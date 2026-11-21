'use strict';
// Oracle 后端：oracledb Thin 模式 + revision CAS。暂不支持跨主机锁。
const { requireDriver, StorageConflictError } = require('./common');

function buildConnect(options) {
  const url = options.url || process.env.ORACLE_URL;
  let user = options.user || process.env.ORACLE_USER || '';
  let password = options.password != null ? options.password : (process.env.ORACLE_PASSWORD || '');
  let connectString = options.connectString || process.env.ORACLE_CONNECT_STRING || '';
  if (url) {
    const parsed = new URL(url);
    user = decodeURIComponent(parsed.username || '');
    password = decodeURIComponent(parsed.password || '');
    connectString = parsed.hostname + ':' + (parsed.port || '1521') + parsed.pathname;
  } else if (!connectString && options.host && options.serviceName) {
    connectString = options.host + ':' + (options.port || 1521) + '/' + options.serviceName;
  }
  return { user, password, connectString };
}

/**
 * @param {Record<string, any>} [options]
 */
function createOracleStorage(options = {}) {
  /** @type {any} */
  let oracledb = null;
  /** @type {any} */
  let pool = null;
  let revision = 0;
  let lastSaveAt = 0;
  let lastError = /** @type {string|null} */ (null);

  async function withConnection(fn) {
    const conn = await pool.getConnection();
    try {
      return await fn(conn);
    } finally {
      try { await conn.close(); } catch (_) {}
    }
  }

  async function currentRevision() {
    return withConnection(async (conn) => {
      const result = await conn.execute(
        "SELECT revision FROM scoreboard_state WHERE id = 'state'",
        [],
        { outFormat: oracledb.OUT_FORMAT_ARRAY },
      );
      return result.rows.length ? Number(result.rows[0][0]) || 0 : 0;
    });
  }

  return {
    kind: 'oracle',
    capabilities: {
      cas: true,
      revision: 'integer',
      distributedLock: false,
      lockKind: null,
      snapshot: 'row',
    },
    async init() {
      oracledb = requireDriver('oracledb', 'Oracle');
      oracledb.fetchAsString = [oracledb.CLOB];
      const target = buildConnect(options);
      pool = await oracledb.createPool({
        user: target.user,
        password: target.password,
        connectString: target.connectString,
        poolMin: 0,
        poolMax: Number(options.poolMax) || 4,
        poolTimeout: 60,
        queueTimeout: Number(options.connectTimeoutMs) || 5000,
      });
      await withConnection(async (conn) => {
        const table = await conn.execute(
          "SELECT COUNT(*) AS c FROM user_tables WHERE table_name = 'SCOREBOARD_STATE'",
          [],
          { outFormat: oracledb.OUT_FORMAT_ARRAY },
        );
        if (Number(table.rows[0][0]) === 0) {
          await conn.execute(
            'CREATE TABLE scoreboard_state (' +
            'id VARCHAR2(64) PRIMARY KEY, data CLOB NOT NULL, ' +
            'revision NUMBER(19) DEFAULT 0 NOT NULL, updated_at NUMBER(19) NOT NULL)',
          );
        }
        const column = await conn.execute(
          "SELECT COUNT(*) AS c FROM user_tab_cols WHERE table_name = 'SCOREBOARD_STATE' AND column_name = 'REVISION'",
          [],
          { outFormat: oracledb.OUT_FORMAT_ARRAY },
        );
        if (Number(column.rows[0][0]) === 0) {
          await conn.execute('ALTER TABLE scoreboard_state ADD (revision NUMBER(19) DEFAULT 0 NOT NULL)');
        }
        await conn.execute("UPDATE scoreboard_state SET revision = 1 WHERE id = 'state' AND revision = 0");
        await conn.commit();
      });
      revision = await currentRevision();
    },
    async load() {
      return withConnection(async (conn) => {
        const result = await conn.execute(
          "SELECT data, revision FROM scoreboard_state WHERE id = 'state'",
          [],
          { outFormat: oracledb.OUT_FORMAT_ARRAY, fetchAsString: [oracledb.CLOB] },
        );
        if (!result.rows.length) {
          revision = 0;
          return null;
        }
        revision = Number(result.rows[0][1]) || 0;
        try { return JSON.parse(result.rows[0][0]); } catch (_) { return null; }
      });
    },
    /**
     * @param {any} state
     * @param {{ expectedRevision?: any }} [saveOptions]
     */
    async save(state, { expectedRevision } = {}) {
      const json = JSON.stringify(state);
      const now = Date.now();
      try {
        await withConnection(async (conn) => {
          if (expectedRevision === undefined) {
            const update = await conn.execute(
              "UPDATE scoreboard_state SET data = :data, revision = revision + 1, updated_at = :ts WHERE id = 'state'",
              { data: json, ts: now },
            );
            if (!update.rowsAffected) {
              await conn.execute(
                "INSERT INTO scoreboard_state (id, data, revision, updated_at) VALUES ('state', :data, 1, :ts)",
                { data: json, ts: now },
              );
            }
            await conn.commit();
            revision = await currentRevisionIn(conn);
            return;
          }
          const expected = expectedRevision === null ? 0 : Number(expectedRevision);
          if (expected === 0) {
            try {
              await conn.execute(
                "INSERT INTO scoreboard_state (id, data, revision, updated_at) VALUES ('state', :data, 1, :ts)",
                { data: json, ts: now },
              );
              await conn.commit();
              revision = 1;
            } catch (error) {
              if (error && error.errorNum === 1) {
                throw new StorageConflictError('状态已被其他实例写入，拒绝覆盖', {
                  currentRevision: await currentRevisionIn(conn),
                });
              }
              throw error;
            }
            return;
          }
          const update = await conn.execute(
            "UPDATE scoreboard_state SET data = :data, revision = revision + 1, updated_at = :ts " +
            "WHERE id = 'state' AND revision = :rev",
            { data: json, ts: now, rev: expected },
          );
          if (!update.rowsAffected) {
            throw new StorageConflictError('状态已被其他实例修改，拒绝覆盖', {
              currentRevision: await currentRevisionIn(conn),
            });
          }
          await conn.commit();
          revision = expected + 1;
        });
        lastSaveAt = Date.now();
        lastError = null;
        return { revision };
      } catch (error) {
        lastError = error && error.message ? error.message : String(error);
        throw error;
      }
    },
    async close() {
      try { if (pool) await pool.close(0); } catch (_) {}
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
          await withConnection(async (conn) => {
            await conn.execute('SELECT 1 FROM dual', [], { outFormat: oracledb.OUT_FORMAT_ARRAY });
          });
          latencyMs = Date.now() - started;
        } catch (error) {
          ok = false;
          warnings.push(error && error.message ? error.message : String(error));
        }
      }
      return {
        ok,
        kind: 'oracle',
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
      await withConnection(async (conn) => {
        await conn.execute("DELETE FROM scoreboard_state WHERE id = 'state'");
        await conn.commit();
      });
      revision = 0;
    },
  };

  async function currentRevisionIn(conn) {
    const result = await conn.execute(
      "SELECT revision FROM scoreboard_state WHERE id = 'state'",
      [],
      { outFormat: oracledb.OUT_FORMAT_ARRAY },
    );
    return result.rows.length ? Number(result.rows[0][0]) || 0 : 0;
  }
}

module.exports = { createOracleStorage };
