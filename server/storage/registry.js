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
  ['mysql', 'mysql'],
  ['mariadb', 'mysql'],
  ['mongodb', 'mongodb'],
  ['mongo', 'mongodb'],
  ['sqlserver', 'sqlserver'],
  ['mssql', 'sqlserver'],
  ['oracle', 'oracle'],
  ['oracledb', 'oracle'],
  ['redis', 'redis'],
]);

const KINDS = Object.freeze([
  'json', 'txt', 'sqlite', 'postgres', 'mysql',
  'mongodb', 'sqlserver', 'oracle', 'redis',
]);

function canonicalKind(raw) {
  const kind = String(raw || 'json').toLowerCase();
  const canonical = ALIASES.get(kind);
  if (!canonical) {
    throw new Error(`不支持的存储后端: ${kind}（可选 ${KINDS.join(' / ')}）`);
  }
  return canonical;
}

module.exports = { ALIASES, KINDS, canonicalKind };
