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

function posInt(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    console.warn('[config] ' + name + ' 必须是正整数，已回退为 ' + fallback);
    return fallback;
  }
  return n;
}

function oneOf(name, fallback, allowed) {
  const raw = (process.env[name] || '').trim().toLowerCase();
  if (!raw) return fallback;
  if (allowed.includes(raw)) return raw;
  console.warn('[config] ' + name + ' 只能是 ' + allowed.join(' / ') + '，已回退为 ' + fallback);
  return fallback;
}

function load() {
  const cookieSecure = oneOf('COOKIE_SECURE', 'auto', ['auto', 'true', 'false']);
  const tlsCertFile = process.env.TLS_CERT_FILE || '';
  const tlsKeyFile = process.env.TLS_KEY_FILE || '';
  if (Boolean(tlsCertFile) !== Boolean(tlsKeyFile)) {
    throw new Error('TLS_CERT_FILE 与 TLS_KEY_FILE 必须同时设置');
  }
  return {
    host: process.env.HOST || '0.0.0.0',
    logLevel: process.env.LOG_LEVEL || 'info', // debug | info | warn | error
    logFormat: process.env.LOG_FORMAT || 'text', // text | json
    slowOpMs: num('SLOW_OP_MS', 100),
    shutdownFlushTimeoutMs: num('SHUTDOWN_FLUSH_TIMEOUT_MS', 10000),
    maxImportBytes: num('MAX_IMPORT_BYTES', 64 * 1024 * 1024),
    stateFilePretty: bool('STATE_FILE_PRETTY', false),
    allowMultiInstance: bool('ALLOW_MULTI_INSTANCE', false),
    auth: {
      adminUsername: process.env.ADMIN_USERNAME || 'admin',
      adminPassword: process.env.ADMIN_PASSWORD || '',
      adminPasswordFile: process.env.ADMIN_PASSWORD_FILE || '',
      sessionTtlHours: posInt('SESSION_TTL_HOURS', 24),
      sessionRememberDays: posInt('SESSION_REMEMBER_DAYS', 30),
      cookieSecure,
      trustProxy: bool('TRUST_PROXY', false),
    },
    tls: {
      certFile: tlsCertFile,
      keyFile: tlsKeyFile,
      passphrase: process.env.TLS_PASSPHRASE || '',
    },
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
