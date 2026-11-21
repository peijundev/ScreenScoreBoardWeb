import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ScreenScoreBoardClient } from '../dist/esm/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');
const SERVER = path.join(REPO_ROOT, 'server/index.js');
const PORT = 3474;
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'sdk-admin-pass';

async function waitHealth() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const response = await fetch(BASE + '/api/health');
      if (response.ok) return;
    } catch (_) {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('计分板服务未启动');
}

async function stop(proc) {
  if (!proc || proc.exitCode !== null) return;
  const exited = new Promise((resolve) => proc.once('exit', resolve));
  proc.kill('SIGTERM');
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
}

const skip = !existsSync(SERVER) ? '未找到仓库 server/index.js（发布包内不运行集成测试）' : false;

test('SDK 对真实服务端：登录、记分、突显、令牌与 MCP', { skip }, async (t) => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'sb-sdk-'));
  const server = spawn(process.execPath, ['server/index.js'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: dataDir,
      STORAGE: 'json',
      LOG_LEVEL: 'error',
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD: PASSWORD,
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
  t.after(async () => {
    await stop(server);
    rmSync(dataDir, { recursive: true, force: true });
  });

  await waitHealth();
  const client = new ScreenScoreBoardClient({
    baseUrl: BASE,
    username: 'admin',
    password: PASSWORD,
    remember: true,
  });
  const user = await client.login();
  assert.equal(user.username, 'admin');
  assert.equal(user.role, 'admin');
  assert.match(client.getSession().cookie || '', /ssb_session=/);

  const project = await client.projects.create('SDK 集成测试');
  assert.ok(project.projectId);
  const projectId = project.projectId;

  const person = await client.people.add(projectId, { name: 'AI 选手' });
  assert.equal(person.name, 'AI 选手');
  const scored = await client.people.addScore(projectId, person.id, 3);
  assert.equal(scored.score, 3);

  const spotlight = await client.spotlight.person(projectId, person.id, 1200);
  assert.equal(spotlight.targetType, 'person');
  assert.equal(spotlight.targetId, person.id);
  assert.equal(spotlight.durationMs, 1200);

  const settings = await client.settings.get(projectId);
  assert.equal(settings.featureSpotlightTrigger, true);

  const state = await client.system.state();
  assert.equal(state.projects[projectId].people[person.id].score, 3);
  assert.ok(
    (state.runtime.spotlightEvents?.[projectId] || [])
      .some((event) => event.targetId === person.id && event.seq > 0),
    '运行时快照包含手动突显事件',
  );

  const csv = await client.data.exportScoresCsv(projectId, 'people');
  assert.match(csv, /AI 选手/);

  const accessBefore = await client.auth.getAccess();
  assert.equal(accessBefore.requireLogin, true);
  assert.equal(accessBefore.openAccess, false);
  const opened = await client.auth.updateAccess(false);
  assert.equal(opened.openAccess, true);
  assert.equal(opened.requireLogin, false);

  // 开放模式下，没有 Cookie / 令牌的新客户端也会获得管理员权限
  const anonymous = new ScreenScoreBoardClient({ baseUrl: BASE });
  const openStatus = await anonymous.auth.status();
  assert.equal(openStatus.openAccess, true);
  assert.equal(openStatus.authenticated, true);
  const openUsers = await anonymous.auth.users.list();
  assert.ok(openUsers.length >= 1);

  await anonymous.auth.updateAccess(true);
  assert.equal((await client.auth.getAccess()).requireLogin, true);

  const token = await client.auth.tokens.create({ name: 'sdk-ai' });
  assert.match(token.token || '', /^ssb_/);

  const ai = new ScreenScoreBoardClient({ baseUrl: BASE, token: token.token });
  const health = await ai.system.health();
  assert.equal(health.ok, true);

  const initialized = await ai.mcp.initialize();
  assert.equal(initialized.serverInfo.name, 'screenscoreboard');
  const tools = await ai.mcp.listTools();
  assert.ok(tools.some((tool) => tool.name === 'trigger_spotlight'));

  const mcpSpotlight = await ai.mcp.callTool('trigger_spotlight', {
    projectId,
    targetType: 'person',
    targetId: person.id,
    durationMs: 900,
  });
  assert.equal(mcpSpotlight.isError, false);
  assert.equal(mcpSpotlight.data.targetId, person.id);
  assert.equal(mcpSpotlight.data.durationMs, 900);

  const projectResource = await ai.mcp.readResource(`scoreboard://project/${projectId}`);
  assert.equal(projectResource.id, projectId);
  assert.equal(projectResource.people[person.id].score, 3);
});
