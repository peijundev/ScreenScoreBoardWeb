'use strict';
// JSON / TXT 共用的文件快照后端：内容哈希作为 revision，原子写 + CAS。
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { logger } = require('../logger');
const { StorageConflictError, sha256 } = require('./common');

/**
 * @param {Object} options
 * @param {string} options.kind
 * @param {string} options.file
 * @param {(state: any) => string} options.serialize
 * @param {(text: string) => any} options.parse
 */
function createFileSnapshotStorage({ kind, file, serialize, parse }) {
  let revision = /** @type {string|null} */ (null);
  let lastSaveAt = 0;
  let lastError = null;

  function currentHash() {
    if (!fs.existsSync(file)) return null;
    try {
      return sha256(fs.readFileSync(file));
    } catch (_) {
      return null;
    }
  }

  function handleCorrupt(error) {
    const backup = file + '.corrupt-' + Date.now();
    try { fs.renameSync(file, backup); } catch (_) {}
    logger.error('状态文件损坏，已备份', {
      file: path.basename(file),
      backup: path.basename(backup),
      error: error && error.message ? error.message : String(error),
      kind,
    });
  }

  return {
    kind,
    capabilities: {
      cas: true,
      revision: 'hash',
      distributedLock: false,
      lockKind: 'file-lock',
      snapshot: 'file',
    },
    async init() {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // 上次崩溃遗留的临时文件（rename 原子，.tmp 必然是不完整数据）
      try { await fsp.unlink(file + '.tmp'); } catch (_) {}
      revision = currentHash();
    },
    async load() {
      if (!fs.existsSync(file)) {
        revision = null;
        return null;
      }
      let bytes;
      try {
        bytes = fs.readFileSync(file);
      } catch (error) {
        lastError = /** @type {Error} */ (error).message;
        throw error;
      }
      if (!bytes.length) {
        revision = null;
        return null;
      }
      revision = sha256(bytes);
      try {
        return parse(bytes.toString('utf8'));
      } catch (error) {
        handleCorrupt(error);
        revision = null;
        return null;
      }
    },
    /**
     * @param {any} state
     * @param {{ expectedRevision?: any }} [options]
     */
    async save(state, { expectedRevision } = {}) {
      try {
        if (expectedRevision !== undefined) {
          const actual = currentHash();
          if (actual !== expectedRevision) {
            throw new StorageConflictError('状态已被其他实例修改，拒绝覆盖', { currentRevision: actual });
          }
        }
        const text = serialize(state);
        const tmp = file + '.tmp';
        await fsp.writeFile(tmp, text, 'utf8');
        await fsp.rename(tmp, file);
        revision = sha256(text);
        lastSaveAt = Date.now();
        lastError = null;
        return { revision };
      } catch (error) {
        lastError = error && error.message ? error.message : String(error);
        throw error;
      }
    },
    async close() {},
    /** @param {{ probe?: boolean }} [options] */
    async health({ probe } = {}) {
      const warnings = [];
      let ok = true;
      let latencyMs = 0;
      try {
        const started = Date.now();
        if (probe) {
          fs.accessSync(path.dirname(file), fs.constants.W_OK);
          ok = fs.existsSync(file);
        }
        latencyMs = Date.now() - started;
      } catch (error) {
        ok = false;
        warnings.push('数据目录不可写：' + (error && error.message ? error.message : String(error)));
      }
      return {
        ok,
        kind,
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
      try { await fsp.unlink(file); } catch (_) {}
      revision = null;
    },
  };
}

module.exports = { createFileSnapshotStorage };
