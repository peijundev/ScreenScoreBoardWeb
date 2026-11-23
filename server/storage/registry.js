'use strict';
// 存储后端别名与工厂注册表。驱动按需加载，缺失时只在 init 报错。

const ALIASES = new Map([
  ['json', 'json'],
  ['file', 'json'],
  ['text', 'json'],
  ['txt', 'txt'],
  ['sqlite', 'sqlite'],
  ['sqlite3', 'sqlite'],
  ['postgres', 'postgres'],
  ['postgresql', 'postgres'],
  ['pg', 'postgres'],
  // PostgreSQL 协议兼容服务；CockroachDB / YugabyteDB 不支持 advisory lock，需在配置中把锁模式设为 none。
  ['cockroach', 'postgres'],
  ['cockroachdb', 'postgres'],
  ['yugabyte', 'postgres'],
  ['yugabytedb', 'postgres'],
  ['mysql', 'mysql'],
  ['mariadb', 'mysql'],
  // MySQL 协议兼容服务；PlanetScale / Vitess 不支持 GET_LOCK，需把锁模式设为 none。
  ['tidb', 'mysql'],
  ['planetscale', 'mysql'],
  ['vitess', 'mysql'],
  ['mongodb', 'mongodb'],
  ['mongo', 'mongodb'],
  ['documentdb', 'mongodb'],
  ['sqlserver', 'sqlserver'],
  ['mssql', 'sqlserver'],
  ['oracle', 'oracle'],
  ['oracledb', 'oracle'],
  ['redis', 'redis'],
  ['upstash', 'redis'],
  ['libsql', 'libsql'],
  ['turso', 'libsql'],
  ['couchdb', 'couchdb'],
  ['couch', 'couchdb'],
  ['d1', 'd1'],
  ['cloudflare-d1', 'd1'],
  ['dynamodb', 'dynamodb'],
  ['dynamo', 'dynamodb'],
  ['firestore', 'firestore'],
  ['gcp-firestore', 'firestore'],
  ['s3', 's3'],
  ['minio', 's3'],
  ['etcd', 'etcd'],
  ['etcd3', 'etcd'],
  ['lmdb', 'lmdb'],
  ['mdb', 'lmdb'],
]);

// 顺序即管理端「存储后端」的展示顺序：Redis 放在第四位，便于常用后端快速选择。
const KINDS = Object.freeze([
  'json', 'txt', 'sqlite', 'redis',
  'postgres', 'mysql', 'mongodb', 'sqlserver', 'oracle',
  'libsql', 'couchdb', 'd1', 'dynamodb', 'firestore', 's3', 'etcd', 'lmdb',
]);

function canonicalKind(raw) {
  const kind = String(raw || 'sqlite').toLowerCase();
  const canonical = ALIASES.get(kind);
  if (!canonical) {
    throw new Error(`不支持的存储后端: ${kind}（可选 ${KINDS.join(' / ')}）`);
  }
  return canonical;
}

module.exports = { ALIASES, KINDS, canonicalKind };
