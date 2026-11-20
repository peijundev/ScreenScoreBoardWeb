import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = require(path.join(ROOT, 'electron/mode.js'));

test('Electron 模式配置、远程 URL、显示端 URL 与 Cookie 解析', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sb-electron-mode-'));
  try {
    const initial = mode.loadConfig(dir, {});
    assert.deepEqual(initial, {
      mode: 'local',
      remoteUrl: '',
      username: '',
      displayUrl: '',
    });

    mode.saveConfig(dir, {
      mode: 'remote',
      remoteUrl: 'https://score.example.com/',
      username: 'admin',
      displayUrl: 'https://score.example.com/display?project=pr_1',
    });
    assert.equal(statSync(mode.configPath(dir)).mode & 0o777, 0o600, '配置文件权限 0600');
    const loaded = mode.loadConfig(dir, {});
    assert.equal(loaded.mode, 'remote');
    assert.equal(loaded.remoteUrl, 'https://score.example.com/');
    assert.equal(loaded.username, 'admin');
    assert.equal(loaded.displayUrl, 'https://score.example.com/display?project=pr_1');

    const envOverride = mode.loadConfig(dir, {
      SCOREBOARD_MODE: 'remote',
      SCOREBOARD_REMOTE_URL: 'https://env.example.com',
      SCOREBOARD_USERNAME: 'env-user',
      SCOREBOARD_DISPLAY_URL: 'https://display.example.com/screen',
    });
    assert.equal(envOverride.mode, 'remote');
    assert.equal(envOverride.remoteUrl, 'https://env.example.com');
    assert.equal(envOverride.username, 'env-user');
    assert.equal(envOverride.displayUrl, 'https://display.example.com/screen');

    const compat = mode.loadConfig(dir, {
      SCOREBOARD_MODE: 'remote',
      SCOREBOARD_URL: 'https://compat.example.com',
    });
    assert.equal(compat.remoteUrl, 'https://compat.example.com');

    const local = mode.loadConfig(dir, { SCOREBOARD_MODE: 'local' });
    assert.equal(local.mode, 'local');

    assert.equal(mode.normalizeRemoteUrl('https://score.example.com/'), 'https://score.example.com');
    assert.equal(
      mode.normalizeRemoteUrl('https://score.example.com/base/'),
      'https://score.example.com/base',
    );
    assert.equal(mode.normalizeRemoteUrl('http://127.0.0.1:3000/'), 'http://127.0.0.1:3000');
    assert.equal(mode.normalizeRemoteUrl('http://localhost:3000'), 'http://localhost:3000');

    assert.throws(() => mode.normalizeRemoteUrl('http://score.example.com'), /HTTPS/);
    assert.throws(() => mode.normalizeRemoteUrl('ftp://score.example.com'), /http/);
    assert.throws(() => mode.normalizeRemoteUrl('https://user:pass@score.example.com'), /用户名或密码/);
    assert.throws(() => mode.normalizeRemoteUrl('not a url'), /格式/);
    assert.throws(() => mode.normalizeRemoteUrl('https://score.example.com/admin'), /根地址/);

    assert.equal(
      mode.normalizeDisplayUrl('https://score.example.com/display?project=pr_1'),
      'https://score.example.com/display?project=pr_1',
    );
    assert.equal(mode.normalizeDisplayUrl('http://127.0.0.1:3000/display'), 'http://127.0.0.1:3000/display');
    assert.equal(mode.normalizeDisplayUrl(''), '');
    assert.throws(() => mode.normalizeDisplayUrl('ftp://score.example.com'), /http/);
    assert.throws(() => mode.normalizeDisplayUrl('https://user:pass@score.example.com'), /用户名或密码/);

    assert.equal(mode.adminUrl('https://score.example.com/', 'pr_1'), 'https://score.example.com/admin?project=pr_1');
    assert.equal(mode.displayUrl('https://score.example.com', 'pr_1'), 'https://score.example.com/display?project=pr_1');
    assert.equal(
      mode.resolveDisplayUrl('https://display.example.com/screen', 'https://score.example.com', 'pr_1'),
      'https://display.example.com/screen',
    );
    assert.equal(
      mode.resolveDisplayUrl('', 'https://score.example.com', 'pr_1'),
      'https://score.example.com/display?project=pr_1',
    );
    assert.equal(mode.healthUrl('https://score.example.com/'), 'https://score.example.com/api/version');
    assert.equal(mode.isLoopbackHostname('localhost'), true);
    assert.equal(mode.isLoopbackHostname('127.0.0.1'), true);
    assert.equal(mode.isLoopbackHostname('score.example.com'), false);

    const sessionCookie = mode.cookieFromSetCookie(
      'https://score.example.com',
      'ssb_session=abc123; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600; Secure',
    );
    assert.equal(sessionCookie.url, 'https://score.example.com');
    assert.equal(sessionCookie.name, 'ssb_session');
    assert.equal(sessionCookie.value, 'abc123');
    assert.equal(sessionCookie.path, '/');
    assert.equal(sessionCookie.httpOnly, true);
    assert.equal(sessionCookie.secure, true);
    assert.equal(sessionCookie.sameSite, 'lax');
    assert.ok(sessionCookie.expirationDate > Math.floor(Date.now() / 1000));

    const csrfCookie = mode.cookieFromSetCookie(
      'https://score.example.com',
      'ssb_csrf=xyz; Path=/; SameSite=Strict',
    );
    assert.equal(csrfCookie.httpOnly, false);
    assert.equal(csrfCookie.secure, false);
    assert.equal(csrfCookie.sameSite, 'strict');
    assert.equal(mode.cookieFromSetCookie('https://score.example.com', ''), null);
    assert.equal(mode.cookieFromSetCookie('https://score.example.com', 'bad'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
