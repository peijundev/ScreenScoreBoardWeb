'use strict';
// MySQL / MariaDB 后端：mysql2/promise 连接池 + revision CAS + GET_LOCK。
const { requireDriver, StorageConflictError } = require('./common');

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

  return {
    kind: 'mysql',
    capabilities: {
      cas: true,
      revision: 'integer',
      distributedLock: true,
      lockKind: 'mysql-get-lock',
      snapshot: 'row',
    },
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
      const [rows] = await pool.query('SELECT revision FROM scoreboard_state WHERE id = ?', ['state']);
      revision = rows.length ? Number(rows[0].revision) || 0 : 0;
    },
    async load() {
      const [rows] = await pool.query('SELECT data, revision FROM scoreboard_state WHERE id = ?', ['state']);
      if (!rows.length) {
        revision = 0;
        return null;
      }
      revision = Number(rows[0].revision) || 0;
      try { return JSON.parse(rows[0].data); } catch (_) { return null; }
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
          await pool.query(
            'INSERT INTO scoreboard_state (id, data, revision, updated_at) VALUES (?, ?, 1, ?) ' +
            'ON DUPLICATE KEY UPDATE data = VALUES(data), revision = revision + 1, updated_at = VALUES(updated_at)',
            ['state', json, now],
          );
          revision = await currentRevision();
        } else {
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
            revision = 1;
          } else {
            const [result] = await pool.query(
              "UPDATE scoreboard_state SET data = ?, revision = revision + 1, updated_at = ? " +
              "WHERE id = 'state' AND revision = ?",
              [json, now, expected],
            );
            if (!result.affectedRows) {
              throw new StorageConflictError('状态已被其他实例修改，拒绝覆盖', {
                currentRevision: await currentRevision(),
              });
            }
            revision = expected + 1;
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
      await pool.query("DELETE FROM scoreboard_state WHERE id = 'state'");
      revision = 0;
    },
  };
}

module.exports = { createMysqlStorage };
