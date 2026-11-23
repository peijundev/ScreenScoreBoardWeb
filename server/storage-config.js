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
/** 全新部署的默认后端；已有 state.json 会在 resolveStorageConfig 中自动识别为 JSON。 */
const DEFAULT_KIND = 'sqlite';

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
 * @property {string} [recommendedLabel] 徽标文案，默认「推荐」
 * @property {string} [recommendedNote]
 * @property {string[]} [pros] 优点
 * @property {string[]} [cons] 缺点
 * @property {string} [warning] 生产环境警告标语
 * @property {string[]} envKeys
 * @property {FieldSpec[]} fields
 * @property {string[][]} [requireOneOf]
 * @property {number} [maxSnapshotBytes] 单份快照的硬上限；0/缺省表示只受迁移上限约束
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
    { name: 'chunked', type: 'boolean', label: '分块存储', default: false, help: '把快照拆成多块，突破单行大小限制；默认关闭' },
    { name: 'chunkSizeKb', type: 'number', label: '块大小 (KB)', default: 256, min: 16, max: 4096, help: '仅在开启分块时生效' },
    { name: 'chunkShards', type: 'number', label: '分片数', default: 1, min: 1, max: 16, help: '块按分片分散存放，便于扩展' },
    { name: 'chunkVerify', type: 'boolean', label: '校验块哈希', default: true, help: '读取时校验每块长度与 SHA-256' },
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
  {
    name: 'lockMode',
    type: 'select',
    label: '跨主机锁',
    default: 'auto',
    options: [
      { value: 'auto', label: '自动（使用会话锁）' },
      { value: 'none', label: '禁用（协议兼容服务）' },
    ],
    help: 'CockroachDB、YugabyteDB、PlanetScale 等不支持会话锁的服务请选择“禁用”，仅依赖 revision CAS',
  },
  { name: 'chunked', type: 'boolean', label: '分块存储', default: false, help: '把快照拆成多块，突破单行大小限制；默认关闭' },
  { name: 'chunkSizeKb', type: 'number', label: '块大小 (KB)', default: 256, min: 16, max: 4096, help: '仅在开启分块时生效' },
  { name: 'chunkShards', type: 'number', label: '分片数', default: 1, min: 1, max: 16, help: '块按分片分散存放，便于扩展' },
  { name: 'chunkVerify', type: 'boolean', label: '校验块哈希', default: true, help: '读取时校验每块长度与 SHA-256' },
];

/** @type {Record<string, BackendDef>} */
const BACKEND_DEFS = {
  json: {
    label: 'JSON 文件',
    category: 'file',
    description: '整份状态写入单个 JSON 文件，兼容旧数据目录。',
    pros: ['零依赖，开箱即用', '文件可读，备份与迁移简单'],
    cons: ['整份重写，无索引与查询', '多实例和大状态量下性能差'],
    warning: '仅适合单实例；不要放在 NFS 等网络文件系统上。',
    envKeys: ['STORAGE', 'STATE_FILE', 'STATE_FILE_PRETTY'],
    fields: FILE_FIELDS.json,
  },
  txt: {
    label: 'TXT 纯文本',
    category: 'file',
    description: '把整份状态以缩进 JSON 写入 .txt，便于人工查看和手工编辑。',
    pros: ['人工可读，可直接编辑', '便于排错和导出'],
    cons: ['无结构化查询', '易被误改，无并发保护'],
    warning: '仅用于调试或人工维护，不建议作为生产主存储。',
    envKeys: ['STORAGE', 'STATE_TXT_FILE'],
    fields: FILE_FIELDS.txt,
  },
  sqlite: {
    label: 'SQLite',
    category: 'file',
    description: '默认后端。单机数据库，无需外部服务；WAL 模式，适合桌面和单机部署。',
    recommended: true,
    recommendedLabel: '本地推荐',
    recommendedNote: '单机/桌面部署推荐；无需外部服务，数据保存在 DATA_DIR 内。',
    pros: ['零外部服务，单文件部署', 'WAL + 事务，单机可靠'],
    cons: ['仅单机，无跨主机锁', '多副本与远程访问不便'],
    warning: '多实例或远程部署请改用 PostgreSQL / MySQL / Redis。',
    envKeys: ['STORAGE', 'SQLITE_FILE', 'SQLITE_BUSY_TIMEOUT_MS'],
    fields: FILE_FIELDS.sqlite,
  },
  postgres: {
    label: 'PostgreSQL',
    category: 'database',
    description: '稳妥的关系型数据库选择；支持跨主机咨询锁与乐观并发。',
    recommended: true,
    recommendedLabel: '生产推荐',
    recommendedNote: '多实例、需要可靠事务与备份的生产环境首选。',
    pros: ['事务与备份生态成熟', '支持 advisory lock 与乐观并发'],
    cons: ['需要独立运维与连接池', 'PgBouncer 事务池下会话锁需固定连接'],
    warning: '生产环境请配置定期备份与连接池；使用 PgBouncer 时注意会话级 advisory lock。',
    envKeys: ['STORAGE', 'DATABASE_URL', 'PG_CONNECT_TIMEOUT_MS'],
    fields: SQL_FIELDS,
    requireOneOf: [['url'], ['host', 'database']],
  },
  mysql: {
    label: 'MySQL / MariaDB',
    category: 'database',
    description: '关系型数据库；支持 GET_LOCK 与乐观并发。',
    recommended: true,
    recommendedLabel: '生态推荐',
    recommendedNote: '已有 MySQL/MariaDB 基础设施时优先复用。',
    pros: ['生态与托管服务广泛', '支持 GET_LOCK 与乐观并发'],
    cons: ['大对象受 max_allowed_packet 限制', '部分云服务不支持 GET_LOCK'],
    warning: '注意 max_allowed_packet；PlanetScale/Vitess 等请关闭跨主机锁。',
    envKeys: ['STORAGE', 'MYSQL_URL', 'MYSQL_HOST', 'MYSQL_PORT', 'MYSQL_USER', 'MYSQL_PASSWORD', 'MYSQL_DATABASE'],
    fields: SQL_FIELDS,
    requireOneOf: [['url'], ['host', 'database']],
  },
  mongodb: {
    label: 'MongoDB',
    category: 'database',
    description: '文档数据库；单文档上限 16MB，适合中小状态。暂不支持跨主机锁。',
    pros: ['文档模型灵活，部署简单', '单文档原子更新'],
    cons: ['单文档上限 16MB', '无跨主机锁'],
    warning: '单文档上限 16MB；接近上限时迁移会失败，请单实例运行。',
    maxSnapshotBytes: Math.floor(15.5 * 1024 * 1024),
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
    pros: ['企业生态与工具成熟', '纯 JS 驱动，无需额外客户端'],
    cons: ['无跨主机锁', '授权与运维成本较高'],
    warning: '仅靠 CAS，请单实例运行；注意授权与 TLS 配置。',
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
    pros: ['Thin 模式无需 Instant Client', '具备企业级备份与运维体系'],
    cons: ['驱动体积大、授权成本高', '无跨主机锁'],
    warning: '仅靠 CAS，请单实例运行；Alpine 上可能跳过原生驱动安装。',
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
    recommendedLabel: '效率推荐',
    recommendedNote: '多实例/低延迟推荐；必须 appendonly yes + maxmemory-policy noeviction',
    pros: ['低延迟，适合多实例写入', '支持跨主机锁与原子 Lua CAS'],
    cons: ['内存成本随状态增长', '持久化配置不当可能丢数据'],
    warning: '必须 appendonly yes + maxmemory-policy noeviction；否则重启或淘汰可能丢失状态。',
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
      { name: 'chunked', type: 'boolean', label: '分块存储', default: false, help: '把快照拆成多个 key，突破单值大小限制；默认关闭' },
      { name: 'chunkSizeKb', type: 'number', label: '块大小 (KB)', default: 256, min: 16, max: 4096, help: '仅在开启分块时生效' },
      { name: 'chunkShards', type: 'number', label: '分片数', default: 1, min: 1, max: 16, help: '块按分片分散存放，便于扩展' },
      { name: 'chunkVerify', type: 'boolean', label: '校验块哈希', default: true, help: '读取时校验每块长度与 SHA-256' },
    ],
  },
  libsql: {
    label: 'libSQL / Turso',
    category: 'database',
    description: 'SQLite 兼容的远程或嵌入式数据库；支持 Turso Cloud 与自托管 libSQL Server，也支持本地 file:。',
    recommended: true,
    recommendedLabel: '边缘推荐',
    recommendedNote: '需要远程 SQLite 兼容或边缘部署时适用。',
    pros: ['SQLite 兼容，迁移成本低', '支持远程与本地 file:'],
    cons: ['无跨主机锁', 'embedded replica 可能读到旧数据'],
    warning: '不要把 embedded replica 作为权威写路径；请单实例运行。',
    envKeys: ['STORAGE', 'LIBSQL_URL', 'LIBSQL_AUTH_TOKEN'],
    fields: [
      { name: 'url', type: 'string', label: '数据库 URL', maxLength: 2048, placeholder: 'libsql://your-db.turso.io', help: '支持 libsql://、https://、wss:// 或 file:' },
      { name: 'authToken', type: 'password', label: '认证令牌', secret: true, maxLength: 2048, help: 'Turso Cloud 或启用认证的 libSQL Server；本地 file: 可留空' },
      { name: 'chunked', type: 'boolean', label: '分块存储', default: false, help: '把快照拆成多块，突破单行大小限制；默认关闭' },
      { name: 'chunkSizeKb', type: 'number', label: '块大小 (KB)', default: 256, min: 16, max: 4096, help: '仅在开启分块时生效' },
      { name: 'chunkShards', type: 'number', label: '分片数', default: 1, min: 1, max: 16, help: '块按分片分散存放，便于扩展' },
      { name: 'chunkVerify', type: 'boolean', label: '校验块哈希', default: true, help: '读取时校验每块长度与 SHA-256' },
    ],
    requireOneOf: [['url']],
  },
  couchdb: {
    label: 'CouchDB',
    category: 'database',
    description: 'HTTP 文档数据库；整份状态保存在 _id=state 的单个文档中，使用 _rev 与 revision 字段做 CAS。',
    recommended: true,
    recommendedLabel: '自托管推荐',
    recommendedNote: '需要 HTTP/JSON 接口与自托管文档库时适用。',
    pros: ['HTTP/JSON，自托管简单', '单文档 MVCC 与快照模型契合'],
    cons: ['默认文档上限约 8MB', '无跨主机锁，写入需两跳'],
    warning: '默认单文档约 8MB；请单实例运行，并确认数据库名合法。',
    maxSnapshotBytes: Math.floor(7.5 * 1024 * 1024),
    envKeys: ['STORAGE', 'COUCHDB_URL', 'COUCHDB_DATABASE', 'COUCHDB_USER', 'COUCHDB_PASSWORD'],
    fields: [
      { name: 'url', type: 'string', label: '服务 URL', maxLength: 2048, placeholder: 'http://127.0.0.1:5984', help: '不包含数据库名；支持 http(s)://' },
      { name: 'database', type: 'string', label: '数据库名', default: 'scoreboard', maxLength: 128, pattern: '^[a-z][a-z0-9_$-]*$', help: 'CouchDB 要求小写字母开头；不存在时自动创建' },
      { name: 'user', type: 'string', label: '用户名', maxLength: 128 },
      { name: 'password', type: 'password', label: '密码', secret: true, maxLength: 512 },
      { name: 'requestTimeoutMs', type: 'number', label: '请求超时 (ms)', default: 15000, min: 1000, max: 120000 },
    ],
    requireOneOf: [['url']],
  },
  d1: {
    label: 'Cloudflare D1',
    category: 'database',
    description: 'Cloudflare 边缘 SQL；通过 REST API 访问，整份状态保存在 scoreboard_state 表。',
    recommended: true,
    recommendedLabel: 'Cloudflare 推荐',
    recommendedNote: 'Cloudflare 生态或边缘部署时适用。',
    pros: ['零 SDK，REST API 接入', '边缘部署，免运维'],
    cons: ['单行约 2MB', '仅 Cloudflare，厂商绑定'],
    warning: '单行约 2MB；需要账户 ID、数据库 ID 与 API Token；请单实例运行。',
    maxSnapshotBytes: Math.floor(1.9 * 1024 * 1024),
    envKeys: [
      'STORAGE', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID',
      'D1_DATABASE_ID', 'D1_ENDPOINT',
    ],
    fields: [
      { name: 'accountId', type: 'string', label: '账户 ID', maxLength: 64, pattern: '^[A-Za-z0-9_-]+$' },
      { name: 'databaseId', type: 'string', label: '数据库 ID', maxLength: 64, pattern: '^[A-Za-z0-9-]+$' },
      { name: 'apiToken', type: 'password', label: 'API Token', secret: true, maxLength: 512 },
      { name: 'endpoint', type: 'string', label: 'API 地址', default: 'https://api.cloudflare.com', maxLength: 512, help: '一般无需修改；可指向兼容代理' },
      { name: 'requestTimeoutMs', type: 'number', label: '请求超时 (ms)', default: 15000, min: 1000, max: 120000 },
      { name: 'chunked', type: 'boolean', label: '分块存储', default: false, help: '把快照拆成多块，突破单行大小限制；默认关闭' },
      { name: 'chunkSizeKb', type: 'number', label: '块大小 (KB)', default: 256, min: 16, max: 4096, help: '仅在开启分块时生效' },
      { name: 'chunkShards', type: 'number', label: '分片数', default: 1, min: 1, max: 16, help: '块按分片分散存放，便于扩展' },
      { name: 'chunkVerify', type: 'boolean', label: '校验块哈希', default: true, help: '读取时校验每块长度与 SHA-256' },
    ],
    // API Token 是 secret：留空表示沿用已保存值，由 mergeSecrets 处理。
    requireOneOf: [['accountId', 'databaseId']],
  },
  dynamodb: {
    label: 'AWS DynamoDB',
    category: 'database',
    description: 'AWS 全托管键值数据库；单项上限 400KB，使用条件写实现 CAS。',
    recommended: true,
    recommendedLabel: 'AWS 推荐',
    recommendedNote: 'AWS 环境、状态小于 400KB 时适用。',
    pros: ['全托管、按需扩展', '条件写天然 CAS'],
    cons: ['单项 400KB', 'SDK 体积大，凭证模型需配置'],
    warning: '单项 400KB；表需预先创建（分区键 id）；请单实例运行。',
    maxSnapshotBytes: Math.floor(380 * 1024),
    envKeys: [
      'STORAGE', 'AWS_REGION', 'DYNAMODB_TABLE', 'DYNAMODB_ENDPOINT',
      'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
    ],
    fields: [
      { name: 'region', type: 'string', label: '区域', default: 'us-east-1', maxLength: 64, pattern: '^[A-Za-z0-9-]+$' },
      { name: 'tableName', type: 'string', label: '表名', default: 'scoreboard_state', maxLength: 255, pattern: '^[A-Za-z0-9_.-]+$', help: '表需预先创建，分区键为字符串 id' },
      { name: 'endpoint', type: 'string', label: 'Endpoint', maxLength: 512, help: '可选；DynamoDB Local / LocalStack 使用' },
      { name: 'accessKeyId', type: 'string', label: 'Access Key ID', maxLength: 256, help: '留空使用 IAM 角色或环境变量' },
      { name: 'secretAccessKey', type: 'password', label: 'Secret Access Key', secret: true, maxLength: 512 },
      { name: 'sessionToken', type: 'password', label: 'Session Token', secret: true, maxLength: 2048 },
    ],
  },
  firestore: {
    label: 'Google Firestore',
    category: 'database',
    description: 'Google Cloud 文档数据库；单文档上限 1MB，事务内使用 revision CAS。',
    recommended: true,
    recommendedLabel: 'GCP 推荐',
    recommendedNote: 'GCP 环境、状态小于 1MB 时适用。',
    pros: ['全托管、事务支持', 'ADC / Workload Identity 免密钥'],
    cons: ['单文档 1MB', '按读写计费，厂商绑定'],
    warning: '单文档 1MB；推荐使用 ADC/Workload Identity；按读写计费。',
    maxSnapshotBytes: Math.floor(0.9 * 1024 * 1024),
    envKeys: [
      'STORAGE', 'GOOGLE_CLOUD_PROJECT', 'FIRESTORE_DATABASE_ID',
      'FIRESTORE_COLLECTION', 'GOOGLE_APPLICATION_CREDENTIALS',
    ],
    fields: [
      { name: 'projectId', type: 'string', label: '项目 ID', maxLength: 128, pattern: '^[A-Za-z0-9_.:-]+$' },
      { name: 'databaseId', type: 'string', label: '数据库 ID', default: '(default)', maxLength: 128, help: '默认 (default)' },
      { name: 'collection', type: 'string', label: '集合名', default: 'scoreboard_state', maxLength: 64, pattern: IDENTIFIER_RE.source },
      { name: 'keyFilename', type: 'string', label: '服务账号文件', maxLength: 1024, help: '留空使用 ADC / GOOGLE_APPLICATION_CREDENTIALS' },
    ],
    requireOneOf: [['projectId']],
  },
  s3: {
    label: 'S3 / MinIO',
    category: 'database',
    description: '对象存储；整份状态写入单个对象，使用 ETag 条件写。适合低频写入与备份，不建议作为高频主存。',
    recommended: true,
    recommendedLabel: '备份推荐',
    recommendedNote: '备份、归档或低频写入场景适用。',
    pros: ['对象存储成本低，易于跨云备份', 'ETag 条件写保证不覆盖新版本'],
    cons: ['每次保存全量重写，延迟高', '旧版 MinIO 可能不支持条件写'],
    warning: '不建议作为高频主存；MinIO 请使用支持 If-Match 的版本。',
    envKeys: [
      'STORAGE', 'S3_BUCKET', 'S3_ENDPOINT', 'S3_REGION', 'S3_KEY_PREFIX',
      'S3_FORCE_PATH_STYLE', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
    ],
    fields: [
      { name: 'bucket', type: 'string', label: '桶名称', maxLength: 255, pattern: '^[a-z0-9][a-z0-9.-]*$' },
      { name: 'keyPrefix', type: 'string', label: '对象前缀', default: 'scoreboard', maxLength: 512, pattern: '^[A-Za-z0-9_./-]*$', help: '状态对象为 <前缀>/state.json' },
      { name: 'region', type: 'string', label: '区域', default: 'us-east-1', maxLength: 64, pattern: '^[A-Za-z0-9-]+$' },
      { name: 'endpoint', type: 'string', label: 'Endpoint', maxLength: 512, help: '可选；MinIO / LocalStack 使用' },
      { name: 'forcePathStyle', type: 'boolean', label: 'Path-style 访问', default: false, help: 'MinIO 通常需要开启' },
      { name: 'accessKeyId', type: 'string', label: 'Access Key ID', maxLength: 256, help: '留空使用 IAM 角色或环境变量' },
      { name: 'secretAccessKey', type: 'password', label: 'Secret Access Key', secret: true, maxLength: 512 },
      { name: 'sessionToken', type: 'password', label: 'Session Token', secret: true, maxLength: 2048 },
    ],
    requireOneOf: [['bucket']],
  },
  etcd: {
    label: 'etcd',
    category: 'database',
    description: 'Kubernetes 原生 KV；使用 key 的 version 做 CAS，按 1.4MB 预检。当前仅 CAS，不提供 lease 锁。',
    recommended: true,
    recommendedLabel: 'K8s 推荐',
    recommendedNote: '已有独立 etcd 集群、状态很小时适用。',
    pros: ['K8s 原生，强一致', 'key version 直接做 CAS'],
    cons: ['默认请求上限约 1.5MB', '无通用托管，仅 CAS 无 lease 锁'],
    warning: '不要使用 K8s 控制面 etcd 存业务数据；当前仅 CAS，请单实例运行。',
    maxSnapshotBytes: Math.floor(1.4 * 1024 * 1024),
    envKeys: ['STORAGE', 'ETCD_ENDPOINT', 'ETCD_PREFIX', 'ETCD_USERNAME', 'ETCD_PASSWORD'],
    fields: [
      { name: 'endpoint', type: 'string', label: 'Endpoint', maxLength: 512, placeholder: 'http://127.0.0.1:2379', help: 'etcd v3 HTTP/JSON gateway' },
      { name: 'prefix', type: 'string', label: 'Key 前缀', default: 'scoreboard', maxLength: 512, pattern: '^[A-Za-z0-9_./-]*$' },
      { name: 'username', type: 'string', label: '用户名', maxLength: 128 },
      { name: 'password', type: 'password', label: '密码', secret: true, maxLength: 512 },
      { name: 'requestTimeoutMs', type: 'number', label: '请求超时 (ms)', default: 15000, min: 1000, max: 120000 },
    ],
    requireOneOf: [['endpoint']],
  },
  lmdb: {
    label: 'LMDB',
    category: 'file',
    description: '嵌入式高性能 KV；单机本地目录，无远程能力。需要原生模块，NFS 等网络文件系统不可靠。',
    recommended: true,
    recommendedLabel: '嵌入式推荐',
    recommendedNote: '单机嵌入式、追求低延迟且不需要远程时适用。',
    pros: ['嵌入式高性能，低延迟', '写事务串行化，无需外部服务'],
    cons: ['无远程能力', '原生模块，NFS 上不可靠'],
    warning: '仅限单机本地磁盘；NFS 等网络文件系统不可靠；优先考虑 SQLite。',
    envKeys: ['STORAGE', 'LMDB_DIR', 'LMDB_MAP_SIZE_MB'],
    fields: [
      { name: 'file', type: 'string', label: '数据目录', default: 'lmdb', file: true, placeholder: 'lmdb', help: '相对 DATA_DIR；必须位于 DATA_DIR 内' },
      { name: 'mapSizeMb', type: 'number', label: 'Map 大小 (MB)', default: 1024, min: 16, max: 65536, help: 'LMDB 虚拟地址空间上限，不是磁盘占用' },
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
    // 云托管/对象存储的额外连接标识；避免改目标后错误复用旧密钥。
    endpoint: String(options.endpoint || ''),
    region: String(options.region || ''),
    projectId: String(options.projectId || ''),
    accountId: String(options.accountId || ''),
    bucket: String(options.bucket || ''),
    databaseId: String(options.databaseId || ''),
    table: String(options.tableName || ''),
    prefix: String(options.keyPrefix || options.prefix || ''),
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
  // 兼容旧部署：只设置 STATE_FILE / STATE_FILE_PRETTY 时仍视为 JSON
  const legacyJsonEnv = !env.STORAGE && (env.STATE_FILE || env.STATE_FILE_PRETTY);
  const rawKind = env.STORAGE || (legacyJsonEnv ? 'json' : DEFAULT_KIND);
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
    case 'libsql': {
      if (env.LIBSQL_URL) options.url = env.LIBSQL_URL;
      if (env.LIBSQL_AUTH_TOKEN) options.authToken = env.LIBSQL_AUTH_TOKEN;
      break;
    }
    case 'couchdb': {
      if (env.COUCHDB_URL) options.url = env.COUCHDB_URL;
      options.database = env.COUCHDB_DATABASE || 'scoreboard';
      if (env.COUCHDB_USER) options.user = env.COUCHDB_USER;
      if (env.COUCHDB_PASSWORD) options.password = env.COUCHDB_PASSWORD;
      break;
    }
    case 'd1': {
      if (env.CLOUDFLARE_ACCOUNT_ID) options.accountId = env.CLOUDFLARE_ACCOUNT_ID;
      if (env.D1_DATABASE_ID) options.databaseId = env.D1_DATABASE_ID;
      if (env.CLOUDFLARE_API_TOKEN) options.apiToken = env.CLOUDFLARE_API_TOKEN;
      if (env.D1_ENDPOINT) options.endpoint = env.D1_ENDPOINT;
      break;
    }
    case 'dynamodb': {
      if (env.AWS_REGION) options.region = env.AWS_REGION;
      if (env.DYNAMODB_TABLE) options.tableName = env.DYNAMODB_TABLE;
      if (env.DYNAMODB_ENDPOINT) options.endpoint = env.DYNAMODB_ENDPOINT;
      if (env.AWS_ACCESS_KEY_ID) options.accessKeyId = env.AWS_ACCESS_KEY_ID;
      if (env.AWS_SECRET_ACCESS_KEY) options.secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
      if (env.AWS_SESSION_TOKEN) options.sessionToken = env.AWS_SESSION_TOKEN;
      break;
    }
    case 'firestore': {
      if (env.GOOGLE_CLOUD_PROJECT) options.projectId = env.GOOGLE_CLOUD_PROJECT;
      if (env.FIRESTORE_DATABASE_ID) options.databaseId = env.FIRESTORE_DATABASE_ID;
      if (env.FIRESTORE_COLLECTION) options.collection = env.FIRESTORE_COLLECTION;
      if (env.GOOGLE_APPLICATION_CREDENTIALS) options.keyFilename = env.GOOGLE_APPLICATION_CREDENTIALS;
      break;
    }
    case 's3': {
      if (env.S3_BUCKET) options.bucket = env.S3_BUCKET;
      if (env.S3_ENDPOINT) options.endpoint = env.S3_ENDPOINT;
      if (env.S3_REGION) options.region = env.S3_REGION;
      if (env.S3_KEY_PREFIX) options.keyPrefix = env.S3_KEY_PREFIX;
      if (env.S3_FORCE_PATH_STYLE != null) options.forcePathStyle = isTruthy(env.S3_FORCE_PATH_STYLE);
      if (env.AWS_ACCESS_KEY_ID) options.accessKeyId = env.AWS_ACCESS_KEY_ID;
      if (env.AWS_SECRET_ACCESS_KEY) options.secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
      if (env.AWS_SESSION_TOKEN) options.sessionToken = env.AWS_SESSION_TOKEN;
      break;
    }
    case 'etcd': {
      if (env.ETCD_ENDPOINT) options.endpoint = env.ETCD_ENDPOINT;
      if (env.ETCD_PREFIX) options.prefix = env.ETCD_PREFIX;
      if (env.ETCD_USERNAME) options.username = env.ETCD_USERNAME;
      if (env.ETCD_PASSWORD) options.password = env.ETCD_PASSWORD;
      break;
    }
    case 'lmdb': {
      options.file = env.LMDB_DIR || 'lmdb';
      options.mapSizeMb = positiveInt(env.LMDB_MAP_SIZE_MB, 1024);
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
  'LIBSQL_URL', 'LIBSQL_AUTH_TOKEN',
  'COUCHDB_URL', 'COUCHDB_DATABASE', 'COUCHDB_USER', 'COUCHDB_PASSWORD',
  'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'D1_DATABASE_ID', 'D1_ENDPOINT',
  'DYNAMODB_TABLE', 'DYNAMODB_ENDPOINT',
  'FIRESTORE_DATABASE_ID', 'FIRESTORE_COLLECTION',
  'S3_BUCKET', 'S3_ENDPOINT', 'S3_REGION', 'S3_KEY_PREFIX', 'S3_FORCE_PATH_STYLE',
  'ETCD_ENDPOINT', 'ETCD_PREFIX', 'ETCD_USERNAME',
  'LMDB_DIR', 'LMDB_MAP_SIZE_MB',
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
      `存储配置文件损坏：${file}。请修复该文件，或将其移走以回退到环境变量/默认 SQLite（有旧 state.json 时会自动识别为 JSON）。`,
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
  if (source === 'default') {
    // 旧部署没有 storage.json/存储环境变量时，优先识别既有 state.json，避免看起来数据丢失。
    const legacyState = path.join(dataDir, 'state.json');
    const defaultSqlite = path.join(dataDir, 'scoreboard.db');
    if (fs.existsSync(legacyState) && !fs.existsSync(defaultSqlite)) {
      const legacyConfig = normalizeStorageConfig(
        fromEnv({ ...env, STORAGE: 'json' }),
        { source: 'legacy', dataDir },
      );
      return { config: legacyConfig, source: 'legacy', configPath: file };
    }
  }
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

/** @param {string} kind */
function secretFieldNames(kind) {
  const def = BACKEND_DEFS[kind];
  return def ? def.fields.filter((field) => field.secret).map((field) => field.name) : [];
}

/** @param {string} kind */
function maxSnapshotBytesFor(kind) {
  const def = BACKEND_DEFS[kind];
  const limit = def && Number(def.maxSnapshotBytes);
  return Number.isFinite(limit) && limit > 0 ? limit : 0;
}

/**
 * @param {any} config
 * @param {{ source?: string, configPath?: string }} [meta]
 */
function redactStorageConfig(config, meta = {}) {
  const options = { ...(config.options || {}) };
  let hasPassword = false;
  for (const name of secretFieldNames(config.kind)) {
    if (typeof options[name] === 'string' && options[name].length > 0) hasPassword = true;
    delete options[name];
  }
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
    hasSecrets: hasPassword,
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
  const secretNames = secretFieldNames(out.kind);
  if (options.clearPassword) {
    for (const name of secretNames) delete out.options[name];
    delete out.options.passwordFile;
    if (typeof out.options.url === 'string') out.options.url = stripUrlPassword(out.options.url);
    return out;
  }
  if (typeof out.options.url === 'string' && out.options.url.includes('***')) {
    out.options.url = previous && previous.kind === out.kind
      ? copyUrlPassword(out.options.url, prevOptions.url || '')
      : stripUrlPassword(out.options.url);
  }
  const sameKind = Boolean(previous && previous.kind === out.kind);
  for (const name of secretNames) {
    const provided = typeof out.options[name] === 'string' && out.options[name].length > 0;
    if (provided) continue;
    delete out.options[name];
    const prevValue = prevOptions[name];
    if (sameKind && typeof prevValue === 'string' && prevValue.length > 0) {
      if (sameConnectionTarget(out.kind, out.options, prevOptions)) {
        out.options[name] = prevValue;
      } else {
        asConfigError('更改连接目标后需要重新输入密码或密钥', { code: 'PASSWORD_REQUIRED' });
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
      recommendedLabel: def.recommendedLabel || '',
      recommendedNote: def.recommendedNote || '',
      pros: [...(def.pros || [])],
      cons: [...(def.cons || [])],
      warning: def.warning || '',
      envKeys: [...def.envKeys],
      maxSnapshotBytes: maxSnapshotBytesFor(kind),
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
  maxSnapshotBytesFor,
  secretFieldNames,
  fromEnv,
  hasStorageEnv,
  connectionTarget,
  sameConnectionTarget,
  redactUrlPassword,
  urlHasPassword,
  stripUrlPassword,
  configPathOf,
};
