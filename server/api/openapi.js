'use strict';
// 由路由表生成 OpenAPI 3.1，避免手写与实现漂移
const APP_VERSION = require('../../package.json').version;
const { routeMinRole } = require('../auth/policy');

const QUERY_PARAMS = {
  '/projects/:projectId/people': [
    { name: 'q', in: 'query', description: '按姓名过滤', schema: { type: 'string' } },
    { name: 'teamId', in: 'query', description: '按团队过滤', schema: { type: 'string' } },
  ],
  '/projects/:projectId/export': [
    { name: 'assets', in: 'query', description: '1 时内联头像/音频资产', schema: { type: 'string', enum: ['0', '1', 'true', 'false'] } },
  ],
  '/projects/:projectId/scores.csv': [
    { name: 'scope', in: 'query', description: '导出范围', schema: { type: 'string', enum: ['all', 'people', 'teams'] } },
  ],
};

function pathParams(pathPattern) {
  return pathPattern.split('/').filter((part) => part.startsWith(':')).map((part) => part.slice(1));
}

function openApiPath(pathPattern) {
  return pathPattern.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function tagOf(pathPattern) {
  const first = pathPattern.split('/').filter(Boolean)[0] || 'system';
  return first;
}

function needsRevision(route) {
  if (route.method === 'GET') return false;
  if (route.revision === true) return true;
  if (route.path.startsWith('/themes/') && route.path !== '/themes/import') return true;
  if (route.path.endsWith('/theme-draft') && route.method === 'PATCH') return true;
  return false;
}

function buildOpenApi(routes) {
  const paths = {};
  const tags = new Set();
  for (const route of routes) {
    const openPath = openApiPath(route.path);
    const tag = tagOf(route.path);
    tags.add(tag);
    const access = routeMinRole(route);
    const operation = {
      operationId: route.mcp || (route.method.toLowerCase() + route.path.replace(/[^A-Za-z0-9]+/g, '_')),
      summary: route.summary || route.path,
      tags: [tag],
      responses: {
        200: { description: '成功' },
        400: { description: '参数非法' },
        401: { description: '未登录或凭据失效' },
        403: { description: '权限不足、功能关闭或 Origin 不被允许' },
        404: { description: '资源不存在' },
        409: { description: '版本冲突（details.currentRevision 为当前版本）' },
        413: { description: '请求体超过上限' },
        422: { description: '无法处理（未知设置键、缺少 dryRun 等）' },
        428: { description: '缺少 revision（主题/草稿写操作）' },
      },
    };
    if (access !== 'public') {
      operation.security = [{ cookieAuth: [] }, { bearerAuth: [] }];
      operation['x-required-role'] = access;
    } else {
      operation.security = [];
    }
    const parameters = pathParams(route.path).map((name) => ({
      name, in: 'path', required: true, schema: { type: 'string' },
    }));
    if (QUERY_PARAMS[route.path]) parameters.push(...QUERY_PARAMS[route.path]);
    if (needsRevision(route)) {
      parameters.push({
        name: 'If-Match', in: 'header', required: false,
        description: '主题 revision，也可用 ?revision= 查询参数；写主题时必须提供',
        schema: { type: 'string' },
      });
      parameters.push({
        name: 'revision', in: 'query', required: false,
        description: 'If-Match 的替代写法', schema: { type: 'integer' },
      });
    }
    if (parameters.length) operation.parameters = parameters;
    if (!route.raw && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(route.method)) {
      operation.requestBody = {
        required: false,
        content: {
          'application/json': {
            schema: route.input || { type: 'object', additionalProperties: true },
          },
        },
      };
    }
    if (route.raw) {
      operation.responses[200] = { description: '成功（原始响应或文件）' };
    }
    paths[openPath] = paths[openPath] || {};
    paths[openPath][route.method.toLowerCase()] = operation;
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'ScreenScoreBoard API',
      version: APP_VERSION,
      description: '计分板 REST v1。所有写操作复用服务端 applyOp，并通过 WebSocket 广播最新状态。写接口需要 Cookie + X-CSRF-Token 或 Bearer API 令牌；公开读取见各 operation 的 security。',
    },
    servers: [{ url: '/' }],
    tags: [...tags].sort().map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        cookieAuth: {
          type: 'apiKey',
          in: 'cookie',
          name: 'ssb_session',
          description: '会话 Cookie；写请求还需 X-CSRF-Token。',
        },
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'API 令牌，格式 ssb_...；在「账号与安全 → API 令牌」创建。',
        },
      },
    },
  };
}

module.exports = { buildOpenApi, needsRevision };
