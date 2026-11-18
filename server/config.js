'use strict';
// 集中解析环境变量：所有后端可调参数的唯一来源

function num(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name, fallback) {
  const v = process.env[name];
  if (v == null || v === '') return fallback;
  return v !== '0' && String(v).toLowerCase() !== 'false';
}

function load() {
  return {
    host: process.env.HOST || '0.0.0.0',
    logLevel: process.env.LOG_LEVEL || 'info', // debug | info | warn | error
    logFormat: process.env.LOG_FORMAT || 'text', // text | json
    slowOpMs: num('SLOW_OP_MS', 100),
    shutdownFlushTimeoutMs: num('SHUTDOWN_FLUSH_TIMEOUT_MS', 10000),
    maxImportBytes: num('MAX_IMPORT_BYTES', 64 * 1024 * 1024),
    stateFilePretty: bool('STATE_FILE_PRETTY', false),
    allowMultiInstance: bool('ALLOW_MULTI_INSTANCE', false),
    broadcast: {
      coalesceMs: num('BROADCAST_COALESCE_MS', 50),
      largeCoalesceMs: num('BROADCAST_LARGE_COALESCE_MS', 250),
      largeBytes: num('BROADCAST_LARGE_BYTES', 150 * 1024),
      maxBufferedBytes: num('WS_MAX_BUFFERED_BYTES', 1024 * 1024),
      maxConnections: num('WS_MAX_CONNECTIONS', 200),
      permessageDeflate: bool('WS_PERMESSAGE_DEFLATE', true),
      deflateThreshold: num('WS_DEFLATE_THRESHOLD', 1024),
      allowedOrigins: (process.env.ALLOWED_ORIGINS || '')
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean),
    },
  };
}

const config = load();

module.exports = { load, config, num, bool };
