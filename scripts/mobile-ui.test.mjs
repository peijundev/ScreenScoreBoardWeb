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
    };
    byText('人员')?.click();
    await sleep(200);
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
    byText('主题')?.click();
    await sleep(200);
    byText('人员')?.click();
    await sleep(200);
    out.draftKept = input?.value === '未提交';

    byText('主题')?.click();
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
    byText('关闭')?.click();
    await sleep(200);
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
    out.opHasDataTools = Boolean(byText('数据导入 / 导出 / 备份'));
    out.opHasLogout = Boolean(byText('退出登录'));
    return out;
  })()`;

  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  const out = result.result.value;
  if (process.env.DEBUG_MOBILE) console.log(JSON.stringify(out, null, 2));
  assert.equal(out.width, 390);
  assert.ok(out.scrollWidth <= out.width + 1, '不应有横向溢出');
  assert.equal(out.topbar, true);
  assert.deepEqual(out.tabs, ['预览', '人员', '团队', '主题', '更多']);
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
  assert.deepEqual(out.accountTabs, ['用户管理', '会话', 'API 令牌', '修改密码']);
  assert.deepEqual(out.opTabs, ['预览', '人员', '团队', '更多'], '操作员没有主题标签');
  assert.equal(out.opHasAddForm, false, '操作员不能新增人员');
  assert.equal(out.opHasRemote, true, '操作员保留遥控记分');
  assert.equal(out.opHasNewProject, false, '操作员不能新建项目');
  assert.equal(out.opHasDataTools, false, '操作员不能导入导出');
  assert.equal(out.opHasLogout, true, '操作员可退出登录');
});
