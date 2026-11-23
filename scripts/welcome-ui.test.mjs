// 零项目欢迎页：管理端欢迎界面、显示端空状态、默认 macOS 浅色
// 运行: node --test scripts/welcome-ui.test.mjs
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
const PORT = 3483;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_PASSWORD = 'test-admin-pass';

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
  : !existsSync(path.join(ROOT, 'public/v2/admin.html'))
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

test('零项目欢迎页与默认 macOS 浅色', { skip: skipReason }, async (t) => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'sb-welcome-'));
  const profile = mkdtempSync(path.join(tmpdir(), 'sb-welcome-chrome-'));
  const server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: dataDir,
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
  const state = await (await fetch(BASE + '/api/state')).json();
  assert.deepEqual(state.projects, {}, '新库没有项目');

  const cdpPort = await waitCdpPort(profile);
  assert.ok(cdpPort, 'Chromium 未启动');
  assert.ok(await waitUrl(`http://127.0.0.1:${cdpPort}/json/version`), 'CDP 未就绪');
  const tab = await (await fetch(`http://127.0.0.1:${cdpPort}/json/new?${BASE}/display-v2`, { method: 'PUT' })).json();
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
    if (res.exceptionDetails) throw new Error('页面脚本异常：' + JSON.stringify(res.exceptionDetails));
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

  // 显示端：没有项目时显示等待画面，而不是空白/连接中
  assert.ok(await waitFor(`document.querySelector('.display-empty')`), '显示端显示零项目空状态');
  assert.ok(
    (await evalJs(`document.querySelector('.display-empty')?.textContent || ''`)).includes('尚未创建项目'),
    '显示端空状态包含提示',
  );

  // 管理端：登录后显示欢迎页
  await send('Page.navigate', { url: BASE + '/admin' });
  await new Promise((r) => setTimeout(r, 500));
  await waitFor(`document.querySelector('#login-username')`);
  await evalJs(`(() => {
    const setValue = (el, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    setValue(document.querySelector('#login-username'), 'admin');
    setValue(document.querySelector('#login-password'), 'test-admin-pass');
    document.querySelector('.login-submit')?.click();
    return true;
  })()`);
  assert.ok(await waitFor(`document.querySelector('.welcome-screen')`), '管理端显示欢迎页');
  assert.equal(await evalJs(`document.body.dataset.theme || ''`), 'macos-light', '默认管理端主题为 macOS 浅色');
  const welcomeText = await evalJs(`document.querySelector('.welcome-screen')?.textContent || ''`);
  assert.ok(welcomeText.includes('ScreenScoreBoard'), '欢迎页包含品牌');
  assert.ok(welcomeText.includes('新建项目'), '欢迎页包含新建项目');
  assert.ok(welcomeText.includes('导入项目'), '欢迎页包含导入项目');
  assert.ok(welcomeText.includes('整库导入'), '欢迎页包含整库导入');
  assert.ok(welcomeText.includes('最近的') || welcomeText.includes('最近项目'), '欢迎页包含最近项目区域');

  // 从欢迎页创建项目后进入正常管理界面
  await evalJs(`(() => {
    const form = document.querySelector('.welcome-create');
    const input = form?.querySelector('input');
    if (!form || !input) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, '欢迎页项目');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    return true;
  })()`);
  assert.ok(await waitFor(`document.querySelector('.topbar')`), '创建项目后进入管理界');
  assert.equal(await evalJs(`Boolean(document.querySelector('.welcome-screen'))`), false, '欢迎页消失');
  assert.ok(
    (await evalJs(`document.body.textContent || ''`)).includes('欢迎页项目'),
    '新建项目出现在管理端',
  );
});
