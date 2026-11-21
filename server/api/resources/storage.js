'use strict';
// 管理端存储后端配置：只允许管理员访问，响应永不包含密码。
const { state, flushSave, getStorageStatus, getStorageHealth } = require('../../state');
const { createStorageFromConfig } = require('../../storage');
const {
  resolveStorageConfig,
  normalizeStorageConfig,
  mergeSecrets,
  redactStorageConfig,
  saveStorageConfig,
  describeBackends,
  configFingerprint,
  redactUrlPassword,
} = require('../../storage-config');
const { migrateStorage } = require('../../storage/migrate');
const { withTimeout } = require('../../storage/common');
const { DATA_DIR } = require('../../paths');
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

/** @param {any} error @param {any} storageConfig */
function safeMessage(error, storageConfig) {
  let message = error && error.message ? String(error.message) : '连接失败';
  const password = storageConfig && storageConfig.options && storageConfig.options.password;
  if (password) message = message.split(String(password)).join('***');
  return redactUrlPassword(message);
}

/** @param {string|null|undefined} text @param {any} storageConfig */
function sanitizeText(text, storageConfig) {
  if (!text) return text;
  let out = String(text);
  const password = storageConfig && storageConfig.options && storageConfig.options.password;
  if (password) out = out.split(String(password)).join('***');
  return redactUrlPassword(out);
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
      backends: describeBackends(),
      restartRequired,
      runtime,
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
  const maxBytes = target.kind === 'mongodb'
    ? Math.min(config.storage.migrationMaxBytes, Math.floor(15.5 * 1024 * 1024))
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
