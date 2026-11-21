'use strict';
// 角色与权限的单一来源：op、REST v1 路由、旧版 /api/* 路由
const { UnauthorizedError, ForbiddenError } = require('../validation');

const ROLES = Object.freeze(['viewer', 'operator', 'admin']);
const ROLE_RANK = Object.freeze({ viewer: 10, operator: 20, admin: 30 });
const ROLE_LABELS = Object.freeze({ admin: '管理员', operator: '操作员', viewer: '只读' });

const { OPS } = require('../ops');

// 操作员只能记分与撤销；其余全部管理员
const OPERATOR_OPS = new Set([
  'addScore',
  'setScore',
  'addTeamScore',
  'triggerSpotlight',
  'undoScore',
  'undoTo',
]);

const OP_MIN_ROLE = Object.freeze(
  Object.fromEntries(
    Object.keys(OPS).map((op) => [op, OPERATOR_OPS.has(op) ? 'operator' : 'admin']),
  ),
);

function isRole(value) {
  return Object.prototype.hasOwnProperty.call(ROLE_RANK, value);
}

function roleRank(role) {
  return ROLE_RANK[role] || 0;
}

function roleAtLeast(role, minimum) {
  if (minimum === 'public') return true;
  if (minimum === 'system') return role === 'system';
  if (!isRole(role)) return false;
  return roleRank(role) >= roleRank(minimum);
}

function minOpRole(op) {
  return OP_MIN_ROLE[op] || 'admin';
}

function canOp(role, op) {
  if (role === 'system') return true;
  if (!isRole(role)) return false;
  return roleRank(role) >= roleRank(minOpRole(op));
}

function assertCanOp(actor, op) {
  if (!actor || actor.kind === 'anonymous') throw new UnauthorizedError('请先登录');
  if (actor.kind === 'invalid') throw new UnauthorizedError('登录已失效，请重新登录');
  if (actor.kind === 'system') return;
  if (!canOp(actor.role, op)) throw new ForbiddenError('没有权限执行该操作');
}

// REST v1：显式例外；其余 GET 需要 viewer，其余写操作需要 admin
const V1_ROUTE_ACCESS = Object.freeze({
  'GET /health': 'public',
  'GET /version': 'public',
  'GET /state': 'public',
  'GET /themes/:themeId': 'public',

  'GET /assets': 'admin',
  'GET /backups': 'admin',
  'GET /orphans': 'admin',
  'GET /endpoints': 'admin',
  'GET /openapi.json': 'admin',
  'GET /projects/:projectId/theme-draft': 'admin',
  'GET /projects/:projectId/export': 'admin',
  'GET /projects/:projectId/scores.csv': 'admin',

  'POST /projects/:projectId/people/:personId/score/add': 'operator',
  'POST /projects/:projectId/people/:personId/score/set': 'operator',
  'POST /projects/:projectId/teams/:teamId/score/add': 'operator',
  'POST /projects/:projectId/spotlight': 'operator',
  'POST /projects/:projectId/runtime/undo': 'operator',
  'POST /projects/:projectId/runtime/undo-to': 'operator',
  'POST /ops': 'operator',
  'POST /projects/:projectId/ops': 'operator',
});

function routeMinRole(route) {
  if (!route) return 'admin';
  if (route.access) return route.access;
  const exact = V1_ROUTE_ACCESS[route.method + ' ' + route.path];
  if (exact) return exact;
  return route.method === 'GET' ? 'viewer' : 'admin';
}

/** 旧版 /api/*：未知路径默认 admin（fail closed） */
function legacyMinRole(method, pathname) {
  const p = String(pathname || '');
  if (method === 'GET') {
    if (p === '/api/health' || p === '/api/state' || p === '/api/version') return 'public';
    if (/^\/api\/themes\/[^/]+$/.test(p)) return 'public';
    if (p === '/api/themes') return 'viewer';
  }
  return 'admin';
}

module.exports = {
  ROLES,
  ROLE_RANK,
  ROLE_LABELS,
  OPERATOR_OPS,
  OP_MIN_ROLE,
  isRole,
  roleRank,
  roleAtLeast,
  minOpRole,
  canOp,
  assertCanOp,
  routeMinRole,
  legacyMinRole,
};
