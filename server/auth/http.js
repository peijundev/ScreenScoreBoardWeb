'use strict';
// HTTP 身份解析、角色/Origin/CSRF 校验与 /api/v1/auth/* 处理器
const crypto = require('crypto');
const { logger } = require('../logger');
const { isOriginAllowed, effectiveHost, effectiveClientIp } = require('../security');
const { UnauthorizedError, ForbiddenError, NotFoundError } = require('../validation');
const { ApiError, ApiConflictError, ApiUnprocessableError } = require('../api/errors');
const store = require('./store');
const {
  routeMinRole,
  roleAtLeast,
} = require('./policy');
const {
  SYSTEM,
  ANONYMOUS,
} = require('./context');
const {
  CSRF_COOKIE,
  readSessionToken,
  cookieSecure,
  serializeCookie,
  setSessionCookies,
  clearSessionCookies,
} = require('./cookies');

const log = logger.child({ scope: 'auth' });
const CSRF_EXEMPT = new Set([
  '/api/v1/auth/login',
  '/api/v1/auth/setup',
  '/api/v1/auth/logout',
]);

function bearerToken(req) {
  const header = req.headers && req.headers.authorization;
  if (!header) return '';
  const match = /^Bearer\s+(.+)$/i.exec(String(header).trim());
  return match ? match[1].trim() : '';
}

function resolveRequest(req) {
  if (!store.isEnabled()) {
    req.auth = SYSTEM;
    return req.auth;
  }
  if (req.__authResolved) return req.auth;
  const bearer = bearerToken(req);
  if (bearer) {
    const found = store.findTokenBySecret(bearer);
    if (!found) {
      req.auth = { kind: 'invalid', role: 'anonymous', reason: 'token' };
    } else {
      req.auth = {
        kind: 'token',
        userId: found.user.id,
        role: found.user.role,
        tokenId: found.token.id,
        username: found.user.username,
      };
    }
    req.__authResolved = true;
    return req.auth;
  }
  const token = readSessionToken(req);
  if (!token) {
    req.auth = ANONYMOUS;
    req.__authResolved = true;
    return req.auth;
  }
  const found = store.findSessionByToken(token);
  if (!found) {
    req.auth = { kind: 'invalid', role: 'anonymous', reason: 'session' };
    req.__authResolved = true;
    return req.auth;
  }
  req.auth = {
    kind: 'user',
    userId: found.user.id,
    role: found.user.role,
    sessionId: found.session.id,
    sessionExpiresAt: found.session.expiresAt,
    remember: found.session.remember,
    csrfToken: found.session.csrfToken,
    username: found.user.username,
  };
  req.__authResolved = true;
  return req.auth;
}

function sendAuthError(res, status, code, message) {
  if (res.headersSent) return;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify({ error: { code, message } }));
}

function requireRole(req, res, minimum) {
  if (!store.isEnabled() || minimum === 'public') return true;
  const auth = req.auth || ANONYMOUS;
  if (auth.kind === 'system') return true;
  if (auth.kind === 'anonymous' || auth.kind === 'invalid') {
    sendAuthError(res, 401, 'UNAUTHORIZED', '请先登录');
    return false;
  }
  if (!roleAtLeast(auth.role, minimum)) {
    sendAuthError(res, 403, 'FORBIDDEN', '没有权限');
    return false;
  }
  return true;
}

function requireOrigin(req, res) {
  const method = String(req.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;
  const origin = req.headers && req.headers.origin;
  if (!isOriginAllowed(origin, effectiveHost(req))) {
    sendAuthError(res, 403, 'ORIGIN_NOT_ALLOWED', 'Origin 不被允许');
    return false;
  }
  return true;
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  if (!left.length || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function isCsrfExempt(pathname) {
  return CSRF_EXEMPT.has(String(pathname || ''));
}

function requireCsrf(req, res, pathname) {
  if (!store.isEnabled()) return true;
  const auth = req.auth || ANONYMOUS;
  if (auth.kind !== 'user') return true;
  const method = String(req.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;
  if (isCsrfExempt(pathname)) return true;
  const provided = req.headers && req.headers['x-csrf-token'];
  if (!safeEqual(provided, auth.csrfToken)) {
    sendAuthError(res, 403, 'CSRF_FAILED', 'CSRF 校验失败，请刷新页面后重试');
    return false;
  }
  return true;
}

function ensureCsrfCookie(req, res) {
  const auth = req.auth;
  if (!store.isEnabled() || !auth || auth.kind !== 'user' || !auth.csrfToken) return;
  const current = req.headers && req.headers.cookie;
  if (current && current.includes(CSRF_COOKIE + '=' + auth.csrfToken)) return;
  let maxAge = null;
  if (auth.remember && auth.sessionExpiresAt) {
    const remains = Date.parse(auth.sessionExpiresAt) - Date.now();
    if (Number.isFinite(remains) && remains > 0) maxAge = Math.floor(remains / 1000);
  }
  const cookie = serializeCookie(CSRF_COOKIE, auth.csrfToken, {
    httpOnly: false,
    secure: cookieSecure(req),
    maxAge,
  });
  const existing = res.getHeader('Set-Cookie');
  const list = Array.isArray(existing) ? existing : existing ? [existing] : [];
  res.setHeader('Set-Cookie', [...list, cookie]);
}

function authStatus(req) {
  if (!store.isEnabled()) {
    return {
      authEnabled: false,
      setupRequired: false,
      setupAllowed: false,
      authenticated: true,
      user: {
        id: 'local',
        username: 'electron',
        displayName: '本机',
        role: 'admin',
      },
    };
  }
  if (store.isSetupRequired()) {
    return {
      authEnabled: true,
      setupRequired: true,
      setupAllowed: store.setupAllowedFor(req),
      authenticated: false,
      user: null,
    };
  }
  const auth = req.auth || ANONYMOUS;
  if (auth.kind === 'user' || auth.kind === 'token') {
    const user = store.findUserById(auth.userId);
    if (user) {
      return {
        authEnabled: true,
        setupRequired: false,
        setupAllowed: false,
        authenticated: true,
        user: store.publicUser(user),
      };
    }
  }
  return {
    authEnabled: true,
    setupRequired: false,
    setupAllowed: false,
    authenticated: false,
    user: null,
  };
}

function validateActor(actor) {
  if (!actor || actor.kind === 'system') return Boolean(actor);
  if (actor.kind === 'anonymous' || actor.kind === 'invalid') return false;
  if (actor.kind === 'user') {
    const session = store.findSessionById(actor.sessionId);
    if (!session || Date.parse(session.expiresAt) <= Date.now()) return false;
    const user = store.findUserById(session.userId);
    return Boolean(user && !user.disabled && user.role === actor.role);
  }
  if (actor.kind === 'token') {
    const record = store.findTokenById(actor.tokenId);
    if (!record) return false;
    if (record.expiresAt && Date.parse(record.expiresAt) <= Date.now()) return false;
    const user = store.findUserById(record.userId);
    return Boolean(user && !user.disabled && user.role === actor.role);
  }
  return false;
}

function requireLogin(ctx) {
  const auth = ctx.auth || ANONYMOUS;
  if (auth.kind === 'system') return { kind: 'system', role: 'system' };
  if (auth.kind !== 'user' && auth.kind !== 'token') {
    throw new UnauthorizedError('请先登录');
  }
  const user = store.findUserById(auth.userId);
  if (!user || user.disabled) throw new UnauthorizedError('登录已失效，请重新登录');
  return auth;
}

function requireAdmin(ctx) {
  const auth = requireLogin(ctx);
  if (auth.kind === 'system') {
    throw new ApiConflictError('本机模式未启用鉴权');
  }
  if (auth.role !== 'admin') throw new ForbiddenError('需要管理员权限');
  return auth;
}

function targetUserId(ctx, requested) {
  const auth = requireLogin(ctx);
  if (auth.kind === 'system') return requested || '';
  const wanted = requested == null || requested === '' ? auth.userId : String(requested);
  if (wanted !== auth.userId && auth.role !== 'admin') {
    throw new ForbiddenError('没有权限操作其他用户');
  }
  return wanted;
}

function validateExpiresAt(value) {
  if (value == null || value === '') return null;
  const ms = Date.parse(String(value));
  if (!Number.isFinite(ms) || ms <= Date.now()) {
    throw new ApiUnprocessableError('过期时间必须是未来的时间');
  }
  return new Date(ms).toISOString();
}

function noStore(res) {
  res.setHeader('Cache-Control', 'no-store');
}

async function status(ctx) {
  resolveRequest(ctx.req);
  ensureCsrfCookie(ctx.req, ctx.res);
  noStore(ctx.res);
  return { data: authStatus(ctx.req) };
}

async function setup(ctx) {
  if (!store.isSetupRequired()) throw new ApiConflictError('初始化已完成');
  if (!store.setupAllowedFor(ctx.req)) {
    throw new ApiError(403, 'SETUP_NOT_ALLOWED', '请在本机完成初始化，或设置 ADMIN_PASSWORD 后重启');
  }
  const username = String(ctx.body.username || '').trim();
  const password = String(ctx.body.password || '');
  if (!username || !password) throw new ApiUnprocessableError('用户名和密码不能为空');
  const result = await store.setup(username, password);
  if (!result.ok) {
    if (result.reason === 'exists') throw new ApiConflictError('初始化已完成');
    throw new ApiConflictError('初始化正在进行，请稍后重试');
  }
  const created = store.createSession(result.user, {
    remember: true,
    ip: effectiveClientIp(ctx.req),
    userAgent: String(ctx.req.headers['user-agent'] || ''),
  });
  setSessionCookies(ctx.res, {
    token: created.token,
    csrfToken: created.csrfToken,
    maxAge: created.maxAge,
    secure: cookieSecure(ctx.req),
  });
  noStore(ctx.res);
  log.info('初始化完成', { username: result.user.username });
  return { data: { user: store.publicUser(result.user) } };
}

async function login(ctx) {
  if (!store.isEnabled()) throw new ApiConflictError('当前为本机模式，未启用鉴权');
  if (store.isSetupRequired()) throw new ApiError(503, 'SETUP_REQUIRED', '尚未初始化管理员');
  const username = String(ctx.body.username || '').trim();
  const password = String(ctx.body.password || '');
  const remember = Boolean(ctx.body.remember);
  if (!username || !password) throw new UnauthorizedError('用户名或密码错误');
  const user = await store.authenticate(username, password);
  if (!user) {
    log.warn('登录失败', {
      username,
      ip: effectiveClientIp(ctx.req),
      reason: 'invalid credentials',
    });
    throw new UnauthorizedError('用户名或密码错误');
  }
  const created = store.createSession(user, {
    remember,
    ip: effectiveClientIp(ctx.req),
    userAgent: String(ctx.req.headers['user-agent'] || ''),
  });
  setSessionCookies(ctx.res, {
    token: created.token,
    csrfToken: created.csrfToken,
    maxAge: created.maxAge,
    secure: cookieSecure(ctx.req),
  });
  noStore(ctx.res);
  log.info('登录成功', { username: user.username, ip: effectiveClientIp(ctx.req) });
  return { data: { user: store.publicUser(user) } };
}

async function logout(ctx) {
  const auth = ctx.auth || ANONYMOUS;
  if (auth.kind === 'user' && auth.sessionId) store.revokeSession(auth.sessionId);
  if (auth.kind === 'token' && auth.tokenId) store.revokeToken(auth.tokenId);
  clearSessionCookies(ctx.res, cookieSecure(ctx.req));
  noStore(ctx.res);
  return { data: { ok: true } };
}

async function me(ctx) {
  const auth = requireLogin(ctx);
  const user = auth.kind === 'system' ? null : store.findUserById(auth.userId);
  ensureCsrfCookie(ctx.req, ctx.res);
  noStore(ctx.res);
  return { data: { user: store.publicUser(user), authEnabled: store.isEnabled() } };
}

async function changePassword(ctx) {
  const auth = requireLogin(ctx);
  if (auth.kind === 'system') throw new ApiConflictError('本机模式未启用鉴权');
  const currentPassword = String(ctx.body.currentPassword || '');
  const newPassword = String(ctx.body.newPassword || '');
  const user = store.findUserById(auth.userId);
  if (!user) throw new UnauthorizedError('登录已失效，请重新登录');
  const ok = await store.verifyPassword(currentPassword, user.passwordHash);
  if (!ok) throw new UnauthorizedError('当前密码不正确');
  const hash = await store.hashPassword(newPassword);
  store.setUserPassword(user.id, hash, { keepSessionId: auth.sessionId });
  log.info('修改密码', { username: user.username });
  return { data: { ok: true } };
}

async function listSessions(ctx) {
  const auth = requireLogin(ctx);
  const userId = targetUserId(ctx, ctx.query.userId);
  if (auth.kind === 'system') return { data: { sessions: [] } };
  return { data: { sessions: store.listSessions(userId, auth.sessionId) } };
}

async function revokeSession(ctx) {
  const auth = requireLogin(ctx);
  const session = store.findSessionById(ctx.params.id);
  if (!session) throw new NotFoundError('会话不存在');
  if (auth.kind !== 'system' && auth.role !== 'admin' && session.userId !== auth.userId) {
    throw new ForbiddenError('没有权限操作该会话');
  }
  store.revokeSession(session.id);
  return { data: { ok: true } };
}

async function logoutAll(ctx) {
  const auth = requireLogin(ctx);
  if (auth.kind === 'system') return { data: { removed: 0 } };
  const removed = store.revokeUserSessions(auth.userId, auth.sessionId);
  return { data: { removed } };
}

async function listTokens(ctx) {
  const auth = requireLogin(ctx);
  const userId = targetUserId(ctx, ctx.query.userId);
  if (auth.kind === 'system') return { data: { tokens: [] } };
  return { data: { tokens: store.listTokens(userId) } };
}

async function createToken(ctx) {
  const auth = requireLogin(ctx);
  if (auth.kind === 'system') throw new ApiConflictError('本机模式未启用鉴权');
  const userId = targetUserId(ctx, ctx.body.userId);
  const name = String(ctx.body.name || '令牌').trim();
  const expiresAt = validateExpiresAt(ctx.body.expiresAt);
  const created = store.createToken(userId, name, expiresAt);
  log.info('创建 API 令牌', { userId, tokenId: created.record.id });
  return { data: { token: created.token, ...store.publicToken(created.record) } };
}

async function revokeToken(ctx) {
  const auth = requireLogin(ctx);
  const record = store.findTokenById(ctx.params.id);
  if (!record) throw new NotFoundError('令牌不存在');
  if (auth.kind !== 'system' && auth.role !== 'admin' && record.userId !== auth.userId) {
    throw new ForbiddenError('没有权限操作该令牌');
  }
  store.revokeToken(record.id);
  return { data: { ok: true } };
}

async function listUsers(ctx) {
  requireAdmin(ctx);
  return { data: { users: store.listUsers() } };
}

async function createUser(ctx) {
  requireAdmin(ctx);
  const username = String(ctx.body.username || '').trim();
  const password = String(ctx.body.password || '');
  const role = String(ctx.body.role || 'viewer');
  const displayName = String(ctx.body.displayName || username);
  const hash = await store.hashPassword(password);
  const user = store.createUser({ username, passwordHash: hash, role, displayName });
  log.info('创建用户', { username: user.username, role: user.role });
  return { data: { user: store.publicUser(user) } };
}

async function updateUser(ctx) {
  requireAdmin(ctx);
  const patch = {};
  if (ctx.body.displayName !== undefined) patch.displayName = ctx.body.displayName;
  if (ctx.body.role !== undefined) patch.role = ctx.body.role;
  if (ctx.body.disabled !== undefined) patch.disabled = Boolean(ctx.body.disabled);
  const user = store.updateUser(ctx.params.id, patch, {
    actorId: ctx.auth && ctx.auth.userId,
  });
  log.info('更新用户', { username: user.username, role: user.role, disabled: user.disabled });
  return { data: { user: store.publicUser(user) } };
}

async function resetUserPassword(ctx) {
  requireAdmin(ctx);
  const user = store.findUserById(ctx.params.id);
  if (!user) throw new NotFoundError('用户不存在');
  const hash = await store.hashPassword(String(ctx.body.password || ''));
  store.setUserPassword(user.id, hash);
  log.info('重置用户密码', { username: user.username });
  return { data: { ok: true } };
}

async function deleteUser(ctx) {
  const auth = requireAdmin(ctx);
  const user = store.deleteUser(ctx.params.id, {
    actorId: auth.kind === 'system' ? null : auth.userId,
  });
  log.info('删除用户', { username: user.username });
  return { data: { ok: true } };
}

async function userSessions(ctx) {
  requireAdmin(ctx);
  const user = store.findUserById(ctx.params.id);
  if (!user) throw new NotFoundError('用户不存在');
  return { data: { sessions: store.listSessions(user.id, null) } };
}

async function revokeUserSession(ctx) {
  requireAdmin(ctx);
  const user = store.findUserById(ctx.params.id);
  if (!user) throw new NotFoundError('用户不存在');
  const session = store.findSessionById(ctx.params.sessionId);
  if (!session || session.userId !== user.id) throw new NotFoundError('会话不存在');
  store.revokeSession(session.id);
  return { data: { ok: true } };
}

async function userTokens(ctx) {
  requireAdmin(ctx);
  const user = store.findUserById(ctx.params.id);
  if (!user) throw new NotFoundError('用户不存在');
  return { data: { tokens: store.listTokens(user.id) } };
}

async function createUserToken(ctx) {
  requireAdmin(ctx);
  const user = store.findUserById(ctx.params.id);
  if (!user) throw new NotFoundError('用户不存在');
  const name = String(ctx.body.name || '令牌').trim();
  const expiresAt = validateExpiresAt(ctx.body.expiresAt);
  const created = store.createToken(user.id, name, expiresAt);
  log.info('为用户创建 API 令牌', { username: user.username, tokenId: created.record.id });
  return { data: { token: created.token, ...store.publicToken(created.record) } };
}

async function revokeUserToken(ctx) {
  requireAdmin(ctx);
  const user = store.findUserById(ctx.params.id);
  if (!user) throw new NotFoundError('用户不存在');
  const record = store.findTokenById(ctx.params.tokenId);
  if (!record || record.userId !== user.id) throw new NotFoundError('令牌不存在');
  store.revokeToken(record.id);
  return { data: { ok: true } };
}

module.exports = {
  resolveRequest,
  validateActor,
  authStatus,
  ensureCsrfCookie,
  requireRole,
  requireOrigin,
  requireCsrf,
  sendAuthError,
  authorize(req, route) {
    const minimum = routeMinRole(route);
    if (minimum === 'public') return true;
    const auth = req.auth || ANONYMOUS;
    if (auth.kind === 'system') return true;
    if (auth.kind === 'anonymous' || auth.kind === 'invalid') {
      throw new UnauthorizedError('请先登录');
    }
    if (!roleAtLeast(auth.role, minimum)) throw new ForbiddenError('没有权限');
    return true;
  },
  handlers: {
    status,
    setup,
    login,
    logout,
    me,
    changePassword,
    listSessions,
    revokeSession,
    logoutAll,
    listTokens,
    createToken,
    revokeToken,
    listUsers,
    createUser,
    updateUser,
    resetUserPassword,
    deleteUser,
    userSessions,
    revokeUserSession,
    userTokens,
    createUserToken,
    revokeUserToken,
  },
};
