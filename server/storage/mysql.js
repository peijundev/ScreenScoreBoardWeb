'use strict';
// MySQL / MariaDB 后端：mysql2/promise 连接池 + revision CAS + GET_LOCK；可选分块快照。
const { requireDriver, StorageConflictError } = require('./common');
const {
  normalizeChunkOptions,
  createChunkPlan,
  parseChunkManifest,
  chunkRowId,
  collectChunkIds,
  assembleChunks,
} = require('./chunking');

const LOCK_NAME = 'screenscoreboard:state';

/**
 * @param {Record<string, any>} [options]
 */
function createMysqlStorage(options = {}) {
  /** @type {any} */
  let pool = null;
  /** @type {any} */
  let lockConn = null;
  let revision = 0;
  let lastSaveAt = 0;
  let lastError = /** @type {string|null} */ (null);

  async function currentRevision() {
    const [rows] = await pool.query('SELECT revision FROM scoreboard_state WHERE id = ?', ['state']);
    return rows.length ? Number(rows[0].revision) || 0 : 0;
  }

  async function readStateRow() {
    return pool.query('SELECT data, revision FROM scoreboard_state WHERE id = ?', ['state']);
  }

  async function currentManifest() {
    const [rows] = await readStateRow();
    return rows.length ? parseChunkManifest(rows[0].data) : null;
  }

  async function readChunkRow(manifest, chunk) {
    const [rows] = await pool.query('SELECT data FROM scoreboard_state WHERE id = ?', [
      chunkRowId(manifest, chunk),
    ]);
    return rows.length ? rows[0].data : null;
  }

  async function writeChunkRows(ids, parts) {
    const now = Date.now();
    for (let i = 0; i < ids.length; i += 1) {
      await pool.query(
        'INSERT INTO scoreboard_state (id, data, revision, updated_at) VALUES (?, ?, 0, ?) ' +
        'ON DUPLICATE KEY UPDATE data = VALUES(data), updated_at = VALUES(updated_at)',
        [ids[i], parts[i], now],
      );
    }
  }

  async function deleteChunkRows(ids) {
    for (const id of ids) {
      await pool.query('DELETE FROM scoreboard_state WHERE id = ?', [id]);
    }
  }

  async function savePlain(json, expectedRevision) {
    const now = Date.now();
    if (expectedRevision === undefined) {
      await pool.query(
        'INSERT INTO scoreboard_state (id, data, revision, updated_at) VALUES (?, ?, 1, ?) ' +
        'ON DUPLICATE KEY UPDATE data = VALUES(data), revision = revision + 1, updated_at = VALUES(updated_at)',
        ['state', json, now],
      );
      return currentRevision();
    }
    const expected = expectedRevision === null ? 0 : Number(expectedRevision);
    if (expected === 0) {
      const [result] = await pool.query(
        'INSERT IGNORE INTO scoreboard_state (id, data, revision, updated_at) VALUES (?, ?, 1, ?)',
        ['state', json, now],
      );
      if (!result.affectedRows) {
        throw new StorageConflictError('状态已被其他实例写入，拒绝覆盖', {
          currentRevision: await currentRevision(),
        });
      }
      return 1;
    }
    const [result] = await pool.query(
      'UPDATE scoreboard_state SET data = ?, revision = revision + 1, updated_at = ? ' +
      "WHERE id = 'state' AND revision = ?",
      [json, now, expected],
    );
    if (!result.affectedRows) {
      throw new StorageConflictError('状态已被其他实例修改，拒绝覆盖', {
        currentRevision: await currentRevision(),
      });
    }
    return expected + 1;
  }

  const capabilities = {
    cas: true,
    revision: 'integer',
    distributedLock: true,
    lockKind: 'mysql-get-lock',
    snapshot: 'row',
  };

  return {
    kind: 'mysql',
    capabilities,
    async init() {
      const mysql = requireDriver('mysql2/promise', 'MySQL');
      const url = options.url || process.env.MYSQL_URL;
      /** @type {Record<string, any>} */
      let conn;
      if (url) {
        const parsed = new URL(url);
        conn = {
          host: parsed.hostname,
          port: Number(parsed.port) || 3306,
          user: decodeURIComponent(parsed.username || ''),
          password: decodeURIComponent(parsed.password || ''),
          database: decodeURIComponent(parsed.pathname.replace(/^\//, '') || 'scoreboard'),
        };
      } else {
        conn = {
          host: options.host || process.env.MYSQL_HOST || '127.0.0.1',
          port: Number(options.port || process.env.MYSQL_PORT) || 3306,
          user: options.user || process.env.MYSQL_USER || 'root',
          password: options.password != null ? options.password : (process.env.MYSQL_PASSWORD || ''),
          database: options.database || process.env.MYSQL_DATABASE || 'scoreboard',
        };
      }
      pool = mysql.createPool({
        ...conn,
        connectTimeout: Number(options.connectTimeoutMs) || 5000,
        connectionLimit: Number(options.maxPool) || 10,
        ...(options.ssl ? { ssl: {} } : {}),
      });
      await pool.query(
        'CREATE TABLE IF NOT EXISTS scoreboard_state (' +
        'id VARCHAR(64) PRIMARY KEY, data LONGTEXT NOT NULL, revision BIGINT NOT NULL DEFAULT 0, updated_at BIGINT NOT NULL)',
      );
      const [columns] = await pool.query(
        "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() " +
        "AND TABLE_NAME = 'scoreboard_state' AND COLUMN_NAME = 'revision'",
      );
      if (!columns.length) {
        await pool.query('ALTER TABLE scoreboard_state ADD COLUMN revision BIGINT NOT NULL DEFAULT 0');
      }
      await pool.query("UPDATE scoreboard_state SET revision = 1 WHERE id = 'state' AND revision = 0");
      revision = await currentRevision();
      // PlanetScale / Vitess 等协议兼容服务不支持会话级 GET_LOCK。
      if (options.lockMode === 'none') {
        capabilities.distributedLock = false;
        capabilities.lockKind = null;
      }
    },
    async load() {
      const [rows] = await readStateRow();
      if (!rows.length) {
        revision = 0;
        return null;
      }
      revision = Number(rows[0].revision) || 0;
      const manifest = parseChunkManifest(rows[0].data);
      if (manifest) {
        try {
          const json = await assembleChunks(manifest, (chunk) => readChunkRow(manifest, chunk));
          return JSON.parse(json);
        } catch (_) {
          return null;
        }
      }
      try { return JSON.parse(rows[0].data); } catch (_) { return null; }
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
      if (!pool) throw new Error('MySQL 存储尚未初始化');
      const waitSeconds = Math.max(0, Math.ceil((Number(lockOptions.waitMs) || 0) / 1000));
      const conn = await pool.getConnection();
      try {
        const [rows] = await conn.query('SELECT GET_LOCK(?, ?) AS ok', [LOCK_NAME, waitSeconds]);
        if (Number(rows[0].ok) === 1) {
          lockConn = conn;
          return { kind: 'mysql-get-lock' };
        }
        throw new Error('无法获取 MySQL 存储锁：已有另一个实例在使用同一数据库');
      } catch (error) {
        try { conn.release(); } catch (_) {}
        throw error;
      }
    },
    async releaseLock() {
      if (!lockConn) return;
      try {
        await lockConn.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]);
      } finally {
        try { lockConn.release(); } catch (_) {}
        lockConn = null;
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
        kind: 'mysql',
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

module.exports = { createMysqlStorage };
