'use strict';
// etcd 后端：通过 v3 HTTP/JSON gateway 访问，使用 key 的 version 做 CAS。
// 零新依赖；仅 CAS，不提供 lease 分布式锁。
const { StorageError, StorageConflictError } = require('./common');

/**
 * @param {Record<string, any>} [options]
 */
function createEtcdStorage(options = {}) {
  let baseUrl = '';
  let key = '';
  let token = '';
  let timeoutMs = 15000;
  let revision = 0;
  let lastSaveAt = 0;
  let lastError = /** @type {string|null} */ (null);

  function configError(message) {
    return new StorageError(message, { code: 'STORAGE_CONFIG_INVALID' });
  }

  function encode(value) {
    return Buffer.from(String(value), 'utf8').toString('base64');
  }

  function decode(value) {
    return Buffer.from(String(value || ''), 'base64').toString('utf8');
  }

  async function post(path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    /** @type {Record<string, string>} */
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (token && path !== '/v3/auth/authenticate') headers.Authorization = token;
    let res;
    try {
      res = await fetch(baseUrl + path, {
        method: 'POST',
        headers,
        body: JSON.stringify(body || {}),
        signal: controller.signal,
      });
    } catch (error) {
      const message = error && error.name === 'AbortError'
        ? `etcd 请求超时（${timeoutMs}ms）`
        : `etcd 请求失败：${error && error.message ? error.message : String(error)}`;
      throw new StorageError(message, { code: 'STORAGE_NETWORK', retryable: true });
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let payload = null;
    if (text) {
      try { payload = JSON.parse(text); } catch (_) { payload = null; }
    }
    if (!res.ok) {
      const auth = res.status === 401 || res.status === 403;
      const message = (payload && (payload.message || payload.error)) || `HTTP ${res.status}`;
      throw new StorageError(`etcd 请求失败：${message}`, {
        code: auth ? 'STORAGE_AUTH' : 'STORAGE_ERROR',
        retryable: res.status === 429 || res.status >= 500,
      });
    }
    return payload || {};
  }

  async function range() {
    const payload = await post('/v3/kv/range', { key: encode(key) });
    const kv = Array.isArray(payload.kvs) ? payload.kvs[0] : null;
    if (!kv) return null;
    return {
      value: decode(kv.value),
      version: Number(kv.version) || 0,
    };
  }

  async function currentVersion() {
    const current = await range();
    return current ? current.version : 0;
  }

  async function safeCurrentVersion() {
    try {
      return await currentVersion();
    } catch (_) {
      return null;
    }
  }

  async function put(value) {
    await post('/v3/kv/put', { key: encode(key), value: encode(value) });
    return currentVersion();
  }

  async function compareAndPut(expected, value) {
    const payload = await post('/v3/kv/txn', {
      compare: [{
        key: encode(key),
        target: 'VERSION',
        result: 'EQUAL',
        version: String(expected),
      }],
      success: [{
        requestPut: {
          key: encode(key),
          value: encode(value),
        },
      }],
      failure: [],
    });
    return Boolean(payload.succeeded);
  }

  return {
    kind: 'etcd',
    capabilities: {
      cas: true,
      revision: 'integer',
      distributedLock: false,
      lockKind: null,
      snapshot: 'row',
    },
    async init() {
      if (!options.endpoint) throw configError('etcd 需要 Endpoint，例如 http://127.0.0.1:2379');
      let parsed;
      try {
        parsed = new URL(String(options.endpoint));
      } catch (_) {
        throw configError('etcd Endpoint 格式不正确');
      }
      if (!/^https?:$/.test(parsed.protocol)) {
        throw configError('etcd Endpoint 必须是 http:// 或 https://');
      }
      baseUrl = parsed.toString().replace(/\/+$/, '');
      timeoutMs = Number(options.requestTimeoutMs) || 15000;
      const prefix = String(options.prefix || 'scoreboard').replace(/^\/+|\/+$/g, '');
      key = (prefix ? prefix + '/' : '') + 'state';

      const username = String(options.username || '');
      if (username) {
        const auth = await post('/v3/auth/authenticate', {
          name: username,
          password: String(options.password || ''),
        });
        token = String(auth.token || '');
        if (!token) throw new StorageError('etcd 认证未返回 token', { code: 'STORAGE_AUTH' });
      }
      const current = await range();
      revision = current ? current.version : 0;
    },
    async load() {
      const current = await range();
      if (!current) {
        revision = 0;
        return null;
      }
      revision = current.version;
      try { return JSON.parse(current.value); } catch (_) { return null; }
    },
    /**
     * @param {any} state
     * @param {{ expectedRevision?: any }} [saveOptions]
     */
    async save(state, { expectedRevision } = {}) {
      const json = JSON.stringify(state);
      try {
        if (expectedRevision === undefined) {
          revision = await put(json);
        } else {
          const expected = expectedRevision === null ? 0 : Number(expectedRevision);
          const ok = await compareAndPut(expected, json);
          if (!ok) {
            throw new StorageConflictError('状态已被其他实例修改，拒绝覆盖', {
              currentRevision: await safeCurrentVersion(),
            });
          }
          revision = await currentVersion();
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
      // fetch 无持久连接需要释放。
    },
    /** @param {{ probe?: boolean }} [healthOptions] */
    async health({ probe } = {}) {
      let ok = true;
      let latencyMs = 0;
      const warnings = [];
      if (probe && baseUrl) {
        try {
          const started = Date.now();
          await range();
          latencyMs = Date.now() - started;
        } catch (error) {
          ok = false;
          warnings.push(error && error.message ? error.message : String(error));
        }
      }
      return {
        ok,
        kind: 'etcd',
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
      await post('/v3/kv/deleterange', { key: encode(key) });
      revision = 0;
    },
  };
}

module.exports = { createEtcdStorage };
