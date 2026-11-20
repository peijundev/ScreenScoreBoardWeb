import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = require(path.join(ROOT, 'electron/mode.js'));

test('Electron 模式配置与远程 URL 校验', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sb-electron-mode-'));
  try {
    const initial = mode.loadConfig(dir, {});
    assert.deepEqual(initial, { mode: 'local', remoteUrl: '' });

    mode.saveConfig(dir, { mode: 'remote', remoteUrl: 'https://score.example.com/' });
    const loaded = mode.loadConfig(dir, {});
    assert.equal(loaded.mode, 'remote');
    assert.equal(loaded.remoteUrl, 'https://score.example.com/');

    const envOverride = mode.loadConfig(dir, {
      SCOREBOARD_MODE: 'remote',
      SCOREBOARD_REMOTE_URL: 'https://env.example.com',
    });
    assert.equal(envOverride.mode, 'remote');
    assert.equal(envOverride.remoteUrl, 'https://env.example.com');

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

    assert.equal(mode.adminUrl('https://score.example.com/', 'pr_1'), 'https://score.example.com/admin?project=pr_1');
    assert.equal(mode.displayUrl('https://score.example.com', 'pr_1'), 'https://score.example.com/display?project=pr_1');
    assert.equal(mode.healthUrl('https://score.example.com/'), 'https://score.example.com/api/version');
    assert.equal(mode.isLoopbackHostname('localhost'), true);
    assert.equal(mode.isLoopbackHostname('127.0.0.1'), true);
    assert.equal(mode.isLoopbackHostname('score.example.com'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
