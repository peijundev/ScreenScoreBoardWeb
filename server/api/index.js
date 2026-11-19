'use strict';
// REST v1：路由匹配 → 资源处理 → 统一响应；写操作全部经 applyOp
const { createRouter } = require('./router');
const { requestId, sendData, sendError, readJsonBody } = require('./responses');
const { toApiError, ApiError } = require('./errors');
const { send } = require('../static');
const { isOriginAllowed } = require('../security');
const { logger } = require('../logger');
const projects = require('./resources/projects');
const themes = require('./resources/themes');
const data = require('./resources/data');
const { createSystemRoutes } = require('./resources/system');

// 预留鉴权钩子：当前始终放行。远程化部署时在这里校验 Token / 会话 / 权限。
function authorize(_req) {
  return true;
}

let allRoutes = [];
const resourceRoutes = [...projects.routes, ...themes.routes, ...data.routes];
allRoutes = [...createSystemRoutes(() => allRoutes), ...resourceRoutes];
const matchRoute = createRouter(allRoutes);

function listRoutes() {
  return allRoutes;
}

async function handleApiV1(req, res, url) {
  const id = requestId();
  const origin = req.headers.origin;
  if (!isOriginAllowed(origin, req.headers.host)) {
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
      'Access-Control-Allow-Headers': 'Content-Type, If-Match',
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
  const ctx = {
    req,
    res,
    params,
    query: Object.fromEntries(url.searchParams.entries()),
    body: {},
    requestId: id,
  };
  try {
    if (!authorize(req)) {
      throw new ApiError(401, 'UNAUTHORIZED', '未授权');
    }
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
