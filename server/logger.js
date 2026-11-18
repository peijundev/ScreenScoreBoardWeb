'use strict';
// 零依赖结构化日志：text / json 两种输出，支持 child 字段与敏感字段脱敏
const { config } = require('./config');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const REDACT_KEYS = new Set(['token', 'authorization', 'password', 'secret']);

function sanitize(fields) {
  if (!fields || typeof fields !== 'object') return fields;
  const out = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = REDACT_KEYS.has(key.toLowerCase()) ? '***' : value;
  }
  return out;
}

function createLogger(opts = {}) {
  const level = LEVELS[opts.level] ?? LEVELS.info;
  const format = opts.format || 'text';
  const base = opts.base || {};

  function emit(lvl, msg, fields) {
    if (LEVELS[lvl] < level) return;
    const rec = { ts: new Date().toISOString(), level: lvl, msg, ...base, ...sanitize(fields) };
    const line =
      format === 'json'
        ? JSON.stringify(rec)
        : '[' + rec.ts + '] ' + lvl.toUpperCase() + ' ' + msg +
          Object.entries({ ...base, ...sanitize(fields) })
            .map(([k, v]) => ' ' + k + '=' + (typeof v === 'object' ? JSON.stringify(v) : String(v)))
            .join('');
    (LEVELS[lvl] >= LEVELS.warn ? process.stderr : process.stdout).write(line + '\n');
  }

  const logger = {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    child: (fields) => createLogger({ level: opts.level, format, base: { ...base, ...fields } }),
  };
  return logger;
}

const logger = createLogger({ level: config.logLevel, format: config.logFormat });

module.exports = { createLogger, logger };
