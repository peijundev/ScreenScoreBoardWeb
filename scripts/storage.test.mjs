// 存储配置与文件后端单测：npm run test:storage
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';
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
const { canonicalKind } = require('../server/storage/registry.js');
const chunking = require('../server/storage/chunking.js');

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

test('SQLite 优先使用内置 node:sqlite（Electron 无需重建原生模块）', async () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'driver.db');
    const storage = createSqliteStorage({ file });
    await storage.init();
    assert.equal(storage.getDriver(), 'node:sqlite');
    const health = await storage.health({ probe: true });
    assert.equal(health.driver, 'node:sqlite');
    await storage.save({ version: 2 });
    assert.equal((await storage.load()).version, 2);
    await storage.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('数据位置描述：文件后端返回绝对路径，远端后端不泄露密码', () => {
  const { describeStorageLocation } = require('../server/storage.js');
  const dataDir = path.join(tmpdir(), 'sb-data-location');
  const fileLocation = describeStorageLocation(
    { kind: 'sqlite', options: { file: 'db/scoreboard.db' } },
    dataDir,
  );
  assert.equal(fileLocation.type, 'file');
  assert.equal(fileLocation.path, path.resolve(dataDir, 'db/scoreboard.db'));
  assert.equal(fileLocation.detail, '');

  const defaultLocation = describeStorageLocation({ kind: 'json', options: {} }, dataDir);
  assert.equal(defaultLocation.path, path.resolve(dataDir, 'state.json'));

  const remoteLocation = describeStorageLocation({
    kind: 'postgres',
    options: { host: 'db.example.com', port: 5432, database: 'scoreboard', password: 'secret-pass' },
  }, dataDir);
  assert.equal(remoteLocation.type, 'remote');
  assert.match(remoteLocation.detail, /db\.example\.com:5432/);
  assert.doesNotMatch(remoteLocation.detail, /secret-pass/);
});

test('驱动加载失败映射为 422 并保留可读消息', () => {
  const { StorageDriverLoadError } = require('../server/storage/common.js');
  const { toApiError } = require('../server/api/errors.js');
  const apiError = toApiError(
    new StorageDriverLoadError('SQLite', new Error('NODE_MODULE_VERSION 137 与 150 不匹配')),
  );
  assert.equal(apiError.status, 422);
  assert.equal(apiError.code, 'STORAGE_DRIVER_LOAD_FAILED');
  assert.match(apiError.message, /SQLite 存储驱动加载失败/);
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

test('分块按 UTF-8 字节切分且不截断字符', () => {
  const text = 'a计'.repeat(1000);
  const parts = chunking.splitByBytes(text, 16);
  assert.ok(parts.length > 1);
  assert.equal(parts.join(''), text);
  for (const part of parts) {
    assert.ok(Buffer.byteLength(part, 'utf8') <= 16);
  }
});

test('分块 manifest 组装与哈希校验', async () => {
  const json = JSON.stringify({ hello: '世界'.repeat(4000) });
  const options = chunking.normalizeChunkOptions({
    chunked: true,
    chunkSizeKb: 16,
    chunkShards: 2,
    chunkVerify: true,
  });
  const plan = chunking.createChunkPlan(json, options);
  assert.ok(plan.parts.length > 1);
  const manifest = chunking.parseChunkManifest(JSON.stringify(plan.manifest));
  assert.ok(manifest);
  const chunks = new Map(
    plan.manifest.chunks.map((chunk, index) => [`${chunk.shard}:${chunk.index}`, plan.parts[index]]),
  );
  const assembled = await chunking.assembleChunks(
    manifest,
    (chunk) => chunks.get(`${chunk.shard}:${chunk.index}`),
  );
  assert.equal(assembled, json);

  const tampered = new Map(chunks);
  const firstKey = [...tampered.keys()][0];
  tampered.set(firstKey, 'x');
  await assert.rejects(
    () => chunking.assembleChunks(manifest, (chunk) => tampered.get(`${chunk.shard}:${chunk.index}`)),
    /校验失败/,
  );
});

test('SQLite 分块往返、CAS 与格式切换', async () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'chunked.db');
    const payload = '计分板'.repeat(20000);
    const state = { version: 2, marker: 'chunked', payload };
    const chunked = createSqliteStorage({
      file,
      chunked: true,
      chunkSizeKb: 16,
      chunkShards: 3,
      chunkVerify: true,
    });
    await chunked.init();
    await chunked.save(state, { expectedRevision: null });
    assert.equal((await chunked.load()).payload, payload);

    // 用与后端相同的 node:sqlite 检查，避免不同驱动同时打开同一 WAL 数据库时互相清理 -shm。
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(file);
    assert.ok(
      db.prepare("SELECT COUNT(*) AS n FROM scoreboard_state WHERE id LIKE 'chunk:%'").get().n > 1,
      '生成多个块行',
    );
    assert.match(
      db.prepare("SELECT data FROM scoreboard_state WHERE id = 'state'").get().data,
      /"chunked":true/,
      '主行保存 manifest',
    );
    db.close();

    // 关闭分块后仍能读取分块数据，再保存为普通格式并清理旧块
    const plain = createSqliteStorage({ file, chunked: false });
    await plain.init();
    assert.equal((await plain.load()).payload, payload);
    await plain.save({ version: 3, marker: 'plain' }, { expectedRevision: plain.getRevision() });
    assert.equal((await plain.load()).marker, 'plain');

    const db2 = new DatabaseSync(file);
    assert.equal(
      db2.prepare("SELECT COUNT(*) AS n FROM scoreboard_state WHERE id LIKE 'chunk:%'").get().n,
      0,
      '切回普通格式后清理旧块',
    );
    db2.close();

    const chunked2 = createSqliteStorage({ file, chunked: true, chunkSizeKb: 16 });
    await chunked2.init();
    const stale = chunked2.getRevision();
    await plain.save({ version: 4 }, { expectedRevision: stale });
    await assert.rejects(
      () => chunked2.save({ version: 5 }, { expectedRevision: stale }),
      (error) => error.name === 'StorageConflictError',
    );
    await chunked2.close();
    await plain.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function externalRoundtrip(kind, options) {
  const config = { kind, options };
  const payload = options.chunked ? '计分板'.repeat(20000) : '';
  const stateOf = (version) => ({
    version,
    marker: kind,
    ...(payload ? { payload } : {}),
  });
  const first = createStorageFromConfig(config);
  await first.init();
  await first.removeSnapshot();
  assert.equal(await first.load(), null);

  const created = await first.save(stateOf(2), { expectedRevision: first.getRevision() });
  assert.ok(created.revision !== undefined, kind + ' 首次写入返回 revision');

  const second = createStorageFromConfig(config);
  await second.init();
  const loaded = await second.load();
  assert.equal(loaded.marker, kind, kind + ' 往返读取一致');
  if (payload) assert.equal(loaded.payload, payload, kind + ' 分块往返一致');

  const stale = second.getRevision();
  await first.save(stateOf(3), { expectedRevision: first.getRevision() });
  await assert.rejects(
    () => second.save(stateOf(4), { expectedRevision: stale }),
    (error) => error.name === 'StorageConflictError',
    kind + ' CAS 拒绝旧 revision',
  );

  await second.load();
  await second.save(stateOf(5), { expectedRevision: second.getRevision() });
  const final = await second.load();
  assert.equal(final.marker, kind, kind + ' 新 revision 写入成功');
  if (payload) assert.equal(final.payload, payload, kind + ' 分块内容保持一致');

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

test('PostgreSQL 分块往返与 CAS', { skip: !process.env.TEST_PG_URL }, async () => {
  await externalRoundtrip('postgres', {
    url: process.env.TEST_PG_URL,
    maxPool: 2,
    chunked: true,
    chunkSizeKb: 16,
    chunkShards: 2,
    chunkVerify: true,
  });
});

test('PostgreSQL advisory lock', { skip: !process.env.TEST_PG_URL }, async () => {
  await externalLock('postgres', { url: process.env.TEST_PG_URL, maxPool: 2 });
});

test('MySQL 往返与 CAS', { skip: !process.env.TEST_MYSQL_URL }, async () => {
  await externalRoundtrip('mysql', { url: process.env.TEST_MYSQL_URL, maxPool: 2 });
});

test('MySQL 分块往返与 CAS', { skip: !process.env.TEST_MYSQL_URL }, async () => {
  await externalRoundtrip('mysql', {
    url: process.env.TEST_MYSQL_URL,
    maxPool: 2,
    chunked: true,
    chunkSizeKb: 16,
    chunkShards: 2,
    chunkVerify: true,
  });
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

test('Redis 分块往返与 CAS', { skip: !process.env.TEST_REDIS_URL }, async () => {
  await externalRoundtrip('redis', {
    url: process.env.TEST_REDIS_URL,
    keyPrefix: 'sb-test-chunk-' + process.pid,
    chunked: true,
    chunkSizeKb: 16,
    chunkShards: 2,
    chunkVerify: true,
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

test('后端推荐标记、优缺点与选择顺序', () => {
  const backends = cfg.describeBackends();
  assert.equal(backends[3].kind, 'redis', 'Redis 位于第四位');
  for (const backend of backends) {
    assert.ok(backend.pros.length > 0, backend.kind + ' 有优点');
    assert.ok(backend.cons.length > 0, backend.kind + ' 有缺点');
    assert.ok(backend.warning, backend.kind + ' 有警告标语');
  }
  const byKind = (kind) => backends.find((item) => item.kind === kind);
  assert.equal(byKind('redis').recommendedLabel, '效率推荐');
  assert.equal(byKind('sqlite').recommendedLabel, '本地推荐');
  assert.equal(byKind('postgres').recommendedLabel, '生产推荐');
  assert.equal(byKind('mysql').recommendedLabel, '生态推荐');
  assert.equal(byKind('libsql').recommendedLabel, '边缘推荐');
  assert.equal(byKind('couchdb').recommendedLabel, '自托管推荐');
  assert.equal(byKind('d1').recommendedLabel, 'Cloudflare 推荐');
  assert.equal(byKind('dynamodb').recommendedLabel, 'AWS 推荐');
  assert.equal(byKind('firestore').recommendedLabel, 'GCP 推荐');
  assert.equal(byKind('s3').recommendedLabel, '备份推荐');
  assert.equal(byKind('etcd').recommendedLabel, 'K8s 推荐');
  assert.equal(byKind('lmdb').recommendedLabel, '嵌入式推荐');
});

test('分块高级选项默认值与边界', () => {
  const dir = tempDir();
  try {
    const sqlite = cfg.normalizeStorageConfig({ kind: 'sqlite', options: {} }, { dataDir: dir });
    assert.equal(sqlite.options.chunked, false);
    assert.equal(sqlite.options.chunkSizeKb, 256);
    assert.equal(sqlite.options.chunkShards, 1);
    assert.equal(sqlite.options.chunkVerify, true);

    assert.throws(
      () => cfg.normalizeStorageConfig(
        { kind: 'sqlite', options: { chunkSizeKb: 8 } },
        { dataDir: dir },
      ),
      /不能小于 16/,
    );
    assert.throws(
      () => cfg.normalizeStorageConfig(
        { kind: 'redis', options: { chunkShards: 32 } },
        { dataDir: dir },
      ),
      /不能大于 16/,
    );

    const redis = cfg.normalizeStorageConfig(
      {
        kind: 'redis',
        options: { chunked: true, chunkSizeKb: 64, chunkShards: 4, chunkVerify: false },
      },
      { dataDir: dir },
    );
    assert.equal(redis.options.chunked, true);
    assert.equal(redis.options.chunkSizeKb, 64);
    assert.equal(redis.options.chunkShards, 4);
    assert.equal(redis.options.chunkVerify, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Cloudflare D1 配置、密钥与快照上限', () => {
  const dir = tempDir();
  try {
    const d1 = cfg.normalizeStorageConfig(
      { kind: 'd1', options: { accountId: 'acct', databaseId: 'db', apiToken: 'tok' } },
      { dataDir: dir },
    );
    assert.equal(d1.kind, 'd1');
    assert.equal(d1.options.endpoint, 'https://api.cloudflare.com');
    assert.equal(cfg.maxSnapshotBytesFor('d1'), Math.floor(1.9 * 1024 * 1024));
    assert.throws(
      () => cfg.normalizeStorageConfig({ kind: 'd1', options: {} }, { dataDir: dir }),
      /请至少填写/,
    );

    const red = cfg.redactStorageConfig(d1);
    assert.equal(red.options.apiToken, undefined);
    assert.equal(red.hasPassword, true);
    assert.ok(!JSON.stringify(red).includes('tok'));

    const same = cfg.normalizeStorageConfig(
      { kind: 'd1', options: { accountId: 'acct', databaseId: 'db' } },
      { dataDir: dir },
    );
    assert.equal(cfg.mergeSecrets(same, d1).options.apiToken, 'tok');
    const changed = cfg.normalizeStorageConfig(
      { kind: 'd1', options: { accountId: 'acct', databaseId: 'db2' } },
      { dataDir: dir },
    );
    assert.throws(() => cfg.mergeSecrets(changed, d1), /重新输入/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('协议兼容别名映射到现有后端', () => {
  assert.equal(canonicalKind('cockroachdb'), 'postgres');
  assert.equal(canonicalKind('yugabytedb'), 'postgres');
  assert.equal(canonicalKind('tidb'), 'mysql');
  assert.equal(canonicalKind('planetscale'), 'mysql');
  assert.equal(canonicalKind('documentdb'), 'mongodb');
  assert.equal(canonicalKind('turso'), 'libsql');
  assert.equal(canonicalKind('couch'), 'couchdb');
});

test('libSQL 与 CouchDB 配置、通用密钥与快照上限', () => {
  const dir = tempDir();
  try {
    const lib = cfg.normalizeStorageConfig(
      { kind: 'libsql', options: { url: 'libsql://demo.turso.io', authToken: 'tok' } },
      { dataDir: dir },
    );
    assert.equal(lib.kind, 'libsql');
    assert.equal(lib.options.authToken, 'tok');
    assert.throws(
      () => cfg.normalizeStorageConfig({ kind: 'libsql', options: {} }, { dataDir: dir }),
      /请至少填写/,
    );

    const couch = cfg.normalizeStorageConfig(
      { kind: 'couchdb', options: { url: 'http://127.0.0.1:5984' } },
      { dataDir: dir },
    );
    assert.equal(couch.options.database, 'scoreboard');
    assert.throws(
      () => cfg.normalizeStorageConfig(
        { kind: 'couchdb', options: { url: 'http://127.0.0.1:5984', database: 'Bad/Name' } },
        { dataDir: dir },
      ),
      /非法字符/,
    );

    // 通用 secret 字段：脱敏、同目标保留、换目标必须重输
    const red = cfg.redactStorageConfig(lib);
    assert.equal(red.options.authToken, undefined);
    assert.equal(red.hasPassword, true);
    assert.equal(red.hasSecrets, true);
    assert.ok(!JSON.stringify(red).includes('tok'));

    const prev = { kind: 'libsql', options: { url: 'libsql://demo.turso.io', authToken: 'tok' } };
    assert.equal(
      cfg.mergeSecrets({ kind: 'libsql', options: { url: 'libsql://demo.turso.io' } }, prev).options.authToken,
      'tok',
    );
    assert.throws(
      () => cfg.mergeSecrets({ kind: 'libsql', options: { url: 'libsql://other.turso.io' } }, prev),
      (error) => error instanceof StorageConfigError && error.code === 'PASSWORD_REQUIRED',
    );

    // 按后端的快照上限；libSQL 只受迁移上限约束
    assert.equal(cfg.maxSnapshotBytesFor('mongodb'), Math.floor(15.5 * 1024 * 1024));
    assert.equal(cfg.maxSnapshotBytesFor('couchdb'), Math.floor(7.5 * 1024 * 1024));
    assert.equal(cfg.maxSnapshotBytesFor('libsql'), 0);

    // 协议兼容服务可显式关闭会话锁
    const pg = cfg.normalizeStorageConfig(
      { kind: 'postgres', options: { host: 'db', database: 'scoreboard', lockMode: 'none' } },
      { dataDir: dir },
    );
    assert.equal(pg.options.lockMode, 'none');
    assert.throws(
      () => cfg.normalizeStorageConfig(
        { kind: 'postgres', options: { host: 'db', database: 'scoreboard', lockMode: 'bogus' } },
        { dataDir: dir },
      ),
      /取值非法/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 内存 CouchDB mock：实现建库、文档读/写/删与 _rev 冲突。 */
function createCouchMock() {
  const dbs = new Map();
  let seq = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const parts = url.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
    const database = parts[0];
    const id = parts[1];
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body || {}));
    };
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch (_) { return send(400, { error: 'bad_request' }); }

      if (req.method === 'PUT' && !id) {
        if (dbs.has(database)) return send(412, { error: 'file_exists' });
        dbs.set(database, new Map());
        return send(201, { ok: true });
      }
      if (!dbs.has(database)) return send(404, { error: 'not_found' });
      const docs = dbs.get(database);

      if (req.method === 'GET' && id) {
        const doc = docs.get(id);
        return doc ? send(200, doc) : send(404, { error: 'not_found' });
      }
      if (req.method === 'PUT' && id) {
        const current = docs.get(id);
        if (current) {
          if (body._rev !== current._rev) return send(409, { error: 'conflict' });
        } else if (body._rev) {
          return send(409, { error: 'conflict' });
        }
        seq += 1;
        const doc = { ...body, _id: id, _rev: `${seq}-mock` };
        docs.set(id, doc);
        return send(201, { ok: true, id, rev: doc._rev });
      }
      if (req.method === 'DELETE' && id) {
        const current = docs.get(id);
        if (!current) return send(404, { error: 'not_found' });
        if (url.searchParams.get('rev') !== current._rev) return send(409, { error: 'conflict' });
        docs.delete(id);
        return send(200, { ok: true });
      }
      return send(400, { error: 'bad_request' });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

test('CouchDB 本地模拟往返与 CAS', async () => {
  const mock = await createCouchMock();
  try {
    await externalRoundtrip('couchdb', { url: mock.url, database: 'scoreboard' });
  } finally {
    await mock.close();
  }
});

let hasLibsql = true;
try {
  require.resolve('@libsql/client');
} catch (_) {
  hasLibsql = false;
}

test('libSQL 本地文件往返与 CAS', { skip: !hasLibsql }, async () => {
  const dir = tempDir();
  try {
    await externalRoundtrip('libsql', { url: 'file:' + path.join(dir, 'libsql.db') });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('libSQL 本地文件分块往返与 CAS', { skip: !hasLibsql }, async () => {
  const dir = tempDir();
  try {
    await externalRoundtrip('libsql', {
      url: 'file:' + path.join(dir, 'chunked.db'),
      chunked: true,
      chunkSizeKb: 16,
      chunkShards: 2,
      chunkVerify: true,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('libSQL 往返与 CAS（远程）', { skip: !process.env.TEST_LIBSQL_URL }, async () => {
  await externalRoundtrip('libsql', { url: process.env.TEST_LIBSQL_URL });
});

test('CouchDB 往返与 CAS（远程）', { skip: !process.env.TEST_COUCHDB_URL }, async () => {
  await externalRoundtrip('couchdb', {
    url: process.env.TEST_COUCHDB_URL,
    database: 'scoreboard_test_' + process.pid,
  });
});

/** 内存 D1 REST mock：按固定 SQL 模式返回结果，验证驱动 CAS 流程。 */
function createD1Mock() {
  const rows = new Map();
  const server = http.createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      if (req.method !== 'POST') return send(405, { success: false, errors: [{ message: 'method' }] });
      if (!/^Bearer test-token$/.test(req.headers.authorization || '')) {
        return send(401, { success: false, errors: [{ message: 'unauthorized' }] });
      }
      let body;
      try { body = JSON.parse(raw); } catch (_) { return send(400, { success: false, errors: [{ message: 'bad json' }] }); }
      const sql = String(body.sql || '').replace(/\s+/g, ' ').trim();
      const params = Array.isArray(body.params) ? body.params : [];
      const ok = (results, changes = 0) => send(200, {
        success: true,
        errors: [],
        messages: [],
        result: [{ results, success: true, meta: { changes } }],
      });

      if (/^CREATE TABLE/i.test(sql)) return ok([]);
      if (/^SELECT 1/i.test(sql)) return ok([{ '1': 1 }]);
      if (/^SELECT data, revision FROM scoreboard_state WHERE id = \?/i.test(sql)) {
        const row = rows.get(params[0]);
        return ok(row ? [{ data: row.data, revision: row.revision }] : []);
      }
      if (/^SELECT revision FROM scoreboard_state WHERE id = \?/i.test(sql)) {
        const row = rows.get(params[0]);
        return ok(row ? [{ revision: row.revision }] : []);
      }
      if (/^SELECT data FROM scoreboard_state WHERE id = \?/i.test(sql)) {
        const row = rows.get(params[0]);
        return ok(row ? [{ data: row.data }] : []);
      }
      if (/^INSERT INTO scoreboard_state/i.test(sql)) {
        const id = params[0];
        const data = params[1];
        const constant = Number((/VALUES \(\?, \?, (\d+), \?\)/.exec(sql) || [])[1] || 1);
        const existing = rows.get(id);
        if (/DO NOTHING/i.test(sql)) {
          if (existing) return ok([]);
          rows.set(id, { data, revision: constant });
          return ok([{ revision: constant }], 1);
        }
        if (constant === 1) {
          const next = existing ? existing.revision + 1 : 1;
          rows.set(id, { data, revision: next });
          return ok([{ revision: next }], 1);
        }
        // 分块行：revision 固定为 0，不参与主版本。
        rows.set(id, { data, revision: 0 });
        return ok([], 1);
      }
      if (/^UPDATE scoreboard_state SET data = \?, revision = revision \+ 1/i.test(sql)) {
        const expected = Number(params[2]);
        const row = rows.get('state');
        if (!row || row.revision !== expected) return ok([]);
        row.data = params[0];
        row.revision += 1;
        return ok([{ revision: row.revision }], 1);
      }
      if (/^UPDATE scoreboard_state SET revision = 1/i.test(sql)) {
        return ok([]);
      }
      if (/^DELETE FROM scoreboard_state WHERE id = \?/i.test(sql)) {
        rows.delete(params[0]);
        return ok([], 1);
      }
      if (/^DELETE FROM scoreboard_state WHERE id = 'state' OR id LIKE 'chunk:%'/i.test(sql)) {
        rows.clear();
        return ok([], 1);
      }
      return send(400, { success: false, errors: [{ message: 'unsupported sql' }] });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

test('Cloudflare D1 本地模拟往返与 CAS', async () => {
  const mock = await createD1Mock();
  try {
    await externalRoundtrip('d1', {
      accountId: 'acct',
      databaseId: 'db',
      apiToken: 'test-token',
      endpoint: mock.url,
    });
  } finally {
    await mock.close();
  }
});

test('Cloudflare D1 本地模拟分块往返与 CAS', async () => {
  const mock = await createD1Mock();
  try {
    await externalRoundtrip('d1', {
      accountId: 'acct',
      databaseId: 'db',
      apiToken: 'test-token',
      endpoint: mock.url,
      chunked: true,
      chunkSizeKb: 16,
      chunkShards: 2,
      chunkVerify: true,
    });
  } finally {
    await mock.close();
  }
});

test('Cloudflare D1 往返与 CAS（远程）', {
  skip: !(process.env.TEST_D1_ACCOUNT_ID && process.env.TEST_D1_DATABASE_ID && process.env.TEST_D1_API_TOKEN),
}, async () => {
  await externalRoundtrip('d1', {
    accountId: process.env.TEST_D1_ACCOUNT_ID,
    databaseId: process.env.TEST_D1_DATABASE_ID,
    apiToken: process.env.TEST_D1_API_TOKEN,
  });
});

test('DynamoDB 配置、密钥与快照上限', () => {
  const dir = tempDir();
  try {
    const base = cfg.normalizeStorageConfig({ kind: 'dynamodb', options: {} }, { dataDir: dir });
    assert.equal(base.options.region, 'us-east-1');
    assert.equal(base.options.tableName, 'scoreboard_state');
    assert.equal(cfg.maxSnapshotBytesFor('dynamodb'), Math.floor(380 * 1024));

    const withSecret = cfg.normalizeStorageConfig({
      kind: 'dynamodb',
      options: { accessKeyId: 'AKIA', secretAccessKey: 'secret-key', sessionToken: 'session-token' },
    }, { dataDir: dir });
    const red = cfg.redactStorageConfig(withSecret);
    assert.equal(red.options.secretAccessKey, undefined);
    assert.equal(red.options.sessionToken, undefined);
    assert.equal(red.hasPassword, true);
    assert.ok(!JSON.stringify(red).includes('secret-key'));
    assert.ok(!JSON.stringify(red).includes('session-token'));

    const same = cfg.normalizeStorageConfig(
      { kind: 'dynamodb', options: { accessKeyId: 'AKIA' } },
      { dataDir: dir },
    );
    const merged = cfg.mergeSecrets(same, withSecret);
    assert.equal(merged.options.secretAccessKey, 'secret-key');
    assert.equal(merged.options.sessionToken, 'session-token');

    const changed = cfg.normalizeStorageConfig(
      { kind: 'dynamodb', options: { accessKeyId: 'AKIA', region: 'eu-west-1' } },
      { dataDir: dir },
    );
    assert.throws(() => cfg.mergeSecrets(changed, withSecret), /重新输入/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 内存 DynamoDB JSON 协议 mock：覆盖 GetItem / PutItem / UpdateItem / DeleteItem。 */
function createDynamoMock() {
  let item = null;
  const server = http.createServer((req, res) => {
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/x-amz-json-1.0', ...headers });
      res.end(JSON.stringify(body));
    };
    const fail = (name, message) => send(400, {
      __type: 'com.amazonaws.dynamodb.v20120810#' + name,
      message,
    }, { 'x-amzn-errortype': name });

    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      if (req.method !== 'POST') return fail('UnknownOperationException', 'method');
      const target = String(req.headers['x-amz-target'] || '');
      let body;
      try { body = raw ? JSON.parse(raw) : {}; } catch (_) { return fail('SerializationException', 'bad json'); }

      if (target.endsWith('.GetItem')) {
        return send(200, item ? { Item: item } : {});
      }
      if (target.endsWith('.PutItem')) {
        if (item) return fail('ConditionalCheckFailedException', 'item exists');
        item = body.Item;
        return send(200, {});
      }
      if (target.endsWith('.UpdateItem')) {
        const values = body.ExpressionAttributeValues || {};
        const condition = String(body.ConditionExpression || '');
        if (condition.includes('attribute_exists')) {
          const expected = Number(values[':expected'] && values[':expected'].N);
          if (!item || Number(item.revision.N) !== expected) {
            return fail('ConditionalCheckFailedException', 'revision mismatch');
          }
          item = {
            ...item,
            data: values[':data'],
            revision: { N: String(expected + 1) },
            updatedAt: values[':now'],
          };
          return send(200, { Attributes: item });
        }
        const current = item ? Number(item.revision.N) || 0 : 0;
        item = {
          id: { S: 'state' },
          data: values[':data'],
          revision: { N: String(current + 1) },
          updatedAt: values[':now'],
        };
        return send(200, { Attributes: item });
      }
      if (target.endsWith('.DeleteItem')) {
        item = null;
        return send(200, {});
      }
      return fail('UnknownOperationException', target);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

test('DynamoDB 本地模拟往返与 CAS', async () => {
  const mock = await createDynamoMock();
  try {
    await externalRoundtrip('dynamodb', {
      region: 'us-east-1',
      tableName: 'scoreboard_state',
      endpoint: mock.url,
      accessKeyId: 'test',
      secretAccessKey: 'test',
    });
  } finally {
    await mock.close();
  }
});

test('DynamoDB 往返与 CAS（远程）', {
  skip: !(process.env.TEST_DYNAMODB_ENDPOINT && process.env.TEST_DYNAMODB_TABLE),
}, async () => {
  await externalRoundtrip('dynamodb', {
    region: process.env.TEST_DYNAMODB_REGION || 'us-east-1',
    tableName: process.env.TEST_DYNAMODB_TABLE,
    endpoint: process.env.TEST_DYNAMODB_ENDPOINT,
    accessKeyId: process.env.TEST_AWS_ACCESS_KEY_ID || 'test',
    secretAccessKey: process.env.TEST_AWS_SECRET_ACCESS_KEY || 'test',
  });
});

test('Firestore 配置与快照上限', () => {
  const dir = tempDir();
  try {
    const base = cfg.normalizeStorageConfig(
      { kind: 'firestore', options: { projectId: 'demo-project' } },
      { dataDir: dir },
    );
    assert.equal(base.options.databaseId, '(default)');
    assert.equal(base.options.collection, 'scoreboard_state');
    assert.equal(cfg.maxSnapshotBytesFor('firestore'), Math.floor(0.9 * 1024 * 1024));
    assert.throws(
      () => cfg.normalizeStorageConfig({ kind: 'firestore', options: {} }, { dataDir: dir }),
      /请至少填写/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 内存 Firestore mock：实现单文档读写与事务内 CAS。 */
function createFirestoreMock() {
  let doc = null;
  const ref = {
    async get() {
      return {
        exists: Boolean(doc),
        get: (field) => (doc ? doc[field] : undefined),
      };
    },
    async delete() {
      doc = null;
    },
  };
  return {
    collection() {
      return { doc() { return ref; } };
    },
    async runTransaction(fn) {
      const tx = {
        async get(target) { return target.get(); },
        set(_target, data) { doc = data; },
      };
      return fn(tx);
    },
    async terminate() {},
  };
}

test('Firestore 本地模拟往返与 CAS', async () => {
  const { createFirestoreStorage } = require('../server/storage/firestore.js');
  const mock = createFirestoreMock();
  const make = () => createFirestoreStorage({ projectId: 'demo', clientFactory: () => mock });
  const first = make();
  const second = make();
  await first.init();
  await second.init();
  try {
    await first.removeSnapshot();
    assert.equal(await first.load(), null);

    const created = await first.save(
      { version: 2, marker: 'firestore' },
      { expectedRevision: first.getRevision() },
    );
    assert.ok(created.revision !== undefined);

    await second.init();
    await second.load();
    assert.equal((await second.load()).marker, 'firestore');
    const stale = second.getRevision();
    await first.save(
      { version: 3, marker: 'firestore' },
      { expectedRevision: first.getRevision() },
    );
    await assert.rejects(
      () => second.save({ version: 4 }, { expectedRevision: stale }),
      (error) => error.name === 'StorageConflictError',
    );

    await second.load();
    await second.save(
      { version: 5, marker: 'firestore' },
      { expectedRevision: second.getRevision() },
    );
    assert.equal((await second.load()).marker, 'firestore');

    await second.removeSnapshot();
    assert.equal(await second.load(), null);
  } finally {
    await first.close();
    await second.close();
  }
});

test('Firestore 往返与 CAS（远程）', {
  skip: !process.env.TEST_FIRESTORE_PROJECT_ID,
}, async () => {
  await externalRoundtrip('firestore', {
    projectId: process.env.TEST_FIRESTORE_PROJECT_ID,
    databaseId: process.env.TEST_FIRESTORE_DATABASE_ID || '(default)',
    collection: process.env.TEST_FIRESTORE_COLLECTION || ('scoreboard_test_' + process.pid),
  });
});

test('S3 与 etcd 配置、密钥与快照上限', () => {
  const dir = tempDir();
  try {
    const s3 = cfg.normalizeStorageConfig(
      { kind: 's3', options: { bucket: 'my-bucket' } },
      { dataDir: dir },
    );
    assert.equal(s3.options.keyPrefix, 'scoreboard');
    assert.equal(s3.options.forcePathStyle, false);
    assert.throws(
      () => cfg.normalizeStorageConfig({ kind: 's3', options: {} }, { dataDir: dir }),
      /请至少填写/,
    );
    const s3red = cfg.redactStorageConfig(cfg.normalizeStorageConfig(
      { kind: 's3', options: { bucket: 'my-bucket', secretAccessKey: 'secret-key', sessionToken: 'session' } },
      { dataDir: dir },
    ));
    assert.equal(s3red.options.secretAccessKey, undefined);
    assert.equal(s3red.options.sessionToken, undefined);
    assert.ok(!JSON.stringify(s3red).includes('secret-key'));

    const etcd = cfg.normalizeStorageConfig(
      { kind: 'etcd', options: { endpoint: 'http://127.0.0.1:2379' } },
      { dataDir: dir },
    );
    assert.equal(etcd.options.prefix, 'scoreboard');
    assert.equal(cfg.maxSnapshotBytesFor('etcd'), Math.floor(1.4 * 1024 * 1024));
    assert.throws(
      () => cfg.normalizeStorageConfig({ kind: 'etcd', options: {} }, { dataDir: dir }),
      /请至少填写/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 内存 S3 mock：支持对象读写、ETag 与 If-Match / If-None-Match。 */
function createS3Mock() {
  const objects = new Map();
  let counter = 0;
  const server = http.createServer((req, res) => {
    const send = (status, body, headers = {}) => {
      res.writeHead(status, headers);
      res.end(body || '');
    };
    const xmlError = (status, code, message) => send(status,
      `<Error><Code>${code}</Code><Message>${message}</Message></Error>`,
      { 'Content-Type': 'application/xml' });
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const objectPath = decodeURIComponent(url.pathname);
      const existing = objects.get(objectPath);
      if (req.method === 'HEAD') {
        if (!existing) return send(404, '', {});
        return send(200, '', { ETag: existing.etag });
      }
      if (req.method === 'GET') {
        if (!existing) return xmlError(404, 'NoSuchKey', 'not found');
        return send(200, existing.body, {
          'Content-Type': 'application/json',
          ETag: existing.etag,
        });
      }
      if (req.method === 'PUT') {
        if (req.headers['if-none-match'] === '*' && existing) {
          return xmlError(412, 'PreconditionFailed', 'object exists');
        }
        if (req.headers['if-match'] && (!existing || req.headers['if-match'] !== existing.etag)) {
          return xmlError(412, 'PreconditionFailed', 'etag mismatch');
        }
        counter += 1;
        const etag = `"mock-${counter}"`;
        objects.set(objectPath, { body: raw, etag });
        return send(200, '', { ETag: etag });
      }
      if (req.method === 'DELETE') {
        objects.delete(objectPath);
        return send(204, '');
      }
      return send(405, '');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

test('S3 本地模拟往返与 CAS', async () => {
  const mock = await createS3Mock();
  try {
    await externalRoundtrip('s3', {
      region: 'us-east-1',
      bucket: 'test-bucket',
      keyPrefix: 'scoreboard',
      endpoint: mock.url,
      forcePathStyle: true,
      accessKeyId: 'test',
      secretAccessKey: 'test',
    });
  } finally {
    await mock.close();
  }
});

/** 内存 etcd v3 HTTP mock：range / put / txn / deleterange。 */
function createEtcdMock() {
  let value = null;
  let version = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const send = (status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch (_) { return send(400, { error: 'bad json' }); }
      const url = new URL(req.url || '/', 'http://127.0.0.1');

      if (url.pathname === '/v3/auth/authenticate') {
        if (body.name !== 'root' || body.password !== 'secret') {
          return send(401, { error: 'authentication failed' });
        }
        return send(200, { token: 'test-token' });
      }
      if (url.pathname === '/v3/kv/range') {
        if (value == null) return send(200, {});
        return send(200, {
          kvs: [{
            key: body.key,
            value: Buffer.from(value, 'utf8').toString('base64'),
            version: String(version),
          }],
        });
      }
      if (url.pathname === '/v3/kv/put') {
        value = Buffer.from(String(body.value || ''), 'base64').toString('utf8');
        version += 1;
        return send(200, {});
      }
      if (url.pathname === '/v3/kv/txn') {
        const compare = Array.isArray(body.compare) ? body.compare[0] : null;
        const expected = compare ? Number(compare.version) : NaN;
        if (expected !== version) return send(200, { succeeded: false });
        const put = body.success && body.success[0] && body.success[0].requestPut;
        if (put) {
          value = Buffer.from(String(put.value || ''), 'base64').toString('utf8');
          version += 1;
        }
        return send(200, { succeeded: true });
      }
      if (url.pathname === '/v3/kv/deleterange') {
        value = null;
        version = 0;
        return send(200, {});
      }
      return send(404, { error: 'not found' });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

test('etcd 本地模拟往返与 CAS', async () => {
  const mock = await createEtcdMock();
  try {
    await externalRoundtrip('etcd', {
      endpoint: mock.url,
      prefix: 'scoreboard',
      username: 'root',
      password: 'secret',
    });
  } finally {
    await mock.close();
  }
});

test('S3 往返与 CAS（远程）', {
  skip: !(process.env.TEST_S3_BUCKET && process.env.TEST_S3_ENDPOINT),
}, async () => {
  await externalRoundtrip('s3', {
    region: process.env.TEST_S3_REGION || 'us-east-1',
    bucket: process.env.TEST_S3_BUCKET,
    keyPrefix: process.env.TEST_S3_KEY_PREFIX || ('scoreboard-test-' + process.pid),
    endpoint: process.env.TEST_S3_ENDPOINT,
    forcePathStyle: process.env.TEST_S3_FORCE_PATH_STYLE !== 'false',
    accessKeyId: process.env.TEST_AWS_ACCESS_KEY_ID || 'test',
    secretAccessKey: process.env.TEST_AWS_SECRET_ACCESS_KEY || 'test',
  });
});

test('etcd 往返与 CAS（远程）', {
  skip: !process.env.TEST_ETCD_ENDPOINT,
}, async () => {
  await externalRoundtrip('etcd', {
    endpoint: process.env.TEST_ETCD_ENDPOINT,
    prefix: process.env.TEST_ETCD_PREFIX || ('scoreboard-test-' + process.pid),
    username: process.env.TEST_ETCD_USERNAME || '',
    password: process.env.TEST_ETCD_PASSWORD || '',
  });
});

test('LMDB 配置与路径限制', () => {
  const dir = tempDir();
  try {
    const lmdb = cfg.normalizeStorageConfig({ kind: 'lmdb', options: {} }, { dataDir: dir });
    assert.equal(lmdb.options.file, 'lmdb');
    assert.equal(lmdb.options.mapSizeMb, 1024);
    assert.throws(
      () => cfg.normalizeStorageConfig({ kind: 'lmdb', options: { file: '../escape' } }, { dataDir: dir }),
      /不能包含 \.\./,
    );
    assert.throws(
      () => cfg.normalizeStorageConfig({ kind: 'lmdb', options: { mapSizeMb: 8 } }, { dataDir: dir }),
      /不能小于 16/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

let hasLmdb = true;
try {
  require.resolve('lmdb');
} catch (_) {
  hasLmdb = false;
}

test('LMDB 本地目录往返与 CAS', { skip: !hasLmdb }, async () => {
  const dir = tempDir();
  try {
    await externalRoundtrip('lmdb', {
      file: path.join(dir, 'lmdb'),
      mapSizeMb: 64,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
