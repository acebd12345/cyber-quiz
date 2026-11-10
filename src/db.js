'use strict';

const crypto = require('crypto');
const { Pool } = require('pg');
const { DEFAULT_QUESTIONS } = require('./questions');
const {
  encryptText,
  decryptText,
  hashPassword,
  verifyPassword,
  validateAndSanitizeQuestion,
  validateAdminAccountInput,
  stripControlChars
} = require('./security');

let pool = null;
let dbConnected = false;

// ==================== 記憶體備援與快取狀態 ====================
let memQuestions = [];
let memQuestionNextId = 1;
let memAdmins = [];
let memAdminNextId = 1;
let memAuditLogs = [];
let memAuditNextId = 1;

// 快取管理員狀態（id -> admin object），於每次修改管理員時立即同步，提供 O(1) Token 撤銷檢查
const adminStateCache = new Map();

function resetMemoryQuestionsToDefault(actorUsername = 'system') {
  memQuestions = DEFAULT_QUESTIONS.map((q, idx) => ({
    id: idx + 1,
    number: idx + 1,
    sortOrder: idx + 1,
    title: q.title,
    scenario: q.scenario,
    options: { ...q.options },
    answer: q.answer,
    explanation: q.explanation,
    isEnabled: true,
    version: 1,
    updatedBy: actorUsername,
    updatedAt: new Date().toISOString()
  }));
  memQuestionNextId = memQuestions.length + 1;
}

resetMemoryQuestionsToDefault('system');

function syncAdminCache(adminRecord) {
  if (!adminRecord || !adminRecord.id) return;
  adminStateCache.set(Number(adminRecord.id), {
    id: Number(adminRecord.id),
    username: adminRecord.username,
    displayName: adminRecord.displayName || adminRecord.display_name,
    adminRole: adminRecord.adminRole || adminRecord.admin_role || 'host',
    isActive:
      adminRecord.isActive !== undefined ? Boolean(adminRecord.isActive) : Boolean(adminRecord.is_active),
    tokenVersion: Number(adminRecord.tokenVersion ?? adminRecord.token_version ?? 1)
  });
}

function buildPoolConfig(connectionString, overrideUser, overridePassword, defaultRole) {
  const optionsFlag = defaultRole ? `-c role=${defaultRole}` : undefined;
  if (connectionString) {
    let finalConnStr = connectionString;
    if (overrideUser && overridePassword) {
      finalConnStr = connectionString.replace(
        /^(postgres(?:ql)?:\/\/)([^:]+):([^@]+)@/,
        `$1${encodeURIComponent(overrideUser)}:${encodeURIComponent(overridePassword)}@`
      );
    }
    return {
      connectionString: finalConnStr,
      ...(optionsFlag ? { options: optionsFlag } : {}),
      max: 15,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000
    };
  }

  return {
    host: process.env.PGHOST,
    user: overrideUser || process.env.PGUSER,
    password: overridePassword || process.env.PGPASSWORD,
    database: process.env.PGDATABASE || 'cyber_quiz',
    port: Number(process.env.PGPORT || 5432),
    ...(optionsFlag ? { options: optionsFlag } : {}),
    max: 15,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000
  };
}

async function initDb() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString && !process.env.PGHOST) {
    console.log('[DB] 未設定 DATABASE_URL，啟用內建記憶體模式（含完整 10 題預設題庫）');
    return { connected: false };
  }

  const setupPool = new Pool(buildPoolConfig(connectionString));

  try {
    const client = await setupPool.connect();
    let runtimePassword = null;
    try {
      await client.query('SET ROLE NONE;');
      await client.query(`
        CREATE TABLE IF NOT EXISTS quiz_questions (
          id SERIAL PRIMARY KEY,
          question_number INT NOT NULL,
          sort_order INT NOT NULL DEFAULT 1,
          title TEXT NOT NULL,
          scenario TEXT NOT NULL,
          option_a TEXT NOT NULL,
          option_b TEXT NOT NULL,
          option_c TEXT NOT NULL,
          option_d TEXT NOT NULL,
          correct_option CHAR(1) NOT NULL CHECK (correct_option IN ('A', 'B', 'C', 'D')),
          explanation TEXT NOT NULL,
          is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
          version INT NOT NULL DEFAULT 1,
          updated_by VARCHAR(64) NOT NULL DEFAULT 'system',
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        ALTER TABLE quiz_questions ADD COLUMN IF NOT EXISTS sort_order INT NOT NULL DEFAULT 1;
        ALTER TABLE quiz_questions ADD COLUMN IF NOT EXISTS is_enabled BOOLEAN NOT NULL DEFAULT TRUE;
        ALTER TABLE quiz_questions ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 1;
        ALTER TABLE quiz_questions ADD COLUMN IF NOT EXISTS updated_by VARCHAR(64) NOT NULL DEFAULT 'system';
        ALTER TABLE quiz_questions DROP CONSTRAINT IF EXISTS quiz_questions_question_number_key;

        CREATE TABLE IF NOT EXISTS quiz_rooms (
          pin VARCHAR(12) PRIMARY KEY,
          title TEXT NOT NULL,
          status VARCHAR(24) NOT NULL DEFAULT 'LOBBY',
          max_players INT NOT NULL DEFAULT 100,
          time_limit_sec INT NOT NULL DEFAULT 25,
          current_question_idx INT NOT NULL DEFAULT -1,
          questions_snapshot JSONB,
          created_by VARCHAR(64) NOT NULL DEFAULT 'admin',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          finished_at TIMESTAMPTZ
        );

        ALTER TABLE quiz_rooms ADD COLUMN IF NOT EXISTS questions_snapshot JSONB;
        ALTER TABLE quiz_rooms ADD COLUMN IF NOT EXISTS created_by VARCHAR(64) NOT NULL DEFAULT 'admin';

        CREATE TABLE IF NOT EXISTS quiz_groups (
          id SERIAL PRIMARY KEY,
          room_pin VARCHAR(12) NOT NULL REFERENCES quiz_rooms(pin) ON DELETE CASCADE,
          group_code VARCHAR(32) NOT NULL,
          group_name VARCHAR(64) NOT NULL,
          password_hash TEXT NOT NULL,
          password_cipher TEXT NOT NULL DEFAULT '',
          max_members INT NOT NULL DEFAULT 5,
          UNIQUE (room_pin, group_code)
        );

        ALTER TABLE quiz_groups ADD COLUMN IF NOT EXISTS password_cipher TEXT NOT NULL DEFAULT '';

        CREATE TABLE IF NOT EXISTS quiz_players (
          player_id VARCHAR(64) PRIMARY KEY,
          room_pin VARCHAR(12) NOT NULL REFERENCES quiz_rooms(pin) ON DELETE CASCADE,
          group_code VARCHAR(32) NOT NULL,
          group_name VARCHAR(64) NOT NULL,
          nickname VARCHAR(32) NOT NULL,
          score INT NOT NULL DEFAULT 0,
          streak INT NOT NULL DEFAULT 0,
          correct_count INT NOT NULL DEFAULT 0,
          total_time_ms INT NOT NULL DEFAULT 0,
          joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (room_pin, nickname)
        );

        CREATE TABLE IF NOT EXISTS quiz_answers (
          id SERIAL PRIMARY KEY,
          room_pin VARCHAR(12) NOT NULL REFERENCES quiz_rooms(pin) ON DELETE CASCADE,
          player_id VARCHAR(64) NOT NULL REFERENCES quiz_players(player_id) ON DELETE CASCADE,
          question_idx INT NOT NULL,
          selected_option CHAR(1) NOT NULL CHECK (selected_option IN ('A', 'B', 'C', 'D')),
          is_correct BOOLEAN NOT NULL,
          elapsed_ms INT NOT NULL,
          points_awarded INT NOT NULL,
          answered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (room_pin, player_id, question_idx)
        );

        CREATE TABLE IF NOT EXISTS quiz_admins (
          id SERIAL PRIMARY KEY,
          username VARCHAR(32) UNIQUE NOT NULL,
          display_name VARCHAR(64) NOT NULL,
          password_hash TEXT NOT NULL,
          admin_role VARCHAR(16) NOT NULL DEFAULT 'host' CHECK (admin_role IN ('super_admin', 'host')),
          is_active BOOLEAN NOT NULL DEFAULT TRUE,
          token_version INT NOT NULL DEFAULT 1,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_login_at TIMESTAMPTZ
        );

        CREATE TABLE IF NOT EXISTS quiz_audit_logs (
          id SERIAL PRIMARY KEY,
          actor_username VARCHAR(32) NOT NULL,
          action VARCHAR(48) NOT NULL,
          target_type VARCHAR(32),
          target_id VARCHAR(64),
          detail TEXT,
          client_ip VARCHAR(64),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);

      // 僅在題庫資料表為空時寫入預設 10 題，絕不覆寫管理員已修改之題目
      const countRes = await client.query('SELECT COUNT(*)::int AS cnt FROM quiz_questions');
      if ((countRes.rows[0]?.cnt || 0) === 0) {
        for (const q of DEFAULT_QUESTIONS) {
          await client.query(
            `
            INSERT INTO quiz_questions (
              question_number, sort_order, title, scenario,
              option_a, option_b, option_c, option_d,
              correct_option, explanation, is_enabled, version, updated_by
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE, 1, 'system')
            `,
            [
              q.number,
              q.number,
              q.title,
              q.scenario,
              q.options.A,
              q.options.B,
              q.options.C,
              q.options.D,
              q.answer,
              q.explanation
            ]
          );
        }
      } else {
        // 確保既有資料的 sort_order 與 question_number 同步
        await client.query(`
          UPDATE quiz_questions
          SET sort_order = question_number
          WHERE sort_order IS NULL OR sort_order = 1 AND question_number > 1
        `);
      }

      // 1. 建立非 cloudsqlsuperuser 的最小權限角色 cyber_quiz_worker (NOLOGIN)
      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cyber_quiz_worker') THEN
            CREATE ROLE cyber_quiz_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
          END IF;
          EXECUTE format('GRANT cyber_quiz_worker TO %I', session_user);
        END
        $$;
        GRANT USAGE ON SCHEMA public TO cyber_quiz_worker;
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
          quiz_questions, quiz_rooms, quiz_groups, quiz_players, quiz_answers, quiz_admins, quiz_audit_logs
        TO cyber_quiz_worker;
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO cyber_quiz_worker;
      `);

      // 2. 僅在目前登入帳號具備 CREATEROLE 權限時，建立或更新 cyber_quiz_runtime
      const rolePrivRes = await client.query(
        `SELECT rolcreaterole, rolsuper FROM pg_roles WHERE rolname = session_user`
      );
      const canCreateRole = Boolean(
        rolePrivRes.rows[0]?.rolcreaterole || rolePrivRes.rows[0]?.rolsuper
      );
      if (canCreateRole) {
        try {
          const candidatePass = 'Rt_' + crypto.randomBytes(14).toString('hex') + '_A9!';
          await client.query(`
            DO $$
            BEGIN
              IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cyber_quiz_runtime') THEN
                CREATE ROLE cyber_quiz_runtime WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD '${candidatePass}';
              ELSE
                ALTER ROLE cyber_quiz_runtime WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD '${candidatePass}';
              END IF;
            END
            $$;
            GRANT USAGE ON SCHEMA public TO cyber_quiz_runtime;
            GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
              quiz_questions, quiz_rooms, quiz_groups, quiz_players, quiz_answers, quiz_admins, quiz_audit_logs
            TO cyber_quiz_runtime;
            GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO cyber_quiz_runtime;
          `);
          runtimePassword = candidatePass;
        } catch (privErr) {
          console.warn('[DB] Runtime login role fallback to cyber_quiz_worker:', privErr.message);
        }
      }

      // 將此條初始連線也降權為 cyber_quiz_worker
      await client.query('SET ROLE cyber_quiz_worker;');
    } finally {
      client.release();
    }

    if (runtimePassword) {
      try {
        const candidatePool = new Pool(
          buildPoolConfig(
            connectionString,
            'cyber_quiz_runtime',
            runtimePassword,
            'cyber_quiz_worker'
          )
        );
        const rtClient = await candidatePool.connect();
        rtClient.release();
        await setupPool.end();
        pool = candidatePool;
        console.log('[DB] 已切換至最小權限執行期登入帳號 cyber_quiz_runtime');
      } catch (connErr) {
        console.warn('[DB] Runtime pool fallback to setupPool with role option:', connErr.message);
        await setupPool.end();
        pool = new Pool(buildPoolConfig(connectionString, null, null, 'cyber_quiz_worker'));
      }
    } else {
      await setupPool.end();
      pool = new Pool(buildPoolConfig(connectionString, null, null, 'cyber_quiz_worker'));
    }

    pool.on('error', (err) => {
      console.error('[DB] Unexpected PostgreSQL pool error:', err.message);
    });

    dbConnected = true;
    return { connected: true };
  } catch (err) {
    console.error('[DB] PostgreSQL 初始化失敗，自動切換為高可用記憶體模式:', err.message);
    dbConnected = false;
    return { connected: false, error: err.message };
  }
}

// ==================== 多管理者帳號與稽核日誌 ====================

async function ensureBootstrapAdmin(hostPassword) {
  const bootstrapHash = hashPassword(hostPassword);
  if (!dbConnected || !pool) {
    const existing = memAdmins.find((a) => a.username === 'admin');
    if (!existing) {
      const adminObj = {
        id: memAdminNextId++,
        username: 'admin',
        displayName: '系統管理員',
        passwordHash: bootstrapHash,
        adminRole: 'super_admin',
        isActive: true,
        tokenVersion: 1,
        createdAt: new Date().toISOString(),
        lastLoginAt: null
      };
      memAdmins.push(adminObj);
      syncAdminCache(adminObj);
    } else if (existing.tokenVersion === 1) {
      existing.passwordHash = bootstrapHash;
      syncAdminCache(existing);
    }
    return;
  }

  try {
    const res = await pool.query('SELECT * FROM quiz_admins ORDER BY id ASC');
    if (res.rows.length === 0) {
      const ins = await pool.query(
        `INSERT INTO quiz_admins (username, display_name, password_hash, admin_role, is_active, token_version)
         VALUES ('admin', '系統管理員', $1, 'super_admin', TRUE, 1)
         RETURNING *`,
        [bootstrapHash]
      );
      syncAdminCache(ins.rows[0]);
    } else {
      for (const row of res.rows) {
        if (row.username === 'admin' && Number(row.token_version) === 1) {
          await pool.query(`UPDATE quiz_admins SET password_hash = $1 WHERE id = $2`, [
            bootstrapHash,
            row.id
          ]);
        }
        syncAdminCache(row);
      }
    }
  } catch (err) {
    console.error('[DB] ensureBootstrapAdmin error:', err.message);
  }
}

async function authenticateAdmin(usernameInput, plainPassword) {
  const cleanUser = String(usernameInput || 'admin')
    .trim()
    .toLowerCase();
  const rawPass = String(plainPassword || '');

  if (!dbConnected || !pool) {
    const target = memAdmins.find((a) => a.username === cleanUser);
    const matched = verifyPassword(rawPass, target ? target.passwordHash : null);
    if (!target || !matched) {
      return { ok: false, error: '帳號或密碼錯誤。' };
    }
    if (!target.isActive) {
      return { ok: false, error: '此管理帳號已停用，請聯絡系統管理員。' };
    }
    target.lastLoginAt = new Date().toISOString();
    syncAdminCache(target);
    return {
      ok: true,
      admin: {
        id: target.id,
        username: target.username,
        displayName: target.displayName,
        adminRole: target.adminRole,
        tokenVersion: target.tokenVersion
      }
    };
  }

  try {
    const res = await pool.query(`SELECT * FROM quiz_admins WHERE username = $1 LIMIT 1`, [
      cleanUser
    ]);
    const row = res.rows[0] || null;
    const matched = verifyPassword(rawPass, row ? row.password_hash : null);
    if (!row || !matched) {
      return { ok: false, error: '帳號或密碼錯誤。' };
    }
    if (!row.is_active) {
      return { ok: false, error: '此管理帳號已停用，請聯絡系統管理員。' };
    }
    await pool.query(`UPDATE quiz_admins SET last_login_at = NOW() WHERE id = $1`, [row.id]);
    syncAdminCache(row);
    return {
      ok: true,
      admin: {
        id: row.id,
        username: row.username,
        displayName: row.display_name,
        adminRole: row.admin_role,
        tokenVersion: row.token_version
      }
    };
  } catch (err) {
    console.error('[DB] authenticateAdmin error:', err.message);
    return { ok: false, error: '登入驗證時發生錯誤。' };
  }
}

/**
 * 同步驗證 Token 內之管理員是否仍為啟用狀態且 tokenVersion 一致
 */
function verifyAdminTokenState(payload) {
  if (!payload || payload.role !== 'host') return null;
  const adminId = Number(payload.adminId || 1);
  const cached = adminStateCache.get(adminId);
  if (!cached) {
    return null;
  }
  if (!cached.isActive) {
    return null;
  }
  if (payload.tokenVersion !== undefined && Number(payload.tokenVersion) !== cached.tokenVersion) {
    return null;
  }
  return {
    id: cached.id,
    username: cached.username,
    displayName: cached.displayName,
    adminRole: cached.adminRole,
    tokenVersion: cached.tokenVersion
  };
}

async function listAdminsFromDb() {
  if (!dbConnected || !pool) {
    return memAdmins.map((a) => ({
      id: a.id,
      username: a.username,
      displayName: a.displayName,
      adminRole: a.adminRole,
      isActive: a.isActive,
      createdAt: a.createdAt,
      lastLoginAt: a.lastLoginAt
    }));
  }
  const res = await pool.query(
    `SELECT id, username, display_name, admin_role, is_active, created_at, last_login_at
     FROM quiz_admins
     ORDER BY id ASC`
  );
  return res.rows.map((r) => ({
    id: r.id,
    username: r.username,
    displayName: r.display_name,
    adminRole: r.admin_role,
    isActive: r.is_active,
    createdAt: r.created_at,
    lastLoginAt: r.last_login_at
  }));
}

async function createAdminInDb({ username, displayName, password, adminRole = 'host' }) {
  const check = validateAdminAccountInput({ username, displayName, password, adminRole }, true);
  if (!check.valid) return { ok: false, error: check.error };

  const cleanUser = String(username).trim().toLowerCase();
  const cleanName = stripControlChars(String(displayName));
  const pwdHash = hashPassword(password);

  if (!dbConnected || !pool) {
    if (memAdmins.some((a) => a.username === cleanUser)) {
      return { ok: false, error: '此帳號名稱已存在。' };
    }
    const created = {
      id: memAdminNextId++,
      username: cleanUser,
      displayName: cleanName,
      passwordHash: pwdHash,
      adminRole,
      isActive: true,
      tokenVersion: 1,
      createdAt: new Date().toISOString(),
      lastLoginAt: null
    };
    memAdmins.push(created);
    syncAdminCache(created);
    return {
      ok: true,
      admin: {
        id: created.id,
        username: created.username,
        displayName: created.displayName,
        adminRole: created.adminRole,
        isActive: created.isActive,
        createdAt: created.createdAt
      }
    };
  }

  try {
    const ins = await pool.query(
      `INSERT INTO quiz_admins (username, display_name, password_hash, admin_role, is_active, token_version)
       VALUES ($1, $2, $3, $4, TRUE, 1)
       RETURNING id, username, display_name, admin_role, is_active, token_version, created_at, last_login_at`,
      [cleanUser, cleanName, pwdHash, adminRole]
    );
    const row = ins.rows[0];
    syncAdminCache(row);
    return {
      ok: true,
      admin: {
        id: row.id,
        username: row.username,
        displayName: row.display_name,
        adminRole: row.admin_role,
        isActive: row.is_active,
        createdAt: row.created_at
      }
    };
  } catch (err) {
    if (err.code === '23505') {
      return { ok: false, error: '此帳號名稱已存在。' };
    }
    console.error('[DB] createAdminInDb error:', err.message);
    return { ok: false, error: '新增管理帳號失敗。' };
  }
}

async function updateAdminInDb(targetId, updates = {}, actorAdmin) {
  const numId = Number(targetId);
  if (!numId) return { ok: false, error: '無效的管理員 ID。' };

  const check = validateAdminAccountInput(updates, false);
  if (!check.valid) return { ok: false, error: check.error };

  // 防止停用自己或將自己降級
  if (actorAdmin && Number(actorAdmin.id) === numId) {
    if (updates.isActive === false) {
      return { ok: false, error: '不可停用目前登入中的自己的帳號。' };
    }
    if (updates.adminRole && updates.adminRole !== 'super_admin') {
      return { ok: false, error: '不可將自己的最高管理員權限降級。' };
    }
  }

  if (!dbConnected || !pool) {
    const target = memAdmins.find((a) => a.id === numId);
    if (!target) return { ok: false, error: '找不到該管理帳號。' };

    const willCeaseSuperAdmin =
      target.adminRole === 'super_admin' &&
      target.isActive &&
      (updates.isActive === false || (updates.adminRole && updates.adminRole !== 'super_admin'));
    if (willCeaseSuperAdmin) {
      const activeSuperCount = memAdmins.filter(
        (a) => a.isActive && a.adminRole === 'super_admin'
      ).length;
      if (activeSuperCount <= 1) {
        return { ok: false, error: '系統至少須保留一位啟用中的最高管理員。' };
      }
    }

    let bumpVersion = false;
    if (updates.displayName !== undefined) {
      target.displayName = stripControlChars(String(updates.displayName));
    }
    if (updates.password) {
      target.passwordHash = hashPassword(updates.password);
      bumpVersion = true;
    }
    if (updates.adminRole && updates.adminRole !== target.adminRole) {
      target.adminRole = updates.adminRole;
      bumpVersion = true;
    }
    if (updates.isActive !== undefined && Boolean(updates.isActive) !== target.isActive) {
      target.isActive = Boolean(updates.isActive);
      bumpVersion = true;
    }
    if (bumpVersion) {
      target.tokenVersion += 1;
    }
    syncAdminCache(target);
    return {
      ok: true,
      admin: {
        id: target.id,
        username: target.username,
        displayName: target.displayName,
        adminRole: target.adminRole,
        isActive: target.isActive
      }
    };
  }

  try {
    const currentRes = await pool.query(`SELECT * FROM quiz_admins WHERE id = $1`, [numId]);
    const target = currentRes.rows[0];
    if (!target) return { ok: false, error: '找不到該管理帳號。' };

    const willCeaseSuperAdmin =
      target.admin_role === 'super_admin' &&
      target.is_active &&
      (updates.isActive === false || (updates.adminRole && updates.adminRole !== 'super_admin'));
    if (willCeaseSuperAdmin) {
      const superCountRes = await pool.query(
        `SELECT COUNT(*)::int AS cnt FROM quiz_admins WHERE is_active = TRUE AND admin_role = 'super_admin'`
      );
      if ((superCountRes.rows[0]?.cnt || 0) <= 1) {
        return { ok: false, error: '系統至少須保留一位啟用中的最高管理員。' };
      }
    }

    const newDisplayName =
      updates.displayName !== undefined
        ? stripControlChars(String(updates.displayName))
        : target.display_name;
    const newPasswordHash = updates.password ? hashPassword(updates.password) : target.password_hash;
    const newRole = updates.adminRole || target.admin_role;
    const newActive =
      updates.isActive !== undefined ? Boolean(updates.isActive) : target.is_active;

    const shouldBump =
      Boolean(updates.password) ||
      newRole !== target.admin_role ||
      newActive !== target.is_active;
    const newTokenVersion = shouldBump ? Number(target.token_version) + 1 : Number(target.token_version);

    const upd = await pool.query(
      `UPDATE quiz_admins
       SET display_name = $2,
           password_hash = $3,
           admin_role = $4,
           is_active = $5,
           token_version = $6
       WHERE id = $1
       RETURNING *`,
      [numId, newDisplayName, newPasswordHash, newRole, newActive, newTokenVersion]
    );
    const updatedRow = upd.rows[0];
    syncAdminCache(updatedRow);
    return {
      ok: true,
      admin: {
        id: updatedRow.id,
        username: updatedRow.username,
        displayName: updatedRow.display_name,
        adminRole: updatedRow.admin_role,
        isActive: updatedRow.is_active
      }
    };
  } catch (err) {
    console.error('[DB] updateAdminInDb error:', err.message);
    return { ok: false, error: '更新管理帳號失敗。' };
  }
}

async function writeAuditLog({ actorUsername, action, targetType, targetId, detail, clientIp }) {
  const entry = {
    id: memAuditNextId++,
    actorUsername: String(actorUsername || 'system').slice(0, 32),
    action: String(action || '').slice(0, 48),
    targetType: targetType ? String(targetType).slice(0, 32) : null,
    targetId: targetId ? String(targetId).slice(0, 64) : null,
    detail: detail ? String(detail).slice(0, 500) : null,
    clientIp: clientIp ? String(clientIp).slice(0, 64) : null,
    createdAt: new Date().toISOString()
  };

  if (!dbConnected || !pool) {
    memAuditLogs.unshift(entry);
    if (memAuditLogs.length > 200) memAuditLogs.length = 200;
    return;
  }

  try {
    await pool.query(
      `INSERT INTO quiz_audit_logs (actor_username, action, target_type, target_id, detail, client_ip)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        entry.actorUsername,
        entry.action,
        entry.targetType,
        entry.targetId,
        entry.detail,
        entry.clientIp
      ]
    );
  } catch (err) {
    console.error('[DB] writeAuditLog error:', err.message);
  }
}

async function listAuditLogsFromDb(limit = 50) {
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
  if (!dbConnected || !pool) {
    return memAuditLogs.slice(0, safeLimit);
  }
  const res = await pool.query(
    `SELECT id, actor_username, action, target_type, target_id, detail, client_ip, created_at
     FROM quiz_audit_logs
     ORDER BY id DESC
     LIMIT $1`,
    [safeLimit]
  );
  return res.rows.map((r) => ({
    id: r.id,
    actorUsername: r.actor_username,
    action: r.action,
    targetType: r.target_type,
    targetId: r.target_id,
    detail: r.detail,
    clientIp: r.client_ip,
    createdAt: r.created_at
  }));
}

// ==================== 後台題庫 CRUD 與房間題目載入 ====================

async function loadQuestionsFromDb(options = {}) {
  const enabledOnly = options.enabledOnly !== undefined ? Boolean(options.enabledOnly) : true;

  if (!dbConnected || !pool) {
    const sorted = [...memQuestions].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
    const filtered = enabledOnly ? sorted.filter((q) => q.isEnabled) : sorted;
    return filtered.map((q, idx) => ({
      id: q.id,
      number: enabledOnly ? idx + 1 : q.sortOrder,
      sortOrder: q.sortOrder,
      title: q.title,
      scenario: q.scenario,
      options: { ...q.options },
      answer: q.answer,
      explanation: q.explanation,
      isEnabled: q.isEnabled,
      version: q.version,
      updatedBy: q.updatedBy,
      updatedAt: q.updatedAt
    }));
  }

  try {
    const whereClause = enabledOnly ? 'WHERE is_enabled = TRUE' : '';
    const res = await pool.query(
      `SELECT id, question_number, sort_order, title, scenario,
              option_a, option_b, option_c, option_d,
              correct_option, explanation, is_enabled, version, updated_by, updated_at
       FROM quiz_questions
       ${whereClause}
       ORDER BY sort_order ASC, id ASC`
    );
    if (res.rows.length === 0 && enabledOnly) {
      return DEFAULT_QUESTIONS.map((q, idx) => ({
        id: idx + 1,
        number: idx + 1,
        sortOrder: idx + 1,
        title: q.title,
        scenario: q.scenario,
        options: { ...q.options },
        answer: q.answer,
        explanation: q.explanation,
        isEnabled: true,
        version: 1
      }));
    }
    return res.rows.map((r, idx) => ({
      id: r.id,
      number: enabledOnly ? idx + 1 : r.sort_order,
      sortOrder: r.sort_order,
      title: r.title,
      scenario: r.scenario,
      options: {
        A: r.option_a,
        B: r.option_b,
        C: r.option_c,
        D: r.option_d
      },
      answer: r.correct_option,
      explanation: r.explanation,
      isEnabled: r.is_enabled,
      version: r.version,
      updatedBy: r.updated_by,
      updatedAt: r.updated_at
    }));
  } catch (err) {
    console.error('[DB] 讀取題庫失敗，使用內建題庫:', err.message);
    return DEFAULT_QUESTIONS.map((q) => ({ ...q, options: { ...q.options } }));
  }
}

async function createQuestionInDb(input, actorUsername = 'admin') {
  const check = validateAndSanitizeQuestion(input);
  if (!check.valid) return { ok: false, error: check.error };
  const val = check.value;

  if (!dbConnected || !pool) {
    const maxOrder = memQuestions.reduce((m, q) => Math.max(m, q.sortOrder), 0);
    const created = {
      id: memQuestionNextId++,
      number: maxOrder + 1,
      sortOrder: maxOrder + 1,
      title: val.title,
      scenario: val.scenario,
      options: { ...val.options },
      answer: val.answer,
      explanation: val.explanation,
      isEnabled: val.isEnabled,
      version: 1,
      updatedBy: actorUsername,
      updatedAt: new Date().toISOString()
    };
    memQuestions.push(created);
    return { ok: true, question: created };
  }

  try {
    const maxRes = await pool.query(
      `SELECT COALESCE(MAX(sort_order), 0)::int AS max_order FROM quiz_questions`
    );
    const nextOrder = (maxRes.rows[0]?.max_order || 0) + 1;
    const ins = await pool.query(
      `INSERT INTO quiz_questions (
         question_number, sort_order, title, scenario,
         option_a, option_b, option_c, option_d,
         correct_option, explanation, is_enabled, version, updated_by, updated_at
       )
       VALUES ($1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1, $11, NOW())
       RETURNING *`,
      [
        nextOrder,
        val.title,
        val.scenario,
        val.options.A,
        val.options.B,
        val.options.C,
        val.options.D,
        val.answer,
        val.explanation,
        val.isEnabled,
        actorUsername
      ]
    );
    const r = ins.rows[0];
    return {
      ok: true,
      question: {
        id: r.id,
        number: r.sort_order,
        sortOrder: r.sort_order,
        title: r.title,
        scenario: r.scenario,
        options: { A: r.option_a, B: r.option_b, C: r.option_c, D: r.option_d },
        answer: r.correct_option,
        explanation: r.explanation,
        isEnabled: r.is_enabled,
        version: r.version,
        updatedBy: r.updated_by,
        updatedAt: r.updated_at
      }
    };
  } catch (err) {
    console.error('[DB] createQuestionInDb error:', err.message);
    return { ok: false, error: '新增題目失敗。' };
  }
}

async function updateQuestionInDb(questionId, input, actorUsername = 'admin') {
  const numId = Number(questionId);
  if (!numId) return { ok: false, error: '無效的題目 ID。' };

  const check = validateAndSanitizeQuestion(input);
  if (!check.valid) return { ok: false, error: check.error };
  const val = check.value;
  const expectedVersion =
    input.version !== undefined && input.version !== null ? Number(input.version) : null;

  if (!dbConnected || !pool) {
    const target = memQuestions.find((q) => q.id === numId);
    if (!target) return { ok: false, error: '找不到該題目。' };
    if (expectedVersion !== null && target.version !== expectedVersion) {
      return {
        ok: false,
        conflict: true,
        error: '此題目已被其他管理員修改，請重新整理後再編輯。'
      };
    }
    if (!val.isEnabled && target.isEnabled) {
      const enabledCount = memQuestions.filter((q) => q.isEnabled).length;
      if (enabledCount <= 1) {
        return { ok: false, error: '題庫至少須保留 1 題啟用中的題目。' };
      }
    }

    target.title = val.title;
    target.scenario = val.scenario;
    target.options = { ...val.options };
    target.answer = val.answer;
    target.explanation = val.explanation;
    target.isEnabled = val.isEnabled;
    target.version += 1;
    target.updatedBy = actorUsername;
    target.updatedAt = new Date().toISOString();
    return { ok: true, question: { ...target, options: { ...target.options } } };
  }

  try {
    const curRes = await pool.query(`SELECT * FROM quiz_questions WHERE id = $1`, [numId]);
    const current = curRes.rows[0];
    if (!current) return { ok: false, error: '找不到該題目。' };

    if (expectedVersion !== null && Number(current.version) !== expectedVersion) {
      return {
        ok: false,
        conflict: true,
        error: '此題目已被其他管理員修改，請重新整理後再編輯。'
      };
    }

    if (!val.isEnabled && current.is_enabled) {
      const enRes = await pool.query(
        `SELECT COUNT(*)::int AS cnt FROM quiz_questions WHERE is_enabled = TRUE`
      );
      if ((enRes.rows[0]?.cnt || 0) <= 1) {
        return { ok: false, error: '題庫至少須保留 1 題啟用中的題目。' };
      }
    }

    const upd = await pool.query(
      `UPDATE quiz_questions
       SET title = $2,
           scenario = $3,
           option_a = $4,
           option_b = $5,
           option_c = $6,
           option_d = $7,
           correct_option = $8,
           explanation = $9,
           is_enabled = $10,
           version = version + 1,
           updated_by = $11,
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [
        numId,
        val.title,
        val.scenario,
        val.options.A,
        val.options.B,
        val.options.C,
        val.options.D,
        val.answer,
        val.explanation,
        val.isEnabled,
        actorUsername
      ]
    );
    const r = upd.rows[0];
    return {
      ok: true,
      question: {
        id: r.id,
        number: r.sort_order,
        sortOrder: r.sort_order,
        title: r.title,
        scenario: r.scenario,
        options: { A: r.option_a, B: r.option_b, C: r.option_c, D: r.option_d },
        answer: r.correct_option,
        explanation: r.explanation,
        isEnabled: r.is_enabled,
        version: r.version,
        updatedBy: r.updated_by,
        updatedAt: r.updated_at
      }
    };
  } catch (err) {
    console.error('[DB] updateQuestionInDb error:', err.message);
    return { ok: false, error: '更新題目失敗。' };
  }
}

async function deleteQuestionInDb(questionId) {
  const numId = Number(questionId);
  if (!numId) return { ok: false, error: '無效的題目 ID。' };

  if (!dbConnected || !pool) {
    const idx = memQuestions.findIndex((q) => q.id === numId);
    if (idx === -1) return { ok: false, error: '找不到該題目。' };
    const remainingEnabled = memQuestions.filter((q) => q.id !== numId && q.isEnabled).length;
    if (remainingEnabled < 1) {
      return { ok: false, error: '刪除後將無啟用題目，至少須保留 1 題啟用題目。' };
    }
    memQuestions.splice(idx, 1);
    memQuestions
      .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)
      .forEach((q, i) => {
        q.sortOrder = i + 1;
        q.number = i + 1;
      });
    return { ok: true };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const remRes = await client.query(
      `SELECT COUNT(*)::int AS cnt FROM quiz_questions WHERE id <> $1 AND is_enabled = TRUE`,
      [numId]
    );
    if ((remRes.rows[0]?.cnt || 0) < 1) {
      await client.query('ROLLBACK');
      return { ok: false, error: '刪除後將無啟用題目，至少須保留 1 題啟用題目。' };
    }

    const delRes = await client.query(`DELETE FROM quiz_questions WHERE id = $1 RETURNING id`, [
      numId
    ]);
    if (delRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return { ok: false, error: '找不到該題目。' };
    }

    // 重新正規化 sort_order 與 question_number
    const allRes = await client.query(
      `SELECT id FROM quiz_questions ORDER BY sort_order ASC, id ASC`
    );
    for (let i = 0; i < allRes.rows.length; i++) {
      await client.query(
        `UPDATE quiz_questions SET sort_order = $2, question_number = $2 WHERE id = $1`,
        [allRes.rows[i].id, i + 1]
      );
    }
    await client.query('COMMIT');
    return { ok: true };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[DB] deleteQuestionInDb error:', err.message);
    return { ok: false, error: '刪除題目失敗。' };
  } finally {
    client.release();
  }
}

async function reorderQuestionsInDb(orderedIds = [], actorUsername = 'admin') {
  if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
    return { ok: false, error: '請提供有效的題目順序清單。' };
  }
  const cleanIds = orderedIds.map((id) => Number(id)).filter((id) => id > 0);

  if (!dbConnected || !pool) {
    const mapById = new Map(memQuestions.map((q) => [q.id, q]));
    let order = 1;
    for (const id of cleanIds) {
      const q = mapById.get(id);
      if (q) {
        q.sortOrder = order;
        q.number = order;
        q.updatedBy = actorUsername;
        order++;
        mapById.delete(id);
      }
    }
    for (const q of mapById.values()) {
      q.sortOrder = order;
      q.number = order;
      order++;
    }
    memQuestions.sort((a, b) => a.sortOrder - b.sortOrder);
    return { ok: true };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < cleanIds.length; i++) {
      await client.query(
        `UPDATE quiz_questions
         SET sort_order = $2, question_number = $2, updated_by = $3, updated_at = NOW()
         WHERE id = $1`,
        [cleanIds[i], i + 1, actorUsername]
      );
    }
    await client.query('COMMIT');
    return { ok: true };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[DB] reorderQuestionsInDb error:', err.message);
    return { ok: false, error: '調整題目順序失敗。' };
  } finally {
    client.release();
  }
}

async function importOrResetQuestionsInDb(rawQuestions, mode = 'replace', actorUsername = 'admin') {
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0 || rawQuestions.length > 200) {
    return { ok: false, error: '題目數量須為 1 至 200 題。' };
  }

  const sanitizedList = [];
  for (let i = 0; i < rawQuestions.length; i++) {
    const check = validateAndSanitizeQuestion(rawQuestions[i]);
    if (!check.valid) {
      return { ok: false, error: `第 ${i + 1} 題格式錯誤：${check.error}` };
    }
    sanitizedList.push(check.value);
  }

  if (mode === 'replace' && !sanitizedList.some((q) => q.isEnabled)) {
    sanitizedList[0].isEnabled = true;
  }

  if (!dbConnected || !pool) {
    if (mode === 'replace') {
      memQuestions = [];
    }
    const baseOrder = memQuestions.reduce((m, q) => Math.max(m, q.sortOrder), 0);
    sanitizedList.forEach((val, idx) => {
      const ord = baseOrder + idx + 1;
      memQuestions.push({
        id: memQuestionNextId++,
        number: ord,
        sortOrder: ord,
        title: val.title,
        scenario: val.scenario,
        options: { ...val.options },
        answer: val.answer,
        explanation: val.explanation,
        isEnabled: val.isEnabled,
        version: 1,
        updatedBy: actorUsername,
        updatedAt: new Date().toISOString()
      });
    });
    return { ok: true, count: sanitizedList.length };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let baseOrder = 0;
    if (mode === 'replace') {
      await client.query('DELETE FROM quiz_questions');
    } else {
      const maxRes = await client.query(
        'SELECT COALESCE(MAX(sort_order), 0)::int AS max_order FROM quiz_questions'
      );
      baseOrder = maxRes.rows[0]?.max_order || 0;
    }

    for (let i = 0; i < sanitizedList.length; i++) {
      const val = sanitizedList[i];
      const ord = baseOrder + i + 1;
      await client.query(
        `INSERT INTO quiz_questions (
           question_number, sort_order, title, scenario,
           option_a, option_b, option_c, option_d,
           correct_option, explanation, is_enabled, version, updated_by, updated_at
         )
         VALUES ($1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1, $11, NOW())`,
        [
          ord,
          val.title,
          val.scenario,
          val.options.A,
          val.options.B,
          val.options.C,
          val.options.D,
          val.answer,
          val.explanation,
          val.isEnabled,
          actorUsername
        ]
      );
    }
    await client.query('COMMIT');
    return { ok: true, count: sanitizedList.length };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[DB] importOrResetQuestionsInDb error:', err.message);
    return { ok: false, error: '匯入或還原題庫失敗。' };
  } finally {
    client.release();
  }
}

async function getPrivilegeStatus() {
  if (!dbConnected || !pool) return null;
  try {
    const res = await pool.query(`
      SELECT
        current_user AS active_role,
        pg_has_role(current_user, 'cloudsqlsuperuser', 'MEMBER') AS is_cloudsqlsuperuser
    `);
    return res.rows[0];
  } catch {
    return null;
  }
}

/**
 * 伺服器重啟時從 PostgreSQL 恢復未過期的活躍房間、題目快照、組別、參賽者與作答紀錄
 */
async function loadActiveRoomsFromDb() {
  if (!dbConnected || !pool) return [];
  try {
    const roomsRes = await pool.query(
      `SELECT pin, title, status, max_players, time_limit_sec, current_question_idx,
              questions_snapshot, created_by,
              EXTRACT(EPOCH FROM created_at) * 1000 AS created_ms
       FROM quiz_rooms
       WHERE created_at > NOW() - INTERVAL '12 hours'
       ORDER BY created_at DESC`
    );
    if (roomsRes.rows.length === 0) return [];

    const fallbackQuestions = await loadQuestionsFromDb({ enabledOnly: true });
    const restoredRooms = [];

    for (const r of roomsRes.rows) {
      const groupsRes = await pool.query(
        `SELECT group_code, group_name, password_hash, password_cipher, max_members
         FROM quiz_groups
         WHERE room_pin = $1
         ORDER BY id ASC`,
        [r.pin]
      );
      const playersRes = await pool.query(
        `SELECT player_id, group_code, group_name, nickname, score, streak, correct_count, total_time_ms,
                EXTRACT(EPOCH FROM joined_at) * 1000 AS joined_ms
         FROM quiz_players
         WHERE room_pin = $1
         ORDER BY joined_at ASC`,
        [r.pin]
      );
      const answersRes = await pool.query(
        `SELECT player_id, question_idx, selected_option, is_correct, elapsed_ms, points_awarded
         FROM quiz_answers
         WHERE room_pin = $1`,
        [r.pin]
      );

      const groupsMap = new Map();
      for (const g of groupsRes.rows) {
        groupsMap.set(g.group_code, {
          code: g.group_code,
          name: g.group_name,
          plainPassword: decryptText(g.password_cipher) || '(已加密保護)',
          passwordHash: g.password_hash,
          maxMembers: g.max_members
        });
      }

      const playersMap = new Map();
      for (const p of playersRes.rows) {
        playersMap.set(p.player_id, {
          id: p.player_id,
          nickname: p.nickname,
          groupCode: p.group_code,
          groupName: p.group_name,
          score: p.score,
          streak: p.streak,
          correctCount: p.correct_count,
          totalTimeMs: p.total_time_ms,
          connected: false,
          socketId: null,
          joinedAt: Math.round(Number(p.joined_ms || Date.now()))
        });
      }

      const historyAnswers = new Map();
      for (const a of answersRes.rows) {
        if (!historyAnswers.has(a.question_idx)) {
          historyAnswers.set(a.question_idx, new Map());
        }
        historyAnswers.get(a.question_idx).set(a.player_id, {
          playerId: a.player_id,
          option: a.selected_option,
          isCorrect: a.is_correct,
          elapsedMs: a.elapsed_ms,
          points: a.points_awarded
        });
      }

      let safeStatus = r.status === 'QUESTION_OPEN' ? 'QUESTION_REVEAL' : r.status;
      let currentQIdx = Number(r.current_question_idx);
      if (
        (r.status === 'QUESTION_OPEN' || r.status === 'QUESTION_REVEAL') &&
        currentQIdx === 0 &&
        answersRes.rows.length === 0
      ) {
        safeStatus = 'LOBBY';
        currentQIdx = -1;
        pool
          .query(
            `UPDATE quiz_rooms SET status = 'LOBBY', current_question_idx = -1 WHERE pin = $1`,
            [r.pin]
          )
          .catch(() => {});
      }
      const currentAnswers = historyAnswers.get(currentQIdx) || new Map();

      // 優先還原該房間建立時鎖定的題目快照，確保後台改題不影響進行中或已結束的比賽
      const roomQuestions =
        Array.isArray(r.questions_snapshot) && r.questions_snapshot.length > 0
          ? r.questions_snapshot
          : fallbackQuestions;

      restoredRooms.push({
        pin: r.pin,
        title: r.title,
        status: safeStatus,
        maxPlayers: r.max_players,
        timeLimitSec: r.time_limit_sec,
        questions: roomQuestions,
        createdBy: r.created_by || 'admin',
        currentQuestionIndex: currentQIdx,
        questionOpenedAtMono: 0,
        questionEndsAtEpoch: 0,
        timerHandle: null,
        groups: groupsMap,
        players: playersMap,
        currentAnswers: new Map(currentAnswers),
        historyAnswers,
        createdAt: Math.round(Number(r.created_ms || Date.now())),
        finishedAt: safeStatus === 'FINISHED' ? Date.now() : null
      });
    }

    console.log(`[DB] 已從 PostgreSQL 恢復 ${restoredRooms.length} 個近期比賽房間狀態`);
    return restoredRooms;
  } catch (err) {
    console.error('[DB] 恢復活躍房間失敗:', err.message);
    return [];
  }
}

async function persistRoomCreated(room) {
  if (!dbConnected || !pool) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO quiz_rooms (pin, title, status, max_players, time_limit_sec, current_question_idx, questions_snapshot, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
       ON CONFLICT (pin) DO UPDATE SET
         title = EXCLUDED.title,
         status = EXCLUDED.status,
         max_players = EXCLUDED.max_players,
         time_limit_sec = EXCLUDED.time_limit_sec,
         current_question_idx = EXCLUDED.current_question_idx,
         questions_snapshot = EXCLUDED.questions_snapshot`,
      [
        room.pin,
        room.title,
        room.status,
        room.maxPlayers,
        room.timeLimitSec,
        room.currentQuestionIndex,
        JSON.stringify(room.questions || []),
        room.createdBy || 'admin'
      ]
    );

    await client.query(`DELETE FROM quiz_groups WHERE room_pin = $1`, [room.pin]);
    for (const g of room.groups.values()) {
      await client.query(
        `INSERT INTO quiz_groups (room_pin, group_code, group_name, password_hash, password_cipher, max_members)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          room.pin,
          g.code,
          g.name,
          g.passwordHash,
          encryptText(g.plainPassword || ''),
          g.maxMembers
        ]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[DB] persistRoomCreated error:', err.message);
  } finally {
    client.release();
  }
}

async function persistRoomStatus(pin, status, currentQuestionIndex) {
  if (!dbConnected || !pool) return;
  try {
    await pool.query(
      `UPDATE quiz_rooms
       SET status = $2::varchar(24),
           current_question_idx = $3,
           finished_at = CASE WHEN $2::varchar(24) = 'FINISHED' THEN NOW() ELSE finished_at END
       WHERE pin = $1`,
      [pin, status, currentQuestionIndex]
    );
  } catch (err) {
    console.error('[DB] persistRoomStatus error:', err.message);
  }
}

async function deleteRoomFromDb(pin) {
  if (!dbConnected || !pool) return;
  try {
    await pool.query(`DELETE FROM quiz_rooms WHERE pin = $1`, [pin]);
  } catch (err) {
    console.error('[DB] deleteRoomFromDb error:', err.message);
  }
}

async function persistPlayerJoined(pin, player) {
  if (!dbConnected || !pool) return;
  try {
    await pool.query(
      `INSERT INTO quiz_players (player_id, room_pin, group_code, group_name, nickname, score, streak, correct_count, total_time_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (player_id) DO UPDATE SET
         nickname = EXCLUDED.nickname,
         score = EXCLUDED.score,
         streak = EXCLUDED.streak`,
      [
        player.id,
        pin,
        player.groupCode,
        player.groupName,
        player.nickname,
        player.score,
        player.streak,
        player.correctCount,
        player.totalTimeMs
      ]
    );
  } catch (err) {
    console.error('[DB] persistPlayerJoined error:', err.message);
  }
}

async function persistPlayerRemoved(pin, playerId) {
  if (!dbConnected || !pool) return;
  try {
    await pool.query(`DELETE FROM quiz_players WHERE room_pin = $1 AND player_id = $2`, [
      pin,
      playerId
    ]);
  } catch (err) {
    console.error('[DB] persistPlayerRemoved error:', err.message);
  }
}

async function persistAnswerAndScore(pin, player, questionIdx, answerRecord) {
  if (!dbConnected || !pool) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO quiz_answers (room_pin, player_id, question_idx, selected_option, is_correct, elapsed_ms, points_awarded)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (room_pin, player_id, question_idx) DO NOTHING`,
      [
        pin,
        player.id,
        questionIdx,
        answerRecord.option,
        answerRecord.isCorrect,
        answerRecord.elapsedMs,
        answerRecord.points
      ]
    );
    await client.query(
      `UPDATE quiz_players
       SET score = $2,
           streak = $3,
           correct_count = $4,
           total_time_ms = $5
       WHERE player_id = $1`,
      [player.id, player.score, player.streak, player.correctCount, player.totalTimeMs]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[DB] persistAnswerAndScore error:', err.message);
  } finally {
    client.release();
  }
}

async function getDbHealth() {
  if (!dbConnected || !pool) {
    return { status: 'memory_fallback', dbConnected: false };
  }
  try {
    const priv = await getPrivilegeStatus();
    return {
      status: 'ok',
      dbConnected: true,
      activeRole: priv ? priv.active_role : null,
      leastPrivilege: priv ? !priv.is_cloudsqlsuperuser : false
    };
  } catch (err) {
    return { status: 'degraded', dbConnected: false, error: err.message };
  }
}

module.exports = {
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
  loadActiveRoomsFromDb,
  persistRoomCreated,
  persistRoomStatus,
  deleteRoomFromDb,
  persistPlayerJoined,
  persistPlayerRemoved,
  persistAnswerAndScore,
  getDbHealth
};
