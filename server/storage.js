'use strict';
// 存储后端：json（默认）/ sqlite / postgres / mysql
// 每种后端都把整份状态快照存为一行数据，接口统一为 init / load / save / close
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { config } = require('./config');
const { logger } = require('./logger');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

function jsonStorage() {
  const file = process.env.STATE_FILE || path.join(DATA_DIR, 'state.json');
  const pretty = config.stateFilePretty;
  return {
    kind: 'json',
    async init() {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // 上次崩溃遗留的临时文件（rename 原子，.tmp 必然是不完整数据）
      try { await fsp.unlink(file + '.tmp'); } catch (_) {}
    },
    async load() {
      if (!fs.existsSync(file)) return null;
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (e) {
        const backup = file + '.corrupt-' + Date.now();
        try { fs.renameSync(file, backup); } catch (_) {}
        logger.error('状态文件损坏，已备份', { backup: path.basename(backup), error: e.message });
        return null;
      }
    },
    async save(state) {
      const tmp = file + '.tmp';
      // 异步原子写，避免阻塞事件循环；默认 compact，可用 STATE_FILE_PRETTY=1 恢复缩进
      await fsp.writeFile(tmp, pretty ? JSON.stringify(state, null, 2) : JSON.stringify(state), 'utf8');
      await fsp.rename(tmp, file);
    },
    async close() {},
  };
}

function sqliteStorage() {
  let db = null;
  const file = process.env.SQLITE_FILE || path.join(DATA_DIR, 'scoreboard.db');
  return {
    kind: 'sqlite',
    async init() {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      let Database;
      try {
        Database = require('better-sqlite3');
      } catch (_) {
        throw new Error('SQLite 存储需要依赖 better-sqlite3：npm install better-sqlite3');
      }
      db = new Database(file);
      db.pragma('journal_mode = WAL');
      db.pragma('busy_timeout = 5000');
      db.exec('CREATE TABLE IF NOT EXISTS scoreboard_state (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL)');
    },
    async load() {
      const row = db.prepare('SELECT data FROM scoreboard_state WHERE id = ?').get('state');
      if (!row) return null;
      try { return JSON.parse(row.data); } catch (_) { return null; }
    },
    async save(state) {
      db.prepare(
        'INSERT INTO scoreboard_state (id, data, updated_at) VALUES (?, ?, ?) ' +
        'ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at'
      ).run('state', JSON.stringify(state), Date.now());
    },
    async close() {
      try { if (db) db.close(); } catch (_) {}
    },
  };
}

function postgresStorage() {
  let pool = null;
  return {
    kind: 'postgres',
    async init() {
      let pg;
      try {
        pg = require('pg');
      } catch (_) {
        throw new Error('PostgreSQL 存储需要依赖 pg：npm install pg');
      }
      const opts = { connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS) || 5000 };
      if (process.env.DATABASE_URL) opts.connectionString = process.env.DATABASE_URL;
      pool = new pg.Pool(opts);
      await pool.query('CREATE TABLE IF NOT EXISTS scoreboard_state (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at BIGINT NOT NULL)');
    },
    async load() {
      const r = await pool.query('SELECT data FROM scoreboard_state WHERE id = $1', ['state']);
      if (!r.rows.length) return null;
      try { return JSON.parse(r.rows[0].data); } catch (_) { return null; }
    },
    async save(state) {
      await pool.query(
        'INSERT INTO scoreboard_state (id, data, updated_at) VALUES ($1, $2, $3) ' +
        'ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at',
        ['state', JSON.stringify(state), Date.now()]
      );
    },
    async close() {
      try { if (pool) await pool.end(); } catch (_) {}
    },
  };
}

function mysqlStorage() {
  let pool = null;
  return {
    kind: 'mysql',
    async init() {
      let mysql;
      try {
        mysql = require('mysql2/promise');
      } catch (_) {
        throw new Error('MySQL 存储需要依赖 mysql2：npm install mysql2');
      }
      pool = process.env.MYSQL_URL ? mysql.createPool(process.env.MYSQL_URL) : mysql.createPool({
        host: process.env.MYSQL_HOST || '127.0.0.1',
        port: Number(process.env.MYSQL_PORT) || 3306,
        user: process.env.MYSQL_USER || 'root',
        password: process.env.MYSQL_PASSWORD || '',
        database: process.env.MYSQL_DATABASE || 'scoreboard',
      });
      await pool.query(
        'CREATE TABLE IF NOT EXISTS scoreboard_state (id VARCHAR(64) PRIMARY KEY, data LONGTEXT NOT NULL, updated_at BIGINT NOT NULL)'
      );
    },
    async load() {
      const [rows] = await pool.query('SELECT data FROM scoreboard_state WHERE id = ?', ['state']);
      if (!rows.length) return null;
      try { return JSON.parse(rows[0].data); } catch (_) { return null; }
    },
    async save(state) {
      await pool.query(
        'INSERT INTO scoreboard_state (id, data, updated_at) VALUES (?, ?, ?) ' +
        'ON DUPLICATE KEY UPDATE data = VALUES(data), updated_at = VALUES(updated_at)',
        ['state', JSON.stringify(state), Date.now()]
      );
    },
    async close() {
      try { if (pool) await pool.end(); } catch (_) {}
    },
  };
}

function createStorage() {
  const kind = (process.env.STORAGE || 'json').toLowerCase();
  switch (kind) {
    case 'json':
    case 'file':
    case 'text':
      return jsonStorage();
    case 'sqlite':
    case 'sqlite3':
      return sqliteStorage();
    case 'postgres':
    case 'postgresql':
    case 'pg':
      return postgresStorage();
    case 'mysql':
    case 'mariadb':
      return mysqlStorage();
    default:
      throw new Error(`不支持的存储后端: ${kind}（可选 json / sqlite / postgres / mysql）`);
  }
}

module.exports = { createStorage };
