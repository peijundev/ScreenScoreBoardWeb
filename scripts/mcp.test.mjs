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
let server = null;
let rpcId = 0;

function startServer() {
  return spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR, STORAGE: 'json', LOG_LEVEL: 'error' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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
      if (res.ok) return;
    } catch (_) { /* retry */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('服务未启动');
}

async function rpc(method, params) {
  const res = await fetch(BASE + '/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
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
      ...(options.headers || {}),
    },
  });
  return res.json();
}

function startStdio() {
  const proc = spawn(process.execPath, [path.join(ROOT, 'bin/screenscoreboard-mcp.js')], {
    cwd: ROOT,
    env: { ...process.env, SCOREBOARD_URL: BASE, LOG_LEVEL: 'error' },
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
