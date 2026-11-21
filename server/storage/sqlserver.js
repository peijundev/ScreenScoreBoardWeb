'use strict';
// SQL Server 后端：mssql/tedious 纯 JS 驱动 + revision CAS。暂不支持跨主机锁。
const { requireDriver, StorageConflictError } = require('./common');

function buildConfig(options) {
  const url = options.url || process.env.MSSQL_URL;
  /** @type {Record<string, any>} */
  const config = {
    options: {
      encrypt: options.encrypt !== false,
      trustServerCertificate: options.trustServerCertificate === true,
      enableArithAbort: true,
    },
    pool: {
      max: Number(options.maxPool) || 5,
      min: 0,
      idleTimeoutMillis: 30000,
    },
    connectionTimeout: Number(options.connectTimeoutMs) || 5000,
    requestTimeout: Number(options.requestTimeoutMs) || 15000,
  };
  if (url) {
    const parsed = new URL(url);
    config.server = parsed.hostname;
    config.port = Number(parsed.port) || 1433;
    config.database = decodeURIComponent(parsed.pathname.replace(/^\//, '') || 'scoreboard');
    config.user = decodeURIComponent(parsed.username || '');
    config.password = decodeURIComponent(parsed.password || '');
  } else {
    config.server = options.server || process.env.MSSQL_SERVER || '127.0.0.1';
    config.port = Number(options.port || process.env.MSSQL_PORT) || 1433;
    config.database = options.database || process.env.MSSQL_DATABASE || 'scoreboard';
    config.user = options.user || process.env.MSSQL_USER || '';
    config.password = options.password != null ? options.password : (process.env.MSSQL_PASSWORD || '');
    if (options.instanceName) config.options.instanceName = options.instanceName;
  }
  return config;
}

/**
 * @param {Record<string, any>} [options]
 */
function createSqlServerStorage(options = {}) {
  /** @type {any} */
  let sql = null;
  /** @type {any} */
  let pool = null;
  let revision = 0;
  let lastSaveAt = 0;
  let lastError = /** @type {string|null} */ (null);

  async function currentRevision() {
    const result = await pool.request().query("SELECT revision FROM dbo.scoreboard_state WHERE id = 'state'");
    return result.recordset.length ? Number(result.recordset[0].revision) || 0 : 0;
  }

  return {
    kind: 'sqlserver',
    capabilities: {
      cas: true,
      revision: 'integer',
      distributedLock: false,
      lockKind: null,
      snapshot: 'row',
    },
    async init() {
      sql = requireDriver('mssql', 'SQL Server');
      pool = new sql.ConnectionPool(buildConfig(options));
      await pool.connect();
      await pool.request().query(`
        IF OBJECT_ID(N'dbo.scoreboard_state', N'U') IS NULL
        BEGIN
          CREATE TABLE dbo.scoreboard_state (
            id NVARCHAR(64) NOT NULL PRIMARY KEY,
            data NVARCHAR(MAX) NOT NULL,
            revision BIGINT NOT NULL DEFAULT 0,
            updated_at BIGINT NOT NULL
          );
        END;
        IF COL_LENGTH('dbo.scoreboard_state', 'revision') IS NULL
        BEGIN
          ALTER TABLE dbo.scoreboard_state ADD revision BIGINT NOT NULL DEFAULT 0;
        END;
        UPDATE dbo.scoreboard_state SET revision = 1 WHERE id = 'state' AND revision = 0;
      `);
      revision = await currentRevision();
    },
    async load() {
      const result = await pool.request().query("SELECT data, revision FROM dbo.scoreboard_state WHERE id = 'state'");
      if (!result.recordset.length) {
        revision = 0;
        return null;
      }
      revision = Number(result.recordset[0].revision) || 0;
      try { return JSON.parse(result.recordset[0].data); } catch (_) { return null; }
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
          const result = await pool.request()
            .input('data', sql.NVarChar(sql.MAX), json)
            .input('ts', sql.BigInt, now)
            .query(`
              UPDATE dbo.scoreboard_state SET data = @data, revision = revision + 1, updated_at = @ts WHERE id = 'state';
              IF @@ROWCOUNT = 0
              BEGIN
                INSERT INTO dbo.scoreboard_state (id, data, revision, updated_at) VALUES ('state', @data, 1, @ts);
              END;
              SELECT revision FROM dbo.scoreboard_state WHERE id = 'state';
            `);
          revision = Number(result.recordset[0].revision) || 1;
        } else {
          const expected = expectedRevision === null ? 0 : Number(expectedRevision);
          if (expected === 0) {
            try {
              await pool.request()
                .input('data', sql.NVarChar(sql.MAX), json)
                .input('ts', sql.BigInt, now)
                .query("INSERT INTO dbo.scoreboard_state (id, data, revision, updated_at) VALUES ('state', @data, 1, @ts)");
              revision = 1;
            } catch (error) {
              if (error && (error.number === 2627 || error.number === 2601)) {
                throw new StorageConflictError('状态已被其他实例写入，拒绝覆盖', {
                  currentRevision: await currentRevision(),
                });
              }
              throw error;
            }
          } else {
            const result = await pool.request()
              .input('data', sql.NVarChar(sql.MAX), json)
              .input('ts', sql.BigInt, now)
              .input('rev', sql.BigInt, expected)
              .query("UPDATE dbo.scoreboard_state SET data = @data, revision = revision + 1, updated_at = @ts WHERE id = 'state' AND revision = @rev");
            if (!result.rowsAffected || result.rowsAffected[0] === 0) {
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
    async close() {
      try { if (pool) await pool.close(); } catch (_) {}
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
          await pool.request().query('SELECT 1 AS ok');
          latencyMs = Date.now() - started;
        } catch (error) {
          ok = false;
          warnings.push(error && error.message ? error.message : String(error));
        }
      }
      return {
        ok,
        kind: 'sqlserver',
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
      await pool.request().query("DELETE FROM dbo.scoreboard_state WHERE id = 'state'");
      revision = 0;
    },
  };
}

module.exports = { createSqlServerStorage };
