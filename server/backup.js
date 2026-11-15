'use strict';
// 自动备份：定时把完整 state 快照写入备份目录（默认 data/backups）
const fs = require('fs');
const path = require('path');
const { state, DATA_DIR } = require('./state');

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

function prune(dir, keep) {
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /^state-.*\.json$/.test(f))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
  } catch (_) {
    return;
  }
  for (const item of files.slice(keep)) {
    try { fs.unlinkSync(path.join(dir, item.f)); } catch (_) {}
  }
}

function runBackup() {
  const cfg = config();
  fs.mkdirSync(cfg.dir, { recursive: true });
  let name = timestampName();
  let full = path.join(cfg.dir, name);
  let i = 1;
  while (fs.existsSync(full)) {
    name = timestampName().replace(/\.json$/, '-' + i + '.json');
    full = path.join(cfg.dir, name);
    i += 1;
  }
  const tmp = full + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, full);
  prune(cfg.dir, cfg.keep);
  return { file: name, size: fs.statSync(full).size, dir: cfg.dir };
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
  const initial = setTimeout(() => {
    try { runBackup(); } catch (e) { console.error('[backup] 备份失败:', e.message); }
  }, 30 * 1000);
  if (initial.unref) initial.unref();
  timer = setInterval(() => {
    try { runBackup(); } catch (e) { console.error('[backup] 备份失败:', e.message); }
  }, intervalMs);
  if (timer.unref) timer.unref();
}

module.exports = { runBackup, listBackups, startBackupScheduler, config };
