'use strict';
// 入口：http server、路由表、头像上传、挂载 WebSocket
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const {
  ASSET_KEY_RE, decodeOriginalName, uniqueFileName,
} = require('./filename');
const { serveStatic, send, PUBLIC_DIR } = require('./static');
const { config } = require('./config');
const { logger } = require('./logger');
const APP_VERSION = require('../package.json').version;
// 1.4.0 是原技术栈（原生 JS 前端）的最后一个发布版本；此后前端迁移到 React
const FINAL_TECH_STACK_RELEASE = '1.4.0';
const REACT_BUILT = fs.existsSync(path.join(PUBLIC_DIR, 'v2', 'admin.html'));
const {
  state,
  init: initState,
  AVATAR_DIR,
  SOUND_DIR,
  getStorageKind,
  getStorageStatus,
  exportProjectData,
  sanitizeImportedProject,
  walkAssetRefs,
  save: saveState,
  flushSave,
  onShutdown,
  OpError,
  publicState,
  getTheme,
  getThemeDraft,
} = require('./state');
const { themeSummary } = require('./theme/schema');
const { attachWSS, broadcastState } = require('./wss');
const { handleApiV1 } = require('./api');
const { handleMcpHttp } = require('./mcp/http');
const runtime = require('./runtime');
const { runBackup, listBackups, startBackupScheduler } = require('./backup');
const { scanOrphans, cleanupOrphans, startCleanupScheduler } = require('./cleanup');
const authStore = require('./auth/store');
const authHttp = require('./auth/http');
const { SYSTEM, ANONYMOUS, runAs } = require('./auth/context');
const { guardLegacy } = require('./api/legacy-access');
const { isLoopbackHost, isDirectLoopbackRequest, effectiveProtocol } = require('./security');

const PORT = Number(process.env.PORT) || 3000;
const cfg = config;
let wssInstance = null;
const MAX_IMAGE = 2 * 1024 * 1024; // 2 MB
const MAX_SOUND = 5 * 1024 * 1024; // 5 MB

// 魔数 → 扩展名（不信任客户端声明的 Content-Type）
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

// 通用二进制上传：大小限制 + 魔数校验 + 服务端随机文件名
function handleUpload(req, res, opts) {
  const chunks = [];
  let size = 0;
  let aborted = false;
  req.on('data', (c) => {
    size += c.length;
    if (size > opts.maxBytes) {
      aborted = true;
      send(res, 413, JSON.stringify({ error: '文件超过 ' + Math.round(opts.maxBytes / 1024 / 1024) + 'MB 上限' }), { 'Content-Type': 'application/json' });
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => {
    if (aborted) return;
    const buf = Buffer.concat(chunks);
    if (buf.length === 0) {
      return send(res, 400, JSON.stringify({ error: '空文件' }), { 'Content-Type': 'application/json' });
    }
    const ext = opts.sniff(buf);
    if (!ext) {
      return send(res, 415, JSON.stringify({ error: opts.unsupported }), { 'Content-Type': 'application/json' });
    }
    const name = uniqueFileName(
      opts.dir,
      decodeOriginalName(req),
      ext,
      opts.prefix === 'avatars' ? 'image' : 'audio',
    );
    try {
      // 同步写盘：exists 检查与写入之间不插入其他上传请求，避免同名冲突
      fs.writeFileSync(path.join(opts.dir, name), buf);
      send(res, 200, JSON.stringify({ path: opts.prefix + '/' + name }), { 'Content-Type': 'application/json' });
    } catch (e) {
      logger.error('上传写盘失败', { error: e.message });
      send(res, 500, JSON.stringify({ error: '保存文件失败' }), { 'Content-Type': 'application/json' });
    }
  });
  req.on('error', (e) => { logger.warn('上传请求中断', { error: e.message }); });
}

// ---------- 数据导出 / 导入 / CSV / 备份 / 清理 ----------
function sendJSON(res, code, data) {
  send(res, code, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8' });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('请求体超过上限'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function assetPath(key) {
  if (typeof key !== 'string' || !ASSET_KEY_RE.test(key)) return null;
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
  if (typeof assets !== 'object') throw new OpError('资产字段格式非法');
  for (const [key, b64] of Object.entries(assets)) {
    const full = assetPath(key);
    if (!full) throw new OpError('资产路径非法：' + key);
    if (typeof b64 !== 'string') throw new OpError('资产内容非法：' + key);
    const buf = Buffer.from(b64, 'base64');
    if (buf.length > 5 * 1024 * 1024) throw new OpError('单个资产超过 5MB：' + key);
    if (total + buf.length > 50 * 1024 * 1024) throw new OpError('资产总量超过 50MB');
    const isImage = key.startsWith('avatars/');
    const ext = isImage ? sniffImage(buf) : sniffAudio(buf);
    if (!ext) throw new OpError('资产格式非法：' + key);
    const dir = isImage ? AVATAR_DIR : SOUND_DIR;
    const name = uniqueFileName(dir, key.split('/').pop(), ext, isImage ? 'image' : 'audio');
    fs.writeFileSync(path.join(dir, name), buf);
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
  let s = String(value == null ? '' : value);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
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
        .reduce((s, p) => s + p.score, 0);
      entries.push({ type: '团队', name: t.name, team: '', score: total, createdAt: t.createdAt });
    }
  }
  entries.sort((a, b) => (b.score - a.score) || (a.createdAt - b.createdAt));
  const mode = project.settings.featureRankTies ? project.settings.rankTieMode : 'none';
  const ranks = assignRanks(entries.map((e) => e.score), mode);
  const lines = ['名次,类型,名称,所属团队,分数'];
  entries.forEach((e, i) => {
    lines.push([ranks[i], e.type, e.name, e.team, e.score].map(csvEscape).join(','));
  });
  return '﻿' + lines.join('\r\n') + '\r\n';
}

async function handleImport(req, res) {
  try {
    const body = await readBody(req, cfg.maxImportBytes);
    let parsed;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch (_) {
      throw new OpError('导入文件不是合法 JSON');
    }
    if (parsed && parsed.format && parsed.version && parsed.version !== 1) {
      throw new OpError('不支持的导入版本');
    }
    const project = sanitizeImportedProject(parsed);
    const map = importAssets(parsed && parsed.assets ? parsed.assets : null);
    walkAssetRefs(project, (ref) => {
      if (!ref) return null;
      if (map.has(ref)) return map.get(ref);
      return assetExists(ref) ? ref : null;
    });
    state.projects[project.id] = project;
    saveState();
    await flushSave();
    broadcastState();
    sendJSON(res, 200, {
      projectId: project.id,
      name: project.name,
      people: Object.keys(project.people).length,
      teams: Object.keys(project.teams).length,
      assets: map.size,
    });
  } catch (e) {
    const status = e.status || (e instanceof OpError || e instanceof SyntaxError ? 400 : 500);
    if (status >= 500) console.error('[import] 导入失败:', e);
    sendJSON(res, status, { error: e.message });
  }
}

async function handleCleanup(req, res) {
  try {
    const body = await readBody(req, 1024 * 1024);
    let opts = {};
    if (body.length) {
      try { opts = JSON.parse(body.toString('utf8')) || {}; } catch (_) { opts = {}; }
    }
    sendJSON(res, 200, cleanupOrphans({ dryRun: Boolean(opts.dryRun) }));
  } catch (e) {
    sendJSON(res, e.status || 500, { error: e.message });
  }
}

function routeRequest(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  // REST v1：放在所有旧路由之前，避免被前缀匹配吞掉；旧 /api/* 行为不变
  if (p === '/api/v1' || p.startsWith('/api/v1/')) {
    void handleApiV1(req, res, url);
    return;
  }
  if (p === '/mcp') {
    if (!authHttp.requireOrigin(req, res)) return;
    if (!authHttp.requireRole(req, res, 'admin')) return;
    if (!authHttp.requireCsrf(req, res, p)) return;
    void handleMcpHttp(req, res);
    return;
  }

  // 旧版 /api/* 统一守卫：未知路径默认 admin，避免新增旧路由漏保护
  if (p === '/api' || p.startsWith('/api/')) {
    if (!guardLegacy(req, res, p)) return;
  }

  if (req.method === 'GET' && p === '/') {
    return send(res, 302, '', { Location: '/display' });
  }
  // React 前端入口（构建产物在 public/v2/）；未构建时返回明确提示，不再回退旧版页面
  if (req.method === 'GET' && (p === '/admin' || p === '/admin-v2' || p === '/display' || p === '/display-v2')) {
    const isAdmin = p === '/admin' || p === '/admin-v2';
    if (serveStatic(res, PUBLIC_DIR, isAdmin ? '/v2/admin.html' : '/v2/display.html')) return;
    return send(res, 503, (
      '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>前端未构建</title></head>' +
        '<body style="font-family:sans-serif;padding:40px;line-height:1.8">' +
        '<h1>前端尚未构建</h1><p>请先执行 <code>npm run build:web</code>，或直接运行 <code>npm run start:build</code>。</p>' +
        '</body></html>'
    ), { 'Content-Type': 'text/html; charset=utf-8' });
  }
  if (req.method === 'GET' && p === '/api/health') {
    return sendJSON(res, 200, {
      ok: true,
      version: APP_VERSION,
      uptimeSec: Math.round(process.uptime()),
      storage: getStorageKind(),
      storageOk: !getStorageStatus().conflict,
      wsClients: wssInstance ? wssInstance.clients.size : 0,
      projects: Object.keys(state.projects).length,
      ts: Date.now(),
    });
  }
  if (req.method === 'GET' && p === '/api/state') {
    return send(res, 200, JSON.stringify({ ...publicState(), runtime: runtime.getRuntimeSnapshot() }), {
      'Content-Type': 'application/json',
    });
  }
  if (req.method === 'GET' && p === '/api/themes') {
    const themes = Object.values(state.themes)
      .map(themeSummary)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return sendJSON(res, 200, { themes });
  }
  if (req.method === 'GET' && p.startsWith('/api/themes/')) {
    const id = decodeURIComponent(p.slice('/api/themes/'.length));
    try {
      const theme = getTheme(id);
      return sendJSON(res, 200, { theme, summary: themeSummary(theme) });
    } catch (e) {
      return sendJSON(res, e instanceof OpError ? 404 : 500, { error: e.message });
    }
  }
  if (req.method === 'GET' && /^\/api\/projects\/[^/]+\/theme-draft$/.test(p)) {
    const projectId = decodeURIComponent(p.split('/')[3] || '');
    try {
      return sendJSON(res, 200, { theme: getThemeDraft(projectId) });
    } catch (e) {
      return sendJSON(res, e instanceof OpError ? 404 : 500, { error: e.message });
    }
  }
  if (req.method === 'GET' && p === '/api/version') {
    return send(res, 200, JSON.stringify({
      version: APP_VERSION,
      // 1.4.0 是原技术栈的最后一个发布版本（历史信息，不代表当前运行的前端）
      finalForTechStack: APP_VERSION === FINAL_TECH_STACK_RELEASE,
      // 当前前端是否已构建：react = public/v2 已构建；missing = 尚未构建
      frontend: REACT_BUILT ? 'react' : 'missing',
    }), { 'Content-Type': 'application/json' });
  }
  if (req.method === 'GET' && p === '/api/export') {
    const projectId = url.searchParams.get('project');
    try {
      if (!projectId) throw new OpError('缺少 project 参数');
      const project = exportProjectData(projectId);
      let assets = null;
      let warnings = [];
      if (url.searchParams.get('assets') === '1') {
        const collected = collectAssets(project);
        assets = collected.assets;
        warnings = collected.warnings;
      }
      const payload = {
        format: 'screenscoreboard.project',
        version: 1,
        exportedAt: Date.now(),
        project,
        warnings,
      };
      if (assets) payload.assets = assets;
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="project-' + projectId + '.json"',
      });
      return res.end(JSON.stringify(payload));
    } catch (e) {
      return sendJSON(res, 404, { error: e.message });
    }
  }
  if (req.method === 'GET' && p === '/api/scores.csv') {
    const projectId = url.searchParams.get('project');
    try {
      if (!projectId) throw new OpError('缺少 project 参数');
      const project = exportProjectData(projectId);
      const scope = ['all', 'people', 'teams'].includes(url.searchParams.get('scope'))
        ? url.searchParams.get('scope') : 'all';
      const csv = scoresCsv(project, scope);
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="scores-' + projectId + '.csv"',
      });
      return res.end(csv);
    } catch (e) {
      return sendJSON(res, 404, { error: e.message });
    }
  }
  if (req.method === 'POST' && p === '/api/import') {
    void handleImport(req, res);
    return;
  }
  if (req.method === 'GET' && p === '/api/backups') {
    return sendJSON(res, 200, listBackups());
  }
  if (req.method === 'POST' && p === '/api/backups/run') {
    runBackup()
      .then((result) => sendJSON(res, 200, result))
      .catch((e) => sendJSON(res, 500, { error: e.message }));
    return;
  }
  if (req.method === 'GET' && p === '/api/orphans') {
    return sendJSON(res, 200, scanOrphans());
  }
  if (req.method === 'POST' && p === '/api/orphans/cleanup') {
    void handleCleanup(req, res);
    return;
  }
  if (req.method === 'POST' && p === '/api/avatar') {
    return handleUpload(req, res, {
      dir: AVATAR_DIR, prefix: 'avatars', maxBytes: MAX_IMAGE,
      sniff: sniffImage, unsupported: '仅支持 png/jpeg/webp/gif 图片',
    });
  }
  if (req.method === 'POST' && p === '/api/sound') {
    return handleUpload(req, res, {
      dir: SOUND_DIR, prefix: 'sounds', maxBytes: MAX_SOUND,
      sniff: sniffAudio, unsupported: '仅支持 wav/ogg/mp3/m4a 音频',
    });
  }
  if (req.method === 'GET' && p.startsWith('/avatars/')) {
    if (serveStatic(res, AVATAR_DIR, p.slice('/avatars'.length))) return;
    return send(res, 404, 'Not Found');
  }
  if (req.method === 'GET' && p.startsWith('/sounds/')) {
    if (serveStatic(res, SOUND_DIR, p.slice('/sounds'.length))) return;
    return send(res, 404, 'Not Found');
  }
  if (req.method === 'GET' && /\.[a-z0-9]+$/i.test(p)) {
    if (serveStatic(res, PUBLIC_DIR, p)) return;
    return send(res, 404, 'Not Found');
  }
  send(res, 404, 'Not Found');
}

let authEnabled = true;

function requestAuth(req) {
  if (!authEnabled) {
    return isDirectLoopbackRequest(req) ? SYSTEM : ANONYMOUS;
  }
  return authHttp.resolveRequest(req);
}

function handleRequest(req, res) {
  if (effectiveProtocol(req) === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }
  const auth = requestAuth(req);
  req.auth = auth;
  runAs(auth, () => routeRequest(req, res));
}

function createHttpServer() {
  if (cfg.tls.certFile && cfg.tls.keyFile) {
    const options = {
      cert: fs.readFileSync(cfg.tls.certFile),
      key: fs.readFileSync(cfg.tls.keyFile),
      minVersion: /** @type {any} */ ('TLSv1.2'),
    };
    if (cfg.tls.passphrase) options.passphrase = cfg.tls.passphrase;
    return https.createServer(options, handleRequest);
  }
  return http.createServer(handleRequest);
}

const server = createHttpServer();
const SERVER_PROTOCOL = cfg.tls.certFile ? 'https' : 'http';

// 启动服务；Electron 主进程也复用它（port 传 0 时由系统分配空闲端口）
async function start(options = {}) {
  const listenPort = options.port != null ? options.port : PORT;
  const listenHost = options.host || cfg.host;
  authEnabled = options.auth !== false;
  if (!authEnabled && !isLoopbackHost(listenHost)) {
    throw new Error('auth:false 仅允许绑定 loopback（127.0.0.1 / ::1 / localhost）');
  }

  await initState();
  authStore.init({ enabled: authEnabled });
  wssInstance = attachWSS(server, { log: logger.child({ scope: 'wss' }) });
  startBackupScheduler();
  startCleanupScheduler();

  if (authEnabled && authStore.isSetupRequired()) {
    logger.warn('管理员尚未初始化：请在本机打开管理端完成设置，或设置 ADMIN_PASSWORD / ADMIN_PASSWORD_FILE');
  }
  if (authEnabled && authStore.isOpenAccess()) {
    logger.warn('登录系统已关闭（开放模式）：所有访问者都会获得管理员权限，请仅在可信网络使用');
  }

  // 优雅退出：先断开 WS、停止接受 HTTP 连接，再由 state 层落盘
  onShutdown(async () => {
    authStore.flush();
    if (wssInstance) {
      for (const client of wssInstance.clients) {
        try { client.terminate(); } catch (_) {}
      }
      await new Promise((resolve) => wssInstance.close(() => resolve(undefined)));
    }
    const closed = new Promise((resolve) => server.close(() => resolve(undefined)));
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 3000))]);
  });

  const actualPort = await new Promise((resolve, reject) => {
    const onError = (e) => reject(e);
    server.once('error', onError);
    server.listen(listenPort, listenHost, () => {
      server.removeListener('error', onError);
      const addr = server.address();
      resolve(addr && typeof addr === 'object' ? addr.port : listenPort);
    });
  });
  logger.info('计分板服务已启动', {
    version: APP_VERSION,
    storage: getStorageKind(),
    frontend: REACT_BUILT ? 'React' : '未构建',
    host: listenHost,
    port: actualPort,
  });
  console.log(`  显示端  ${SERVER_PROTOCOL}://localhost:${actualPort}/display`);
  console.log(`  管理端  ${SERVER_PROTOCOL}://localhost:${actualPort}/admin`);
  if (!authEnabled) {
    console.log('  鉴权    已关闭（仅限 loopback 本机模式）');
  } else if (authStore.isOpenAccess()) {
    console.log('  鉴权    开放模式（无需登录，所有访问者拥有管理员权限）');
  }
  if (!REACT_BUILT) {
    console.log('  ※ 未检测到 React 构建产物，请先执行 npm run build:web');
  }
  return { server, port: actualPort };
}

process.on('uncaughtException', (err) => {
  logger.error('未捕获异常', { error: err.message, stack: err.stack });
  process.exitCode = 1;
  // 尽量落盘后退出；shutdown 内部有超时保护
  void require('./state').shutdown(1);
});
process.on('unhandledRejection', (reason) => {
  const err = /** @type {any} */ (reason);
  logger.error('未处理的 Promise 拒绝', {
    error: err && err.message ? err.message : String(reason),
  });
});

if (require.main === module) {
  start().catch((e) => {
    logger.error('启动失败', { error: e.message });
    process.exit(1);
  });
}

module.exports = { start, server };
