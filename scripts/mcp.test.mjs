import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { listRoutes } = require(path.join(ROOT, 'server/api'));
const PORT = 3468;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sb-mcp-'));
const ADMIN_PASSWORD = 'test-admin-pass';
let server = null;
let rpcId = 0;
let adminToken = '';

function startServer() {
  return spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
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

async function loginAdmin() {
  const res = await fetch(BASE + '/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD }),
  });
  if (!res.ok) throw new Error('登录失败：HTTP ' + res.status);
  return sessionFromResponse(res);
}

async function createToken(session, userId = '') {
  const pathname = userId
    ? '/api/v1/auth/users/' + encodeURIComponent(userId) + '/tokens'
    : '/api/v1/auth/tokens';
  const res = await fetch(BASE + pathname, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: session.cookie,
      'X-CSRF-Token': session.csrf,
    },
    body: JSON.stringify({ name: 'mcp-test' }),
  });
  if (!res.ok) throw new Error('创建令牌失败：HTTP ' + res.status);
  return (await res.json()).data.token;
}

async function createTokenWithAdmin(userId) {
  const res = await fetch(BASE + '/api/v1/auth/users/' + encodeURIComponent(userId) + '/tokens', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + adminToken,
    },
    body: JSON.stringify({ name: 'operator-token' }),
  });
  if (!res.ok) throw new Error('创建用户令牌失败：HTTP ' + res.status);
  return (await res.json()).data.token;
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
        const session = await loginAdmin();
        adminToken = await createToken(session);
        return;
      }
    } catch (_) { /* retry */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('服务未启动');
}

async function rpc(method, params) {
  const res = await fetch(BASE + '/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: 'Bearer ' + adminToken,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  assert.equal(res.status, 200);
  return res.json();
}

async function rest(pathname, options = {}) {
  const res = await fetch(BASE + '/api/v1' + pathname, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      Accept: 'application/json',
      Authorization: 'Bearer ' + adminToken,
      ...(options.headers || {}),
    },
  });
  return res.json();
}

function startStdio() {
  const proc = spawn(process.execPath, [path.join(ROOT, 'bin/screenscoreboard-mcp.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      SCOREBOARD_URL: BASE,
      SCOREBOARD_TOKEN: adminToken,
      LOG_LEVEL: 'error',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  const rl = readline.createInterface({ input: proc.stdout, terminal: false });
  rl.on('line', (line) => {
    let message = null;
    try { message = JSON.parse(line); } catch (_) { return; }
    if (message.id != null && pending.has(message.id)) {
      const { resolve } = pending.get(message.id);
      pending.delete(message.id);
      resolve(message);
    }
  });
  let seq = 0;
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error('stdio MCP 超时'));
      }
    }, 5000);
    timer.unref();
  });
  return { proc, send };
}

test('MCP HTTP 与 stdio 工具一致且可调用', async (t) => {
  server = startServer();
  await waitServer();
  t.after(async () => {
    await stopProcess(server);
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  const anonymous = await fetch(BASE + '/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });
  assert.equal(anonymous.status, 401, 'MCP 需要登录');

  const opUserRes = await fetch(BASE + '/api/v1/auth/users', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + adminToken,
    },
    body: JSON.stringify({ username: 'mcp-op', password: 'operator-pass', role: 'operator' }),
  });
  assert.equal(opUserRes.status, 200);
  const opUser = (await opUserRes.json()).data.user;
  const opToken = await createTokenWithAdmin(opUser.id);
  const operatorMcp = await fetch(BASE + '/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + opToken,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }),
  });
  assert.equal(operatorMcp.status, 403, '操作员令牌不能使用 MCP');

  const init = await rpc('initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' },
  });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'screenscoreboard');

  const list = await rpc('tools/list', {});
  const expectedNames = listRoutes()
    .filter((route) => route.mcp && !route.raw)
    .map((route) => route.mcp)
    .sort();
  assert.deepEqual(
    list.result.tools.map((tool) => tool.name).sort(),
    expectedNames,
    'MCP 工具表必须与 REST 路由表（排除 raw 端点）完全一致',
  );
  for (const tool of list.result.tools) {
    assert.equal(typeof tool.description, 'string');
    assert.equal(tool.inputSchema.type, 'object');
  }
  const names = new Set(list.result.tools.map((tool) => tool.name));
  assert.ok(names.has('add_person'));
  assert.ok(names.has('trigger_spotlight'));
  const spotTool = list.result.tools.find((tool) => tool.name === 'trigger_spotlight');
  assert.deepEqual(
    [...spotTool.inputSchema.required].sort(),
    ['projectId', 'targetId', 'targetType'],
    '手动突显工具声明了必填参数',
  );
  assert.ok(!names.has('update_theme_part'), '主题子资源使用分工具而非单一 update_theme_part');
  assert.ok(names.has('update_theme_layers'));
  assert.ok(names.has('call_op'));
  assert.ok(names.has('call_project_op'));
  for (const raw of ['export_project', 'export_scores_csv', 'upload_image', 'upload_sound']) {
    assert.ok(!names.has(raw), raw + ' 是 raw 端点，不应暴露为 MCP 工具');
  }

  const projects = await rest('/projects');
  const projectId = projects.data[0].id;
  const added = await rpc('tools/call', {
    name: 'add_person', arguments: { projectId, name: 'AI 添加' },
  });
  assert.equal(added.result.isError, false);
  const person = JSON.parse(added.result.content[0].text);
  assert.equal(person.name, 'AI 添加');

  const spotlighted = await rpc('tools/call', {
    name: 'trigger_spotlight',
    arguments: { projectId, targetType: 'person', targetId: person.id, durationMs: 900 },
  });
  assert.equal(spotlighted.result.isError, false);
  const spotlightEvent = JSON.parse(spotlighted.result.content[0].text);
  assert.equal(spotlightEvent.targetType, 'person');
  assert.equal(spotlightEvent.targetId, person.id);
  assert.equal(spotlightEvent.durationMs, 900);

  const scored = await rpc('tools/call', {
    name: 'add_score', arguments: { projectId, personId: person.id, delta: 3 },
  });
  assert.equal(scored.result.isError, false);
  const after = await rest(`/projects/${projectId}/people/${person.id}`);
  assert.equal(after.data.score, 3);

  const bad = await rpc('tools/call', { name: 'add_person', arguments: { name: '缺项目' } });
  assert.equal(bad.result.isError, true);

  const unknown = await rpc('tools/call', { name: 'no_such_tool', arguments: {} });
  assert.equal(unknown.result.isError, true);

  const resources = await rpc('resources/list', {});
  assert.ok(resources.result.resources.length >= 4);
  const health = await rpc('resources/read', { uri: 'scoreboard://health' });
  assert.ok(health.result.contents[0].text.includes('"ok": true'));

  const stdio = startStdio();
  t.after(() => stopProcess(stdio.proc));
  const stdioInit = await stdio.send('initialize', { protocolVersion: '2025-06-18' });
  assert.equal(stdioInit.result.protocolVersion, '2025-06-18');
  const stdioList = await stdio.send('tools/list', {});
  const stdioNames = stdioList.result.tools.map((tool) => tool.name).sort();
  assert.deepEqual(stdioNames, [...names].sort());
  const stdioHealth = await stdio.send('tools/call', { name: 'get_health', arguments: {} });
  assert.equal(stdioHealth.result.isError, false);
});
