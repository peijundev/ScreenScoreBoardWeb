'use strict';
// 迁移：把当前内存状态写入目标后端，回读校验成功后由调用方保存配置。
const { createStorageFromConfig } = require('../storage');
const { StorageConfigError, StorageConflictError, canonicalJSON, sha256 } = require('./common');

/**
 * @param {Object} options
 * @param {any} options.targetConfig
 * @param {'copy'|'empty'} [options.mode]
 * @param {boolean} [options.overwrite]
 * @param {any} options.snapshot
 * @param {number} [options.maxBytes]
 * @param {string} [options.dataDir]
 * @param {string} [options.ownerId]
 */
async function migrateStorage(options) {
  const {
    targetConfig,
    mode = 'copy',
    overwrite = false,
    snapshot,
    maxBytes = 0,
    dataDir,
    ownerId = `migrate:${process.pid}:${Date.now()}`,
  } = options;

  const json = JSON.stringify(snapshot);
  const bytes = Buffer.byteLength(json, 'utf8');
  if (maxBytes > 0 && bytes > maxBytes) {
    throw new StorageConfigError(
      `状态快照 ${bytes} 字节超过该后端允许的迁移上限 ${maxBytes} 字节`,
      { code: 'SNAPSHOT_TOO_LARGE' },
    );
  }

  const target = createStorageFromConfig(targetConfig, { dataDir });
  let locked = false;
  let previous = /** @type {any} */ (null);
  let wrote = false;

  try {
    await target.init();
    if (target.capabilities && target.capabilities.distributedLock && typeof target.acquireLock === 'function') {
      await target.acquireLock(ownerId, { waitMs: 3000 });
      locked = true;
    }

    const existing = await target.load();
    if (existing) {
      if (!overwrite) {
        throw new StorageConflictError('目标存储已有数据；请确认覆盖或改用“空库启动”', {
          currentRevision: target.getRevision(),
        });
      }
      previous = { data: existing, revision: target.getRevision() };
    }

    if (mode === 'copy') {
      await target.save(snapshot, { expectedRevision: target.getRevision() });
      wrote = true;
      const loaded = await target.load();
      const expectedHash = sha256(canonicalJSON(snapshot));
      const actualHash = sha256(canonicalJSON(loaded));
      if (expectedHash !== actualHash) {
        throw new Error('迁移回读校验失败：目标后端内容与当前状态不一致');
      }
      return {
        ok: true,
        mode,
        kind: target.kind,
        verified: true,
        bytes,
        revision: target.getRevision(),
      };
    }

    // empty：目标必须为空；若已有数据且允许覆盖，则显式删除。
    if (existing) {
      if (typeof target.removeSnapshot !== 'function') {
        throw new Error('该存储后端不支持清空已有快照');
      }
      await target.removeSnapshot();
      const after = await target.load();
      if (after) throw new Error('无法清空目标后端已有数据');
    }
    return {
      ok: true,
      mode: 'empty',
      kind: target.kind,
      verified: true,
      bytes: 0,
      revision: target.getRevision(),
    };
  } catch (error) {
    // 回滚：迁移过程中写入的数据尽量恢复原状，配置文件尚未保存。
    if (wrote) {
      try {
        if (previous) {
          await target.save(previous.data, { expectedRevision: target.getRevision() });
        } else if (typeof target.removeSnapshot === 'function') {
          await target.removeSnapshot();
        }
      } catch (_) {
        // 回滚失败只记录在错误链中；调用方会返回原始错误。
      }
    }
    throw error;
  } finally {
    if (locked) {
      try { await target.releaseLock(ownerId); } catch (_) {}
    }
    try { await target.close(); } catch (_) {}
  }
}

module.exports = { migrateStorage };
