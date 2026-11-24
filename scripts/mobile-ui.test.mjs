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
const PORT = 3469;
const BASE = `http://127.0.0.1:${PORT}`;

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

async function createOperator() {
  const loginRes = await fetch(BASE + '/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'test-admin-pass' }),
  });
  assert.ok(loginRes.ok, '管理员登录失败');
  const session = sessionFromResponse(loginRes);
  const res = await fetch(BASE + '/api/v1/auth/users', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: session.cookie,
      'X-CSRF-Token': session.csrf,
    },
    body: JSON.stringify({ username: 'mobile-op', password: 'operator-pass', role: 'operator' }),
  });
  assert.equal(res.status, 200, '创建操作员失败');
}

/** 创建队员账号，并配置一个针对固定人员的加分按钮。 */
async function createMemberWithMenu() {
  const loginRes = await fetch(BASE + '/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'test-admin-pass' }),
  });
  assert.ok(loginRes.ok, '管理员登录失败');
  const session = sessionFromResponse(loginRes);
  const headers = {
    'Content-Type': 'application/json',
    Cookie: session.cookie,
    'X-CSRF-Token': session.csrf,
  };

  const snapshot = await (await fetch(BASE + '/api/state')).json();
  let projectId = Object.keys(snapshot.projects)[0];
  if (!projectId) {
    const projectRes = await fetch(BASE + '/api/v1/projects', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: '手机测试项目' }),
    });
    assert.equal(projectRes.status, 201, '创建手机测试项目失败');
    projectId = (await projectRes.json()).data.projectId;
  }
  assert.ok(projectId, '缺少默认项目');
  const personRes = await fetch(`${BASE}/api/v1/projects/${projectId}/people`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: '队员投票目标' }),
  });
  assert.equal(personRes.status, 201, '创建队员目标人员失败');
  const person = (await personRes.json()).data;

  const created = await fetch(BASE + '/api/v1/auth/users', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      username: 'mobile-member',
      password: 'member-pass-1',
      role: 'member',
      memberProjectId: projectId,
      memberPersonId: person.id,
    }),
  });
  assert.equal(created.status, 200, '创建队员失败');
  const member = (await created.json()).data.user;

  const patchRes = await fetch(`${BASE}/api/v1/projects/${projectId}/settings`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({
      patch: {
        featureMemberConsole: true,
        featureBuzzer: true,
        featureCountdown: true,
        countdownDurationSec: 30,
        buzzTimerMode: 'window',
        buzzDurationSec: 60,
        buzzTarget: 'self',
        buzzScoreDelta: 0,
        buzzButtonMode: 'all',
        buzzRunButtonAction: false,
        buzzLoserHint: true,
        buzzStopTimerOnWin: true,
        memberMenus: [{
          userId: member.id,
          enabled: true,
          columns: 1,
          gap: 16,
          fillMode: 'adaptive',
          buttons: [{
            id: 'vote-mobile',
            label: '投票',
            enabled: true,
            action: 'score',
            targetType: 'person',
            targetId: person.id,
            delta: 1,
            durationMs: 0,
            height: 120,
            fontSize: 28,
            radius: 16,
            color: '#e8a33d',
            textColor: '',
            image: '',
          }],
        }],
      },
    }),
  });
  assert.equal(patchRes.status, 200, '配置人员菜单失败');
  return { projectId, personId: person.id, memberId: member.id, admin: session };
}

const skipReason = !chromiumPath()
  ? '未找到 Chromium（设置 CHROME_PATH 或安装 chromium / google-chrome）'
  : !existsSync(path.join(ROOT, 'public/v2/admin.html'))
    ? '未构建前端，请先运行 npm run build:web'
    : false;

test('手机管理端：全屏对话框与主要流程', { skip: skipReason }, async (t) => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'sb-mobile-'));
  const profile = mkdtempSync(path.join(tmpdir(), 'sb-chrome-'));
  const server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: dataDir,
      STORAGE: 'json',
      LOG_LEVEL: 'error',
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD: 'test-admin-pass',
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
    '--window-size=390,844', 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => {
    await Promise.all([stopProcess(chrome), stopProcess(server)]);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(profile, { recursive: true, force: true });
  });

  assert.ok(await waitUrl(BASE + '/api/health'), '服务未启动');
  await createOperator();
  const memberSetup = await createMemberWithMenu();
  const cdpPort = await waitCdpPort(profile);
  assert.ok(cdpPort, 'Chromium 未启动');
  assert.ok(await waitUrl(`http://127.0.0.1:${cdpPort}/json/version`), 'CDP 未就绪');

  const tab = await (await fetch(`http://127.0.0.1:${cdpPort}/json/new?${BASE}/admin`, { method: 'PUT' })).json();
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
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
  });
  await new Promise((r) => setTimeout(r, 1500));

  const expression = `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const byText = (text) => [...document.querySelectorAll('button, a')].find((b) => b.textContent.trim() === text);
    const setValue = (el, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    for (let i = 0; i < 100 && !document.querySelector('#login-username') && !document.querySelector('.mobile-topbar'); i++) await sleep(100);
    const loginUser = document.querySelector('#login-username');
    const loginPass = document.querySelector('#login-password');
    if (loginUser && loginPass) {
      setValue(loginUser, 'admin');
      setValue(loginPass, 'test-admin-pass');
      document.querySelector('.login-submit')?.click();
    }
    for (let i = 0; i < 100 && !document.querySelector('.mobile-topbar'); i++) await sleep(100);
    const out = {
      width: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      topbar: Boolean(document.querySelector('.mobile-topbar')),
      tabs: [...document.querySelectorAll('.mobile-tab')].map((b) => b.textContent.trim()),
      adminTheme: document.body.dataset.theme || '',
    };
    byText('预览')?.click();
    await sleep(250);
    out.buzzBar = Boolean(document.querySelector('.preview-buzz-bar'));
    out.buzzStartButton = Boolean(document.querySelector('.preview-buzz-bar .btn.primary'));
    out.memberBar = Boolean(document.querySelector('.preview-member-bar'));
    const memberBarButtons = [...document.querySelectorAll('.preview-member-bar button')]
      .map((b) => b.textContent.trim());
    out.memberPauseButton = memberBarButtons.some((t) => t.includes('暂停所有队员按钮'));
    out.memberAccountButton = memberBarButtons.some((t) => t.includes('停用所有队员账号'));
    out.countdownBar = Boolean(document.querySelector('.preview-countdown'));
    const cdButton = (text) => [...document.querySelectorAll('.preview-countdown .cd-btns button')]
      .find((b) => b.textContent.trim() === text);
    cdButton('开始')?.click();
    await sleep(900);
    out.countdownRunning = document.querySelector('.preview-countdown .cd-status')?.textContent || '';
    out.previewCountdown = Boolean(
      document.getElementById('display-preview')?.contentDocument
        ?.querySelector('.overlay-countdown, .countdown-big'),
    );
    cdButton('暂停')?.click();
    await sleep(350);
    out.countdownPaused = document.querySelector('.preview-countdown .cd-status')?.textContent || '';
    cdButton('重置')?.click();
    await sleep(500);
    out.countdownReset = document.querySelector('.preview-countdown .cd-status')?.textContent || '';
    out.previewCountdownAfterReset = Boolean(
      document.getElementById('display-preview')?.contentDocument
        ?.querySelector('.overlay-countdown, .countdown-big'),
    );
    byText('人员')?.click();
    await sleep(250);
    const form = document.querySelector('.add-form');
    const input = form?.querySelector('input[placeholder="姓名"]');
    if (input) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '手机流程');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    }
    await sleep(600);
    const row = [...document.querySelectorAll('.person-row')].find((r) => r.textContent.includes('手机流程'));
    out.personAdded = Boolean(row);
    const before = row?.querySelector('.p-score')?.textContent;
    // 手机端使用遥控器式的 +1 / −1 大按钮
    row?.querySelector('.remote-pad .remote-plus')?.click();
    await sleep(500);
    out.scoreChanged = before !== row?.querySelector('.p-score')?.textContent;
    out.rowOverflow = row ? row.scrollWidth > row.clientWidth + 1 : null;

    // 切 tab 不应丢失未提交的输入
    if (input) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '未提交');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    out.hiddenPanels = document.querySelectorAll('.mobile-panel.is-hidden').length;
    out.visiblePanels = [...document.querySelectorAll('.mobile-panel')]
      .filter((p) => getComputedStyle(p).display !== 'none').length;
    byText('外观')?.click();
    await sleep(200);
    byText('人员')?.click();
    await sleep(200);
    out.draftKept = input?.value === '未提交';

    byText('外观')?.click();
    await sleep(200);
    byText('主题工作室')?.click();
    await sleep(1200);
    const dlg = document.querySelector('.settings-dialog');
    out.studioMobile = dlg?.classList.contains('dialog-mobile') || false;
    const rect = dlg?.getBoundingClientRect();
    out.studioSize = rect ? { w: Math.round(rect.width), h: Math.round(rect.height) } : null;
    out.studioTabs = [...document.querySelectorAll('.settings-dialog .settings-tabs button')].map((b) => b.textContent.trim());
    [...document.querySelectorAll('.theme-lib-actions button')].find((b) => b.textContent.trim() === '新建')?.click();
    // 新建完成后会自动切到「元数据」，以此为就绪信号，避免在 theme 仍为 null 时切到矢量
    for (let i = 0; i < 80 && !document.querySelector('.theme-meta'); i++) await sleep(100);
    await sleep(200);
    [...document.querySelectorAll('.settings-tabs button')].find((b) => b.textContent.trim() === '矢量')?.click();
    for (let i = 0; i < 60 && !document.querySelector('.vector-stage svg'); i++) await sleep(100);
    out.vector = Boolean(document.querySelector('.vector-stage svg'));
    byText('关闭')?.click();
    await sleep(300);
    byText('排版设置')?.click();
    await sleep(600);
    const settings = document.querySelector('.settings-dialog');
    out.settingsMobile = settings?.classList.contains('dialog-mobile') || false;
    byText('关闭')?.click();
    await sleep(300);
    byText('更多')?.click();
    await sleep(200);
    const accountBtn = [...document.querySelectorAll('button')]
      .find((b) => b.textContent.includes('admin · 管理员'));
    accountBtn?.click();
    await sleep(500);
    out.accountDialog = Boolean(document.querySelector('.account-dialog'));
    out.accountTabs = [...document.querySelectorAll('.account-tabs button')].map((b) => b.textContent.trim());
    byText('用户管理')?.click();
    await sleep(500);
    out.memberBindingRow = Boolean(document.querySelector('.account-row .account-member-binding'));
    const roleSelect = document.querySelector('.account-form select');
    if (roleSelect) {
      roleSelect.value = 'member';
      roleSelect.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(250);
    }
    out.newMemberBinding = Boolean(document.querySelector('.account-member-binding-new'));
    byText('关闭')?.click();
    await sleep(200);
    byText('更多')?.click();
    await sleep(200);
    byText('人员菜单')?.click();
    for (let i = 0; i < 100 && !document.querySelector('.member-console.is-preview .member-action'); i++) await sleep(100);
    out.memberMenuDialog = Boolean(document.querySelector('.member-menu-dialog'));
    out.memberPreviewTabs = [...document.querySelectorAll('.member-console.is-preview .member-tab')]
      .map((b) => b.textContent.trim());
    out.memberPreviewButtons = document.querySelectorAll('.member-console.is-preview .member-action').length;
    out.memberPreviewFill = Boolean(
      document.querySelector('.member-console.is-preview .member-content.is-fill'),
    );
    out.fillScreenOption = [...document.querySelectorAll('label')]
      .some((label) => label.textContent.includes('铺满屏幕'));
    const heightInput = document.querySelector(
      '.member-button-editor input[type="number"][min="56"]',
    );
    if (heightInput) {
      setValue(heightInput, '200');
      heightInput.blur();
      await sleep(200);
    }
    out.heightManual = heightInput?.value;
    [...document.querySelectorAll('.member-console.is-preview .member-tab')]
      .find((b) => b.textContent.trim() === '更多')?.click();
    await sleep(150);
    out.memberPreviewMore = Boolean(document.querySelector('.member-console.is-preview .member-account'));
    byText('关闭')?.click();
    await sleep(300);
    byText('更多')?.click();
    await sleep(200);
    byText('退出登录')?.click();
    for (let i = 0; i < 100 && !document.querySelector('#login-username'); i++) await sleep(100);
    const opUser = document.querySelector('#login-username');
    const opPass = document.querySelector('#login-password');
    if (opUser && opPass) {
      setValue(opUser, 'mobile-op');
      setValue(opPass, 'operator-pass');
      document.querySelector('.login-submit')?.click();
    }
    for (let i = 0; i < 100 && !document.querySelector('.mobile-topbar'); i++) await sleep(100);
    out.opTabs = [...document.querySelectorAll('.mobile-tab')].map((b) => b.textContent.trim());
    out.opHasAddForm = Boolean(document.querySelector('.add-form'));
    out.opHasRemote = Boolean(document.querySelector('.remote-pad .remote-plus'));
    byText('更多')?.click();
    await sleep(200);
    out.opHasNewProject = Boolean(byText('新建项目'));
    out.opHasDataTools = Boolean(byText('功能开关与数据'));
    out.opHasLogout = Boolean(byText('退出登录'));

    // 队员：只有「操作 / 更多」两栏，大按钮执行管理端配置的动作
    byText('退出登录')?.click();
    for (let i = 0; i < 100 && !document.querySelector('#login-username'); i++) await sleep(100);
    const memUser = document.querySelector('#login-username');
    const memPass = document.querySelector('#login-password');
    if (memUser && memPass) {
      setValue(memUser, 'mobile-member');
      setValue(memPass, 'member-pass-1');
      document.querySelector('.login-submit')?.click();
    }
    for (let i = 0; i < 100 && !document.querySelector('.member-console'); i++) await sleep(100);
    out.memberTabs = [...document.querySelectorAll('.member-tab')].map((b) => b.textContent.trim());
    out.memberButtons = document.querySelectorAll('.member-action').length;
    out.memberScrollWidth = document.documentElement.scrollWidth;
    out.memberFill = Boolean(document.querySelector('.member-content.is-fill'));
    out.memberButtonHeight = Math.round(
      document.querySelector('.member-action')?.getBoundingClientRect().height || 0,
    );
    out.memberContentHeight = Math.round(
      document.querySelector('.member-content')?.getBoundingClientRect().height || 0,
    );
    document.querySelector('.member-action:not(.is-disabled)')?.click();
    await sleep(700);
    [...document.querySelectorAll('.member-tab')]
      .find((b) => b.textContent.trim() === '更多')?.click();
    await sleep(200);
    out.memberMoreLogout = Boolean(byText('退出登录'));
    out.memberMoreAccount = document.querySelector('.member-account')?.textContent || '';
    out.memberThemePicker = Boolean(document.querySelector('.member-console .admin-theme-picker'));
    return out;
  })()`;

  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  const out = result.result.value;
  if (process.env.DEBUG_MOBILE) console.log(JSON.stringify(out, null, 2));
  assert.equal(out.width, 390);
  assert.ok(out.scrollWidth <= out.width + 1, '不应有横向溢出');
  assert.equal(out.topbar, true);
  assert.deepEqual(out.tabs, ['预览', '人员', '团队', '外观', '更多']);
  assert.equal(out.adminTheme, 'macos-light', '管理端默认主题为 macOS 浅色');
  assert.equal(out.buzzBar, true, '显示端预览包含抢答控制条');
  assert.equal(out.buzzStartButton, true, '显示端预览包含开始抢答按钮');
  assert.equal(out.memberBar, true, '显示端预览包含队员控制条');
  assert.equal(out.memberPauseButton, true, '预览可一键暂停所有队员按钮');
  assert.equal(out.memberAccountButton, true, '预览可一键停用所有队员账号');
  assert.equal(out.countdownBar, true, '显示端预览包含计时器控制条');
  assert.ok(out.countdownRunning.includes('进行中'), '计时器开始后显示进行中与剩余时间');
  assert.equal(out.previewCountdown, true, '计时器在显示端预览中实际显示');
  assert.ok(out.countdownPaused.includes('已暂停'), '计时器可暂停');
  assert.equal(out.countdownReset, '未开始', '计时器可重置');
  assert.equal(out.previewCountdownAfterReset, false, '重置后预览中的计时器消失');
  assert.equal(out.personAdded, true);
  assert.equal(out.scoreChanged, true);
  assert.equal(out.rowOverflow, false);
  assert.equal(out.hiddenPanels, 2);
  assert.equal(out.visiblePanels, 1);
  assert.equal(out.draftKept, true, '切换标签后未提交的姓名应保留');
  assert.equal(out.studioMobile, true);
  assert.deepEqual(out.studioSize, { w: 390, h: 844 });
  assert.equal(out.studioTabs.length, 8);
  assert.equal(out.vector, true);
  assert.equal(out.settingsMobile, true);
  assert.equal(out.accountDialog, true, '账号与安全对话框可打开');
  assert.deepEqual(out.accountTabs, ['访问控制', '用户管理', '会话', 'API 令牌', '修改密码']);
  assert.equal(out.memberBindingRow, true, '用户管理显示队员绑定选择');
  assert.equal(out.newMemberBinding, true, '新建队员时显示项目与人员绑定选择');
  assert.equal(out.memberMenuDialog, true, '人员功能菜单对话框可打开');
  assert.deepEqual(out.memberPreviewTabs, ['操作', '更多'], '人员菜单预览包含两个真实标签');
  assert.equal(out.memberPreviewButtons, 1, '人员菜单预览渲染真实按钮');
  assert.equal(out.memberPreviewFill, true, '人员菜单预览应用铺满模式');
  assert.equal(out.fillScreenOption, true, '列数 1 且单按钮时显示铺满屏幕选项');
  assert.equal(out.heightManual, '200', '按钮高度支持手动输入');
  assert.equal(out.memberPreviewMore, true, '人员菜单预览可切到更多页');
  assert.deepEqual(out.opTabs, ['预览', '人员', '团队', '更多'], '操作员没有主题标签');
  assert.equal(out.opHasAddForm, false, '操作员不能新增人员');
  assert.equal(out.opHasRemote, true, '操作员保留遥控记分');
  assert.equal(out.opHasNewProject, false, '操作员不能新建项目');
  assert.equal(out.opHasDataTools, false, '操作员不能导入导出');
  assert.equal(out.opHasLogout, true, '操作员可退出登录');
  assert.deepEqual(out.memberTabs, ['操作', '更多'], '队员只有两个标签');
  assert.equal(out.memberButtons, 1, '队员看到管理端配置的大按钮');
  assert.equal(out.memberFill, true, '列数 1 且单按钮时铺满模式生效');
  assert.ok(
    out.memberButtonHeight > out.memberContentHeight * 0.7,
    '单按钮铺满可用区域',
  );
  assert.ok(out.memberScrollWidth <= out.width + 1, '队员界面不应有横向溢出');
  assert.equal(out.memberMoreLogout, true, '队员更多页可退出登录');
  assert.ok(out.memberMoreAccount.includes('mobile-member'), '队员更多页显示账号');
  assert.equal(out.memberThemePicker, true, '队员更多页可以修改管理端主题');

  // 抢答：管理员开始后队员端出现抢答横幅，第一个按下即锁定
  async function adminPost(admin, pathname, body) {
    const res = await fetch(BASE + '/api/v1' + pathname, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: admin.cookie,
        'X-CSRF-Token': admin.csrf,
      },
      body: JSON.stringify(body ?? {}),
    });
    assert.equal(res.status, 200, '管理员请求失败：' + pathname);
    return res.json();
  }
  await adminPost(
    memberSetup.admin,
    `/projects/${memberSetup.projectId}/buzz/start`,
    {},
  );
  await new Promise((r) => setTimeout(r, 800));
  const buzzExpr = `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    [...document.querySelectorAll('.member-tab')].find((b) => b.textContent.trim() === '操作')?.click();
    await sleep(300);
    const banner1 = document.querySelector('.member-buzz-banner')?.textContent || '';
    const buttons = [...document.querySelectorAll('.member-action')];
    const enabled = buttons.filter((b) => !b.disabled).length;
    buttons.find((b) => !b.disabled)?.click();
    await sleep(900);
    return {
      banner1,
      enabled,
      banner2: document.querySelector('.member-buzz-banner')?.textContent || '',
      disabledAfter: [...document.querySelectorAll('.member-action')].every((b) => b.disabled),
    };
  })()`;
  const buzzRes = await send('Runtime.evaluate', {
    expression: buzzExpr, awaitPromise: true, returnByValue: true,
  });
  const buzz = buzzRes.result.value;
  if (!buzz) throw new Error('抢答界面表达式失败：' + JSON.stringify(buzzRes.exceptionDetails));
  assert.ok(buzz.banner1.includes('抢答开始'), '队员端显示抢答开始横幅');
  assert.equal(buzz.enabled, 1, '抢答期间可点击按钮可用');
  assert.ok(buzz.banner2.includes('你抢到了'), '第一个按下的队员锁定成功');
  assert.equal(buzz.disabledAfter, true, '抢答后所有按钮禁用');

  await adminPost(
    memberSetup.admin,
    `/projects/${memberSetup.projectId}/buzz/end`,
    {},
  );
  await new Promise((r) => setTimeout(r, 700));
  const buzzEndRes = await send('Runtime.evaluate', {
    expression: `(() => ({
      banner: Boolean(document.querySelector('.member-buzz-banner')),
      enabled: [...document.querySelectorAll('.member-action')].filter((b) => !b.disabled).length,
    }))()`,
    returnByValue: true,
  });
  const buzzEnd = buzzEndRes.result.value;
  assert.equal(buzzEnd.banner, false, '结束抢答后横幅消失');
  assert.equal(buzzEnd.enabled, 1, '结束抢答后按钮恢复可用');

  // 平板宽度：自适应铺满仍按可用区域伸缩
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1024, height: 768, deviceScaleFactor: 1, mobile: true,
  });
  await new Promise((r) => setTimeout(r, 400));
  const tabletRes = await send('Runtime.evaluate', {
    expression: `(() => ({
      width: innerWidth,
      fill: Boolean(document.querySelector('.member-content.is-fill')),
      button: Math.round(document.querySelector('.member-action')?.getBoundingClientRect().height || 0),
      content: Math.round(document.querySelector('.member-content')?.getBoundingClientRect().height || 0),
      scrollWidth: document.documentElement.scrollWidth,
    }))()`,
    returnByValue: true,
  });
  const tablet = tabletRes.result.value;
  assert.equal(tablet.width, 1024);
  assert.equal(tablet.fill, true, '平板宽度下自适应铺满生效');
  assert.ok(tablet.button > tablet.content * 0.7, '平板宽度下单按钮铺满可用区域');
  assert.ok(tablet.scrollWidth <= tablet.width + 1, '平板宽度下无横向溢出');

  // 桌面宽度：同一队员界面组件仍只有「操作 / 更多」两栏
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 800, deviceScaleFactor: 1, mobile: false,
  });
  await new Promise((r) => setTimeout(r, 300));
  const desktopExpr = `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const byText = (text) => [...document.querySelectorAll('button, a')].find((b) => b.textContent.trim() === text);
    [...document.querySelectorAll('.member-tab')].find((b) => b.textContent.trim() === '操作')?.click();
    await sleep(150);
    const out = {
      width: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      tabs: [...document.querySelectorAll('.member-tab')].map((b) => b.textContent.trim()),
      buttons: document.querySelectorAll('.member-action').length,
    };
    [...document.querySelectorAll('.member-tab')].find((b) => b.textContent.trim() === '更多')?.click();
    await sleep(150);
    byText('退出登录')?.click();
    for (let i = 0; i < 100 && !document.querySelector('#login-username'); i++) await sleep(100);
    out.loggedOut = Boolean(document.querySelector('#login-username'));
    return out;
  })()`;
  const desktopRes = await send('Runtime.evaluate', {
    expression: desktopExpr, awaitPromise: true, returnByValue: true,
  });
  const desktop = desktopRes.result.value;
  assert.equal(desktop.width, 1280);
  assert.ok(desktop.scrollWidth <= desktop.width + 1, '桌面队员界面不应有横向溢出');
  assert.deepEqual(desktop.tabs, ['操作', '更多'], '桌面队员同样只有两个标签');
  assert.equal(desktop.buttons, 1, '桌面队员看到同一批按钮');
  assert.equal(desktop.loggedOut, true, '队员可退出登录');

  const afterMember = await (await fetch(BASE + '/api/state')).json();
  assert.equal(
    afterMember.projects[memberSetup.projectId].people[memberSetup.personId].score,
    1,
    '点击队员按钮应执行管理端配置的加分',
  );

  // 桌面宽度下的人员菜单窗口：默认大窗口、可拖动，中间编辑区不能被挤成一条
  const dialogExpr = `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const byText = (text) => [...document.querySelectorAll('button, a')].find((b) => b.textContent.trim() === text);
    const setValue = (el, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const loginUser = document.querySelector('#login-username');
    const loginPass = document.querySelector('#login-password');
    if (loginUser && loginPass) {
      setValue(loginUser, 'admin');
      setValue(loginPass, 'test-admin-pass');
      document.querySelector('.login-submit')?.click();
    }
    for (let i = 0; i < 100 && !document.querySelector('.topbar'); i++) await sleep(100);
    for (let i = 0; i < 100; i++) {
      const menuButton = byText('人员菜单');
      if (menuButton && !menuButton.disabled) {
        menuButton.click();
        break;
      }
      await sleep(100);
    }
    for (let i = 0; i < 100 && !document.querySelector('.member-menu-dialog'); i++) await sleep(100);
    await sleep(400);
    const dlg = document.querySelector('.settings-dialog');
    if (!dlg) {
      return {
        width: innerWidth,
        missingDialog: true,
        debug: {
          topbar: Boolean(document.querySelector('.topbar')),
          menuButton: Boolean(byText('人员菜单')),
          dialogs: document.querySelectorAll('.settings-dialog').length,
          login: Boolean(document.querySelector('#login-username')),
          text: document.body.innerText.slice(0, 400),
        },
      };
    }
    const rect = dlg.getBoundingClientRect();
    const editor = document.querySelector('.member-menu-editor')?.getBoundingClientRect();
    const header = dlg.querySelector('.dialog-header');
    const beforeLeft = rect.left;
    header.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, pointerId: 1, clientX: rect.left + 200, clientY: rect.top + 16,
    }));
    window.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, pointerId: 1, clientX: rect.left + 280, clientY: rect.top + 56,
    }));
    await sleep(300);
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
    await sleep(200);
    const after = dlg.getBoundingClientRect();
    const title = document.querySelector('.member-menu-editor-head h3');
    const titleRect = title?.getBoundingClientRect();
    const enableLabel = [...document.querySelectorAll('.member-menu-editor-head label')]
      .find((label) => label.textContent.includes('启用该队员菜单'));
    const enableRect = enableLabel?.getBoundingClientRect();
    return {
      width: innerWidth,
      dialogWidth: Math.round(rect.width),
      dialogLeft: Math.round(rect.left),
      editorWidth: editor ? Math.round(editor.width) : 0,
      mobileClass: dlg.classList.contains('dialog-mobile'),
      dragDelta: Math.round(after.left - beforeLeft),
      titleWidth: titleRect ? Math.round(titleRect.width) : 0,
      titleHeight: titleRect ? Math.round(titleRect.height) : 0,
      enableHeight: enableRect ? Math.round(enableRect.height) : 0,
      hasDisplayPreview: Boolean(document.querySelector('.member-display-preview')),
    };
  })()`;
  const dialogRes = await send('Runtime.evaluate', {
    expression: dialogExpr, awaitPromise: true, returnByValue: true,
  });
  if (dialogRes.exceptionDetails) {
    throw new Error('桌面人员菜单表达式异常：' + JSON.stringify(dialogRes.exceptionDetails));
  }
  const dialog = dialogRes.result.value;
  if (dialog?.missingDialog) {
    throw new Error('人员菜单未打开：' + JSON.stringify(dialog.debug));
  }
  if (!dialog || dialog.width === undefined) {
    throw new Error('桌面人员菜单表达式失败：' + JSON.stringify(dialogRes.result));
  }
  assert.equal(dialog.width, 1280);
  assert.ok(dialog.dialogWidth > 1000, '人员菜单默认使用大窗口');
  assert.equal(dialog.mobileClass, false, '桌面宽度不使用手机全屏样式');
  assert.ok(dialog.dialogLeft > 0, '人员菜单窗口不是全屏');
  assert.ok(dialog.editorWidth > 350, '人员菜单中间编辑区宽度正常');
  assert.ok(dialog.dragDelta > 40, '人员菜单窗口可拖动');
  assert.ok(dialog.titleWidth > 80 && dialog.titleHeight < 40, '编辑区标题保持横向，不再竖排');
  assert.ok(dialog.enableHeight < 40, '启用菜单标签不再竖排');
  assert.equal(dialog.hasDisplayPreview, false, '人员菜单已移除内嵌大屏预览');
});

test('人员与团队记分控件共用同一组功能开关', () => {
  const people = readFileSync(
    path.join(ROOT, 'web/src/admin/components/PeoplePanel.tsx'), 'utf8',
  );
  const teams = readFileSync(
    path.join(ROOT, 'web/src/admin/components/TeamsPanel.tsx'), 'utf8',
  );
  const features = readFileSync(
    path.join(ROOT, 'web/src/admin/settings/featuresSchema.ts'), 'utf8',
  );
  assert.match(people, /quickScore=\{Boolean\(settings\.featureQuickScore\)\}/);
  assert.match(teams, /quickScore=\{project\.settings\.featureQuickScore !== false\}/);
  assert.match(teams, /canScore && teamScore && quickScore/, '团队快捷分受同一开关控制');
  assert.match(teams, /\(!mobile \|\| !quickScore\)/, '团队任意加分的显示规则与人员一致');
  assert.match(teams, /featureSpotlightTrigger/, '团队突显仍受突显开关控制');
  assert.match(features, /快捷记分按钮（人员 \/ 团队）/, '开关文案说明同时作用于人员与团队');
});
