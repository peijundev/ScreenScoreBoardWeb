'use strict';
// SQLite 后端：优先使用 Node/Electron 内置 node:sqlite，旧环境回退 better-sqlite3。
// WAL + busy_timeout + revision CAS；可选分块快照。内置驱动与 Node/Electron ABI 无关，
// 打包后的 Electron 不再需要为 better-sqlite3 单独重新编译。
const fs = require('fs');
const path = require('path');
const {
  requireDriver,
  StorageConflictError,
  StorageDriverLoadError,
  StorageError,
} = require('./common');
const {
  normalizeChunkOptions,
  createChunkPlan,
  parseChunkManifest,
  chunkRowId,
  collectChunkIds,
  assembleChunks,
} = require('./chunking');

/** @returns {any|null} */
function loadNodeSqlite() {
  try {
    const mod = require('node:sqlite');
    return mod && typeof mod.DatabaseSync === 'function' ? mod : null;
  } catch (_) {
    return null;
  }
}

/** 原生模块加载失败（ABI 不匹配、二进制缺失等）才转成可读的驱动错误。 */
function isDriverLoadFailure(error) {
  const message = error && error.message ? String(error.message) : String(error);
  return /NODE_MODULE_VERSION|self-register|ERR_DLOPEN_FAILED|Cannot find module|was compiled against|dlopen/i
    .test(message);
}

/**
 * 打开数据库并抹平两个驱动的差异：
 * - node:sqlite（Node 22.5+ / Electron 内置）：同步 API，事务需手工 BEGIN IMMEDIATE；
 * - better-sqlite3：旧环境回退，提供原生 transaction()。
 * @param {string} file
 * @param {number} busyTimeoutMs
 */
function openDatabase(file, busyTimeoutMs) {
  const nodeSqlite = loadNodeSqlite();
  if (nodeSqlite) {
    /** @type {any} */
    let raw;
    try {
      raw = new nodeSqlite.DatabaseSync(file);
    } catch (error) {
      if (isDriverLoadFailure(error)) throw new StorageDriverLoadError('SQLite', error);
      const message = error && error.message ? String(error.message) : String(error);
      throw new StorageError(`无法打开 SQLite 数据库 ${file}：${message}`, {
        code: 'STORAGE_OPEN_FAILED',
      });
    }
    return {
      driver: 'node:sqlite',
      exec: (/** @type {string} */ sql) => raw.exec(sql),
      prepare: (/** @type {string} */ sql) => raw.prepare(sql),
      /** 与 better-sqlite3 的 transaction().immediate() 语义一致。 */
      immediate: (/** @type {() => any} */ fn) => {
        raw.exec('BEGIN IMMEDIATE');
        try {
          const result = fn();
          raw.exec('COMMIT');
          return result;
        } catch (error) {
          try { raw.exec('ROLLBACK'); } catch (_) {}
          throw error;
        }
      },
      close: () => raw.close(),
    };
  }

  const Database = requireDriver('better-sqlite3', 'SQLite');
  /** @type {any} */
  let raw;
  try {
    raw = new Database(file);
  } catch (error) {
    if (isDriverLoadFailure(error)) throw new StorageDriverLoadError('SQLite', error);
    throw error;
  }
  return {
    driver: 'better-sqlite3',
    exec: (/** @type {string} */ sql) => raw.exec(sql),
    prepare: (/** @type {string} */ sql) => raw.prepare(sql),
    immediate: (/** @type {() => any} */ fn) => raw.transaction(fn).immediate(),
    close: () => raw.close(),
  };
}

/**
 * @param {{ file: string, busyTimeoutMs?: number } & Record<string, any>} options
 */
function createSqliteStorage(options) {
  const { file, busyTimeoutMs = 5000 } = options;
  /** @type {any} */
  let db = null;
  let driverName = 'unknown';
  let revision = 0;
  let lastSaveAt = 0;
  let lastError = /** @type {string|null} */ (null);

  function ensureRevisionColumn() {
    const columns = db.prepare('PRAGMA table_info(scoreboard_state)').all();
    if (!columns.some((column) => column.name === 'revision')) {
      db.exec('ALTER TABLE scoreboard_state ADD COLUMN revision INTEGER NOT NULL DEFAULT 0');
    }
    // 旧行（无 revision）统一初始化为 1；0 表示“没有行”。
    db.prepare("UPDATE scoreboard_state SET revision = 1 WHERE id = 'state' AND revision = 0").run();
  }

  function readStateRow() {
    return db.prepare('SELECT data, revision FROM scoreboard_state WHERE id = ?').get('state');
  }

  function currentManifest() {
    const row = readStateRow();
    return row ? parseChunkManifest(row.data) : null;
  }

  function readChunkRow(manifest, chunk) {
    const row = db.prepare('SELECT data FROM scoreboard_state WHERE id = ?')
      .get(chunkRowId(manifest, chunk));
    return row ? row.data : null;
  }

  function writeChunkRows(ids, parts) {
    const now = Date.now();
    const stmt = db.prepare(
      'INSERT OR REPLACE INTO scoreboard_state (id, data, revision, updated_at) VALUES (?, ?, 0, ?)',
    );
    db.immediate(() => {
      for (let i = 0; i < ids.length; i += 1) stmt.run(ids[i], parts[i], now);
    });
  }

  function deleteChunkRows(ids) {
    if (!ids.length) return;
    const stmt = db.prepare('DELETE FROM scoreboard_state WHERE id = ?');
    db.immediate(() => {
      for (const id of ids) stmt.run(id);
    });
  }

  /** 原有单行 CAS 写入；分块模式下写入的是 manifest。 */
  function savePlain(json, expectedRevision) {
    const now = Date.now();
    const expected = expectedRevision === undefined
      ? undefined
      : (expectedRevision === null ? 0 : Number(expectedRevision));
    return db.immediate(() => {
      const row = db.prepare('SELECT revision FROM scoreboard_state WHERE id = ?').get('state');
      const current = row ? Number(row.revision) || 0 : 0;
      if (expected !== undefined && current !== expected) {
        throw new StorageConflictError('状态已被其他实例修改，拒绝覆盖', { currentRevision: current });
      }
      if (!row) {
        db.prepare(
          'INSERT INTO scoreboard_state (id, data, revision, updated_at) VALUES (?, ?, ?, ?)',
        ).run('state', json, 1, now);
        return 1;
      }
      const next = current + 1;
      db.prepare(
        'UPDATE scoreboard_state SET data = ?, revision = ?, updated_at = ? WHERE id = ?',
      ).run(json, next, now, 'state');
      return next;
    });
  }

  return {
    kind: 'sqlite',
    /** @returns {string} */ getDriver() { return driverName; },
    capabilities: {
      cas: true,
      revision: 'integer',
      distributedLock: false,
      lockKind: 'file-lock',
      snapshot: 'row',
    },
    async init() {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      db = openDatabase(file, Number(busyTimeoutMs) || 5000);
      driverName = db.driver;
      db.exec('PRAGMA busy_timeout = ' + (Number(busyTimeoutMs) || 5000));
      // 已经是 WAL 时不再重复切换：切换需要写锁与 -shm 访问，多个连接并存时容易失败。
      const journal = db.prepare('PRAGMA journal_mode').get();
      if (!journal || String(journal.journal_mode || '').toLowerCase() !== 'wal') {
        db.exec('PRAGMA journal_mode = WAL');
      }
      db.exec(
        'CREATE TABLE IF NOT EXISTS scoreboard_state (' +
        'id TEXT PRIMARY KEY, data TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)',
      );
      ensureRevisionColumn();
      const row = readStateRow();
      revision = row ? Number(row.revision) || 0 : 0;
    },
    async load() {
      const row = readStateRow();
      if (!row) {
        revision = 0;
        return null;
      }
      revision = Number(row.revision) || 0;
      const manifest = parseChunkManifest(row.data);
      if (manifest) {
        try {
          const json = await assembleChunks(manifest, (chunk) => readChunkRow(manifest, chunk));
          return JSON.parse(json);
        } catch (_) {
          return null;
        }
      }
      try { return JSON.parse(row.data); } catch (_) { return null; }
    },
    /**
     * @param {any} state
     * @param {{ expectedRevision?: any }} [saveOptions]
     */
    async save(state, { expectedRevision } = {}) {
      const json = JSON.stringify(state);
      const chunkOptions = normalizeChunkOptions(options);
      try {
        const previous = currentManifest();
        if (!chunkOptions.enabled) {
          const next = savePlain(json, expectedRevision);
          if (previous) {
            try { deleteChunkRows(collectChunkIds(previous)); } catch (_) {}
          }
          revision = next;
          lastSaveAt = Date.now();
          lastError = null;
          return { revision: next };
        }

        const plan = createChunkPlan(json, chunkOptions);
        const ids = plan.manifest.chunks.map((chunk) => chunkRowId(plan.manifest, chunk));
        writeChunkRows(ids, plan.parts);
        try {
          const next = savePlain(JSON.stringify(plan.manifest), expectedRevision);
          revision = next;
          lastSaveAt = Date.now();
          lastError = null;
          if (previous) {
            try { deleteChunkRows(collectChunkIds(previous)); } catch (_) {}
          }
          return { revision: next };
        } catch (error) {
          try { deleteChunkRows(ids); } catch (_) {}
          throw error;
        }
      } catch (error) {
        lastError = error && error.message ? error.message : String(error);
        throw error;
      }
    },
    async close() {
      try { if (db) db.close(); } catch (_) {}
    },
    /** @param {{ probe?: boolean }} [healthOptions] */
    async health({ probe } = {}) {
      let ok = true;
      let latencyMs = 0;
      const warnings = [];
      if (probe) {
        try {
          const started = Date.now();
          db.prepare('SELECT 1').get();
          latencyMs = Date.now() - started;
        } catch (error) {
          ok = false;
          warnings.push(error && error.message ? error.message : String(error));
        }
      }
      return {
        ok,
        kind: 'sqlite',
        driver: driverName,
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
      db.prepare("DELETE FROM scoreboard_state WHERE id = 'state' OR id LIKE 'chunk:%'").run();
      revision = 0;
    },
  };
}

module.exports = { createSqliteStorage };
