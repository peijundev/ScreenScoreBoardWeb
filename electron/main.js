'use strict';
// Electron 主进程：启动时选择本地/远程模式；本地内嵌服务端，远程连接已部署服务
const { app, BrowserWindow, Menu, shell, dialog, session, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const modeUtils = require('./mode');
const { nextZoom, zoomCommand } = require('./zoom');

const APP_NAME = 'ScreenScoreBoard';

// 固定用户数据目录，开发/打包后都写到同一处
app.setName(APP_NAME);
try {
  app.setPath('userData', path.join(app.getPath('appData'), APP_NAME));
} catch (_) {}

let serverPort = 0;
let adminWindow = null;
let launcherWindow = null;
const displayWindows = new Set();
let quitting = false;
let launching = false;
let mode = 'local';
let remoteUrl = '';
let remoteUsername = '';
let remoteDisplayUrl = '';
let embeddedServer = false;

function localBaseURL() {
  return 'http://127.0.0.1:' + serverPort;
}

function baseURL() {
  if (mode === 'remote-admin') return remoteUrl;
  if (mode === 'remote-display') {
    try {
      return remoteDisplayUrl ? new URL(remoteDisplayUrl).origin : '';
    } catch (_) {
      return '';
    }
  }
  return localBaseURL();
}

function isRemoteDisplayMode() {
  return mode === 'remote-display';
}

function projectIdFromWindow(win) {
  try {
    const url = new URL(win && win.webContents ? win.webContents.getURL() : '');
    return url.searchParams.get('project');
  } catch (_) {
    return null;
  }
}

function adminURL(projectId) {
  return modeUtils.adminUrl(baseURL(), projectId);
}

/** 屏幕模式使用完整显示端网址；管理模式用服务器根地址 + /display；本地模式用 127.0.0.1 */
function displayURL(projectId) {
  if (mode === 'remote-display') return remoteDisplayUrl;
  if (mode === 'remote-admin') return modeUtils.displayUrl(remoteUrl, projectId);
  return modeUtils.displayUrl(localBaseURL(), projectId);
}

function isDisplayLink(raw) {
  try {
    const url = new URL(raw);
    if (mode === 'remote-display' && remoteDisplayUrl) {
      const configured = new URL(remoteDisplayUrl);
      if (url.href === configured.href) return true;
    }
    if (!baseURL()) return false;
    const base = new URL(baseURL());
    return (
      url.origin === base.origin &&
      (url.pathname === '/display' || url.pathname === '/display-v2')
    );
  } catch (_) {
    return false;
  }
}

/**
 * 浏览器式页面缩放：Ctrl/Cmd + 滚轮、+、-、0。
 * 使用 manual 模式由应用自己处理，避免 Chromium 再叠加一次；比例只存在于当前窗口，不落盘。
 */
function attachZoom(win) {
  const wc = win.webContents;
  wc.setZoomMode('manual');
  wc.setZoomFactor(1);
  const apply = (command) => {
    wc.setZoomFactor(nextZoom(wc.getZoomFactor(), command));
  };
  // Ctrl/Cmd + 滚轮由 preload 发 IPC（Electron 的 zoom-changed 不覆盖真实滚轮）
  wc.on('before-input-event', (event, input) => {
    const command = zoomCommand(input);
    if (!command) return;
    event.preventDefault();
    apply(command);
  });
}

function zoomWindow(win, command) {
  const target = win && !win.isDestroyed() ? win : BrowserWindow.getFocusedWindow();
  if (!target || target.isDestroyed()) return;
  const wc = target.webContents;
  wc.setZoomFactor(nextZoom(wc.getZoomFactor(), command));
}

function createAdminWindow(projectId) {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: APP_NAME + ' 管理端',
    backgroundColor: '#1b1e20',
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'admin-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  attachZoom(win);
  win.loadURL(adminURL(projectId));
  // 管理端里的「打开显示端」链接（target=_blank）改为开独立显示端窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isDisplayLink(url)) {
      let pid = null;
      try { pid = new URL(url).searchParams.get('project'); } catch (_) {}
      openDisplayWindow(pid);
      return { action: 'deny' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('closed', () => { if (adminWindow === win) adminWindow = null; });
  adminWindow = win;
  return win;
}

/** 显示端窗口：无标签页、无地址栏，只加载配置好的显示端网址 */
function openDisplayWindow(projectId) {
  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    title: APP_NAME + ' 显示端',
    backgroundColor: '#12161c',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'display-preload.js'),
    },
  });
  attachZoom(win);
  win.loadURL(displayURL(projectId));
  displayWindows.add(win);
  win.on('closed', () => displayWindows.delete(win));
  return win;
}

function focusedProjectId(win) {
  return projectIdFromWindow(win) || projectIdFromWindow(adminWindow);
}

function openLauncherWindow() {
  // 欢迎页只保留模式选择，不显示运行中的管理菜单
  Menu.setApplicationMenu(null);
  if (launcherWindow) {
    if (launcherWindow.isMinimized()) launcherWindow.restore();
    launcherWindow.show();
    launcherWindow.focus();
    return;
  }
  launcherWindow = new BrowserWindow({
    width: 720,
    height: 720,
    minWidth: 560,
    minHeight: 600,
    title: APP_NAME + ' · 选择运行模式',
    backgroundColor: '#1b1e20',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'launcher-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  launcherWindow.loadFile(path.join(__dirname, 'launcher.html'));
  launcherWindow.on('closed', () => {
    launcherWindow = null;
    if (!adminWindow && displayWindows.size === 0) app.quit();
  });
}

function finishLaunch() {
  launching = false;
  if (isRemoteDisplayMode()) openDisplayWindow();
  else createAdminWindow();
  buildMenu();
  if (launcherWindow) {
    const win = launcherWindow;
    launcherWindow = null;
    win.close();
  }
}

/** 运行中返回欢迎页：关闭管理/显示窗口，保留已启动的本地服务端以便复用 */
function returnToLauncher() {
  if (launching) return false;
  openLauncherWindow();
  for (const win of BrowserWindow.getAllWindows()) {
    if (win === launcherWindow) continue;
    try { win.close(); } catch (_) {}
  }
  adminWindow = null;
  displayWindows.clear();
  if (launcherWindow) {
    launcherWindow.show();
    launcherWindow.focus();
  }
  return true;
}

function isTrustedShellUrl(raw) {
  try {
    const origin = new URL(raw).origin;
    return origin === new URL(baseURL()).origin;
  } catch (_) {
    return false;
  }
}

function scheduleFinish() {
  // 先让 IPC 把成功响应送回启动页，再关闭它
  setTimeout(finishLaunch, 80);
}

async function fetchRemoteVersion(base) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(modeUtils.healthUrl(base), { signal: controller.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json().catch(() => ({}));
    return { version: data && data.version ? String(data.version) : '' };
  } finally {
    clearTimeout(timer);
  }
}

async function storeLoginCookies(origin, setCookieHeaders) {
  let stored = 0;
  for (const header of setCookieHeaders) {
    const cookie = modeUtils.cookieFromSetCookie(origin, header);
    if (!cookie) continue;
    await session.defaultSession.cookies.set(cookie);
    stored += 1;
  }
  if (!stored) throw new Error('登录成功但未收到会话 Cookie');
  const sessionCookie = await session.defaultSession.cookies.get({
    url: origin,
    name: 'ssb_session',
  });
  if (!sessionCookie.length) throw new Error('登录成功但会话 Cookie 未能保存');
}

async function loginRemote(config) {
  const checked = modeUtils.validateRemoteUrl(config.remoteUrl);
  if (!checked.ok) throw new Error(checked.error);
  const username = String(config.username || '').trim();
  const password = String(config.password || '');
  if (!username) throw new Error('请填写账号');
  if (!password) throw new Error('请填写密码');

  await fetchRemoteVersion(checked.url);
  const res = await fetch(checked.url + '/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, remember: true }),
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (_) { /* ignore */ }
  if (!res.ok) {
    const message = body && body.error && body.error.message
      ? body.error.message
      : '登录失败（HTTP ' + res.status + '）';
    throw new Error(message);
  }
  const setCookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie')].filter(Boolean);
  const origin = new URL(checked.url).origin;
  await storeLoginCookies(origin, setCookies);

  remoteUrl = checked.url;
  remoteUsername = username;
  // 管理模式的显示端窗口固定使用服务器根地址 + /display；
  // 保留 remoteDisplayUrl 仅用于启动页屏幕模式的回填，不参与管理端显示端 URL。
  mode = 'remote-admin';
  try {
    modeUtils.saveConfig(app.getPath('userData'), {
      mode: 'remote-admin',
      remoteUrl,
      username: remoteUsername,
      displayUrl: remoteDisplayUrl,
    });
  } catch (error) {
    console.warn('[electron] 保存远程管理模式配置失败：' + error.message);
  }
}

/** 远程屏幕模式：不登录，只打开一个完整的显示端网址 */
async function startDisplayMode(config) {
  const checked = modeUtils.validateDisplayUrl(config.displayUrl);
  if (!checked.ok) throw new Error(checked.error);
  if (!checked.url) throw new Error('请填写显示端网址');
  remoteDisplayUrl = checked.url;
  mode = 'remote-display';
  try {
    modeUtils.saveConfig(app.getPath('userData'), {
      mode: 'remote-display',
      remoteUrl,
      username: remoteUsername,
      displayUrl: remoteDisplayUrl,
    });
  } catch (error) {
    console.warn('[electron] 保存远程屏幕模式配置失败：' + error.message);
  }
}

async function startLocalMode() {
  // 从运行中返回欢迎页后本地服务端仍在运行，直接复用，避免同一进程重复启动
  if (!embeddedServer) await startEmbeddedServer();
  mode = 'local';
  try {
    modeUtils.saveConfig(app.getPath('userData'), {
      mode: 'local',
      remoteUrl,
      username: remoteUsername,
      displayUrl: remoteDisplayUrl,
    });
  } catch (error) {
    console.warn('[electron] 保存本地模式配置失败：' + error.message);
  }
}

function registerLauncherHandlers() {
  ipcMain.on('ssb:zoom', (event, command) => {
    if (command !== 'in' && command !== 'out') return;
    zoomWindow(BrowserWindow.fromWebContents(event.sender), command);
  });

  ipcMain.handle('ssb:launcher:get', () => ({
    mode,
    remoteUrl,
    username: remoteUsername,
    displayUrl: remoteDisplayUrl,
  }));

  ipcMain.handle('ssb:launcher:local', async () => {
    if (launching) return { ok: false, error: '正在启动，请稍候' };
    launching = true;
    try {
      await startLocalMode();
      scheduleFinish();
      return { ok: true };
    } catch (error) {
      launching = false;
      return { ok: false, error: '启动失败：' + (error && error.message ? error.message : '') };
    }
  });

  ipcMain.handle('ssb:launcher:remote', async (_event, config) => {
    if (launching) return { ok: false, error: '正在连接，请稍候' };
    launching = true;
    try {
      await loginRemote(config || {});
      scheduleFinish();
      return { ok: true };
    } catch (error) {
      launching = false;
      return { ok: false, error: error && error.message ? error.message : '连接失败' };
    }
  });

  ipcMain.handle('ssb:launcher:display', async (_event, config) => {
    if (launching) return { ok: false, error: '正在打开，请稍候' };
    launching = true;
    try {
      await startDisplayMode(config || {});
      scheduleFinish();
      return { ok: true };
    } catch (error) {
      launching = false;
      return { ok: false, error: error && error.message ? error.message : '打开失败' };
    }
  });

  ipcMain.handle('ssb:launcher:quit', () => {
    app.quit();
    return { ok: true };
  });

  ipcMain.handle('ssb:shell:return-to-launcher', (event) => {
    const rawUrl = event.senderFrame && event.senderFrame.url
      ? event.senderFrame.url
      : (event.sender && event.sender.getURL ? event.sender.getURL() : '');
    if (!isTrustedShellUrl(rawUrl)) {
      return { ok: false, error: '当前页面不允许切换模式' };
    }
    const ok = returnToLauncher();
    return ok ? { ok: true } : { ok: false, error: '正在启动，请稍候' };
  });
}

function modeLabel() {
  if (mode === 'local') return '本地（内置服务端）';
  if (mode === 'remote-display') return '远程屏幕';
  return '远程管理';
}

function reloadDisplayWindow() {
  const target = Array.from(displayWindows).pop();
  if (target) target.reload();
}

function buildMenu() {
  const displayOnly = isRemoteDisplayMode();
  const fileSubmenu = displayOnly
    ? [
      {
        label: '在系统浏览器中打开显示端',
        accelerator: 'CmdOrCtrl+Shift+B',
        click: () => shell.openExternal(displayURL(null)),
      },
      {
        label: '重新加载显示端',
        accelerator: 'CmdOrCtrl+R',
        click: () => reloadDisplayWindow(),
      },
      { type: 'separator' },
      { label: '退出', role: 'quit' },
    ]
    : [
      {
        label: '打开显示端窗口',
        accelerator: 'CmdOrCtrl+Shift+D',
        click: (_mi, win) => openDisplayWindow(focusedProjectId(win)),
      },
      {
        label: '在系统浏览器中打开显示端',
        accelerator: 'CmdOrCtrl+Shift+B',
        click: (_mi, win) => {
          shell.openExternal(displayURL(focusedProjectId(win)));
        },
      },
      {
        label: '新建管理端窗口',
        click: (_mi, win) => createAdminWindow(focusedProjectId(win)),
      },
      { type: 'separator' },
      { label: '退出', role: 'quit' },
    ];

  const template = [
    { label: '文件', submenu: fileSubmenu },
    {
      label: '视图',
      submenu: [
        { label: '重新加载', role: 'reload' },
        { label: '开发者工具', role: 'toggleDevTools' },
        { type: 'separator' },
        {
          label: '切换显示端全屏',
          accelerator: 'F11',
          click: (_mi, win) => {
            const target = win && displayWindows.has(win)
              ? win
              : Array.from(displayWindows).pop();
            if (target) target.setFullScreen(!target.isFullScreen());
          },
        },
        { type: 'separator' },
        { label: '实际大小', click: (_mi, win) => zoomWindow(win, 'reset') },
        { label: '放大', click: (_mi, win) => zoomWindow(win, 'in') },
        { label: '缩小', click: (_mi, win) => zoomWindow(win, 'out') },
      ],
    },
    {
      label: '服务器',
      submenu: [
        {
          label: '当前：' + modeLabel() +
            (mode === 'remote-admin' ? ' ' + remoteUrl : '') +
            (mode === 'remote-display' ? ' ' + remoteDisplayUrl : ''),
          enabled: false,
        },
        { type: 'separator' },
        {
          label: '退出到欢迎页（切换模式）…',
          accelerator: 'CmdOrCtrl+Shift+M',
          click: () => returnToLauncher(),
        },
        {
          label: '重启应用…',
          click: () => {
            app.relaunch();
            app.quit();
          },
        },
        {
          label: displayOnly ? '重新加载显示端' : '重新连接',
          enabled: displayOnly
            ? displayWindows.size > 0
            : mode === 'remote-admin' && Boolean(adminWindow),
          click: () => {
            if (displayOnly) reloadDisplayWindow();
            else if (adminWindow) adminWindow.reload();
          },
        },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于',
          click: () => {
            const lines = [
              '计分板' + (displayOnly ? '显示端' : '管理端') + '（Electron）',
              '模式：' + modeLabel(),
            ];
            if (!displayOnly) lines.push('管理端：' + baseURL() + '/admin');
            lines.push('显示端：' + displayURL(null));
            dialog.showMessageBox({
              type: 'info',
              title: '关于 ' + APP_NAME,
              message: APP_NAME,
              detail: lines.join('\n'),
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function startEmbeddedServer() {
  const dataDir = path.join(app.getPath('userData'), 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  process.env.DATA_DIR = dataDir;
  // Electron 本地窗口固定走 http://127.0.0.1；避免外部 TLS 环境变量把内嵌服务变成 https
  delete process.env.TLS_CERT_FILE;
  delete process.env.TLS_KEY_FILE;
  delete process.env.TLS_PASSPHRASE;

  const { start } = require('../server/index');
  const result = await start({ port: 0, host: '127.0.0.1', auth: false });
  serverPort = result.port;
  embeddedServer = true;
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (launcherWindow) {
      launcherWindow.show();
      launcherWindow.focus();
      return;
    }
    if (adminWindow) {
      if (adminWindow.isMinimized()) adminWindow.restore();
      adminWindow.focus();
    } else if (displayWindows.size > 0) {
      const win = Array.from(displayWindows).pop();
      if (win.isMinimized()) win.restore();
      win.focus();
    } else if (BrowserWindow.getAllWindows().length === 0) {
      openLauncherWindow();
    }
  });

  app.whenReady().then(async () => {
    // 拒绝摄像头/麦克风等权限请求；不影响 HTTP/WS
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    registerLauncherHandlers();

    const config = modeUtils.loadConfig(app.getPath('userData'));
    mode = config.mode;
    remoteUrl = config.remoteUrl;
    remoteUsername = config.username;
    remoteDisplayUrl = config.displayUrl;
    openLauncherWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) openLauncherWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  // 退出前把防抖中的状态写盘
  app.on('before-quit', (e) => {
    if (quitting) return;
    e.preventDefault();
    quitting = true;
    let flush = null;
    if (embeddedServer) {
      try {
        flush = require('../server/state').flushSave;
      } catch (_) {}
    }
    Promise.resolve(flush ? flush() : null)
      .catch(() => {})
      .finally(() => app.exit(0));
  });
}
