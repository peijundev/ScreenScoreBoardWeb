'use strict';
// SQLite 后端：better-sqlite3，WAL + busy_timeout + revision CAS；可选分块快照。
const fs = require('fs');
const path = require('path');
const { requireDriver, StorageConflictError } = require('./common');
const {
  normalizeChunkOptions,
  createChunkPlan,
  parseChunkManifest,
  chunkRowId,
  collectChunkIds,
  assembleChunks,
} = require('./chunking');

/**
 * @param {{ file: string, busyTimeoutMs?: number } & Record<string, any>} options
 */
function createSqliteStorage(options) {
  const { file, busyTimeoutMs = 5000 } = options;
  /** @type {any} */
  let db = null;
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
    const tx = db.transaction(() => {
      for (let i = 0; i < ids.length; i += 1) stmt.run(ids[i], parts[i], now);
    });
    tx();
  }

  function deleteChunkRows(ids) {
    if (!ids.length) return;
    const stmt = db.prepare('DELETE FROM scoreboard_state WHERE id = ?');
    const tx = db.transaction(() => {
      for (const id of ids) stmt.run(id);
    });
    tx();
  }

  /** 原有单行 CAS 写入；分块模式下写入的是 manifest。 */
  function savePlain(json, expectedRevision) {
    const now = Date.now();
    const expected = expectedRevision === undefined
      ? undefined
      : (expectedRevision === null ? 0 : Number(expectedRevision));
    /** @type {any} */
    const run = db.transaction(() => {
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
    return run.immediate();
  }

  return {
    kind: 'sqlite',
    capabilities: {
      cas: true,
      revision: 'integer',
      distributedLock: false,
      lockKind: 'file-lock',
      snapshot: 'row',
    },
    async init() {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const Database = requireDriver('better-sqlite3', 'SQLite');
      db = new Database(file);
      db.pragma('journal_mode = WAL');
      db.pragma('busy_timeout = ' + (Number(busyTimeoutMs) || 5000));
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
