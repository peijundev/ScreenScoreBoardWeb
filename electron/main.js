'use strict';
// Electron 主进程：内嵌启动计分板服务，管理端窗口 + 可另开显示端窗口
const { app, BrowserWindow, Menu, shell, dialog, session } = require('electron');
const path = require('path');
const fs = require('fs');

const APP_NAME = 'ScreenScoreBoard';

// 固定用户数据目录，开发/打包后都写到同一处
app.setName(APP_NAME);
try {
  app.setPath('userData', path.join(app.getPath('appData'), APP_NAME));
} catch (_) {}

let serverPort = 0;
let adminWindow = null;
const displayWindows = new Set();
let quitting = false;

function baseURL() {
  return 'http://127.0.0.1:' + serverPort;
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
  return baseURL() + '/display' + (projectId ? '?project=' + encodeURIComponent(projectId) : '');
}

function adminURL(projectId) {
  return baseURL() + '/admin' + (projectId ? '?project=' + encodeURIComponent(projectId) : '');
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
      label: '帮助',
      submenu: [
        {
          label: '关于',
          click: () => {
            dialog.showMessageBox({
              type: 'info',
              title: '关于 ' + APP_NAME,
              message: APP_NAME,
              detail: '计分板管理端（Electron）\n服务端口：' + serverPort +
                '\n管理端：' + baseURL() + '/admin',
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

  const { start } = require('../server/index');
  const result = await start({ port: 0, host: '127.0.0.1' });
  serverPort = result.port;
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (adminWindow) {
      if (adminWindow.isMinimized()) adminWindow.restore();
      adminWindow.focus();
    } else {
      createAdminWindow();
    }
  });

  app.whenReady().then(async () => {
    // 只允许访问本地服务
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

    try {
      await startEmbeddedServer();
    } catch (e) {
      dialog.showErrorBox('启动失败', '内置服务启动失败：' + e.message);
      app.quit();
      return;
    }

    buildMenu();
    createAdminWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createAdminWindow();
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
    try {
      flush = require('../server/state').flushSave;
    } catch (_) {}
    Promise.resolve(flush ? flush() : null)
      .catch(() => {})
      .finally(() => app.exit(0));
  });
}
