'use strict';
// MCP 工具表：从 REST v1 路由表派生，保证 HTTP API 与 AI 工具不漂移
const { listRoutes } = require('../api');
const { needsRevision } = require('../api/openapi');

const TOOL_INPUTS = {
  create_project: { name: { type: 'string', minLength: 1, maxLength: 30 } },
  rename_project: { projectId: { type: 'string' }, name: { type: 'string', minLength: 1, maxLength: 30 } },
  delete_project: { projectId: { type: 'string' } },
  list_people: {
    projectId: { type: 'string' }, q: { type: 'string' },
    teamId: { type: ['string', 'null'] }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1 },
  },
  add_person: {
    projectId: { type: 'string' }, name: { type: 'string', minLength: 1, maxLength: 20 },
    avatar: { type: ['string', 'null'] }, cardImage: { type: ['string', 'null'] },
    bio: { type: 'string', maxLength: 60 }, teamId: { type: ['string', 'null'] },
  },
  update_person: {
    projectId: { type: 'string' }, personId: { type: 'string' },
    name: { type: 'string', minLength: 1, maxLength: 20 },
    avatar: { type: ['string', 'null'] }, cardImage: { type: ['string', 'null'] },
    bio: { type: 'string', maxLength: 60 }, teamId: { type: ['string', 'null'] },
  },
  remove_person: { projectId: { type: 'string' }, personId: { type: 'string' } },
  add_score: { projectId: { type: 'string' }, personId: { type: 'string' }, delta: { type: 'number' } },
  set_score: { projectId: { type: 'string' }, personId: { type: 'string' }, score: { type: 'number' } },
  add_team_score: { projectId: { type: 'string' }, teamId: { type: 'string' }, delta: { type: 'number' } },
  reset_scores: { projectId: { type: 'string' } },
  update_settings: { projectId: { type: 'string' }, patch: { type: 'object', additionalProperties: true } },
  start_countdown: { projectId: { type: 'string' }, durationSec: { type: 'integer', minimum: 1, maximum: 3600 } },
  pause_countdown: { projectId: { type: 'string' } },
  resume_countdown: { projectId: { type: 'string' } },
  reset_countdown: { projectId: { type: 'string' } },
  undo_score: { projectId: { type: 'string' } },
  undo_to: { projectId: { type: 'string' }, keep: { type: 'integer', minimum: 0, maximum: 50 } },
  update_theme: { themeId: { type: 'string' }, theme: { type: 'object' }, revision: { type: 'integer', minimum: 1 } },
  update_theme_layers: { themeId: { type: 'string' }, layers: { type: 'array' }, revision: { type: 'integer', minimum: 1 } },
  update_theme_widgets: { themeId: { type: 'string' }, widgets: { type: 'array' }, revision: { type: 'integer', minimum: 1 } },
  update_theme_settings: { themeId: { type: 'string' }, settings: { type: 'object' }, revision: { type: 'integer', minimum: 1 } },
  update_theme_script: { themeId: { type: 'string' }, script: { type: 'object' }, revision: { type: 'integer', minimum: 1 } },
  apply_theme: { themeId: { type: 'string' }, projectId: { type: 'string' }, revision: { type: 'integer', minimum: 1 } },
  save_theme_draft: { projectId: { type: 'string' }, theme: { type: 'object' }, revision: { type: 'integer', minimum: 0 } },
  call_op: {
    projectId: { type: 'string' }, op: { type: 'string' },
    payload: { type: 'object', additionalProperties: true },
  },
  call_project_op: { op: { type: 'string' }, payload: { type: 'object', additionalProperties: true } },
};

function pathParams(pathPattern) {
  return pathPattern.split('/').filter((part) => part.startsWith(':')).map((part) => part.slice(1));
}

function schemaFor(route) {
  const properties = {};
  const required = [];
  const override = TOOL_INPUTS[route.mcp] || {};
  for (const [key, schema] of Object.entries(override)) {
    properties[key] = schema;
    if (route.path.includes(':' + key) || ['projectId', 'personId', 'teamId', 'themeId'].includes(key)) {
      if (route.path.includes(':' + key)) required.push(key);
    }
  }
  for (const param of pathParams(route.path)) {
    if (!properties[param]) properties[param] = { type: 'string' };
    if (!required.includes(param)) required.push(param);
  }
  if (needsRevision(route) && !properties.revision) {
    properties.revision = { type: 'integer', minimum: 1, description: '主题当前 revision（乐观并发）' };
  }
  if (!Object.keys(override).length) {
    properties.payload = {
      type: 'object', additionalProperties: true,
      description: '请求体字段；也可直接展开为工具参数',
    };
  }
  return {
    type: 'object',
    properties,
    required: [...new Set(required)],
    additionalProperties: true,
  };
}

function buildTools() {
  return listRoutes()
    .filter((route) => route.mcp && !route.raw)
    .map((route) => {
      const destructive = route.destructive ? '【破坏性操作，执行前请确认】' : '';
      return {
        name: route.mcp,
        description: `${destructive}${route.summary || route.path}（${route.method} ${route.path}）`,
        inputSchema: schemaFor(route),
        route,
        mutates: Boolean(route.mutates),
        destructive: Boolean(route.destructive),
      };
    });
}

const tools = buildTools();
const toolMap = new Map(tools.map((tool) => [tool.name, tool]));

function stripArgs(args, route) {
  const body = { ...(args || {}) };
  for (const param of pathParams(route.path)) delete body[param];
  delete body.revision;
  // 自动生成的工具用 payload 承载请求体；低层 op 工具保留 payload 原样
  if (body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload) &&
    route.mcp !== 'call_op' && route.mcp !== 'call_project_op') {
    Object.assign(body, body.payload);
    delete body.payload;
  }
  return body;
}

function makeParams(tool, args) {
  const params = {};
  for (const param of pathParams(tool.route.path)) {
    if (args[param] == null) throw new Error(`缺少参数 ${param}`);
    params[param] = String(args[param]);
  }
  return params;
}

/** 进程内调用：HTTP MCP 与测试使用，直接走资源层 */
async function callToolInProcess(name, args) {
  const tool = toolMap.get(name);
  if (!tool) throw new Error('未知工具: ' + name);
  const params = makeParams(tool, args || {});
  const body = stripArgs(args, tool.route);
  const ctx = {
    req: { headers: args && args.revision != null ? { 'if-match': `"${args.revision}"` } : {} },
    res: null,
    params,
    query: { ...body, ...(args && args.revision != null ? { revision: String(args.revision) } : {}) },
    body,
    requestId: 'mcp',
  };
  const result = await tool.route.handler(ctx);
  if (!result || result.data === undefined) throw new Error('工具没有返回数据');
  return result.data;
}

/** stdio 调用：通过 REST 访问已运行的服务 */
async function callToolRemote(baseUrl, name, args) {
  const tool = toolMap.get(name);
  if (!tool) throw new Error('未知工具: ' + name);
  const params = makeParams(tool, args || {});
  let path = tool.route.path;
  for (const [key, value] of Object.entries(params)) {
    path = path.replace(':' + key, encodeURIComponent(value));
  }
  const body = stripArgs(args, tool.route);
  const query = new URLSearchParams();
  if (args && args.revision != null) query.set('revision', String(args.revision));
  for (const key of ['q', 'teamId', 'offset', 'limit', 'scope', 'assets']) {
    if (args && args[key] != null && tool.route.method === 'GET') query.set(key, String(args[key]));
  }
  const url = baseUrl.replace(/\/$/, '') + '/api/v1' + path + (query.toString() ? '?' + query.toString() : '');
  const headers = { Accept: 'application/json' };
  const init = { method: tool.route.method, headers };
  if (args && args.revision != null) headers['If-Match'] = `"${args.revision}"`;
  if (tool.route.method !== 'GET' && tool.route.method !== 'DELETE') {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  } else if (tool.route.method === 'DELETE' && Object.keys(body).length) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch (_) { /* 非 JSON 响应 */ }
  if (!res.ok) {
    const message = parsed && parsed.error ? parsed.error.message : `HTTP ${res.status}`;
    throw new Error(message);
  }
  return parsed ? parsed.data : null;
}

module.exports = {
  tools,
  toolMap,
  buildTools,
  schemaFor,
  callToolInProcess,
  callToolRemote,
  pathParams,
};
