// 队员控制台：角色、绑定、按队员菜单、专用 op 与执行边界
// 运行: node --test scripts/member-console.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { OPS } = require(path.join(ROOT, 'server/ops'));
const {
  ROLES,
  ROLE_RANK,
  ROLE_LABELS,
  OP_MIN_ROLE,
  canOp,
  roleAtLeast,
} = require(path.join(ROOT, 'server/auth/policy'));
const {
  DEFAULT_SETTINGS,
  SETTINGS_VALIDATORS,
  normalizeMemberMenuButton,
  normalizeMemberMenuConfig,
} = require(path.join(ROOT, 'server/settings'));

function validButton(overrides = {}) {
  return {
    id: 'vote-1',
    label: '投票',
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

function validMenu(overrides = {}) {
  return {
    userId: 'u_1',
    enabled: true,
    columns: 2,
    gap: 16,
    buttons: [validButton()],
    ...overrides,
  };
}

test('member 角色与专用 op 契约', () => {
  assert.ok(ROLES.includes('member'));
  assert.equal(ROLE_RANK.member, 15);
  assert.equal(ROLE_LABELS.member, '队员');
  assert.equal(OP_MIN_ROLE.memberAction, 'member');
  assert.equal(canOp('member', 'memberAction'), true);
  assert.equal(canOp('member', 'addScore'), false);
  assert.equal(canOp('member', 'triggerSpotlight'), false);
  assert.equal(canOp('member', 'updateSettings'), false);
  assert.equal(roleAtLeast('member', 'viewer'), true);
  assert.equal(roleAtLeast('member', 'operator'), false);
  assert.ok(Object.prototype.hasOwnProperty.call(OPS, 'memberAction'));
});

test('人员菜单设置默认值', () => {
  assert.equal(DEFAULT_SETTINGS.featureMemberConsole, true);
  assert.equal(DEFAULT_SETTINGS.memberButtonsPaused, false);
  assert.deepEqual(DEFAULT_SETTINGS.memberMenus, []);
});

test('按钮 onlyDuringBuzz：默认 false，非法值拒绝', () => {
  assert.equal(normalizeMemberMenuButton(validButton()).onlyDuringBuzz, false);
  assert.equal(
    normalizeMemberMenuButton(validButton({ onlyDuringBuzz: true })).onlyDuringBuzz,
    true,
  );
  assert.equal(
    SETTINGS_VALIDATORS.memberButtonsPaused(true),
    true,
  );
  assert.throws(() => SETTINGS_VALIDATORS.memberButtonsPaused('yes'), /布尔/);
  assert.throws(
    () => normalizeMemberMenuButton(validButton({ onlyDuringBuzz: 'yes' })),
    /布尔/,
  );
});

test('人员菜单按钮支持小数分值并保留两位', () => {
  assert.equal(normalizeMemberMenuButton(validButton({ delta: 0.5 })).delta, 0.5);
  assert.equal(normalizeMemberMenuButton(validButton({ delta: -1.25 })).delta, -1.25);
  assert.equal(normalizeMemberMenuButton(validButton({ delta: 0.555 })).delta, 0.56);
  assert.throws(
    () => normalizeMemberMenuButton(validButton({ delta: 0.001 })),
    /非 0 数字/,
  );
});

test('按队员菜单校验：合法值与缺省字段', () => {
  const missingEnabled = validButton();
  delete missingEnabled.enabled;
  const out = SETTINGS_VALIDATORS.memberMenus([
    validMenu({ buttons: [missingEnabled] }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].userId, 'u_1');
  assert.equal(out[0].enabled, true);
  assert.equal(out[0].columns, 2);
  assert.equal(out[0].gap, 16);
  assert.equal(out[0].buttons[0].enabled, true);
});

test('按队员菜单校验：拒绝非法结构', () => {
  const invalid = [
    'not-array',
    Array.from({ length: 201 }, (_, i) => validMenu({ userId: 'u' + i })),
    [validMenu(), validMenu()],
    [validMenu({ columns: 0 })],
    [validMenu({ columns: 5 })],
    [validMenu({ gap: 49 })],
    [validMenu({ buttons: [validButton({ label: '   ' })] })],
    [validMenu({ buttons: [validButton({ action: 'delete' })] })],
    [validMenu({ buttons: [validButton({ targetType: 'group' })] })],
    [validMenu({ buttons: [validButton({ targetId: '' })] })],
    [validMenu({ buttons: [validButton({ delta: 0 })] })],
    [validMenu({ buttons: [validButton({ delta: 10001 })] })],
    [validMenu({ buttons: [validButton({ height: 55 })] })],
    [validMenu({ buttons: [validButton({ fontSize: 97 })] })],
    [validMenu({ buttons: [validButton({ radius: 49 })] })],
    [validMenu({ buttons: [validButton({ color: 'red' })] })],
    [validMenu({ buttons: [validButton({ textColor: '#fff' })] })],
    [validMenu({ buttons: [validButton({ image: 'data:image/png;base64,AAAA' })] })],
    [validMenu({ buttons: [validButton({ durationMs: 10001 })] })],
  ];
  for (const value of invalid) {
    assert.throws(
      () => SETTINGS_VALIDATORS.memberMenus(value),
      /按钮|人员菜单|数组|id|标题|头像|列数|间距|账号|重复/,
      '应拒绝：' + JSON.stringify(value).slice(0, 80),
    );
  }
});

test('人员菜单 fillMode 默认 none，可设为 adaptive', () => {
  const off = SETTINGS_VALIDATORS.memberMenus([validMenu()]);
  assert.equal(off[0].fillMode, 'none');
  const on = SETTINGS_VALIDATORS.memberMenus([validMenu({ fillMode: 'adaptive' })]);
  assert.equal(on[0].fillMode, 'adaptive');
  assert.throws(
    () => SETTINGS_VALIDATORS.memberMenus([validMenu({ fillMode: 'stretch' })]),
    /铺满模式/,
  );
});

test('normalizeMemberMenuConfig 丢弃未知字段并保留固定字段', () => {
  const out = normalizeMemberMenuConfig(validMenu({ extra: 'x' }));
  assert.equal(out.extra, undefined);
  assert.equal(out.userId, 'u_1');
  assert.equal(out.buttons[0].id, 'vote-1');
  const button = normalizeMemberMenuButton(validButton({ extra: 'x' }));
  assert.equal(button.extra, undefined);
});

test('队员端预览与真实界面共用组件与样式，显示端显式跳过', () => {
  const consoleSrc = readFileSync(
    path.join(ROOT, 'web/src/admin/components/MemberConsole.tsx'), 'utf8',
  );
  const dialogSrc = readFileSync(
    path.join(ROOT, 'web/src/admin/components/MemberMenuDialog.tsx'), 'utf8',
  );
  const coreSrc = readFileSync(
    path.join(ROOT, 'web/src/display/lib/core.ts'), 'utf8',
  );
  const cssSrc = readFileSync(
    path.join(ROOT, 'public/admin.css'), 'utf8',
  );
  assert.ok(consoleSrc.includes('export function MemberConsoleView'), '真实界面导出展示层');
  assert.ok(consoleSrc.includes("from '../../shared/member-menu'"), '真实界面使用共享按钮样式');
  assert.ok(consoleSrc.includes('memberMenus'), '真实界面按账号查找菜单');
  assert.ok(dialogSrc.includes("import { MemberConsoleView } from './MemberConsole'"), '预览复用真实展示层');
  assert.ok(dialogSrc.includes('<MemberConsoleView'), '预览实际渲染真实展示层');
  assert.ok(dialogSrc.includes('defaultWidth={1280}'), '人员菜单使用可拖动窗口而非全屏');
  assert.ok(!dialogSrc.includes('fullscreen'), '人员菜单不再强制全屏');
  assert.ok(
    cssSrc.includes('.settings-dialog .settings-form > .member-menu-dialog')
      && cssSrc.includes('grid-column: 1 / -1;'),
    '人员菜单占满设置内容区整行，避免编辑区被挤成一条',
  );
  const numberInputSrc = readFileSync(
    path.join(ROOT, 'web/src/admin/components/NumberInput.tsx'), 'utf8',
  );
  assert.ok(consoleSrc.includes('fillMode') && consoleSrc.includes("=== 'adaptive'"), '单按钮支持自适应铺满');
  assert.ok(dialogSrc.includes('铺满屏幕') && dialogSrc.includes('自适应'), '管理端提供自适应铺满模式');
  assert.ok(!dialogSrc.includes('member-display-preview'), '人员菜单不再内嵌大屏预览');
  assert.ok(
    dialogSrc.includes("from './NumberInput'")
      && (dialogSrc.match(/<NumberInput/g) || []).length >= 5,
    '人员菜单滑条同时提供手动数字输入',
  );
  assert.ok(
    numberInputSrc.includes('type="number"') && numberInputSrc.includes('onBlur'),
    '数字输入支持逐字输入并在失焦时夹紧',
  );
  assert.ok(cssSrc.includes('.member-grid.is-fill'), '铺满样式存在');
  const previewSrc = readFileSync(
    path.join(ROOT, 'web/src/admin/components/PreviewPanel.tsx'), 'utf8',
  );
  assert.ok(
    previewSrc.includes("from './NumberInput'") && previewSrc.includes('<NumberInput'),
    '预览缩放滑条支持手动输入',
  );
  assert.ok(
    previewSrc.includes('function CountdownBar')
      && previewSrc.includes('preview-countdown')
      && previewSrc.includes("'countdownStart'"),
    '显示端预览包含计时器控制条',
  );
  assert.ok(
    previewSrc.includes('function MemberControls')
      && previewSrc.includes('暂停所有队员按钮')
      && previewSrc.includes('停用所有队员账号')
      && previewSrc.includes('setMembersDisabled'),
    '显示端预览提供队员按钮暂停与账号批量停用入口',
  );
  assert.ok(
    consoleSrc.includes('memberButtonsPaused') && consoleSrc.includes('onlyDuringBuzz'),
    '队员端消费暂停状态与仅抢答时启用设置',
  );
  assert.ok(
    consoleSrc.includes('const dimmed')
      && consoleSrc.includes("dimmed ? ' is-disabled'"),
    '仅抢答时启用的按钮在无抢答时显式置灰',
  );
  assert.ok(
    dialogSrc.includes('仅抢答时启用'),
    '人员菜单按钮可配置仅抢答时启用',
  );
  assert.ok(coreSrc.includes('void s.memberMenus'), '显示端显式跳过管理端专用设置');
});

// ---------- 集成测试脚手架 ----------
const PORT = 3480;
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
  const states = [];
  const pending = new Map();
  let seq = 0;
  const ready = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
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
    states,
    close: () => ws.close(),
    waitState: async (predicate) => {
      for (let i = 0; i < 80; i += 1) {
        const found = [...states].reverse().find(predicate);
        if (found) return found;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error('等待 WS 状态超时');
    },
    op: (op, payload) => new Promise((resolve, reject) => {
      const reqId = 'm' + ++seq;
      pending.set(reqId, { resolve, reject });
      ws.send(JSON.stringify({ type: 'op', reqId, op, payload }));
    }),
  };
}

async function getState() {
  const res = await fetch(BASE + '/api/state');
  return res.json();
}

async function waitBuzzPhase(projectId, phase, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await getState();
    const buzz = state.runtime && state.runtime.buzz ? state.runtime.buzz[projectId] : null;
    if (buzz && buzz.phase === phase) return buzz;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('等待抢答阶段超时：' + phase);
}

test('队员绑定与逐人菜单：只能执行自己账号的配置按钮', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'sb-member-'));
  let server = startServer(dataDir);
  const adminWs = [];
  const memberWs = [];
  try {
    await waitHealth();
    const adminSession = await login('admin', ADMIN_PASSWORD);
    const admin = wsClient(adminSession);
    adminWs.push(admin);
    await admin.ready;

    const snapshot = await getState();
    let projectId = Object.keys(snapshot.projects)[0];
    if (!projectId) {
      projectId = (await admin.op('addProject', { name: '测试项目' })).projectId;
    }
    assert.ok(projectId);
    const added = await admin.op('addPerson', { projectId, name: '小明' });
    const personId = added.personId;
    assert.ok(personId);
    const secondProject = await admin.op('addProject', { name: '第二项目' });

    const create = (body) => api(adminSession, '/auth/users', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    const created = await create({
      username: 'member1',
      password: MEMBER_PASSWORD,
      role: 'member',
      memberProjectId: projectId,
      memberPersonId: personId,
    });
    assert.ok(created.status === 200 || created.status === 201, JSON.stringify(created.json));
    const memberUser = created.json.data.user;
    assert.equal(memberUser.role, 'member');
    assert.equal(memberUser.memberProjectId, projectId);
    assert.equal(memberUser.memberPersonId, personId);

    const created2 = await create({
      username: 'member2',
      password: MEMBER_PASSWORD,
      role: 'member',
      memberProjectId: projectId,
      memberPersonId: personId,
    });
    assert.ok(created2.status === 200 || created2.status === 201);
    const memberUser2 = created2.json.data.user;

    const unbound = await create({
      username: 'member3',
      password: MEMBER_PASSWORD,
      role: 'member',
    });
    assert.equal(unbound.status, 400, '队员必须绑定项目与人员');

    const badPerson = await create({
      username: 'member4',
      password: MEMBER_PASSWORD,
      role: 'member',
      memberProjectId: projectId,
      memberPersonId: 'nope',
    });
    assert.equal(badPerson.status, 400, '绑定人员必须存在');

    const operator = await create({
      username: 'op1',
      password: MEMBER_PASSWORD,
      role: 'operator',
    });
    assert.ok(operator.status === 200 || operator.status === 201);
    const promote = await api(adminSession, '/auth/users/' + operator.json.data.user.id, {
      method: 'PATCH',
      body: JSON.stringify({ role: 'member' }),
    });
    assert.equal(promote.status, 400, '改为队员时必须提供绑定');

    await admin.op('updateSettings', {
      projectId,
      patch: {
        featureMemberConsole: true,
        featureBuzzer: true,
        buzzTimerMode: 'prepare',
        buzzDurationSec: 1,
        buzzButtonMode: 'all',
        memberMenus: [{
          userId: memberUser.id,
          enabled: true,
          columns: 2,
          gap: 16,
          buttons: [
            validButton({ id: 'vote-1', targetId: personId, delta: 1 }),
            validButton({
              id: 'show-1', label: '突显', action: 'spotlight', targetId: personId, delta: 0,
            }),
            validButton({ id: 'off-1', label: '停用', enabled: false, targetId: personId }),
            validButton({
              id: 'session-1',
              label: '抢答投票',
              onlyDuringBuzz: true,
              buzz: false,
              targetId: personId,
              delta: 2,
            }),
          ],
        }],
      },
    });

    const memberSession = await login('member1', MEMBER_PASSWORD);
    const me = await api(memberSession, '/auth/me');
    assert.equal(me.json.data.user.role, 'member');
    assert.equal(me.json.data.user.memberProjectId, projectId);
    const member = wsClient(memberSession);
    memberWs.push(member);
    await member.ready;

    const result = await member.op('memberAction', { projectId, buttonId: 'vote-1' });
    assert.equal(result.action, 'score');
    let state = await getState();
    assert.equal(state.projects[projectId].people[personId].score, 1);

    const showResult = await member.op('memberAction', { projectId, buttonId: 'show-1' });
    assert.equal(showResult.action, 'spotlight');
    state = await getState();
    assert.equal(state.projects[projectId].people[personId].score, 1, '突显不改分数');

    await assert.rejects(
      member.op('addScore', { projectId, personId, delta: 99 }),
      /没有权限/,
    );
    await assert.rejects(
      member.op('triggerSpotlight', { projectId, targetType: 'person', targetId: personId }),
      /没有权限/,
    );
    await assert.rejects(
      member.op('updateSettings', { projectId, patch: { title: 'x' } }),
      /没有权限/,
    );
    await assert.rejects(
      member.op('memberAction', { projectId, buttonId: 'nope' }),
      /按钮不存在/,
    );
    await assert.rejects(
      member.op('memberAction', { projectId, buttonId: 'off-1' }),
      /已停用/,
    );
    await assert.rejects(
      member.op('memberAction', { projectId: secondProject.projectId, buttonId: 'vote-1' }),
      /未绑定当前项目/,
    );

    const injected = await member.op('memberAction', {
      projectId, buttonId: 'vote-1', delta: 9999, targetId: 'other', action: 'score',
    });
    assert.equal(injected.action, 'score', '额外字段不应导致失败，但也不会生效');
    state = await getState();
    assert.equal(state.projects[projectId].people[personId].score, 2, '注入字段应被忽略');

    // 第二个队员没有菜单，不能借用第一个队员的按钮
    const member2Session = await login('member2', MEMBER_PASSWORD);
    const member2 = wsClient(member2Session);
    memberWs.push(member2);
    await member2.ready;
    await assert.rejects(
      member2.op('memberAction', { projectId, buttonId: 'vote-1' }),
      /尚未为该账号配置/,
    );

    // 直接调用记分 REST / 设置也必须是 403；专用 REST 路由可用
    const restScore = await api(memberSession, `/projects/${projectId}/people/${personId}/score/add`, {
      method: 'POST',
      body: JSON.stringify({ delta: 5 }),
    });
    assert.equal(restScore.status, 403);
    const restSettings = await api(memberSession, `/projects/${projectId}/settings`, {
      method: 'PATCH',
      body: JSON.stringify({ patch: { title: 'x' } }),
    });
    assert.equal(restSettings.status, 403);
    const restAction = await api(memberSession, `/projects/${projectId}/member-action`, {
      method: 'POST',
      body: JSON.stringify({ buttonId: 'vote-1' }),
    });
    assert.equal(restAction.status, 200, JSON.stringify(restAction.json));
    state = await getState();
    assert.equal(state.projects[projectId].people[personId].score, 3);

    // 一键暂停：服务端同时拒绝普通动作与抢答按下
    await admin.op('updateSettings', { projectId, patch: { memberButtonsPaused: true } });
    await assert.rejects(
      member.op('memberAction', { projectId, buttonId: 'vote-1' }),
      /暂停所有队员按钮/,
    );
    await admin.op('updateSettings', { projectId, patch: { memberButtonsPaused: false } });

    // 仅抢答时启用：未开始抢答时不可用
    await assert.rejects(
      member.op('memberAction', { projectId, buttonId: 'session-1' }),
      /仅在抢答时可用/,
    );

    const started = await admin.op('buzzStart', { projectId });
    assert.equal(started.phase, 'prepare');
    await assert.rejects(
      member.op('memberAction', { projectId, buttonId: 'session-1' }),
      /仅在抢答时可用|尚未开放/,
      '准备倒计时期间不开放投票按钮',
    );
    await waitBuzzPhase(projectId, 'open');
    const sessionResult = await member.op('memberAction', { projectId, buttonId: 'session-1' });
    assert.equal(sessionResult.action, 'score');
    state = await getState();
    assert.equal(state.projects[projectId].people[personId].score, 5, '抢答开放期间投票按钮执行原动作');

    await assert.rejects(
      member.op('memberAction', { projectId, buttonId: 'vote-1' }),
      /请使用抢答按钮/,
      '参与抢答的按钮在抢答期间仍只能走 buzzPress',
    );
    const sessionBuzz = await member.op('buzzPress', { projectId, buttonId: 'session-1' });
    assert.deepEqual(sessionBuzz, { won: false, reason: 'not-buzz-button' });

    await admin.op('updateSettings', { projectId, patch: { memberButtonsPaused: true } });
    const pausedPress = await member.op('buzzPress', { projectId, buttonId: 'vote-1' });
    assert.deepEqual(pausedPress, { won: false, reason: 'paused' });
    await admin.op('updateSettings', { projectId, patch: { memberButtonsPaused: false } });
    await admin.op('buzzEnd', { projectId });

    // 全局批量停用/启用队员账号
    const nonBoolean = await api(adminSession, '/auth/users/members/disabled', {
      method: 'POST',
      body: JSON.stringify({ disabled: 'yes' }),
    });
    assert.equal(nonBoolean.status, 422, '非法 disabled 被拒绝');
    const memberForbidden = await api(memberSession, '/auth/users/members/disabled', {
      method: 'POST',
      body: JSON.stringify({ disabled: true }),
    });
    assert.equal(memberForbidden.status, 403, '队员不能批量停用账号');
    const disabledAll = await api(adminSession, '/auth/users/members/disabled', {
      method: 'POST',
      body: JSON.stringify({ disabled: true }),
    });
    assert.equal(disabledAll.status, 200, JSON.stringify(disabledAll.json));
    assert.ok(disabledAll.json.data.count >= 2);
    assert.equal(disabledAll.json.data.disabled, true);
    const afterDisable = await api(memberSession, '/auth/me');
    assert.equal(afterDisable.status, 401, '停用后旧会话立即失效');
    const enabledAll = await api(adminSession, '/auth/users/members/disabled', {
      method: 'POST',
      body: JSON.stringify({ disabled: false }),
    });
    assert.equal(enabledAll.status, 200);
    assert.ok(enabledAll.json.data.count >= 2);

    // 重启后绑定与菜单配置都应恢复
    for (const ws of [...adminWs, ...memberWs]) { try { ws.close(); } catch (_) {} }
    await stopServer(server);
    server = startServer(dataDir);
    await waitHealth();
    const memberSession2 = await login('member1', MEMBER_PASSWORD);
    const memberAgain = wsClient(memberSession2);
    memberWs.push(memberAgain);
    await memberAgain.ready;
    const afterRestart = await memberAgain.op('memberAction', { projectId, buttonId: 'vote-1' });
    assert.equal(afterRestart.action, 'score');
    state = await getState();
    assert.equal(state.projects[projectId].people[personId].score, 6, '重启后绑定与菜单仍可用');
    assert.equal(
      state.projects[projectId].settings.memberMenus[0].userId,
      memberUser.id,
      '菜单按账号存储',
    );
    assert.equal(
      state.projects[projectId].settings.memberMenus[0].buttons
        .find((button) => button.id === 'session-1')?.onlyDuringBuzz,
      true,
      '仅抢答时启用设置重启后保留',
    );
    assert.equal(state.projects[projectId].settings.memberButtonsPaused, false);
    assert.notEqual(memberUser2.id, memberUser.id);
  } finally {
    for (const ws of memberWs) { try { ws.close(); } catch (_) {} }
    for (const ws of adminWs) { try { ws.close(); } catch (_) {} }
    await stopServer(server);
  }
});
