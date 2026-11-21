// 存储配置与文件后端单测：npm run test:storage
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const cfg = require('../server/storage-config.js');
const { StorageConfigError } = require('../server/storage/common.js');
const { createJsonStorage } = require('../server/storage/file.js');
const { createTxtStorage } = require('../server/storage/txt.js');
const { createSqliteStorage } = require('../server/storage/sqlite.js');
const { createStorageFromConfig } = require('../server/storage.js');

function tempDir() {
  return mkdtempSync(path.join(tmpdir(), 'sb-storage-'));
}

test('默认配置为 JSON', () => {
  const dir = tempDir();
  try {
    const { config, source } = cfg.resolveStorageConfig({ env: {}, dataDir: dir });
    assert.equal(source, 'default');
    assert.equal(config.kind, 'json');
    assert.equal(config.options.file, 'state.json');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('storage.json 优先于环境变量，且权限为 0600', async () => {
  const dir = tempDir();
  try {
    await cfg.saveStorageConfig(
      { kind: 'txt', options: { file: 'state.txt' } },
      { dataDir: dir, actor: 'tester' },
    );
    const { config, source } = cfg.resolveStorageConfig({
      env: { STORAGE: 'json' },
      dataDir: dir,
    });
    assert.equal(source, 'storage.json');
    assert.equal(config.kind, 'txt');
    if (process.platform !== 'win32') {
      const mode = statSync(path.join(dir, 'storage.json')).mode & 0o777;
      assert.equal(mode, 0o600);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('环境变量可构造配置', () => {
  const dir = tempDir();
  try {
    const { config, source } = cfg.resolveStorageConfig({
      env: { STORAGE: 'sqlite', SQLITE_FILE: 'custom.db' },
      dataDir: dir,
    });
    assert.equal(source, 'env');
    assert.equal(config.kind, 'sqlite');
    assert.equal(config.options.file, 'custom.db');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('损坏的 storage.json 为 fail-closed', () => {
  const dir = tempDir();
  try {
    writeFileSync(path.join(dir, 'storage.json'), '{not json');
    assert.throws(
      () => cfg.resolveStorageConfig({ env: {}, dataDir: dir }),
      (error) => error instanceof StorageConfigError,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('未知后端、未知字段与非法文件路径被拒绝', () => {
  const dir = tempDir();
  try {
    assert.throws(
      () => cfg.normalizeStorageConfig({ kind: 'cassandra' }, { dataDir: dir }),
      /不支持的存储后端/,
    );
    assert.throws(
      () => cfg.normalizeStorageConfig({ kind: 'json', options: { nope: 1 } }, { dataDir: dir }),
      /不支持配置项/,
    );
    assert.throws(
      () => cfg.normalizeStorageConfig({ kind: 'json', options: { file: '../state.json' } }, { dataDir: dir }),
      /不能包含 \.\./,
    );
    assert.throws(
      () => cfg.normalizeStorageConfig({ kind: 'json', options: { file: 'auth.json' } }, { dataDir: dir }),
      /保留文件名/,
    );
    assert.throws(
      () => cfg.normalizeStorageConfig({ kind: 'json', options: { file: 'state.txt' } }, { dataDir: dir }),
      /扩展名/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PostgreSQL 必填项与端口边界', () => {
  const dir = tempDir();
  try {
    assert.throws(
      () => cfg.normalizeStorageConfig({ kind: 'postgres', options: {} }, { dataDir: dir }),
      /请至少填写/,
    );
    const ok = cfg.normalizeStorageConfig(
      { kind: 'postgres', options: { host: 'db', database: 'scoreboard', port: 5432 } },
      { dataDir: dir },
    );
    assert.equal(ok.options.port, 5432);
    assert.throws(
      () => cfg.normalizeStorageConfig(
        { kind: 'postgres', options: { host: 'db', database: 'scoreboard', port: 70000 } },
        { dataDir: dir },
      ),
      /不能大于 65535/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('脱敏不返回密码', () => {
  const red = cfg.redactStorageConfig({
    kind: 'postgres',
    options: { url: 'postgres://user:secret@db:5432/scoreboard', password: 'secret2' },
  });
  assert.equal(red.hasPassword, true);
  assert.equal(red.options.password, undefined);
  assert.ok(!JSON.stringify(red).includes('secret'));
  assert.match(red.options.url, /\*\*\*/);
});

test('密码保留仅在连接目标未变时生效', () => {
  const previous = {
    kind: 'postgres',
    options: { host: 'db', database: 'scoreboard', user: 'u', password: 'pw' },
  };
  const same = { kind: 'postgres', options: { host: 'db', database: 'scoreboard', user: 'u' } };
  assert.equal(cfg.mergeSecrets(same, previous).options.password, 'pw');

  const changed = { kind: 'postgres', options: { host: 'db2', database: 'scoreboard', user: 'u' } };
  assert.throws(
    () => cfg.mergeSecrets(changed, previous),
    (error) => error instanceof StorageConfigError && error.code === 'PASSWORD_REQUIRED',
  );
  assert.equal(cfg.mergeSecrets(same, previous, { clearPassword: true }).options.password, undefined);

  // 切换到不需要密码的后端时，不应要求重新输入旧后端的密码
  assert.doesNotThrow(() => cfg.mergeSecrets(
    { kind: 'json', options: { file: 'state.json' } },
    previous,
  ));

  const urlNext = { kind: 'postgres', options: { url: 'postgres://u:***@db:5432/scoreboard' } };
  const urlPrev = { kind: 'postgres', options: { url: 'postgres://u:pw@db:5432/scoreboard' } };
  assert.equal(cfg.mergeSecrets(urlNext, urlPrev).options.url, 'postgres://u:pw@db:5432/scoreboard');
});

test('JSON 文件后端往返与 CAS', async () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'state.json');
    const storage = createJsonStorage({ file });
    await storage.init();
    assert.equal(await storage.load(), null);

    const first = await storage.save({ version: 2, projects: {} }, { expectedRevision: null });
    assert.ok(first.revision);
    const loaded = await storage.load();
    assert.equal(loaded.version, 2);
    assert.equal(storage.getRevision(), first.revision);

    await assert.rejects(
      () => storage.save({ version: 3 }, { expectedRevision: null }),
      (error) => error.name === 'StorageConflictError',
    );

    const second = await storage.save({ version: 4 }, { expectedRevision: first.revision });
    assert.notEqual(second.revision, first.revision);
    assert.equal((await storage.load()).version, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('TXT 文件后端输出缩进 JSON', async () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'state.txt');
    const storage = createTxtStorage({ file });
    await storage.init();
    await storage.save({ version: 2, title: '计分板' });
    const text = readFileSync(file, 'utf8');
    assert.match(text, /\n {2}"version": 2/);
    assert.equal(JSON.parse(text).title, '计分板');
    assert.equal(text.endsWith('\n'), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createStorageFromConfig 解析 DATA_DIR 内路径', async () => {
  const dir = tempDir();
  try {
    mkdirSync(path.join(dir, 'nested'), { recursive: true });
    const storage = createStorageFromConfig(
      { kind: 'txt', options: { file: 'nested/state.txt' } },
      { dataDir: dir },
    );
    await storage.init();
    await storage.save({ version: 2 });
    assert.equal(JSON.parse(readFileSync(path.join(dir, 'nested/state.txt'), 'utf8')).version, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SQLite 旧表自动加 revision 列并保留数据', async () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'legacy.db');
    const Database = require('better-sqlite3');
    const db = new Database(file);
    db.exec('CREATE TABLE scoreboard_state (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL)');
    db.prepare('INSERT INTO scoreboard_state (id, data, updated_at) VALUES (?, ?, ?)')
      .run('state', JSON.stringify({ version: 2, projects: { legacy: true } }), Date.now());
    db.close();

    const storage = createSqliteStorage({ file });
    await storage.init();
    const loaded = await storage.load();
    assert.equal(loaded.projects.legacy, true);
    assert.equal(storage.getRevision(), 1);

    await storage.save({ version: 3 }, { expectedRevision: 1 });
    assert.equal((await storage.load()).version, 3);
    await storage.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SQLite CAS 拒绝旧 revision 覆盖', async () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'cas.db');
    const first = createSqliteStorage({ file });
    const second = createSqliteStorage({ file });
    await first.init();
    await second.init();
    await first.save({ version: 1 });
    await second.load();
    const stale = second.getRevision();
    await first.save({ version: 2 }, { expectedRevision: stale });
    await assert.rejects(
      () => second.save({ version: 3 }, { expectedRevision: stale }),
      (error) => error.name === 'StorageConflictError',
    );
    await first.close();
    await second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function externalRoundtrip(kind, options) {
  const config = { kind, options };
  const first = createStorageFromConfig(config);
  await first.init();
  await first.removeSnapshot();
  assert.equal(await first.load(), null);

  const created = await first.save({ version: 2, marker: kind }, { expectedRevision: first.getRevision() });
  assert.ok(created.revision !== undefined, kind + ' 首次写入返回 revision');

  const second = createStorageFromConfig(config);
  await second.init();
  const loaded = await second.load();
  assert.equal(loaded.marker, kind, kind + ' 往返读取一致');

  const stale = second.getRevision();
  await first.save({ version: 3, marker: kind }, { expectedRevision: first.getRevision() });
  await assert.rejects(
    () => second.save({ version: 4, marker: kind }, { expectedRevision: stale }),
    (error) => error.name === 'StorageConflictError',
    kind + ' CAS 拒绝旧 revision',
  );

  await second.load();
  await second.save({ version: 5, marker: kind }, { expectedRevision: second.getRevision() });
  assert.equal((await second.load()).marker, kind, kind + ' 新 revision 写入成功');

  await second.removeSnapshot();
  await second.close();
  await first.close();
}

async function externalLock(kind, options) {
  const first = createStorageFromConfig({ kind, options });
  const second = createStorageFromConfig({ kind, options });
  await first.init();
  await second.init();
  try {
    await first.acquireLock('test-first', { waitMs: 500 });
    await assert.rejects(
      () => second.acquireLock('test-second', { waitMs: 300 }),
      /锁/,
      kind + ' 第二个实例获取锁失败',
    );
    await first.releaseLock();
    await second.acquireLock('test-second', { waitMs: 1500 });
    await second.releaseLock();
  } finally {
    await first.close();
    await second.close();
  }
}

test('PostgreSQL 往返与 CAS', { skip: !process.env.TEST_PG_URL }, async () => {
  await externalRoundtrip('postgres', { url: process.env.TEST_PG_URL, maxPool: 2 });
});

test('PostgreSQL advisory lock', { skip: !process.env.TEST_PG_URL }, async () => {
  await externalLock('postgres', { url: process.env.TEST_PG_URL, maxPool: 2 });
});

test('MySQL 往返与 CAS', { skip: !process.env.TEST_MYSQL_URL }, async () => {
  await externalRoundtrip('mysql', { url: process.env.TEST_MYSQL_URL, maxPool: 2 });
});

test('MySQL GET_LOCK', { skip: !process.env.TEST_MYSQL_URL }, async () => {
  await externalLock('mysql', { url: process.env.TEST_MYSQL_URL, maxPool: 2 });
});

test('MongoDB 往返与 CAS', { skip: !process.env.TEST_MONGO_URL }, async () => {
  await externalRoundtrip('mongodb', {
    url: process.env.TEST_MONGO_URL,
    database: 'scoreboard',
    collection: 'scoreboard_state_test_' + process.pid,
    maxPool: 2,
  });
});

test('Redis 往返与 CAS', { skip: !process.env.TEST_REDIS_URL }, async () => {
  await externalRoundtrip('redis', {
    url: process.env.TEST_REDIS_URL,
    keyPrefix: 'sb-test-' + process.pid,
  });
});

test('Redis 分布式锁', { skip: !process.env.TEST_REDIS_URL }, async () => {
  await externalLock('redis', {
    url: process.env.TEST_REDIS_URL,
    keyPrefix: 'sb-test-lock-' + process.pid,
    lockTtlMs: 30000,
    lockRenewMs: 10000,
  });
});

test('SQL Server 往返与 CAS', { skip: !process.env.TEST_MSSQL_URL }, async () => {
  await externalRoundtrip('sqlserver', { url: process.env.TEST_MSSQL_URL, maxPool: 2 });
});

test('Oracle 往返与 CAS', { skip: !process.env.TEST_ORACLE_URL }, async () => {
  await externalRoundtrip('oracle', { url: process.env.TEST_ORACLE_URL, poolMax: 2 });
});
