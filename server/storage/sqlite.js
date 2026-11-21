'use strict';
// SQLite 后端：better-sqlite3，WAL + busy_timeout + revision CAS。
const fs = require('fs');
const path = require('path');
const { requireDriver } = require('./common');
const { StorageConflictError } = require('./common');

/**
 * @param {{ file: string, busyTimeoutMs?: number }} options
 */
function createSqliteStorage({ file, busyTimeoutMs = 5000 }) {
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
      const row = db.prepare('SELECT revision FROM scoreboard_state WHERE id = ?').get('state');
      revision = row ? Number(row.revision) || 0 : 0;
    },
    async load() {
      const row = db.prepare('SELECT data, revision FROM scoreboard_state WHERE id = ?').get('state');
      if (!row) {
        revision = 0;
        return null;
      }
      revision = Number(row.revision) || 0;
      try { return JSON.parse(row.data); } catch (_) { return null; }
    },
    /**
     * @param {any} state
     * @param {{ expectedRevision?: any }} [options]
     */
    async save(state, { expectedRevision } = {}) {
      const json = JSON.stringify(state);
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
      try {
        const next = run.immediate();
        revision = next;
        lastSaveAt = Date.now();
        lastError = null;
        return { revision: next };
      } catch (error) {
        lastError = error && error.message ? error.message : String(error);
        throw error;
      }
    },
    async close() {
      try { if (db) db.close(); } catch (_) {}
    },
    /** @param {{ probe?: boolean }} [options] */
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
      db.prepare("DELETE FROM scoreboard_state WHERE id = 'state'").run();
      revision = 0;
    },
  };
}

module.exports = { createSqliteStorage };
