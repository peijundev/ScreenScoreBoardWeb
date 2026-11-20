'use strict';
// 共享的 Origin 校验（WebSocket 与 MCP HTTP 复用）
const { config } = require('./config');

function isLoopbackAddress(addr) {
  if (!addr) return false;
  const value = String(addr);
  return value === '::1' || value === '::ffff:127.0.0.1' || value.startsWith('127.');
}

function isLoopbackHost(host) {
  const value = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return value === 'localhost' || value === '::1' || value.startsWith('127.');
}

function hasForwardingHeaders(req) {
  return Boolean(
    req.headers['x-forwarded-for'] ||
      req.headers['x-real-ip'] ||
      req.headers.forwarded,
  );
}

function effectiveProtocol(req) {
  if (req.socket && req.socket.encrypted) return 'https';
  if (config.auth.trustProxy) {
    const value = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    if (value === 'https' || value === 'http') return value;
  }
  return 'http';
}

function effectiveHost(req) {
  if (config.auth.trustProxy) {
    const value = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
    if (value) return value;
  }
  return req.headers.host;
}

function effectiveClientIp(req) {
  if (config.auth.trustProxy) {
    const value = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (value) return value;
  }
  return (req.socket && req.socket.remoteAddress) || '';
}

/** 只有「直接来自 loopback、且没有任何转发头」的请求才算本机请求 */
function isDirectLoopbackRequest(req) {
  return isLoopbackAddress(req.socket && req.socket.remoteAddress) && !hasForwardingHeaders(req);
}

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

module.exports = {
  isOriginAllowed,
  isLoopbackAddress,
  isLoopbackHost,
  hasForwardingHeaders,
  effectiveProtocol,
  effectiveHost,
  effectiveClientIp,
  isDirectLoopbackRequest,
};
