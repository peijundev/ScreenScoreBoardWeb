'use strict';
// Electron 主进程：本地模式内嵌服务端，远程模式连接已部署的计分板服务
const { app, BrowserWindow, Menu, shell, dialog, session, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const modeUtils = require('./mode');

const APP_NAME = 'ScreenScoreBoard';

// 固定用户数据目录，开发/打包后都写到同一处
app.setName(APP_NAME);
try {
  app.setPath('userData', path.join(app.getPath('appData'), APP_NAME));
} catch (_) {}

let serverPort = 0;
let adminWindow = null;
let settingsWindow = null;
const displayWindows = new Set();
let quitting = false;
let mode = 'local';
let remoteUrl = '';
let embeddedServer = false;

function baseURL() {
  return mode === 'remote' ? remoteUrl : 'http://127.0.0.1:' + serverPort;
}

function projectIdFromWindow(win) {
  try {
    const url = new URL(win && win.webContents ? win.webContents.getURL() : '');
    return url.searchParams.get('project');
  } catch (_) {
    return null;
  }
}

function displayURL(projectId) {
  return modeUtils.displayUrl(baseURL(), projectId);
}

function adminURL(projectId) {
  return modeUtils.adminUrl(baseURL(), projectId);
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
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadURL(adminURL(projectId));
  // 管理端里的「打开显示端」链接（target=_blank）改为开独立显示端窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(baseURL() + '/display')) {
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
    },
  });
  win.loadURL(displayURL(projectId));
  displayWindows.add(win);
  win.on('closed', () => displayWindows.delete(win));
  return win;
}

function focusedProjectId(win) {
  return projectIdFromWindow(win) || projectIdFromWindow(adminWindow);
}

function openSettingsWindow() {
  if (settingsWindow) {
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 600,
    height: 540,
    minWidth: 480,
    minHeight: 460,
    title: APP_NAME + ' 服务器设置',
    backgroundColor: '#1b1e20',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'settings-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  settingsWindow.loadFile(path.join(__dirname, 'settings.html'));
  settingsWindow.on('closed', () => { settingsWindow = null; });
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

async function bootRemote() {
  for (;;) {
    try {
      await fetchRemoteVersion(remoteUrl);
      return true;
    } catch (error) {
      const choice = await dialog.showMessageBox({
        type: 'error',
        title: '无法连接服务器',
        message: '无法连接远程计分板服务',
        detail: remoteUrl + '\n' + (error && error.message ? error.message : ''),
        buttons: ['重试', '服务器设置', '退出'],
        defaultId: 0,
        cancelId: 2,
      });
      if (choice.response === 0) continue;
      if (choice.response === 1) {
        openSettingsWindow();
        return false;
      }
      app.quit();
      return false;
    }
  }
}

function registerConfigHandlers() {
  ipcMain.handle('ssb:config:get', () => ({ mode, remoteUrl }));
  ipcMain.handle('ssb:config:test', async (_event, rawUrl) => {
    const check = modeUtils.validateRemoteUrl(rawUrl);
    if (!check.ok) return { ok: false, error: check.error };
    try {
      const info = await fetchRemoteVersion(check.url);
      return { ok: true, url: check.url, version: info.version };
    } catch (error) {
      return { ok: false, error: '无法连接：' + (error && error.message ? error.message : '') };
    }
  });
  ipcMain.handle('ssb:config:save', async (_event, config) => {
    const nextMode = config && config.mode === 'remote' ? 'remote' : 'local';
    let nextUrl = '';
    if (nextMode === 'remote') {
      const check = modeUtils.validateRemoteUrl(config && config.remoteUrl);
      if (!check.ok) return { ok: false, error: check.error };
      nextUrl = check.url;
    } else if (config && typeof config.remoteUrl === 'string') {
      nextUrl = config.remoteUrl.trim();
    }
    try {
      modeUtils.saveConfig(app.getPath('userData'), { mode: nextMode, remoteUrl: nextUrl });
    } catch (error) {
      return { ok: false, error: '保存失败：' + error.message };
    }
    setTimeout(() => {
      app.relaunch();
      app.quit();
    }, 50);
    return { ok: true };
  });
}

function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
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
      ],
    },
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
        { label: '实际大小', role: 'resetZoom' },
        { label: '放大', role: 'zoomIn' },
        { label: '缩小', role: 'zoomOut' },
      ],
    },
    {
      label: '服务器',
      submenu: [
        {
          label: mode === 'remote' ? '当前：远程 ' + remoteUrl : '当前：本地（内置服务端）',
          enabled: false,
        },
        { type: 'separator' },
        {
          label: '本地模式（内置服务端）',
          enabled: mode !== 'local',
          click: () => {
            modeUtils.saveConfig(app.getPath('userData'), { mode: 'local', remoteUrl });
            app.relaunch();
            app.quit();
          },
        },
        {
          label: '远程模式 / 服务器设置…',
          click: () => openSettingsWindow(),
        },
        {
          label: '重新连接',
          enabled: mode === 'remote',
          click: () => {
            if (adminWindow) adminWindow.reload();
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
            dialog.showMessageBox({
              type: 'info',
              title: '关于 ' + APP_NAME,
              message: APP_NAME,
              detail: '计分板管理端（Electron）\n模式：' +
                (mode === 'remote' ? '远程' : '本地（内置服务端）') +
                '\n地址：' + baseURL() + '/admin',
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
    if (settingsWindow) {
      settingsWindow.focus();
      return;
    }
    if (adminWindow) {
      if (adminWindow.isMinimized()) adminWindow.restore();
      adminWindow.focus();
    } else if (embeddedServer || (mode === 'remote' && remoteUrl)) {
      createAdminWindow();
    }
  });

  app.whenReady().then(async () => {
    // 只允许访问本地服务
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    registerConfigHandlers();

    const config = modeUtils.loadConfig(app.getPath('userData'));
    mode = config.mode;
    remoteUrl = config.remoteUrl;

    if (mode === 'remote') {
      const checked = modeUtils.validateRemoteUrl(remoteUrl);
      if (!checked.ok) {
        dialog.showErrorBox('服务器地址无效', checked.error);
        openSettingsWindow();
        return;
      }
      remoteUrl = checked.url;
      const ready = await bootRemote();
      if (!ready) return;
    } else {
      try {
        await startEmbeddedServer();
      } catch (e) {
        dialog.showErrorBox('启动失败', '内置服务启动失败：' + e.message);
        app.quit();
        return;
      }
    }

    buildMenu();
    createAdminWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length > 0) return;
      if (embeddedServer || (mode === 'remote' && remoteUrl)) createAdminWindow();
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
