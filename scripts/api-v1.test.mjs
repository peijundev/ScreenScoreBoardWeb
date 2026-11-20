import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const PORT = 3467;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sb-api-'));
const ADMIN_PASSWORD = 'test-admin-pass';
let server = null;
let session = null;

function startServer() {
  return spawn(process.execPath, ['server/index.js'], {
    cwd: path.join(path.dirname(fileURLToPath(import.meta.url)), '..'),
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR,
      STORAGE: 'json',
      LOG_LEVEL: 'error',
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD,
      ADMIN_PASSWORD_FILE: '',
      SESSION_TTL_HOURS: '',
      SESSION_REMEMBER_DAYS: '',
      COOKIE_SECURE: '',
      TRUST_PROXY: '',
      TLS_CERT_FILE: '',
      TLS_KEY_FILE: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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

async function loginAs(username, password) {
  const res = await fetch(BASE + '/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error('登录失败：HTTP ' + res.status);
  return sessionFromResponse(res);
}

async function stopProcess(proc) {
  if (!proc || proc.exitCode !== null) return;
  const exited = new Promise((resolve) => proc.once('exit', resolve));
  proc.kill('SIGTERM');
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
}

async function waitServer() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(BASE + '/api/health');
      if (res.ok) {
        session = await loginAs('admin', ADMIN_PASSWORD);
        return;
      }
    } catch (_) { /* retry */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('服务未启动');
}

async function api(pathname, options = {}, authSession = session) {
  const method = String(options.method || 'GET').toUpperCase();
  const headers = {
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(options.headers || {}),
  };
  if (authSession) {
    headers.Cookie = authSession.cookie;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) headers['X-CSRF-Token'] = authSession.csrf;
  }
  const res = await fetch(BASE + '/api/v1' + pathname, { ...options, headers });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { /* not json */ }
  return { status: res.status, json, text, headers: res.headers };
}

async function wsClient(authSession = session) {
  const ws = new WebSocket(
    `ws://127.0.0.1:${PORT}/ws`,
    authSession ? { headers: { Cookie: authSession.cookie } } : {},
  );
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const states = [];
  ws.on('message', (buf) => {
    const msg = JSON.parse(String(buf));
    if (msg.type === 'state') states.push(msg);
  });
  let seq = 0;
  const pending = new Map();
  ws.on('message', (buf) => {
    const msg = JSON.parse(String(buf));
    if (msg.type === 'ack' && msg.reqId && pending.has(msg.reqId)) {
      const { resolve, reject } = pending.get(msg.reqId);
      pending.delete(msg.reqId);
      if (msg.ok) resolve(msg.result);
      else reject(new Error(msg.error));
    }
  });
  const sendOp = (op, payload) => new Promise((resolve, reject) => {
    const reqId = 't' + ++seq;
    pending.set(reqId, { resolve, reject });
    ws.send(JSON.stringify({ type: 'op', reqId, op, payload }));
  });
  const waitState = async (predicate) => {
    for (let i = 0; i < 60; i += 1) {
      const found = [...states].reverse().find((m) => predicate(m));
      if (found) return found;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('等待 WS 状态超时');
  };
  return { ws, sendOp, waitState, states };
}

test('REST v1 全量资源、revision 与旧 API 兼容', async (t) => {
  server = startServer();
  await waitServer();
  const ws = await wsClient();
  t.after(async () => {
    ws.ws.close();
    await stopProcess(server);
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  const health = await api('/health');
  assert.equal(health.status, 200);
  assert.equal(health.json.data.ok, true);

  const anonymousState = await fetch(BASE + '/api/v1/state');
  assert.equal(anonymousState.status, 200, '公开状态无需登录');
  const anonymousWrite = await api('/projects', {
    method: 'POST', body: JSON.stringify({ name: '匿名' }),
  }, null);
  assert.equal(anonymousWrite.status, 401, '匿名写操作被拒绝');
  const noCsrf = await fetch(BASE + '/api/v1/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: session.cookie },
    body: JSON.stringify({ name: '缺少 CSRF' }),
  });
  assert.equal(noCsrf.status, 403, '缺少 CSRF 头被拒绝');
  assert.equal((await noCsrf.json()).error.code, 'CSRF_FAILED');

  const openapi = await api('/openapi.json');
  assert.equal(openapi.status, 200);
  assert.equal(openapi.json.openapi, '3.1.0');
  const peopleOp = openapi.json.paths['/projects/{projectId}/people'].get;
  assert.ok(peopleOp);
  assert.ok(peopleOp.parameters.some((p) => p.name === 'q'));
  assert.ok(peopleOp.responses['403'] && peopleOp.responses['413'] && peopleOp.responses['428']);

  const create = await api('/projects', { method: 'POST', body: JSON.stringify({ name: 'API 测试' }) });
  assert.equal(create.status, 201);
  const projectId = create.json.data.projectId;
  assert.ok(projectId);

  const add = await api(`/projects/${projectId}/people`, {
    method: 'POST',
    body: JSON.stringify({ name: '张三', bio: '简介' }),
  });
  assert.equal(add.status, 201);
  const personId = add.json.data.id;

  const emptyName = await api(`/projects/${projectId}/people`, {
    method: 'POST', body: JSON.stringify({ name: '' }),
  });
  assert.equal(emptyName.status, 400);
  assert.equal(emptyName.json.error.code, 'INVALID_ARGUMENT');

  const badTeam = await api(`/projects/${projectId}/people`, {
    method: 'POST', body: JSON.stringify({ name: '无队', teamId: 'tm_missing' }),
  });
  assert.equal(badTeam.status, 404);
  assert.equal(badTeam.json.error.code, 'NOT_FOUND');

  const missingTheme = await api('/themes/th_missing');
  assert.equal(missingTheme.status, 404);

  const evilOrigin = await api('/projects', {
    method: 'POST',
    headers: { Origin: 'http://evil.example.com' },
    body: JSON.stringify({ name: '跨站' }),
  });
  assert.equal(evilOrigin.status, 403);
  assert.equal(evilOrigin.json.error.code, 'ORIGIN_NOT_ALLOWED');

  // 功能开关关闭 → 403（验证 FeatureDisabledError 不再被吞成 500）
  const disableUndo = await api(`/projects/${projectId}/settings`, {
    method: 'PATCH', body: JSON.stringify({ patch: { featureUndo: false } }),
  });
  assert.equal(disableUndo.status, 200);
  const disabledUndo = await api(`/projects/${projectId}/runtime/undo`, { method: 'POST' });
  assert.equal(disabledUndo.status, 403);
  assert.equal(disabledUndo.json.error.code, 'FEATURE_DISABLED');
  await api(`/projects/${projectId}/settings`, {
    method: 'PATCH', body: JSON.stringify({ patch: { featureUndo: true } }),
  });

  // 超限请求体应得到结构化 413，而不是连接被重置
  const huge = await api('/projects', {
    method: 'POST', body: JSON.stringify({ name: 'x'.repeat(2 * 1024 * 1024 + 10) }),
  });
  assert.equal(huge.status, 413);
  assert.equal(huge.json.error.code, 'PAYLOAD_TOO_LARGE');

  const hugeImage = await api('/assets/images', {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(2 * 1024 * 1024)]),
  });
  assert.equal(hugeImage.status, 413);

  const score = await api(`/projects/${projectId}/people/${personId}/score/add`, {
    method: 'POST', body: JSON.stringify({ delta: 5 }),
  });
  assert.equal(score.json.data.score, 5);
  const broadcast = await ws.waitState((m) => m.data.projects[projectId] &&
    m.data.projects[projectId].people[personId] &&
    m.data.projects[projectId].people[personId].score === 5);
  assert.equal(broadcast.data.projects[projectId].people[personId].score, 5);

  const unknown = await api(`/projects/${projectId}/settings`, {
    method: 'PATCH', body: JSON.stringify({ notARealSetting: 1 }),
  });
  assert.equal(unknown.status, 422);
  assert.deepEqual(unknown.json.error.details.unknownKeys, ['notARealSetting']);

  const okSettings = await api(`/projects/${projectId}/settings`, {
    method: 'PATCH', body: JSON.stringify({ patch: { accent: '#112233' } }),
  });
  assert.equal(okSettings.status, 200);
  assert.equal(okSettings.json.data.accent, '#112233');

  const oldIgnore = await ws.sendOp('updateSettings', {
    projectId, patch: { totallyUnknown: true },
  });
  assert.ok(oldIgnore !== undefined);
  const state = await api('/state');
  assert.equal(state.json.data.projects[projectId].settings.totallyUnknown, undefined);

  const theme = await api('/themes', { method: 'POST', body: JSON.stringify({ name: '接口主题' }) });
  assert.equal(theme.status, 201);
  const themeId = theme.json.data.meta.id;
  assert.equal(theme.json.data.meta.revision, 1);

  const noRevision = await api(`/themes/${themeId}/layers`, {
    method: 'PATCH', body: JSON.stringify({ layers: [] }),
  });
  assert.equal(noRevision.status, 428);

  const layers = await api(`/themes/${themeId}/layers`, {
    method: 'PATCH',
    headers: { 'If-Match': '"1"' },
    body: JSON.stringify({ layers: [{ name: '背景', nodes: [] }] }),
  });
  assert.equal(layers.status, 200);
  assert.equal(layers.json.meta.revision, 2);
  const layerId = layers.json.data.layers[0].id;

  const stale = await api(`/themes/${themeId}/layers`, {
    method: 'PATCH',
    headers: { 'If-Match': '"1"' },
    body: JSON.stringify({ layers: [] }),
  });
  assert.equal(stale.status, 409);

  const node = await api(`/themes/${themeId}/layers/${layerId}/nodes/nd_test`, {
    method: 'PUT',
    headers: { 'If-Match': '"2"' },
    body: JSON.stringify({ node: { type: 'ellipse', x: 10, y: 20, w: 100, h: 60 } }),
  });
  assert.equal(node.status, 200);
  assert.equal(node.json.meta.revision, 3);

  const themeUnknown = await api(`/themes/${themeId}/settings`, {
    method: 'PATCH',
    headers: { 'If-Match': '"3"' },
    body: JSON.stringify({ settings: { notAThemeKey: 1 } }),
  });
  assert.equal(themeUnknown.status, 422);

  const anyRevision = await api(`/themes/${themeId}/settings`, {
    method: 'PATCH',
    headers: { 'If-Match': '*' },
    body: JSON.stringify({ settings: {} }),
  });
  assert.equal(anyRevision.status, 200);
  assert.equal(anyRevision.json.meta.revision, 4);

  const draftBody = {
    theme: {
      format: 'screenscoreboard.theme', version: 2,
      meta: { name: '草稿', baseStyle: 'custom' },
      canvas: { width: 1920, height: 1080 }, layers: [], widgets: [], settings: {},
    },
  };
  const draft1 = await api(`/projects/${projectId}/theme-draft`, {
    method: 'PATCH', body: JSON.stringify(draftBody),
  });
  assert.equal(draft1.status, 200);
  assert.equal(draft1.json.meta.revision, 1);
  const draftNoRev = await api(`/projects/${projectId}/theme-draft`, {
    method: 'PATCH', body: JSON.stringify(draftBody),
  });
  assert.equal(draftNoRev.status, 428);
  const draft2 = await api(`/projects/${projectId}/theme-draft`, {
    method: 'PATCH',
    headers: { 'If-Match': '"1"' },
    body: JSON.stringify(draftBody),
  });
  assert.equal(draft2.status, 200);
  assert.equal(draft2.json.meta.revision, 2);

  const escape = await api(`/projects/${projectId}/ops`, {
    method: 'POST', body: JSON.stringify({ op: 'addScore', payload: { personId, delta: 2 } }),
  });
  assert.equal(escape.status, 200);
  assert.equal(escape.json.data.score, 7);

  const createdOp = await api('/auth/users', {
    method: 'POST',
    body: JSON.stringify({ username: 'op1', password: 'operator-pass', role: 'operator' }),
  });
  assert.equal(createdOp.status, 200);
  const opSession = await loginAs('op1', 'operator-pass');
  const opScore = await api(
    `/projects/${projectId}/people/${personId}/score/add`,
    { method: 'POST', body: JSON.stringify({ delta: 1 }) },
    opSession,
  );
  assert.equal(opScore.status, 200, '操作员可以记分');
  const opSettings = await api(
    `/projects/${projectId}/settings`,
    { method: 'PATCH', body: JSON.stringify({ patch: { accent: '#000000' } }) },
    opSession,
  );
  assert.equal(opSettings.status, 403, '操作员不能改设置');
  const opEscape = await api(
    '/ops',
    {
      method: 'POST',
      body: JSON.stringify({
        op: 'updateSettings',
        payload: { projectId, patch: { accent: '#000000' } },
      }),
    },
    opSession,
  );
  assert.equal(opEscape.status, 403, '操作员不能借 /ops 提权');

  const missing = await api('/projects/pr_missing');
  assert.equal(missing.status, 404);

  const legacyHealth = await fetch(BASE + '/api/health');
  assert.equal(legacyHealth.status, 200);
  const legacyState = await fetch(BASE + '/api/state');
  assert.equal(legacyState.status, 200);
  const legacy = await legacyState.json();
  assert.ok(legacy.projects[projectId]);
  assert.equal(legacy.themes, undefined);
});
