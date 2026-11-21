'use strict';
// 存储后端入口：兼容原有 createStorage() 调用；具体实现在 server/storage/ 下。
const path = require('path');
const { config } = require('./config');
const { DATA_DIR } = require('./paths');
const { canonicalKind } = require('./storage/registry');
const { resolveStorageConfig } = require('./storage-config');
const { createJsonStorage } = require('./storage/file');
const { createTxtStorage } = require('./storage/txt');
const { createSqliteStorage } = require('./storage/sqlite');
const { createPostgresStorage } = require('./storage/postgres');
const { createMysqlStorage } = require('./storage/mysql');
const { createMongoStorage } = require('./storage/mongodb');
const { createSqlServerStorage } = require('./storage/sqlserver');
const { createOracleStorage } = require('./storage/oracle');
const { createRedisStorage } = require('./storage/redis');
const {
  StorageError,
  StorageConfigError,
  StorageConflictError,
  StorageUnsupportedError,
  StorageDriverMissingError,
} = require('./storage/common');

const DEFAULT_FILES = {
  json: 'state.json',
  txt: 'state.txt',
  sqlite: 'scoreboard.db',
};

/**
 * @typedef {Object} StorageOptions
 * @property {string} [kind]
 * @property {string} [file]
 * @property {boolean} [pretty]
 * @property {number} [busyTimeoutMs]
 * @property {string} [url]
 */

/**
 * @param {string} kind
 * @param {string|undefined} file
 * @param {string} [dataDir]
 */
function resolveFilePath(kind, file, dataDir) {
  const raw = file || DEFAULT_FILES[kind];
  return path.isAbsolute(raw) ? raw : path.resolve(dataDir || DATA_DIR, raw);
}

/**
 * @param {StorageOptions} [options]
 */
function createStorage(options = {}) {
  if (!options.kind) {
    const resolved = resolveStorageConfig();
    return createStorageFromConfig(resolved.config);
  }
  const kind = canonicalKind(options.kind);
  switch (kind) {
    case 'json':
      return createJsonStorage({
        file: resolveFilePath('json', options.file),
        pretty: options.pretty != null ? Boolean(options.pretty) : config.stateFilePretty,
      });
    case 'txt':
      return createTxtStorage({ file: resolveFilePath('txt', options.file) });
    case 'sqlite':
      return createSqliteStorage({
        file: resolveFilePath('sqlite', options.file),
        busyTimeoutMs: options.busyTimeoutMs,
      });
    case 'postgres':
      return createPostgresStorage(options);
    case 'mysql':
      return createMysqlStorage(options);
    case 'mongodb':
      return createMongoStorage(options);
    case 'sqlserver':
      return createSqlServerStorage(options);
    case 'oracle':
      return createOracleStorage(options);
    case 'redis':
      return createRedisStorage(options);
    default:
      throw new Error(`不支持的存储后端: ${kind}`);
  }
}

/**
 * @param {{ kind: string, options?: Record<string, any> }} storageConfig
 * @param {{ dataDir?: string }} [meta]
 */
function createStorageFromConfig(storageConfig, meta = {}) {
  const kind = canonicalKind(storageConfig.kind);
  /** @type {StorageOptions & Record<string, any>} */
  const options = { ...(storageConfig.options || {}), kind };
  if (DEFAULT_FILES[kind]) {
    options.file = resolveFilePath(kind, options.file, meta.dataDir);
  }
  return createStorage(options);
}

module.exports = {
  createStorage,
  createStorageFromConfig,
  StorageError,
  StorageConfigError,
  StorageConflictError,
  StorageUnsupportedError,
  StorageDriverMissingError,
};
