'use strict';
// CouchDB 后端：整份状态保存在 _id=state 的单个文档中。
// 使用文档的 _rev 做原子条件写，另存整数 revision 与外部 CAS 语义对齐。
const { StorageError, StorageConflictError } = require('./common');

const DOC_ID = 'state';

/**
 * @param {Record<string, any>} [options]
 */
function createCouchdbStorage(options = {}) {
  let baseUrl = '';
  let dbUrl = '';
  let authHeader = '';
  let timeoutMs = 15000;
  let revision = 0;
  let lastSaveAt = 0;
  let lastError = /** @type {string|null} */ (null);

  function asStorageError(status, payload, fallback = 'CouchDB 请求失败') {
    const reason = payload && (payload.reason || payload.error);
    const message = reason ? `${fallback}：${reason}` : `${fallback}（HTTP ${status}）`;
    const auth = status === 401 || status === 403;
    return new StorageError(message, {
      code: auth ? 'STORAGE_AUTH' : 'STORAGE_ERROR',
      retryable: status === 429 || status >= 500,
    });
  }

  async function request(method, url, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    /** @type {Record<string, string>} */
    const headers = { Accept: 'application/json' };
    if (authHeader) headers.Authorization = authHeader;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    try {
      const res = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      let payload = null;
      if (text) {
        try { payload = JSON.parse(text); } catch (_) { payload = null; }
      }
      return { status: res.status, ok: res.ok, payload };
    } catch (error) {
      const message = error && error.name === 'AbortError'
        ? `CouchDB 请求超时（${timeoutMs}ms）`
        : `CouchDB 请求失败：${error && error.message ? error.message : String(error)}`;
      throw new StorageError(message, { code: 'STORAGE_NETWORK', retryable: true });
    } finally {
      clearTimeout(timer);
    }
  }

  async function getDoc() {
    const res = await request('GET', dbUrl + '/' + DOC_ID);
    if (res.status === 404) return null;
    if (!res.ok) throw asStorageError(res.status, res.payload, '读取 CouchDB 文档失败');
    return res.payload;
  }

  async function safeCurrentRevision() {
    try {
      const doc = await getDoc();
      return doc ? Number(doc.revision) || 0 : 0;
    } catch (_) {
      return null;
    }
  }

  function docBody(json, nextRevision, now, doc) {
    /** @type {Record<string, any>} */
    const body = { data: json, revision: nextRevision, updatedAt: now };
    if (doc && doc._rev) body._rev = doc._rev;
    return body;
  }

  return {
    kind: 'couchdb',
    capabilities: {
      cas: true,
      revision: 'integer',
      distributedLock: false,
      lockKind: null,
      snapshot: 'document',
    },
    async init() {
      if (!options.url) throw new Error('CouchDB 需要服务 URL');
      let parsed;
      try {
        parsed = new URL(String(options.url));
      } catch (_) {
        throw new StorageError('CouchDB URL 格式不正确', { code: 'STORAGE_CONFIG_INVALID' });
      }
      if (!/^https?:$/.test(parsed.protocol)) {
        throw new StorageError('CouchDB URL 必须是 http:// 或 https://', { code: 'STORAGE_CONFIG_INVALID' });
      }
      const embeddedUser = decodeURIComponent(parsed.username || '');
      const embeddedPassword = decodeURIComponent(parsed.password || '');
      const user = String(options.user || embeddedUser || '');
      const password = String(options.password || embeddedPassword || '');
      if (user) {
        authHeader = 'Basic ' + Buffer.from(user + ':' + password, 'utf8').toString('base64');
      }
      parsed.username = '';
      parsed.password = '';
      baseUrl = parsed.toString().replace(/\/+$/, '');
      timeoutMs = Number(options.requestTimeoutMs) || 15000;
      const database = String(options.database || 'scoreboard');
      dbUrl = baseUrl + '/' + encodeURIComponent(database);

      const res = await request('PUT', dbUrl);
      if (res.status === 201 || res.status === 202 || res.status === 412) return;
      throw asStorageError(res.status, res.payload, '创建 CouchDB 数据库失败');
    },
    async load() {
      const doc = await getDoc();
      if (!doc) {
        revision = 0;
        return null;
      }
      revision = Number(doc.revision) || 0;
      if (typeof doc.data !== 'string') return null;
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
          // 无条件写：先取当前 _rev，再条件 PUT；409 时重试有限次数。
          for (let attempt = 0; attempt < 3; attempt += 1) {
            const doc = await getDoc();
            const next = (doc ? Number(doc.revision) || 0 : 0) + 1;
            const res = await request('PUT', dbUrl + '/' + DOC_ID, docBody(json, next, now, doc));
            if (res.ok) {
              revision = next;
              lastSaveAt = Date.now();
              lastError = null;
              return { revision };
            }
            if (res.status !== 409) throw asStorageError(res.status, res.payload, '写入 CouchDB 文档失败');
          }
          throw new StorageConflictError('CouchDB 并发写入冲突，请重试', {
            currentRevision: await safeCurrentRevision(),
          });
        }

        const expected = expectedRevision === null ? 0 : Number(expectedRevision);
        if (expected === 0) {
          const res = await request('PUT', dbUrl + '/' + DOC_ID, docBody(json, 1, now, null));
          if (res.ok) {
            revision = 1;
            lastSaveAt = Date.now();
            lastError = null;
            return { revision };
          }
          if (res.status === 409) {
            throw new StorageConflictError('状态已被其他实例写入，拒绝覆盖', {
              currentRevision: await safeCurrentRevision(),
            });
          }
          throw asStorageError(res.status, res.payload, '创建 CouchDB 文档失败');
        }

        const doc = await getDoc();
        const current = doc ? Number(doc.revision) || 0 : 0;
        if (!doc || current !== expected) {
          throw new StorageConflictError('状态已被其他实例修改，拒绝覆盖', {
            currentRevision: current,
          });
        }
        const res = await request('PUT', dbUrl + '/' + DOC_ID, docBody(json, expected + 1, now, doc));
        if (res.ok) {
          revision = expected + 1;
          lastSaveAt = Date.now();
          lastError = null;
          return { revision };
        }
        if (res.status === 409) {
          throw new StorageConflictError('状态已被其他实例修改，拒绝覆盖', {
            currentRevision: await safeCurrentRevision(),
          });
        }
        throw asStorageError(res.status, res.payload, '写入 CouchDB 文档失败');
      } catch (error) {
        lastError = error && error.message ? error.message : String(error);
        throw error;
      }
    },
    async close() {
      // fetch 无持久连接需要释放。
    },
    /** @param {{ probe?: boolean }} [healthOptions] */
    async health({ probe } = {}) {
      let ok = true;
      let latencyMs = 0;
      const warnings = [];
      if (probe && dbUrl) {
        try {
          const started = Date.now();
          const res = await request('GET', dbUrl);
          latencyMs = Date.now() - started;
          if (!res.ok) {
            ok = false;
            warnings.push(res.payload && res.payload.reason
              ? String(res.payload.reason)
              : `CouchDB 数据库不可用（HTTP ${res.status}）`);
          }
        } catch (error) {
          ok = false;
          warnings.push(error && error.message ? error.message : String(error));
        }
      }
      return {
        ok,
        kind: 'couchdb',
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
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const doc = await getDoc();
        if (!doc) {
          revision = 0;
          return;
        }
        const res = await request(
          'DELETE',
          dbUrl + '/' + DOC_ID + '?rev=' + encodeURIComponent(String(doc._rev || '')),
        );
        if (res.ok || res.status === 404) {
          revision = 0;
          return;
        }
        if (res.status !== 409) {
          throw asStorageError(res.status, res.payload, '删除 CouchDB 文档失败');
        }
      }
      throw new StorageConflictError('删除 CouchDB 文档时发生并发冲突', {
        currentRevision: await safeCurrentRevision(),
      });
    },
  };
}

module.exports = { createCouchdbStorage };
