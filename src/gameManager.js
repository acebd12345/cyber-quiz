'use strict';

const crypto = require('crypto');
const { performance } = require('perf_hooks');
const {
  sanitizeQuestionForOpenPhase,
  sanitizeQuestionForRevealPhase
} = require('./questions');
const {
  hashPassword,
  verifyPassword,
  sanitizeNickname,
  sanitizeGroupName,
  generateRoomPin,
  generateGroupPassword
} = require('./security');
const {
  loadQuestionsFromDb,
  loadActiveRoomsFromDb,
  persistRoomCreated,
  persistRoomStatus,
  deleteRoomFromDb,
  persistPlayerJoined,
  persistPlayerRemoved,
  persistAnswerAndScore
} = require('./db');

class GameManager {
  constructor(io) {
    this.io = io;
    this.rooms = new Map(); // pin -> Room
  }

  /**
   * 啟動時從 PostgreSQL 還原未過期的活躍房間
   */
  async restoreFromDatabase() {
    const restored = await loadActiveRoomsFromDb();
    for (const room of restored) {
      this.rooms.set(room.pin, room);
    }
    return restored.length;
  }

  /**
   * 定期清理已結束超過 2 小時或閒置超過 6 小時的房間記憶體
   */
  cleanupExpiredRooms() {
    const now = Date.now();
    const FINISHED_TTL_MS = 2 * 60 * 60 * 1000;
    const MAX_IDLE_TTL_MS = 6 * 60 * 60 * 1000;

    for (const [pin, room] of this.rooms.entries()) {
      const isFinishedExpired =
        room.status === 'FINISHED' &&
        room.finishedAt &&
        now - room.finishedAt > FINISHED_TTL_MS;
      const isIdleExpired = now - (room.createdAt || now) > MAX_IDLE_TTL_MS;

      if (isFinishedExpired || isIdleExpired) {
        if (room.timerHandle) {
          clearTimeout(room.timerHandle);
          room.timerHandle = null;
        }
        this.rooms.delete(pin);
      }
    }
  }

  /**
   * 建立新測驗房間（含總人數上限、作答秒數、各組名稱/密碼/每組人數上限、房間題目快照）
   */
  async createRoom(options = {}, createdBy = 'admin') {
    let pin = generateRoomPin();
    while (this.rooms.has(pin)) {
      pin = generateRoomPin();
    }

    const title =
      String(options.title || '神手速快問快答大亂鬥')
        .replace(/[<>"'`&\\]/g, '')
        .trim()
        .slice(0, 60) || '神手速快問快答大亂鬥';

    const maxPlayers = Math.max(1, Math.min(500, parseInt(options.maxPlayers, 10) || 100));
    const timeLimitSec = Math.max(5, Math.min(180, parseInt(options.timeLimitSec, 10) || 25));

    const enabledQuestions = await loadQuestionsFromDb({ enabledOnly: true });
    let selectedQuestions = enabledQuestions;
    if (Array.isArray(options.questionIds) && options.questionIds.length > 0) {
      const idSet = new Set(options.questionIds.map((id) => Number(id)));
      const filtered = enabledQuestions.filter((q) => idSet.has(Number(q.id)));
      if (filtered.length > 0) {
        selectedQuestions = filtered;
      }
    }
    const questions = selectedQuestions.map((q, idx) => ({
      ...q,
      number: idx + 1,
      options: { ...q.options }
    }));

    const groupsMap = new Map();
    const rawGroups =
      Array.isArray(options.groups) && options.groups.length > 0
        ? options.groups
        : this.generateDefaultGroups(5, 5);

    for (let i = 0; i < Math.min(rawGroups.length, 100); i++) {
      const g = rawGroups[i];
      const nameCheck = sanitizeGroupName(g.name || `第 ${i + 1} 組`);
      const groupName = nameCheck.valid ? nameCheck.value : `第 ${i + 1} 組`;
      const groupCode = `G${i + 1}`;
      const plainPassword = String(g.password || generateGroupPassword(6)).trim();
      const maxMembers = Math.max(1, Math.min(200, parseInt(g.maxMembers, 10) || 5));

      groupsMap.set(groupCode, {
        code: groupCode,
        name: groupName,
        plainPassword, // 僅供主持人後台檢視/匯出，絕不對參賽者端公開
        passwordHash: hashPassword(plainPassword),
        maxMembers
      });
    }

    const room = {
      pin,
      title,
      status: 'LOBBY', // LOBBY | QUESTION_OPEN | QUESTION_REVEAL | LEADERBOARD | FINISHED
      maxPlayers,
      timeLimitSec,
      questions,
      createdBy: String(createdBy || 'admin').slice(0, 64),
      currentQuestionIndex: -1,
      questionOpenedAtMono: 0,
      questionEndsAtEpoch: 0,
      timerHandle: null,
      groups: groupsMap, // code -> Group
      players: new Map(), // playerId -> Player
      currentAnswers: new Map(), // playerId -> AnswerRecord (for current question)
      historyAnswers: new Map(), // questionIdx -> Map(playerId -> AnswerRecord)
      createdAt: Date.now(),
      finishedAt: null
    };

    this.rooms.set(pin, room);
    await persistRoomCreated(room);
    return room;
  }

  /**
   * 列出目前所有活躍房間（供主持人與助教於後台一覽並進入控場）
   */
  listActiveRooms() {
    const list = [];
    for (const room of this.rooms.values()) {
      list.push({
        pin: room.pin,
        title: room.title,
        status: room.status,
        currentPlayers: room.players.size,
        maxPlayers: room.maxPlayers,
        totalQuestions: room.questions.length,
        currentQuestionIndex: room.currentQuestionIndex,
        createdBy: room.createdBy || 'admin',
        createdAt: room.createdAt
      });
    }
    return list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  /**
   * 當房間仍處於等待室（LOBBY）時，重新同步最新啟用題庫至房間快照
   */
  async syncRoomQuestionsInLobby(pin) {
    const room = this.getRoom(pin);
    if (!room) return { ok: false, error: '找不到此房間。' };
    if (room.status !== 'LOBBY') {
      return { ok: false, error: '測驗開始後無法變更房間題目快照。' };
    }
    const enabledQuestions = await loadQuestionsFromDb({ enabledOnly: true });
    room.questions = enabledQuestions.map((q, idx) => ({
      ...q,
      number: idx + 1,
      options: { ...q.options }
    }));
    await persistRoomCreated(room);
    this.broadcastRoomState(room);
    return {
      ok: true,
      totalQuestions: room.questions.length,
      room: this.serializeRoomForHost(room)
    };
  }

  generateDefaultGroups(groupCount = 5, maxMembersPerGroup = 5) {
    const list = [];
    for (let i = 1; i <= groupCount; i++) {
      list.push({
        name: `第 ${i} 組`,
        password: generateGroupPassword(6),
        maxMembers: maxMembersPerGroup
      });
    }
    return list;
  }

  getRoom(pin) {
    if (!pin) return null;
    return this.rooms.get(String(pin).trim()) || null;
  }

  /**
   * 刪除房間（清除計時器、通知所有連線端、從記憶體與資料庫永久移除）
   */
  async deleteRoom(pin) {
    const cleanPin = String(pin || '').trim();
    const room = this.getRoom(cleanPin);
    if (!room) {
      return { ok: false, error: '找不到此房間' };
    }

    if (room.timerHandle) {
      clearTimeout(room.timerHandle);
      room.timerHandle = null;
    }

    const payload = {
      pin: room.pin,
      title: room.title,
      message: `房間「${room.title}」（PIN：${room.pin}）已被主持人刪除。`
    };
    this.io.to(`room:${room.pin}`).emit('room:deleted', payload);
    this.io.to(`host:${room.pin}`).emit('room:deleted', payload);

    this.rooms.delete(room.pin);
    await deleteRoomFromDb(room.pin);

    return {
      ok: true,
      pin: room.pin,
      title: room.title
    };
  }

  /**
   * 主持人於等待室更新房間設定與各組密碼/上限
   */
  async updateRoomConfig(pin, config = {}) {
    const room = this.getRoom(pin);
    if (!room) return { ok: false, error: '找不到該房間' };
    if (room.status !== 'LOBBY') {
      return { ok: false, error: '測驗開始後無法重設組別結構，但可調整人數上限' };
    }

    if (config.title) {
      room.title =
        String(config.title)
          .replace(/[<>"'`&\\]/g, '')
          .trim()
          .slice(0, 60) || room.title;
    }
    if (config.maxPlayers !== undefined) {
      room.maxPlayers = Math.max(
        1,
        Math.min(500, parseInt(config.maxPlayers, 10) || room.maxPlayers)
      );
    }
    if (config.timeLimitSec !== undefined) {
      room.timeLimitSec = Math.max(
        5,
        Math.min(180, parseInt(config.timeLimitSec, 10) || room.timeLimitSec)
      );
    }

    if (Array.isArray(config.groups) && config.groups.length > 0) {
      const newGroups = new Map();
      for (let i = 0; i < Math.min(config.groups.length, 100); i++) {
        const g = config.groups[i];
        const nameCheck = sanitizeGroupName(g.name || `第 ${i + 1} 組`);
        const groupName = nameCheck.valid ? nameCheck.value : `第 ${i + 1} 組`;
        const groupCode = g.code && /^G\d+$/.test(g.code) ? g.code : `G${i + 1}`;
        const plainPassword = String(g.password || generateGroupPassword(6)).trim();
        if (plainPassword.length < 2 || plainPassword.length > 32) {
          return { ok: false, error: `${groupName} 的密碼長度須為 2 至 32 字元` };
        }
        const maxMembers = Math.max(1, Math.min(200, parseInt(g.maxMembers, 10) || 5));

        newGroups.set(groupCode, {
          code: groupCode,
          name: groupName,
          plainPassword,
          passwordHash: hashPassword(plainPassword),
          maxMembers
        });
      }
      room.groups = newGroups;
    }

    await persistRoomCreated(room);
    this.broadcastRoomState(room);
    return { ok: true, room: this.serializeRoomForHost(room) };
  }

  /**
   * 參賽者查詢房間公開資訊（僅回傳組別名稱與目前人數/上限，絕不回傳密碼或題庫）
   */
  getPublicRoomInfo(pin) {
    const room = this.getRoom(pin);
    if (!room) return null;

    const groupsPublic = [];
    for (const g of room.groups.values()) {
      const count = this.getGroupMemberCount(room, g.code);
      groupsPublic.push({
        code: g.code,
        name: g.name,
        currentMembers: count,
        maxMembers: g.maxMembers,
        isFull: count >= g.maxMembers
      });
    }

    return {
      pin: room.pin,
      title: room.title,
      status: room.status,
      currentPlayers: room.players.size,
      maxPlayers: room.maxPlayers,
      isRoomFull: room.players.size >= room.maxPlayers,
      groups: groupsPublic
    };
  }

  getGroupMemberCount(room, groupCode) {
    let count = 0;
    for (const p of room.players.values()) {
      if (p.groupCode === groupCode) count++;
    }
    return count;
  }

  /**
   * 參賽者驗證組別密碼並加入房間（含總人數上限、單組人數上限、暱稱防重與防 XSS）
   */
  async joinPlayer(pin, { groupCode, groupPassword, nickname }) {
    const room = this.getRoom(pin);
    if (!room) {
      return { ok: false, error: '找不到此房間 PIN 碼，請確認後再試' };
    }
    if (room.status === 'FINISHED') {
      return { ok: false, error: '此房間測驗已經結束' };
    }

    const group = room.groups.get(String(groupCode || '').trim());
    if (!group) {
      return { ok: false, error: '請選擇有效的參賽組別' };
    }

    // 1. 常數時間驗證組別密碼
    if (!verifyPassword(groupPassword, group.passwordHash)) {
      return { ok: false, error: '組別密碼錯誤，請確認您所屬組別的通行密碼' };
    }

    // 2. 驗證並清理暱稱
    const nickCheck = sanitizeNickname(nickname);
    if (!nickCheck.valid) {
      return { ok: false, error: nickCheck.error };
    }
    const cleanNick = nickCheck.value;

    // 3. 檢查房間總人數上限
    if (room.players.size >= room.maxPlayers) {
      return {
        ok: false,
        error: `房間總人數已達上限 (${room.maxPlayers} 人)，無法再加入`
      };
    }

    // 4. 檢查該組人數上限
    const currentGroupMembers = this.getGroupMemberCount(room, group.code);
    if (currentGroupMembers >= group.maxMembers) {
      return {
        ok: false,
        error: `「${group.name}」人數已達上限 (${group.maxMembers} 人)，如有斷線重連需求請請主持人協助移除舊連線`
      };
    }

    // 5. 檢查同房間內暱稱是否重複（不分大小寫）
    for (const p of room.players.values()) {
      if (p.nickname.toLowerCase() === cleanNick.toLowerCase()) {
        return { ok: false, error: '此暱稱已被其他參賽者使用，請換一個暱稱' };
      }
    }

    const playerId = crypto.randomUUID();
    const player = {
      id: playerId,
      nickname: cleanNick,
      groupCode: group.code,
      groupName: group.name,
      score: 0,
      streak: 0,
      correctCount: 0,
      totalTimeMs: 0,
      connected: true,
      socketId: null,
      joinedAt: Date.now()
    };

    room.players.set(playerId, player);
    await persistPlayerJoined(room.pin, player);
    this.broadcastRoomState(room);

    return {
      ok: true,
      player,
      room
    };
  }

  /**
   * 主持人強制踢除參賽者（釋放該組名額）
   */
  async kickPlayer(pin, playerId) {
    const room = this.getRoom(pin);
    if (!room) return { ok: false, error: '找不到房間' };
    const player = room.players.get(playerId);
    if (!player) return { ok: false, error: '找不到該參賽者' };

    if (player.socketId) {
      this.io.to(player.socketId).emit('player:kicked', {
        message: '您已被主持人移出房間'
      });
    }
    room.players.delete(playerId);
    room.currentAnswers.delete(playerId);
    for (const ansMap of room.historyAnswers.values()) {
      ansMap.delete(playerId);
    }
    await persistPlayerRemoved(room.pin, playerId);
    this.broadcastRoomState(room);
    this.checkAutoRevealAfterPlayerChange(room);
    return { ok: true };
  }

  /**
   * 參賽者主動離開房間（釋放該組名額與暱稱）
   */
  async leavePlayer(pin, playerId) {
    const room = this.getRoom(pin);
    if (!room) return { ok: false, error: '找不到房間' };
    const player = room.players.get(playerId);
    if (!player) return { ok: false, error: '找不到該參賽者' };

    room.players.delete(playerId);
    room.currentAnswers.delete(playerId);
    for (const ansMap of room.historyAnswers.values()) {
      ansMap.delete(playerId);
    }
    await persistPlayerRemoved(room.pin, playerId);
    this.broadcastRoomState(room);
    this.checkAutoRevealAfterPlayerChange(room);
    return { ok: true };
  }

  checkAutoRevealAfterPlayerChange(room) {
    if (
      room.status === 'QUESTION_OPEN' &&
      room.players.size > 0 &&
      room.currentAnswers.size >= room.players.size
    ) {
      if (room.timerHandle) {
        clearTimeout(room.timerHandle);
        room.timerHandle = null;
      }
      setImmediate(() => {
        this.revealCurrentQuestion(room.pin).catch((err) =>
          console.error('[Game] Early reveal error:', err)
        );
      });
    }
  }

  /**
   * 開始下一題（狀態機保護：禁止在 QUESTION_OPEN 或 FINISHED 期間重複觸發跳題）
   */
  async startNextQuestion(pin) {
    const room = this.getRoom(pin);
    if (!room) return { ok: false, error: '找不到房間' };

    if (room.status === 'QUESTION_OPEN') {
      return {
        ok: false,
        error: '目前題目尚在作答中，請先截止揭曉答案後再進入下一題'
      };
    }
    if (room.status === 'FINISHED') {
      return { ok: false, error: '本場測驗已結束' };
    }

    if (room.timerHandle) {
      clearTimeout(room.timerHandle);
      room.timerHandle = null;
    }

    const nextIdx = room.currentQuestionIndex + 1;
    if (nextIdx >= room.questions.length) {
      return await this.finishGame(pin);
    }

    room.currentQuestionIndex = nextIdx;
    room.status = 'QUESTION_OPEN';
    room.currentAnswers = new Map();
    room.questionOpenedAtMono = performance.now();
    room.questionEndsAtEpoch = Date.now() + room.timeLimitSec * 1000;

    await persistRoomStatus(room.pin, room.status, room.currentQuestionIndex);

    // 設定後端強制截止計時器
    room.timerHandle = setTimeout(() => {
      this.revealCurrentQuestion(room.pin).catch((err) =>
        console.error('[Game] Auto reveal error:', err)
      );
    }, room.timeLimitSec * 1000);

    this.broadcastRoomState(room);
    return { ok: true };
  }

  /**
   * 參賽者提交答案（Server 端計時、鎖定單次提交、揭曉前絕不回傳對錯）
   */
  submitAnswer(pin, playerId, selectedOption) {
    const room = this.getRoom(pin);
    if (!room) return { ok: false, error: '找不到房間' };
    if (room.status !== 'QUESTION_OPEN') {
      return { ok: false, error: '目前不在作答時間內' };
    }

    const player = room.players.get(playerId);
    if (!player) {
      return { ok: false, error: '參賽者身分無效或已被移出房間' };
    }

    const opt = String(selectedOption || '').trim().toUpperCase();
    if (!['A', 'B', 'C', 'D'].includes(opt)) {
      return { ok: false, error: '無效的選項' };
    }

    // 防止重複提交或竄改答案
    if (room.currentAnswers.has(playerId)) {
      return { ok: false, error: '本題您已經提交過答案，無法重複作答' };
    }

    const durationMs = room.timeLimitSec * 1000;
    const rawElapsedMs = performance.now() - room.questionOpenedAtMono;
    // 允許 400ms 網路延遲緩衝
    if (rawElapsedMs > durationMs + 400) {
      return { ok: false, error: '作答時間已截止' };
    }

    const elapsedMs = Math.max(0, Math.min(durationMs, Math.round(rawElapsedMs)));
    const q = room.questions[room.currentQuestionIndex];
    const isCorrect = opt === q.answer;

    // 僅記錄於伺服器端，等 QUESTION_REVEAL 時才正式寫入分數並公開
    room.currentAnswers.set(playerId, {
      playerId,
      option: opt,
      isCorrect,
      elapsedMs,
      points: 0 // 揭曉時統一計算並加分
    });

    // 通知全場最新已作答人數（不含誰選了什麼、也不含對錯）
    this.io.to(`room:${room.pin}`).emit('game:answer_count', {
      answeredCount: room.currentAnswers.size,
      totalPlayers: room.players.size
    });

    // 若全場所有參賽者皆已作答，自動提前揭曉答案！
    if (room.players.size > 0 && room.currentAnswers.size >= room.players.size) {
      if (room.timerHandle) {
        clearTimeout(room.timerHandle);
        room.timerHandle = null;
      }
      setImmediate(() => {
        this.revealCurrentQuestion(room.pin).catch((err) =>
          console.error('[Game] Early reveal error:', err)
        );
      });
    }

    return {
      ok: true,
      acceptedOption: opt,
      elapsedMs
    };
  }

  /**
   * 揭曉本題標準答案與解析，並結算本題積分與連勝加成
   */
  async revealCurrentQuestion(pin) {
    const room = this.getRoom(pin);
    if (!room) return { ok: false, error: '找不到房間' };
    if (room.status !== 'QUESTION_OPEN') {
      return { ok: false, error: '本題已揭曉或不在作答狀態' };
    }

    if (room.timerHandle) {
      clearTimeout(room.timerHandle);
      room.timerHandle = null;
    }

    room.status = 'QUESTION_REVEAL';
    const qIdx = room.currentQuestionIndex;
    const durationMs = room.timeLimitSec * 1000;

    // 結算每位參賽者在本題的得分與連勝
    for (const player of room.players.values()) {
      const record = room.currentAnswers.get(player.id);
      if (record) {
        if (record.isCorrect) {
          player.streak += 1;
          player.correctCount += 1;
          player.totalTimeMs += record.elapsedMs;
          // 基礎分 500 + 速度加成最高 500 + 連對獎勵 (最高 +250)
          const speedRatio = Math.max(0, 1 - record.elapsedMs / (durationMs * 1.1));
          const speedBonus = Math.round(500 * speedRatio);
          const streakBonus = Math.min(player.streak - 1, 5) * 50;
          const points = 500 + speedBonus + streakBonus;
          record.points = points;
          player.score += points;
        } else {
          player.streak = 0;
          record.points = 0;
        }
        await persistAnswerAndScore(room.pin, player, qIdx, record);
      } else {
        // 未作答視同中斷連勝
        player.streak = 0;
      }
    }

    room.historyAnswers.set(qIdx, new Map(room.currentAnswers));
    await persistRoomStatus(room.pin, room.status, room.currentQuestionIndex);

    this.broadcastRoomState(room);
    return { ok: true };
  }

  /**
   * 切換至排行榜畫面（LEADERBOARD）
   */
  async showLeaderboard(pin) {
    const room = this.getRoom(pin);
    if (!room) return { ok: false, error: '找不到房間' };
    if (room.status !== 'QUESTION_REVEAL' && room.status !== 'LEADERBOARD') {
      return { ok: false, error: '請先揭曉本題答案後再顯示排行榜' };
    }
    room.status = 'LEADERBOARD';
    await persistRoomStatus(room.pin, room.status, room.currentQuestionIndex);
    this.broadcastRoomState(room);
    return { ok: true };
  }

  /**
   * 結束整場測驗並公布最終頒獎台與完整解析
   */
  async finishGame(pin) {
    const room = this.getRoom(pin);
    if (!room) return { ok: false, error: '找不到房間' };
    if (room.timerHandle) {
      clearTimeout(room.timerHandle);
      room.timerHandle = null;
    }
    room.status = 'FINISHED';
    room.finishedAt = Date.now();
    await persistRoomStatus(room.pin, room.status, room.currentQuestionIndex);
    this.broadcastRoomState(room);
    return { ok: true };
  }

  /**
   * 計算特定題目的單題最高分（MVP）得主資訊
   * 僅讀取已揭曉結算之 room.historyAnswers，絕不退回讀取尚未結算之 currentAnswers。
   * 僅統計目前仍在 room.players 中的有效參賽者，確保與資料庫 ON DELETE CASCADE 行為一致。
   * 狀態區分：has_winner | all_wrong | no_answers | not_played | no_record
   */
  computeQuestionMvp(room, qIdx) {
    if (typeof qIdx !== 'number' || qIdx < 0 || qIdx >= room.questions.length) {
      return null;
    }

    const answersMap = room.historyAnswers.get(qIdx);
    if (!answersMap) {
      return {
        questionIndex: qIdx,
        questionNumber: qIdx + 1,
        status: qIdx > room.currentQuestionIndex ? 'not_played' : 'no_record',
        answeredCount: 0,
        points: 0,
        elapsedMs: null,
        winners: []
      };
    }

    let answeredCount = 0;
    const validCorrect = [];

    for (const rec of answersMap.values()) {
      const player = room.players.get(rec.playerId);
      if (!player) continue;
      answeredCount += 1;
      if (rec.isCorrect && rec.points > 0) {
        validCorrect.push({
          id: player.id,
          nickname: player.nickname,
          groupCode: player.groupCode,
          groupName: player.groupName,
          points: rec.points,
          elapsedMs: rec.elapsedMs
        });
      }
    }

    if (validCorrect.length === 0) {
      return {
        questionIndex: qIdx,
        questionNumber: qIdx + 1,
        status: answeredCount === 0 ? 'no_answers' : 'all_wrong',
        answeredCount,
        points: 0,
        elapsedMs: null,
        winners: []
      };
    }

    validCorrect.sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      return a.elapsedMs - b.elapsedMs;
    });

    const bestPoints = validCorrect[0].points;
    const bestElapsedMs = validCorrect[0].elapsedMs;
    const winners = validCorrect.filter(
      (item) => item.points === bestPoints && item.elapsedMs === bestElapsedMs
    );

    return {
      questionIndex: qIdx,
      questionNumber: qIdx + 1,
      status: 'has_winner',
      answeredCount,
      points: bestPoints,
      elapsedMs: bestElapsedMs,
      winners
    };
  }

  /**
   * 計算個人排行榜與組別統計排行榜
   * 注意：僅在 QUESTION_REVEAL 與 LEADERBOARD 階段附加本題得分與單題王標記，嚴防作答期間 (QUESTION_OPEN) 洩漏對錯！
   */
  computeLeaderboards(room) {
    const canExposeCurrentQuestionStats =
      room.status === 'QUESTION_REVEAL' || room.status === 'LEADERBOARD';
    const qIdx = room.currentQuestionIndex;
    const currentMvp =
      canExposeCurrentQuestionStats && qIdx >= 0 ? this.computeQuestionMvp(room, qIdx) : null;
    const mvpWinnerIds = new Set(
      currentMvp && currentMvp.status === 'has_winner'
        ? currentMvp.winners.map((w) => w.id)
        : []
    );
    const currentAnswersMap =
      canExposeCurrentQuestionStats && qIdx >= 0 ? room.historyAnswers.get(qIdx) || null : null;

    const playersSorted = Array.from(room.players.values())
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (b.correctCount !== a.correctCount) return b.correctCount - a.correctCount;
        return a.totalTimeMs - b.totalTimeMs;
      })
      .map((p, idx) => {
        const rec = currentAnswersMap ? currentAnswersMap.get(p.id) : null;
        return {
          rank: idx + 1,
          id: p.id,
          nickname: p.nickname,
          groupCode: p.groupCode,
          groupName: p.groupName,
          score: p.score,
          streak: p.streak,
          correctCount: p.correctCount,
          totalTimeMs: p.totalTimeMs,
          connected: p.connected,
          lastQuestionPoints: canExposeCurrentQuestionStats ? (rec ? rec.points : 0) : null,
          isQuestionMvp: canExposeCurrentQuestionStats ? mvpWinnerIds.has(p.id) : false
        };
      });

    const groupsStats = [];
    for (const g of room.groups.values()) {
      const members = playersSorted.filter((p) => p.groupCode === g.code);
      const totalScore = members.reduce((sum, m) => sum + m.score, 0);
      const avgScore = members.length > 0 ? Math.round(totalScore / members.length) : 0;
      const totalCorrect = members.reduce((sum, m) => sum + m.correctCount, 0);
      groupsStats.push({
        code: g.code,
        name: g.name,
        memberCount: members.length,
        maxMembers: g.maxMembers,
        totalScore,
        avgScore,
        totalCorrect
      });
    }

    groupsStats.sort((a, b) => {
      if (b.avgScore !== a.avgScore) return b.avgScore - a.avgScore;
      return b.totalScore - a.totalScore;
    });

    groupsStats.forEach((g, idx) => {
      g.rank = idx + 1;
    });

    return {
      individual: playersSorted,
      groups: groupsStats,
      currentQuestionMvp: currentMvp
    };
  }

  /**
   * 計算本題各選項作答分布（僅於 QUESTION_REVEAL 後提供）
   */
  computeOptionDistribution(room) {
    const counts = { A: 0, B: 0, C: 0, D: 0 };
    for (const rec of room.currentAnswers.values()) {
      if (counts[rec.option] !== undefined) {
        counts[rec.option] += 1;
      }
    }
    return counts;
  }

  /**
   * 建立傳給參賽者與大螢幕的安全狀態快照（作答期間嚴格濾除答案與解析）
   */
  buildPublicState(room) {
    const qIdx = room.currentQuestionIndex;
    const rawQ = qIdx >= 0 && qIdx < room.questions.length ? room.questions[qIdx] : null;
    const leaderboards = this.computeLeaderboards(room);

    let questionPayload = null;
    let optionDistribution = null;

    if (rawQ) {
      if (room.status === 'QUESTION_OPEN') {
        questionPayload = sanitizeQuestionForOpenPhase(rawQ, qIdx, room.questions.length);
      } else if (
        room.status === 'QUESTION_REVEAL' ||
        room.status === 'LEADERBOARD' ||
        room.status === 'FINISHED'
      ) {
        questionPayload = sanitizeQuestionForRevealPhase(rawQ, qIdx, room.questions.length);
        optionDistribution = this.computeOptionDistribution(room);
      }
    }

    // 結束時提供全題庫完整回顧、解析與各題單題王
    const allQuestionsReview =
      room.status === 'FINISHED'
        ? room.questions.map((q, idx) => ({
            ...sanitizeQuestionForRevealPhase(q, idx, room.questions.length),
            questionMvp: this.computeQuestionMvp(room, idx)
          }))
        : null;

    return {
      pin: room.pin,
      title: room.title,
      status: room.status,
      maxPlayers: room.maxPlayers,
      currentPlayers: room.players.size,
      timeLimitSec: room.timeLimitSec,
      currentQuestionIndex: room.currentQuestionIndex,
      totalQuestions: room.questions.length,
      questionEndsAtEpoch: room.status === 'QUESTION_OPEN' ? room.questionEndsAtEpoch : null,
      serverNowEpoch: Date.now(),
      answeredCount: room.currentAnswers.size,
      question: questionPayload,
      optionDistribution,
      currentQuestionMvp: leaderboards.currentQuestionMvp,
      leaderboard: leaderboards.individual,
      groupLeaderboard: leaderboards.groups,
      allQuestionsReview
    };
  }

  /**
   * 序列化給主持人後台的完整管理資訊（含各組通行密碼清單）
   */
  serializeRoomForHost(room) {
    const publicState = this.buildPublicState(room);
    const hostGroups = [];
    for (const g of room.groups.values()) {
      const currentMembers = this.getGroupMemberCount(room, g.code);
      hostGroups.push({
        code: g.code,
        name: g.name,
        password: g.plainPassword,
        currentMembers,
        maxMembers: g.maxMembers
      });
    }
    return {
      ...publicState,
      createdBy: room.createdBy || 'admin',
      hostGroups
    };
  }

  /**
   * 建立特定參賽者的個人狀態（在 QUESTION_OPEN 時僅告知已選哪個選項，不透露對錯）
   */
  buildPlayerPersonalState(room, playerId) {
    const player = room.players.get(playerId);
    if (!player) return null;

    const leaderboards = this.computeLeaderboards(room);
    const rankedPlayer = leaderboards.individual.find((p) => p.id === playerId);
    const ans = room.currentAnswers.get(playerId);

    let currentQuestionResult = null;
    if (ans) {
      if (room.status === 'QUESTION_OPEN') {
        currentQuestionResult = {
          submitted: true,
          selectedOption: ans.option,
          elapsedMs: ans.elapsedMs
          // 注意：絕不在 QUESTION_OPEN 包含 isCorrect 或 points
        };
      } else {
        currentQuestionResult = {
          submitted: true,
          selectedOption: ans.option,
          elapsedMs: ans.elapsedMs,
          isCorrect: ans.isCorrect,
          points: ans.points
        };
      }
    } else if (room.status === 'QUESTION_REVEAL' || room.status === 'LEADERBOARD') {
      currentQuestionResult = {
        submitted: false,
        selectedOption: null,
        elapsedMs: null,
        isCorrect: false,
        points: 0
      };
    }

    return {
      id: player.id,
      nickname: player.nickname,
      groupCode: player.groupCode,
      groupName: player.groupName,
      score: player.score,
      streak: player.streak,
      correctCount: player.correctCount,
      rank: rankedPlayer ? rankedPlayer.rank : null,
      // 讓前端比對個人狀態是否對應目前題號與階段，避免舊題結果套用到新題而鎖死選項
      questionIndex: room.currentQuestionIndex,
      roomStatus: room.status,
      currentQuestionResult
    };
  }

  /**
   * 同步推播最新狀態給房間內的大螢幕與所有參賽者
   */
  broadcastRoomState(room) {
    const publicState = this.buildPublicState(room);
    const hostState = this.serializeRoomForHost(room);

    // 推播給主持人
    this.io.to(`host:${room.pin}`).emit('host:state', hostState);

    // 先推播個人專屬作答/名次狀態（確保參賽者收到公開狀態時，個人狀態已對應同一題號）
    for (const player of room.players.values()) {
      if (player.socketId) {
        const personal = this.buildPlayerPersonalState(room, player.id);
        this.io.to(player.socketId).emit('player:personal', personal);
      }
    }

    // 推播公開狀態給房間所有人
    this.io.to(`room:${room.pin}`).emit('game:state', publicState);
  }
}

module.exports = { GameManager };
