'use strict';
// LMDB 后端：嵌入式 KV，单机本地目录；写事务串行化，事务内 read-check-write 做 CAS。
// 需要原生模块 lmdb；NFS 等网络文件系统上不可靠。
const fs = require('fs');
const { requireDriver, StorageConflictError } = require('./common');

const KEY = 'state';

/**
 * @param {{ file: string, mapSizeMb?: number }} options
 */
function createLmdbStorage({ file, mapSizeMb = 1024 }) {
  /** @type {any} */
  let db = null;
  let revision = 0;
  let lastSaveAt = 0;
  let lastError = /** @type {string|null} */ (null);

  function currentRecord() {
    const raw = db.get(KEY);
    if (raw == null || raw === '') return null;
    try {
      const record = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return record && typeof record === 'object' ? record : null;
    } catch (_) {
      return null;
    }
  }

  return {
    kind: 'lmdb',
    capabilities: {
      cas: true,
      revision: 'integer',
      distributedLock: false,
      lockKind: 'file-lock',
      snapshot: 'row',
    },
    async init() {
      if (!file) throw new Error('LMDB 需要数据目录');
      fs.mkdirSync(file, { recursive: true });
      const { open } = requireDriver('lmdb', 'LMDB');
      db = open({
        path: file,
        mapSize: Math.max(16, Number(mapSizeMb) || 1024) * 1024 * 1024,
        keyEncoding: 'string',
        valueEncoding: 'string',
        compression: false,
      });
      if (typeof db.resetReadTxn === 'function') db.resetReadTxn();
      const record = currentRecord();
      revision = record ? Number(record.revision) || 0 : 0;
    },
    async load() {
      // 其他实例可能已提交新值，刷新读事务快照后再读。
      if (typeof db.resetReadTxn === 'function') db.resetReadTxn();
      const record = currentRecord();
      if (!record) {
        revision = 0;
        return null;
      }
      revision = Number(record.revision) || 0;
      try { return JSON.parse(record.data); } catch (_) { return null; }
    },
    /**
     * @param {any} state
     * @param {{ expectedRevision?: any }} [saveOptions]
     */
    async save(state, { expectedRevision } = {}) {
      const json = JSON.stringify(state);
      const now = Date.now();
      try {
        const next = db.transactionSync(() => {
          const record = currentRecord();
          const current = record ? Number(record.revision) || 0 : 0;
          if (expectedRevision !== undefined) {
            const expected = expectedRevision === null ? 0 : Number(expectedRevision);
            if (current !== expected) {
              throw new StorageConflictError('状态已被其他实例修改，拒绝覆盖', {
                currentRevision: current,
              });
            }
          }
          const nextRevision = current + 1;
          db.putSync(KEY, JSON.stringify({ data: json, revision: nextRevision, updatedAt: now }));
          return nextRevision;
        });
        revision = next;
        lastSaveAt = Date.now();
        lastError = null;
        return { revision };
      } catch (error) {
        lastError = error && error.message ? error.message : String(error);
        throw error;
      }
    },
    async close() {
      try { if (db) db.close(); } catch (_) {}
      db = null;
    },
    /** @param {{ probe?: boolean }} [healthOptions] */
    async health({ probe } = {}) {
      let ok = true;
      let latencyMs = 0;
      const warnings = [];
      if (probe && db) {
        try {
          const started = Date.now();
          db.get(KEY);
          latencyMs = Date.now() - started;
        } catch (error) {
          ok = false;
          warnings.push(error && error.message ? error.message : String(error));
        }
      }
      return {
        ok,
        kind: 'lmdb',
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
      db.removeSync(KEY);
      revision = 0;
    },
  };
}

module.exports = { createLmdbStorage };
