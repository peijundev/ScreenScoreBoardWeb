'use strict';
// 自动备份：定时把完整 state 快照写入备份目录（默认 data/backups）
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { state, DATA_DIR } = require('./state');
const { logger } = require('./logger');

function envNumber(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function config() {
  const enabled = process.env.BACKUP_ENABLED !== '0';
  const intervalMinutes = Math.max(0, envNumber('BACKUP_INTERVAL_MINUTES', 30));
  const keep = Math.max(1, Math.floor(envNumber('BACKUP_KEEP', 20)));
  const dir = process.env.BACKUP_DIR || path.join(DATA_DIR, 'backups');
  return { enabled, intervalMinutes, keep, dir };
}

function timestampName(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return 'state-' + now.getFullYear() + p(now.getMonth() + 1) + p(now.getDate()) +
    '-' + p(now.getHours()) + p(now.getMinutes()) + p(now.getSeconds()) + '.json';
}

async function prune(dir, keep) {
  let files = [];
  try {
    const names = await fsp.readdir(dir);
    files = await Promise.all(
      names
        .filter((f) => /^state-.*\.json$/.test(f))
        .map(async (f) => {
          const st = await fsp.stat(path.join(dir, f));
          return { f, t: st.mtimeMs };
        }),
    );
    files.sort((a, b) => b.t - a.t);
  } catch (_) {
    return;
  }
  for (const item of files.slice(keep)) {
    try { await fsp.unlink(path.join(dir, item.f)); } catch (_) {}
  }
}

async function exists(file) {
  try {
    await fsp.access(file);
    return true;
  } catch (_) {
    return false;
  }
}

let running = null;

function runBackup() {
  // 同一时间只跑一个备份，避免重叠写
  if (running) return running;
  running = (async () => {
    const cfg = config();
    await fsp.mkdir(cfg.dir, { recursive: true });
    let name = timestampName();
    let full = path.join(cfg.dir, name);
    let i = 1;
    while (await exists(full)) {
      name = timestampName().replace(/\.json$/, '-' + i + '.json');
      full = path.join(cfg.dir, name);
      i += 1;
    }
    const tmp = full + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
    await fsp.rename(tmp, full);
    await prune(cfg.dir, cfg.keep);
    const st = await fsp.stat(full);
    return { file: name, size: st.size, dir: cfg.dir };
  })().finally(() => {
    running = null;
  });
  return running;
}

function listBackups() {
  const cfg = config();
  let files = [];
  try {
    files = fs.readdirSync(cfg.dir).filter((f) => /^state-.*\.json$/.test(f))
      .map((f) => {
        const st = fs.statSync(path.join(cfg.dir, f));
        return { name: f, size: st.size, mtime: st.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch (_) {}
  return { enabled: cfg.enabled, intervalMinutes: cfg.intervalMinutes, keep: cfg.keep, dir: cfg.dir, files };
}

let timer = null;
function startBackupScheduler() {
  const cfg = config();
  if (!cfg.enabled || cfg.intervalMinutes <= 0 || timer) return;
  const intervalMs = cfg.intervalMinutes * 60 * 1000;
  const run = () => {
    runBackup().catch((e) => logger.error('备份失败', { error: e.message }));
  };
  const initial = setTimeout(run, 30 * 1000);
  if (initial.unref) initial.unref();
  timer = setInterval(run, intervalMs);
  if (timer.unref) timer.unref();
}

module.exports = { runBackup, listBackups, startBackupScheduler, config };
