'use strict';
// 孤儿上传文件：扫描 avatars/，清理未被任何项目引用且超过宽限期的普通文件。
// sounds/ 是全局音效库，用户导入后需永久保留在可选菜单中，不参与孤儿清理。
const fs = require('fs');
const path = require('path');
const { state, AVATAR_DIR } = require('./state');

const FILE_RE = /^[\w.-]+\.(png|jpe?g|gif|webp|wav|ogg|mp3|m4a)$/i;

function envNumber(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function config() {
  return {
    autoEnabled: process.env.ORPHAN_CLEANUP_ENABLED === '1',
    graceHours: envNumber('ORPHAN_CLEANUP_GRACE_HOURS', 24),
  };
}

function collectReferences() {
  const refs = new Set();
  for (const project of Object.values(state.projects)) {
    for (const p of Object.values(project.people)) {
      if (p.avatar) refs.add(p.avatar);
      if (p.cardImage) refs.add(p.cardImage);
    }
    for (const t of Object.values(project.teams)) {
      if (t.avatar) refs.add(t.avatar);
      if (t.cardImage) refs.add(t.cardImage);
    }
    if (project.settings.bgImage) refs.add(project.settings.bgImage);
    if (project.settings.customSound) refs.add(project.settings.customSound);
  }
  return refs;
}

function listFiles(dir, prefix) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return [];
  }
  const out = [];
  for (const ent of entries) {
    if (!ent.isFile() || !FILE_RE.test(ent.name)) continue;
    try {
      const st = fs.lstatSync(path.join(dir, ent.name));
      if (!st.isFile()) continue;
      out.push({ key: prefix + '/' + ent.name, name: ent.name, size: st.size, mtime: st.mtimeMs });
    } catch (_) {}
  }
  return out;
}

function scanOrphans() {
  const refs = collectReferences();
  const cfg = config();
  const avatars = listFiles(AVATAR_DIR, 'avatars').filter((f) => !refs.has(f.key));
  return {
    avatars: { count: avatars.length, bytes: avatars.reduce((s, f) => s + f.size, 0), items: avatars },
    // 音效库文件永久保留
    sounds: { count: 0, bytes: 0, items: [] },
    graceHours: cfg.graceHours,
    autoEnabled: cfg.autoEnabled,
  };
}

function cleanupOrphans(options = {}) {
  const dryRun = Boolean(options.dryRun);
  const cfg = config();
  const cutoff = Date.now() - cfg.graceHours * 3600 * 1000;
  // 重新构建一次引用集合，降低并发上传时的误删概率
  const refs = collectReferences();
  const candidates = listFiles(AVATAR_DIR, 'avatars')
    .map((f) => ({ ...f, dir: AVATAR_DIR }))
    .filter((f) => !refs.has(f.key));

  const removed = [];
  let bytes = 0;
  let skippedRecent = 0;
  for (const f of candidates) {
    if (f.mtime > cutoff) {
      skippedRecent += 1;
      continue;
    }
    if (!dryRun) {
      try {
        fs.unlinkSync(path.join(f.dir, f.name));
        removed.push(f.key);
        bytes += f.size;
      } catch (e) {
        console.error('[cleanup] 删除失败:', f.key, e.message);
      }
    } else {
      removed.push(f.key);
      bytes += f.size;
    }
  }
  return { removed, removedCount: removed.length, bytes, skippedRecent, graceHours: cfg.graceHours, dryRun };
}

let timer = null;
function startCleanupScheduler() {
  const cfg = config();
  if (!cfg.autoEnabled || timer) return;
  const initial = setTimeout(() => {
    try { cleanupOrphans(); } catch (e) { console.error('[cleanup] 清理失败:', e.message); }
  }, 60 * 1000);
  if (initial.unref) initial.unref();
  timer = setInterval(() => {
    try { cleanupOrphans(); } catch (e) { console.error('[cleanup] 清理失败:', e.message); }
  }, 24 * 3600 * 1000);
  if (timer.unref) timer.unref();
}

module.exports = { scanOrphans, cleanupOrphans, startCleanupScheduler, collectReferences, config };
