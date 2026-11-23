// 抢答模式：设置、权限、计时器、首个抢答与锁定突显
// 运行: node --test scripts/buzz-mode.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { OPS } = require(path.join(ROOT, 'server/ops'));
const { OP_MIN_ROLE, canOp } = require(path.join(ROOT, 'server/auth/policy'));
const {
  DEFAULT_SETTINGS,
  SETTINGS_VALIDATORS,
  normalizeMemberMenuButton,
} = require(path.join(ROOT, 'server/settings'));

function validButton(overrides = {}) {
  return {
    id: 'buzz-1',
    label: '抢答',
    enabled: true,
    buzz: true,
    action: 'score',
    targetType: 'person',
    targetId: 'p_1',
    delta: 1,
    durationMs: 0,
    height: 120,
    fontSize: 28,
    radius: 16,
    color: '#e8a33d',
    textColor: '',
    image: '',
    ...overrides,
  };
}

test('抢答设置默认值与权限契约', () => {
  assert.equal(DEFAULT_SETTINGS.featureBuzzer, false);
  assert.equal(DEFAULT_SETTINGS.buzzTimerMode, 'prepare');
  assert.equal(DEFAULT_SETTINGS.buzzDurationSec, 10);
  assert.equal(DEFAULT_SETTINGS.buzzTarget, 'self');
  assert.equal(DEFAULT_SETTINGS.buzzScoreDelta, 0);
  assert.equal(DEFAULT_SETTINGS.buzzButtonMode, 'all');
  assert.equal(DEFAULT_SETTINGS.buzzRunButtonAction, false);
  assert.equal(DEFAULT_SETTINGS.buzzLoserHint, true);
  assert.equal(DEFAULT_SETTINGS.buzzStopTimerOnWin, true);

  assert.ok(Object.prototype.hasOwnProperty.call(OPS, 'buzzStart'));
  assert.ok(Object.prototype.hasOwnProperty.call(OPS, 'buzzEnd'));
  assert.ok(Object.prototype.hasOwnProperty.call(OPS, 'buzzPress'));
  assert.equal(OP_MIN_ROLE.buzzStart, 'admin');
  assert.equal(OP_MIN_ROLE.buzzEnd, 'admin');
  assert.equal(OP_MIN_ROLE.buzzPress, 'member');
  assert.equal(canOp('member', 'buzzPress'), true);
  assert.equal(canOp('member', 'buzzStart'), false);
  assert.equal(canOp('viewer', 'buzzPress'), false);
});

test('抢答设置校验：合法值与非法值', () => {
  const v = SETTINGS_VALIDATORS;
  assert.equal(v.buzzTimerMode('prepare'), 'prepare');
  assert.equal(v.buzzTimerMode('window'), 'window');
  assert.equal(v.buzzDurationSec(10), 10);
  assert.equal(v.buzzDurationSec(3600), 3600);
  assert.equal(v.buzzTarget('self'), 'self');
  assert.equal(v.buzzTarget('team'), 'team');
  assert.equal(v.buzzScoreDelta(0), 0);
  assert.equal(v.buzzScoreDelta(10000), 10000);
  assert.equal(v.buzzButtonMode('all'), 'all');
  assert.equal(v.buzzButtonMode('marked'), 'marked');
  assert.equal(v.buzzRunButtonAction(true), true);
  assert.equal(v.buzzLoserHint(false), false);
  assert.equal(v.buzzStopTimerOnWin(true), true);

  assert.throws(() => v.buzzTimerMode('later'), /计时器模式/);
  assert.throws(() => v.buzzDurationSec(0), /倒计时时长/);
  assert.throws(() => v.buzzDurationSec(3601), /倒计时时长/);
  assert.throws(() => v.buzzTarget('other'), /突显目标/);
  assert.throws(() => v.buzzScoreDelta(-1), /加分/);
  assert.throws(() => v.buzzScoreDelta(10001), /加分/);
  assert.throws(() => v.buzzButtonMode('some'), /按钮范围/);
  assert.throws(() => v.buzzRunButtonAction('yes'), /布尔/);
});

test('人员菜单按钮 buzz 字段缺省为 true', () => {
  const without = validButton();
  delete without.buzz;
  assert.equal(normalizeMemberMenuButton(without).buzz, true);
  assert.equal(normalizeMemberMenuButton(validButton({ buzz: false })).buzz, false);
  assert.throws(
    () => normalizeMemberMenuButton(validButton({ buzz: 'yes' })),
    /布尔/,
  );
});

test('抢答界面与显示端接线契约', () => {
  const memberSrc = readFileSync(
    path.join(ROOT, 'web/src/admin/components/MemberConsole.tsx'), 'utf8',
  );
  const previewSrc = readFileSync(
    path.join(ROOT, 'web/src/admin/components/PreviewPanel.tsx'), 'utf8',
  );
  const dialogSrc = readFileSync(
    path.join(ROOT, 'web/src/admin/components/MemberMenuDialog.tsx'), 'utf8',
  );
  const appSrc = readFileSync(
    path.join(ROOT, 'web/src/display/App.tsx'), 'utf8',
  );
  const coreSrc = readFileSync(
    path.join(ROOT, 'web/src/display/lib/core.ts'), 'utf8',
  );
  const overlaySrc = readFileSync(
    path.join(ROOT, 'web/src/display/components/Overlays.tsx'), 'utf8',
  );
  const displayCss = readFileSync(
    path.join(ROOT, 'public/display.css'), 'utf8',
  );

  assert.ok(memberSrc.includes("'buzzPress'"), '队员端发送 buzzPress');
  assert.ok(memberSrc.includes('member-buzz-banner'), '队员端显示抢答横幅');
  assert.ok(previewSrc.includes('开始抢答') && previewSrc.includes('结束抢答'), '预览面板有开始/结束按钮');
  assert.ok(previewSrc.includes("'buzzStart'") && previewSrc.includes("'buzzEnd'"), '预览面板调用抢答 op');
  assert.ok(dialogSrc.includes('抢答模式'), '人员菜单包含抢答设置');
  assert.ok(dialogSrc.includes('buzzTimerMode') && dialogSrc.includes('buzzScoreDelta'), '抢答规则可配');
  assert.ok(dialogSrc.includes('参与抢答'), '按钮可配置是否参与抢答');
  assert.ok(appSrc.includes('runtime?.buzz') && appSrc.includes('spawnPersistentSpotlight'), '显示端消费锁定赢家');
  assert.ok(appSrc.includes('clearPersistentSpotlights'), '结束抢答清除锁定突显');
  assert.ok(coreSrc.includes('clearPersistentSpotlights') && coreSrc.includes('persistent'), '锁定突显独立注册');
  assert.ok(overlaySrc.includes('force'), '抢答期间强制显示计时器');
  assert.ok(displayCss.includes('spotlight-locked'), '锁定突显层级样式存在');
});

// ---------- 集成测试 ----------
const { spawn } = await import('node:child_process');
const { mkdtempSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const WebSocket = require('ws');

const PORT = 3481;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_PASSWORD = 'test-admin-pass';
const MEMBER_PASSWORD = 'member-pass-1';
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

function startServer(dataDir) {
  return spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, ...AUTH_ENV, PORT: String(PORT), DATA_DIR: dataDir, LOG_LEVEL: 'error' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function stopServer(proc) {
  if (!proc || proc.exitCode !== null) return;
  const exited = new Promise((resolve) => proc.once('exit', resolve));
  proc.kill('SIGTERM');
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
}

async function waitHealth() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(BASE + '/api/health');
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
  return { cookie: pairs.join('; '), csrf: find('ssb_csrf') };
}

async function login(username, password) {
  const res = await fetch(BASE + '/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(res.status, 200, '登录应成功：' + username);
  return sessionFromResponse(res);
}

async function api(session, pathname, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const headers = {
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(options.headers || {}),
  };
  if (session) {
    headers.Cookie = session.cookie;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) headers['X-CSRF-Token'] = session.csrf;
  }
  const res = await fetch(BASE + '/api/v1' + pathname, { ...options, headers });
  let json = null;
  try { json = await res.json(); } catch (_) { /* empty */ }
  return { status: res.status, json };
}

function wsClient(session) {
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
      const reqId = 'b' + ++seq;
      pending.set(reqId, { resolve, reject });
      ws.send(JSON.stringify({ type: 'op', reqId, op, payload }));
    }),
  };
}

async function getState() {
  const res = await fetch(BASE + '/api/state');
  return res.json();
}

async function waitRuntime(predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await getState();
    if (predicate(state.runtime || {})) return state.runtime;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('等待运行态超时');
}

function buzzButton(overrides = {}) {
  return {
    id: 'buzz-1', label: '抢答', enabled: true, buzz: true,
    action: 'score', targetType: 'person', targetId: 'p_1',
    delta: 1, durationMs: 0, height: 120, fontSize: 28, radius: 16,
    color: '#e8a33d', textColor: '', image: '',
    ...overrides,
  };
}

test('抢答：准备计时、第一个获胜、锁定保留直到结束', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'sb-buzz-'));
  const server = startServer(dataDir);
  const clients = [];
  try {
    await waitHealth();
    const adminSession = await login('admin', ADMIN_PASSWORD);
    const admin = wsClient(adminSession);
    clients.push(admin);
    await admin.ready;

    let state = await getState();
    let projectId = Object.keys(state.projects)[0];
    if (!projectId) {
      projectId = (await admin.op('addProject', { name: '抢答测试项目' })).projectId;
    }
    const personA = (await admin.op('addPerson', { projectId, name: '甲' })).personId;
    const personB = (await admin.op('addPerson', { projectId, name: '乙' })).personId;
    const team = await admin.op('addTeam', { projectId, name: '甲队' });
    await admin.op('assignTeam', { projectId, personId: personA, teamId: team.teamId });

    const create = (body) => api(adminSession, '/auth/users', {
      method: 'POST', body: JSON.stringify(body),
    });
    const u1 = (await create({
      username: 'member1', password: MEMBER_PASSWORD, role: 'member',
      memberProjectId: projectId, memberPersonId: personA,
    })).json.data.user;
    const u2 = (await create({
      username: 'member2', password: MEMBER_PASSWORD, role: 'member',
      memberProjectId: projectId, memberPersonId: personB,
    })).json.data.user;

    const menu = (userId) => ({
      userId, enabled: true, columns: 2, gap: 16,
      buttons: [buzzButton({ targetId: personA })],
    });
    await admin.op('updateSettings', {
      projectId,
      patch: {
        featureBuzzer: true,
        featureMemberConsole: true,
        featureCountdown: false,
        memberMenus: [menu(u1.id), menu(u2.id)],
        buzzTimerMode: 'prepare',
        buzzDurationSec: 1,
        buzzTarget: 'self',
        buzzScoreDelta: 0,
        buzzButtonMode: 'all',
        buzzRunButtonAction: false,
        buzzLoserHint: true,
        buzzStopTimerOnWin: true,
      },
    });

    const s1 = await login('member1', MEMBER_PASSWORD);
    const s2 = await login('member2', MEMBER_PASSWORD);
    const m1 = wsClient(s1);
    const m2 = wsClient(s2);
    clients.push(m1, m2);
    await Promise.all([m1.ready, m2.ready]);

    const started = await admin.op('buzzStart', { projectId });
    assert.equal(started.mode, 'prepare');
    assert.equal(started.phase, 'prepare');
    let runtime = await waitRuntime((r) => r.buzz?.[projectId]);
    assert.equal(runtime.buzz[projectId].phase, 'prepare');
    assert.equal(runtime.countdowns[projectId].state, 'running');
    assert.equal(runtime.countdowns[projectId].durationMs, 1000);

    const early = await m1.op('buzzPress', { projectId, buttonId: 'buzz-1' });
    assert.deepEqual(early, { won: false, reason: 'prepare' });

    runtime = await waitRuntime((r) => r.buzz?.[projectId]?.phase === 'open');
    assert.ok(!runtime.countdowns[projectId], '准备倒计时结束后计时器关闭');
    assert.equal(runtime.buzz[projectId].winner, null);

    const [r1, r2] = await Promise.all([
      m1.op('buzzPress', { projectId, buttonId: 'buzz-1' }),
      m2.op('buzzPress', { projectId, buttonId: 'buzz-1' }),
    ]);
    const wins = [r1, r2].filter((r) => r.won);
    const losses = [r1, r2].filter((r) => !r.won);
    assert.equal(wins.length, 1, '只有第一个抢答成功');
    assert.equal(losses.length, 1);
    assert.equal(losses[0].reason, 'taken');
    const winner = wins[0].winner;
    assert.ok(winner.personId === personA || winner.personId === personB);

    runtime = await waitRuntime((r) => r.buzz?.[projectId]?.winner);
    assert.equal(runtime.buzz[projectId].winner.personId, winner.personId);
    assert.equal(runtime.buzz[projectId].phase, 'open');

    await assert.rejects(
      m1.op('memberAction', { projectId, buttonId: 'buzz-1' }),
      /抢答进行中/,
    );

    await new Promise((r) => setTimeout(r, 300));
    runtime = (await getState()).runtime;
    assert.equal(runtime.buzz[projectId].winner.personId, winner.personId, '赢家持续保留');

    await admin.op('buzzEnd', { projectId });
    runtime = await waitRuntime((r) => !r.buzz?.[projectId]);
    assert.ok(!runtime.countdowns[projectId], '结束抢答清空计时器');
  } finally {
    for (const client of clients) { try { client.close(); } catch (_) {} }
    await stopServer(server);
  }
});

test('抢答：window 模式抢到即锁定；team 目标与规则生效', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'sb-buzz-window-'));
  const server = startServer(dataDir);
  const clients = [];
  try {
    await waitHealth();
    const adminSession = await login('admin', ADMIN_PASSWORD);
    const admin = wsClient(adminSession);
    clients.push(admin);
    await admin.ready;

    const state = await getState();
    let projectId = Object.keys(state.projects)[0];
    if (!projectId) {
      projectId = (await admin.op('addProject', { name: '抢答窗口项目' })).projectId;
    }
    const personA = (await admin.op('addPerson', { projectId, name: '甲' })).personId;
    const team = await admin.op('addTeam', { projectId, name: '甲队' });
    await admin.op('assignTeam', { projectId, personId: personA, teamId: team.teamId });
    const created = await api(adminSession, '/auth/users', {
      method: 'POST',
      body: JSON.stringify({
        username: 'member1', password: MEMBER_PASSWORD, role: 'member',
        memberProjectId: projectId, memberPersonId: personA,
      }),
    });
    const user = created.json.data.user;
    await admin.op('updateSettings', {
      projectId,
      patch: {
        featureBuzzer: true,
        featureMemberConsole: true,
        memberMenus: [{
          userId: user.id, enabled: true, columns: 2, gap: 16,
          buttons: [
            buzzButton({ targetId: personA, delta: 3 }),
            buzzButton({ id: 'no-buzz', label: '不抢答', buzz: false, targetId: personA }),
          ],
        }],
        buzzTimerMode: 'window',
        buzzDurationSec: 5,
        buzzTarget: 'team',
        buzzScoreDelta: 2,
        buzzButtonMode: 'marked',
        buzzRunButtonAction: true,
        buzzLoserHint: false,
        buzzStopTimerOnWin: true,
      },
    });

    const session = await login('member1', MEMBER_PASSWORD);
    const member = wsClient(session);
    clients.push(member);
    await member.ready;

    let started = await admin.op('buzzStart', { projectId });
    assert.equal(started.phase, 'open');

    const notBuzz = await member.op('buzzPress', { projectId, buttonId: 'no-buzz' });
    assert.deepEqual(notBuzz, { won: false, reason: 'not-buzz-button' });

    const result = await member.op('buzzPress', { projectId, buttonId: 'buzz-1' });
    assert.equal(result.won, true);
    assert.equal(result.winner.targetType, 'team');
    assert.equal(result.winner.targetId, team.teamId);
    let runtime = await waitRuntime((r) => r.buzz?.[projectId]?.phase === 'locked');
    assert.ok(!runtime.countdowns[projectId], '抢到后立即关闭计时器');
    assert.equal(runtime.buzz[projectId].winner.personId, personA);

    const after = await getState();
    const project = after.projects[projectId];
    const members = Object.values(project.people).filter((p) => p.teamId === team.teamId);
    assert.ok(members.length >= 1);
    assert.equal(members[0].score, 2 + 3, '抢答加分 + 按钮原加分动作');

    await admin.op('buzzEnd', { projectId });
    runtime = await waitRuntime((r) => !r.buzz?.[projectId]);
    assert.ok(!runtime.countdowns[projectId]);

    // 关闭总开关后不能再开始
    await admin.op('updateSettings', { projectId, patch: { featureBuzzer: false } });
    await assert.rejects(
      admin.op('buzzStart', { projectId }),
      /未开启/,
    );
  } finally {
    for (const client of clients) { try { client.close(); } catch (_) {} }
    await stopServer(server);
  }
});
