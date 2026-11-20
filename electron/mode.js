'use strict';
// Electron 本地/远程模式配置：纯函数，便于在 Node 测试中直接使用
const fs = require('fs');
const path = require('path');

const CONFIG_NAME = 'electron-config.json';
const DEFAULT_CONFIG = Object.freeze({
  mode: 'local',
  remoteUrl: '',
  username: '',
  displayUrl: '',
});

function configPath(userDataDir) {
  return path.join(userDataDir, CONFIG_NAME);
}

function readFileConfig(userDataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(userDataDir), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_CONFIG };
    return {
      mode: parsed.mode === 'remote' ? 'remote' : 'local',
      remoteUrl: typeof parsed.remoteUrl === 'string' ? parsed.remoteUrl : '',
      username: typeof parsed.username === 'string' ? parsed.username : '',
      displayUrl: typeof parsed.displayUrl === 'string' ? parsed.displayUrl : '',
    };
  } catch (_) {
    return { ...DEFAULT_CONFIG };
  }
}

function loadConfig(userDataDir, env = process.env) {
  const file = readFileConfig(userDataDir);
  const envMode = String(env.SCOREBOARD_MODE || '').toLowerCase();
  const mode = envMode === 'remote' || envMode === 'local' ? envMode : file.mode;
  let remoteUrl = file.remoteUrl;
  let username = file.username;
  let displayUrl = file.displayUrl;
  if (mode === 'remote') {
    remoteUrl = env.SCOREBOARD_REMOTE_URL || env.SCOREBOARD_URL || file.remoteUrl || '';
    username = env.SCOREBOARD_USERNAME || file.username || '';
    displayUrl = env.SCOREBOARD_DISPLAY_URL || file.displayUrl || '';
  }
  return { mode, remoteUrl, username, displayUrl };
}

function saveConfig(userDataDir, config) {
  fs.mkdirSync(userDataDir, { recursive: true });
  const file = configPath(userDataDir);
  const tmp = file + '.tmp';
  const value = {
    mode: config.mode === 'remote' ? 'remote' : 'local',
    remoteUrl: typeof config.remoteUrl === 'string' ? config.remoteUrl : '',
    username: typeof config.username === 'string' ? config.username : '',
    displayUrl: typeof config.displayUrl === 'string' ? config.displayUrl : '',
  };
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch (_) {}
  return value;
}

function isLoopbackHostname(hostname) {
  const value = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return value === 'localhost' || value === '::1' || value.startsWith('127.');
}

function normalizeRemoteUrl(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) throw new Error('请输入服务器地址');
  let url;
  try {
    url = new URL(text);
  } catch (_) {
    throw new Error('服务器地址格式不正确');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('服务器地址只支持 http/https');
  }
  if (url.username || url.password) {
    throw new Error('服务器地址不能包含用户名或密码');
  }
  if (url.protocol === 'http:' && !isLoopbackHostname(url.hostname)) {
    throw new Error('远程服务器必须使用 HTTPS（本机地址除外）');
  }
  const pathname = url.pathname.replace(/\/+$/, '');
  if (/\/admin$/i.test(pathname) || /\/display(-v2)?$/i.test(pathname)) {
    throw new Error('服务器地址请填写站点根地址，不要包含 /admin 或 /display');
  }
  return url.origin + pathname;
}

function validateRemoteUrl(raw) {
  try {
    return { ok: true, url: normalizeRemoteUrl(raw), error: '' };
  } catch (error) {
    return { ok: false, url: '', error: error.message };
  }
}

/**
 * 显示端是一个独立的、无标签页的浏览器窗口，因此允许任意 http/https 网址。
 * 不携带账号密码时，HTTP 显示端不会泄露管理端凭据。
 */
function normalizeDisplayUrl(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return '';
  let url;
  try {
    url = new URL(text);
  } catch (_) {
    throw new Error('显示端网址格式不正确');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('显示端网址只支持 http/https');
  }
  if (url.username || url.password) {
    throw new Error('显示端网址不能包含用户名或密码');
  }
  const pathname = url.pathname === '/' ? '' : url.pathname;
  return url.origin + pathname + url.search + url.hash;
}

function validateDisplayUrl(raw) {
  try {
    return { ok: true, url: normalizeDisplayUrl(raw), error: '' };
  } catch (error) {
    return { ok: false, url: '', error: error.message };
  }
}

function withPath(base, suffix, projectId) {
  const root = String(base || '').replace(/\/+$/, '');
  return root + suffix + (projectId ? '?project=' + encodeURIComponent(projectId) : '');
}

function adminUrl(base, projectId) {
  return withPath(base, '/admin', projectId);
}

function displayUrl(base, projectId) {
  return withPath(base, '/display', projectId);
}

/** 远程模式优先使用用户填写的完整显示端网址，否则回退到服务器地址 + /display */
function resolveDisplayUrl(configured, base, projectId) {
  return configured ? configured : displayUrl(base, projectId);
}

function healthUrl(base) {
  return String(base || '').replace(/\/+$/, '') + '/api/version';
}

function sameSiteValue(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (value === 'strict') return 'strict';
  if (value === 'lax') return 'lax';
  if (value === 'none') return 'no_restriction';
  return 'unspecified';
}

/** 把服务端 Set-Cookie 转成 Electron cookies.set 需要的对象 */
function cookieFromSetCookie(origin, header) {
  const text = String(header || '').trim();
  if (!text) return null;
  const parts = text.split(';');
  const pair = parts.shift() || '';
  const index = pair.indexOf('=');
  if (index <= 0) return null;
  const name = pair.slice(0, index).trim();
  const value = pair.slice(index + 1).trim();
  if (!name) return null;
  const cookie = {
    url: origin,
    name,
    value,
    path: '/',
    secure: false,
    httpOnly: false,
    sameSite: 'unspecified',
  };
  for (const part of parts) {
    const attr = part.trim();
    if (!attr) continue;
    const eq = attr.indexOf('=');
    const key = (eq >= 0 ? attr.slice(0, eq) : attr).trim().toLowerCase();
    const attrValue = eq >= 0 ? attr.slice(eq + 1).trim() : '';
    if (key === 'path' && attrValue) cookie.path = attrValue;
    else if (key === 'domain' && attrValue) cookie.domain = attrValue;
    else if (key === 'secure') cookie.secure = true;
    else if (key === 'httponly') cookie.httpOnly = true;
    else if (key === 'samesite') cookie.sameSite = sameSiteValue(attrValue);
    else if (key === 'max-age') {
      const seconds = Number(attrValue);
      if (Number.isFinite(seconds) && seconds > 0) {
        cookie.expirationDate = Math.floor(Date.now() / 1000) + Math.floor(seconds);
      }
    }
  }
  return cookie;
}

module.exports = {
  CONFIG_NAME,
  DEFAULT_CONFIG,
  configPath,
  loadConfig,
  saveConfig,
  isLoopbackHostname,
  normalizeRemoteUrl,
  validateRemoteUrl,
  normalizeDisplayUrl,
  validateDisplayUrl,
  adminUrl,
  displayUrl,
  resolveDisplayUrl,
  healthUrl,
  cookieFromSetCookie,
};
