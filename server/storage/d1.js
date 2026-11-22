'use strict';
// Cloudflare D1 后端：通过 REST API 执行 SQL，整份状态保存在 scoreboard_state 表。
// 不使用厂商 SDK，仅依赖 Node 24 的全局 fetch；可选分块快照。
const { StorageError, StorageConflictError } = require('./common');
const {
  normalizeChunkOptions,
  createChunkPlan,
  parseChunkManifest,
  chunkRowId,
  collectChunkIds,
  assembleChunks,
} = require('./chunking');

/**
 * @param {Record<string, any>} [options]
 */
function createD1Storage(options = {}) {
  let apiUrl = '';
  let apiToken = '';
  let timeoutMs = 15000;
  let revision = 0;
  let lastSaveAt = 0;
  let lastError = /** @type {string|null} */ (null);

  function configError(message) {
    return new StorageError(message, { code: 'STORAGE_CONFIG_INVALID' });
  }

  async function query(sql, params = []) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    let res;
    try {
      res = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + apiToken,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ sql, params }),
        signal: controller.signal,
      });
    } catch (error) {
      const message = error && error.name === 'AbortError'
        ? `Cloudflare D1 请求超时（${timeoutMs}ms）`
        : `Cloudflare D1 请求失败：${error && error.message ? error.message : String(error)}`;
      throw new StorageError(message, { code: 'STORAGE_NETWORK', retryable: true });
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let payload = null;
    if (text) {
      try { payload = JSON.parse(text); } catch (_) { payload = null; }
    }
    if (!res.ok || !payload || payload.success === false) {
      const errors = payload && Array.isArray(payload.errors) ? payload.errors : [];
      const detail = errors.length
        ? errors.map((item) => item && (item.message || item.code)).filter(Boolean).join('; ')
        : `HTTP ${res.status}`;
      const auth = res.status === 401 || res.status === 403;
      throw new StorageError(`Cloudflare D1 请求失败：${detail}`, {
        code: auth ? 'STORAGE_AUTH' : 'STORAGE_ERROR',
        retryable: res.status === 429 || res.status >= 500,
      });
    }

    const first = Array.isArray(payload.result) ? payload.result[0] : payload.result;
    const rows = first && Array.isArray(first.results) ? first.results : [];
    const changes = first && first.meta ? Number(first.meta.changes) || 0 : 0;
    return { rows, changes };
  }

  async function currentRevision() {
    const result = await query('SELECT revision FROM scoreboard_state WHERE id = ?', ['state']);
    return result.rows.length ? Number(result.rows[0].revision) || 0 : 0;
  }

  async function readStateRow() {
    return query('SELECT data, revision FROM scoreboard_state WHERE id = ?', ['state']);
  }

  async function currentManifest() {
    const result = await readStateRow();
    return result.rows.length ? parseChunkManifest(result.rows[0].data) : null;
  }

  async function readChunkRow(manifest, chunk) {
    const result = await query('SELECT data FROM scoreboard_state WHERE id = ?', [
      chunkRowId(manifest, chunk),
    ]);
    return result.rows.length ? result.rows[0].data : null;
  }

  async function writeChunkRows(ids, parts) {
    const now = Date.now();
    for (let i = 0; i < ids.length; i += 1) {
      await query(
        'INSERT INTO scoreboard_state (id, data, revision, updated_at) VALUES (?, ?, 0, ?) ' +
        'ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at',
        [ids[i], parts[i], now],
      );
    }
  }

  async function deleteChunkRows(ids) {
    for (const id of ids) {
      await query('DELETE FROM scoreboard_state WHERE id = ?', [id]);
    }
  }

  async function savePlain(json, expectedRevision) {
    const now = Date.now();
    if (expectedRevision === undefined) {
      const result = await query(
        'INSERT INTO scoreboard_state (id, data, revision, updated_at) VALUES (?, ?, 1, ?) ' +
        'ON CONFLICT(id) DO UPDATE SET data = excluded.data, ' +
        'revision = scoreboard_state.revision + 1, updated_at = excluded.updated_at ' +
        'RETURNING revision',
        ['state', json, now],
      );
      return Number(result.rows[0].revision);
    }
    const expected = expectedRevision === null ? 0 : Number(expectedRevision);
    if (expected === 0) {
      const result = await query(
        'INSERT INTO scoreboard_state (id, data, revision, updated_at) VALUES (?, ?, 1, ?) ' +
        'ON CONFLICT(id) DO NOTHING RETURNING revision',
        ['state', json, now],
      );
      if (!result.rows.length) {
        throw new StorageConflictError('状态已被其他实例写入，拒绝覆盖', {
          currentRevision: await currentRevision(),
        });
      }
      return Number(result.rows[0].revision);
    }
    const result = await query(
      'UPDATE scoreboard_state SET data = ?, revision = revision + 1, updated_at = ? ' +
      "WHERE id = 'state' AND revision = ? RETURNING revision",
      [json, now, expected],
    );
    if (!result.rows.length) {
      throw new StorageConflictError('状态已被其他实例修改，拒绝覆盖', {
        currentRevision: await currentRevision(),
      });
    }
    return Number(result.rows[0].revision);
  }

  return {
    kind: 'd1',
    capabilities: {
      cas: true,
      revision: 'integer',
      distributedLock: false,
      lockKind: null,
      snapshot: 'row',
    },
    async init() {
      if (!options.accountId || !options.databaseId || !options.apiToken) {
        throw configError('Cloudflare D1 需要账户 ID、数据库 ID 与 API Token');
      }
      let endpoint;
      try {
        endpoint = new URL(String(options.endpoint || 'https://api.cloudflare.com'));
      } catch (_) {
        throw configError('Cloudflare D1 API 地址格式不正确');
      }
      if (!/^https?:$/.test(endpoint.protocol)) {
        throw configError('Cloudflare D1 API 地址必须是 http:// 或 https://');
      }
      apiToken = String(options.apiToken);
      timeoutMs = Number(options.requestTimeoutMs) || 15000;
      apiUrl = endpoint.toString().replace(/\/+$/, '') +
        '/client/v4/accounts/' + encodeURIComponent(String(options.accountId)) +
        '/d1/database/' + encodeURIComponent(String(options.databaseId)) + '/query';

      await query(
        'CREATE TABLE IF NOT EXISTS scoreboard_state (' +
        'id TEXT PRIMARY KEY, data TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)',
      );
      await query("UPDATE scoreboard_state SET revision = 1 WHERE id = 'state' AND revision = 0");
      revision = await currentRevision();
    },
    async load() {
      const result = await readStateRow();
      if (!result.rows.length) {
        revision = 0;
        return null;
      }
      revision = Number(result.rows[0].revision) || 0;
      const manifest = parseChunkManifest(result.rows[0].data);
      if (manifest) {
        try {
          const json = await assembleChunks(manifest, (chunk) => readChunkRow(manifest, chunk));
          return JSON.parse(json);
        } catch (_) {
          return null;
        }
      }
      try { return JSON.parse(result.rows[0].data); } catch (_) { return null; }
    },
    /**
     * @param {any} state
     * @param {{ expectedRevision?: any }} [saveOptions]
     */
    async save(state, { expectedRevision } = {}) {
      const json = JSON.stringify(state);
      const chunkOptions = normalizeChunkOptions(options);
      try {
        const previous = await currentManifest();
        if (!chunkOptions.enabled) {
          const next = await savePlain(json, expectedRevision);
          if (previous) {
            try { await deleteChunkRows(collectChunkIds(previous)); } catch (_) {}
          }
          revision = next;
          lastSaveAt = Date.now();
          lastError = null;
          return { revision: next };
        }

        const plan = createChunkPlan(json, chunkOptions);
        const ids = plan.manifest.chunks.map((chunk) => chunkRowId(plan.manifest, chunk));
        await writeChunkRows(ids, plan.parts);
        try {
          const next = await savePlain(JSON.stringify(plan.manifest), expectedRevision);
          revision = next;
          lastSaveAt = Date.now();
          lastError = null;
          if (previous) {
            try { await deleteChunkRows(collectChunkIds(previous)); } catch (_) {}
          }
          return { revision: next };
        } catch (error) {
          try { await deleteChunkRows(ids); } catch (_) {}
          throw error;
        }
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
      if (probe && apiUrl) {
        try {
          const started = Date.now();
          await query('SELECT 1');
          latencyMs = Date.now() - started;
        } catch (error) {
          ok = false;
          warnings.push(error && error.message ? error.message : String(error));
        }
      }
      return {
        ok,
        kind: 'd1',
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
      await query("DELETE FROM scoreboard_state WHERE id = 'state' OR id LIKE 'chunk:%'");
      revision = 0;
    },
  };
}

module.exports = { createD1Storage };
