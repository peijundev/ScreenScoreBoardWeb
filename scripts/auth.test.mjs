import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { listRoutes } = require(path.join(ROOT, 'server/api'));
const { OPS } = require(path.join(ROOT, 'server/ops'));
const {
  OP_MIN_ROLE,
  routeMinRole,
  legacyMinRole,
} = require(path.join(ROOT, 'server/auth/policy'));

const ADMIN_PASSWORD = 'test-admin-pass';
const OPERATOR_PASSWORD = 'operator-pass';
const VIEWER_PASSWORD = 'viewer-pass';
const BASE = 'http://127.0.0.1:3470';

const AUTH_ENV = {
  ADMIN_USERNAME: 'admin',
  ADMIN_PASSWORD,
  ADMIN_PASSWORD_FILE: '',
  SESSION_TTL_HOURS: '',
  SESSION_REMEMBER_DAYS: '',
  COOKIE_SECURE: '',
  TRUST_PROXY: '',
  TLS_CERT_FILE: '',
  TLS_KEY_FILE: '',
};

function startServer({ dataDir, port = 3470, env = {} }) {
  return spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, ...AUTH_ENV, PORT: String(port), DATA_DIR: dataDir, LOG_LEVEL: 'error', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function stopProcess(proc) {
  if (!proc || proc.exitCode !== null) return;
  const exited = new Promise((resolve) => proc.once('exit', resolve));
  proc.kill('SIGTERM');
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
}

async function waitHealth(base) {
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(base + '/api/health');
      if (res.ok) return;
    } catch (_) { /* retry */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('服务未启动');
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
  return { cookie: pairs.join('; '), csrf: find('ssb_csrf'), raw: list };
}

async function login(base, username, password) {
  const res = await fetch(base + '/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error('登录失败：HTTP ' + res.status);
  return { session: sessionFromResponse(res), res };
}

async function api(base, session, pathname, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const headers = {
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(options.headers || {}),
  };
  if (session) {
    headers.Cookie = session.cookie;
    if (options.csrf !== false && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      headers['X-CSRF-Token'] = session.csrf;
    }
  }
  const res = await fetch(base + '/api/v1' + pathname, { ...options, headers });
  let json = null;
  try { json = await res.json(); } catch (_) { /* empty */ }
  return { status: res.status, json, headers: res.headers };
}

function wsClient(base, session = null) {
  const ws = new WebSocket(
    base.replace(/^http/, 'ws') + '/ws',
    session ? { headers: { Cookie: session.cookie } } : {},
  );
  const states = [];
  const pending = new Map();
  let seq = 0;
  const ready = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const closed = new Promise((resolve) => {
    ws.on('close', (code) => resolve(code));
  });
  ws.on('message', (buf) => {
    const msg = JSON.parse(String(buf));
    if (msg.type === 'state') states.push(msg);
    if (msg.type === 'ack' && msg.reqId && pending.has(msg.reqId)) {
      const entry = pending.get(msg.reqId);
      pending.delete(msg.reqId);
      if (msg.ok) entry.resolve(msg.result);
      else entry.reject(new Error(msg.error));
    }
  });
  return {
    ws,
    ready,
    closed,
    states,
    waitState: async (predicate) => {
      for (let i = 0; i < 80; i += 1) {
        const found = [...states].reverse().find(predicate);
        if (found) return found;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error('等待 WS 状态超时');
    },
    op: (op, payload) => new Promise((resolve, reject) => {
      const reqId = 'a' + ++seq;
      pending.set(reqId, { resolve, reject });
      ws.send(JSON.stringify({ type: 'op', reqId, op, payload }));
    }),
  };
}

async function userByName(base, session, username) {
  const res = await api(base, session, '/auth/users');
  return res.json.data.users.find((user) => user.username === username);
}

test('鉴权系统：登录、角色、CSRF、会话、MCP 与本地模式', async (t) => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'sb-auth-'));
  const setupDir = mkdtempSync(path.join(tmpdir(), 'sb-auth-setup-'));
  const localDir = mkdtempSync(path.join(tmpdir(), 'sb-auth-local-'));
  const server = startServer({ dataDir });
  const setupServer = startServer({
    dataDir: setupDir,
    port: 3471,
    env: { ADMIN_PASSWORD: '', ADMIN_PASSWORD_FILE: '' },
  });
  t.after(async () => {
    await Promise.all([stopProcess(server), stopProcess(setupServer)]);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(setupDir, { recursive: true, force: true });
    rmSync(localDir, { recursive: true, force: true });
  });

  await waitHealth(BASE);
  await waitHealth('http://127.0.0.1:3471');
  const adminLogin = await login(BASE, 'admin', ADMIN_PASSWORD);
  const admin = adminLogin.session;
  const loginCookies = adminLogin.res.headers.getSetCookie();
  assert.ok(loginCookies.some((line) => /^ssb_session=.*HttpOnly/i.test(line)), '会话 Cookie 为 HttpOnly');
  assert.ok(loginCookies.some((line) => /SameSite=Lax/i.test(line)), 'Cookie 为 SameSite=Lax');
  const csrfLine = loginCookies.find((line) => line.startsWith('ssb_csrf='));
  assert.ok(csrfLine && !/HttpOnly/i.test(csrfLine), 'CSRF Cookie 可被 JS 读取');

  // 登录失败与「不做限流」
  for (let i = 0; i < 30; i += 1) {
    const res = await fetch(BASE + '/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'wrong-' + i }),
    });
    assert.equal(res.status, 401, '错误密码返回 401');
    assert.equal(res.headers.get('retry-after'), null, '没有 Retry-After');
  }
  const afterFailures = await login(BASE, 'admin', ADMIN_PASSWORD);
  assert.ok(afterFailures.session.cookie, '连续失败后仍可正常登录');

  const state = await api(BASE, admin, '/state');
  const projectId = Object.keys(state.json.data.projects)[0];

  // CSRF
  const noCsrf = await api(BASE, admin, '/projects', {
    method: 'POST',
    csrf: false,
    body: JSON.stringify({ name: '缺少 CSRF' }),
  });
  assert.equal(noCsrf.status, 403);
  assert.equal(noCsrf.json.error.code, 'CSRF_FAILED');
  const withCsrf = await api(BASE, admin, '/projects', {
    method: 'POST',
    body: JSON.stringify({ name: 'CSRF 正常' }),
  });
  assert.equal(withCsrf.status, 201);

  // 用户与角色
  for (const [username, password, role] of [
    ['op1', OPERATOR_PASSWORD, 'operator'],
    ['view1', VIEWER_PASSWORD, 'viewer'],
  ]) {
    const created = await api(BASE, admin, '/auth/users', {
      method: 'POST',
      body: JSON.stringify({ username, password, role }),
    });
    assert.equal(created.status, 200, '创建 ' + role);
  }
  const weak = await api(BASE, admin, '/auth/users', {
    method: 'POST',
    body: JSON.stringify({ username: 'weak', password: '123', role: 'viewer' }),
  });
  assert.equal(weak.status, 422);
  assert.equal(weak.json.error.code, 'WEAK_PASSWORD');
  const duplicate = await api(BASE, admin, '/auth/users', {
    method: 'POST',
    body: JSON.stringify({ username: 'op1', password: OPERATOR_PASSWORD, role: 'operator' }),
  });
  assert.equal(duplicate.status, 400);
  assert.equal(duplicate.json.error.code, 'INVALID_ARGUMENT');

  const op = (await login(BASE, 'op1', OPERATOR_PASSWORD)).session;
  const view = (await login(BASE, 'view1', VIEWER_PASSWORD)).session;

  const adminPerson = await api(BASE, admin, `/projects/${projectId}/people`, {
    method: 'POST', body: JSON.stringify({ name: '鉴权人员' }),
  });
  const personId = adminPerson.json.data.id;
  const opScore = await api(BASE, op, `/projects/${projectId}/people/${personId}/score/add`, {
    method: 'POST', body: JSON.stringify({ delta: 1 }),
  });
  assert.equal(opScore.status, 200, '操作员可记分');
  const opSettings = await api(BASE, op, `/projects/${projectId}/settings`, {
    method: 'PATCH', body: JSON.stringify({ patch: { accent: '#112233' } }),
  });
  assert.equal(opSettings.status, 403, '操作员不能改设置');
  const opOps = await api(BASE, op, '/ops', {
    method: 'POST',
    body: JSON.stringify({ op: 'updateSettings', payload: { projectId, patch: { accent: '#112233' } } }),
  });
  assert.equal(opOps.status, 403, '操作员不能通过 /ops 提权');
  const viewScore = await api(BASE, view, `/projects/${projectId}/people/${personId}/score/add`, {
    method: 'POST', body: JSON.stringify({ delta: 1 }),
  });
  assert.equal(viewScore.status, 403, '只读不能记分');

  // Legacy 路由
  const anonImport = await fetch(BASE + '/api/import', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(anonImport.status, 401, '匿名不能导入');
  const anonExport = await fetch(BASE + '/api/export?project=' + projectId);
  assert.equal(anonExport.status, 401, '匿名不能导出');
  const anonUnknown = await fetch(BASE + '/api/not-a-route');
  assert.equal(anonUnknown.status, 401, '未知旧 API 默认拒绝');
  assert.equal((await fetch(BASE + '/api/state')).status, 200, '公开状态仍可读');

  // WS 权限与显示端写门禁
  const anonWs = wsClient(BASE);
  await anonWs.ready;
  const anonState = await anonWs.waitState((m) => m.data.projects[projectId]);
  assert.ok(anonState, '匿名 WS 收到快照');
  await assert.rejects(anonWs.op('updateSettings', { projectId, patch: { title: 'x' } }), /登录|权限/);
  const adminWs = wsClient(BASE, admin);
  await adminWs.ready;
  await adminWs.waitState((m) => m.data.projects[projectId]);
  const adminSettings = await adminWs.op('updateSettings', { projectId, patch: { title: '鉴权标题' } });
  assert.ok(adminSettings);
  const opWs = wsClient(BASE, op);
  await opWs.ready;
  await opWs.waitState((m) => m.data.projects[projectId]);
  assert.ok(await opWs.op('addScore', { projectId, personId, delta: 1 }));
  await assert.rejects(opWs.op('updateSettings', { projectId, patch: { title: 'x' } }), /权限/);
  const viewWs = wsClient(BASE, view);
  await viewWs.ready;
  await viewWs.waitState((m) => m.data.projects[projectId]);
  await assert.rejects(viewWs.op('addScore', { projectId, personId, delta: 1 }), /权限/);

  // 大量非法 op 不应被限流/断连
  for (let i = 0; i < 20; i += 1) {
    await assert.rejects(adminWs.op('notARealOp', { projectId }), /未知操作/);
  }
  assert.equal(adminWs.ws.readyState, WebSocket.OPEN, '大量失败 op 后连接仍保持');

  // 会话吊销
  const opUser = await userByName(BASE, admin, 'op1');
  const opSessions = await api(BASE, admin, `/auth/users/${opUser.id}/sessions`);
  const opSession = opSessions.json.data.sessions[0];
  assert.ok(opSession, '操作员会话可见');
  const revoked = await api(BASE, admin, `/auth/users/${opUser.id}/sessions/${opSession.id}`, {
    method: 'DELETE',
  });
  assert.equal(revoked.status, 200, '管理员可吊销会话');
  const opAfterRevoke = await api(BASE, op, '/auth/me');
  assert.equal(opAfterRevoke.status, 401, '吊销后 Cookie 失效');
  assert.equal(await opWs.closed, 4401, '吊销后 WS 关闭 4401');

  // 重置密码
  const opLogin2 = await login(BASE, 'op1', OPERATOR_PASSWORD);
  const reset = await api(BASE, admin, `/auth/users/${opUser.id}/password`, {
    method: 'POST', body: JSON.stringify({ password: 'new-operator-pass' }),
  });
  assert.equal(reset.status, 200);
  assert.equal((await api(BASE, opLogin2.session, '/auth/me')).status, 401, '重置密码后旧会话失效');
  assert.equal((await fetch(BASE + '/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'op1', password: OPERATOR_PASSWORD }),
  })).status, 401, '旧密码失效');
  assert.ok((await login(BASE, 'op1', 'new-operator-pass')).session.cookie, '新密码可登录');

  // 停用 / 启用
  const disable = await api(BASE, admin, `/auth/users/${opUser.id}`, {
    method: 'PATCH', body: JSON.stringify({ disabled: true }),
  });
  assert.equal(disable.status, 200);
  assert.equal((await fetch(BASE + '/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'op1', password: 'new-operator-pass' }),
  })).status, 401, '停用后不能登录');
  const enable = await api(BASE, admin, `/auth/users/${opUser.id}`, {
    method: 'PATCH', body: JSON.stringify({ disabled: false }),
  });
  assert.equal(enable.status, 200);
  assert.ok((await login(BASE, 'op1', 'new-operator-pass')).session.cookie, '启用后可登录');

  // 最后一个管理员保护
  const adminUser = await userByName(BASE, admin, 'admin');
  const selfDisable = await api(BASE, admin, `/auth/users/${adminUser.id}`, {
    method: 'PATCH', body: JSON.stringify({ disabled: true }),
  });
  assert.equal(selfDisable.status, 403, '不能停用自己');
  const selfDemote = await api(BASE, admin, `/auth/users/${adminUser.id}`, {
    method: 'PATCH', body: JSON.stringify({ role: 'viewer' }),
  });
  assert.equal(selfDemote.status, 403, '不能降级自己');
  const selfDelete = await api(BASE, admin, `/auth/users/${adminUser.id}`, { method: 'DELETE' });
  assert.equal(selfDelete.status, 403, '不能删除自己');

  // 文件与快照隔离
  await new Promise((resolve) => setTimeout(resolve, 300));
  const authFile = path.join(dataDir, 'auth.json');
  const sessionsFile = path.join(dataDir, 'sessions.json');
  assert.equal(statSync(authFile).mode & 0o777, 0o600, 'auth.json 权限 0600');
  assert.equal(statSync(sessionsFile).mode & 0o777, 0o600, 'sessions.json 权限 0600');
  const authJson = JSON.parse(readFileSync(authFile, 'utf8'));
  assert.equal(authJson.settings.requireLogin, true, 'auth.json 持久化登录模式开关');
  assert.ok(!readFileSync(authFile, 'utf8').includes(ADMIN_PASSWORD), 'auth.json 无明文密码');
  const stateFile = readFileSync(path.join(dataDir, 'state.json'), 'utf8');
  assert.ok(!/"users"|"tokens"|"passwordHash"/.test(stateFile), 'state.json 不含鉴权数据');
  assert.equal((await fetch(BASE + '/auth.json')).status, 404, 'auth.json 不可通过 HTTP 读取');

  // 权限矩阵完整性
  assert.deepEqual(Object.keys(OP_MIN_ROLE).sort(), Object.keys(OPS).sort(), 'op 权限表覆盖全部 op');
  for (const route of listRoutes()) {
    assert.ok(['public', 'viewer', 'operator', 'admin'].includes(routeMinRole(route)), '路由权限值合法');
  }
  assert.equal(legacyMinRole('GET', '/api/state'), 'public');
  assert.equal(legacyMinRole('GET', '/api/themes/th_1'), 'public');
  assert.equal(legacyMinRole('POST', '/api/avatar'), 'admin');
  assert.equal(legacyMinRole('GET', '/api/not-real'), 'admin');

  // 部署模式开放访问：管理员可在运行时关闭/启用登录系统
  console.log('访问控制（开放模式）:');
  const accessBefore = await api(BASE, admin, '/auth/access');
  assert.equal(accessBefore.status, 200);
  assert.equal(accessBefore.json.data.requireLogin, true);
  assert.equal(accessBefore.json.data.openAccess, false);
  assert.ok(accessBefore.json.data.activeAdmins >= 1);

  const openRes = await api(BASE, admin, '/auth/access', {
    method: 'PATCH', body: JSON.stringify({ requireLogin: false }),
  });
  assert.equal(openRes.status, 200);
  assert.equal(openRes.json.data.openAccess, true);

  const openStatus = await fetch(BASE + '/api/v1/auth/status').then((r) => r.json());
  assert.equal(openStatus.data.openAccess, true);
  assert.equal(openStatus.data.authenticated, true);
  assert.equal(openStatus.data.requireLogin, false);
  assert.equal(openStatus.data.user.role, 'admin');

  const anonAccess = await fetch(BASE + '/api/v1/auth/access');
  assert.equal(anonAccess.status, 200, '开放模式下无需登录即可读取访问控制');
  const anonCreate = await fetch(BASE + '/api/v1/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '开放模式项目' }),
  });
  assert.equal(anonCreate.status, 201, '开放模式下匿名请求获得管理员权限');

  const openWs = wsClient(BASE);
  await openWs.ready;
  await openWs.waitState((m) => m.data.projects[projectId]);
  assert.ok(
    await openWs.op('updateSettings', { projectId, patch: { title: '开放模式' } }),
    '开放模式下匿名 WS 可写',
  );

  const closeRes = await api(BASE, null, '/auth/access', {
    method: 'PATCH', body: JSON.stringify({ requireLogin: true }),
  });
  assert.equal(closeRes.status, 200, '开放模式下匿名请求可重新启用登录');
  assert.equal(closeRes.json.data.requireLogin, true);
  assert.equal(await openWs.closed, 4401, '重新启用登录后 system WS 被关闭');

  const anonAfter = await fetch(BASE + '/api/v1/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '匿名拒绝' }),
  });
  assert.equal(anonAfter.status, 401, '重新启用登录后匿名写被拒绝');
  const adminMe = await fetch(BASE + '/api/v1/auth/me', {
    headers: { Cookie: admin.cookie },
  });
  assert.equal(adminMe.status, 200, '原有管理员会话在重新启用登录后仍有效');

  // 首次初始化
  const setupStatus = await fetch('http://127.0.0.1:3471/api/v1/auth/status').then((r) => r.json());
  assert.equal(setupStatus.data.setupRequired, true);
  const blockedSetup = await fetch('http://127.0.0.1:3471/api/v1/auth/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.9' },
    body: JSON.stringify({ username: 'admin', password: 'setup-password-123' }),
  });
  assert.equal(blockedSetup.status, 403, '带转发头的 setup 被拒绝');
  const doSetup = await fetch('http://127.0.0.1:3471/api/v1/auth/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'setup-password-123' }),
  });
  assert.equal(doSetup.status, 200, 'loopback setup 成功');
  const secondSetup = await fetch('http://127.0.0.1:3471/api/v1/auth/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'root', password: 'setup-password-123' }),
  });
  assert.equal(secondSetup.status, 409, '第二次 setup 返回冲突');

  // 反向代理语义：X-Forwarded-Proto 让 Cookie 带 Secure
  const proxyDir = mkdtempSync(path.join(tmpdir(), 'sb-auth-proxy-'));
  const proxyServer = startServer({
    dataDir: proxyDir,
    port: 3472,
    env: { TRUST_PROXY: '1' },
  });
  try {
    await waitHealth('http://127.0.0.1:3472');
    const proxyLogin = await fetch('http://127.0.0.1:3472/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'score.example.com' },
      body: JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD }),
    });
    assert.equal(proxyLogin.status, 200);
    assert.ok(proxyLogin.headers.getSetCookie().some((line) => /Secure/i.test(line)), '反代 HTTPS 下 Cookie 带 Secure');
  } finally {
    await stopProcess(proxyServer);
    rmSync(proxyDir, { recursive: true, force: true });
  }

  // Electron 本地模式：无 Cookie 可写，非 loopback 拒绝
  const localScript = `
    const { start } = require('./server/index');
    start({ port: 3473, host: '127.0.0.1', auth: false }).catch((e) => { console.error(e); process.exit(1); });
  `;
  const localProc = spawn(process.execPath, ['-e', localScript], {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR: localDir, LOG_LEVEL: 'error' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await waitHealth('http://127.0.0.1:3473');
    const localStatus = await fetch('http://127.0.0.1:3473/api/v1/auth/status').then((r) => r.json());
    assert.equal(localStatus.data.authEnabled, false);
    const localWrite = await fetch('http://127.0.0.1:3473/api/v1/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '本地模式' }),
    });
    assert.equal(localWrite.status, 201, '本地模式无 Cookie 可写');
  } finally {
    await stopProcess(localProc);
  }
  const badHost = spawn(process.execPath, ['-e', `
    const { start } = require('./server/index');
    start({ port: 3474, host: '0.0.0.0', auth: false })
      .then(() => { console.log('UNEXPECTED'); process.exit(0); })
      .catch((e) => { console.log('EXPECTED:' + e.message); process.exit(0); });
  `], {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR: localDir, LOG_LEVEL: 'error' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const badOutput = await new Promise((resolve) => {
    let text = '';
    badHost.stdout.on('data', (d) => { text += d; });
    badHost.on('exit', () => resolve(text));
    setTimeout(() => { try { badHost.kill('SIGKILL'); } catch (_) {} resolve(text); }, 5000);
  });
  assert.match(badOutput, /EXPECTED:auth:false/, '非 loopback + auth:false 抛错');

  adminWs.ws.close();
  anonWs.ws.close();
  viewWs.ws.close();
  opWs.ws.close();

  // 开放模式 + 会话在服务重启后仍有效
  const openBeforeRestart = await api(BASE, admin, '/auth/access', {
    method: 'PATCH', body: JSON.stringify({ requireLogin: false }),
  });
  assert.equal(openBeforeRestart.status, 200);
  await stopProcess(server);
  const restarted = startServer({ dataDir });
  try {
    await waitHealth(BASE);
    const restartedStatus = await fetch(BASE + '/api/v1/auth/status').then((r) => r.json());
    assert.equal(restartedStatus.data.openAccess, true, '开放模式在重启后保留');
    const reopen = await fetch(BASE + '/api/v1/auth/access', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requireLogin: true }),
    });
    assert.equal(reopen.status, 200, '重启后开放模式仍可重新启用登录');
    const persisted = await fetch(BASE + '/api/v1/auth/me', {
      headers: { Cookie: admin.cookie },
    });
    assert.equal(persisted.status, 200, '会话在服务重启后仍有效');
  } finally {
    await stopProcess(restarted);
  }
});
