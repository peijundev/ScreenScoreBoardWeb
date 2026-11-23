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
const docEl = {
  dataset: {},
  style: {
    vars: {},
    setProperty(key, value) {
      this.vars[key] = value;
    },
  },
};
defineGlobal('document', { body, documentElement: docEl });

const {
  ADMIN_THEMES,
  ADMIN_THEME_STORAGE_KEY,
  DEFAULT_ADMIN_THEME,
  normalizeAdminTheme,
  readAdminTheme,
  applyAdminTheme,
} = await import('../web/src/shared/adminTheme.ts');

const {
  ADMIN_RIPPLE_DEFAULTS,
  ADMIN_RIPPLE_LIMITS,
  ADMIN_RIPPLE_STORAGE_KEYS,
  normalizeAdminRipplePrefs,
  readAdminRipplePrefs,
  saveAdminRipplePrefs,
} = await import('../web/src/shared/adminRipple.ts');

const {
  ADMIN_SWITCH_DEFAULTS,
  ADMIN_SWITCH_LIMITS,
  ADMIN_SWITCH_STORAGE_KEYS,
  normalizeAdminSwitchPrefs,
  readAdminSwitchPrefs,
  saveAdminSwitchPrefs,
  applyAdminSwitchPrefs,
  switchHeightFor,
} = await import('../web/src/shared/adminSwitch.ts');

test('提供 Breeze / Adwaita / macOS / Android 各深/浅八套主题', () => {
  const ids = ADMIN_THEMES.map((item) => item.id);
  assert.deepEqual(ids, [
    'breeze-dark', 'breeze-light',
    'adwaita-dark', 'adwaita-light',
    'macos-dark', 'macos-light',
    'android-dark', 'android-light',
  ]);
  assert.equal(DEFAULT_ADMIN_THEME, 'macos-light');
  assert.equal(new Set(ADMIN_THEMES.map((item) => item.group)).size, 4);
});

test('旧值 dark/light 映射到 Breeze，未知值回退默认', () => {
  assert.equal(normalizeAdminTheme('dark'), 'breeze-dark');
  assert.equal(normalizeAdminTheme('light'), 'breeze-light');
  assert.equal(normalizeAdminTheme('adwaita-dark'), 'adwaita-dark');
  assert.equal(normalizeAdminTheme('android-dark'), 'android-dark');
  assert.equal(normalizeAdminTheme('unknown'), 'macos-light');
  assert.equal(normalizeAdminTheme(null), 'macos-light');
  assert.equal(normalizeAdminTheme(undefined), 'macos-light');
});

test('读取并持久化主题', () => {
  memory.clear();
  memory.set(ADMIN_THEME_STORAGE_KEY, 'android-light');
  assert.equal(readAdminTheme(), 'android-light');

  memory.set(ADMIN_THEME_STORAGE_KEY, 'dark');
  assert.equal(readAdminTheme(), 'breeze-dark');

  memory.set(ADMIN_THEME_STORAGE_KEY, 'not-a-theme');
  assert.equal(readAdminTheme(), 'macos-light');

  memory.clear();
  assert.equal(readAdminTheme(), 'macos-light');
});

test('应用主题写入 body 与 localStorage', () => {
  memory.clear();
  body.dataset = {};
  assert.equal(applyAdminTheme('android-dark'), 'android-dark');
  assert.equal(body.dataset.theme, 'android-dark');
  assert.equal(memory.get(ADMIN_THEME_STORAGE_KEY), 'android-dark');

  // persist:false 只改 DOM，不覆盖已保存值
  applyAdminTheme('breeze-light', { persist: false });
  assert.equal(body.dataset.theme, 'breeze-light');
  assert.equal(memory.get(ADMIN_THEME_STORAGE_KEY), 'android-dark');
});

test('CSS 包含八套主题与 macOS 磨砂 / Android M3 变量', () => {
  const css = readFileSync(path.join(root, 'public/admin.css'), 'utf8');
  assert.match(css, /body\[data-theme="dark"\],\s*body\[data-theme="breeze-dark"\]/);
  assert.match(css, /body\[data-theme="light"\],\s*body\[data-theme="breeze-light"\]/);
  assert.match(css, /body\[data-theme="adwaita-dark"\]/);
  assert.match(css, /body\[data-theme="adwaita-light"\]/);
  assert.match(css, /body\[data-theme="macos-dark"\]/);
  assert.match(css, /body\[data-theme="macos-light"\]/);
  assert.match(css, /body\[data-theme="android-dark"\]/);
  assert.match(css, /body\[data-theme="android-light"\]/);
  // macOS：Big Sur 磨砂（半透明 + backdrop-filter）与壁纸
  assert.match(css, /--frost-blur:\s*18px/);
  assert.match(css, /--wallpaper:/);
  assert.match(css, /backdrop-filter:\s*blur\(var\(--frost-blur\)\)\s*saturate\(var\(--frost-saturate\)\)/);
  assert.match(css, /background:\s*var\(--wallpaper\)/);
  // Android：Material 3 baseline 主色与胶囊按钮
  assert.match(css, /--accent:\s*#d0bcff/);
  assert.match(css, /--accent:\s*#6750a4/);
  assert.match(css, /--radius-large:\s*28px/);
  assert.match(css, /body\[data-theme\^="android"\] \.btn[\s\S]*?border-radius:\s*999px/);
  // Android：M3 交互（涟漪、状态层、filled 输入框、elevation）
  assert.match(css, /@keyframes ssb-ripple/);
  assert.match(css, /\.ssb-ripple-host/);
  assert.match(css, /--ripple-opacity/);
  assert.match(css, /--state-hover:/);
  assert.match(css, /--elevation-2:/);
  assert.match(css, /border-bottom:\s*1px solid var\(--border-strong\)/);
  assert.match(css, /\.topbar-popover/);
  // 其余主题变量未被破坏
  assert.match(css, /--accent:\s*#3584e4/);
  assert.match(css, /--accent:\s*#0a84ff/);
  assert.match(css, /--accent:\s*#007aff/);
  assert.match(css, /--radius-large:\s*0px/);
  assert.match(css, /--on-positive:\s*#ffffff/);
  assert.match(css, /border-radius:\s*var\(--radius-large, var\(--radius, 0\)\)/);
});

test('Android 涟漪默认开启，时长与强度有边界', () => {
  assert.deepEqual(ADMIN_RIPPLE_DEFAULTS, { enabled: true, durationMs: 450, opacity: 0.14 });
  assert.deepEqual(normalizeAdminRipplePrefs(), ADMIN_RIPPLE_DEFAULTS);
  assert.equal(normalizeAdminRipplePrefs({ durationMs: 10 }).durationMs, ADMIN_RIPPLE_LIMITS.durationMs.min);
  assert.equal(normalizeAdminRipplePrefs({ durationMs: 99999 }).durationMs, ADMIN_RIPPLE_LIMITS.durationMs.max);
  assert.equal(normalizeAdminRipplePrefs({ opacity: 0 }).opacity, ADMIN_RIPPLE_LIMITS.opacity.min);
  assert.equal(normalizeAdminRipplePrefs({ opacity: 9 }).opacity, ADMIN_RIPPLE_LIMITS.opacity.max);
  assert.equal(normalizeAdminRipplePrefs({ enabled: 'off' }).enabled, false);
  assert.equal(normalizeAdminRipplePrefs({ enabled: 'on' }).enabled, true);
  assert.equal(normalizeAdminRipplePrefs({ durationMs: 'abc' }).durationMs, ADMIN_RIPPLE_DEFAULTS.durationMs);
});

test('涟漪偏好持久化并可关闭', () => {
  memory.clear();
  const saved = saveAdminRipplePrefs({ enabled: false, durationMs: 600, opacity: 0.2 });
  assert.deepEqual(saved, { enabled: false, durationMs: 600, opacity: 0.2 });
  assert.equal(memory.get(ADMIN_RIPPLE_STORAGE_KEYS.enabled), 'off');
  assert.deepEqual(readAdminRipplePrefs(), saved);

  // 越界值读取时收敛到边界
  memory.set(ADMIN_RIPPLE_STORAGE_KEYS.durationMs, '99999');
  memory.set(ADMIN_RIPPLE_STORAGE_KEYS.opacity, '-1');
  assert.equal(readAdminRipplePrefs().durationMs, ADMIN_RIPPLE_LIMITS.durationMs.max);
  assert.equal(readAdminRipplePrefs().opacity, ADMIN_RIPPLE_LIMITS.opacity.min);

  memory.clear();
  assert.deepEqual(readAdminRipplePrefs(), ADMIN_RIPPLE_DEFAULTS);
});

test('苹果风格开关默认开启，尺寸与动画有边界', () => {
  assert.deepEqual(ADMIN_SWITCH_DEFAULTS, { enabled: true, size: 44, durationMs: 180 });
  assert.deepEqual(normalizeAdminSwitchPrefs(), ADMIN_SWITCH_DEFAULTS);
  assert.equal(normalizeAdminSwitchPrefs({ size: 1 }).size, ADMIN_SWITCH_LIMITS.size.min);
  assert.equal(normalizeAdminSwitchPrefs({ size: 999 }).size, ADMIN_SWITCH_LIMITS.size.max);
  assert.equal(
    normalizeAdminSwitchPrefs({ durationMs: 1 }).durationMs,
    ADMIN_SWITCH_LIMITS.durationMs.min,
  );
  assert.equal(
    normalizeAdminSwitchPrefs({ durationMs: 99999 }).durationMs,
    ADMIN_SWITCH_LIMITS.durationMs.max,
  );
  assert.equal(normalizeAdminSwitchPrefs({ enabled: 'off' }).enabled, false);
  assert.equal(normalizeAdminSwitchPrefs({ enabled: 'on' }).enabled, true);
  assert.equal(normalizeAdminSwitchPrefs({ size: 'abc' }).size, ADMIN_SWITCH_DEFAULTS.size);
  // 高度按比例推导，保持胶囊比例
  assert.equal(switchHeightFor(44), 25);
  assert.equal(switchHeightFor(ADMIN_SWITCH_LIMITS.size.min), 18);
});

test('开关偏好持久化、可关闭并应用到根元素', () => {
  memory.clear();
  const saved = saveAdminSwitchPrefs({ enabled: false, size: 52, durationMs: 320 });
  assert.deepEqual(saved, { enabled: false, size: 52, durationMs: 320 });
  assert.equal(memory.get(ADMIN_SWITCH_STORAGE_KEYS.enabled), 'off');
  assert.deepEqual(readAdminSwitchPrefs(), saved);

  // 越界值读取时收敛到边界
  memory.set(ADMIN_SWITCH_STORAGE_KEYS.size, '999');
  memory.set(ADMIN_SWITCH_STORAGE_KEYS.durationMs, '-5');
  assert.equal(readAdminSwitchPrefs().size, ADMIN_SWITCH_LIMITS.size.max);
  assert.equal(readAdminSwitchPrefs().durationMs, ADMIN_SWITCH_LIMITS.durationMs.min);

  const applied = applyAdminSwitchPrefs({ enabled: true, size: 48, durationMs: 240 });
  assert.deepEqual(applied, { enabled: true, size: 48, durationMs: 240 });
  assert.equal(docEl.dataset.adminSwitch, 'on');
  assert.equal(docEl.style.vars['--switch-w'], '48px');
  assert.equal(docEl.style.vars['--switch-h'], '27px');
  assert.equal(docEl.style.vars['--switch-dur'], '240ms');

  applyAdminSwitchPrefs({ enabled: false, size: 48, durationMs: 240 });
  assert.equal(docEl.dataset.adminSwitch, 'off');

  memory.clear();
  assert.deepEqual(readAdminSwitchPrefs(), ADMIN_SWITCH_DEFAULTS);
});

test('开关样式与入口挂载已生效', () => {
  const css = readFileSync(path.join(root, 'public/admin.css'), 'utf8');
  assert.match(css, /html\[data-admin-switch="on"\] input\[type="checkbox"\]/);
  assert.match(css, /appearance:\s*none/);
  assert.match(css, /--switch-w/);
  assert.match(css, /--switch-dur/);
  assert.match(css, /:checked::before\s*\{[^}]*translateX\(calc\(var\(--switch-w/);
  assert.match(css, /\.topbar-popover-trigger/);
  const picker = readFileSync(
    path.join(root, 'web/src/admin/components/AdminThemePicker.tsx'),
    'utf8',
  );
  assert.match(picker, /useAdminSwitch/);
  assert.match(picker, /苹果风格开关/);
  assert.match(picker, /TopbarPopover/);
  // 顶栏在 macOS 主题下带 backdrop-filter，面板必须 portal 到 body 才不会被内容盖住
  const popover = readFileSync(
    path.join(root, 'web/src/admin/components/TopbarPopover.tsx'),
    'utf8',
  );
  assert.match(popover, /createPortal/);
  assert.match(popover, /document\.body/);
  const main = readFileSync(path.join(root, 'web/src/admin/main.tsx'), 'utf8');
  assert.match(main, /applyAdminSwitchPrefs\(readAdminSwitchPrefs\(\)\)/);
});

test('涟漪安装器已挂载到管理端入口', () => {
  const ripple = readFileSync(path.join(root, 'web/src/admin/ripple.ts'), 'utf8');
  assert.match(ripple, /installAndroidRipple/);
  assert.match(ripple, /pointerdown/);
  assert.match(ripple, /dataset\.theme\?\.startsWith\('android'\)/);
  const main = readFileSync(path.join(root, 'web/src/admin/main.tsx'), 'utf8');
  assert.match(main, /installAndroidRipple\(\)/);
});

test('管理端入口包含首屏主题初始化脚本', () => {
  const html = readFileSync(path.join(root, 'web/admin.html'), 'utf8');
  assert.match(html, /admin-theme/);
  assert.match(html, /breeze-dark/);
  assert.match(html, /adwaita-dark/);
  assert.match(html, /macos-dark/);
  assert.match(html, /android-dark/);
  assert.match(html, /android-light/);
  assert.match(html, /document\.body\.dataset\.theme/);
  assert.match(html, /data-theme="macos-light"/);
  assert.match(html, /macos-light/);
});
