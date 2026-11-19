'use strict';
// HTTP MCP：POST /mcp，Streamable HTTP 的 JSON 子集（无状态 + 可选 session id）
const crypto = require('crypto');
const { send } = require('../static');
const { readJsonBody } = require('../api/responses');
const { isOriginAllowed } = require('../security');
const { logger } = require('../logger');
const { handleMessage } = require('./protocol');

const MAX_BODY = 4 * 1024 * 1024;

function json(res, status, body, extra = {}) {
  send(res, status, JSON.stringify(body), {
    'Content-Type': 'application/json; charset=utf-8',
    ...extra,
  });
}

async function handleMcpHttp(req, res) {
  if (req.method !== 'POST') {
    json(res, 405, {
      jsonrpc: '2.0', id: null,
      error: { code: -32600, message: 'MCP 只接受 POST' },
    }, { Allow: 'POST' });
    return true;
  }
  if (!isOriginAllowed(req.headers.origin, req.headers.host)) {
    json(res, 403, {
      jsonrpc: '2.0', id: null,
      error: { code: -32600, message: 'Origin 不被允许' },
    });
    return true;
  }
  let message;
  try {
    message = await readJsonBody(req, MAX_BODY);
  } catch (error) {
    json(res, 200, {
      jsonrpc: '2.0', id: null,
      error: { code: -32700, message: error.message || 'JSON 解析失败' },
    });
    return true;
  }
  const isInitialize = Boolean(message && !Array.isArray(message) && message.method === 'initialize');
  const headers = isInitialize ? { 'Mcp-Session-Id': crypto.randomBytes(16).toString('hex') } : {};
  try {
    if (Array.isArray(message)) {
      const results = [];
      for (const item of message) {
        const result = await handleMessage(item);
        if (result) results.push(result);
      }
      if (!results.length) {
        send(res, 202, '', headers);
        return true;
      }
      json(res, 200, results, headers);
      return true;
    }
    const result = await handleMessage(message);
    if (!result) {
      send(res, 202, '', headers);
      return true;
    }
    json(res, 200, result, headers);
  } catch (error) {
    logger.error('MCP HTTP 处理失败', { error: error.message });
    json(res, 200, {
      jsonrpc: '2.0',
      id: message && message.id != null ? message.id : null,
      error: { code: -32603, message: '内部错误' },
    }, headers);
  }
  return true;
}

module.exports = { handleMcpHttp };
