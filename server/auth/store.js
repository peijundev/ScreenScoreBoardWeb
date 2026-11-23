'use strict';
// 账号、会话、令牌的持久化与内存索引
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { config } = require('../config');
const { logger } = require('../logger');
const { DATA_DIR } = require('../paths');
const { NotFoundError, ForbiddenError } = require('../validation');
const { isRole } = require('./policy');
const {
  hashPassword,
  hashPasswordSync,
  verifyPassword,
  verifyDummy,
  normalizePassword,
} = require('./passwords');
const {
  isDirectLoopbackRequest,
  effectiveHost,
  isLoopbackHost,
} = require('../security');

const log = logger.child({ scope: 'auth' });
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const USERNAME_RE = /^[\p{L}\p{N}_.-]{3,32}$/u;

let enabled = false;
let requireLogin = true;
let users = new Map();
let usersByName = new Map();
let tokens = new Map();
let tokensByHash = new Map();
let sessions = new Map();
let sessionsByHash = new Map();
let revokeListener = null;
let setupInProgress = false;
let authDirty = false;
let authTimer = null;
let sessionsDirty = false;
let sessionsTimer = null;
let cleanupTimer = null;
let loaded = false;

function nowIso() {
  return new Date().toISOString();
}

function toMs(value) {
  const n = Date.parse(value);
  return Number.isFinite(n) ? n : 0;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function newId() {
  return crypto.randomUUID();
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch (_) {}
}

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) return null;
  return JSON.parse(raw);
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    memberProjectId: user.memberProjectId || null,
    memberPersonId: user.memberPersonId || null,
    disabled: Boolean(user.disabled),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt || null,
  };
}

function publicSession(session, currentId) {
  return {
    id: session.id,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    lastSeenAt: session.lastSeenAt,
    ip: session.ip || '',
    userAgent: session.userAgent || '',
    remember: Boolean(session.remember),
    current: currentId ? session.id === currentId : false,
  };
}

function publicToken(token) {
  return {
    id: token.id,
    name: token.name,
    createdAt: token.createdAt,
    lastUsedAt: token.lastUsedAt || null,
    expiresAt: token.expiresAt || null,
  };
}

function assertUsername(raw) {
  const username = String(raw == null ? '' : raw).normalize('NFC').trim();
  if (!USERNAME_RE.test(username)) {
    const err = new Error('用户名需为 3–32 位字母、数字、下划线、点或连字符');
    err.name = 'UserInputError';
    throw err;
  }
  return username;
}

function assertRole(role) {
  if (!isRole(role)) {
    const err = new Error('角色非法');
    err.name = 'UserInputError';
    throw err;
  }
  return role;
}

function normalizeMemberBinding(role, projectId, personId) {
  if (role !== 'member') return { memberProjectId: null, memberPersonId: null };
  const pid = typeof projectId === 'string' ? projectId.trim() : '';
  const person = typeof personId === 'string' ? personId.trim() : '';
  if (!pid || !person) {
    const err = new Error('队员账号必须绑定项目与人员');
    err.name = 'UserInputError';
    throw err;
  }
  return { memberProjectId: pid, memberPersonId: person };
}

function validateUserRecord(user) {
  if (!user || typeof user !== 'object') return null;
  if (typeof user.id !== 'string' || !user.id) return null;
  if (typeof user.username !== 'string') return null;
  if (!isRole(user.role)) return null;
  if (typeof user.passwordHash !== 'string') return null;
  const username = String(user.username).normalize('NFC').trim();
  const usernameKey = username.toLowerCase();
  return {
    id: user.id,
    username,
    usernameKey,
    displayName: typeof user.displayName === 'string' ? user.displayName : username,
    role: user.role,
    memberProjectId: typeof user.memberProjectId === 'string' ? user.memberProjectId : null,
    memberPersonId: typeof user.memberPersonId === 'string' ? user.memberPersonId : null,
    passwordHash: user.passwordHash,
    disabled: Boolean(user.disabled),
    createdAt: typeof user.createdAt === 'string' ? user.createdAt : nowIso(),
    updatedAt: typeof user.updatedAt === 'string' ? user.updatedAt : nowIso(),
    lastLoginAt: typeof user.lastLoginAt === 'string' ? user.lastLoginAt : null,
  };
}

function loadAuthFile() {
  users = new Map();
  usersByName = new Map();
  tokens = new Map();
  tokensByHash = new Map();
  requireLogin = true;
  if (!fs.existsSync(AUTH_FILE)) return;
  let data;
  try {
    data = readJson(AUTH_FILE);
  } catch (error) {
    throw new Error('auth.json 无法解析，请从备份恢复：' + error.message);
  }
  if (!data || data.version !== 1 || !Array.isArray(data.users) || !Array.isArray(data.tokens)) {
    throw new Error('auth.json 格式不正确，请从备份恢复');
  }
  for (const raw of data.users) {
    const user = validateUserRecord(raw);
    if (!user) throw new Error('auth.json 中存在非法用户记录');
    if (users.has(user.id)) throw new Error('auth.json 中存在重复用户 ID');
    if (usersByName.has(user.usernameKey)) throw new Error('auth.json 中存在重复用户名');
    users.set(user.id, user);
    usersByName.set(user.usernameKey, user);
  }
  for (const raw of data.tokens) {
    if (!raw || typeof raw.id !== 'string' || typeof raw.userId !== 'string') continue;
    const owner = users.get(raw.userId);
    if (!owner) continue;
    const record = {
      id: raw.id,
      userId: raw.userId,
      name: typeof raw.name === 'string' ? raw.name.slice(0, 60) : '令牌',
      tokenHash: String(raw.tokenHash || ''),
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : nowIso(),
      lastUsedAt: typeof raw.lastUsedAt === 'string' ? raw.lastUsedAt : null,
      expiresAt: typeof raw.expiresAt === 'string' ? raw.expiresAt : null,
    };
    if (!record.tokenHash) continue;
    tokens.set(record.id, record);
    tokensByHash.set(record.tokenHash, record);
  }
  if (data.settings && typeof data.settings === 'object' && data.settings.requireLogin === false) {
    requireLogin = false;
  }
  // 开放模式必须有可用的管理员，否则重新启用登录后会无人可登录
  if (!requireLogin && countActiveAdmins() === 0) {
    requireLogin = true;
    log.warn('auth.json 中的开放模式没有启用中的管理员，已强制要求登录');
  }
}

function saveAuthFile() {
  const data = {
    version: 1,
    settings: { requireLogin },
    users: [...users.values()],
    tokens: [...tokens.values()],
  };
  writeJsonAtomic(AUTH_FILE, data);
  authDirty = false;
}

function scheduleAuthSave() {
  authDirty = true;
  if (authTimer) return;
  authTimer = setTimeout(() => {
    authTimer = null;
    if (!authDirty) return;
    try {
      saveAuthFile();
    } catch (error) {
      log.warn('auth.json 写入失败', { error: error.message });
    }
  }, 60 * 1000);
  if (authTimer.unref) authTimer.unref();
}

function loadSessionsFile() {
  sessions = new Map();
  sessionsByHash = new Map();
  if (!fs.existsSync(SESSIONS_FILE)) return;
  let data;
  try {
    data = readJson(SESSIONS_FILE);
  } catch (error) {
    log.warn('sessions.json 无法解析，已按空会话启动', { error: error.message });
    return;
  }
  if (!data || data.version !== 1 || !Array.isArray(data.sessions)) {
    log.warn('sessions.json 格式不正确，已按空会话启动');
    return;
  }
  const now = Date.now();
  for (const raw of data.sessions) {
    if (!raw || typeof raw.id !== 'string' || typeof raw.tokenHash !== 'string') continue;
    const user = users.get(raw.userId);
    if (!user || user.disabled) continue;
    const expiresAt = typeof raw.expiresAt === 'string' ? raw.expiresAt : '';
    if (!expiresAt || toMs(expiresAt) <= now) continue;
    const record = {
      id: raw.id,
      tokenHash: raw.tokenHash,
      csrfToken: String(raw.csrfToken || ''),
      userId: raw.userId,
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : nowIso(),
      expiresAt,
      lastSeenAt: typeof raw.lastSeenAt === 'string' ? raw.lastSeenAt : nowIso(),
      ip: typeof raw.ip === 'string' ? raw.ip : '',
      userAgent: typeof raw.userAgent === 'string' ? raw.userAgent.slice(0, 300) : '',
      remember: Boolean(raw.remember),
    };
    if (!record.csrfToken) continue;
    if (sessions.has(record.id) || sessionsByHash.has(record.tokenHash)) continue;
    sessions.set(record.id, record);
    sessionsByHash.set(record.tokenHash, record);
  }
}

function saveSessionsFile() {
  const data = {
    version: 1,
    sessions: [...sessions.values()],
  };
  writeJsonAtomic(SESSIONS_FILE, data);
  sessionsDirty = false;
}

function scheduleSessionsSave() {
  sessionsDirty = true;
  if (sessionsTimer) return;
  sessionsTimer = setTimeout(() => {
    sessionsTimer = null;
    if (!sessionsDirty) return;
    try {
      saveSessionsFile();
    } catch (error) {
      log.warn('sessions.json 写入失败', { error: error.message });
    }
  }, 60 * 1000);
  if (sessionsTimer.unref) sessionsTimer.unref();
}

function notifyRevoke(payload) {
  if (!revokeListener) return;
  try {
    revokeListener(payload);
  } catch (error) {
    log.warn('会话吊销回调失败', { error: error.message });
  }
}

function countActiveAdmins() {
  let count = 0;
  for (const user of users.values()) {
    if (user.role === 'admin' && !user.disabled) count += 1;
  }
  return count;
}

function isEnabled() {
  return enabled;
}

function isLoginRequired() {
  return requireLogin;
}

/** 部署模式下的「完全开放」：不要求登录，所有请求按管理员处理。 */
function isOpenAccess() {
  return enabled && !requireLogin;
}

function firstActiveAdminId() {
  for (const user of users.values()) {
    if (user.role === 'admin' && !user.disabled) return user.id;
  }
  return null;
}

function getAccessSettings() {
  return {
    requireLogin,
    openAccess: isOpenAccess(),
    activeAdmins: countActiveAdmins(),
  };
}

function setRequireLogin(value) {
  if (!enabled) throw new Error('鉴权未启用');
  if (typeof value !== 'boolean') throw new Error('requireLogin 必须是布尔值');
  if (countActiveAdmins() === 0) throw new Error('至少需要一个启用中的管理员');
  if (requireLogin === value) return getAccessSettings();
  const previous = requireLogin;
  requireLogin = value;
  try {
    saveAuthFile();
  } catch (error) {
    requireLogin = previous;
    throw error;
  }
  // 切回登录模式时，开放模式下建立的 system WS 连接必须立即失效
  notifyRevoke({ accessMode: value ? 'login' : 'open' });
  return getAccessSettings();
}

function isSetupRequired() {
  return enabled && users.size === 0;
}

function setupAllowedFor(req) {
  if (!isSetupRequired() || config.auth.trustProxy || !isDirectLoopbackRequest(req)) {
    return false;
  }
  // 即使请求来自 loopback，也要求访问的是本机地址，避免本机反代把公网域名转发进来
  const host = effectiveHost(req);
  let hostName = '';
  try {
    hostName = new URL('http://' + host).hostname;
  } catch (_) {
    return false;
  }
  if (!(hostName === 'localhost' || isLoopbackHost(hostName))) return false;
  const origin = req.headers && req.headers.origin;
  if (origin) {
    try {
      const parsed = new URL(origin);
      if (!(parsed.hostname === 'localhost' || isLoopbackHost(parsed.hostname))) return false;
    } catch (_) {
      return false;
    }
  }
  return true;
}

function findUserById(id) {
  return users.get(String(id)) || null;
}

function findUserByUsername(username) {
  const key = String(username == null ? '' : username).normalize('NFC').trim().toLowerCase();
  return usersByName.get(key) || null;
}

function listUsers() {
  return [...users.values()]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map(publicUser);
}

async function authenticate(username, password) {
  const user = findUserByUsername(username);
  if (!user || user.disabled) {
    await verifyDummy(password);
    return null;
  }
  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) return null;
  user.lastLoginAt = nowIso();
  user.updatedAt = user.updatedAt || nowIso();
  saveAuthFile();
  return user;
}

function createUser({
  username, passwordHash, role = 'viewer', displayName = '', disabled = false,
  memberProjectId = null, memberPersonId = null,
}) {
  const name = assertUsername(username);
  const key = name.toLowerCase();
  if (usersByName.has(key)) {
    const err = new Error('用户名已存在');
    err.name = 'UserInputError';
    throw err;
  }
  assertRole(role);
  const binding = normalizeMemberBinding(role, memberProjectId, memberPersonId);
  if (typeof passwordHash !== 'string' || !passwordHash) {
    const err = new Error('密码哈希无效');
    err.name = 'UserInputError';
    throw err;
  }
  const now = nowIso();
  const user = {
    id: newId(),
    username: name,
    usernameKey: key,
    displayName: String(displayName || name).trim().slice(0, 40) || name,
    role,
    ...binding,
    passwordHash,
    disabled: Boolean(disabled),
    createdAt: now,
    updatedAt: now,
    lastLoginAt: null,
  };
  users.set(user.id, user);
  usersByName.set(key, user);
  saveAuthFile();
  return user;
}

function updateUser(id, patch = {}, options = {}) {
  const user = findUserById(id);
  if (!user) throw new NotFoundError('用户不存在');
  const actorId = options.actorId || null;
  const nextRole = patch.role !== undefined ? assertRole(patch.role) : user.role;
  const nextDisabled = patch.disabled !== undefined ? Boolean(patch.disabled) : user.disabled;
  if (actorId && actorId === user.id && (nextRole !== user.role || nextDisabled)) {
    throw new ForbiddenError('不能停用或降级自己');
  }
  if (
    user.role === 'admin' &&
    !user.disabled &&
    (nextRole !== 'admin' || nextDisabled)
  ) {
    if (countActiveAdmins() <= 1) {
      throw new ForbiddenError('不能停用、降级或删除最后一个管理员');
    }
  }
  if (patch.displayName !== undefined) {
    user.displayName = String(patch.displayName || '').trim().slice(0, 40) || user.username;
  }
  const roleChanged = nextRole !== user.role;
  const disabledChanged = nextDisabled !== user.disabled;
  const previousProjectId = user.memberProjectId || null;
  const previousPersonId = user.memberPersonId || null;
  const bindingTouched = patch.role !== undefined
    || patch.memberProjectId !== undefined
    || patch.memberPersonId !== undefined;
  const nextProjectId = patch.memberProjectId !== undefined
    ? patch.memberProjectId
    : user.memberProjectId;
  const nextPersonId = patch.memberPersonId !== undefined
    ? patch.memberPersonId
    : user.memberPersonId;
  const binding = bindingTouched
    ? normalizeMemberBinding(nextRole, nextProjectId, nextPersonId)
    : {
        memberProjectId: user.memberProjectId || null,
        memberPersonId: user.memberPersonId || null,
      };
  user.role = nextRole;
  user.memberProjectId = binding.memberProjectId;
  user.memberPersonId = binding.memberPersonId;
  user.disabled = nextDisabled;
  const bindingChanged = user.memberProjectId !== previousProjectId
    || user.memberPersonId !== previousPersonId;
  user.updatedAt = nowIso();
  saveAuthFile();
  if (disabledChanged && user.disabled) {
    revokeUserSessions(user.id);
    revokeUserTokens(user.id);
  } else if (roleChanged || bindingChanged) {
    notifyRevoke({ userId: user.id, reason: roleChanged ? 'role' : 'binding' });
  }
  return user;
}

function deleteUser(id, options = {}) {
  const user = findUserById(id);
  if (!user) throw new NotFoundError('用户不存在');
  if (options.actorId && options.actorId === user.id) {
    throw new ForbiddenError('不能删除自己');
  }
  if (user.role === 'admin' && !user.disabled && countActiveAdmins() <= 1) {
    throw new ForbiddenError('不能停用、降级或删除最后一个管理员');
  }
  revokeUserSessions(user.id);
  revokeUserTokens(user.id);
  users.delete(user.id);
  usersByName.delete(user.usernameKey);
  saveAuthFile();
  notifyRevoke({ userId: user.id, reason: 'deleted' });
  return user;
}

function setUserPassword(id, passwordHash, options = {}) {
  const user = findUserById(id);
  if (!user) throw new NotFoundError('用户不存在');
  if (typeof passwordHash !== 'string' || !passwordHash) {
    const err = new Error('密码哈希无效');
    err.name = 'UserInputError';
    throw err;
  }
  user.passwordHash = passwordHash;
  user.updatedAt = nowIso();
  saveAuthFile();
  revokeUserSessions(user.id, options.keepSessionId || null);
  revokeUserTokens(user.id);
  return user;
}

async function setup(username, password) {
  if (!isSetupRequired()) return { ok: false, reason: 'exists' };
  if (setupInProgress) return { ok: false, reason: 'busy' };
  setupInProgress = true;
  try {
    const normalized = normalizePassword(password);
    const hash = await hashPassword(normalized);
    if (users.size > 0) return { ok: false, reason: 'exists' };
    const user = createUser({
      username,
      passwordHash: hash,
      role: 'admin',
      displayName: username,
    });
    log.info('已创建首个管理员', { username: user.username });
    return { ok: true, user };
  } finally {
    setupInProgress = false;
  }
}

function createSession(user, { remember = false, ip = '', userAgent = '' } = {}) {
  const token = crypto.randomBytes(32).toString('base64url');
  const csrfToken = crypto.randomBytes(32).toString('base64url');
  const ttlMs = remember
    ? config.auth.sessionRememberDays * 24 * 60 * 60 * 1000
    : config.auth.sessionTtlHours * 60 * 60 * 1000;
  const now = Date.now();
  const session = {
    id: newId(),
    tokenHash: sha256(token),
    csrfToken,
    userId: user.id,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
    lastSeenAt: new Date(now).toISOString(),
    ip: String(ip || '').slice(0, 128),
    userAgent: String(userAgent || '').slice(0, 300),
    remember: Boolean(remember),
  };
  sessions.set(session.id, session);
  sessionsByHash.set(session.tokenHash, session);
  saveSessionsFile();
  return {
    token,
    csrfToken,
    session,
    maxAge: remember ? Math.floor(ttlMs / 1000) : null,
  };
}

function findSessionByToken(token) {
  if (!token) return null;
  const hash = sha256(token);
  const session = sessionsByHash.get(hash);
  if (!session) return null;
  if (toMs(session.expiresAt) <= Date.now()) {
    revokeSession(session.id);
    return null;
  }
  const user = users.get(session.userId);
  if (!user || user.disabled) {
    revokeSession(session.id);
    return null;
  }
  session.lastSeenAt = nowIso();
  scheduleSessionsSave();
  return { session, user };
}

function findSessionById(id) {
  return sessions.get(String(id)) || null;
}

function listSessions(userId, currentId) {
  const now = Date.now();
  const list = [...sessions.values()]
    .filter((s) => !userId || s.userId === userId)
    .filter((s) => toMs(s.expiresAt) > now)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return list.map((s) => publicSession(s, currentId));
}

function revokeSession(id) {
  const session = sessions.get(String(id));
  if (!session) return false;
  sessions.delete(session.id);
  sessionsByHash.delete(session.tokenHash);
  saveSessionsFile();
  notifyRevoke({ sessionId: session.id, userId: session.userId });
  return true;
}

function revokeUserSessions(userId, exceptId = null) {
  let removed = 0;
  for (const session of [...sessions.values()]) {
    if (session.userId !== userId) continue;
    if (exceptId && session.id === exceptId) continue;
    sessions.delete(session.id);
    sessionsByHash.delete(session.tokenHash);
    removed += 1;
    notifyRevoke({ sessionId: session.id, userId });
  }
  if (removed) saveSessionsFile();
  return removed;
}

function revokeAllSessions(exceptId = null) {
  let removed = 0;
  for (const session of [...sessions.values()]) {
    if (exceptId && session.id === exceptId) continue;
    sessions.delete(session.id);
    sessionsByHash.delete(session.tokenHash);
    removed += 1;
    notifyRevoke({ sessionId: session.id, userId: session.userId });
  }
  if (removed) saveSessionsFile();
  return removed;
}

function createToken(userId, name = '令牌', expiresAt = null) {
  const user = findUserById(userId);
  if (!user) throw new NotFoundError('用户不存在');
  const secret = 'ssb_' + crypto.randomBytes(32).toString('base64url');
  const token = {
    id: newId(),
    userId: user.id,
    name: String(name || '令牌').trim().slice(0, 60) || '令牌',
    tokenHash: sha256(secret),
    createdAt: nowIso(),
    lastUsedAt: null,
    expiresAt: expiresAt || null,
  };
  tokens.set(token.id, token);
  tokensByHash.set(token.tokenHash, token);
  saveAuthFile();
  return { token: secret, record: token };
}

function findTokenBySecret(secret) {
  if (!secret) return null;
  const hash = sha256(secret);
  const record = tokensByHash.get(hash);
  if (!record) return null;
  if (record.expiresAt && toMs(record.expiresAt) <= Date.now()) {
    revokeToken(record.id);
    return null;
  }
  const user = users.get(record.userId);
  if (!user || user.disabled) {
    revokeToken(record.id);
    return null;
  }
  record.lastUsedAt = nowIso();
  scheduleAuthSave();
  return { token: record, user };
}

function findTokenById(id) {
  return tokens.get(String(id)) || null;
}

function listTokens(userId) {
  const now = Date.now();
  return [...tokens.values()]
    .filter((t) => !userId || t.userId === userId)
    .filter((t) => !t.expiresAt || toMs(t.expiresAt) > now)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(publicToken);
}

function revokeToken(id) {
  const token = tokens.get(String(id));
  if (!token) return false;
  tokens.delete(token.id);
  tokensByHash.delete(token.tokenHash);
  saveAuthFile();
  notifyRevoke({ tokenId: token.id, userId: token.userId });
  return true;
}

function revokeUserTokens(userId) {
  let removed = 0;
  for (const token of [...tokens.values()]) {
    if (token.userId !== userId) continue;
    tokens.delete(token.id);
    tokensByHash.delete(token.tokenHash);
    removed += 1;
    notifyRevoke({ tokenId: token.id, userId });
  }
  if (removed) saveAuthFile();
  return removed;
}

function setRevocationListener(fn) {
  revokeListener = typeof fn === 'function' ? fn : null;
}

function expireNow() {
  const now = Date.now();
  let removed = 0;
  for (const session of [...sessions.values()]) {
    if (toMs(session.expiresAt) <= now) {
      sessions.delete(session.id);
      sessionsByHash.delete(session.tokenHash);
      removed += 1;
      notifyRevoke({ sessionId: session.id, userId: session.userId });
    }
  }
  for (const token of [...tokens.values()]) {
    if (token.expiresAt && toMs(token.expiresAt) <= now) {
      tokens.delete(token.id);
      tokensByHash.delete(token.tokenHash);
      notifyRevoke({ tokenId: token.id, userId: token.userId });
    }
  }
  if (removed) saveSessionsFile();
  return removed;
}

function startCleanup() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    try { expireNow(); } catch (error) { log.warn('会话清理失败', { error: error.message }); }
  }, 60 * 60 * 1000);
  if (cleanupTimer.unref) cleanupTimer.unref();
}

function readBootstrapPassword() {
  if (config.auth.adminPasswordFile) {
    const file = config.auth.adminPasswordFile;
    try {
      return fs.readFileSync(file, 'utf8').replace(/[\r\n]+$/, '');
    } catch (error) {
      throw new Error('无法读取 ADMIN_PASSWORD_FILE：' + error.message);
    }
  }
  return config.auth.adminPassword || '';
}

function init(options = {}) {
  enabled = options.enabled !== false;
  loaded = true;
  if (!enabled) return { enabled: false, setupRequired: false };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  loadAuthFile();
  loadSessionsFile();
  try { fs.chmodSync(AUTH_FILE, 0o600); } catch (_) {}
  try { fs.chmodSync(SESSIONS_FILE, 0o600); } catch (_) {}
  startCleanup();
  if (users.size === 0 && options.bootstrap !== false) {
    const password = readBootstrapPassword();
    if (password) {
      const username = config.auth.adminUsername || 'admin';
      const hash = hashPasswordSync(password);
      const user = createUser({
        username,
        passwordHash: hash,
        role: 'admin',
        displayName: username,
      });
      log.info('已根据环境变量创建管理员', { username: user.username });
    } else {
      log.warn('尚未初始化管理员：请在本机打开管理端完成设置，或设置 ADMIN_PASSWORD / ADMIN_PASSWORD_FILE');
    }
  }
  expireNow();
  return { enabled: true, setupRequired: users.size === 0 };
}

function flush() {
  if (!enabled || !loaded) return;
  try {
    if (authDirty) saveAuthFile();
  } catch (error) {
    log.warn('auth.json 落盘失败', { error: error.message });
  }
  try {
    if (sessionsDirty) saveSessionsFile();
  } catch (error) {
    log.warn('sessions.json 落盘失败', { error: error.message });
  }
}

module.exports = {
  AUTH_FILE,
  SESSIONS_FILE,
  init,
  flush,
  isEnabled,
  isLoginRequired,
  isOpenAccess,
  firstActiveAdminId,
  getAccessSettings,
  setRequireLogin,
  isSetupRequired,
  setupAllowedFor,
  countActiveAdmins,
  findUserById,
  findUserByUsername,
  listUsers,
  publicUser,
  publicSession,
  publicToken,
  authenticate,
  createUser,
  updateUser,
  deleteUser,
  setUserPassword,
  setup,
  createSession,
  findSessionByToken,
  findSessionById,
  listSessions,
  revokeSession,
  revokeUserSessions,
  revokeAllSessions,
  createToken,
  findTokenBySecret,
  findTokenById,
  listTokens,
  revokeToken,
  revokeUserTokens,
  setRevocationListener,
  expireNow,
  hashPassword,
  hashPasswordSync,
  verifyPassword,
  normalizePassword,
  sha256,
};
