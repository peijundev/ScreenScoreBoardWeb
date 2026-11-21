'use strict';
// MongoDB 后端：单文档快照 + revision CAS。暂不支持跨主机分布式锁。
const { requireDriver, StorageConflictError } = require('./common');

function buildUrl(options) {
  const url = options.url || process.env.MONGODB_URL || process.env.MONGO_URL;
  if (url) return url;
  const host = options.host || process.env.MONGODB_HOST || '127.0.0.1';
  const port = Number(options.port || process.env.MONGODB_PORT) || 27017;
  const database = options.database || process.env.MONGODB_DB || 'screenscoreboard';
  const user = options.user || process.env.MONGODB_USER || '';
  const password = options.password || process.env.MONGODB_PASSWORD || '';
  const auth = user
    ? `${encodeURIComponent(user)}${password ? ':' + encodeURIComponent(password) : ''}@`
    : '';
  return `mongodb://${auth}${host}:${port}/${database}`;
}

/**
 * @param {Record<string, any>} [options]
 */
function createMongoStorage(options = {}) {
  /** @type {any} */
  let client = null;
  /** @type {any} */
  let collection = null;
  let revision = 0;
  let lastSaveAt = 0;
  let lastError = /** @type {string|null} */ (null);

  async function currentRevision() {
    const doc = await collection.findOne({ _id: 'state' }, { projection: { revision: 1 } });
    return doc ? Number(doc.revision) || 0 : 0;
  }

  function docOf(result) {
    if (!result) return null;
    return result.value !== undefined ? result.value : result;
  }

  return {
    kind: 'mongodb',
    capabilities: {
      cas: true,
      revision: 'integer',
      distributedLock: false,
      lockKind: null,
      snapshot: 'document',
    },
    async init() {
      const { MongoClient } = requireDriver('mongodb', 'MongoDB');
      const url = buildUrl(options);
      /** @type {Record<string, any>} */
      const opts = {
        serverSelectionTimeoutMS: Number(options.serverSelectionTimeoutMs) || 5000,
        connectTimeoutMS: Number(options.connectTimeoutMs) || 5000,
        maxPoolSize: Number(options.maxPool) || 5,
      };
      if (options.tls) opts.tls = true;
      if (options.authSource) opts.authSource = options.authSource;
      client = new MongoClient(url, opts);
      await client.connect();
      const database = options.database || process.env.MONGODB_DB || 'screenscoreboard';
      collection = client.db(database).collection(options.collection || 'scoreboard_state');
      // 旧文档 revision=0 初始化为 1；0 表示“没有文档”。
      await collection.updateOne({ _id: 'state', revision: 0 }, { $set: { revision: 1 } });
      const doc = await collection.findOne({ _id: 'state' }, { projection: { revision: 1 } });
      revision = doc ? Number(doc.revision) || 0 : 0;
    },
    async load() {
      const doc = await collection.findOne({ _id: 'state' });
      if (!doc) {
        revision = 0;
        return null;
      }
      revision = Number(doc.revision) || 0;
      try { return JSON.parse(doc.data); } catch (_) { return null; }
    },
    /**
     * @param {any} state
     * @param {{ expectedRevision?: any }} [saveOptions]
     */
    async save(state, { expectedRevision } = {}) {
      const json = JSON.stringify(state);
      const now = Date.now();
      try {
        if (expectedRevision === undefined) {
          const result = docOf(await collection.findOneAndUpdate(
            { _id: 'state' },
            { $set: { data: json, updatedAt: now }, $inc: { revision: 1 } },
            { upsert: true, returnDocument: 'after' },
          ));
          revision = Number(result && result.revision) || 1;
        } else {
          const expected = expectedRevision === null ? 0 : Number(expectedRevision);
          const filter = expected === 0
            ? { _id: 'state', revision: 0 }
            : { _id: 'state', revision: expected };
          let result;
          try {
            result = docOf(await collection.findOneAndUpdate(
              filter,
              { $set: { data: json, updatedAt: now }, $inc: { revision: 1 } },
              expected === 0
                ? { upsert: true, returnDocument: 'after' }
                : { returnDocument: 'after' },
            ));
          } catch (error) {
            if (error && error.code === 11000) {
              throw new StorageConflictError('状态已被其他实例写入，拒绝覆盖', {
                currentRevision: await currentRevision(),
              });
            }
            throw error;
          }
          if (!result) {
            throw new StorageConflictError('状态已被其他实例修改，拒绝覆盖', {
              currentRevision: await currentRevision(),
            });
          }
          revision = Number(result.revision) || (expected + 1);
        }
        lastSaveAt = Date.now();
        lastError = null;
        return { revision };
      } catch (error) {
        lastError = error && error.message ? error.message : String(error);
        throw error;
      }
    },
    async close() {
      try { if (client) await client.close(); } catch (_) {}
      client = null;
      collection = null;
    },
    /** @param {{ probe?: boolean }} [healthOptions] */
    async health({ probe } = {}) {
      let ok = true;
      let latencyMs = 0;
      const warnings = [];
      if (probe && client) {
        try {
          const started = Date.now();
          await client.db(options.database || 'screenscoreboard').command({ ping: 1 });
          latencyMs = Date.now() - started;
        } catch (error) {
          ok = false;
          warnings.push(error && error.message ? error.message : String(error));
        }
      }
      return {
        ok,
        kind: 'mongodb',
        revision,
        latencyMs,
        lastSaveAt: lastSaveAt || null,
        lastError,
        warnings,
      };
    },
    getRevision() {
      return revision;
    },
    async removeSnapshot() {
      await collection.deleteOne({ _id: 'state' });
      revision = 0;
    },
  };
}

module.exports = { createMongoStorage };
