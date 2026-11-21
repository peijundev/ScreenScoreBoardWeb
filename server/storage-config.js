'use strict';
// 存储配置：DATA_DIR/storage.json 的读写、校验、脱敏与来源优先级。
// 该配置独立于 DEFAULT_SETTINGS，绝不进入状态快照或广播。
const fs = require('fs');
const path = require('path');
const { DATA_DIR, STORAGE_CONFIG_FILE } = require('./paths');
const { logger } = require('./logger');
const { StorageConfigError, sha256, canonicalJSON } = require('./storage/common');
const { canonicalKind, KINDS } = require('./storage/registry');

const CONFIG_VERSION = 1;

const RESERVED_FILES = new Set([
  'storage.json', 'auth.json', 'sessions.json', 'scoreboard.lock',
]);
const RESERVED_DIRS = new Set(['backups', 'avatars', 'sounds']);
const IDENTIFIER_RE = /^[A-Za-z0-9_.:-]+$/;

/** @param {string} text */
function hasControlChars(text) {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * @typedef {Object} FieldSpec
 * @property {string} name
 * @property {'string'|'password'|'number'|'boolean'|'select'} type
 * @property {string} label
 * @property {any} [default]
 * @property {number} [min]
 * @property {number} [max]
 * @property {number} [maxLength]
 * @property {boolean} [secret]
 * @property {boolean} [secretUrl]
 * @property {boolean} [file]
 * @property {string[]} [extensions]
 * @property {string} [pattern]
 * @property {string} [placeholder]
 * @property {string} [help]
 * @property {Array<{ value: string, label: string }>} [options]
 */

/**
 * @typedef {Object} BackendDef
 * @property {string} label
 * @property {'file'|'database'} category
 * @property {string} description
 * @property {boolean} [recommended]
 * @property {string} [recommendedNote]
 * @property {string[]} envKeys
 * @property {FieldSpec[]} fields
 * @property {string[][]} [requireOneOf]
 */

/** @type {Record<string, FieldSpec[]>} */
const FILE_FIELDS = {
  json: [
    { name: 'file', type: 'string', label: '文件名', default: 'state.json', file: true, extensions: ['.json'], placeholder: 'state.json', help: '相对 DATA_DIR，只允许 DATA_DIR 内路径' },
    { name: 'pretty', type: 'boolean', label: '缩进输出', default: false, help: '便于人工查看，文件会更大' },
  ],
  txt: [
    { name: 'file', type: 'string', label: '文件名', default: 'state.txt', file: true, extensions: ['.txt'], placeholder: 'state.txt', help: '始终输出缩进 JSON，便于人工阅读' },
  ],
  sqlite: [
    { name: 'file', type: 'string', label: '数据库文件', default: 'scoreboard.db', file: true, extensions: ['.db', '.sqlite', '.sqlite3'], placeholder: 'scoreboard.db' },
    { name: 'busyTimeoutMs', type: 'number', label: '忙等超时 (ms)', default: 5000, min: 1000, max: 30000 },
  ],
};

/** @type {FieldSpec[]} */
const SQL_FIELDS = [
  { name: 'url', type: 'string', label: '连接 URL', secretUrl: true, maxLength: 2048, placeholder: 'postgres://user:pass@host:5432/scoreboard' },
  { name: 'host', type: 'string', label: '主机', maxLength: 255 },
  { name: 'port', type: 'number', label: '端口', min: 1, max: 65535 },
  { name: 'user', type: 'string', label: '用户名', maxLength: 128 },
  { name: 'password', type: 'password', label: '密码', secret: true, maxLength: 512 },
  { name: 'database', type: 'string', label: '数据库', maxLength: 128, pattern: IDENTIFIER_RE.source },
  { name: 'ssl', type: 'boolean', label: 'SSL', default: false },
  { name: 'connectTimeoutMs', type: 'number', label: '连接超时 (ms)', default: 5000, min: 1000, max: 120000 },
  { name: 'requestTimeoutMs', type: 'number', label: '请求超时 (ms)', default: 15000, min: 1000, max: 120000 },
  { name: 'maxPool', type: 'number', label: '连接池上限', default: 5, min: 1, max: 20 },
];

/** @type {Record<string, BackendDef>} */
const BACKEND_DEFS = {
  json: {
    label: 'JSON 文件',
    category: 'file',
    description: '默认后端。整份状态写入单个 JSON 文件，兼容旧数据目录。',
    envKeys: ['STORAGE', 'STATE_FILE', 'STATE_FILE_PRETTY'],
    fields: FILE_FIELDS.json,
  },
  txt: {
    label: 'TXT 纯文本',
    category: 'file',
    description: '把整份状态以缩进 JSON 写入 .txt，便于人工查看和手工编辑。',
    envKeys: ['STORAGE', 'STATE_TXT_FILE'],
    fields: FILE_FIELDS.txt,
  },
  sqlite: {
    label: 'SQLite',
    category: 'file',
    description: '单机数据库，无需外部服务；WAL 模式，适合桌面和单机部署。',
    envKeys: ['STORAGE', 'SQLITE_FILE', 'SQLITE_BUSY_TIMEOUT_MS'],
    fields: FILE_FIELDS.sqlite,
  },
  postgres: {
    label: 'PostgreSQL',
    category: 'database',
    description: '稳妥的关系型数据库选择；支持跨主机咨询锁与乐观并发。',
    envKeys: ['STORAGE', 'DATABASE_URL', 'PG_CONNECT_TIMEOUT_MS'],
    fields: SQL_FIELDS,
    requireOneOf: [['url'], ['host', 'database']],
  },
  mysql: {
    label: 'MySQL / MariaDB',
    category: 'database',
    description: '关系型数据库；支持 GET_LOCK 与乐观并发。',
    envKeys: ['STORAGE', 'MYSQL_URL', 'MYSQL_HOST', 'MYSQL_PORT', 'MYSQL_USER', 'MYSQL_PASSWORD', 'MYSQL_DATABASE'],
    fields: SQL_FIELDS,
    requireOneOf: [['url'], ['host', 'database']],
  },
  mongodb: {
    label: 'MongoDB',
    category: 'database',
    description: '文档数据库；单文档上限 16MB，适合中小状态。暂不支持跨主机锁。',
    envKeys: ['STORAGE', 'MONGODB_URL', 'MONGO_URL', 'MONGODB_DB'],
    fields: [
      { name: 'url', type: 'string', label: '连接 URL', secretUrl: true, maxLength: 2048, placeholder: 'mongodb://user:pass@host:27017/scoreboard' },
      { name: 'host', type: 'string', label: '主机', maxLength: 255 },
      { name: 'port', type: 'number', label: '端口', min: 1, max: 65535 },
      { name: 'user', type: 'string', label: '用户名', maxLength: 128 },
      { name: 'password', type: 'password', label: '密码', secret: true, maxLength: 512 },
      { name: 'database', type: 'string', label: '数据库', maxLength: 128, pattern: IDENTIFIER_RE.source },
      { name: 'authSource', type: 'string', label: '认证库', maxLength: 128, pattern: IDENTIFIER_RE.source },
      { name: 'collection', type: 'string', label: '集合名', default: 'scoreboard_state', maxLength: 64, pattern: IDENTIFIER_RE.source },
      { name: 'tls', type: 'boolean', label: 'TLS', default: false },
      { name: 'serverSelectionTimeoutMs', type: 'number', label: '选主超时 (ms)', default: 5000, min: 1000, max: 120000 },
      { name: 'connectTimeoutMs', type: 'number', label: '连接超时 (ms)', default: 5000, min: 1000, max: 120000 },
      { name: 'maxPool', type: 'number', label: '连接池上限', default: 5, min: 1, max: 20 },
    ],
    requireOneOf: [['url'], ['host', 'database']],
  },
  sqlserver: {
    label: 'SQL Server',
    category: 'database',
    description: 'Microsoft SQL Server；使用纯 JS 的 mssql/tedious 驱动。暂不支持跨主机锁。',
    envKeys: ['STORAGE', 'MSSQL_URL', 'MSSQL_SERVER', 'MSSQL_PORT', 'MSSQL_USER', 'MSSQL_PASSWORD', 'MSSQL_DATABASE'],
    fields: [
      { name: 'url', type: 'string', label: '连接 URL', secretUrl: true, maxLength: 2048, placeholder: 'mssql://user:pass@host:1433/scoreboard' },
      { name: 'server', type: 'string', label: '服务器', maxLength: 255 },
      { name: 'port', type: 'number', label: '端口', default: 1433, min: 1, max: 65535 },
      { name: 'database', type: 'string', label: '数据库', maxLength: 128, pattern: IDENTIFIER_RE.source },
      { name: 'user', type: 'string', label: '用户名', maxLength: 128 },
      { name: 'password', type: 'password', label: '密码', secret: true, maxLength: 512 },
      { name: 'instanceName', type: 'string', label: '实例名', maxLength: 128 },
      { name: 'encrypt', type: 'boolean', label: '加密连接', default: true },
      { name: 'trustServerCertificate', type: 'boolean', label: '信任服务器证书', default: false },
      { name: 'connectTimeoutMs', type: 'number', label: '连接超时 (ms)', default: 5000, min: 1000, max: 120000 },
      { name: 'requestTimeoutMs', type: 'number', label: '请求超时 (ms)', default: 15000, min: 1000, max: 120000 },
      { name: 'maxPool', type: 'number', label: '连接池上限', default: 5, min: 1, max: 20 },
    ],
    requireOneOf: [['url'], ['server', 'database']],
  },
  oracle: {
    label: 'Oracle（Thin）',
    category: 'database',
    description: '使用 oracledb Thin 模式，无需 Instant Client。暂不支持跨主机锁。',
    envKeys: ['STORAGE', 'ORACLE_URL', 'ORACLE_CONNECT_STRING', 'ORACLE_USER', 'ORACLE_PASSWORD'],
    fields: [
      { name: 'url', type: 'string', label: '连接 URL', secretUrl: true, maxLength: 2048, placeholder: 'oracle://user:pass@host:1521/service' },
      { name: 'connectString', type: 'string', label: '连接串', maxLength: 512, placeholder: 'host:1521/service' },
      { name: 'host', type: 'string', label: '主机', maxLength: 255 },
      { name: 'port', type: 'number', label: '端口', default: 1521, min: 1, max: 65535 },
      { name: 'serviceName', type: 'string', label: '服务名', maxLength: 128, pattern: IDENTIFIER_RE.source },
      { name: 'user', type: 'string', label: '用户名', maxLength: 128 },
      { name: 'password', type: 'password', label: '密码', secret: true, maxLength: 512 },
      { name: 'connectTimeoutMs', type: 'number', label: '连接超时 (ms)', default: 5000, min: 1000, max: 120000 },
      { name: 'requestTimeoutMs', type: 'number', label: '请求超时 (ms)', default: 15000, min: 1000, max: 120000 },
      { name: 'poolMax', type: 'number', label: '连接池上限', default: 4, min: 1, max: 20 },
    ],
    requireOneOf: [['url'], ['connectString'], ['host', 'serviceName']],
  },
  redis: {
    label: 'Redis',
    category: 'database',
    description: '低延迟、支持跨主机锁。作为权威存储必须开启 AOF 且禁止淘汰。',
    recommended: true,
    recommendedNote: '多实例/低延迟推荐；必须 appendonly yes + maxmemory-policy noeviction',
    envKeys: ['STORAGE', 'REDIS_URL', 'REDIS_HOST', 'REDIS_PORT', 'REDIS_PASSWORD'],
    fields: [
      { name: 'url', type: 'string', label: '连接 URL', secretUrl: true, maxLength: 2048, placeholder: 'redis://user:pass@host:6379/0' },
      { name: 'host', type: 'string', label: '主机', maxLength: 255 },
      { name: 'port', type: 'number', label: '端口', default: 6379, min: 1, max: 65535 },
      { name: 'db', type: 'number', label: '数据库编号', default: 0, min: 0, max: 15 },
      { name: 'user', type: 'string', label: '用户名', maxLength: 128 },
      { name: 'password', type: 'password', label: '密码', secret: true, maxLength: 512 },
      { name: 'tls', type: 'boolean', label: 'TLS', default: false },
      { name: 'keyPrefix', type: 'string', label: 'Key 前缀', default: 'scoreboard', maxLength: 40, pattern: IDENTIFIER_RE.source },
      { name: 'connectTimeoutMs', type: 'number', label: '连接超时 (ms)', default: 5000, min: 1000, max: 120000 },
      { name: 'commandTimeoutMs', type: 'number', label: '命令超时 (ms)', default: 15000, min: 1000, max: 120000 },
      { name: 'lockTtlMs', type: 'number', label: '锁 TTL (ms)', default: 30000, min: 5000, max: 120000 },
      { name: 'lockRenewMs', type: 'number', label: '锁续租间隔 (ms)', default: 10000, min: 1000, max: 60000 },
    ],
  },
};

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asConfigError(message, details) {
  throw new StorageConfigError(message, details);
}

function isTruthy(raw) {
  if (raw == null || raw === '') return false;
  return raw !== '0' && String(raw).toLowerCase() !== 'false';
}

function positiveInt(raw, fallback) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function configPathOf(dataDir) {
  return path.join(dataDir || DATA_DIR, 'storage.json');
}

/**
 * @param {string} kind
 * @param {string} [dataDir]
 */
function backendDef(kind, dataDir) {
  void dataDir;
  const def = BACKEND_DEFS[kind];
  if (!def) asConfigError(`未知的存储后端：${kind}`);
  return def;
}

/**
 * @param {string} value
 * @returns {string}
 */
function redactUrlPassword(value) {
  return String(value).replace(/(^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/@]*):[^/@]*@/, '$1:***@');
}

/** @param {string} value */
function urlHasPassword(value) {
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/@]*:[^/@]*@/.test(String(value || ''));
}

/** @param {string} value */
function stripUrlPassword(value) {
  return String(value).replace(/(^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/@]*):[^/@]*@/, '$1@');
}

/**
 * @param {string} targetUrl
 * @param {string} sourceUrl
 */
function copyUrlPassword(targetUrl, sourceUrl) {
  const match = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/@]*)@/.exec(String(sourceUrl || ''));
  if (!match) return targetUrl;
  const userInfo = match[2];
  const colon = userInfo.indexOf(':');
  if (colon < 0) return targetUrl;
  const password = userInfo.slice(colon + 1);
  const replaced = String(targetUrl).replace(
    /^([A-Za-z][A-Za-z0-9+.-]*:\/\/[^/@]*?):\*\*\*@/,
    `$1:${password}@`,
  );
  if (replaced !== targetUrl) return replaced;
  return String(targetUrl).replace(
    /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/@]*)@/,
    `$1$2:${password}@`,
  );
}

/** @param {any} value */
function safeUrl(value) {
  try {
    return new URL(String(value));
  } catch (_) {
    return null;
  }
}

/**
 * @param {string} kind
 * @param {Record<string, any>} options
 */
function connectionTarget(kind, options) {
  const parsed = options.url ? safeUrl(options.url) : null;
  return {
    kind,
    host: String(options.host || (parsed && parsed.hostname) || ''),
    port: String(options.port || (parsed && parsed.port) || ''),
    user: String(options.user || (parsed && parsed.username) || ''),
    database: String(options.database || (parsed && parsed.pathname.replace(/^\//, '')) || ''),
    server: String(options.server || ''),
    instance: String(options.instanceName || ''),
    service: String(options.serviceName || ''),
    authSource: String(options.authSource || ''),
  };
}

/**
 * @param {string} kind
 * @param {Record<string, any>} a
 * @param {Record<string, any>} b
 */
function sameConnectionTarget(kind, a, b) {
  return canonicalJSON(connectionTarget(kind, a)) === canonicalJSON(connectionTarget(kind, b));
}

/**
 * @param {string} value
 * @param {string[]} extensions
 * @param {string} dataDir
 */
function assertSafeFile(value, extensions, dataDir) {
  if (hasControlChars(value)) asConfigError('文件路径包含非法控制字符');
  if (path.isAbsolute(value)) asConfigError('文件路径必须是 DATA_DIR 内的相对路径');
  const parts = value.split(/[\\/]+/).filter(Boolean);
  if (!parts.length) asConfigError('文件路径不能为空');
  if (parts.some((part) => part === '..')) asConfigError('文件路径不能包含 ..');
  const root = path.resolve(dataDir);
  const resolved = path.resolve(root, value);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    asConfigError('文件路径必须位于 DATA_DIR 内');
  }
  const base = path.basename(resolved).toLowerCase();
  if (RESERVED_FILES.has(base)) asConfigError(`不能使用保留文件名：${base}`);
  if (parts.some((part) => RESERVED_DIRS.has(part.toLowerCase()))) {
    asConfigError('不能把状态文件放进保留目录（backups/avatars/sounds）');
  }
  if (extensions && extensions.length && !extensions.some((ext) => base.endsWith(ext))) {
    asConfigError(`文件扩展名必须是 ${extensions.join(' / ')}`);
  }
  if (fs.existsSync(resolved)) {
    try {
      const real = fs.realpathSync(resolved);
      if (real !== root && !real.startsWith(root + path.sep)) {
        asConfigError('文件路径不能是 DATA_DIR 之外的符号链接');
      }
    } catch (_) {
      asConfigError('无法解析文件路径');
    }
  }
}

/**
 * @param {FieldSpec} spec
 * @param {any} value
 * @param {{ kind: string, source: string, dataDir: string }} ctx
 */
function validateField(spec, value, ctx) {
  if (spec.type === 'boolean') {
    if (typeof value !== 'boolean') asConfigError(`${spec.label}必须是布尔值`);
    return value;
  }
  if (spec.type === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n) || !Number.isInteger(n)) asConfigError(`${spec.label}必须是整数`);
    if (spec.min != null && n < spec.min) asConfigError(`${spec.label}不能小于 ${spec.min}`);
    if (spec.max != null && n > spec.max) asConfigError(`${spec.label}不能大于 ${spec.max}`);
    return n;
  }
  if (typeof value !== 'string') asConfigError(`${spec.label}必须是字符串`);
  const text = spec.type === 'password' ? value : value.trim();
  if (hasControlChars(text)) asConfigError(`${spec.label}包含非法控制字符`);
  if (spec.maxLength && text.length > spec.maxLength) {
    asConfigError(`${spec.label}不能超过 ${spec.maxLength} 个字符`);
  }
  if (spec.pattern && text && !new RegExp('^' + spec.pattern + '$').test(text)) {
    asConfigError(`${spec.label}包含非法字符`);
  }
  if (spec.file && ctx.source !== 'env') {
    assertSafeFile(text, spec.extensions || [], ctx.dataDir);
  }
  if (spec.type === 'select' && spec.options && !spec.options.some((o) => o.value === text)) {
    asConfigError(`${spec.label}取值非法`);
  }
  return text;
}

/**
 * @param {string} kind
 * @param {any} rawOptions
 * @param {{ source?: string, dataDir?: string }} [meta]
 */
function validateOptions(kind, rawOptions, meta = {}) {
  const def = backendDef(kind);
  const source = meta.source || 'storage.json';
  const dataDir = meta.dataDir || DATA_DIR;
  if (rawOptions != null && !isPlainObject(rawOptions)) {
    asConfigError('存储配置 options 必须是对象');
  }
  const input = rawOptions || {};
  const specs = new Map(def.fields.map((field) => [field.name, field]));
  for (const key of Object.keys(input)) {
    if (!specs.has(key)) asConfigError(`存储后端 ${kind} 不支持配置项：${key}`);
  }
  const out = {};
  for (const spec of def.fields) {
    const raw = input[spec.name];
    if (raw == null || raw === '') {
      if (spec.default !== undefined) out[spec.name] = spec.default;
      continue;
    }
    out[spec.name] = validateField(spec, raw, { kind, source, dataDir });
  }
  if (source !== 'env' && def.requireOneOf) {
    const groups = def.requireOneOf;
    const ok = groups.some((group) => group.every((name) => out[name] != null && out[name] !== ''));
    if (!ok) {
      asConfigError(`请至少填写 ${groups.map((g) => g.join(' + ')).join(' 或 ')}`);
    }
  }
  if (out.url && urlHasPassword(out.url) && source !== 'env') {
    // URL 密码是允许的；脱敏只发生在返回给前端时。
  }
  return out;
}

/**
 * @param {any} raw
 * @param {{ source?: string, dataDir?: string }} [meta]
 */
function normalizeStorageConfig(raw, meta = {}) {
  const source = meta.source || 'storage.json';
  const dataDir = meta.dataDir || DATA_DIR;
  if (!isPlainObject(raw)) asConfigError('存储配置必须是对象');
  const version = raw.version == null ? CONFIG_VERSION : Number(raw.version);
  if (!Number.isInteger(version) || version !== CONFIG_VERSION) {
    asConfigError(`不支持的存储配置版本：${raw.version}（当前支持 ${CONFIG_VERSION}）`);
  }
  let kind;
  try {
    kind = canonicalKind(raw.kind);
  } catch (error) {
    asConfigError(/** @type {Error} */ (error).message);
  }
  if (!KINDS.includes(kind)) asConfigError(`存储后端 ${kind} 尚未实现`);
  const options = validateOptions(kind, raw.options, { source, dataDir });
  return {
    version: CONFIG_VERSION,
    kind,
    options,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : undefined,
    updatedBy: typeof raw.updatedBy === 'string' ? raw.updatedBy : undefined,
  };
}

/**
 * 从环境变量构造配置（旧部署方式的初始值）。
 * @param {NodeJS.ProcessEnv} [env]
 */
function fromEnv(env = process.env) {
  const rawKind = env.STORAGE || 'json';
  let kind;
  try {
    kind = canonicalKind(rawKind);
  } catch (error) {
    asConfigError(/** @type {Error} */ (error).message);
  }
  /** @type {Record<string, any>} */
  const options = {};
  switch (kind) {
    case 'json':
      options.file = env.STATE_FILE || 'state.json';
      options.pretty = isTruthy(env.STATE_FILE_PRETTY);
      break;
    case 'txt':
      options.file = env.STATE_TXT_FILE || 'state.txt';
      break;
    case 'sqlite':
      options.file = env.SQLITE_FILE || 'scoreboard.db';
      options.busyTimeoutMs = positiveInt(env.SQLITE_BUSY_TIMEOUT_MS, 5000);
      break;
    case 'postgres':
      if (env.DATABASE_URL) options.url = env.DATABASE_URL;
      options.connectTimeoutMs = positiveInt(env.PG_CONNECT_TIMEOUT_MS, 5000);
      break;
    case 'mysql':
      if (env.MYSQL_URL) options.url = env.MYSQL_URL;
      break;
    case 'mongodb': {
      const url = env.MONGODB_URL || env.MONGO_URL;
      if (url) options.url = url;
      if (env.MONGODB_HOST) options.host = env.MONGODB_HOST;
      if (env.MONGODB_PORT) options.port = positiveInt(env.MONGODB_PORT, 27017);
      if (env.MONGODB_USER) options.user = env.MONGODB_USER;
      if (env.MONGODB_PASSWORD) options.password = env.MONGODB_PASSWORD;
      options.database = env.MONGODB_DB || 'screenscoreboard';
      break;
    }
    case 'sqlserver': {
      const url = env.MSSQL_URL;
      if (url) options.url = url;
      if (env.MSSQL_SERVER) options.server = env.MSSQL_SERVER;
      if (env.MSSQL_PORT) options.port = positiveInt(env.MSSQL_PORT, 1433);
      if (env.MSSQL_DATABASE) options.database = env.MSSQL_DATABASE;
      if (env.MSSQL_USER) options.user = env.MSSQL_USER;
      if (env.MSSQL_PASSWORD) options.password = env.MSSQL_PASSWORD;
      break;
    }
    case 'oracle': {
      const url = env.ORACLE_URL;
      if (url) options.url = url;
      if (env.ORACLE_CONNECT_STRING) options.connectString = env.ORACLE_CONNECT_STRING;
      if (env.ORACLE_USER) options.user = env.ORACLE_USER;
      if (env.ORACLE_PASSWORD) options.password = env.ORACLE_PASSWORD;
      break;
    }
    case 'redis': {
      const url = env.REDIS_URL;
      if (url) options.url = url;
      if (env.REDIS_HOST) options.host = env.REDIS_HOST;
      if (env.REDIS_PORT) options.port = positiveInt(env.REDIS_PORT, 6379);
      if (env.REDIS_PASSWORD) options.password = env.REDIS_PASSWORD;
      break;
    }
    default:
      break;
  }
  return { version: CONFIG_VERSION, kind, options };
}

const STORAGE_ENV_KEYS = [
  'STORAGE', 'STATE_FILE', 'STATE_FILE_PRETTY', 'STATE_TXT_FILE', 'SQLITE_FILE',
  'DATABASE_URL', 'MYSQL_URL', 'MYSQL_HOST', 'MYSQL_DATABASE',
  'MONGODB_URL', 'MONGO_URL', 'MONGODB_HOST', 'MONGODB_PORT', 'MONGODB_DB',
  'MSSQL_URL', 'MSSQL_SERVER', 'MSSQL_DATABASE',
  'ORACLE_URL', 'ORACLE_CONNECT_STRING', 'ORACLE_USER',
  'REDIS_URL', 'REDIS_HOST', 'REDIS_PORT',
];

function hasStorageEnv(env = process.env) {
  return STORAGE_ENV_KEYS.some((key) => env[key] != null && env[key] !== '');
}

/**
 * @param {string} [file]
 */
function readStorageConfigFile(file = STORAGE_CONFIG_FILE) {
  if (!fs.existsSync(file)) return null;
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (error) {
    asConfigError(`无法读取存储配置文件：${file}`, { cause: String(error) });
  }
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    logger.warn('存储配置文件权限过宽，正在收紧为 0600', { file: path.basename(file) });
    try { fs.chmodSync(file, 0o600); } catch (_) {}
  }
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    asConfigError(`无法读取存储配置文件：${file}`, { cause: String(error) });
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    asConfigError(
      `存储配置文件损坏：${file}。请修复该文件，或将其移走以回退到环境变量/默认 JSON。`,
      { cause: String(error) },
    );
  }
}

/**
 * @param {{ env?: NodeJS.ProcessEnv, dataDir?: string }} [options]
 */
function resolveStorageConfig(options = {}) {
  const env = options.env || process.env;
  const dataDir = options.dataDir || DATA_DIR;
  const file = configPathOf(dataDir);
  if (fs.existsSync(file)) {
    const raw = readStorageConfigFile(file);
    const config = normalizeStorageConfig(raw, { source: 'storage.json', dataDir });
    return { config, source: 'storage.json', configPath: file };
  }
  const envConfig = fromEnv(env);
  const source = hasStorageEnv(env) ? 'env' : 'default';
  const config = normalizeStorageConfig(envConfig, { source, dataDir });
  return { config, source, configPath: file };
}

/** @type {Promise<any>} */
let writeQueue = Promise.resolve();

/**
 * @param {any} config
 * @param {{ actor?: string, dataDir?: string }} [options]
 */
function saveStorageConfig(config, options = {}) {
  const dataDir = options.dataDir || DATA_DIR;
  const file = configPathOf(dataDir);
  const normalized = normalizeStorageConfig(config, { source: 'storage.json', dataDir });
  const payload = {
    version: CONFIG_VERSION,
    kind: normalized.kind,
    options: normalized.options,
    updatedAt: new Date().toISOString(),
    updatedBy: options.actor || '',
  };
  const write = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch (_) {}
    return payload;
  };
  const next = writeQueue.then(write, write);
  writeQueue = next.catch(() => undefined);
  return next;
}

/**
 * @param {any} config
 * @param {{ source?: string, configPath?: string }} [meta]
 */
function redactStorageConfig(config, meta = {}) {
  const options = { ...(config.options || {}) };
  let hasPassword = false;
  if (typeof options.password === 'string' && options.password.length > 0) hasPassword = true;
  delete options.password;
  delete options.passwordFile;
  if (typeof options.url === 'string') {
    if (urlHasPassword(options.url)) hasPassword = true;
    options.url = redactUrlPassword(options.url);
  }
  return {
    version: config.version || CONFIG_VERSION,
    kind: config.kind,
    options,
    hasPassword,
    source: meta.source || 'storage.json',
    updatedAt: config.updatedAt,
    updatedBy: config.updatedBy,
    configPath: meta.configPath ? path.basename(meta.configPath) : 'storage.json',
  };
}

/**
 * 合并密码：留空表示保留，仅在连接目标未变时允许；目标变化必须重新输入。
 * @param {any} next
 * @param {any} previous
 * @param {{ clearPassword?: boolean }} [options]
 */
function mergeSecrets(next, previous, options = {}) {
  const out = { ...next, options: { ...(next.options || {}) } };
  const prevOptions = (previous && previous.options) || {};
  const prevHasPassword = Boolean(
    (typeof prevOptions.password === 'string' && prevOptions.password.length > 0) ||
    (typeof prevOptions.url === 'string' && urlHasPassword(prevOptions.url)),
  );
  if (options.clearPassword) {
    delete out.options.password;
    if (typeof out.options.url === 'string') out.options.url = stripUrlPassword(out.options.url);
    return out;
  }
  if (typeof out.options.url === 'string' && out.options.url.includes('***')) {
    out.options.url = previous && previous.kind === out.kind
      ? copyUrlPassword(out.options.url, prevOptions.url || '')
      : stripUrlPassword(out.options.url);
  }
  const provided = typeof out.options.password === 'string' && out.options.password.length > 0;
  if (!provided) {
    delete out.options.password;
    const sameKind = Boolean(previous && previous.kind === out.kind);
    if (prevHasPassword && sameKind) {
      const sameTarget = sameConnectionTarget(out.kind, out.options, prevOptions);
      if (sameTarget) {
        if (typeof prevOptions.password === 'string' && prevOptions.password.length > 0) {
          out.options.password = prevOptions.password;
        }
      } else {
        asConfigError('更改连接目标后需要重新输入密码', { code: 'PASSWORD_REQUIRED' });
      }
    }
  }
  return out;
}

/** @param {any} config */
function configFingerprint(config) {
  return sha256(canonicalJSON({ kind: config.kind, options: config.options }));
}

/** 给管理端 UI 的后端元数据（只列已实现的后端）。 */
function describeBackends() {
  return KINDS.filter((kind) => BACKEND_DEFS[kind]).map((kind) => {
    const def = BACKEND_DEFS[kind];
    return {
      kind,
      label: def.label,
      category: def.category,
      description: def.description,
      recommended: Boolean(def.recommended),
      recommendedNote: def.recommendedNote || '',
      envKeys: [...def.envKeys],
      fields: def.fields.map((field) => ({ ...field })),
    };
  });
}

module.exports = {
  CONFIG_VERSION,
  BACKEND_DEFS,
  resolveStorageConfig,
  readStorageConfigFile,
  saveStorageConfig,
  normalizeStorageConfig,
  validateOptions,
  redactStorageConfig,
  mergeSecrets,
  configFingerprint,
  describeBackends,
  fromEnv,
  hasStorageEnv,
  connectionTarget,
  sameConnectionTarget,
  redactUrlPassword,
  urlHasPassword,
  stripUrlPassword,
  configPathOf,
};
