import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const zoom = require(path.join(ROOT, 'electron/zoom.js'));

test('缩放范围限制在 50%–300%', () => {
  assert.equal(zoom.ZOOM_MIN, 0.5);
  assert.equal(zoom.ZOOM_MAX, 3);
  assert.equal(zoom.clampZoom(0.2), 0.5);
  assert.equal(zoom.clampZoom(5), 3);
  assert.equal(zoom.clampZoom(1.25), 1.25);
  assert.equal(zoom.clampZoom('abc'), 1);
});

test('每档 10%，到边界后不再变化，reset 回到 100%', () => {
  assert.equal(zoom.nextZoom(1, 'in'), 1.1);
  assert.equal(zoom.nextZoom(1, 'out'), 0.9);
  assert.equal(zoom.nextZoom(2.95, 'in'), 3);
  assert.equal(zoom.nextZoom(3, 'in'), 3);
  assert.equal(zoom.nextZoom(0.55, 'out'), 0.5);
  assert.equal(zoom.nextZoom(0.5, 'out'), 0.5);
  assert.equal(zoom.nextZoom(1.3, 'reset'), 1);
});

test('快捷键解析：Ctrl/Cmd + +、-、0，忽略 Alt 与 keyUp', () => {
  const ctrl = (key, extra = {}) => ({
    type: 'keyDown',
    key,
    control: true,
    meta: false,
    alt: false,
    ...extra,
  });
  assert.equal(zoom.zoomCommand(ctrl('=')), 'in');
  assert.equal(zoom.zoomCommand(ctrl('+', { shift: true })), 'in');
  assert.equal(zoom.zoomCommand(ctrl('-')), 'out');
  assert.equal(zoom.zoomCommand(ctrl('_', { shift: true })), 'out');
  assert.equal(zoom.zoomCommand(ctrl('0')), 'reset');
  assert.equal(zoom.zoomCommand(ctrl('a')), null);
  assert.equal(zoom.zoomCommand(ctrl('=', { alt: true })), null);
  assert.equal(zoom.zoomCommand({ type: 'keyUp', key: '=', control: true }), null);

  // macOS 使用 Cmd
  assert.equal(
    zoom.zoomCommand({ type: 'keyDown', key: '=', meta: true, control: false, alt: false }, 'darwin'),
    'in',
  );
  assert.equal(
    zoom.zoomCommand({ type: 'keyDown', key: '=', control: true, meta: false, alt: false }, 'darwin'),
    null,
  );
});
