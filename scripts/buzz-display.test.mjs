// 独立显示端抢答：临时计时器、锁定赢家突显、结束清除
// 运行: node --test scripts/buzz-display.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3482;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_PASSWORD = 'test-admin-pass';
const MEMBER_PASSWORD = 'member-pass-1';

function chromiumPath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  try {
    return execFileSync('which', ['chromium'], { encoding: 'utf8' }).trim();
  } catch (_) {
    try {
      return execFileSync('which', ['google-chrome'], { encoding: 'utf8' }).trim();
    } catch (_) {
      return null;
    }
  }
}

const skipReason = !chromiumPath()
  ? '未找到 Chromium（设置 CHROME_PATH 或安装 chromium / google-chrome）'
  : !existsSync(path.join(ROOT, 'public/v2/display.html'))
    ? '未构建前端，请先运行 npm run build:web'
    : false;

async function waitCdpPort(profile) {
  const file = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100; i += 1) {
    try {
      const port = Number(readFileSync(file, 'utf8').split('\n')[0]);
      if (Number.isInteger(port) && port > 0) return port;
    } catch (_) { /* retry */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

async function stopProcess(proc) {
  if (!proc || proc.exitCode !== null) return;
  const exited = new Promise((resolve) => proc.once('exit', resolve));
  proc.kill('SIGTERM');
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
}

async function waitUrl(url, attempts = 100) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
    } catch (_) { /* retry */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
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

async function login(username, password) {
  const res = await fetch(BASE + '/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(res.status, 200, '登录失败：' + username);
  return sessionFromResponse(res);
}

async function api(session, pathname, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const headers = {
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    Cookie: session.cookie,
  };
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) headers['X-CSRF-Token'] = session.csrf;
  const res = await fetch(BASE + '/api/v1' + pathname, { ...options, headers });
  let json = null;
  try { json = await res.json(); } catch (_) { /* empty */ }
  return { status: res.status, json };
}

function memberWs(session) {
  const ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/ws', { headers: { Cookie: session.cookie } });
  const pending = new Map();
  let seq = 0;
  const ready = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  ws.on('message', (buf) => {
    const msg = JSON.parse(String(buf));
    if (msg.type === 'ack' && msg.reqId && pending.has(msg.reqId)) {
      const entry = pending.get(msg.reqId);
      pending.delete(msg.reqId);
      if (msg.ok) entry.resolve(msg.result);
      else entry.reject(new Error(msg.error));
    }
  });
  return {
    ready,
    close: () => ws.close(),
    op: (op, payload) => new Promise((resolve, reject) => {
      const reqId = 'd' + ++seq;
      pending.set(reqId, { resolve, reject });
      ws.send(JSON.stringify({ type: 'op', reqId, op, payload }));
    }),
  };
}

test('独立显示端：抢答临时计时器与锁定突显', { skip: skipReason }, async (t) => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'sb-buzz-display-'));
  const profile = mkdtempSync(path.join(tmpdir(), 'sb-buzz-chrome-'));
  const server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: dataDir,
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
  const chrome = spawn(chromiumPath(), [
    '--headless=new', '--no-sandbox', '--disable-gpu',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--window-size=1280,800', 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => {
    await Promise.all([stopProcess(chrome), stopProcess(server)]);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(profile, { recursive: true, force: true });
  });

  assert.ok(await waitUrl(BASE + '/api/health'), '服务未启动');

  const admin = await login('admin', ADMIN_PASSWORD);
  const adminWs = memberWs(admin);
  t.after(() => adminWs.close());
  await adminWs.ready;
  const snapshot = await (await fetch(BASE + '/api/state')).json();
  let projectId = Object.keys(snapshot.projects)[0];
  if (!projectId) {
    const created = await api(admin, '/projects', {
      method: 'POST',
      body: JSON.stringify({ name: '显示端抢答项目' }),
    });
    projectId = created.json.data.projectId;
  }
  assert.ok(projectId);
  const personRes = await api(admin, `/projects/${projectId}/people`, {
    method: 'POST',
    body: JSON.stringify({ name: '抢答甲' }),
  });
  const person = personRes.json.data;
  const team = await adminWs.op('addTeam', { projectId, name: '突显队' });
  await adminWs.op('assignTeam', { projectId, personId: person.id, teamId: team.teamId });
  await adminWs.op('setTeamCaptain', {
    projectId, teamId: team.teamId, personId: person.id,
  });
  const userRes = await api(admin, '/auth/users', {
    method: 'POST',
    body: JSON.stringify({
      username: 'display-member',
      password: MEMBER_PASSWORD,
      role: 'member',
      memberProjectId: projectId,
      memberPersonId: person.id,
    }),
  });
  const memberUser = userRes.json.data.user;
  const patchRes = await api(admin, `/projects/${projectId}/settings`, {
    method: 'PATCH',
    body: JSON.stringify({
      patch: {
        featureBuzzer: true,
        featureMemberConsole: true,
        featureCountdown: false,
        buzzTimerMode: 'prepare',
        buzzDurationSec: 2,
        buzzTarget: 'self',
        buzzScoreDelta: 0,
        buzzButtonMode: 'all',
        buzzRunButtonAction: false,
        buzzLoserHint: true,
        buzzStopTimerOnWin: true,
        memberMenus: [{
          userId: memberUser.id,
          enabled: true,
          columns: 2,
          gap: 16,
          buttons: [{
            id: 'buzz-1', label: '抢答', enabled: true, buzz: true,
            action: 'score', targetType: 'person', targetId: person.id,
            delta: 1, durationMs: 0, height: 120, fontSize: 28, radius: 16,
            color: '#e8a33d', textColor: '', image: '',
          }],
        }],
      },
    }),
  });
  assert.equal(patchRes.status, 200, '抢答设置失败');

  const cdpPort = await waitCdpPort(profile);
  assert.ok(cdpPort, 'Chromium 未启动');
  assert.ok(await waitUrl(`http://127.0.0.1:${cdpPort}/json/version`), 'CDP 未就绪');
  const tab = await (await fetch(
    `http://127.0.0.1:${cdpPort}/json/new?${BASE}/display-v2?project=${encodeURIComponent(projectId)}`,
    { method: 'PUT' },
  )).json();
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  let seq = 0;
  const pending = new Map();
  ws.on('message', (buf) => {
    const message = JSON.parse(String(buf));
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  t.after(() => ws.close());
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 800, deviceScaleFactor: 1, mobile: false,
  });
  const evalJs = async (expression) => {
    const res = await send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    });
    if (res.exceptionDetails) {
      throw new Error('页面脚本异常：' + JSON.stringify(res.exceptionDetails));
    }
    return res.result.value;
  };
  async function waitFor(expression, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await evalJs(`Boolean(${expression})`)) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  }

  assert.ok(
    await waitFor(
      `document.querySelector('.card[data-kind="person"], .member[data-person], .card[data-kind="team"]')`,
    ),
    '显示端渲染人员/团队卡片',
  );

  const startRes = await api(admin, `/projects/${projectId}/buzz/start`, {
    method: 'POST',
    body: '{}',
  });
  assert.equal(startRes.status, 200);
  assert.ok(
    await waitFor(`document.querySelector('.overlay-countdown, .countdown-big')`, 3000),
    '抢答准备期间即使 featureCountdown 关闭也显示计时器',
  );
  await new Promise((r) => setTimeout(r, 2600));
  const promptText = await evalJs(
    `document.querySelector('.overlay-countdown, .countdown-big')?.textContent || ''`,
  );
  assert.ok(promptText.includes('开始抢答'), '准备倒计时结束后显示开始抢答');
  assert.equal(
    await evalJs(`Boolean(document.querySelector('.overlay-countdown.is-buzz-start, .countdown-big.is-buzz-start'))`),
    true,
    '开始抢答提示沿用计时器样式',
  );

  const member = memberWs(await login('display-member', MEMBER_PASSWORD));
  t.after(() => member.close());
  await member.ready;
  const press = await member.op('buzzPress', { projectId, buttonId: 'buzz-1' });
  assert.equal(press.won, true);
  assert.ok(
    await waitFor(`document.querySelector('.spotlight-overlay.spotlight-locked')`, 4000),
    '赢家在独立显示端锁定突显',
  );
  const lockedText = await evalJs(
    `document.querySelector('.spotlight-overlay.spotlight-locked')?.textContent || ''`,
  );
  assert.ok(lockedText.includes('抢答甲'), '锁定突显包含赢家人员');
  assert.equal(
    await evalJs(`Boolean(document.querySelector('.overlay-countdown, .countdown-big'))`),
    false,
    '抢到后开始提示消失',
  );

  await api(admin, `/projects/${projectId}/buzz/end`, { method: 'POST', body: '{}' });
  assert.ok(
    await waitFor(`!document.querySelector('.spotlight-overlay.spotlight-locked')`, 3000),
    '结束抢答后锁定突显清除',
  );

  // 关闭「开始抢答」开关：倒计时结束后计时器直接关闭
  await api(admin, `/projects/${projectId}/settings`, {
    method: 'PATCH',
    body: JSON.stringify({ patch: { buzzShowStartPrompt: false } }),
  });
  await new Promise((r) => setTimeout(r, 300));
  await api(admin, `/projects/${projectId}/buzz/start`, { method: 'POST', body: '{}' });
  await new Promise((r) => setTimeout(r, 2600));
  assert.equal(
    await evalJs(`Boolean(document.querySelector('.overlay-countdown, .countdown-big'))`),
    false,
    '关闭开关后倒计时结束不显示开始提示',
  );
  await api(admin, `/projects/${projectId}/buzz/end`, { method: 'POST', body: '{}' });
  await new Promise((r) => setTimeout(r, 300));

  // 团队突显：团队卡片 / 队长卡片，不展开成员
  await api(admin, `/projects/${projectId}/spotlight`, {
    method: 'POST',
    body: JSON.stringify({ targetType: 'team', targetId: team.teamId, durationMs: 4000 }),
  });
  assert.ok(
    await waitFor(
      `[...document.querySelectorAll('.spotlight-overlay .spotlight-team-card .team-name')]
        .some((el) => el.textContent.trim() === '突显队')`,
    ),
    '团队突显显示团队名称+头像卡片',
  );
  assert.equal(
    await evalJs(`Boolean(document.querySelector('.spotlight-overlay .team-members'))`),
    false,
    '团队突显不展开成员',
  );

  await api(admin, `/projects/${projectId}/settings`, {
    method: 'PATCH',
    body: JSON.stringify({ patch: { teamSpotlightCard: 'captain' } }),
  });
  await new Promise((r) => setTimeout(r, 300));
  await api(admin, `/projects/${projectId}/spotlight`, {
    method: 'POST',
    body: JSON.stringify({ targetType: 'team', targetId: team.teamId, durationMs: 4000 }),
  });
  assert.ok(
    await waitFor(
      `[...document.querySelectorAll('.spotlight-overlay .spotlight-team-card .team-name')]
        .some((el) => el.textContent.trim() === '抢答甲')`,
    ),
    '队长卡片显示队长姓名',
  );
  assert.ok(
    await evalJs(
      `[...document.querySelectorAll('.spotlight-overlay .spotlight-team-card .team-spotlight-caption')]
        .some((el) => el.textContent.includes('突显队'))`,
    ),
    '队长卡片显示团队名称',
  );
});
