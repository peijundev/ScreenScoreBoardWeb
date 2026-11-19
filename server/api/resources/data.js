'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const {
  state, AVATAR_DIR, SOUND_DIR, save, flushSave,
  exportProjectData, sanitizeImportedProject, walkAssetRefs,
} = require('../../state');
const { broadcastState } = require('../../wss');
const { OPS } = require('../../ops');
const { runBackup, listBackups } = require('../../backup');
const { scanOrphans, cleanupOrphans } = require('../../cleanup');
const { send } = require('../../static');
const { readRawBody } = require('../responses');
const { commit, requireProject } = require('./common');
const { ApiUnprocessableError } = require('../errors');

function sniffImage(buf) {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 4 && buf.toString('ascii', 0, 4) === 'GIF8') return 'gif';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

function sniffAudio(buf) {
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') return 'wav';
  if (buf.length >= 4 && buf.toString('ascii', 0, 4) === 'OggS') return 'ogg';
  if (buf.length >= 3 && buf.toString('ascii', 0, 3) === 'ID3') return 'mp3';
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'mp3';
  if (buf.length >= 8 && buf.toString('ascii', 4, 8) === 'ftyp') return 'm4a';
  return null;
}

async function upload(ctx, kind) {
  const isImage = kind === 'images';
  const buf = await readRawBody(ctx.req, isImage ? 2 * 1024 * 1024 : 5 * 1024 * 1024, '文件超过上限');
  if (!buf.length) throw new ApiUnprocessableError('空文件');
  const ext = isImage ? sniffImage(buf) : sniffAudio(buf);
  if (!ext) throw new ApiUnprocessableError(isImage ? '仅支持 png/jpeg/webp/gif' : '仅支持 wav/ogg/mp3/m4a');
  const name = crypto.randomBytes(8).toString('hex') + '.' + ext;
  const dir = isImage ? AVATAR_DIR : SOUND_DIR;
  await fsp.writeFile(path.join(dir, name), buf);
  return { path: (isImage ? 'avatars/' : 'sounds/') + name, bytes: buf.length };
}

function assetPath(key) {
  if (typeof key !== 'string' || !/^(avatars|sounds)\/[\w.-]+$/.test(key)) return null;
  const name = key.split('/')[1];
  if (name !== path.basename(name)) return null;
  return path.join(key.startsWith('avatars/') ? AVATAR_DIR : SOUND_DIR, name);
}

function collectAssets(project) {
  const refs = new Set();
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
  const assets = {};
  const warnings = [];
  let total = 0;
  for (const ref of refs) {
    const full = assetPath(ref);
    if (!full) { warnings.push(ref + ' 路径非法，已跳过'); continue; }
    try {
      const st = fs.statSync(full);
      if (!st.isFile()) { warnings.push(ref + ' 不是文件，已跳过'); continue; }
      if (st.size > 5 * 1024 * 1024) { warnings.push(ref + ' 超过 5MB，已跳过'); continue; }
      if (total + st.size > 50 * 1024 * 1024) { warnings.push('资产总量超过 50MB，' + ref + ' 及后续已跳过'); break; }
      assets[ref] = fs.readFileSync(full).toString('base64');
      total += st.size;
    } catch (_) {
      warnings.push(ref + ' 不存在，已跳过');
    }
  }
  return { assets, warnings };
}

function importAssets(assets) {
  const map = new Map();
  let total = 0;
  if (assets == null) return map;
  if (typeof assets !== 'object') throw new ApiUnprocessableError('资产字段格式非法');
  for (const [key, b64] of Object.entries(assets)) {
    const full = assetPath(key);
    if (!full) throw new ApiUnprocessableError('资产路径非法：' + key);
    if (typeof b64 !== 'string') throw new ApiUnprocessableError('资产内容非法：' + key);
    const buf = Buffer.from(b64, 'base64');
    if (buf.length > 5 * 1024 * 1024) throw new ApiUnprocessableError('单个资产超过 5MB：' + key);
    if (total + buf.length > 50 * 1024 * 1024) throw new ApiUnprocessableError('资产总量超过 50MB');
    const isImage = key.startsWith('avatars/');
    const ext = isImage ? sniffImage(buf) : sniffAudio(buf);
    if (!ext) throw new ApiUnprocessableError('资产格式非法：' + key);
    const name = crypto.randomBytes(8).toString('hex') + '.' + ext;
    fs.writeFileSync(path.join(isImage ? AVATAR_DIR : SOUND_DIR, name), buf);
    map.set(key, (isImage ? 'avatars/' : 'sounds/') + name);
    total += buf.length;
  }
  return map;
}

function assetExists(key) {
  const full = assetPath(key);
  if (!full) return false;
  try { return fs.statSync(full).isFile(); } catch (_) { return false; }
}

function assignRanks(values, mode) {
  let dense = 0;
  let prev = null;
  let competition = 0;
  return values.map((score, i) => {
    const isNew = i === 0 || score !== prev;
    if (isNew) { dense += 1; competition = i + 1; prev = score; }
    if (mode === 'dense') return dense;
    if (mode === 'competition') return competition;
    return i + 1;
  });
}

function csvEscape(value) {
  let text = String(value == null ? '' : value);
  if (/^[=+\-@]/.test(text)) text = "'" + text;
  if (/[",\r\n]/.test(text)) text = '"' + text.replace(/"/g, '""') + '"';
  return text;
}

function scoresCsv(project, scope) {
  const entries = [];
  const teamName = (id) => (project.teams[id] ? project.teams[id].name : '');
  if (scope !== 'teams') {
    for (const p of Object.values(project.people)) {
      entries.push({ type: '人员', name: p.name, team: teamName(p.teamId), score: p.score, createdAt: p.createdAt });
    }
  }
  if (scope !== 'people') {
    for (const t of Object.values(project.teams)) {
      const total = Object.values(project.people)
        .filter((p) => p.teamId === t.id)
        .reduce((sum, p) => sum + p.score, 0);
      entries.push({ type: '团队', name: t.name, team: '', score: total, createdAt: t.createdAt });
    }
  }
  entries.sort((a, b) => (b.score - a.score) || (a.createdAt - b.createdAt));
  const mode = project.settings.featureRankTies ? project.settings.rankTieMode : 'none';
  const ranks = assignRanks(entries.map((entry) => entry.score), mode);
  const lines = ['名次,类型,名称,所属团队,分数'];
  entries.forEach((entry, i) => {
    lines.push([ranks[i], entry.type, entry.name, entry.team, entry.score].map(csvEscape).join(','));
  });
  return '﻿' + lines.join('\r\n') + '\r\n';
}

const routes = [
  {
    method: 'GET', path: '/projects/:projectId/export', mcp: 'export_project', summary: '导出项目（可含资产）', raw: true,
    handler: (ctx) => {
      const project = requireProject(ctx.params.projectId);
      const withAssets = ctx.query.assets === '1' || ctx.query.assets === 'true';
      const payload = {
        format: 'screenscoreboard.project',
        version: 1,
        exportedAt: new Date().toISOString(),
        project: exportProjectData(project.id),
        warnings: [],
      };
      if (withAssets) {
        const collected = collectAssets(project);
        payload.assets = collected.assets;
        payload.warnings = collected.warnings;
      }
      const name = String(project.name || 'project').replace(/[\\/:*?"<>|]/g, '_');
      send(ctx.res, 200, JSON.stringify(payload), {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(name)}.json"`,
      });
    },
  },
  {
    method: 'POST', path: '/projects/import', mcp: 'import_project', summary: '导入项目（创建新项目）', mutates: true, bodyLimit: 64 * 1024 * 1024,
    handler: async (ctx) => {
      const parsed = ctx.body;
      if (parsed && parsed.format && parsed.version && parsed.version !== 1) {
        throw new ApiUnprocessableError('不支持的导入版本');
      }
      const project = sanitizeImportedProject(parsed);
      const map = importAssets(parsed && parsed.assets ? parsed.assets : null);
      walkAssetRefs(project, (ref) => {
        if (!ref) return null;
        if (map.has(ref)) return map.get(ref);
        return assetExists(ref) ? ref : null;
      });
      state.projects[project.id] = project;
      save();
      await flushSave();
      broadcastState();
      return {
        data: {
          projectId: project.id,
          name: project.name,
          people: Object.keys(project.people).length,
          teams: Object.keys(project.teams).length,
          assets: map.size,
        },
        status: 201,
      };
    },
  },
  {
    method: 'GET', path: '/projects/:projectId/scores.csv', mcp: 'export_scores_csv', summary: '导出分数 CSV', raw: true,
    handler: (ctx) => {
      const project = requireProject(ctx.params.projectId);
      const scope = ['all', 'people', 'teams'].includes(ctx.query.scope) ? ctx.query.scope : 'all';
      const name = String(project.name || 'scores').replace(/[\\/:*?"<>|]/g, '_');
      send(ctx.res, 200, scoresCsv(project, scope), {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(name)}-scores.csv"`,
      });
    },
  },
  {
    method: 'POST', path: '/assets/images', mcp: 'upload_image', summary: '上传图片（原始二进制）', raw: true, mutates: true,
    handler: async (ctx) => ({ data: await upload(ctx, 'images'), status: 201 }),
  },
  {
    method: 'POST', path: '/assets/sounds', mcp: 'upload_sound', summary: '上传音频（原始二进制）', raw: true, mutates: true,
    handler: async (ctx) => ({ data: await upload(ctx, 'sounds'), status: 201 }),
  },
  {
    method: 'GET', path: '/assets', mcp: 'list_assets', summary: '列出已上传资产',
    handler: () => {
      const list = (dir, prefix) => {
        try {
          return fs.readdirSync(dir)
            .filter((name) => /^[\w.-]+\.(png|jpe?g|gif|webp|wav|ogg|mp3|m4a)$/i.test(name))
            .sort()
            .map((name) => {
              const stat = fs.statSync(path.join(dir, name));
              return { path: prefix + '/' + name, bytes: stat.size, mtime: stat.mtimeMs };
            });
        } catch (_) {
          return [];
        }
      };
      return { data: { avatars: list(AVATAR_DIR, 'avatars'), sounds: list(SOUND_DIR, 'sounds') } };
    },
  },
  {
    method: 'GET', path: '/backups', mcp: 'list_backups', summary: '列出备份',
    handler: () => ({ data: listBackups() }),
  },
  {
    method: 'POST', path: '/backups/run', mcp: 'run_backup', summary: '立即备份', mutates: true,
    handler: async () => ({ data: await runBackup() }),
  },
  {
    method: 'GET', path: '/orphans', mcp: 'scan_orphans', summary: '扫描孤儿文件',
    handler: () => ({ data: scanOrphans() }),
  },
  {
    method: 'POST', path: '/orphans/cleanup', mcp: 'cleanup_orphans', summary: '清理孤儿文件（默认试运行）', mutates: true, destructive: true,
    handler: (ctx) => {
      if (ctx.body.dryRun === undefined) throw new ApiUnprocessableError('必须显式提供 dryRun');
      return { data: cleanupOrphans({ dryRun: Boolean(ctx.body.dryRun) }) };
    },
  },

  // ---------- op 逃生通道 ----------
  {
    method: 'POST', path: '/ops', mcp: 'call_op', summary: '直接执行 op（低层逃生通道，payload 自带 projectId）', mutates: true,
    handler: (ctx) => {
      const { op, payload } = ctx.body;
      if (!Object.prototype.hasOwnProperty.call(OPS, op)) throw new ApiUnprocessableError('未知操作: ' + op);
      return { data: commit(op, payload || {}) };
    },
  },
  {
    method: 'POST', path: '/projects/:projectId/ops', mcp: 'call_project_op', summary: '直接执行项目级 op（低层逃生通道，自动注入 projectId）', mutates: true,
    handler: (ctx) => {
      const { op, payload } = ctx.body;
      if (!Object.prototype.hasOwnProperty.call(OPS, op)) throw new ApiUnprocessableError('未知操作: ' + op);
      requireProject(ctx.params.projectId);
      return { data: commit(op, { ...(payload || {}), projectId: ctx.params.projectId }) };
    },
  },
];

module.exports = { routes, collectAssets, scoresCsv, sniffImage, sniffAudio };
