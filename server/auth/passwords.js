'use strict';
// 密码哈希：Node 内置 scrypt，自描述格式，便于以后升级参数
const crypto = require('crypto');

const SCRYPT = Object.freeze({ N: 16384, r: 8, p: 1, keylen: 64 });

function scryptAsync(password, salt, keylen, options) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, options, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}
const MAXMEM = 64 * 1024 * 1024;
const SALT_BYTES = 16;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 256;

function normalizePassword(password) {
  return String(password == null ? '' : password).normalize('NFC');
}

function assertPasswordPolicy(password) {
  const value = normalizePassword(password);
  if (value.length < MIN_PASSWORD) {
    const err = new Error('密码至少 ' + MIN_PASSWORD + ' 个字符');
    err.name = 'PasswordPolicyError';
    throw err;
  }
  if (value.length > MAX_PASSWORD) {
    const err = new Error('密码最多 ' + MAX_PASSWORD + ' 个字符');
    err.name = 'PasswordPolicyError';
    throw err;
  }
  return value;
}

function encodeHash(salt, key, params = SCRYPT) {
  return [
    'scrypt',
    params.N,
    params.r,
    params.p,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

function parseHash(stored) {
  if (typeof stored !== 'string') return null;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (![N, r, p].every((n) => Number.isInteger(n) && n > 0)) return null;
  // 防止损坏/恶意 auth.json 用超大参数拖垮登录
  if (N < 1024 || N > 1 << 20 || r > 32 || p > 16) return null;
  let salt;
  let key;
  try {
    salt = Buffer.from(parts[4], 'base64url');
    key = Buffer.from(parts[5], 'base64url');
  } catch (_) {
    return null;
  }
  if (!salt.length || !key.length) return null;
  return { N, r, p, salt, key };
}

async function hashPassword(password) {
  const value = assertPasswordPolicy(password);
  const salt = crypto.randomBytes(SALT_BYTES);
  const key = await scryptAsync(value, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: MAXMEM,
  });
  return encodeHash(salt, key);
}

function hashPasswordSync(password) {
  const value = assertPasswordPolicy(password);
  const salt = crypto.randomBytes(SALT_BYTES);
  const key = crypto.scryptSync(value, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: MAXMEM,
  });
  return encodeHash(salt, key);
}

async function verifyPassword(password, stored) {
  const parsed = parseHash(stored);
  if (!parsed) return false;
  const value = normalizePassword(password);
  let derived;
  try {
    derived = await scryptAsync(value, parsed.salt, parsed.key.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem: MAXMEM,
    });
  } catch (_) {
    return false;
  }
  if (derived.length !== parsed.key.length) return false;
  return crypto.timingSafeEqual(derived, parsed.key);
}

let dummyHash = null;

/** 未知用户也执行一次同成本校验，降低用响应时间枚举账号的可能 */
async function verifyDummy(password) {
  if (!dummyHash) {
    dummyHash = hashPasswordSync('dummy-password-' + crypto.randomBytes(16).toString('hex'));
  }
  await verifyPassword(password, dummyHash);
  return false;
}

module.exports = {
  MIN_PASSWORD,
  MAX_PASSWORD,
  normalizePassword,
  assertPasswordPolicy,
  hashPassword,
  hashPasswordSync,
  verifyPassword,
  verifyDummy,
};
