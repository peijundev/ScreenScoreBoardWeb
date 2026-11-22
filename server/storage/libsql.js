'use strict';
// libSQL / Turso 后端：SQLite 兼容 SQL，支持远程 libsql:// 与本地 file:；可选分块快照。
const { importDriver, StorageConflictError } = require('./common');
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
function createLibsqlStorage(options = {}) {
  /** @type {any} */
  let client = null;
  let revision = 0;
  let lastSaveAt = 0;
  let lastError = /** @type {string|null} */ (null);

  async function exec(sql, args = []) {
    return client.execute({ sql, args });
  }

  async function currentRevision() {
    const result = await exec('SELECT revision FROM scoreboard_state WHERE id = ?', ['state']);
    return result.rows.length ? Number(result.rows[0].revision) || 0 : 0;
  }

  async function readStateRow() {
    return exec('SELECT data, revision FROM scoreboard_state WHERE id = ?', ['state']);
  }

  async function currentManifest() {
    const result = await readStateRow();
    return result.rows.length ? parseChunkManifest(result.rows[0].data) : null;
  }

  async function readChunkRow(manifest, chunk) {
    const result = await exec('SELECT data FROM scoreboard_state WHERE id = ?', [
      chunkRowId(manifest, chunk),
    ]);
    return result.rows.length ? result.rows[0].data : null;
  }

  async function writeChunkRows(ids, parts) {
    const now = Date.now();
    for (let i = 0; i < ids.length; i += 1) {
      await exec(
        'INSERT INTO scoreboard_state (id, data, revision, updated_at) VALUES (?, ?, 0, ?) ' +
        'ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at',
        [ids[i], parts[i], now],
      );
    }
  }

  async function deleteChunkRows(ids) {
    for (const id of ids) {
      await exec('DELETE FROM scoreboard_state WHERE id = ?', [id]);
    }
  }

  async function savePlain(json, expectedRevision) {
    const now = Date.now();
    if (expectedRevision === undefined) {
      const result = await exec(
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
      const result = await exec(
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
    const result = await exec(
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
    kind: 'libsql',
    capabilities: {
      cas: true,
      revision: 'integer',
      distributedLock: false,
      lockKind: null,
      snapshot: 'row',
    },
    async init() {
      if (!options.url) throw new Error('libSQL 需要数据库 URL');
      const mod = await importDriver('@libsql/client', 'libSQL');
      const createClient = mod.createClient || (mod.default && mod.default.createClient);
      if (typeof createClient !== 'function') {
        throw new Error('@libsql/client 缺少 createClient 导出');
      }
      if (client) {
        try { client.close(); } catch (_) {}
      }
      client = createClient({
        url: String(options.url),
        authToken: options.authToken ? String(options.authToken) : undefined,
      });
      await exec(
        'CREATE TABLE IF NOT EXISTS scoreboard_state (' +
        'id TEXT PRIMARY KEY, data TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)',
      );
      const columns = await exec("PRAGMA table_info('scoreboard_state')");
      if (!columns.rows.some((column) => column.name === 'revision')) {
        await exec('ALTER TABLE scoreboard_state ADD COLUMN revision INTEGER NOT NULL DEFAULT 0');
      }
      await exec("UPDATE scoreboard_state SET revision = 1 WHERE id = 'state' AND revision = 0");
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
      try { if (client) client.close(); } catch (_) {}
      client = null;
    },
    /** @param {{ probe?: boolean }} [healthOptions] */
    async health({ probe } = {}) {
      let ok = true;
      let latencyMs = 0;
      const warnings = [];
      if (probe && client) {
        try {
          const started = Date.now();
          await exec('SELECT 1');
          latencyMs = Date.now() - started;
        } catch (error) {
          ok = false;
          warnings.push(error && error.message ? error.message : String(error));
        }
      }
      return {
        ok,
        kind: 'libsql',
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
      await exec("DELETE FROM scoreboard_state WHERE id = 'state' OR id LIKE 'chunk:%'");
      revision = 0;
    },
  };
}

module.exports = { createLibsqlStorage };
