'use strict';
// PostgreSQL 后端：pg 连接池，单表单行快照 + revision CAS + advisory lock。
const { requireDriver, StorageConflictError, sleep } = require('./common');

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

  return {
    kind: 'postgres',
    capabilities: {
      cas: true,
      revision: 'integer',
      distributedLock: true,
      lockKind: 'pg-advisory',
      snapshot: 'row',
    },
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
      const row = await pool.query('SELECT revision FROM scoreboard_state WHERE id = $1', ['state']);
      revision = row.rows.length ? Number(row.rows[0].revision) || 0 : 0;
    },
    async load() {
      const result = await pool.query('SELECT data, revision FROM scoreboard_state WHERE id = $1', ['state']);
      if (!result.rows.length) {
        revision = 0;
        return null;
      }
      revision = Number(result.rows[0].revision) || 0;
      try { return JSON.parse(result.rows[0].data); } catch (_) { return null; }
    },
    /**
     * @param {any} state
     * @param {{ expectedRevision?: any }} [syncOptions]
     */
    async save(state, { expectedRevision } = {}) {
      const json = JSON.stringify(state);
      const now = Date.now();
      try {
        if (expectedRevision === undefined) {
          const result = await pool.query(
            'INSERT INTO scoreboard_state (id, data, revision, updated_at) VALUES ($1, $2, 1, $3) ' +
            'ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, ' +
            'revision = scoreboard_state.revision + 1, updated_at = EXCLUDED.updated_at ' +
            'RETURNING revision',
            ['state', json, now],
          );
          revision = Number(result.rows[0].revision);
        } else {
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
            revision = Number(result.rows[0].revision);
          } else {
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
            revision = Number(result.rows[0].revision);
          }
        }
        lastSaveAt = Date.now();
        lastError = null;
        return { revision };
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
      await pool.query("DELETE FROM scoreboard_state WHERE id = 'state'");
      revision = 0;
    },
  };
}

module.exports = { createPostgresStorage };
