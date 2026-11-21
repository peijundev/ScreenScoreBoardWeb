'use strict';
// REST v1：路由匹配 → 资源处理 → 统一响应；写操作全部经 applyOp
const { createRouter } = require('./router');
const { requestId, sendData, sendError, readJsonBody } = require('./responses');
const { toApiError, ApiError } = require('./errors');
const { send } = require('../static');
const { isOriginAllowed, effectiveHost } = require('../security');
const { logger } = require('../logger');
const auth = require('../auth/http');
const authResources = require('./resources/auth');
const projects = require('./resources/projects');
const themes = require('./resources/themes');
const data = require('./resources/data');
const storage = require('./resources/storage');
const { createSystemRoutes } = require('./resources/system');

let allRoutes = [];
const resourceRoutes = [
  ...authResources.routes,
  ...projects.routes,
  ...themes.routes,
  ...data.routes,
  ...storage.routes,
];
allRoutes = [...createSystemRoutes(() => allRoutes), ...resourceRoutes];
const matchRoute = createRouter(allRoutes);

function listRoutes() {
  return allRoutes;
}

async function handleApiV1(req, res, url) {
  const id = requestId();
  auth.resolveRequest(req);
  const origin = req.headers.origin;
  if (!isOriginAllowed(origin, effectiveHost(req))) {
    sendError(res, new ApiError(403, 'ORIGIN_NOT_ALLOWED', 'Origin 不被允许'), id);
    return true;
  }
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') {
    send(res, 204, '', {
      Allow: 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, If-Match, Authorization, X-CSRF-Token',
      'Access-Control-Max-Age': '600',
    });
    return true;
  }
  // 路由表使用相对路径（/projects/...），这里去掉 /api/v1 前缀
  const subPath = url.pathname.slice('/api/v1'.length) || '/';
  const matched = matchRoute(req.method, subPath);
  if (!matched) {
    sendError(res, new ApiError(404, 'NOT_FOUND', '接口不存在'), id);
    return true;
  }
  const { route, params } = matched;
  if (url.pathname.startsWith('/api/v1/auth/')) {
    res.setHeader('Cache-Control', 'no-store');
  }
  const ctx = {
    req,
    res,
    params,
    query: Object.fromEntries(url.searchParams.entries()),
    body: {},
    auth: req.auth,
    requestId: id,
  };
  try {
    auth.authorize(req, route);
    if (!auth.requireCsrf(req, res, url.pathname)) return true;
    if (!route.raw && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      ctx.body = await readJsonBody(req, route.bodyLimit || 2 * 1024 * 1024);
    }
    const result = await route.handler(ctx);
    if (result !== undefined && !res.headersSent) {
      sendData(res, result.data, { requestId: id, ...(result.meta || {}) }, result.status || 200);
    }
  } catch (error) {
    const apiError = toApiError(error);
    if (apiError.status >= 500) {
      logger.error('API v1 请求失败', { path: url.pathname, error: error && error.message });
    }
    if (!res.headersSent) sendError(res, apiError, id);
  }
  return true;
}

module.exports = { handleApiV1, listRoutes, allRoutes };
