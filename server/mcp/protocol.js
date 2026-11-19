'use strict';
// 最小 MCP JSON-RPC 2.0 核心：initialize / tools / resources / ping
const { tools, callToolInProcess } = require('./tools');
const { state, publicState, getTheme, getThemeDraft } = require('../state');
const runtime = require('../runtime');

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_NAME = 'screenscoreboard';
const APP_VERSION = require('../../package.json').version;

function textContent(value, isError) {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
    isError: Boolean(isError),
  };
}

function resourceList() {
  return [
    { uri: 'scoreboard://state', name: '全量状态', mimeType: 'application/json' },
    { uri: 'scoreboard://health', name: '健康状态', mimeType: 'application/json' },
    { uri: 'scoreboard://project/{projectId}', name: '项目详情', mimeType: 'application/json' },
    { uri: 'scoreboard://theme/{themeId}', name: '主题详情', mimeType: 'application/json' },
    { uri: 'scoreboard://theme-draft/{projectId}', name: '项目主题草稿', mimeType: 'application/json' },
  ];
}

function readResource(uri) {
  if (uri === 'scoreboard://state') {
    return { ...publicState(), runtime: runtime.getRuntimeSnapshot() };
  }
  if (uri === 'scoreboard://health') {
    return {
      ok: true,
      version: APP_VERSION,
      uptimeSec: Math.round(process.uptime()),
      projects: Object.keys(state.projects).length,
      ts: Date.now(),
    };
  }
  const projectMatch = /^scoreboard:\/\/project\/([^/]+)$/.exec(uri);
  if (projectMatch) {
    const project = state.projects[projectMatch[1]];
    if (!project) throw new Error('项目不存在');
    return project;
  }
  const themeMatch = /^scoreboard:\/\/theme\/([^/]+)$/.exec(uri);
  if (themeMatch) return getTheme(themeMatch[1]);
  const draftMatch = /^scoreboard:\/\/theme-draft\/([^/]+)$/.exec(uri);
  if (draftMatch) {
    if (!state.projects[draftMatch[1]]) throw new Error('项目不存在');
    return getThemeDraft(draftMatch[1]);
  }
  throw new Error('未知资源: ' + uri);
}

function rpcError(id, code, message, data) {
  return { jsonrpc: '2.0', id: id == null ? null : id, error: { code, message, data } };
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

async function handleMessage(message, options = {}) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return rpcError(null, -32600, '非法请求');
  }
  const callTool = options.callTool || callToolInProcess;
  const readResourceFn = options.readResource || readResource;
  const { id, method, params } = message;
  const isNotification = id === undefined || id === null;
  try {
    if (method === 'initialize') {
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false }, resources: { subscribe: false } },
        serverInfo: { name: SERVER_NAME, version: APP_VERSION },
      });
    }
    if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
      return null;
    }
    if (method === 'ping') return rpcResult(id, {});
    if (method === 'tools/list') return rpcResult(id, { tools: tools.map(({ route, ...tool }) => tool) });
    if (method === 'tools/call') {
      const name = params && params.name;
      const args = (params && (params.arguments || params.args)) || {};
      if (!name) return rpcError(id, -32602, '缺少工具名');
      try {
        const result = await callTool(name, args);
        return rpcResult(id, textContent(result));
      } catch (error) {
        return rpcResult(id, textContent(error.message || '工具执行失败', true));
      }
    }
    if (method === 'resources/list') {
      return rpcResult(id, { resources: resourceList() });
    }
    if (method === 'resources/read') {
      const uri = params && params.uri;
      if (!uri) return rpcError(id, -32602, '缺少资源 URI');
      try {
        const value = await readResourceFn(uri);
        return rpcResult(id, {
          contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(value, null, 2) }],
        });
      } catch (error) {
        return rpcError(id, -32602, error.message);
      }
    }
    if (isNotification) return null;
    return rpcError(id, -32601, '方法不存在: ' + method);
  } catch (error) {
    return rpcError(id, -32603, error.message || '内部错误');
  }
}

module.exports = {
  PROTOCOL_VERSION,
  SERVER_NAME,
  handleMessage,
  resourceList,
  readResource,
};
