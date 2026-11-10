'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const QRCode = require('qrcode');
const { Server } = require('socket.io');

const { DEFAULT_QUESTIONS } = require('./questions');
const {
  initDb,
  ensureBootstrapAdmin,
  authenticateAdmin,
  verifyAdminTokenState,
  listAdminsFromDb,
  createAdminInDb,
  updateAdminInDb,
  writeAuditLog,
  listAuditLogsFromDb,
  loadQuestionsFromDb,
  createQuestionInDb,
  updateQuestionInDb,
  deleteQuestionInDb,
  reorderQuestionsInDb,
  importOrResetQuestionsInDb,
  getDbHealth
} = require('./db');
const {
  getJwtSecret,
  signToken,
  verifyToken,
  SlidingWindowRateLimiter
} = require('./security');
const { GameManager } = require('./gameManager');

const PORT = Number(process.env.PORT || 8080);

function getHostPassword() {
  if (process.env.HOST_PASSWORD && process.env.HOST_PASSWORD.length >= 8) {
    return process.env.HOST_PASSWORD;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('[FATAL] 正式環境必須設定高強度 HOST_PASSWORD 環境變數');
  }
  if (!global.__ephemeralHostPassword) {
    global.__ephemeralHostPassword = crypto.randomBytes(12).toString('base64url');
    console.log(
      `[DEV] 未設定 HOST_PASSWORD，本次啟動隨機產生臨時主持人密碼: ${global.__ephemeralHostPassword}`
    );
  }
  return global.__ephemeralHostPassword;
}

function extractSocketIp(socket) {
  const xff = socket.handshake?.headers?.['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim().length > 0) {
    const parts = xff.split(',').map((s) => s.trim());
    return parts[parts.length - 1] || socket.handshake.address || 'unknown';
  }
  return socket.handshake?.address || 'unknown';
}

function createAppServer() {
  // 啟動前強制檢查密鑰可用性並初始化預設最高管理員
  getJwtSecret();
  const hostPassword = getHostPassword();
  ensureBootstrapAdmin(hostPassword).catch((err) =>
    console.error('[Auth] Bootstrap admin error:', err.message)
  );

  const app = express();
  const server = http.createServer(app);

  // Cloud Run / Reverse Proxy 真實 IP 支援
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // 嚴格資安標頭 (Strict CSP 禁止 inline script / eval，且 connect-src 僅限同源 'self')
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          scriptSrcAttr: ["'none'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          fontSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          mediaSrc: ["'self'", 'data:', 'blob:'],
          connectSrc: ["'self'"],
          frameAncestors: ["'none'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"]
        }
      },
      crossOriginEmbedderPolicy: false
    })
  );

  // 題庫 JSON 批次匯入路由允許 256KB，其餘路由限制 32KB 防止大型封包 DoS
  app.use('/api/host/questions/import', express.json({ limit: '256kb' }));
  app.use(express.json({ limit: '32kb' }));

  const io = new Server(server, {
    maxHttpBufferSize: 16 * 1024,
    pingInterval: 20000,
    pingTimeout: 20000,
    cors: {
      origin: false
    }
  });

  const gameManager = new GameManager(io);
  const serverBootId = crypto.randomBytes(8).toString('hex');

  app.use('/api/', (_req, res, next) => {
    res.setHeader('X-Server-Boot-Id', serverBootId);
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // 雙層失敗密碼嘗試限制器（單一 IP 總量 + 單一 IP+帳號，先檢查 isBlocked 再驗密碼）
  const failedHostIpLimiter = new SlidingWindowRateLimiter(5 * 60 * 1000, 12);
  const failedHostUserLimiter = new SlidingWindowRateLimiter(5 * 60 * 1000, 8);
  const failedGroupAuthLimiter = new SlidingWindowRateLimiter(60 * 1000, 12);
  // WebSocket 事件頻率限制（單一連線 + 單一 IP 雙層保護）
  // 注意：現場參賽者通常共用同一個 Wi-Fi（對外同一個 NAT IP），IP 層級上限須能容納整場人數
  const socketEventLimiter = new SlidingWindowRateLimiter(10 * 1000, 35);
  const ipSocketEventLimiter = new SlidingWindowRateLimiter(10 * 1000, 1500);
  // WebSocket 每秒新建握手頻率與每 IP 同時連線上限（85 人同時掃碼入場不可被擋）
  const ipHandshakeLimiter = new SlidingWindowRateLimiter(10 * 1000, 300);
  const ipConnectionCounts = new Map();
  const MAX_SOCKETS_PER_IP = 300;
  const MAX_TOTAL_SOCKETS = 600;

  setInterval(() => {
    failedHostIpLimiter.cleanup();
    failedHostUserLimiter.cleanup();
    failedGroupAuthLimiter.cleanup();
    socketEventLimiter.cleanup();
    ipSocketEventLimiter.cleanup();
    ipHandshakeLimiter.cleanup();
    gameManager.cleanupExpiredRooms();
  }, 60 * 1000).unref();

  // 一般 API 頻率保護（以 IP 計，需容納整場共用 NAT 之參賽者查房、加入與狀態同步）
  const apiRateLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 6000,
    standardHeaders: true,
    legacyHeaders: false,
    message: { ok: false, error: '請求過於頻繁，請稍候再試' }
  });
  app.use('/api/', apiRateLimiter);

  // 驗證主持人 Token 與帳號即時啟用狀態 / tokenVersion
  function verifyHostAccess(token) {
    const payload = verifyToken(token);
    if (!payload || payload.role !== 'host') return null;
    const liveAdmin = verifyAdminTokenState(payload);
    if (!liveAdmin) return null;
    return liveAdmin;
  }

  function requireHostAuth(req, res, next) {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
    const liveAdmin = verifyHostAccess(token);
    if (!liveAdmin) {
      return res.status(401).json({ ok: false, error: '管理授權無效或已過期，請重新登入。' });
    }
    req.hostUser = liveAdmin;
    next();
  }

  function requireSuperAdmin(req, res, next) {
    if (!req.hostUser || req.hostUser.adminRole !== 'super_admin') {
      return res.status(403).json({
        ok: false,
        error: '權限不足：此操作僅限最高管理員（super_admin）執行。'
      });
    }
    next();
  }

  // 健康檢查
  app.get('/api/health', async (_req, res) => {
    const dbHealth = await getDbHealth();
    res.json({
      ok: true,
      service: 'cyber-ethics-quiz',
      timestamp: new Date().toISOString(),
      db: dbHealth
    });
  });

  // ==================== 1. 管理者登入與身分查詢 ====================

  app.post('/api/host/login', async (req, res) => {
    const ip = req.ip || 'unknown';
    const rawUsername = String(req.body?.username || 'admin')
      .trim()
      .toLowerCase();
    const ipLockKey = `host_ip:${ip}`;
    const userLockKey = `host_user:${ip}:${rawUsername}`;

    if (failedHostIpLimiter.isBlocked(ipLockKey) || failedHostUserLimiter.isBlocked(userLockKey)) {
      return res.status(429).json({
        ok: false,
        error: '登入失敗次數過多，已暫時鎖定 5 分鐘。'
      });
    }

    const password = String(req.body?.password || '');
    const authResult = await authenticateAdmin(rawUsername, password);

    if (!authResult.ok) {
      const ipBlocked = failedHostIpLimiter.recordFailure(ipLockKey);
      const userBlocked = failedHostUserLimiter.recordFailure(userLockKey);
      if (ipBlocked || userBlocked) {
        return res.status(429).json({
          ok: false,
          error: '登入失敗次數過多，已暫時鎖定 5 分鐘。'
        });
      }
      return res.status(401).json({ ok: false, error: authResult.error || '帳號或密碼錯誤。' });
    }

    const admin = authResult.admin;
    const hostToken = signToken(
      {
        role: 'host',
        adminId: admin.id,
        username: admin.username,
        displayName: admin.displayName,
        adminRole: admin.adminRole,
        tokenVersion: admin.tokenVersion
      },
      8 * 3600
    );

    await writeAuditLog({
      actorUsername: admin.username,
      action: 'ADMIN_LOGIN',
      targetType: 'admin',
      targetId: String(admin.id),
      detail: `管理員 ${admin.username} (${admin.adminRole}) 登入成功`,
      clientIp: ip
    });

    res.json({
      ok: true,
      hostToken,
      admin: {
        id: admin.id,
        username: admin.username,
        displayName: admin.displayName,
        adminRole: admin.adminRole
      }
    });
  });

  app.get('/api/host/me', requireHostAuth, (req, res) => {
    res.json({
      ok: true,
      admin: req.hostUser
    });
  });

  // ==================== 2. 房間管理 API ====================

  // 取得目前所有活躍房間列表（供主講人與控台助教協同控場）
  app.get('/api/host/rooms', requireHostAuth, (_req, res) => {
    res.json({
      ok: true,
      rooms: gameManager.listActiveRooms()
    });
  });

  // 建立新房間（含題目快照鎖定與建立者記錄）
  app.post('/api/host/rooms', requireHostAuth, async (req, res) => {
    try {
      const actor = req.hostUser.username;
      const room = await gameManager.createRoom(req.body || {}, actor);
      await writeAuditLog({
        actorUsername: actor,
        action: 'ROOM_CREATE',
        targetType: 'room',
        targetId: room.pin,
        detail: `建立房間「${room.title}」（題數：${room.questions.length}，上限：${room.maxPlayers} 人）`,
        clientIp: req.ip
      });
      res.json({
        ok: true,
        room: gameManager.serializeRoomForHost(room)
      });
    } catch (err) {
      console.error('[API] Create room error:', err);
      res.status(500).json({ ok: false, error: '建立房間失敗' });
    }
  });

  // 更新等待室中之房間設定
  app.put('/api/host/rooms/:pin/config', requireHostAuth, async (req, res) => {
    const result = await gameManager.updateRoomConfig(req.params.pin, req.body || {});
    if (!result.ok) {
      return res.status(400).json(result);
    }
    res.json(result);
  });

  // 於等待室（LOBBY）同步最新題庫至房間快照
  app.post('/api/host/rooms/:pin/sync-questions', requireHostAuth, async (req, res) => {
    const result = await gameManager.syncRoomQuestionsInLobby(req.params.pin);
    if (!result.ok) {
      return res.status(400).json(result);
    }
    await writeAuditLog({
      actorUsername: req.hostUser.username,
      action: 'ROOM_SYNC_QUESTIONS',
      targetType: 'room',
      targetId: req.params.pin,
      detail: `同步房間題目快照（共 ${result.totalQuestions} 題）`,
      clientIp: req.ip
    });
    res.json(result);
  });

  // 查詢單一房間完整狀態
  app.get('/api/host/rooms/:pin', requireHostAuth, (req, res) => {
    const room = gameManager.getRoom(req.params.pin);
    if (!room) {
      return res.status(404).json({ ok: false, error: '找不到該房間' });
    }
    res.json({
      ok: true,
      serverBootId,
      room: gameManager.serializeRoomForHost(room)
    });
  });

  // 主持人控場操作 HTTP API（確保跨容器版本切換或 WebSocket 重連瞬間亦 100% 路由至主實例並廣播）
  app.post('/api/host/rooms/:pin/action', requireHostAuth, async (req, res) => {
    const pin = String(req.params.pin || '').trim();
    const action = String(req.body?.action || '').trim();
    const actor = req.hostUser.username;
    let result = { ok: false, error: '不支援的控場指令' };

    if (action === 'next_question') {
      result = await gameManager.startNextQuestion(pin);
    } else if (action === 'reveal_answer') {
      result = await gameManager.revealCurrentQuestion(pin);
    } else if (action === 'show_leaderboard') {
      result = await gameManager.showLeaderboard(pin);
    } else if (action === 'finish_game') {
      result = await gameManager.finishGame(pin);
      if (result.ok) {
        await writeAuditLog({
          actorUsername: actor,
          action: 'ROOM_FINISH',
          targetType: 'room',
          targetId: pin,
          detail: '結束比賽並公布最終排名',
          clientIp: req.ip
        });
      }
    } else if (action === 'kick_player') {
      const playerId = String(req.body?.playerId || '').trim();
      result = await gameManager.kickPlayer(pin, playerId);
      if (result.ok) {
        await writeAuditLog({
          actorUsername: actor,
          action: 'PLAYER_KICK',
          targetType: 'player',
          targetId: playerId,
          detail: `於房間 ${pin} 移除參賽者 ${playerId}`,
          clientIp: req.ip
        });
      }
    }

    if (!result.ok) {
      return res.status(400).json(result);
    }
    const room = gameManager.getRoom(pin);
    res.json({
      ok: true,
      serverBootId,
      room: room ? gameManager.serializeRoomForHost(room) : null
    });
  });

  // 刪除指定房間（清除記憶體、PostgreSQL 紀錄與通知連線中之參賽者）
  app.delete('/api/host/rooms/:pin', requireHostAuth, async (req, res) => {
    const pin = String(req.params.pin || '').trim();
    const result = await gameManager.deleteRoom(pin);
    if (!result.ok) {
      return res.status(404).json(result);
    }
    await writeAuditLog({
      actorUsername: req.hostUser.username,
      action: 'ROOM_DELETE',
      targetType: 'room',
      targetId: pin,
      detail: `刪除房間「${result.title}」（PIN：${pin}）`,
      clientIp: req.ip
    });
    res.json({ ok: true, pin, title: result.title });
  });

  // ==================== 3. 後台題庫管理 API ====================

  // 取得題庫清單（一般主持人僅檢視題目與選項以供選題；最高管理員可檢視並編輯正解與解析）
  app.get('/api/host/questions', requireHostAuth, async (req, res) => {
    const allQuestions = await loadQuestionsFromDb({ enabledOnly: false });
    const isSuper = req.hostUser.adminRole === 'super_admin';
    const questions = allQuestions.map((q) => {
      if (isSuper) return q;
      return {
        id: q.id,
        number: q.number,
        sortOrder: q.sortOrder,
        title: q.title,
        scenario: q.scenario,
        options: q.options,
        isEnabled: q.isEnabled,
        version: q.version,
        updatedBy: q.updatedBy,
        updatedAt: q.updatedAt
      };
    });
    res.json({ ok: true, canEdit: isSuper, questions });
  });

  // 新增單筆題目（僅限 super_admin）
  app.post('/api/host/questions', requireHostAuth, requireSuperAdmin, async (req, res) => {
    const actor = req.hostUser.username;
    const result = await createQuestionInDb(req.body || {}, actor);
    if (!result.ok) {
      return res.status(400).json(result);
    }
    await writeAuditLog({
      actorUsername: actor,
      action: 'QUESTION_CREATE',
      targetType: 'question',
      targetId: String(result.question.id),
      detail: `新增題目：${result.question.title}`,
      clientIp: req.ip
    });
    res.json(result);
  });

  // 重新排序題目（僅限 super_admin，須置於 /:id 路由前）
  app.post('/api/host/questions/reorder', requireHostAuth, requireSuperAdmin, async (req, res) => {
    const actor = req.hostUser.username;
    const result = await reorderQuestionsInDb(req.body?.orderedIds, actor);
    if (!result.ok) {
      return res.status(400).json(result);
    }
    await writeAuditLog({
      actorUsername: actor,
      action: 'QUESTION_REORDER',
      targetType: 'question_bank',
      targetId: 'all',
      detail: `調整題庫順序（共 ${(req.body?.orderedIds || []).length} 題）`,
      clientIp: req.ip
    });
    const questions = await loadQuestionsFromDb({ enabledOnly: false });
    res.json({ ok: true, questions });
  });

  // 批次匯入題庫 JSON（僅限 super_admin）
  app.post('/api/host/questions/import', requireHostAuth, requireSuperAdmin, async (req, res) => {
    const actor = req.hostUser.username;
    const mode = req.body?.mode === 'replace' ? 'replace' : 'append';
    const rawList = req.body?.questions;
    const result = await importOrResetQuestionsInDb(rawList, mode, actor);
    if (!result.ok) {
      return res.status(400).json(result);
    }
    await writeAuditLog({
      actorUsername: actor,
      action: 'QUESTION_IMPORT',
      targetType: 'question_bank',
      targetId: mode,
      detail: `批次匯入題庫（模式：${mode}，共 ${result.count} 題）`,
      clientIp: req.ip
    });
    const questions = await loadQuestionsFromDb({ enabledOnly: false });
    res.json({ ok: true, count: result.count, questions });
  });

  // 還原或追加系統預設 10 題（僅限 super_admin）
  app.post('/api/host/questions/reset', requireHostAuth, requireSuperAdmin, async (req, res) => {
    const actor = req.hostUser.username;
    const mode = req.body?.mode === 'append' ? 'append' : 'replace';
    const result = await importOrResetQuestionsInDb(DEFAULT_QUESTIONS, mode, actor);
    if (!result.ok) {
      return res.status(400).json(result);
    }
    await writeAuditLog({
      actorUsername: actor,
      action: 'QUESTION_RESET_DEFAULT',
      targetType: 'question_bank',
      targetId: mode,
      detail: `還原預設 10 題（模式：${mode}）`,
      clientIp: req.ip
    });
    const questions = await loadQuestionsFromDb({ enabledOnly: false });
    res.json({ ok: true, count: result.count, questions });
  });

  // 編輯指定題目（僅限 super_admin，支援 version 樂觀鎖）
  app.put('/api/host/questions/:id', requireHostAuth, requireSuperAdmin, async (req, res) => {
    const actor = req.hostUser.username;
    const result = await updateQuestionInDb(req.params.id, req.body || {}, actor);
    if (!result.ok) {
      return res.status(result.conflict ? 409 : 400).json(result);
    }
    await writeAuditLog({
      actorUsername: actor,
      action: 'QUESTION_UPDATE',
      targetType: 'question',
      targetId: String(req.params.id),
      detail: `修改題目 #${req.params.id}：${result.question.title}（v${result.question.version}）`,
      clientIp: req.ip
    });
    res.json(result);
  });

  // 刪除指定題目（僅限 super_admin）
  app.delete('/api/host/questions/:id', requireHostAuth, requireSuperAdmin, async (req, res) => {
    const actor = req.hostUser.username;
    const result = await deleteQuestionInDb(req.params.id);
    if (!result.ok) {
      return res.status(400).json(result);
    }
    await writeAuditLog({
      actorUsername: actor,
      action: 'QUESTION_DELETE',
      targetType: 'question',
      targetId: String(req.params.id),
      detail: `刪除題目 ID #${req.params.id}`,
      clientIp: req.ip
    });
    const questions = await loadQuestionsFromDb({ enabledOnly: false });
    res.json({ ok: true, questions });
  });

  // ==================== 4. 多管理者帳號與稽核日誌 API ====================

  app.get('/api/host/admins', requireHostAuth, requireSuperAdmin, async (_req, res) => {
    const admins = await listAdminsFromDb();
    res.json({ ok: true, admins });
  });

  app.post('/api/host/admins', requireHostAuth, requireSuperAdmin, async (req, res) => {
    const actor = req.hostUser.username;
    const result = await createAdminInDb(req.body || {});
    if (!result.ok) {
      return res.status(400).json(result);
    }
    await writeAuditLog({
      actorUsername: actor,
      action: 'ADMIN_CREATE',
      targetType: 'admin',
      targetId: result.admin.username,
      detail: `新增管理者帳號 ${result.admin.username}（角色：${result.admin.adminRole}）`,
      clientIp: req.ip
    });
    res.json(result);
  });

  app.patch('/api/host/admins/:id', requireHostAuth, requireSuperAdmin, async (req, res) => {
    const actor = req.hostUser;
    const result = await updateAdminInDb(req.params.id, req.body || {}, actor);
    if (!result.ok) {
      return res.status(400).json(result);
    }
    await writeAuditLog({
      actorUsername: actor.username,
      action: 'ADMIN_UPDATE',
      targetType: 'admin',
      targetId: result.admin.username,
      detail: `更新管理者 ${result.admin.username}（角色：${result.admin.adminRole}，啟用：${result.admin.isActive}）`,
      clientIp: req.ip
    });
    res.json(result);
  });

  app.get('/api/host/audit-logs', requireHostAuth, requireSuperAdmin, async (req, res) => {
    const logs = await listAuditLogsFromDb(req.query.limit || 50);
    res.json({ ok: true, logs });
  });

  // ==================== 5. 參賽者公開 API ====================

  app.get('/api/qrcode', async (req, res) => {
    try {
      const rawPin = String(req.query.pin || '').trim();
      const rawGroup = String(req.query.group || '').trim();

      let baseOrigin = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
      if (!baseOrigin) {
        const rawProto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https')
          .split(',')[0]
          .trim()
          .toLowerCase();
        const safeProto = rawProto === 'http' ? 'http' : 'https';
        const rawHost = String(req.get('host') || 'localhost:8080').trim();
        const safeHost = /^[a-zA-Z0-9.-]+(?::\d{1,5})?$/.test(rawHost)
          ? rawHost
          : 'localhost:8080';
        baseOrigin = `${safeProto}://${safeHost}`;
      }

      const params = new URLSearchParams();
      if (/^\d{6}$/.test(rawPin)) {
        params.set('pin', rawPin);
        if (/^G\d{1,2}$/.test(rawGroup)) {
          params.set('group', rawGroup);
        }
      }
      const queryStr = params.toString();
      const targetUrl = queryStr ? `${baseOrigin}/?${queryStr}` : `${baseOrigin}/`;

      const svg = await QRCode.toString(targetUrl, {
        type: 'svg',
        margin: 1,
        width: 240,
        color: {
          dark: '#172033',
          light: '#FFFFFF'
        }
      });

      res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.send(svg);
    } catch {
      res.status(500).send('QR Error');
    }
  });

  const BGM_TITLE_MAP = {
    '01-tense-match-25s.mp3': '01. 25秒緊張比賽音樂 (25s)',
    '02-extreme-countdown-25s.mp3': '02. 極限緊張倒數 (25s)',
    '03-industrial-beat-25s.mp3': '03. 工業重拍窒息 (25s)',
    '04-dark-hero-25s.mp3': '04. 黑化主角登場 (25s)',
    '05-villain-aura-25s.mp3': '05. 反派氣場 (25s)',
    '06-sudden-awakening-25s.mp3': '06. 突發黑化覺醒 (25s)',
    '07-dark-turning-point-25s.mp3': '07. 黑化轉折點 (25s)',
    '08-despair-suppression-25s.mp3': '08. 處刑曲・絕望壓制 (25s)',
    '09-medieval-fantasy-25s.mp3': '09. 中古奇幻・處刑曲 (25s)',
    '10-execution-ignite-25s.mp3': '10. 處刑時刻・燃爆 (25s)',
    '11-crusade-execution-25s.mp3': '11. 聖戰處刑 (25s)',
    '12-irish-awakening-25s.mp3': '12. 愛爾蘭黑化覺醒 (25s)',
    '13-celtic-war-soul-25s.mp3': '13. 凱爾特戰魂處刑 (25s)',
    '14-celtic-dream-flight-25s.mp3': '14. 夢的起飛・凱爾特奇幻 (25s)',
    '15-wings-of-adventure-25s.mp3': '15. 夢的翅膀・冒險開始 (25s)',
    '16-egyptian-odyssey-25s.mp3': '16. 埃及神話・啟程 (25s)',
    '17-ten-thousand-swords-25s.mp3': '17. 修仙絕技・萬劍歸宗 (25s)',
    '18-tribulation-burst-25s.mp3': '18. 渡劫爆發・靈力全開 (25s)'
  };

  app.get('/api/bgm', (_req, res) => {
    try {
      const bgmDir = path.join(__dirname, '..', 'public', 'bgm');
      if (!fs.existsSync(bgmDir)) {
        return res.json({ ok: true, tracks: [] });
      }
      const files = fs
        .readdirSync(bgmDir)
        .filter((f) => /\.(mp3|m4a|ogg|wav)$/i.test(f))
        .sort((a, b) => a.localeCompare(b, 'zh-Hant'));
      const tracks = files.map((fileName, idx) => {
        const cleanTitle = fileName
          .replace(/\.[^.]+$/, '')
          .replace(/\s+25s$/i, ' (25s)');
        const numPrefix = String(idx + 1).padStart(2, '0');
        return {
          id: fileName.replace(/\.[^.]+$/, ''),
          fileName,
          title: BGM_TITLE_MAP[fileName] || `${numPrefix}. ${cleanTitle}`,
          src: `/bgm/${encodeURIComponent(fileName)}`
        };
      });
      res.json({ ok: true, tracks });
    } catch {
      res.json({ ok: true, tracks: [] });
    }
  });

  app.get('/api/rooms/:pin', (req, res) => {
    const info = gameManager.getPublicRoomInfo(req.params.pin);
    if (!info) {
      return res.status(404).json({ ok: false, error: '找不到此房間 PIN 碼，請確認是否輸入正確' });
    }
    res.json({ ok: true, serverBootId, room: info });
  });

  app.get('/api/rooms/:pin/state', (req, res) => {
    const room = gameManager.getRoom(req.params.pin);
    if (!room) {
      return res.status(404).json({ ok: false, error: '找不到該房間' });
    }
    res.json({
      ok: true,
      serverBootId,
      gameState: gameManager.buildPublicState(room)
    });
  });

  app.get('/api/player/state', (req, res) => {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
    const payload = verifyToken(token);
    if (!payload || payload.role !== 'player') {
      return res.status(401).json({ ok: false, error: '參賽憑證無效或已過期，請重新加入房間' });
    }
    const room = gameManager.getRoom(payload.pin);
    if (!room) {
      return res.status(404).json({ ok: false, error: '此測驗房間已被主持人刪除或關閉。' });
    }
    const player = room.players.get(payload.playerId);
    if (!player) {
      return res.status(404).json({ ok: false, error: '您的參賽席次已不存在，請重新加入' });
    }
    player.connected = true;
    res.json({
      ok: true,
      serverBootId,
      gameState: gameManager.buildPublicState(room),
      personal: gameManager.buildPlayerPersonalState(room, player.id)
    });
  });

  app.post('/api/player/answer', (req, res) => {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
    const payload = verifyToken(token);
    if (!payload || payload.role !== 'player') {
      return res.status(401).json({ ok: false, error: '參賽憑證無效' });
    }
    const result = gameManager.submitAnswer(payload.pin, payload.playerId, req.body?.option);
    if (!result.ok) {
      return res.status(400).json(result);
    }
    const room = gameManager.getRoom(payload.pin);
    const personal = room
      ? gameManager.buildPlayerPersonalState(room, payload.playerId)
      : null;
    res.json({
      ...result,
      serverBootId,
      personal
    });
  });

  app.post('/api/rooms/:pin/join', async (req, res) => {
    const ip = req.ip || 'unknown';
    const pin = String(req.params.pin || '').trim();
    const { groupCode, groupPassword, nickname } = req.body || {};
    const cleanGroupCode = String(groupCode || '').trim();

    const rateKey = `join:${ip}:${pin}:${cleanGroupCode}`;
    if (failedGroupAuthLimiter.isBlocked(rateKey)) {
      return res.status(429).json({
        ok: false,
        error: '組別密碼嘗試錯誤次數過多，請稍候 1 分鐘再試'
      });
    }

    const result = await gameManager.joinPlayer(pin, {
      groupCode: cleanGroupCode,
      groupPassword,
      nickname
    });

    if (!result.ok) {
      if (result.error && result.error.includes('組別密碼錯誤')) {
        const nowBlocked = failedGroupAuthLimiter.recordFailure(rateKey);
        if (nowBlocked) {
          return res.status(429).json({
            ok: false,
            error: '組別密碼嘗試錯誤次數過多，請稍候 1 分鐘再試'
          });
        }
      }
      return res.status(400).json(result);
    }

    const playerToken = signToken(
      {
        role: 'player',
        pin: result.room.pin,
        playerId: result.player.id,
        groupCode: result.player.groupCode
      },
      6 * 3600
    );

    res.json({
      ok: true,
      playerToken,
      player: gameManager.buildPlayerPersonalState(result.room, result.player.id),
      gameState: gameManager.buildPublicState(result.room)
    });
  });

  // ==================== 6. Socket.IO 即時連線處理 ====================

  io.use((socket, next) => {
    if (io.engine.clientsCount >= MAX_TOTAL_SOCKETS) {
      return next(new Error('伺服器連線人數已滿'));
    }
    const clientIp = extractSocketIp(socket);
    socket.data.clientIp = clientIp;

    if (!ipHandshakeLimiter.consume(clientIp)) {
      return next(new Error('建立連線過於頻繁，請稍候再試'));
    }

    const currentIpCount = ipConnectionCounts.get(clientIp) || 0;
    if (currentIpCount >= MAX_SOCKETS_PER_IP) {
      return next(new Error('同一網路來源連線數已達上限'));
    }
    ipConnectionCounts.set(clientIp, currentIpCount + 1);
    next();
  });

  io.on('connection', (socket) => {
    const clientIp = socket.data.clientIp || 'unknown';
    socket.emit('server:hello', { serverBootId });

    socket.use((_packet, next) => {
      if (!socketEventLimiter.consume(socket.id) || !ipSocketEventLimiter.consume(clientIp)) {
        return next(new Error('操作過於頻繁，請放慢點擊速度'));
      }
      next();
    });

    // 唯讀投影幕訂閱
    socket.on('display:subscribe', ({ pin }, ack) => {
      const room = gameManager.getRoom(pin);
      if (!room) {
        if (typeof ack === 'function') ack({ ok: false, error: '找不到該房間' });
        return;
      }
      socket.data.role = 'display';
      socket.data.pin = room.pin;
      socket.join(`room:${room.pin}`);

      const publicState = gameManager.buildPublicState(room);
      if (typeof ack === 'function') ack({ ok: true, gameState: publicState });
    });

    // 主持人訂閱房間與控制（每次皆核對帳號啟用狀態與 tokenVersion）
    socket.on('host:subscribe', ({ pin, hostToken }, ack) => {
      const admin = verifyHostAccess(hostToken);
      if (!admin) {
        if (typeof ack === 'function') ack({ ok: false, error: '主持人認證已失效，請重新登入' });
        return;
      }
      const room = gameManager.getRoom(pin);
      if (!room) {
        if (typeof ack === 'function') ack({ ok: false, error: '找不到該房間' });
        return;
      }
      socket.data.role = 'host';
      socket.data.pin = room.pin;
      socket.data.adminUsername = admin.username;
      socket.join(`host:${room.pin}`);
      socket.join(`room:${room.pin}`);

      const state = gameManager.serializeRoomForHost(room);
      if (typeof ack === 'function') ack({ ok: true, room: state });
    });

    socket.on('host:next_question', async ({ pin, hostToken }, ack) => {
      const admin = verifyHostAccess(hostToken);
      if (!admin) {
        if (typeof ack === 'function') ack({ ok: false, error: '無權限或帳號已停用' });
        return;
      }
      const res = await gameManager.startNextQuestion(pin);
      if (typeof ack === 'function') ack(res);
    });

    socket.on('host:reveal_answer', async ({ pin, hostToken }, ack) => {
      const admin = verifyHostAccess(hostToken);
      if (!admin) {
        if (typeof ack === 'function') ack({ ok: false, error: '無權限或帳號已停用' });
        return;
      }
      const res = await gameManager.revealCurrentQuestion(pin);
      if (typeof ack === 'function') ack(res);
    });

    socket.on('host:show_leaderboard', async ({ pin, hostToken }, ack) => {
      const admin = verifyHostAccess(hostToken);
      if (!admin) {
        if (typeof ack === 'function') ack({ ok: false, error: '無權限或帳號已停用' });
        return;
      }
      const res = await gameManager.showLeaderboard(pin);
      if (typeof ack === 'function') ack(res);
    });

    socket.on('host:finish_game', async ({ pin, hostToken }, ack) => {
      const admin = verifyHostAccess(hostToken);
      if (!admin) {
        if (typeof ack === 'function') ack({ ok: false, error: '無權限或帳號已停用' });
        return;
      }
      const res = await gameManager.finishGame(pin);
      if (res.ok) {
        await writeAuditLog({
          actorUsername: admin.username,
          action: 'ROOM_FINISH',
          targetType: 'room',
          targetId: String(pin),
          detail: `結束比賽並公布最終排名`,
          clientIp
        });
      }
      if (typeof ack === 'function') ack(res);
    });

    socket.on('host:kick_player', async ({ pin, playerId, hostToken }, ack) => {
      const admin = verifyHostAccess(hostToken);
      if (!admin) {
        if (typeof ack === 'function') ack({ ok: false, error: '無權限或帳號已停用' });
        return;
      }
      const res = await gameManager.kickPlayer(pin, playerId);
      if (res.ok) {
        await writeAuditLog({
          actorUsername: admin.username,
          action: 'PLAYER_KICK',
          targetType: 'player',
          targetId: String(playerId),
          detail: `於房間 ${pin} 移除參賽者 ${playerId}`,
          clientIp
        });
      }
      if (typeof ack === 'function') ack(res);
    });

    // 參賽者綁定連線 / 斷線自動重連
    socket.on('player:bind', ({ playerToken }, ack) => {
      const payload = verifyToken(playerToken);
      if (!payload || payload.role !== 'player') {
        if (typeof ack === 'function')
          ack({ ok: false, error: '參賽憑證無效或已過期，請重新加入房間' });
        return;
      }
      const room = gameManager.getRoom(payload.pin);
      if (!room) {
        if (typeof ack === 'function') ack({ ok: false, error: '房間已關閉或不存在' });
        return;
      }
      const player = room.players.get(payload.playerId);
      if (!player) {
        if (typeof ack === 'function') ack({ ok: false, error: '您的參賽席次已不存在，請重新加入' });
        return;
      }

      player.socketId = socket.id;
      player.connected = true;
      socket.data.role = 'player';
      socket.data.pin = room.pin;
      socket.data.playerId = player.id;
      socket.join(`room:${room.pin}`);

      const publicState = gameManager.buildPublicState(room);
      const personalState = gameManager.buildPlayerPersonalState(room, player.id);

      io.to(`host:${room.pin}`).emit('host:state', gameManager.serializeRoomForHost(room));

      if (typeof ack === 'function') {
        ack({
          ok: true,
          gameState: publicState,
          personal: personalState
        });
      }
    });

    // 參賽者送出答案
    socket.on('player:answer', ({ playerToken, option }, ack) => {
      const payload = verifyToken(playerToken);
      if (!payload || payload.role !== 'player') {
        if (typeof ack === 'function') ack({ ok: false, error: '參賽憑證無效' });
        return;
      }
      const res = gameManager.submitAnswer(payload.pin, payload.playerId, option);
      if (res.ok) {
        const room = gameManager.getRoom(payload.pin);
        const personal = room
          ? gameManager.buildPlayerPersonalState(room, payload.playerId)
          : null;
        socket.emit('player:personal', personal);
      }
      if (typeof ack === 'function') ack(res);
    });

    // 參賽者主動離開房間（釋放該組名額與暱稱）
    socket.on('player:leave', async ({ playerToken }, ack) => {
      const payload = verifyToken(playerToken);
      if (!payload || payload.role !== 'player') {
        if (typeof ack === 'function') ack({ ok: false });
        return;
      }
      socket.leave(`room:${payload.pin}`);
      if (socket.data.playerId === payload.playerId) {
        socket.data.role = null;
        socket.data.pin = null;
        socket.data.playerId = null;
      }
      const res = await gameManager.leavePlayer(payload.pin, payload.playerId);
      if (typeof ack === 'function') ack(res);
    });

    socket.on('disconnect', () => {
      const count = ipConnectionCounts.get(clientIp) || 1;
      if (count <= 1) {
        ipConnectionCounts.delete(clientIp);
      } else {
        ipConnectionCounts.set(clientIp, count - 1);
      }

      if (socket.data.role === 'player' && socket.data.pin && socket.data.playerId) {
        const room = gameManager.getRoom(socket.data.pin);
        if (room) {
          const player = room.players.get(socket.data.playerId);
          if (player && player.socketId === socket.id) {
            player.connected = false;
            io.to(`host:${room.pin}`).emit('host:state', gameManager.serializeRoomForHost(room));
          }
        }
      }
    });
  });

  // 靜態前端資源
  const publicDir = path.join(__dirname, '..', 'public');
  app.use(express.static(publicDir));

  app.get('/host', (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  app.get('/display/:pin?', (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  app.get('*', (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  return { app, server, io, gameManager, hostPassword };
}

if (require.main === module) {
  (async () => {
    await initDb();
    const { server, gameManager, hostPassword } = createAppServer();
    await ensureBootstrapAdmin(hostPassword);
    await gameManager.restoreFromDatabase();
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`[CyberQuiz] 伺服器已啟動：http://localhost:${PORT}`);
    });
  })();
}

module.exports = { createAppServer };
