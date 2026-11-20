'use strict';
// Electron 本地/远程模式配置：纯函数，便于在 Node 测试中直接使用
const fs = require('fs');
const path = require('path');

const CONFIG_NAME = 'electron-config.json';
const DEFAULT_CONFIG = Object.freeze({ mode: 'local', remoteUrl: '' });

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
  if (mode === 'remote') {
    remoteUrl = env.SCOREBOARD_REMOTE_URL || env.SCOREBOARD_URL || file.remoteUrl || '';
  }
  return { mode, remoteUrl };
}

function saveConfig(userDataDir, config) {
  fs.mkdirSync(userDataDir, { recursive: true });
  const file = configPath(userDataDir);
  const tmp = file + '.tmp';
  const value = {
    mode: config.mode === 'remote' ? 'remote' : 'local',
    remoteUrl: typeof config.remoteUrl === 'string' ? config.remoteUrl : '',
  };
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
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
  return url.origin + pathname;
}

function validateRemoteUrl(raw) {
  try {
    return { ok: true, url: normalizeRemoteUrl(raw), error: '' };
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

function healthUrl(base) {
  return String(base || '').replace(/\/+$/, '') + '/api/version';
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
  adminUrl,
  displayUrl,
  healthUrl,
};
