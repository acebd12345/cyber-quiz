'use strict';

const crypto = require('crypto');

function getJwtSecret() {
  if (process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 16) {
    return process.env.JWT_SECRET;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('[FATAL] 正式環境必須設定高強度 JWT_SECRET 環境變數');
  }
  if (!global.__ephemeralJwtSecret) {
    global.__ephemeralJwtSecret = crypto.randomBytes(32).toString('hex');
  }
  return global.__ephemeralJwtSecret;
}

/**
 * 使用 scrypt + 隨機 salt 雜湊密碼（防止資料庫外洩時明文暴露組別或管理員密碼）
 */
function hashPassword(plainText) {
  const normalized = String(plainText || '').trim();
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(normalized, salt, 32).toString('hex');
  return `${salt}:${derived}`;
}

// 預先產生一組固定 Dummy Hash，供帳號不存在時執行常數時間比對，防止帳號枚舉 Timing Attack
const DUMMY_SCRYPT_HASH = (() => {
  const salt = '0123456789abcdef0123456789abcdef';
  const derived = crypto.scryptSync('dummy_password_for_timing_safety', salt, 32).toString('hex');
  return `${salt}:${derived}`;
})();

/**
 * 常數時間（Constant-time）驗證 scrypt 密碼雜湊，防止 Timing Attack
 */
function verifyPassword(plainText, storedHash) {
  const targetHash =
    storedHash && typeof storedHash === 'string' && storedHash.includes(':')
      ? storedHash
      : DUMMY_SCRYPT_HASH;
  const parts = targetHash.split(':');
  if (parts.length !== 2) return false;
  const [salt, keyHex] = parts;
  try {
    const derived = crypto.scryptSync(String(plainText || '').trim(), salt, 32);
    const keyBuf = Buffer.from(keyHex, 'hex');
    if (derived.length !== keyBuf.length) return false;
    const matched = crypto.timingSafeEqual(derived, keyBuf);
    return targetHash === storedHash ? matched : false;
  } catch {
    return false;
  }
}

/**
 * 使用 AES-256-GCM 加密組別密碼（僅供主持人控台重啟恢復時解密檢視）
 */
function encryptText(plainText) {
  const key = crypto.createHash('sha256').update(getJwtSecret()).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

function decryptText(cipherPayload) {
  if (!cipherPayload || typeof cipherPayload !== 'string') return '';
  const parts = cipherPayload.split(':');
  if (parts.length !== 3) return '';
  try {
    const key = crypto.createHash('sha256').update(getJwtSecret()).digest();
    const iv = Buffer.from(parts[0], 'hex');
    const tag = Buffer.from(parts[1], 'hex');
    const enc = Buffer.from(parts[2], 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

/**
 * 常數時間比對明文密鑰（用於 Host Master Password 比對）
 */
function safeCompareStrings(input, expected) {
  if (typeof input !== 'string' || typeof expected !== 'string' || !expected) return false;
  const secret = getJwtSecret();
  const h1 = crypto.createHmac('sha256', secret).update(input).digest();
  const h2 = crypto.createHmac('sha256', secret).update(expected).digest();
  return crypto.timingSafeEqual(h1, h2);
}

/**
 * 簽發 HMAC-SHA256 Token
 */
function signToken(payload, expiresInSec = 14400) {
  const secret = getJwtSecret();
  const data = {
    ...payload,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + expiresInSec,
    jti: crypto.randomBytes(8).toString('hex')
  };
  const bodyB64 = Buffer.from(JSON.stringify(data), 'utf8').toString('base64url');
  const sigB64 = crypto
    .createHmac('sha256', secret)
    .update(bodyB64)
    .digest('base64url');
  return `${bodyB64}.${sigB64}`;
}

/**
 * 驗證 HMAC-SHA256 Token
 */
function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [bodyB64, sigB64] = parts;
  try {
    const secret = getJwtSecret();
    const expectedSig = crypto
      .createHmac('sha256', secret)
      .update(bodyB64)
      .digest();
    const actualSig = Buffer.from(sigB64, 'base64url');
    if (expectedSig.length !== actualSig.length) return null;
    if (!crypto.timingSafeEqual(expectedSig, actualSig)) return null;

    const payload = JSON.parse(Buffer.from(bodyB64, 'base64url').toString('utf8'));
    const now = Math.floor(Date.now() / 1000);
    if (!payload.exp || payload.exp < now) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * 清理一般控制字元與零寬度字元（保留標點與法規網址所需符號）
 */
function stripControlChars(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\uFEFF]/g, '')
    .trim();
}

/**
 * 嚴格驗證與清理參賽者暱稱：
 * - 移除控制字元與零寬度隱藏字元（防偽冒他人名稱）
 * - 禁止 HTML 標籤字元 < > " ' ` &（防 XSS）
 * - 限制長度 1 ~ 20 字元
 */
function sanitizeNickname(raw) {
  if (typeof raw !== 'string') return { valid: false, error: '請輸入有效的暱稱' };
  const cleaned = stripControlChars(raw);
  if (cleaned.length < 1 || cleaned.length > 20) {
    return { valid: false, error: '暱稱長度須為 1 至 20 個字元' };
  }
  if (/[<>"'`&\\]/.test(cleaned)) {
    return { valid: false, error: '暱稱不得包含特殊符號 (< > " \' ` & \\)' };
  }
  return { valid: true, value: cleaned };
}

/**
 * 嚴格驗證與清理組別名稱
 */
function sanitizeGroupName(raw) {
  if (typeof raw !== 'string') return { valid: false, error: '請輸入有效的組別名稱' };
  const cleaned = stripControlChars(raw);
  if (cleaned.length < 1 || cleaned.length > 24) {
    return { valid: false, error: '組別名稱長度須為 1 至 24 個字元' };
  }
  if (/[<>"'`&\\]/.test(cleaned)) {
    return { valid: false, error: '組別名稱不得包含特殊符號' };
  }
  return { valid: true, value: cleaned };
}

/**
 * 驗證與清理題目欄位（保留引號與法規網址字元，僅過濾控制字元並檢查長度與重複選項）
 */
function validateAndSanitizeQuestion(input = {}) {
  const title = stripControlChars(String(input.title || ''));
  const scenario = stripControlChars(String(input.scenario || ''));
  const rawOpts = input.options || {};
  const optA = stripControlChars(String(rawOpts.A ?? input.option_a ?? ''));
  const optB = stripControlChars(String(rawOpts.B ?? input.option_b ?? ''));
  const optC = stripControlChars(String(rawOpts.C ?? input.option_c ?? ''));
  const optD = stripControlChars(String(rawOpts.D ?? input.option_d ?? ''));
  const answer = String(input.answer ?? input.correct_option ?? '')
    .trim()
    .toUpperCase();
  const explanation = stripControlChars(String(input.explanation || ''));
  const isEnabled = input.isEnabled !== undefined ? Boolean(input.isEnabled) : true;

  if (title.length < 1 || title.length > 120) {
    return { valid: false, error: '題目標題長度須為 1 至 120 字元。' };
  }
  if (scenario.length < 1 || scenario.length > 600) {
    return { valid: false, error: '情境說明長度須為 1 至 600 字元。' };
  }
  const opts = [optA, optB, optC, optD];
  for (const [idx, text] of opts.entries()) {
    const label = ['A', 'B', 'C', 'D'][idx];
    if (text.length < 1 || text.length > 200) {
      return { valid: false, error: `選項 ${label} 長度須為 1 至 200 字元。` };
    }
  }
  const uniqueOpts = new Set(opts);
  if (uniqueOpts.size < 4) {
    return { valid: false, error: 'A、B、C、D 四個選項內容不可重複。' };
  }
  if (!['A', 'B', 'C', 'D'].includes(answer)) {
    return { valid: false, error: '正確答案必須為 A、B、C 或 D。' };
  }
  if (explanation.length < 1 || explanation.length > 600) {
    return { valid: false, error: '答案解析長度須為 1 至 600 字元。' };
  }

  return {
    valid: true,
    value: {
      title,
      scenario,
      options: { A: optA, B: optB, C: optC, D: optD },
      answer,
      explanation,
      isEnabled
    }
  };
}

/**
 * 驗證管理者帳號與顯示名稱格式
 */
function validateAdminAccountInput({ username, displayName, password, adminRole }, isCreate = true) {
  if (isCreate || username !== undefined) {
    const cleanUser = String(username || '').trim().toLowerCase();
    if (!/^[a-z0-9_.-]{3,32}$/.test(cleanUser)) {
      return {
        valid: false,
        error: '帳號須為 3 至 32 字元之英數字、底線、點或連字號。'
      };
    }
  }
  if (isCreate || displayName !== undefined) {
    const cleanName = stripControlChars(String(displayName || ''));
    if (cleanName.length < 1 || cleanName.length > 32 || /[<>"'`&\\]/.test(cleanName)) {
      return {
        valid: false,
        error: '顯示名稱須為 1 至 32 字元，且不含特殊標籤符號。'
      };
    }
  }
  if (isCreate || (password !== undefined && password !== '')) {
    const rawPass = String(password || '');
    if (rawPass.length < 8 || rawPass.length > 64) {
      return {
        valid: false,
        error: '管理密碼長度須為 8 至 64 字元。'
      };
    }
  }
  if (adminRole !== undefined && !['super_admin', 'host'].includes(adminRole)) {
    return {
      valid: false,
      error: '角色權限必須為 super_admin 或 host。'
    };
  }
  return { valid: true };
}

/**
 * 產生加密安全的 6 位數房間 PIN 碼
 */
function generateRoomPin() {
  return String(crypto.randomInt(100000, 999999));
}

/**
 * 產生易讀且安全的各組隨機密碼（排除易混淆字元 0/O/1/I/l）
 */
function generateGroupPassword(length = 6) {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz';
  let out = '';
  for (let i = 0; i < length; i++) {
    out += alphabet[crypto.randomInt(0, alphabet.length)];
  }
  return out;
}

/**
 * 記憶體滑動視窗 Rate Limiter
 */
class SlidingWindowRateLimiter {
  constructor(windowMs = 60000, maxAttempts = 15) {
    this.windowMs = windowMs;
    this.maxAttempts = maxAttempts;
    this.buckets = new Map();
  }

  _getActiveTimestamps(key) {
    const cutoff = Date.now() - this.windowMs;
    const timestamps = this.buckets.get(key) || [];
    const filtered = timestamps.filter((t) => t > cutoff);
    if (filtered.length > 0) {
      this.buckets.set(key, filtered);
    } else {
      this.buckets.delete(key);
    }
    return filtered;
  }

  isBlocked(key) {
    const active = this._getActiveTimestamps(key);
    return active.length >= this.maxAttempts;
  }

  recordFailure(key) {
    const active = this._getActiveTimestamps(key);
    active.push(Date.now());
    this.buckets.set(key, active);
    return active.length >= this.maxAttempts;
  }

  consume(key) {
    const active = this._getActiveTimestamps(key);
    if (active.length >= this.maxAttempts) {
      return false;
    }
    active.push(Date.now());
    this.buckets.set(key, active);
    return true;
  }

  cleanup() {
    const cutoff = Date.now() - this.windowMs;
    for (const [key, timestamps] of this.buckets.entries()) {
      const filtered = timestamps.filter((t) => t > cutoff);
      if (filtered.length === 0) {
        this.buckets.delete(key);
      } else {
        this.buckets.set(key, filtered);
      }
    }
  }
}

module.exports = {
  getJwtSecret,
  hashPassword,
  verifyPassword,
  encryptText,
  decryptText,
  safeCompareStrings,
  signToken,
  verifyToken,
  stripControlChars,
  sanitizeNickname,
  sanitizeGroupName,
  validateAndSanitizeQuestion,
  validateAdminAccountInput,
  generateRoomPin,
  generateGroupPassword,
  SlidingWindowRateLimiter
};
