'use strict';
// PostgreSQL 后端：pg 连接池，单表单行快照 + revision CAS + advisory lock；可选分块快照。
const { requireDriver, StorageConflictError, sleep } = require('./common');
const {
  normalizeChunkOptions,
  createChunkPlan,
  parseChunkManifest,
  chunkRowId,
  collectChunkIds,
  assembleChunks,
} = require('./chunking');

const LOCK_KEY_SQL = "hashtext('screenscoreboard:state')";

/**
 * @param {Record<string, any>} [options]
 */
function createPostgresStorage(options = {}) {
  /** @type {any} */
  let pool = null;
  /** @type {any} */
  let lockClient = null;
  let revision = 0;
  let lastSaveAt = 0;
  let lastError = /** @type {string|null} */ (null);

  async function currentRevision() {
    const result = await pool.query('SELECT revision FROM scoreboard_state WHERE id = $1', ['state']);
    return result.rows.length ? Number(result.rows[0].revision) || 0 : 0;
  }

  async function readStateRow() {
    return pool.query('SELECT data, revision FROM scoreboard_state WHERE id = $1', ['state']);
  }

  async function currentManifest() {
    const result = await readStateRow();
    return result.rows.length ? parseChunkManifest(result.rows[0].data) : null;
  }

  async function readChunkRow(manifest, chunk) {
    const result = await pool.query('SELECT data FROM scoreboard_state WHERE id = $1', [
      chunkRowId(manifest, chunk),
    ]);
    return result.rows.length ? result.rows[0].data : null;
  }

  async function writeChunkRows(ids, parts) {
    const now = Date.now();
    for (let i = 0; i < ids.length; i += 1) {
      await pool.query(
        'INSERT INTO scoreboard_state (id, data, revision, updated_at) VALUES ($1, $2, 0, $3) ' +
        'ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at',
        [ids[i], parts[i], now],
      );
    }
  }

  async function deleteChunkRows(ids) {
    for (const id of ids) {
      await pool.query('DELETE FROM scoreboard_state WHERE id = $1', [id]);
    }
  }

  async function savePlain(json, expectedRevision) {
    const now = Date.now();
    if (expectedRevision === undefined) {
      const result = await pool.query(
        'INSERT INTO scoreboard_state (id, data, revision, updated_at) VALUES ($1, $2, 1, $3) ' +
        'ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, ' +
        'revision = scoreboard_state.revision + 1, updated_at = EXCLUDED.updated_at ' +
        'RETURNING revision',
        ['state', json, now],
      );
      return Number(result.rows[0].revision);
    }
    const expected = expectedRevision === null ? 0 : Number(expectedRevision);
    if (expected === 0) {
      const result = await pool.query(
        'INSERT INTO scoreboard_state (id, data, revision, updated_at) VALUES ($1, $2, 1, $3) ' +
        'ON CONFLICT (id) DO NOTHING RETURNING revision',
        ['state', json, now],
      );
      if (!result.rows.length) {
        throw new StorageConflictError('状态已被其他实例写入，拒绝覆盖', {
          currentRevision: await currentRevision(),
        });
      }
      return Number(result.rows[0].revision);
    }
    const result = await pool.query(
      'UPDATE scoreboard_state SET data = $1, revision = revision + 1, updated_at = $2 ' +
      "WHERE id = 'state' AND revision = $3 RETURNING revision",
      [json, now, expected],
    );
    if (!result.rows.length) {
      throw new StorageConflictError('状态已被其他实例修改，拒绝覆盖', {
        currentRevision: await currentRevision(),
      });
    }
    return Number(result.rows[0].revision);
  }

  const capabilities = {
    cas: true,
    revision: 'integer',
    distributedLock: true,
    lockKind: 'pg-advisory',
    snapshot: 'row',
  };

  return {
    kind: 'postgres',
    capabilities,
    async init() {
      const pg = requireDriver('pg', 'PostgreSQL');
      /** @type {Record<string, any>} */
      const opts = {
        connectionTimeoutMillis: Number(options.connectTimeoutMs || process.env.PG_CONNECT_TIMEOUT_MS) || 5000,
        max: Number(options.maxPool) || 10,
      };
      const url = options.url || process.env.DATABASE_URL;
      if (url) {
        opts.connectionString = url;
      } else {
        if (options.host || process.env.PGHOST) opts.host = options.host || process.env.PGHOST;
        if (options.port || process.env.PGPORT) opts.port = Number(options.port || process.env.PGPORT);
        if (options.user || process.env.PGUSER) opts.user = options.user || process.env.PGUSER;
        if (options.password || process.env.PGPASSWORD) opts.password = options.password || process.env.PGPASSWORD;
        if (options.database || process.env.PGDATABASE) opts.database = options.database || process.env.PGDATABASE;
      }
      opts.ssl = Boolean(options.ssl);
      pool = new pg.Pool(opts);
      await pool.query(
        'CREATE TABLE IF NOT EXISTS scoreboard_state (' +
        'id TEXT PRIMARY KEY, data TEXT NOT NULL, revision BIGINT NOT NULL DEFAULT 0, updated_at BIGINT NOT NULL)',
      );
      await pool.query('ALTER TABLE scoreboard_state ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 0');
      await pool.query("UPDATE scoreboard_state SET revision = 1 WHERE id = 'state' AND revision = 0");
      revision = await currentRevision();
      // CockroachDB / YugabyteDB 等协议兼容服务没有 advisory lock。
      if (options.lockMode === 'none') {
        capabilities.distributedLock = false;
        capabilities.lockKind = null;
      }
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
    /**
     * @param {string} ownerId
     * @param {{ waitMs?: number }} [lockOptions]
     */
    async acquireLock(ownerId, lockOptions = {}) {
      void ownerId;
      if (!pool) throw new Error('PostgreSQL 存储尚未初始化');
      const waitMs = Number(lockOptions.waitMs) || 0;
      const client = await pool.connect();
      const deadline = Date.now() + waitMs;
      try {
        for (;;) {
          const result = await client.query(`SELECT pg_try_advisory_lock(${LOCK_KEY_SQL}) AS ok`);
          if (result.rows[0].ok) {
            lockClient = client;
            return { kind: 'pg-advisory' };
          }
          if (Date.now() >= deadline) {
            throw new Error('无法获取 PostgreSQL 存储锁：已有另一个实例在使用同一数据库');
          }
          await sleep(200);
        }
      } catch (error) {
        try { client.release(); } catch (_) {}
        throw error;
      }
    },
    async releaseLock() {
      if (!lockClient) return;
      try {
        await lockClient.query(`SELECT pg_advisory_unlock(${LOCK_KEY_SQL})`);
      } finally {
        try { lockClient.release(); } catch (_) {}
        lockClient = null;
      }
    },
    async close() {
      try { await this.releaseLock(); } catch (_) {}
      try { if (pool) await pool.end(); } catch (_) {}
      pool = null;
    },
    /** @param {{ probe?: boolean }} [healthOptions] */
    async health({ probe } = {}) {
      let ok = true;
      let latencyMs = 0;
      const warnings = [];
      if (probe && pool) {
        try {
          const started = Date.now();
          await pool.query('SELECT 1');
          latencyMs = Date.now() - started;
        } catch (error) {
          ok = false;
          warnings.push(error && error.message ? error.message : String(error));
        }
      }
      return {
        ok,
        kind: 'postgres',
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
      await pool.query("DELETE FROM scoreboard_state WHERE id = 'state' OR id LIKE 'chunk:%'");
      revision = 0;
    },
  };
}

module.exports = { createPostgresStorage };
