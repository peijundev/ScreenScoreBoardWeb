'use strict';
// 共享的 Origin 校验（WebSocket 与 MCP HTTP 复用）
const { config } = require('./config');

function isOriginAllowed(origin, host, allowedOrigins = config.broadcast.allowedOrigins) {
  if (!origin) return true; // 原生客户端通常不带 Origin
  let parsed = null;
  try {
    parsed = new URL(origin);
  } catch (_) {
    return false;
  }
  if (host && parsed.host === host) return true;
  return allowedOrigins.some((item) => {
    if (item === origin) return true;
    try { return new URL(item).host === parsed.host; } catch (_) { return false; }
  });
}

module.exports = { isOriginAllowed };
