import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

    assert.equal(mode.normalizeMode('remote'), 'remote-admin', '旧 remote 配置迁移为远程管理');
    assert.equal(mode.normalizeMode('remote-admin'), 'remote-admin');
    assert.equal(mode.normalizeMode('remote-display'), 'remote-display');
    assert.equal(mode.normalizeMode('local'), 'local');
    assert.equal(mode.normalizeMode('unknown'), 'local');
    assert.deepEqual(mode.MODES, ['local', 'remote-admin', 'remote-display']);

    mode.saveConfig(dir, {
      mode: 'remote-admin',
      remoteUrl: 'https://score.example.com/',
      username: 'admin',
      displayUrl: '',
    });
    assert.equal(statSync(mode.configPath(dir)).mode & 0o777, 0o600, '配置文件权限 0600');
    const savedAdmin = JSON.parse(readFileSync(mode.configPath(dir), 'utf8'));
    assert.equal(savedAdmin.mode, 'remote-admin');
    const loaded = mode.loadConfig(dir, {});
    assert.equal(loaded.mode, 'remote-admin');
    assert.equal(loaded.remoteUrl, 'https://score.example.com/');
    assert.equal(loaded.username, 'admin');
    assert.equal(loaded.displayUrl, '');

    mode.saveConfig(dir, {
      mode: 'remote-display',
      remoteUrl: '',
      username: '',
      displayUrl: 'https://display.example.com/screen?project=pr_1',
    });
    const loadedDisplay = mode.loadConfig(dir, {});
    assert.equal(loadedDisplay.mode, 'remote-display');
    assert.equal(loadedDisplay.displayUrl, 'https://display.example.com/screen?project=pr_1');

    // 旧配置文件：mode=remote，自动迁移为远程管理，显示端网址不再附属在管理表单
    writeFileSync(mode.configPath(dir), JSON.stringify({
      mode: 'remote',
      remoteUrl: 'https://legacy.example.com',
      username: 'legacy-admin',
      displayUrl: 'https://legacy.example.com/display?project=pr_old',
    }));
    const legacy = mode.loadConfig(dir, {});
    assert.equal(legacy.mode, 'remote-admin');
    assert.equal(legacy.remoteUrl, 'https://legacy.example.com');
    assert.equal(
      legacy.displayUrl,
      'https://legacy.example.com/display?project=pr_old',
      '旧显示端网址保留给屏幕模式表单回填',
    );

    const envOverride = mode.loadConfig(dir, {
      SCOREBOARD_MODE: 'remote-admin',
      SCOREBOARD_REMOTE_URL: 'https://env.example.com',
      SCOREBOARD_USERNAME: 'env-user',
      SCOREBOARD_DISPLAY_URL: 'https://display.example.com/screen',
    });
    assert.equal(envOverride.mode, 'remote-admin');
    assert.equal(envOverride.remoteUrl, 'https://env.example.com');
    assert.equal(envOverride.username, 'env-user');
    assert.equal(
      envOverride.displayUrl,
      'https://display.example.com/screen',
      'SCOREBOARD_DISPLAY_URL 可回填屏幕模式表单，但不参与管理端显示端 URL',
    );

    const envDisplay = mode.loadConfig(dir, {
      SCOREBOARD_MODE: 'remote-display',
      SCOREBOARD_DISPLAY_URL: 'https://display.example.com/screen',
    });
    assert.equal(envDisplay.mode, 'remote-display');
    assert.equal(envDisplay.displayUrl, 'https://display.example.com/screen');

    const compat = mode.loadConfig(dir, {
      SCOREBOARD_MODE: 'remote',
      SCOREBOARD_URL: 'https://compat.example.com',
    });
    assert.equal(compat.mode, 'remote-admin');
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
