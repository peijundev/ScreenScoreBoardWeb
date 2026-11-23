'use strict';
// 管理端存储后端配置：只允许管理员访问，响应永不包含密码。
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  state,
  save,
  flushSave,
  getStorageStatus,
  getStorageHealth,
  getActiveStorageConfig,
  exportLibraryState,
  sanitizeLibraryImport,
  LIBRARY_SECTIONS,
} = require('../../state');
const { createStorageFromConfig, describeStorageLocation } = require('../../storage');
const runtime = require('../../runtime');
const { broadcastState } = require('../../wss');
const { readRawBody } = require('../responses');
const {
  resolveStorageConfig,
  normalizeStorageConfig,
  mergeSecrets,
  redactStorageConfig,
  saveStorageConfig,
  describeBackends,
  configFingerprint,
  redactUrlPassword,
  maxSnapshotBytesFor,
  secretFieldNames,
} = require('../../storage-config');
const { migrateStorage } = require('../../storage/migrate');
const { withTimeout } = require('../../storage/common');
const { DATA_DIR } = require('../../paths');
const { send } = require('../../static');
const { config } = require('../../config');
const { logger } = require('../../logger');
const { ApiUnprocessableError, ApiConflictError } = require('../errors');

let healthCache = { at: 0, value: /** @type {any} */ (null) };
let migrationRunning = false;

function noStore(ctx) {
  ctx.res.setHeader('Cache-Control', 'no-store');
}

function actorOf(ctx) {
  return (ctx.auth && ctx.auth.username) || '';
}

/** @param {any} storageConfig */
function secretValues(storageConfig) {
  if (!storageConfig) return [];
  const options = storageConfig.options || {};
  return secretFieldNames(storageConfig.kind)
    .map((name) => options[name])
    .filter((value) => typeof value === 'string' && value.length > 0);
}

/** @param {string} text @param {any} storageConfig */
function redactSecrets(text, storageConfig) {
  let out = text;
  for (const value of secretValues(storageConfig)) out = out.split(value).join('***');
  return redactUrlPassword(out);
}

/** @param {any} error @param {any} storageConfig */
function safeMessage(error, storageConfig) {
  const message = error && error.message ? String(error.message) : '连接失败';
  return redactSecrets(message, storageConfig);
}

/** @param {string|null|undefined} text @param {any} storageConfig */
function sanitizeText(text, storageConfig) {
  if (!text) return text;
  return redactSecrets(String(text), storageConfig);
}

/** @param {any} runtime @param {any} storageConfig */
function sanitizeHealth(runtime, storageConfig) {
  if (!runtime) return runtime;
  return {
    ...runtime,
    lastSaveError: sanitizeText(runtime.lastSaveError, storageConfig),
    lastError: sanitizeText(runtime.lastError, storageConfig),
    warnings: Array.isArray(runtime.warnings)
      ? runtime.warnings.map((warning) => sanitizeText(warning, storageConfig))
      : runtime.warnings,
  };
}

/** @param {any} ctx */
async function getConfig(ctx) {
  noStore(ctx);
  const resolved = resolveStorageConfig();
  const status = getStorageStatus();
  const runtime = sanitizeHealth(await getStorageHealth({ probe: false }), resolved.config);
  const restartRequired = Boolean(
    status.configHash && status.configHash !== configFingerprint(resolved.config),
  );
  // 「当前运行中」的位置以启动时实际生效的配置为准；配置刚保存、尚未重启时两者可能不同。
  const activeConfig = getActiveStorageConfig() || resolved.config;
  return {
    data: {
      config: redactStorageConfig(resolved.config, {
        source: resolved.source,
        configPath: resolved.configPath,
      }),
      active: {
        kind: status.kind,
        source: status.source,
        revision: status.revision,
        lastSaveAt: status.lastSaveAt,
        lastSaveError: status.lastSaveError,
        conflict: status.conflict,
      },
      location: {
        dataDir: DATA_DIR,
        configFile: resolved.configPath,
        active: describeStorageLocation(activeConfig, DATA_DIR),
      },
      backends: describeBackends(),
      restartRequired,
      runtime,
    },
  };
}

function parseLibraryScope(raw) {
  if (raw == null || raw === '') return [...LIBRARY_SECTIONS];
  const list = String(raw).split(',').map((item) => item.trim()).filter(Boolean);
  if (!list.length) throw new ApiUnprocessableError('请选择导出/导入范围');
  const invalid = list.filter((item) => !LIBRARY_SECTIONS.includes(item));
  if (invalid.length) {
    throw new ApiUnprocessableError('不支持的数据范围：' + invalid.join('、'));
  }
  return [...new Set(list)];
}

function libraryStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function libraryContentType(format) {
  if (format === 'sqlite') return 'application/vnd.sqlite3';
  if (format === 'txt') return 'text/plain; charset=utf-8';
  return 'application/json; charset=utf-8';
}

function libraryExtension(format) {
  if (format === 'sqlite') return 'db';
  if (format === 'txt') return 'txt';
  return 'json';
}

/** 整库导出：可选 JSON / SQLite / TXT / 当前后端原生文件。 */
async function exportLibraryHandler(ctx) {
  const format = String(ctx.query.format || 'json');
  if (!['json', 'sqlite', 'txt', 'native'].includes(format)) {
    throw new ApiUnprocessableError('不支持的导出格式：' + format);
  }
  const scope = parseLibraryScope(ctx.query.scope);
  await flushSave();

  if (format === 'native') {
    const active = getActiveStorageConfig() || resolveStorageConfig().config;
    const kind = String(active.kind || '');
    const location = describeStorageLocation(active, DATA_DIR);
    if (location.type !== 'file' || !['json', 'txt', 'sqlite'].includes(kind)) {
      throw new ApiUnprocessableError('当前后端不是可导出的单文件后端（JSON / TXT / SQLite）');
    }
    let data;
    try {
      data = fs.readFileSync(location.path);
    } catch (_) {
      throw new ApiUnprocessableError('当前后端数据文件尚未生成');
    }
    send(ctx.res, 200, data, {
      'Content-Type': libraryContentType(kind),
      'Content-Disposition': `attachment; filename="screenscoreboard-native-${libraryStamp()}.${kind === 'sqlite' ? 'db' : kind === 'txt' ? 'txt' : 'json'}"`,
      'Cache-Control': 'no-store',
    });
    return;
  }

  if (format === 'sqlite') {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssb-library-'));
    const tempFile = path.join(tempDir, 'library.db');
    try {
      const target = createStorageFromConfig(
        { kind: 'sqlite', options: { file: tempFile } },
        { dataDir: tempDir },
      );
      await target.init();
      await target.save(exportLibraryState(scope), { expectedRevision: null });
      await target.close();
      const data = fs.readFileSync(tempFile);
      send(ctx.res, 200, data, {
        'Content-Type': libraryContentType('sqlite'),
        'Content-Disposition': `attachment; filename="screenscoreboard-library-${libraryStamp()}.db"`,
        'Cache-Control': 'no-store',
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    return;
  }

  const library = exportLibraryState(scope);
  const body = format === 'txt'
    ? JSON.stringify(library, null, 2)
    : JSON.stringify({
        format: 'screenscoreboard.library',
        version: 1,
        exportedAt: new Date().toISOString(),
        scope,
        state: library,
      });
  send(ctx.res, 200, body, {
    'Content-Type': libraryContentType(format),
    'Content-Disposition': `attachment; filename="screenscoreboard-library-${libraryStamp()}.${libraryExtension(format)}"`,
    'Cache-Control': 'no-store',
  });
}

/** 整库导入：读取 JSON / SQLite / TXT（自动识别）并按所选范围替换数据。 */
async function importLibraryHandler(ctx) {
  const format = String(ctx.query.format || 'auto');
  if (!['auto', 'json', 'txt', 'sqlite'].includes(format)) {
    throw new ApiUnprocessableError('不支持的导入格式：' + format);
  }
  const scope = parseLibraryScope(ctx.query.scope);
  const data = await readRawBody(ctx.req, 100 * 1024 * 1024, '导入文件超过上限（100MB）');
  if (!data.length) throw new ApiUnprocessableError('导入文件为空');

  let detected = format;
  if (format === 'auto') {
    detected = data.subarray(0, 16).toString('latin1') === 'SQLite format 3\u0000'
      ? 'sqlite'
      : 'json';
  }
  let parsed;
  if (detected === 'sqlite') {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssb-import-'));
    const tempFile = path.join(tempDir, 'library.db');
    try {
      fs.writeFileSync(tempFile, data);
      const source = createStorageFromConfig(
        { kind: 'sqlite', options: { file: tempFile } },
        { dataDir: tempDir },
      );
      await source.init();
      parsed = await source.load();
      await source.close();
      if (!parsed) throw new ApiUnprocessableError('SQLite 文件中没有数据');
    } catch (error) {
      if (error instanceof ApiUnprocessableError) throw error;
      throw new ApiUnprocessableError(
        'SQLite 文件无法读取：' + (error && error.message ? error.message : '未知错误'),
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  } else {
    try {
      parsed = JSON.parse(data.toString('utf8'));
    } catch (_) {
      throw new ApiUnprocessableError('文件不是有效的 JSON/TXT');
    }
  }

  const imported = sanitizeLibraryImport(parsed, scope);
  const oldProjectIds = Object.keys(state.projects);
  if (imported.projects) state.projects = imported.projects;
  if (imported.themes) state.themes = imported.themes;
  if (imported.themeDrafts) state.themeDrafts = imported.themeDrafts;

  // 清理悬空草稿与主题引用
  for (const projectId of Object.keys(state.themeDrafts)) {
    if (!state.projects[projectId]) delete state.themeDrafts[projectId];
  }
  if (imported.projects) {
    for (const project of Object.values(state.projects)) {
      if (project.themeId && !state.themes[project.themeId]) {
        project.themeId = null;
        project.themeRevision = 0;
      }
    }
    for (const projectId of oldProjectIds) runtime.clearProjectRuntime(projectId);
  }

  save();
  await flushSave();
  broadcastState();
  return {
    data: {
      scope,
      detectedFormat: detected,
      counts: {
        projects: imported.projects ? Object.keys(imported.projects).length : null,
        themes: imported.themes ? Object.keys(imported.themes).length : null,
        themeDrafts: imported.themeDrafts ? Object.keys(imported.themeDrafts).length : null,
      },
    },
  };
}

/** @param {any} ctx */
async function getHealth(ctx) {
  noStore(ctx);
  const refresh = ctx.query && ctx.query.refresh === '1';
  if (!refresh && healthCache.value && Date.now() - healthCache.at < 10000) {
    return { data: healthCache.value };
  }
  const resolved = resolveStorageConfig();
  const value = sanitizeHealth(await getStorageHealth({ probe: true }), resolved.config);
  healthCache = { at: Date.now(), value };
  return { data: value };
}

/** @param {any} ctx */
async function saveConfig(ctx) {
  noStore(ctx);
  const body = ctx.body || {};
  const previous = resolveStorageConfig().config;
  const normalized = normalizeStorageConfig(
    { version: 1, kind: body.kind, options: body.options || {} },
    { source: 'storage.json', dataDir: DATA_DIR },
  );
  const merged = mergeSecrets(normalized, previous, { clearPassword: body.clearPassword === true });
  const saved = await saveStorageConfig(merged, { actor: actorOf(ctx), dataDir: DATA_DIR });
  healthCache = { at: 0, value: null };
  logger.info('存储配置已保存（重启后生效）', {
    kind: saved.kind,
    actor: actorOf(ctx) || 'unknown',
  });
  return {
    data: {
      saved: true,
      restartRequired: true,
      config: redactStorageConfig(saved, { source: 'storage.json' }),
      warnings: ['配置已保存，重启后生效；本次不会自动迁移数据。'],
    },
  };
}

/** @param {any} ctx */
async function testConnection(ctx) {
  noStore(ctx);
  const body = ctx.body || {};
  const previous = resolveStorageConfig().config;
  const normalized = normalizeStorageConfig(
    { version: 1, kind: body.kind, options: body.options || {} },
    { source: 'storage.json', dataDir: DATA_DIR },
  );
  const target = mergeSecrets(normalized, previous, {});
  let storage = null;
  try {
    storage = createStorageFromConfig(target, { dataDir: DATA_DIR });
    await withTimeout(
      storage.init(),
      config.storage.connectTimeoutMs,
      '测试连接',
    );
    const existing = await storage.load();
    const health = await storage.health({ probe: true });
    return {
      data: {
        ok: true,
        kind: target.kind,
        latencyMs: health.latencyMs || 0,
        existing: existing !== null,
        revision: typeof storage.getRevision === 'function' ? storage.getRevision() : null,
        warnings: health.warnings || [],
      },
    };
  } catch (error) {
    return {
      data: {
        ok: false,
        kind: target.kind,
        code: (error && error.code) || 'CONNECTION_FAILED',
        message: safeMessage(error, target),
        latencyMs: 0,
        warnings: [],
      },
    };
  } finally {
    if (storage) {
      try { await storage.close(); } catch (_) {}
    }
  }
}

/** @param {any} ctx */
async function migrate(ctx) {
  noStore(ctx);
  if (migrationRunning) {
    throw new ApiConflictError('已有迁移任务正在进行');
  }
  const body = ctx.body || {};
  const mode = body.mode === 'empty' ? 'empty' : 'copy';
  if (body.mode != null && body.mode !== 'copy' && body.mode !== 'empty') {
    throw new ApiUnprocessableError('mode 只能是 copy 或 empty');
  }
  const previous = resolveStorageConfig().config;
  const normalized = normalizeStorageConfig(
    { version: 1, kind: body.config && body.config.kind, options: (body.config && body.config.options) || {} },
    { source: 'storage.json', dataDir: DATA_DIR },
  );
  const target = mergeSecrets(normalized, previous, { clearPassword: body.clearPassword === true });
  const backendLimit = maxSnapshotBytesFor(target.kind);
  const maxBytes = backendLimit > 0
    ? Math.min(config.storage.migrationMaxBytes, backendLimit)
    : config.storage.migrationMaxBytes;

  migrationRunning = true;
  try {
    await flushSave();
    const snapshot = JSON.parse(JSON.stringify(state));
    const result = await migrateStorage({
      targetConfig: target,
      mode,
      overwrite: body.overwrite === true,
      snapshot,
      maxBytes,
      dataDir: DATA_DIR,
      ownerId: `migrate:${process.pid}:${Date.now()}`,
    });
    const saved = await saveStorageConfig(target, { actor: actorOf(ctx), dataDir: DATA_DIR });
    healthCache = { at: 0, value: null };
    logger.info('存储迁移完成，配置已保存（重启后生效）', {
      kind: saved.kind,
      mode,
      bytes: result.bytes,
      actor: actorOf(ctx) || 'unknown',
    });
    return {
      data: {
        ...result,
        saved: true,
        restartRequired: true,
        warnings: [
          '迁移的是保存时刻的快照；重启前对旧后端的写入不会同步到新后端，请尽快重启。',
        ],
      },
    };
  } finally {
    migrationRunning = false;
  }
}

const routes = [
  {
    method: 'GET',
    path: '/storage',
    summary: '读取存储后端配置（管理员）',
    access: 'admin',
    mcp: false,
    handler: getConfig,
  },
  {
    method: 'GET',
    path: '/storage/export',
    summary: '整库导出（可选范围与格式）',
    access: 'admin',
    mcp: false,
    raw: true,
    handler: exportLibraryHandler,
  },
  {
    method: 'POST',
    path: '/storage/import',
    summary: '整库导入（JSON/SQLite/TXT，自动识别）',
    access: 'admin',
    mcp: false,
    raw: true,
    mutates: true,
    handler: importLibraryHandler,
  },
  {
    method: 'GET',
    path: '/storage/health',
    summary: '存储后端健康诊断（管理员）',
    access: 'admin',
    mcp: false,
    handler: getHealth,
  },
  {
    method: 'PUT',
    path: '/storage',
    summary: '保存存储后端配置（管理员，重启后生效）',
    access: 'admin',
    mcp: false,
    bodyLimit: 32 * 1024,
    handler: saveConfig,
  },
  {
    method: 'POST',
    path: '/storage/test',
    summary: '测试存储后端连接（管理员）',
    access: 'admin',
    mcp: false,
    bodyLimit: 16 * 1024,
    handler: testConnection,
  },
  {
    method: 'POST',
    path: '/storage/migrate',
    summary: '迁移数据并保存存储配置（管理员）',
    access: 'admin',
    mcp: false,
    bodyLimit: 32 * 1024,
    handler: migrate,
  },
];

module.exports = { routes };
