'use strict';
// Google Cloud Firestore 后端：单个文档快照 + 事务内 revision CAS。
// 认证优先使用 ADC / Workload Identity；也可指定 keyFilename。
const { requireDriver, StorageError, StorageConflictError } = require('./common');

const DOC_ID = 'state';

/**
 * @param {Record<string, any>} [options]
 */
function createFirestoreStorage(options = {}) {
  const projectId = String(options.projectId || process.env.GOOGLE_CLOUD_PROJECT || '');
  const databaseId = String(options.databaseId || '(default)');
  const collectionName = String(options.collection || 'scoreboard_state');
  /** @type {any} */
  let firestore = null;
  /** @type {any} */
  let docRef = null;
  let revision = 0;
  let lastSaveAt = 0;
  let lastError = /** @type {string|null} */ (null);

  function conflict(current) {
    return new StorageConflictError('状态已被其他实例修改，拒绝覆盖', {
      currentRevision: current,
    });
  }

  function mapError(error) {
    if (!error) return error;
    const code = error.code;
    if (code === 5 || code === '5' || code === 'NOT_FOUND' || error.name === 'NotFoundError') {
      return new StorageError(
        'Firestore 项目或数据库不存在，请检查 projectId / databaseId',
        { code: 'STORAGE_CONFIG_INVALID' },
      );
    }
    if (
      code === 7 || code === '7' || code === 16 || code === '16' ||
      code === 'PERMISSION_DENIED' || code === 'UNAUTHENTICATED' ||
      error.name === 'PermissionDeniedError' || error.name === 'UnauthenticatedError'
    ) {
      return new StorageError(
        'Firestore 认证或权限失败，请检查 ADC、Workload Identity 或服务账号权限',
        { code: 'STORAGE_AUTH' },
      );
    }
    return error;
  }

  async function readSnapshot() {
    return docRef.get();
  }

  async function currentRevision() {
    const snap = await readSnapshot();
    return snap.exists ? Number(snap.get('revision')) || 0 : 0;
  }

  return {
    kind: 'firestore',
    capabilities: {
      cas: true,
      revision: 'integer',
      distributedLock: false,
      lockKind: null,
      snapshot: 'document',
    },
    async init() {
      if (!projectId) {
        throw new StorageError('Firestore 需要 projectId', { code: 'STORAGE_CONFIG_INVALID' });
      }
      if (typeof options.clientFactory === 'function') {
        firestore = options.clientFactory({ projectId, databaseId });
      } else {
        const mod = requireDriver('@google-cloud/firestore', 'Firestore');
        const Firestore = mod.Firestore || (mod.default && mod.default.Firestore);
        if (typeof Firestore !== 'function') {
          throw new Error('@google-cloud/firestore 缺少 Firestore 导出');
        }
        /** @type {Record<string, any>} */
        const config = { projectId, databaseId };
        if (options.keyFilename) config.keyFilename = String(options.keyFilename);
        firestore = new Firestore(config);
      }
      docRef = firestore.collection(collectionName).doc(DOC_ID);
      try {
        await readSnapshot();
      } catch (error) {
        throw mapError(error);
      }
      revision = await currentRevision();
    },
    async load() {
      try {
        const snap = await readSnapshot();
        if (!snap.exists) {
          revision = 0;
          return null;
        }
        revision = Number(snap.get('revision')) || 0;
        const data = snap.get('data');
        if (typeof data !== 'string') return null;
        try { return JSON.parse(data); } catch (_) { return null; }
      } catch (error) {
        throw mapError(error);
      }
    },
    /**
     * @param {any} state
     * @param {{ expectedRevision?: any }} [saveOptions]
     */
    async save(state, { expectedRevision } = {}) {
      const json = JSON.stringify(state);
      const now = Date.now();
      try {
        const next = await firestore.runTransaction(async (tx) => {
          const snap = await tx.get(docRef);
          const current = snap.exists ? Number(snap.get('revision')) || 0 : 0;
          if (expectedRevision !== undefined) {
            const expected = expectedRevision === null ? 0 : Number(expectedRevision);
            if (current !== expected) throw conflict(current);
          }
          const nextRevision = current + 1;
          tx.set(docRef, { data: json, revision: nextRevision, updatedAt: now });
          return nextRevision;
        });
        revision = next;
        lastSaveAt = Date.now();
        lastError = null;
        return { revision };
      } catch (error) {
        const mapped = mapError(error);
        lastError = mapped && mapped.message ? mapped.message : String(mapped);
        throw mapped;
      }
    },
    async close() {
      try {
        if (firestore && typeof firestore.terminate === 'function') {
          await firestore.terminate();
        }
      } catch (_) {}
      firestore = null;
      docRef = null;
    },
    /** @param {{ probe?: boolean }} [healthOptions] */
    async health({ probe } = {}) {
      let ok = true;
      let latencyMs = 0;
      const warnings = [];
      if (probe && docRef) {
        try {
          const started = Date.now();
          await readSnapshot();
          latencyMs = Date.now() - started;
        } catch (error) {
          ok = false;
          warnings.push(error && error.message ? error.message : String(error));
        }
      }
      return {
        ok,
        kind: 'firestore',
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
      await docRef.delete();
      revision = 0;
    },
  };
}

module.exports = { createFirestoreStorage };
