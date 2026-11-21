'use strict';
const APP_VERSION = require('../../../package.json').version;
const { publicState, getStorageKind, getStorageStatus } = require('../../state');
const { clientCount } = require('../../wss');
const runtime = require('../../runtime');
const { buildOpenApi } = require('../openapi');
const { effectiveHost, effectiveProtocol } = require('../../security');

function health() {
  return {
    ok: true,
    version: APP_VERSION,
    uptimeSec: Math.round(process.uptime()),
    storage: getStorageKind(),
    storageOk: !getStorageStatus().conflict,
    wsClients: clientCount(),
    projects: Object.keys(publicState().projects).length,
    ts: Date.now(),
  };
}

function createSystemRoutes(getRoutes) {
  return [
    {
      method: 'GET', path: '/health', mcp: 'get_health', summary: '健康状态',
      handler: () => ({ data: health() }),
    },
    {
      method: 'GET', path: '/version', mcp: 'get_version', summary: '版本信息',
      handler: () => ({
        data: { version: APP_VERSION, finalForTechStack: '1.4.0', frontend: 'react-v2' },
      }),
    },
    {
      method: 'GET', path: '/state', mcp: 'get_state', summary: '读取全量热状态',
      handler: () => ({ data: { ...publicState(), runtime: runtime.getRuntimeSnapshot() } }),
    },
    {
      method: 'GET', path: '/runtime', mcp: 'get_all_runtime', summary: '读取全部项目运行态',
      handler: () => ({ data: runtime.getRuntimeSnapshot() }),
    },
    {
      method: 'GET', path: '/endpoints', mcp: 'get_endpoints', summary: '发现 REST 与 MCP 端点',
      handler: (ctx) => {
        const host = effectiveHost(ctx.req);
        const origin = host ? effectiveProtocol(ctx.req) + '://' + host : '';
        return {
          data: {
            rest: '/api/v1',
            mcp: '/mcp',
            openapi: '/api/v1/openapi.json',
            absolute: origin ? { rest: origin + '/api/v1', mcp: origin + '/mcp' } : undefined,
          },
        };
      },
    },
    {
      method: 'GET', path: '/openapi.json', mcp: false, summary: 'OpenAPI 3.1 描述', raw: true,
      handler: (ctx) => {
        const body = JSON.stringify(buildOpenApi(getRoutes()), null, 2);
        ctx.res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        ctx.res.end(body);
      },
    },
  ];
}

module.exports = { createSystemRoutes, health };
