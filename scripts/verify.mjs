// 端到端验证：HTTP / 上传 / WS 同步 / 多项目 / 持久化 / SQLite 存储 / 旧数据迁移
// 运行: npm run verify
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import http from 'node:http';
import {
  mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, statSync, utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const require = createRequire(import.meta.url);
const { KINDS } = require('../server/storage/registry.js');

const PORT = 3456;
const BASE = `http://127.0.0.1:${PORT}`;
const PKG_VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sb-verify-'));
const TEST_ADMIN = 'admin';
const TEST_PASSWORD = 'test-admin-pass';
const AUTH_ENV = {
  ADMIN_USERNAME: TEST_ADMIN,
  ADMIN_PASSWORD: TEST_PASSWORD,
  ADMIN_PASSWORD_FILE: '',
  SESSION_TTL_HOURS: '',
  SESSION_REMEMBER_DAYS: '',
  COOKIE_SECURE: '',
  TRUST_PROXY: '',
  TLS_CERT_FILE: '',
  TLS_KEY_FILE: '',
  TLS_PASSPHRASE: '',
};

let adminSession = null;

let passed = 0, failed = 0;
let currentServer = null;
process.on('exit', () => { try { currentServer && currentServer.kill('SIGKILL'); } catch (_) {} });

function assert(cond, name) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`); }
}

// 1×1 PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

function startServer(extraEnv = {}) {
  // 用运行测试的同一个 Node，避免多版本 Node 下原生模块 ABI 不一致
  const proc = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, ...AUTH_ENV, PORT: String(PORT), DATA_DIR, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  currentServer = proc;
  return proc;
}

function sessionFromResponse(res) {
  const list = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie')].filter(Boolean);
  const pairs = list.filter(Boolean).map((line) => line.split(';')[0].trim());
  const find = (name) => {
    const pair = pairs.find((item) => item.startsWith(name + '='));
    return pair ? pair.slice(name.length + 1) : '';
  };
  return { cookie: pairs.join('; '), csrf: find('ssb_csrf') };
}

async function login(base = BASE, username = TEST_ADMIN, password = TEST_PASSWORD) {
  const res = await fetch(base + '/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error('登录失败：HTTP ' + res.status);
  return sessionFromResponse(res);
}

function authFetch(pathname, options = {}) {
  const headers = new Headers(options.headers || {});
  if (adminSession) {
    headers.set('Cookie', adminSession.cookie);
    const method = String(options.method || 'GET').toUpperCase();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      headers.set('X-CSRF-Token', adminSession.csrf);
    }
  }
  const url = pathname.startsWith('http') ? pathname : BASE + pathname;
  return fetch(url, { ...options, headers });
}

async function waitServer(options = {}) {
  const autoLogin = options.login !== false;
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(BASE + '/api/state');
      if (r.ok) {
        if (autoLogin) adminSession = await login();
        return;
      }
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('服务启动超时');
}

async function stopServer(proc) {
  proc.kill('SIGTERM');
  await new Promise((r) => proc.once('exit', r));
}

function wsClient(name, session = null) {
  const ws = new WebSocket(
    `ws://127.0.0.1:${PORT}/ws`,
    session ? { headers: { Cookie: session.cookie } } : {},
  );
  const client = {
    ws, name, states: [], runtimes: [], acks: new Map(), seq: 0,
    ready: new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); }),
    waitState(pred, since = 0, timeout = 3000) {
      return new Promise((resolve, reject) => {
        for (let i = since; i < client.states.length; i++) {
          if (pred(client.states[i])) return resolve(client.states[i]);
        }
        const t = setTimeout(() => reject(new Error(`${name}: 等待状态超时`)), timeout);
        client._waiters.push({ pred, resolve: (s) => { clearTimeout(t); resolve(s); } });
      });
    },
    waitRuntime(pred, since = 0, timeout = 3000) {
      return new Promise((resolve, reject) => {
        for (let i = since; i < client.runtimes.length; i++) {
          if (client.runtimes[i] && pred(client.runtimes[i])) return resolve(client.runtimes[i]);
        }
        const t = setTimeout(() => reject(new Error(`${name}: 等待运行态超时`)), timeout);
        client._runtimeWaiters.push({ pred, resolve: (r) => { clearTimeout(t); resolve(r); } });
      });
    },
    _waiters: [],
    _runtimeWaiters: [],
    sendOp(op, payload) {
      return new Promise((resolve, reject) => {
        const reqId = `v${++client.seq}`;
        client.acks.set(reqId, { resolve, reject });
        ws.send(JSON.stringify({ type: 'op', reqId, op, payload }));
      });
    },
  };
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'state') {
      client.states.push(msg.data);
      client.runtimes.push(msg.runtime || null);
      client._waiters = client._waiters.filter((w) => {
        if (w.pred(msg.data)) { w.resolve(msg.data); return false; }
        return true;
      });
      client._runtimeWaiters = client._runtimeWaiters.filter((w) => {
        if (msg.runtime && w.pred(msg.runtime)) { w.resolve(msg.runtime); return false; }
        return true;
      });
    } else if (msg.type === 'ack') {
      const a = client.acks.get(msg.reqId);
      if (a) {
        client.acks.delete(msg.reqId);
        msg.ok ? a.resolve(msg) : a.reject(new Error(msg.error));
      }
    }
  });
  return client;
}

async function getState() {
  return (await fetch(BASE + '/api/state')).json();
}

function rawGet(pathname) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.end();
  });
}

async function main() {
  let server = startServer();
  await waitServer();
  console.log('HTTP 路由与状态:');

  let r = await fetch(BASE + '/display');
  { const html = await r.text(); assert((r.status === 200 && html.includes('id="root"')) || (r.status === 503 && html.includes('前端尚未构建')), 'GET /display 返回页面'); }
  r = await fetch(BASE + '/admin');
  { const html = await r.text(); assert((r.status === 200 && html.includes('id="root"')) || (r.status === 503 && html.includes('前端尚未构建')), 'GET /admin 返回页面'); }
  r = await fetch(BASE + '/');
  {
    const html = await r.text();
    // CI 不构建前端时，重定向目标会返回 503，这也是合法状态
    assert(
      (r.status === 200 && html.includes('id="root"')) ||
      (r.status === 503 && html.includes('前端尚未构建')),
      'GET / 重定向后可访问',
    );
  }
  const st0 = await getState();
  const projectId = Object.keys(st0.projects || {})[0];
  assert(Boolean(projectId), '默认创建一个项目');
  assert(st0.projects[projectId].settings.title === '计分板', '项目默认设置正确');
  assert(st0.projects[projectId].settings.displayStyle === 'guofeng', '默认显示风格为古风雅集');
  r = await fetch(BASE + '/../etc/passwd');
  assert(r.status === 400 || r.status === 404, '路径穿越被拒绝');
  r = await fetch(BASE + '/admin.css');
  assert(r.ok && (await r.text()).includes('--card'), '静态资源可访问');
  r = await fetch(BASE + '/img/trueage/scroll-1.webp');
  assert(r.ok && (await r.arrayBuffer()).byteLength > 1000, '真·古风卷轴素材可访问');
  console.log('P1 后端健壮性:');
  r = await fetch(BASE + '/api/health');
  const health = await r.json();
  const healthText = JSON.stringify(health);
  assert(r.ok && health.ok === true && Number.isFinite(health.uptimeSec) &&
    typeof health.wsClients === 'number' && healthText.length < 1024,
    '健康检查返回轻量状态');
  r = await fetch(BASE + '/api/state');
  assert(r.headers.get('x-content-type-options') === 'nosniff', '响应包含 nosniff 安全头');
  assert(r.headers.get('x-frame-options') === 'SAMEORIGIN', '响应包含 X-Frame-Options');
  const badUrl = await rawGet('/%zz');
  assert(badUrl.status === 400 || badUrl.status === 404, '非法 URL 编码被安全处理（400/404）');
  assert((await fetch(BASE + '/api/health')).ok, '非法 URL 后服务仍存活');

  console.log('单实例锁:');
  const second = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(PORT + 1), DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let secondErr = '';
  second.stderr.on('data', (d) => { secondErr += d; });
  const secondCode = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { second.kill('SIGKILL'); } catch (_) {}
      resolve(-1);
    }, 5000);
    second.once('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
  assert(secondCode === 1 && /占用|进程/.test(secondErr), '同一数据目录拒绝第二个实例');

  console.log('版本信息:');
  const verRes = await fetch(BASE + '/api/version');
  const verData = await verRes.json();
  assert(verRes.ok && verData.version === PKG_VERSION, '版本接口返回 ' + PKG_VERSION);
  assert(verData.finalForTechStack === false, '不再标记为原技术栈最终版');
  assert(verData.frontend === 'react' || verData.frontend === 'missing', '版本接口返回当前前端类型');

  console.log('头像上传:');
  r = await authFetch('/api/avatar', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: PNG });
  const up = await r.json();
  assert(r.ok && /^avatars\/[^/]+\.png$/.test(up.path), '上传合法 PNG 返回 path');
  r = await fetch(BASE + '/' + up.path);
  assert(r.ok && Buffer.from(await r.arrayBuffer()).equals(PNG), '上传头像可取回且一致');
  r = await authFetch('/api/avatar', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: Buffer.alloc(3 * 1024 * 1024) });
  assert(r.status === 413, '3MB 上传返回 413');
  r = await authFetch('/api/avatar', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: Buffer.from('nope') });
  assert(r.status === 415, '伪造图片返回 415');

  console.log('自定义音效上传:');
  const WAV = Buffer.alloc(64);
  WAV.write('RIFF', 0, 'ascii');
  WAV.writeUInt32LE(56, 4);
  WAV.write('WAVE', 8, 'ascii');
  WAV.write('fmt ', 12, 'ascii');
  r = await authFetch('/api/sound', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: WAV });
  const soundUp = await r.json();
  assert(r.ok && /^sounds\/[^/]+\.wav$/.test(soundUp.path), '上传 WAV 音效返回 path');
  r = await fetch(BASE + '/' + soundUp.path);
  assert(r.ok && Buffer.from(await r.arrayBuffer()).equals(WAV), '音效文件可取回且一致');
  r = await authFetch('/api/sound', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: Buffer.from('not audio') });
  assert(r.status === 415, '伪造音频返回 415');

  // 导入时保留原始文件名（含中文），同名自动追加序号
  const namedHeaders = { 'Content-Type': 'audio/wav', 'X-File-Name': encodeURIComponent('测试音效') };
  r = await authFetch('/api/sound', { method: 'POST', headers: namedHeaders, body: WAV });
  const namedSound = await r.json();
  assert(r.ok && namedSound.path === 'sounds/测试音效.wav', '导入音频保留原始文件名');
  r = await fetch(BASE + '/' + namedSound.path);
  assert(r.ok && Buffer.from(await r.arrayBuffer()).equals(WAV), '中文文件名音频可访问');
  r = await authFetch('/api/sound', { method: 'POST', headers: namedHeaders, body: WAV });
  const namedSound2 = await r.json();
  assert(r.ok && namedSound2.path === 'sounds/测试音效-1.wav', '同名音频自动追加序号');
  const namedImageHeaders = { 'Content-Type': 'image/png', 'X-File-Name': encodeURIComponent('背景 图') };
  r = await authFetch('/api/avatar', { method: 'POST', headers: namedImageHeaders, body: PNG });
  const namedImage = await r.json();
  assert(r.ok && namedImage.path === 'avatars/背景-图.png', '导入图片保留原始文件名');

  console.log('WebSocket 同步:');
  const viewer = wsClient('viewer');
  const admin = wsClient('admin', adminSession);
  await Promise.all([viewer.ready, admin.ready]);
  await viewer.waitState((s) => s.projects && s.projects[projectId]);
  assert(viewer.states.length >= 1, 'viewer 连接即收到初始状态');

  const evil = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { Origin: 'http://evil.example' } });
  const evilCode = await new Promise((resolve) => {
    evil.on('close', (code) => resolve(code));
    evil.on('error', () => resolve(-1));
    setTimeout(() => resolve(-2), 2000);
  });
  assert(evilCode === 1008, '跨站 Origin 的 WebSocket 被拒绝');

  const oversized = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  await new Promise((resolve) => oversized.on('open', resolve));
  const oversizeCode = await new Promise((resolve) => {
    oversized.on('close', (code) => resolve(code));
    oversized.on('error', () => {});
    oversized.send('x'.repeat(100 * 1024));
    setTimeout(() => resolve(-1), 2000);
  });
  assert(oversizeCode === 1009, '超过 maxPayload 的连接被关闭');
  assert((await fetch(BASE + '/api/health')).ok, '超大消息后服务仍存活');
  const P = (st) => st.projects[projectId];
  const adminOp = (op, payload) => admin.sendOp(op, Object.assign({ projectId }, payload || {}));

  const ack1 = await adminOp('addPerson', { name: '张三', avatar: up.path });
  const pid = ack1.result.personId;
  let s = await viewer.waitState((st) => P(st) && P(st).people[pid]);
  assert(s.projects[projectId].people[pid].name === '张三', 'viewer 实时收到新人员');
  await adminOp('addScore', { personId: pid, delta: 10 });
  s = await viewer.waitState((st) => P(st) && P(st).people[pid] && P(st).people[pid].score === 10);
  assert(true, 'viewer 实时收到加分 (+10)');
  await adminOp('addScore', { personId: pid, delta: -3 });
  s = await viewer.waitState((st) => P(st).people[pid] && P(st).people[pid].score === 7);
  assert(true, 'viewer 实时收到减分 (−3 → 7)');

  const ack2 = await adminOp('addTeam', { name: '红队' });
  const tid = ack2.result.teamId;
  await adminOp('assignTeam', { personId: pid, teamId: tid });
  s = await viewer.waitState((st) => P(st).people[pid] && P(st).people[pid].teamId === tid);
  assert(P(s).teams[tid].name === '红队', 'viewer 实时收到建队与移入');

  console.log('人员/团队自定义顺序:');
  const ordA = (await adminOp('addPerson', { name: '排序甲' })).result.personId;
  const ordB = (await adminOp('addPerson', { name: '排序乙' })).result.personId;
  const ordC = (await adminOp('addPerson', { name: '排序丙' })).result.personId;
  let ordState = await getState();
  const orderOfPerson = (st, id) => st.projects[projectId].people[id].order;
  const orderOfTeam = (st, id) => st.projects[projectId].teams[id].order;
  assert(orderOfPerson(ordState, ordB) > orderOfPerson(ordState, ordA) &&
    orderOfPerson(ordState, ordC) > orderOfPerson(ordState, ordB),
    '新人员按添加顺序获得递增序号');
  await adminOp('movePerson', { personId: ordC, direction: 'up' });
  await adminOp('movePerson', { personId: ordC, direction: 'up' });
  ordState = await getState();
  assert(orderOfPerson(ordState, ordC) < orderOfPerson(ordState, ordA), '人员可上移调整顺序');
  assert(ordState.projects[projectId].settings.sortBy === 'manual', '调序后自动切换为自定义顺序');
  await adminOp('movePerson', { personId: ordC, direction: 'up' });
  await adminOp('movePerson', { personId: ordC, direction: 'up' });
  ordState = await getState();
  assert(orderOfPerson(ordState, ordC) === 0, '列表顶部继续上移为无操作');
  await adminOp('movePerson', { personId: 'p_nope', direction: 'up' })
    .catch((e) => assert(/人员不存在/.test(e.message), '调序校验人员存在'));

  const tid2 = (await adminOp('addTeam', { name: '蓝队' })).result.teamId;
  ordState = await getState();
  assert(orderOfTeam(ordState, tid2) > orderOfTeam(ordState, tid), '新团队追加到末尾');
  await adminOp('moveTeam', { teamId: tid2, direction: 'up' });
  ordState = await getState();
  assert(orderOfTeam(ordState, tid2) < orderOfTeam(ordState, tid), '团队可上移调整顺序');
  await adminOp('moveTeam', { teamId: tid2, direction: 'left' })
    .catch((e) => assert(/移动方向/.test(e.message), '非法移动方向被拒绝'));

  await adminOp('updateSettings', { patch: { sortBy: 'score' } });
  await adminOp('updateSettings', { patch: { sortBy: 'manual' } });
  ordState = await getState();
  assert(ordState.projects[projectId].settings.sortBy === 'manual', '可切换为自定义顺序');
  await adminOp('updateSettings', { patch: { sortBy: 'random' } })
    .catch((e) => assert(/排序方式/.test(e.message), '非法排序方式被拒绝'));
  await adminOp('updateSettings', { patch: { sortBy: 'score' } });

  console.log('人员/团队改名:');
  await adminOp('renamePerson', { personId: pid, name: '张三丰' });
  s = await viewer.waitState((st) => P(st).people[pid] && P(st).people[pid].name === '张三丰');
  assert(true, '人员改名并实时同步');
  await adminOp('renameTeam', { teamId: tid, name: '红队二号' });
  s = await viewer.waitState((st) => P(st).teams[tid] && P(st).teams[tid].name === '红队二号');
  assert(true, '团队改名并实时同步');
  await adminOp('renamePerson', { personId: pid, name: '   ' })
    .catch((e) => assert(/不能为空/.test(e.message), '空姓名被拒绝'));
  await adminOp('renameTeam', { teamId: tid, name: '一'.repeat(21) })
    .catch((e) => assert(/过长/.test(e.message), '超长团队名被拒绝'));
  await adminOp('renamePerson', { personId: pid, name: '张三' });
  await adminOp('renameTeam', { teamId: tid, name: '红队' });

  console.log('简介:');
  await adminOp('setBio', { kind: 'person', id: pid, bio: '千里之行，始于足下' });
  s = await viewer.waitState((st) => P(st).people[pid] && P(st).people[pid].bio === '千里之行，始于足下');
  assert(true, '人员简介同步');
  await adminOp('setBio', { kind: 'team', id: tid, bio: '同心者胜' });
  s = await viewer.waitState((st) => P(st).teams[tid] && P(st).teams[tid].bio === '同心者胜');
  assert(true, '团队简介同步');
  await adminOp('setBio', { kind: 'person', id: pid, bio: '一'.repeat(61) })
    .catch((e) => assert(/过长/.test(e.message), '超长简介被拒绝'));
  await adminOp('setBio', { kind: 'person', id: 'p_nope', bio: 'x' })
    .catch((e) => assert(/人员不存在/.test(e.message), '简介校验目标存在'));
  await adminOp('updateSettings', {
    patch: {
      featureBio: true, bioFont: 'kai', bioFontCustom: '',
      bioSize: 20, bioColor: '#ff8800', bioOpacity: 0.6, bioItalic: true,
    },
  });
  s = await viewer.waitState((st) => P(st).settings.bioSize === 20);
  assert(P(s).settings.featureBio === true && P(s).settings.bioFont === 'kai' &&
    P(s).settings.bioColor === '#ff8800' && P(s).settings.bioOpacity === 0.6 &&
    P(s).settings.bioItalic === true, '简介外观设置同步');
  await adminOp('updateSettings', { patch: { bioSize: 99 } })
    .catch((e) => assert(/简介字号/.test(e.message), '简介字号越界被拒绝'));
  await adminOp('updateSettings', { patch: { bioOpacity: 0.1 } })
    .catch((e) => assert(/简介不透明度/.test(e.message), '简介不透明度越界被拒绝'));

  await adminOp('updateSettings', {
    patch: {
      featureTeamCaptain: true,
      teamCaptainLabel: '领队',
      teamCaptainSizeMode: 'auto',
      teamCaptainSize: 14,
      teamCaptainColor: '#ffcc00',
    },
  });
  s = await viewer.waitState((st) => P(st).settings.teamCaptainLabel === '领队');
  assert(P(s).settings.featureTeamCaptain === true && P(s).settings.teamCaptainSizeMode === 'auto' &&
    P(s).settings.teamCaptainSize === 14 && P(s).settings.teamCaptainColor === '#ffcc00',
    '队长标签设置同步');
  await adminOp('updateSettings', { patch: { teamCaptainLabel: '' } })
    .catch((e) => assert(/队长标签/.test(e.message), '空队长标签被拒绝'));
  await adminOp('updateSettings', { patch: { teamCaptainSize: 121 } })
    .catch((e) => assert(/队长标签字号/.test(e.message), '队长标签字号越界被拒绝'));
  await adminOp('updateSettings', { patch: { teamCaptainSizeMode: 'huge' } })
    .catch((e) => assert(/队长字号模式/.test(e.message), '非法队长字号模式被拒绝'));
  await adminOp('updateSettings', { patch: { teamCaptainColor: 'red' } })
    .catch((e) => assert(/队长标签颜色/.test(e.message), '非法队长标签颜色被拒绝'));

  await adminOp('updateSettings', { patch: { displayResolution: '3840x2160' } });
  s = await viewer.waitState((st) => P(st).settings.displayResolution === '3840x2160');
  assert(true, '显示端逻辑分辨率同步');
  await adminOp('updateSettings', { patch: { displayResolution: '4k' } })
    .catch((e) => assert(/显示分辨率/.test(e.message), '非法显示分辨率被拒绝'));
  await adminOp('updateSettings', { patch: { displayResolution: '100x100' } })
    .catch((e) => assert(/显示分辨率/.test(e.message), '显示分辨率越界被拒绝'));
  await adminOp('updateSettings', { patch: { displayResolutionScale: 70 } });
  s = await viewer.waitState((st) => P(st).settings.displayResolutionScale === 70);
  assert(true, '分辨率放大强度同步');
  await adminOp('updateSettings', { patch: { displayResolutionScale: 101 } })
    .catch((e) => assert(/放大强度/.test(e.message), '分辨率放大强度越界被拒绝'));

  await adminOp('updateSettings', { patch: { teamMemberLayout: 'column' } });
  s = await viewer.waitState((st) => P(st).settings.teamMemberLayout === 'column');
  assert(true, '成员卡片排列同步');
  await adminOp('updateSettings', { patch: { teamMemberLayout: 'grid' } })
    .catch((e) => assert(/成员卡片排列/.test(e.message), '非法成员卡片排列被拒绝'));

  console.log('主题导入:');
  await adminOp('applyTheme', {
    baseStyle: 'ppt',
    settings: { accent: '#112233', cardStyle: 'glass', cardRadius: 20, bioFont: 'kai' },
  });
  s = await viewer.waitState((st) => P(st).settings.cardRadius === 20);
  assert(P(s).settings.displayStyle === 'ppt' && P(s).settings.accent === '#112233' &&
    P(s).settings.cardStyle === 'glass' && P(s).settings.bioFont === 'kai',
    '主题应用：基础风格与视觉设置同步');
  await adminOp('applyTheme', { settings: { title: '不支持的键' } })
    .catch((e) => assert(/不支持的设置项/.test(e.message), '主题拒绝非视觉设置项'));
  await adminOp('applyTheme', { baseStyle: 'trueage' })
    .catch((e) => assert(/显示风格/.test(e.message), '主题拒绝已删除的风格'));
  await adminOp('applyTheme', { settings: { accent: 'red' } })
    .catch((e) => assert(/强调色/.test(e.message), '主题拒绝非法值'));

  console.log('主题工作室（v2）:');
  const v2Theme = (name, accent) => ({
    format: 'screenscoreboard.theme',
    version: 2,
    meta: { name, author: '验证', description: 'v2', baseStyle: 'modern' },
    canvas: { width: 1920, height: 1080, background: { type: 'none', color: '#000000', image: '' } },
    layers: [{ name: '背景', nodes: [{ type: 'rect', x: 0, y: 0, w: 200, h: 120, fill: '#334455' }] }],
    widgets: [{ type: 'title', surface: 'canvas', props: { fontSize: 64 } }],
    settings: { accent, cardRadius: 21 },
    script: { enabled: false },
  });
  const createdTheme = await adminOp('themeCreate', { name: '验证主题' });
  const themeId = createdTheme.result.themeId;
  assert(/^th_/.test(themeId), 'themeCreate 创建主题');
  const updatedTheme = await adminOp('themeUpdate', {
    themeId, theme: v2Theme('验证主题 v2', '#445566'),
  });
  assert(updatedTheme.result.theme && updatedTheme.result.theme.revision === 2, 'themeUpdate revision +1');
  const themeListRes = await authFetch('/api/themes');
  const themeList = await themeListRes.json();
  assert(themeListRes.ok && themeList.themes.some((t) => t.id === themeId), '主题库接口返回摘要');
  const themeRes = await fetch(BASE + '/api/themes/' + themeId);
  const themeOne = await themeRes.json();
  assert(themeRes.ok && themeOne.theme.layers.length === 1 && themeOne.theme.widgets.length === 1,
    '主题详情返回完整 spec');
  await adminOp('themeUpdate', { themeId, theme: { ...v2Theme('bad', '#445566'), settings: { title: 'bad' } } })
    .catch((e) => assert(/不支持的设置项/.test(e.message), 'v2 主题拒绝非视觉设置项'));
  await adminOp('themeUpdate', {
    themeId, theme: { ...v2Theme('bad', '#445566'), settings: { themeScriptEnabled: true } },
  }).catch((e) => assert(/不支持的设置项/.test(e.message), '主题设置不能自行开启主题脚本'));
  await adminOp('themeUpdate', { themeId, theme: { ...v2Theme('bad', '#445566'), script: { enabled: true, source: '' } } })
    .catch((e) => assert(/必须提供源码/.test(e.message), 'v2 主题拒绝空脚本'));

  await adminOp('themeApply', { projectId, themeId });
  s = await viewer.waitState((st) => P(st).settings.accent === '#445566');
  assert(P(s).settings.cardRadius === 21 && P(s).settings.displayStyle === 'modern' &&
    s.projects[projectId].themeId === themeId && s.projects[projectId].themeRevision === 2,
    '主题应用设置并记录引用');
  assert(P(s).settings.themeScriptEnabled === false, '主题脚本默认关闭');
  const hot = viewer.states[viewer.states.length - 1];
  assert(hot.themes === undefined && hot.themeDrafts === undefined, 'WS 热状态不广播主题库/草稿');

  const scriptTheme = v2Theme('验证主题脚本', '#445566');
  scriptTheme.script = {
    enabled: true,
    source: 'function drawTheme(ctx) { return [{ op: "text", x: 10, y: 20, text: ctx.title, size: 24, color: "#ffffff" }]; }',
    entry: 'drawTheme',
  };
  await adminOp('themeUpdate', { themeId, theme: scriptTheme });
  const scriptThemeRes = await fetch(BASE + '/api/themes/' + themeId);
  const scriptThemeData = await scriptThemeRes.json();
  assert(scriptThemeRes.ok && scriptThemeData.theme.script.enabled === true &&
    /function drawTheme/.test(scriptThemeData.theme.script.source),
    '主题脚本源码随主题保存并读取');

  await adminOp('draftSave', { projectId, theme: v2Theme('项目草稿', '#778899') });
  const draftRes = await authFetch('/api/projects/' + projectId + '/theme-draft');
  const draftData = await draftRes.json();
  assert(draftRes.ok && draftData.theme && draftData.theme.meta.name === '项目草稿' &&
    draftData.theme.settings.accent === '#778899', '项目草稿保存与读取');
  await adminOp('draftDelete', { projectId });
  await adminOp('themeDuplicate', { themeId }).then((ack) =>
    ack.result.themeId && adminOp('themeDelete', { themeId: ack.result.themeId }));
  await adminOp('themeDelete', { themeId });
  s = await viewer.waitState((st) => st.projects[projectId].themeId === null);
  assert(s.projects[projectId].themeRevision === 0, '删除主题自动解绑项目');
  await adminOp('updateSettings', {
    patch: { accent: '#112233', displayStyle: 'ppt', cardRadius: 20 },
  });

  await new Promise((r) => setTimeout(r, 250));
  const rawState = readFileSync(path.join(DATA_DIR, 'state.json'), 'utf8');
  assert(!rawState.includes('\n  '), 'JSON 存盘默认使用 compact 格式');

  await adminOp('updateSettings', { patch: { columns: 6, theme: 'light', title: '决赛计分板' } });
  s = await viewer.waitState((st) => P(st).settings.columns === 6);
  assert(s.projects[projectId].settings.theme === 'light', 'viewer 实时收到排版变更');

  await adminOp('updateSettings', {
    patch: { bgType: 'image', bgImage: up.path, bgColor: '#203040', cardBg: '#101820', cardRadius: 18 },
  });
  s = await viewer.waitState((st) => P(st).settings.cardRadius === 18);
  assert(s.projects[projectId].settings.bgImage === up.path, 'viewer 实时收到背景图设置');

  await adminOp('updateSettings', { patch: { bgImageBlur: true, bgImageBlurAmount: 18 } });
  s = await viewer.waitState((st) => P(st).settings.bgImageBlur === true);
  assert(P(s).settings.bgImageBlurAmount === 18, '背景图虚化开关与虚化度同步');
  await adminOp('updateSettings', { patch: { bgImageBlurAmount: 99 } })
    .catch((e) => assert(/虚化度/.test(e.message), '虚化度越界被拒绝'));
  await adminOp('updateSettings', { patch: { bgImageBlur: 'yes' } })
    .catch((e) => assert(/布尔/.test(e.message), '非法虚化开关被拒绝'));
  await adminOp('updateSettings', { patch: { bgScrimEnabled: false } });
  s = await viewer.waitState((st) => P(st).settings.bgScrimEnabled === false);
  assert(true, '背景遮罩可关闭');
  await adminOp('updateSettings', { patch: { bgScrimEnabled: 'no' } })
    .catch((e) => assert(/布尔/.test(e.message), '非法背景遮罩开关被拒绝'));
  await adminOp('updateSettings', { patch: { bgScrimEnabled: true } });
  s = await viewer.waitState((st) => P(st).settings.bgScrimEnabled === true);
  assert(true, '背景遮罩可重新开启');

  await adminOp('updateSettings', { patch: { layoutMode: 'free', memberScale: 1.4 } });
  s = await viewer.waitState((st) => P(st).settings.layoutMode === 'free');
  assert(s.projects[projectId].settings.memberScale === 1.4, '自由布局/成员缩放同步');

  await adminOp('setCardImage', { kind: 'person', id: pid, image: up.path });
  s = await viewer.waitState((st) => P(st).people[pid] && P(st).people[pid].cardImage === up.path);
  assert(true, '个人卡面图同步');
  await adminOp('setCardImage', { kind: 'person', id: pid, image: null });
  await viewer.waitState((st) => P(st).people[pid] && P(st).people[pid].cardImage === null);
  assert(true, '卡面图可移除');

  await adminOp('setLayout', { kind: 'person', id: pid, layout: { x: 5, y: 6, w: 24, h: 15 } });
  s = await viewer.waitState((st) => P(st).people[pid] && P(st).people[pid].layout && P(st).people[pid].layout.x === 5);
  assert(s.projects[projectId].people[pid].layout.w === 24, '卡片位置/大小同步');
  await adminOp('setLayout', { kind: 'person', id: pid, layout: { x: -20, y: 200, w: 1, h: 1 } });
  s = await viewer.waitState((st) => P(st).people[pid] && P(st).people[pid].layout && P(st).people[pid].layout.w === 4);
  assert(P(s).people[pid].layout.x === -20 && P(s).people[pid].layout.y === 200,
    '卡片可拖出画布（不强制贴边），仅尺寸取最小值');
  await adminOp('setLayout', { kind: 'person', id: pid, layout: { x: 500, y: -500, w: 500, h: 500 } });
  s = await viewer.waitState((st) => P(st).people[pid] && P(st).people[pid].layout && P(st).people[pid].layout.w === 200);
  assert(P(s).people[pid].layout.x === 200 && P(s).people[pid].layout.y === -100,
    '极端坐标被限制在安全范围');

  await adminOp('setMemberLayout', { personId: pid, layout: { x: 2, y: 3, w: 20, h: 21 } });
  s = await viewer.waitState((st) => P(st).people[pid] && P(st).people[pid].memberLayout);
  assert(P(s).people[pid].memberLayout.w === 20, '成员小卡片布局同步');

  await adminOp('resetLayout');
  s = await viewer.waitState((st) => P(st).people[pid] && P(st).people[pid].layout === null);
  assert(P(s).people[pid].memberLayout === null, 'resetLayout 清空卡片与成员布局');
  // 恢复到后续持久化断言所需的位置
  await adminOp('setLayout', { kind: 'person', id: pid, layout: { x: 200, y: -100, w: 200, h: 200 } });
  await adminOp('setMemberLayout', { personId: pid, layout: { x: 2, y: 3, w: 20, h: 21 } });
  await viewer.waitState((st) => P(st).people[pid] && P(st).people[pid].layout && P(st).people[pid].layout.w === 200);

  await adminOp('updateSettings', { patch: { avatarPosition: 'top', avatarSizeMode: 'manual', avatarSize: 96 } });
  s = await viewer.waitState((st) => P(st).settings.avatarPosition === 'top');
  assert(P(s).settings.avatarSize === 96, '头像位置/大小同步');

  await adminOp('updateSettings', {
    patch: {
      cardStyle: 'neon', glassBlur: 18, glassOpacity: 0.4,
      scoreEffect: 'confetti', scoreEffectDuration: 1200, scoreEffectColor: '#ff8800',
      scoreEffectOnlyPositive: true, soundEnabled: true, soundPreset: 'chime', soundVolume: 0.6,
    },
  });
  s = await viewer.waitState((st) => P(st).settings.cardStyle === 'neon');
  assert(P(s).settings.scoreEffect === 'confetti' && P(s).settings.soundPreset === 'chime' &&
    P(s).settings.soundVolume === 0.6, '卡片样式/特效/内置音效/音效同步');

  await adminOp('updateSettings', { patch: { customSound: namedSound.path } });
  s = await viewer.waitState((st) => P(st).settings.customSound === namedSound.path);
  assert(true, '音效可使用保留的原始文件名');
  await adminOp('updateSettings', { patch: { bgmFile: namedSound.path } });
  s = await viewer.waitState((st) => P(st).settings.bgmFile === namedSound.path);
  assert(true, '背景音乐支持 sounds/ 路径');
  await adminOp('updateSettings', { patch: { bgmFile: '' } });
  await viewer.waitState((st) => P(st).settings.bgmFile === '');

  await adminOp('updateSettings', { patch: { displayStyle: 'seewo' } });
  s = await viewer.waitState((st) => P(st).settings.displayStyle === 'seewo');
  assert(true, '显示风格同步');
  await adminOp('updateSettings', { patch: { displayStyle: 'hologram' } }).catch((e) => {
    assert(/显示风格/.test(e.message), '非法显示风格被拒绝');
  });
  for (const style of ['guofeng', 'ink', 'trueage', 'modern', 'neon', 'poster']) {
    await adminOp('updateSettings', { patch: { displayStyle: style } });
    await viewer.waitState((st) => P(st).settings.displayStyle === style);
  }
  assert(true, '新增显示风格均可用');
  await adminOp('updateSettings', { patch: { displayStyle: 'seewo' } });
  await viewer.waitState((st) => P(st).settings.displayStyle === 'seewo');

  await adminOp('updateSettings', {
    patch: {
      scoreEffect: 'spotlight', spotlightScope: 'person_team',
      spotlightWidth: 700, spotlightHeight: 420, spotlightTheme: 'fly',
      spotlightReturnDuration: 2200, spotlightScrimEnabled: true, spotlightScrimOpacity: 0.25,
      spotlightPlayMode: 'parallel', spotlightParallelMax: 6, spotlightParallelGap: 36,
      spotlightParallelTransition: 500, spotlightInterruptFade: 250,
      spotlightFontFamily: 'custom', spotlightFontFamilyCustom: 'LXGW WenKai',
      spotlightFontScale: 1.6, spotlightAvatarEnabled: false,
      spotlightAvatarSizeMode: 'manual', spotlightAvatarSize: 120,
      spotlightAvatarPosition: 'top',
      customSound: soundUp.path,
    },
  });
  s = await viewer.waitState((st) => P(st).settings.scoreEffect === 'spotlight');
  assert(P(s).settings.customSound === soundUp.path && P(s).settings.spotlightScope === 'person_team' &&
    P(s).settings.spotlightWidth === 700 && P(s).settings.spotlightHeight === 420 &&
    P(s).settings.spotlightTheme === 'fly' && P(s).settings.spotlightReturnDuration === 2200 &&
    P(s).settings.spotlightScrimEnabled === true && P(s).settings.spotlightScrimOpacity === 0.25 &&
    P(s).settings.spotlightPlayMode === 'parallel' && P(s).settings.spotlightParallelMax === 6 &&
    P(s).settings.spotlightParallelGap === 36 && P(s).settings.spotlightParallelTransition === 500 &&
    P(s).settings.spotlightInterruptFade === 250 &&
    P(s).settings.spotlightFontFamily === 'custom' &&
    P(s).settings.spotlightFontFamilyCustom === 'LXGW WenKai' &&
    P(s).settings.spotlightFontScale === 1.6 &&
    P(s).settings.spotlightAvatarEnabled === false &&
    P(s).settings.spotlightAvatarSizeMode === 'manual' &&
    P(s).settings.spotlightAvatarSize === 120 &&
    P(s).settings.spotlightAvatarPosition === 'top',
    '居中突显特效/范围/宽高/主题/飞入飞回时长/压暗开关与强度/播放模式/并列与打断参数/字体/字号/头像/自定义音效同步');
  await adminOp('updateSettings', { patch: { spotlightPlayMode: 'warp' } }).catch((e) => {
    assert(/播放模式/.test(e.message), '非法播放模式被拒绝');
  });
  await adminOp('updateSettings', { patch: { spotlightParallelMax: 7 } }).catch((e) => {
    assert(/并列最多卡片数/.test(e.message), '非法并列最多卡片数被拒绝');
  });
  await adminOp('updateSettings', { patch: { spotlightParallelGap: 121 } }).catch((e) => {
    assert(/并列卡片间距/.test(e.message), '非法并列卡片间距被拒绝');
  });
  await adminOp('updateSettings', { patch: { spotlightParallelTransition: 1600 } }).catch((e) => {
    assert(/并列卡片过渡时长/.test(e.message), '非法并列卡片过渡时长被拒绝');
  });
  await adminOp('updateSettings', { patch: { spotlightInterruptFade: 1200 } }).catch((e) => {
    assert(/打断淡出时长/.test(e.message), '非法打断淡出时长被拒绝');
  });
  await adminOp('updateSettings', { patch: { spotlightPlayMode: 'interrupt' } });
  s = await viewer.waitState((st) => P(st).settings.spotlightPlayMode === 'interrupt');
  assert(true, '打断模式可选');
  await adminOp('updateSettings', { patch: { spotlightPlayMode: 'parallel' } });
  s = await viewer.waitState((st) => P(st).settings.spotlightPlayMode === 'parallel');
  assert(true, '恢复并列模式以验证持久化');
  await adminOp('updateSettings', { patch: { spotlightTheme: 'genie' } });
  s = await viewer.waitState((st) => P(st).settings.spotlightTheme === 'genie');
  assert(true, '神灯主题可选');
  await adminOp('updateSettings', { patch: { spotlightTheme: 'squeeze' } });
  s = await viewer.waitState((st) => P(st).settings.spotlightTheme === 'squeeze');
  assert(true, '联动避开主题可选');
  await adminOp('updateSettings', { patch: { spotlightTheme: 'warp' } }).catch((e) => {
    assert(/突显主题/.test(e.message), '非法突显主题被拒绝');
  });
  await adminOp('updateSettings', { patch: { spotlightReturnDuration: 100 } }).catch((e) => {
    assert(/飞入飞回时长/.test(e.message), '非法飞入飞回时长被拒绝');
  });
  await adminOp('updateSettings', { patch: { spotlightScrimOpacity: 1.5 } }).catch((e) => {
    assert(/压暗强度/.test(e.message), '非法突显压暗强度被拒绝');
  });
  await adminOp('updateSettings', { patch: { spotlightScrimEnabled: 'yes' } }).catch((e) => {
    assert(/压暗开关/.test(e.message), '非法突显压暗开关被拒绝');
  });
  await adminOp('updateSettings', { patch: { spotlightFontScale: 3 } }).catch((e) => {
    assert(/突显字号缩放/.test(e.message), '非法突显字号缩放被拒绝');
  });
  await adminOp('updateSettings', { patch: { spotlightAvatarSize: 10 } }).catch((e) => {
    assert(/突显头像大小/.test(e.message), '非法突显头像大小被拒绝');
  });
  await adminOp('updateSettings', { patch: { spotlightAvatarPosition: 'center' } }).catch((e) => {
    assert(/突显头像位置/.test(e.message), '非法突显头像位置被拒绝');
  });
  await adminOp('updateSettings', { patch: { spotlightFontFamily: 'warp' } }).catch((e) => {
    assert(/突显字体/.test(e.message), '非法突显字体被拒绝');
  });
  await adminOp('updateSettings', { patch: { scoreEffect: 'highlight', scoreRolling: false } });
  s = await viewer.waitState((st) => P(st).settings.scoreEffect === 'highlight' &&
    P(st).settings.scoreRolling === false);
  assert(true, '原位聚光灯/滚动数字设置同步');

  await adminOp('updateSettings', {
    patch: { themeScriptEnabled: true, themeScriptFps: 12, themeScriptTimeoutMs: 150 },
  });
  s = await viewer.waitState((st) => P(st).settings.themeScriptEnabled === true);
  assert(P(s).settings.themeScriptFps === 12 && P(s).settings.themeScriptTimeoutMs === 150,
    '主题脚本开关/帧率/超时可调并同步');
  await adminOp('updateSettings', { patch: { themeScriptFps: 0 } })
    .catch((e) => assert(/帧率/.test(e.message), '非法主题脚本帧率被拒绝'));
  await adminOp('updateSettings', { patch: { themeScriptTimeoutMs: 2000 } })
    .catch((e) => assert(/超时/.test(e.message), '非法主题脚本超时被拒绝'));
  await adminOp('updateSettings', { patch: { themeScriptEnabled: 'yes' } })
    .catch((e) => assert(/布尔/.test(e.message), '非法主题脚本开关被拒绝'));
  await adminOp('updateSettings', { patch: { themeScriptEnabled: false } });
  s = await viewer.waitState((st) => P(st).settings.themeScriptEnabled === false);
  assert(true, '主题脚本可关闭');
  await adminOp('updateSettings', {
    patch: { featureMobileAdmin: false, adminTouchTargetSize: 52 },
  });
  s = await viewer.waitState((st) => P(st).settings.featureMobileAdmin === false);
  assert(P(s).settings.adminTouchTargetSize === 52,
    '管理端移动布局开关与触控目标尺寸可调并同步');
  await adminOp('updateSettings', { patch: { adminTouchTargetSize: 39 } })
    .catch((e) => assert(/触控目标/.test(e.message), '非法触控目标尺寸被拒绝'));
  await adminOp('updateSettings', { patch: { adminTouchTargetSize: 65 } })
    .catch((e) => assert(/触控目标/.test(e.message), '触控目标尺寸上限被拒绝'));
  await adminOp('updateSettings', { patch: { featureMobileAdmin: 'yes' } })
    .catch((e) => assert(/布尔/.test(e.message), '非法管理端移动布局开关被拒绝'));
  await adminOp('updateSettings', { patch: { customSound: '../../etc/passwd' } }).catch((e) => {
    assert(/音效文件路径/.test(e.message), '非法音效路径被拒绝');
  });
  await adminOp('updateSettings', { patch: { spotlightScope: 'team_only' } }).catch((e) => {
    assert(/突显范围/.test(e.message), '非法突显范围被拒绝');
  });
  await adminOp('updateSettings', { patch: { spotlightWidth: 9 } }).catch((e) => {
    assert(/突显宽度/.test(e.message), '非法突显宽度被拒绝');
  });

  // 纯突显：管理端 / API 可凭空触发居中放大，但绝不改分数、不写撤销栈或分数日志
  console.log('手动突显（不加分）:');
  const manualBefore = await getState();
  const manualScore = manualBefore.projects[projectId].people[pid].score;
  const undoBefore = manualBefore.runtime.undoCounts[projectId] || 0;
  const logsBefore = (manualBefore.runtime.scoreLogs?.[projectId] || []).length;
  let markSpot = viewer.runtimes.length;
  const spotAck = await adminOp('triggerSpotlight', {
    targetType: 'person', targetId: pid, durationMs: 1500,
  });
  assert(spotAck.result && spotAck.result.targetType === 'person' &&
    spotAck.result.targetId === pid && spotAck.result.durationMs === 1500,
    '手动突显返回运行时事件');
  await viewer.waitRuntime((r) => (r.spotlightEvents?.[projectId] || []).some(
    (e) => e.targetType === 'person' && e.targetId === pid && e.durationMs === 1500), markSpot);
  const manualAfter = await getState();
  assert(manualAfter.projects[projectId].people[pid].score === manualScore, '手动突显不改变分数');
  assert((manualAfter.runtime.undoCounts[projectId] || 0) === undoBefore, '手动突显不进入撤销栈');
  assert((manualAfter.runtime.scoreLogs?.[projectId] || []).length === logsBefore,
    '手动突显不写分数日志');
  markSpot = viewer.runtimes.length;
  await adminOp('triggerSpotlight', { targetType: 'team', targetId: tid });
  await viewer.waitRuntime((r) => (r.spotlightEvents?.[projectId] || []).some(
    (e) => e.targetType === 'team' && e.targetId === tid), markSpot);
  assert(true, '手动突显团队');
  await adminOp('triggerSpotlight', { targetType: 'person', targetId: 'p_missing' }).catch((e) => {
    assert(/不存在/.test(e.message), '手动突显不存在的人员被拒绝');
  });
  await adminOp('triggerSpotlight', { targetType: 'group', targetId: pid }).catch((e) => {
    assert(/目标类型/.test(e.message), '非法突显目标类型被拒绝');
  });
  await adminOp('triggerSpotlight', {
    targetType: 'person', targetId: pid, durationMs: 10001,
  }).catch((e) => {
    assert(/突显时长/.test(e.message), '非法手动突显时长被拒绝');
  });
  await adminOp('updateSettings', {
    patch: { featureSpotlightTrigger: false, spotlightTriggerDuration: 2400 },
  });
  s = await viewer.waitState((st) => P(st).settings.featureSpotlightTrigger === false &&
    P(st).settings.spotlightTriggerDuration === 2400);
  assert(true, '手动突显开关与时长同步');
  await adminOp('triggerSpotlight', { targetType: 'person', targetId: pid }).catch((e) => {
    assert(/未开启/.test(e.message), '手动突显关闭时拒绝');
  });
  await adminOp('updateSettings', { patch: { spotlightTriggerDuration: 10001 } }).catch((e) => {
    assert(/手动突显时长/.test(e.message), '非法手动突显时长设置被拒绝');
  });
  await adminOp('updateSettings', { patch: { featureSpotlightTrigger: 'yes' } }).catch((e) => {
    assert(/布尔/.test(e.message), '非法手动突显开关被拒绝');
  });
  await adminOp('updateSettings', { patch: { featureSpotlightTrigger: true } });
  await viewer.waitState((st) => P(st).settings.featureSpotlightTrigger === true);

  await adminOp('updateSettings', {
    patch: {
      fontFamily: 'serif', fontScale: 1.2, titleSize: 72, titleAlign: 'left', titleColor: '#ff0000',
      showTitleRule: false, boardMaxWidth: 2200, cardGap: 30, cardPad: 20, cardBorderWidth: 3,
      cardBorderColor: '#00ff00', cardShadow: 'strong', teamAccentWidth: 8, avatarBorderWidth: 4,
      avatarShape: 'square', textColor: '#00ffff', positiveColor: '#00ff00', negativeColor: '#ff00ff',
      rankColor: '#ffff00', scrimOpacity: 0.3, showRank: false, rankSize: 22,
      showScoreBar: false, scoreBarHeight: 9,
    },
  });
  s = await viewer.waitState((st) => P(st).settings.titleSize === 72);
  assert(P(s).settings.fontFamily === 'serif' && P(s).settings.titleSize === 72 &&
    P(s).settings.titleColor === '#ff0000' && P(s).settings.cardShadow === 'strong' &&
    P(s).settings.showRank === false && P(s).settings.scoreBarHeight === 9 &&
    P(s).settings.avatarShape === 'square' && P(s).settings.scrimOpacity === 0.3,
    '高级外观设置同步');

  await adminOp('updateSettings', { patch: { fontFamily: 'custom', fontFamilyCustom: 'Noto Serif CJK SC' } });
  s = await viewer.waitState((st) => P(st).settings.fontFamily === 'custom');
  assert(P(s).settings.fontFamilyCustom === 'Noto Serif CJK SC', '自定义系统字体同步');
  await adminOp('updateSettings', { patch: { fontFamilyCustom: 'bad;font' } }).catch((e) => {
    assert(/非法字符/.test(e.message), '非法字体名称被拒绝');
  });
  await adminOp('updateSettings', { patch: { titleFont: 'custom', titleFontCustom: 'LXGW WenKai' } });
  s = await viewer.waitState((st) => P(st).settings.titleFont === 'custom');
  assert(P(s).settings.titleFontCustom === 'LXGW WenKai', '标题自定义字体同步');
  await adminOp('updateSettings', { patch: { titleFont: 'hologram' } }).catch((e) => {
    assert(/标题字体/.test(e.message), '非法标题字体被拒绝');
  });
  await adminOp('updateSettings', { patch: { titleFontCustom: 'bad;font' } })
    .catch((e) => assert(/非法字符/.test(e.message), '标题字体名称非法字符被拒绝'));

  await adminOp('updateSettings', {
    patch: {
      clockFont: 'serif', clockFontSize: 48, countdownFont: 'kai',
      leaderboardFont: 'custom', leaderboardFontCustom: 'LXGW WenKai',
      marqueeFont: 'serif', welcomeFont: 'kai', welcomeFontSize: 160, scoreFont: 'serif',
    },
  });
  s = await viewer.waitState((st) => P(st).settings.clockFont === 'serif');
  assert(P(s).settings.clockFontSize === 48 && P(s).settings.countdownFont === 'kai' &&
    P(s).settings.leaderboardFont === 'custom' &&
    P(s).settings.leaderboardFontCustom === 'LXGW WenKai' &&
    P(s).settings.marqueeFont === 'serif' && P(s).settings.welcomeFont === 'kai' &&
    P(s).settings.welcomeFontSize === 160 && P(s).settings.scoreFont === 'serif',
    '时钟/倒计时/排行榜/跑马灯/欢迎幕布/分数数字字体同步');
  await adminOp('updateSettings', { patch: { clockFont: 'hologram' } })
    .catch((e) => assert(/时钟字体/.test(e.message), '非法时钟字体被拒绝'));
  await adminOp('updateSettings', { patch: { welcomeFontSize: 999 } })
    .catch((e) => assert(/欢迎幕布字号/.test(e.message), '欢迎幕布字号越界被拒绝'));
  await adminOp('updateSettings', { patch: { scoreFont: 'hologram' } })
    .catch((e) => assert(/分数字体/.test(e.message), '非法分数字体被拒绝'));
  await adminOp('updateSettings', { patch: { fontScale: 3 } }).catch((e) => {
    assert(/字号缩放/.test(e.message), '非法字号缩放被拒绝');
  });
  await adminOp('updateSettings', { patch: { titleAlign: 'justify' } }).catch((e) => {
    assert(/标题对齐/.test(e.message), '非法标题对齐被拒绝');
  });
  await adminOp('updateSettings', { patch: { cardShadow: 'hard' } }).catch((e) => {
    assert(/卡片阴影/.test(e.message), '非法卡片阴影被拒绝');
  });
  await adminOp('updateSettings', { patch: { positiveColor: 'red' } }).catch((e) => {
    assert(/正分颜色/.test(e.message), '非法正分颜色被拒绝');
  });
  await adminOp('updateSettings', { patch: { scrimOpacity: 2 } }).catch((e) => {
    assert(/遮罩强度/.test(e.message), '非法遮罩强度被拒绝');
  });

  await adminOp('updateSettings', {
    patch: {
      cardBgMode: 'acrylic', cardBg: '#101820', cardOpacity: 0.4, cardAcrylicBlur: 20,
      showTeamAccent: false, teamAccentColor: '#00ff00', teamAccentWidth: 7,
    },
  });
  s = await viewer.waitState((st) => P(st).settings.cardBgMode === 'acrylic');
  assert(P(s).settings.cardOpacity === 0.4 && P(s).settings.cardAcrylicBlur === 20 &&
    P(s).settings.showTeamAccent === false && P(s).settings.teamAccentColor === '#00ff00' &&
    P(s).settings.teamAccentWidth === 7, '半透明/亚克力与团队色条设置同步');
  await adminOp('updateSettings', { patch: { cardBgMode: 'frosted' } }).catch((e) => {
    assert(/底色模式/.test(e.message), '非法卡片底色模式被拒绝');
  });
  await adminOp('updateSettings', { patch: { cardOpacity: 2 } }).catch((e) => {
    assert(/不透明度/.test(e.message), '非法卡片不透明度被拒绝');
  });
  await adminOp('updateSettings', { patch: { cardAcrylicBlur: 99 } }).catch((e) => {
    assert(/亚克力模糊/.test(e.message), '非法亚克力模糊被拒绝');
  });
  await adminOp('updateSettings', { patch: { teamAccentColor: 'red' } }).catch((e) => {
    assert(/团队色条颜色/.test(e.message), '非法团队色条颜色被拒绝');
  });

  await adminOp('updateSettings', {
    patch: { styleFreeConfig: true, titleDecor: 'plain', titleAlign: 'left' },
  });
  s = await viewer.waitState((st) => P(st).settings.styleFreeConfig === true);
  assert(P(s).settings.titleDecor === 'plain' && P(s).settings.titleAlign === 'left',
    '风格自由配置/标题装饰/标题对齐同步');
  await adminOp('updateSettings', { patch: { titleDecor: 'fancy' } }).catch((e) => {
    assert(/标题装饰/.test(e.message), '非法标题装饰被拒绝');
  });

  await adminOp('updateSettings', { patch: { titleFree: true, titleX: 30, titleY: 20 } });
  s = await viewer.waitState((st) => P(st).settings.titleFree === true);
  assert(P(s).settings.titleX === 30 && P(s).settings.titleY === 20, '标题自由位置同步');
  await adminOp('updateSettings', { patch: { titleX: 200 } }).catch((e) => {
    assert(/标题位置/.test(e.message), '非法标题位置被拒绝');
  });

  console.log('课堂工具与运行时:');
  await adminOp('setAvatar', { kind: 'person', id: pid, avatar: null });
  s = await viewer.waitState((st) => P(st).people[pid] && P(st).people[pid].avatar === null);
  assert(true, '头像可清除');
  await adminOp('setAvatar', { kind: 'person', id: pid, avatar: up.path });
  s = await viewer.waitState((st) => P(st).people[pid] && P(st).people[pid].avatar === up.path);
  assert(true, '头像可修改');
  await adminOp('setAvatar', { kind: 'person', id: pid, avatar: '../../etc/passwd' }).catch((e) => {
    assert(/头像路径/.test(e.message), '非法头像路径被拒绝');
  });

  const batchAck = await adminOp('addPeopleBatch', { names: ['甲', '乙', '甲', ' 丙 ', '张三'] });
  assert(batchAck.result.added === 3 && batchAck.result.skipped.length === 2, '批量添加去重/跳过重名');
  const batchIds = batchAck.result.personIds;

  await adminOp('setTeamCaptain', { teamId: tid, personId: pid });
  s = await viewer.waitState((st) => P(st) && P(st).teams[tid] && P(st).teams[tid].captainId === pid);
  assert(true, '设置团队成员为队长');

  const outsider = await adminOp('addPerson', { name: '队外人员' });
  await adminOp('setTeamCaptain', { teamId: tid, personId: outsider.result.personId })
    .catch((e) => assert(/只有加入该团队/.test(e.message), '非团队成员不能设为队长'));
  await adminOp('removePerson', { personId: outsider.result.personId });

  const tempCaptain = await adminOp('addPerson', { name: '临时队长', teamId: tid });
  await adminOp('setTeamCaptain', { teamId: tid, personId: tempCaptain.result.personId });
  await adminOp('assignTeam', { personId: tempCaptain.result.personId, teamId: null });
  s = await viewer.waitState((st) => P(st) && P(st).teams[tid] && P(st).teams[tid].captainId === null);
  assert(true, '换队后自动取消队长');
  await adminOp('removePerson', { personId: tempCaptain.result.personId });

  const removedCaptain = await adminOp('addPerson', { name: '待删队长', teamId: tid });
  await adminOp('setTeamCaptain', { teamId: tid, personId: removedCaptain.result.personId });
  await adminOp('removePerson', { personId: removedCaptain.result.personId });
  s = await viewer.waitState((st) => P(st) && P(st).teams[tid] && P(st).teams[tid].captainId === null);
  assert(true, '删除队长后自动清空');

  await adminOp('updateSettings', { patch: { featureTeamCaptain: false } });
  await adminOp('setTeamCaptain', { teamId: tid, personId: pid })
    .catch((e) => assert(/未开启/.test(e.message), '队长功能关闭时拒绝设置'));
  await adminOp('updateSettings', { patch: { featureTeamCaptain: true } });

  await adminOp('setTeamCaptain', { teamId: tid, personId: null });
  s = await viewer.waitState((st) => P(st) && P(st).teams[tid] && P(st).teams[tid].captainId === null);
  assert(true, '取消团队队长');
  await adminOp('addPeopleBatch', { names: Array.from({ length: 201 }, (_, i) => '人' + i) }).catch((e) => {
    assert(/最多/.test(e.message), '批量添加上限被拒绝');
  });
  await adminOp('addPeopleBatch', { names: ['一'.repeat(21)] }).catch((e) => {
    assert(/过长/.test(e.message), '批量超长姓名被拒绝');
  });
  await adminOp('updateSettings', { patch: { featureBatchAdd: false } });
  await adminOp('addPeopleBatch', { names: ['丁'] }).catch((e) => {
    assert(/未开启/.test(e.message), '批量添加关闭时拒绝');
  });
  await adminOp('updateSettings', { patch: { featureBatchAdd: true } });

  const teamBatchAck = await adminOp('addTeamsBatch', {
    names: ['批量队甲', '批量队乙', '批量队甲', ' 批量队丙 '],
  });
  assert(
    teamBatchAck.result.added === 3 && teamBatchAck.result.skipped.length === 1,
    '批量添加团队去重/跳过重名',
  );
  const teamBatchIds = teamBatchAck.result.teamIds;
  await adminOp('addTeamsBatch', { names: ['批量队甲'] }).catch((e) => {
    assert(/没有可添加/.test(e.message), '团队全部重名时报错');
  });
  await adminOp('addTeamsBatch', {
    names: Array.from({ length: 201 }, (_, i) => '批队' + i),
  }).catch((e) => {
    assert(/最多/.test(e.message), '批量团队上限被拒绝');
  });
  await adminOp('addTeamsBatch', { names: ['一'.repeat(21)] }).catch((e) => {
    assert(/过长/.test(e.message), '批量团队名过长被拒绝');
  });
  for (const id of teamBatchIds) {
    await adminOp('removeTeam', { teamId: id });
  }

  const curBefore = await getState();
  const scoreBefore = curBefore.projects[projectId].people[pid].score;
  await adminOp('addTeamScore', { teamId: tid, delta: 5 });
  s = await viewer.waitState((st) => P(st).people[pid] && P(st).people[pid].score === scoreBefore + 5);
  assert(true, '团队整体记分');
  const emptyTeamAck = await adminOp('addTeam', { name: '空队' });
  await adminOp('addTeamScore', { teamId: emptyTeamAck.result.teamId, delta: 1 }).catch((e) => {
    assert(/暂无成员/.test(e.message), '空团队记分报错');
  });
  await adminOp('removeTeam', { teamId: emptyTeamAck.result.teamId });
  await adminOp('undoScore', {});
  s = await viewer.waitState((st) => P(st).people[pid] && P(st).people[pid].score === scoreBefore);
  assert(true, '撤销团队记分');
  await adminOp('addScore', { personId: pid, delta: 5 });
  await viewer.waitState((st) => P(st).people[pid] && P(st).people[pid].score === scoreBefore + 5);
  await adminOp('undoScore', {});
  await viewer.waitState((st) => P(st).people[pid] && P(st).people[pid].score === scoreBefore);
  assert(true, '撤销单次记分');
  await adminOp('setScore', { personId: pid, score: 9 });
  await adminOp('resetScores', {});
  s = await viewer.waitState((st) => Object.values(P(st).people).every((p) => p.score === 0));
  assert(true, '重置本局分数');
  await adminOp('undoScore', {});
  s = await viewer.waitState((st) => P(st).people[pid] && P(st).people[pid].score === 9);
  assert(true, '重置可撤销');
  await adminOp('setScore', { personId: pid, score: 7 });
  await adminOp('updateSettings', { patch: { featureUndo: false } });
  await adminOp('undoScore', {}).catch((e) => {
    assert(/未开启/.test(e.message), '撤销功能关闭时拒绝');
  });
  await adminOp('updateSettings', { patch: { featureUndo: true } });

  // 快捷分预设 + undoTo + 分数日志
  await adminOp('updateSettings', { patch: { quickScorePresets: [2, 4, 8, -2] } });
  s = await viewer.waitState((st) => Array.isArray(P(st).settings.quickScorePresets) &&
    P(st).settings.quickScorePresets[0] === 2);
  assert(P(s).settings.quickScorePresets.length === 4, '快捷分预设自定义同步');
  await adminOp('updateSettings', { patch: { quickScorePresets: [0, 1] } }).catch((e) => {
    assert(/预设/.test(e.message), '非法快捷分预设被拒绝');
  });
  await adminOp('updateSettings', { patch: { quickScorePresets: [1, 5, 10, -1] } });

  const rtSince = viewer.runtimes.length;
  await adminOp('addScore', { personId: pid, delta: 5 });
  await viewer.waitRuntime((r) => r.scoreLogs && r.scoreLogs[projectId]);
  assert(true, '分数日志记录 addScore');
  await adminOp('addScore', { personId: pid, delta: 3 });
  await adminOp('addScore', { personId: pid, delta: 2 });
  const rt = await viewer.waitRuntime(
    (r) => r.undoLabels && r.undoLabels[projectId] && r.undoLabels[projectId].length >= 3 &&
      r.scoreLogs && r.scoreLogs[projectId] && r.scoreLogs[projectId].length >= 3,
    rtSince,
  );
  assert(true, '撤销历史标签与分数日志快照');
  const beforeUndoCount = rt.undoCounts[projectId];
  await adminOp('undoTo', { keep: beforeUndoCount - 2 });
  s = await viewer.waitState((st) => P(st).people[pid] && P(st).people[pid].score === 12);
  assert(true, 'undoTo 连续撤销多步');
  await adminOp('undoTo', { keep: 999 }).catch((e) => {
    assert(/目标数量/.test(e.message), 'undoTo 越界拒绝');
  });

  console.log('倒计时与排行榜:');
  await adminOp('updateSettings', { patch: { featureCountdown: true } });
  await adminOp('updateSettings', { patch: { countdownDisplayMode: 'fullscreen' } });
  s = await viewer.waitState((st) => P(st).settings.countdownDisplayMode === 'fullscreen');
  assert(true, '倒计时显示模式同步');
  await adminOp('updateSettings', { patch: { countdownDisplayMode: 'weird' } }).catch((e) => {
    assert(/倒计时显示模式/.test(e.message), '非法倒计时显示模式被拒绝');
  });
  await adminOp('updateSettings', { patch: { countdownTheme: 'ink' } });
  s = await viewer.waitState((st) => P(st).settings.countdownTheme === 'ink');
  assert(true, '倒计时水墨主题同步');
  await adminOp('updateSettings', { patch: { countdownTheme: 'video' } });
  s = await viewer.waitState((st) => P(st).settings.countdownTheme === 'video');
  assert(true, '倒计时影片主题同步');
  const videoRes = await fetch(BASE + '/media/ink-countdown.mp4');
  const videoBuf = Buffer.from(await videoRes.arrayBuffer());
  assert(videoRes.ok && (videoRes.headers.get('content-type') || '').includes('video/mp4') &&
    videoBuf.length > 100000, '影片素材可通过 HTTP 访问');
  await adminOp('updateSettings', { patch: { countdownTheme: 'ink' } });
  await adminOp('updateSettings', { patch: { countdownTheme: 'oil' } }).catch((e) => {
    assert(/倒计时主题/.test(e.message), '非法倒计时主题被拒绝');
  });
  await adminOp('updateSettings', {
    patch: {
      countdownShape: 'rounded-rect', countdownRadius: 40, countdownSize: 600,
      countdownHeight: 300, countdownFontSize: 96,
      countdownPosition: 'bottom-right', countdownShowProgress: false,
      countdownShowBackdrop: false, countdownBg: '#112233', countdownBgMode: 'acrylic',
      countdownBlur: 18, countdownOpacity: 0.5, countdownTextColor: '#abcdef',
    },
  });
  s = await viewer.waitState((st) => P(st).settings.countdownShape === 'rounded-rect');
  assert(P(s).settings.countdownRadius === 40 && P(s).settings.countdownSize === 600 &&
    P(s).settings.countdownHeight === 300 && P(s).settings.countdownFontSize === 96 &&
    P(s).settings.countdownPosition === 'bottom-right' &&
    P(s).settings.countdownShowProgress === false && P(s).settings.countdownShowBackdrop === false &&
    P(s).settings.countdownBg === '#112233' && P(s).settings.countdownBgMode === 'acrylic' &&
    P(s).settings.countdownBlur === 18 && P(s).settings.countdownOpacity === 0.5 &&
    P(s).settings.countdownTextColor === '#abcdef', '倒计时圆角矩形/宽高/字号/背景模式同步');
  await adminOp('updateSettings', { patch: { countdownShape: 'rect' } });
  s = await viewer.waitState((st) => P(st).settings.countdownShape === 'rect');
  assert(true, '矩形倒计时窗口可用');
  await adminOp('updateSettings', { patch: { countdownShape: 'rounded-rect' } });
  await viewer.waitState((st) => P(st).settings.countdownShape === 'rounded-rect');
  await adminOp('updateSettings', { patch: { countdownShape: 'hexagon' } }).catch((e) => {
    assert(/窗口形状/.test(e.message), '非法倒计时窗口形状被拒绝');
  });
  await adminOp('updateSettings', { patch: { countdownSize: 9999 } }).catch((e) => {
    assert(/窗口尺寸/.test(e.message), '非法倒计时窗口尺寸被拒绝');
  });
  await adminOp('updateSettings', { patch: { countdownHeight: 2000 } }).catch((e) => {
    assert(/窗口高度/.test(e.message), '非法倒计时窗口高度被拒绝');
  });
  await adminOp('updateSettings', { patch: { countdownFontSize: 999 } }).catch((e) => {
    assert(/数字字号/.test(e.message), '非法倒计时数字字号被拒绝');
  });
  await adminOp('updateSettings', { patch: { countdownBgMode: 'blur' } }).catch((e) => {
    assert(/背景模式/.test(e.message), '非法倒计时背景模式被拒绝');
  });
  await adminOp('updateSettings', { patch: { countdownBlur: 99 } }).catch((e) => {
    assert(/亚克力模糊/.test(e.message), '非法倒计时亚克力模糊被拒绝');
  });
  let markR = viewer.runtimes.length;
  await adminOp('countdownStart', { durationSec: 1 });
  await viewer.waitRuntime((r) => r.countdowns[projectId] && r.countdowns[projectId].state === 'running', markR);
  assert(true, '倒计时启动运行态同步');
  const httpRunning = await getState();
  assert(httpRunning.runtime.countdowns[projectId].state === 'running', 'HTTP 状态包含倒计时运行态');
  await viewer.waitRuntime((r) => r.countdowns[projectId] && r.countdowns[projectId].state === 'ended', markR, 5000);
  assert(true, '倒计时结束广播');
  markR = viewer.runtimes.length;
  await adminOp('countdownStart', { durationSec: 30 });
  await viewer.waitRuntime((r) => r.countdowns[projectId] && r.countdowns[projectId].state === 'running', markR);
  await adminOp('countdownPause', {});
  await viewer.waitRuntime((r) => r.countdowns[projectId] && r.countdowns[projectId].state === 'paused', markR);
  assert(true, '倒计时暂停');
  await adminOp('countdownResume', {});
  await viewer.waitRuntime((r) => r.countdowns[projectId] && r.countdowns[projectId].state === 'running', markR);
  assert(true, '倒计时继续');
  await adminOp('countdownReset', {});
  await viewer.waitRuntime((r) => !r.countdowns[projectId], markR);
  assert(true, '倒计时重置');
  markR = viewer.runtimes.length;
  await adminOp('countdownStart', { durationSec: 30 });
  await viewer.waitRuntime((r) => r.countdowns[projectId] && r.countdowns[projectId].state === 'running', markR);
  await adminOp('updateSettings', { patch: { featureCountdown: false } });
  await viewer.waitRuntime((r) => !r.countdowns[projectId], markR);
  assert(true, '关闭倒计时开关会清理运行态');
  await adminOp('countdownStart', { durationSec: 1 }).catch((e) => {
    assert(/未开启/.test(e.message), '倒计时关闭时拒绝');
  });

  await adminOp('updateSettings', {
    patch: { featureRankTies: true, featureLeaderboard: true, rankTieMode: 'competition' },
  });
  await adminOp('setScore', { personId: pid, score: 10 });
  await adminOp('setScore', { personId: batchIds[0], score: 10 });
  await adminOp('setScore', { personId: batchIds[1], score: 8 });

  const csvFetch = async () => {
    const res = await authFetch('/api/scores.csv?project=' + projectId + '&scope=people');
    const buf = Buffer.from(await res.arrayBuffer());
    return { res, buf, text: buf.toString('utf8') };
  };
  let csv = await csvFetch();
  assert(csv.res.headers.get('content-type').includes('text/csv') &&
    csv.buf[0] === 0xEF && csv.buf[1] === 0xBB && csv.buf[2] === 0xBF,
    'CSV 类型与 BOM');
  let rows = csv.text.replace(/^﻿/, '').trim().split(/\r?\n/).slice(1).map((l) => l.split(','));
  assert(rows[0][0] === '1' && rows[1][0] === '1' && rows[2][0] === '3', '竞赛式并列名次');
  await adminOp('updateSettings', { patch: { rankTieMode: 'dense' } });
  csv = await csvFetch();
  rows = csv.text.replace(/^﻿/, '').trim().split(/\r?\n/).slice(1).map((l) => l.split(','));
  assert(rows[0][0] === '1' && rows[1][0] === '1' && rows[2][0] === '2', '密集式并列名次');
  await adminOp('updateSettings', { patch: { rankTieMode: 'none' } });
  csv = await csvFetch();
  rows = csv.text.replace(/^﻿/, '').trim().split(/\r?\n/).slice(1).map((l) => l.split(','));
  assert(rows[0][0] === '1' && rows[1][0] === '2' && rows[2][0] === '3', '顺序编号名次');
  await adminOp('updateSettings', { patch: { featureLeaderboard: false, displayView: 'leaderboard' } }).catch((e) => {
    assert(/排行榜/.test(e.message), '排行榜关闭时拒绝切换视图');
  });

  const commaAck = await adminOp('addPerson', { name: 'A,B"Q' });
  csv = await csvFetch();
  assert(csv.text.includes('"A,B""Q"'), 'CSV 特殊字符转义');
  await adminOp('removePerson', { personId: commaAck.result.personId });

  console.log('课堂玩法与欢迎幕布:');
  await adminOp('updateSettings', {
    patch: {
      featureMarquee: true, marqueeText: '欢迎来到比赛',
      featureWelcome: true, welcomeText: '欢迎光临', welcomeBgColor: '#123456',
      featureCarousel: true, carouselViews: ['cards', 'leaderboard', 'welcome'],
      carouselIntervalSec: 10,
    },
  });
  s = await viewer.waitState((st) => P(st).settings.featureWelcome === true);
  assert(P(s).settings.marqueeText === '欢迎来到比赛' &&
    P(s).settings.welcomeText === '欢迎光临' && P(s).settings.welcomeBgColor === '#123456' &&
    P(s).settings.carouselViews.length === 3 && P(s).settings.carouselIntervalSec === 10,
    '跑马灯/欢迎幕布/轮播设置同步');
  await adminOp('updateSettings', { patch: { carouselViews: ['cards', 'badview'] } }).catch((e) => {
    assert(/轮播视图/.test(e.message), '非法轮播视图被拒绝');
  });
  await adminOp('updateSettings', { patch: { carouselIntervalSec: 1 } }).catch((e) => {
    assert(/轮播间隔/.test(e.message), '非法轮播间隔被拒绝');
  });
  await adminOp('updateSettings', { patch: { bgmEnabled: true, bgmVolume: 0.6, bgmLoop: false } });
  s = await viewer.waitState((st) => P(st).settings.bgmEnabled === true);
  assert(P(s).settings.bgmVolume === 0.6 && P(s).settings.bgmLoop === false, '背景音乐设置同步');

  console.log('导出 / 导入 / 备份 / 清理:');
  const exportRes = await authFetch('/api/export?project=' + projectId + '&assets=1');
  const exportData = await exportRes.json();
  assert(exportRes.ok && exportData.format === 'screenscoreboard.project' && exportData.assets[up.path],
    '项目导出包含资产');
  const importRes = await authFetch('/api/import', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(exportData),
  });
  const importData = await importRes.json();
  assert(importRes.ok && importData.projectId, '项目可导入');
  const afterImport = await getState();
  const imported = afterImport.projects[importData.projectId];
  assert(imported && imported.people[pid] && imported.people[pid].score === 10, '导入后人员与分数一致');
  const importedOrders = [...Object.values(imported.people), ...Object.values(imported.teams)]
    .map((e) => e.order).sort((a, b) => a - b);
  assert(importedOrders.every((n, i) => Number.isInteger(n) && n === i), '导入项目补齐并压缩排序序号');
  const importedAvatar = imported.people[pid].avatar;
  assert(importedAvatar && importedAvatar !== up.path, '导入资产被重写路径');
  const avatarRes = await fetch(BASE + '/' + importedAvatar);
  assert(avatarRes.ok && Buffer.from(await avatarRes.arrayBuffer()).equals(PNG), '导入头像字节一致');

  const badImport = JSON.parse(JSON.stringify(exportData));
  badImport.project.settings.columns = 99;
  const badImportRes = await authFetch('/api/import', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(badImport),
  });
  assert(badImportRes.status === 400, '非法设置导入被拒绝');
  await admin.sendOp('deleteProject', { projectId: importData.projectId });
  await viewer.waitState((st) => !st.projects[importData.projectId]);
  assert(Object.keys((await getState()).projects).length === 1, '导入项目可删除');

  const backupRes = await authFetch('/api/backups/run', { method: 'POST' });
  const backupData = await backupRes.json();
  assert(backupRes.ok && existsSync(path.join(backupData.dir, backupData.file)), '手动备份生成文件');

  const orphanName = 'orphan-test.png';
  const orphanPath = path.join(DATA_DIR, 'avatars', orphanName);
  writeFileSync(orphanPath, PNG);
  const oldTime = new Date(Date.now() - 48 * 3600 * 1000);
  utimesSync(orphanPath, oldTime, oldTime);
  const orphanScan = await (await authFetch('/api/orphans')).json();
  assert(orphanScan.avatars.count >= 1, '扫描到孤儿头像');
  const cleanupRes = await authFetch('/api/orphans/cleanup', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  await cleanupRes.json();
  assert(cleanupRes.ok && !existsSync(orphanPath), '清理孤儿头像');
  assert(existsSync(path.join(DATA_DIR, up.path)), '引用的头像未被清理');

  // 音效库：导入的文件永久保留，删除前需解除引用
  r = await authFetch('/api/sound', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: WAV });
  const libSound = await r.json();
  assert(r.ok && /^sounds\/[^/]+\.wav$/.test(libSound.path), '音效库可导入新音效');
  const libPath = path.join(DATA_DIR, libSound.path);
  const libName = libSound.path.split('/')[1];
  utimesSync(libPath, oldTime, oldTime);
  const libScan = await (await authFetch('/api/orphans')).json();
  assert(libScan.sounds.count === 0, '音效库文件不算孤儿');
  const libCleanup = await authFetch('/api/orphans/cleanup', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  await libCleanup.json();
  assert(libCleanup.ok && existsSync(libPath), '音效库文件不被孤儿清理');
  await adminOp('updateSettings', { patch: { customSound: libSound.path } });
  let delRes = await authFetch('/api/v1/assets/sounds/' + libName, { method: 'DELETE' });
  assert(delRes.status === 422, '被引用的音效不可删除');
  delRes = await authFetch('/api/v1/assets/sounds/' + libName + '?force=1', { method: 'DELETE' });
  const delData = await delRes.json().catch(() => ({}));
  let libState = await getState();
  assert(delRes.ok && delData.data?.removed === libSound.path && delData.data?.cleared >= 1 &&
    !existsSync(libPath) && P(libState).settings.customSound === '',
    '强制删除音效并移除引用');
  await adminOp('updateSettings', { patch: { customSound: soundUp.path } });

  // 图片资源：被引用时需强制删除并清空引用
  r = await authFetch('/api/avatar', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: PNG });
  const libImage = await r.json();
  assert(r.ok && /^avatars\/[^/]+\.png$/.test(libImage.path), '资源库可导入新图片');
  const libImagePath = path.join(DATA_DIR, libImage.path);
  const libImageName = libImage.path.split('/')[1];
  await adminOp('setAvatar', { kind: 'person', id: pid, avatar: libImage.path });
  delRes = await authFetch('/api/v1/assets/avatars/' + libImageName, { method: 'DELETE' });
  assert(delRes.status === 422, '被引用的图片不可删除');
  delRes = await authFetch('/api/v1/assets/avatars/' + libImageName + '?force=1', { method: 'DELETE' });
  const imgDelData = await delRes.json().catch(() => ({}));
  libState = await getState();
  assert(delRes.ok && imgDelData.data?.removed === libImage.path && imgDelData.data?.cleared >= 1 &&
    !existsSync(libImagePath) && P(libState).people[pid].avatar === null,
    '强制删除图片并移除头像引用');
  await adminOp('setAvatar', { kind: 'person', id: pid, avatar: up.path });
  const assetsRes = await (await authFetch('/api/v1/assets')).json();
  assert(Array.isArray(assetsRes.data?.sounds) && assetsRes.data.sounds.some((a) => a.path === soundUp.path),
    '资源库列表包含已上传音效');
  r = await authFetch('/api/v1/assets/sounds/..%2F..%2Fetc%2Fpasswd', { method: 'DELETE' });
  assert(r.status === 404 || r.status === 422, '资源删除拒绝路径穿越');

  await adminOp('setScore', { personId: pid, score: 7 });
  await adminOp('updateSettings', {
    patch: { featureRankTies: true, rankTieMode: 'competition', featureLeaderboard: true, displayView: 'leaderboard' },
  });

  // 非法参数
  await adminOp('updateSettings', { patch: { columns: 99 } }).catch((e) => assert(/列数/.test(e.message), '排版参数越界被拒绝'));
  await adminOp('updateSettings', { patch: { cardStyle: 'hologram' } }).catch((e) => assert(/卡片样式/.test(e.message), '非法卡片样式被拒绝'));
  await adminOp('updateSettings', { patch: { scoreEffect: 'sparkle' } }).catch((e) => assert(/特效类型/.test(e.message), '非法特效类型被拒绝'));
  await adminOp('updateSettings', { patch: { soundVolume: 2 } }).catch((e) => assert(/音量/.test(e.message), '音效音量越界被拒绝'));
  await adminOp('updateSettings', { patch: { soundPreset: 'nope' } }).catch((e) => assert(/内置音效/.test(e.message), '非法内置音效被拒绝'));

  // 广播收敛（先等上一轮合并广播落地）
  await new Promise((r) => setTimeout(r, 150));
  const countBefore = viewer.states.length;
  await adminOp('addScore', { personId: 'p_nope', delta: 1 }).catch((e) => assert(e.message === '人员不存在', '非法 op 返回错误'));
  await new Promise((r) => setTimeout(r, 300));
  assert(viewer.states.length === countBefore, '非法 op 不触发广播');
  await admin.sendOp('addPerson', { name: '无项目' }).catch((e) => assert(/项目不存在/.test(e.message), '缺少 projectId 被拒绝'));

  await new Promise((r) => setTimeout(r, 150));
  const statesBeforeBurst = viewer.states.length;
  for (let i = 0; i < 5; i += 1) await adminOp('addScore', { personId: pid, delta: 1 });
  await new Promise((r) => setTimeout(r, 250));
  const burstStates = viewer.states.length - statesBeforeBurst;
  assert(burstStates > 0 && burstStates < 5, '连续记分合并广播（少于操作次数）');
  await adminOp('setScore', { personId: pid, score: 7 });

  console.log('多项目:');
  const ackP2 = await admin.sendOp('addProject', { name: '第二项目' });
  const projectId2 = ackP2.result.projectId;
  s = await viewer.waitState((st) => st.projects[projectId2]);
  assert(s.projects[projectId2].name === '第二项目' && Object.keys(s.projects).length === 2, '新建项目并同步');
  const p2ack = await admin.sendOp('addPerson', { projectId: projectId2, name: '李四' });
  s = await viewer.waitState((st) => st.projects[projectId2] && st.projects[projectId2].people[p2ack.result.personId]);
  assert(!Object.keys(s.projects[projectId].people).includes(p2ack.result.personId), '两个项目数据互相隔离');
  await admin.sendOp('renameProject', { projectId: projectId2, name: '冠军组' });
  s = await viewer.waitState((st) => st.projects[projectId2] && st.projects[projectId2].name === '冠军组');
  assert(true, '项目可重命名');
  await admin.sendOp('deleteProject', { projectId: projectId2 });
  s = await viewer.waitState((st) => !st.projects[projectId2]);
  assert(Object.keys(s.projects).length === 1, '项目可删除');
  await admin.sendOp('deleteProject', { projectId }).catch((e) => assert(/至少保留/.test(e.message), '最后一个项目不可删除'));
  await adminOp('updateSettings', { patch: { columns: 5 } });
  await viewer.waitState((st) => P(st).settings.columns === 5);

  console.log('持久化（JSON）:');
  viewer.ws.close(); admin.ws.close();
  await stopServer(server);
  server = startServer();
  await waitServer();
  const restored = await getState();
  const rp = restored.projects[projectId];
  assert(rp && rp.people[pid] && rp.people[pid].score === 7, '重启后人员与分数恢复');
  assert(rp.people[ordC] && rp.people[ordC].order === 0 && rp.people[ordA].order === 3 &&
    rp.people[ordB].order === 4 && rp.teams[tid2] && rp.teams[tid2].order === 1 &&
    rp.teams[tid].order === 5, '重启后人员/团队自定义顺序恢复');
  assert(rp.people[pid].bio === '千里之行，始于足下' && rp.teams[tid].bio === '同心者胜' &&
    rp.settings.featureBio === true && rp.settings.bioFont === 'kai' && rp.settings.bioSize === 20 &&
    rp.settings.bioColor === '#ff8800' && rp.settings.bioOpacity === 0.6 &&
    rp.settings.bioItalic === true, '重启后简介与外观设置恢复');
  assert(rp.settings.featureTeamCaptain === true && rp.settings.teamCaptainLabel === '领队' &&
    rp.settings.teamCaptainSizeMode === 'auto' && rp.settings.teamCaptainSize === 14 &&
    rp.settings.teamCaptainColor === '#ffcc00', '重启后队长标签设置恢复');
  assert(rp.settings.displayResolution === '3840x2160' &&
    rp.settings.displayResolutionScale === 70, '重启后显示端逻辑分辨率与放大强度恢复');
  assert(rp.settings.teamMemberLayout === 'column', '重启后成员卡片排列恢复');
  assert(rp.people[pid].layout.x === 200 && rp.people[pid].layout.w === 200 &&
    rp.people[pid].memberLayout.w === 20, '重启后卡片布局恢复（含画布外坐标）');
  assert(rp.settings.cardStyle === 'neon' && rp.settings.columns === 5 && rp.settings.avatarSize === 96, '重启后外观设置恢复');
  assert(rp.settings.bgImage === up.path && rp.settings.bgImageBlur === true &&
    rp.settings.bgImageBlurAmount === 18, '重启后背景图与虚化设置恢复');
  assert(rp.settings.bgScrimEnabled === true && rp.settings.scrimOpacity === 0.3,
    '重启后背景遮罩开关与强度恢复');
  assert(rp.settings.displayStyle === 'seewo', '重启后显示风格恢复');
  assert(rp.settings.fontFamily === 'custom' && rp.settings.fontFamilyCustom === 'Noto Serif CJK SC' &&
    rp.settings.titleSize === 72 && rp.settings.cardBorderWidth === 3 && rp.settings.showRank === false,
    '重启后高级外观设置恢复');
  assert(rp.settings.titleFont === 'custom' && rp.settings.titleFontCustom === 'LXGW WenKai',
    '重启后标题字体设置恢复');
  assert(rp.settings.cardBgMode === 'acrylic' && rp.settings.cardOpacity === 0.4 &&
    rp.settings.showTeamAccent === false && rp.settings.teamAccentColor === '#00ff00',
    '重启后半透明/亚克力与团队色条设置恢复');
  assert(rp.settings.styleFreeConfig === true && rp.settings.titleDecor === 'plain' &&
    rp.settings.titleAlign === 'left', '重启后风格自由配置/标题设置恢复');
  assert(rp.settings.titleFree === true && rp.settings.titleX === 30 && rp.settings.titleY === 20,
    '重启后标题自由位置恢复');
  assert(rp.settings.scoreEffect === 'highlight' && rp.settings.customSound === soundUp.path &&
    rp.settings.soundPreset === 'chime' &&
    rp.settings.spotlightScope === 'person_team' && rp.settings.spotlightWidth === 700 &&
    rp.settings.spotlightHeight === 420 && rp.settings.spotlightTheme === 'squeeze' &&
    rp.settings.spotlightReturnDuration === 2200 && rp.settings.spotlightScrimEnabled === true &&
    rp.settings.spotlightScrimOpacity === 0.25 && rp.settings.spotlightPlayMode === 'parallel' &&
    rp.settings.spotlightParallelMax === 6 && rp.settings.spotlightParallelGap === 36 &&
    rp.settings.spotlightParallelTransition === 500 && rp.settings.spotlightInterruptFade === 250 &&
    rp.settings.spotlightFontFamily === 'custom' &&
    rp.settings.spotlightFontFamilyCustom === 'LXGW WenKai' &&
    rp.settings.spotlightFontScale === 1.6 &&
    rp.settings.spotlightAvatarEnabled === false &&
    rp.settings.spotlightAvatarSizeMode === 'manual' &&
    rp.settings.spotlightAvatarSize === 120 &&
    rp.settings.spotlightAvatarPosition === 'top' &&
    rp.settings.featureSpotlightTrigger === true && rp.settings.spotlightTriggerDuration === 2400 &&
    rp.settings.scoreRolling === false,
    '重启后居中突显/范围/宽高/主题/飞入飞回时长/压暗开关与强度/播放模式/并列与打断参数/字体/字号/头像/手动突显/滚动数字/自定义音效恢复');
  assert(rp.settings.countdownDisplayMode === 'fullscreen' && rp.settings.countdownShape === 'rounded-rect' &&
    rp.settings.countdownSize === 600 && rp.settings.countdownHeight === 300 &&
    rp.settings.countdownFontSize === 96 && rp.settings.countdownPosition === 'bottom-right' &&
    rp.settings.clockFont === 'serif' && rp.settings.clockFontSize === 48 &&
    rp.settings.countdownFont === 'kai' && rp.settings.leaderboardFontCustom === 'LXGW WenKai' &&
    rp.settings.marqueeFont === 'serif' && rp.settings.welcomeFontSize === 160 &&
    rp.settings.scoreFont === 'serif' &&
    rp.settings.countdownBg === '#112233' && rp.settings.countdownBgMode === 'acrylic' &&
    rp.settings.countdownBlur === 18, '重启后倒计时显示模式/圆角矩形/字号/背景恢复');
  assert(Object.keys(restored.projects).length === 1, '重启后项目列表恢复');
  assert(rp.settings.featureRankTies === true && rp.settings.rankTieMode === 'competition' &&
    rp.settings.featureLeaderboard === true && rp.settings.displayView === 'leaderboard' &&
    rp.settings.featureCountdown === false, '重启后新功能开关恢复');
  assert(rp.settings.featureMobileAdmin === false && rp.settings.adminTouchTargetSize === 52,
    '重启后管理端移动布局与触控目标尺寸恢复');
  assert(!restored.runtime.undoCounts[projectId] && !restored.runtime.countdowns[projectId] &&
    !restored.runtime.spotlightEvents[projectId], '重启后撤销栈、倒计时与手动突显运行态清空');

  console.log('存储后端（SQLite）:');
  await stopServer(server);
  const sqliteEnv = { STORAGE: 'sqlite', SQLITE_FILE: path.join(DATA_DIR, 'scoreboard-test.db') };
  server = startServer(sqliteEnv);
  await waitServer();
  let sqlState = await getState();
  const sqlProjectId = Object.keys(sqlState.projects)[0];
  assert(Boolean(sqlProjectId), 'SQLite 后端启动并初始化');
  const sqlClient = wsClient('sqlite-admin', adminSession);
  await sqlClient.ready;
  await sqlClient.waitState((st) => st.projects && st.projects[sqlProjectId]);
  const sqlAck = await sqlClient.sendOp('addPerson', { projectId: sqlProjectId, name: '持久化测试' });
  const sqlPid = sqlAck.result.personId;
  await new Promise((r) => setTimeout(r, 300)); // 等防抖写盘
  sqlClient.ws.close();
  await stopServer(server);
  server = startServer(sqliteEnv);
  await waitServer();
  sqlState = await getState();
  assert(sqlState.projects[sqlProjectId] && sqlState.projects[sqlProjectId].people[sqlPid], 'SQLite 重启后数据恢复');
  await stopServer(server);

  console.log('旧版数据迁移:');
  const legacyDir = mkdtempSync(path.join(tmpdir(), 'sb-legacy-'));
  writeFileSync(path.join(legacyDir, 'state.json'), JSON.stringify({
    version: 1,
    people: { p_legacy: { id: 'p_legacy', name: '旧成员', score: 3, teamId: null, createdAt: 1, avatar: null } },
    teams: {},
    settings: { title: '旧积分榜', displayStyle: 'trueage' },
  }));
  server = startServer({ DATA_DIR: legacyDir });
  await waitServer();
  const legacyState = await getState();
  const legacyProjects = Object.values(legacyState.projects);
  assert(legacyProjects.length === 1 && legacyProjects[0].name === '默认项目', '旧数据包装为默认项目');
  assert(legacyProjects[0].people.p_legacy && legacyProjects[0].people.p_legacy.score === 3, '旧人员数据保留');
  assert(legacyProjects[0].people.p_legacy.order === 0, '旧数据补齐排序序号');
  assert(legacyProjects[0].settings.title === '旧积分榜' && legacyProjects[0].settings.scoreEffect, '旧设置保留并补全新字段');
  assert(legacyProjects[0].settings.displayStyle === 'trueage', '旧的真·古风风格保留');
  await stopServer(server);

  async function backendRoundtrip(label, env) {
    const dir = mkdtempSync(path.join(tmpdir(), 'sb-' + label + '-'));
    let srv = startServer({ ...env, DATA_DIR: dir });
    await waitServer();
    let st = await getState();
    const pid = Object.keys(st.projects)[0];
    const client = wsClient(label + '-admin', adminSession);
    await client.ready;
    await client.waitState((x) => x.projects && x.projects[pid]);
    const ack = await client.sendOp('addPerson', { projectId: pid, name: label + '测试' });
    await new Promise((r) => setTimeout(r, 400));
    client.ws.close();
    await stopServer(srv);
    srv = startServer({ ...env, DATA_DIR: dir });
    await waitServer();
    st = await getState();
    assert(st.projects[pid] && st.projects[pid].people[ack.result.personId], label + ' 重启后数据恢复');
    await stopServer(srv);
    rmSync(dir, { recursive: true, force: true });
  }

  if (process.env.TEST_PG_URL) {
    console.log('存储后端（PostgreSQL）:');
    await backendRoundtrip('PostgreSQL', { STORAGE: 'postgres', DATABASE_URL: process.env.TEST_PG_URL });
  } else {
    console.log('存储后端（PostgreSQL）: 跳过（未设置 TEST_PG_URL）');
  }
  if (process.env.TEST_MYSQL_URL) {
    console.log('存储后端（MySQL）:');
    await backendRoundtrip('MySQL', { STORAGE: 'mysql', MYSQL_URL: process.env.TEST_MYSQL_URL });
  } else {
    console.log('存储后端（MySQL）: 跳过（未设置 TEST_MYSQL_URL）');
  }

  console.log('存储配置 API 与 TXT 后端:');
  const configDir = mkdtempSync(path.join(tmpdir(), 'sb-config-'));
  server = startServer({ DATA_DIR: configDir, STORAGE: 'json', STATE_FILE: '' });
  await waitServer();

  let storageRes = await authFetch('/api/v1/storage');
  assert(storageRes.ok, '管理员可读取存储配置');
  let storagePayload = await storageRes.json();
  assert(storagePayload.data.config.kind === 'json', '默认后端为 json');
  assert(
    storagePayload.data.backends.length === KINDS.length,
    `返回 ${KINDS.length} 种存储后端元数据`,
  );
  assert(
    storagePayload.data.backends.some(
      (b) => b.kind === 'redis' && b.recommended && b.recommendedLabel === '效率推荐',
    ),
    'Redis 标记为效率推荐',
  );
  assert(
    storagePayload.data.backends.some(
      (b) => b.kind === 'sqlite' && b.recommended && b.recommendedLabel === '本地推荐',
    ),
    'SQLite 标记为本地推荐',
  );
  assert(storagePayload.data.backends[3].kind === 'redis', 'Redis 位于后端选择第四位');
  assert(
    storagePayload.data.backends.every(
      (b) => Array.isArray(b.pros) && b.pros.length > 0 &&
        Array.isArray(b.cons) && b.cons.length > 0 && b.warning,
    ),
    '每种后端都有优缺点与警告',
  );
  assert(
    storagePayload.data.backends.some(
      (b) => b.kind === 'postgres' && b.recommendedLabel === '生产推荐',
    ),
    'PostgreSQL 标记为生产推荐',
  );

  const anonStorage = await fetch(BASE + '/api/v1/storage');
  assert(anonStorage.status === 401, '匿名访问存储配置返回 401');

  const putJson = (body) => authFetch('/api/v1/storage', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  storageRes = await putJson({ kind: 'nope', options: {} });
  assert(storageRes.status === 422, '未知存储后端被拒绝');
  storageRes = await putJson({ kind: 'json', options: { file: '../escape.json' } });
  assert(storageRes.status === 422, '越界状态文件路径被拒绝');

  storageRes = await putJson({ kind: 'txt', options: { file: 'state.txt' } });
  assert(storageRes.ok, '保存 TXT 存储配置');
  assert(existsSync(path.join(configDir, 'storage.json')), '生成 storage.json');
  if (process.platform !== 'win32') {
    const mode = statSync(path.join(configDir, 'storage.json')).mode & 0o777;
    assert(mode === 0o600, 'storage.json 权限为 0600');
  }

  storageRes = await authFetch('/api/v1/storage/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'txt', options: { file: 'state.txt' } }),
  });
  let testPayload = await storageRes.json();
  assert(testPayload.data.ok === true, '测试 TXT 连接成功');

  let cfgState = await getState();
  const cfgProjectId = Object.keys(cfgState.projects)[0];
  const cfgClient = wsClient('config-admin', adminSession);
  await cfgClient.ready;
  await cfgClient.waitState((st) => st.projects && st.projects[cfgProjectId]);
  const cfgAck = await cfgClient.sendOp('addPerson', { projectId: cfgProjectId, name: '迁移测试' });
  const cfgPersonId = cfgAck.result.personId;
  await new Promise((r) => setTimeout(r, 300));
  cfgClient.ws.close();

  storageRes = await authFetch('/api/v1/storage/migrate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mode: 'copy',
      config: { kind: 'txt', options: { file: 'state.txt' } },
    }),
  });
  storagePayload = await storageRes.json();
  assert(storageRes.ok && storagePayload.data.verified === true, '迁移到 TXT 并回读校验');

  await stopServer(server);
  // storage.json 优先于环境变量：这里故意传入 STORAGE=json
  server = startServer({ DATA_DIR: configDir, STORAGE: 'json', STATE_FILE: '' });
  await waitServer();
  cfgState = await getState();
  assert(
    cfgState.projects[cfgProjectId] && cfgState.projects[cfgProjectId].people[cfgPersonId],
    'TXT 后端重启后数据恢复',
  );
  assert(existsSync(path.join(configDir, 'state.txt')), 'state.txt 已生成');
  const txtContent = readFileSync(path.join(configDir, 'state.txt'), 'utf8');
  assert(txtContent.includes('\n  "version": 2'), 'TXT 内容是缩进 JSON');
  const healthRes = await fetch(BASE + '/api/health');
  const healthPayload = await healthRes.json();
  assert(healthPayload.storage === 'txt' && healthPayload.storageOk === true, '健康检查报告 txt 且正常');

  storageRes = await putJson({ kind: 'json', options: { file: 'fresh.json' } });
  assert(storageRes.ok, '仅保存配置（不迁移）');
  await stopServer(server);
  server = startServer({ DATA_DIR: configDir, STORAGE: 'txt', STATE_FILE: '' });
  await waitServer();
  const freshState = await getState();
  const freshPeople = Object.values(freshState.projects).flatMap((p) => Object.keys(p.people));
  assert(!freshPeople.includes(cfgPersonId), '仅保存不迁移时新后端为空');
  assert(Object.keys(freshState.projects).length >= 1, '空库启动自动创建默认项目');

  await stopServer(server);
  writeFileSync(path.join(configDir, 'storage.json'), '{not-json');
  const badProc = startServer({ DATA_DIR: configDir });
  const badCode = await new Promise((resolve) => badProc.once('exit', resolve));
  assert(badCode !== 0, '损坏 storage.json 导致启动失败');

  console.log('存储配置密码保护:');
  const secretDir = mkdtempSync(path.join(tmpdir(), 'sb-secret-'));
  const secret = 'sb-super-secret-password';
  server = startServer({ DATA_DIR: secretDir, STORAGE: 'json', STATE_FILE: '' });
  await waitServer();
  storageRes = await authFetch('/api/v1/storage', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: 'postgres',
      options: {
        host: '127.0.0.1', port: 5432, user: 'u', database: 'scoreboard', password: secret,
      },
    }),
  });
  const putText = await storageRes.text();
  assert(storageRes.ok, '保存带密码的数据库配置');
  assert(!putText.includes(secret), '保存响应不包含密码');
  storageRes = await authFetch('/api/v1/storage');
  const getText = await storageRes.text();
  assert(!getText.includes(secret), '读取配置不包含密码');
  assert(JSON.parse(getText).data.config.hasPassword === true, '配置标记已设置密码');
  const secretFile = readFileSync(path.join(secretDir, 'storage.json'), 'utf8');
  assert(secretFile.includes(secret), '配置文件保存密码');
  if (process.platform !== 'win32') {
    assert((statSync(path.join(secretDir, 'storage.json')).mode & 0o777) === 0o600, '密码配置文件权限 0600');
  }
  storageRes = await authFetch('/api/v1/storage/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: 'postgres',
      options: {
        host: '127.0.0.1', port: 1, user: 'u', database: 'scoreboard', password: secret,
      },
    }),
  });
  testPayload = await storageRes.json();
  assert(testPayload.data.ok === false, '不可达数据库测试连接失败');
  assert(!JSON.stringify(testPayload).includes(secret), '测试连接错误不泄露密码');
  await stopServer(server);
  rmSync(secretDir, { recursive: true, force: true });

  rmSync(configDir, { recursive: true, force: true });
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(legacyDir, { recursive: true, force: true });

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('验证脚本异常:', e); process.exit(1); });
