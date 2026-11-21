// 管理端主题：归一化、持久化与 CSS/HTML 契约
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function defineGlobal(name, value) {
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
  });
}

const memory = new Map();
defineGlobal('localStorage', {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => { memory.set(key, String(value)); },
  removeItem: (key) => { memory.delete(key); },
  clear: () => memory.clear(),
  key: (index) => Array.from(memory.keys())[index] ?? null,
  get length() { return memory.size; },
});
const body = { dataset: {} };
defineGlobal('document', { body });

const {
  ADMIN_THEMES,
  ADMIN_THEME_STORAGE_KEY,
  DEFAULT_ADMIN_THEME,
  normalizeAdminTheme,
  readAdminTheme,
  applyAdminTheme,
} = await import('../web/src/shared/adminTheme.ts');

test('提供 Breeze / Adwaita / macOS 各深/浅六套主题', () => {
  const ids = ADMIN_THEMES.map((item) => item.id);
  assert.deepEqual(ids, [
    'breeze-dark', 'breeze-light',
    'adwaita-dark', 'adwaita-light',
    'macos-dark', 'macos-light',
  ]);
  assert.equal(DEFAULT_ADMIN_THEME, 'breeze-dark');
  assert.equal(new Set(ADMIN_THEMES.map((item) => item.group)).size, 3);
});

test('旧值 dark/light 映射到 Breeze，未知值回退默认', () => {
  assert.equal(normalizeAdminTheme('dark'), 'breeze-dark');
  assert.equal(normalizeAdminTheme('light'), 'breeze-light');
  assert.equal(normalizeAdminTheme('adwaita-dark'), 'adwaita-dark');
  assert.equal(normalizeAdminTheme('unknown'), 'breeze-dark');
  assert.equal(normalizeAdminTheme(null), 'breeze-dark');
  assert.equal(normalizeAdminTheme(undefined), 'breeze-dark');
});

test('读取并持久化主题', () => {
  memory.clear();
  memory.set(ADMIN_THEME_STORAGE_KEY, 'adwaita-light');
  assert.equal(readAdminTheme(), 'adwaita-light');

  memory.set(ADMIN_THEME_STORAGE_KEY, 'dark');
  assert.equal(readAdminTheme(), 'breeze-dark');

  memory.set(ADMIN_THEME_STORAGE_KEY, 'not-a-theme');
  assert.equal(readAdminTheme(), 'breeze-dark');

  memory.clear();
  assert.equal(readAdminTheme(), 'breeze-dark');
});

test('应用主题写入 body 与 localStorage', () => {
  memory.clear();
  body.dataset = {};
  assert.equal(applyAdminTheme('adwaita-dark'), 'adwaita-dark');
  assert.equal(body.dataset.theme, 'adwaita-dark');
  assert.equal(memory.get(ADMIN_THEME_STORAGE_KEY), 'adwaita-dark');

  // persist:false 只改 DOM，不覆盖已保存值
  applyAdminTheme('breeze-light', { persist: false });
  assert.equal(body.dataset.theme, 'breeze-light');
  assert.equal(memory.get(ADMIN_THEME_STORAGE_KEY), 'adwaita-dark');
});

test('CSS 包含六套主题与 Adwaita / macOS 变量', () => {
  const css = readFileSync(path.join(root, 'public/admin.css'), 'utf8');
  assert.match(css, /body\[data-theme="dark"\],\s*body\[data-theme="breeze-dark"\]/);
  assert.match(css, /body\[data-theme="light"\],\s*body\[data-theme="breeze-light"\]/);
  assert.match(css, /body\[data-theme="adwaita-dark"\]/);
  assert.match(css, /body\[data-theme="adwaita-light"\]/);
  assert.match(css, /body\[data-theme="macos-dark"\]/);
  assert.match(css, /body\[data-theme="macos-light"\]/);
  assert.match(css, /--accent:\s*#3584e4/);
  assert.match(css, /--accent:\s*#0a84ff/);
  assert.match(css, /--accent:\s*#007aff/);
  assert.match(css, /--radius:\s*8px/);
  assert.match(css, /--radius:\s*6px/);
  assert.match(css, /--radius-large:\s*0px/);
  assert.match(css, /--on-positive:\s*#ffffff/);
  assert.match(css, /border-radius:\s*var\(--radius-large, var\(--radius, 0\)\)/);
});

test('管理端入口包含首屏主题初始化脚本', () => {
  const html = readFileSync(path.join(root, 'web/admin.html'), 'utf8');
  assert.match(html, /admin-theme/);
  assert.match(html, /breeze-dark/);
  assert.match(html, /adwaita-dark/);
  assert.match(html, /macos-dark/);
  assert.match(html, /document\.body\.dataset\.theme/);
});
