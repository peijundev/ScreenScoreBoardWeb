// 显示端逻辑分辨率：解析、设置链路与画布缩放契约
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const {
  DISPLAY_RESOLUTION_LIMITS,
  DISPLAY_RESOLUTION_SCALE_DEFAULT,
  displayContentScale,
  parseDisplayResolution,
  formatDisplayResolution,
} = await import('../web/src/shared/displayResolution.ts');

test('逻辑分辨率只接受 auto 或合法 WxH', () => {
  assert.equal(parseDisplayResolution('auto'), null);
  assert.deepEqual(parseDisplayResolution('3840x2160'), { w: 3840, h: 2160 });
  assert.deepEqual(parseDisplayResolution(' 1280x720 '), { w: 1280, h: 720 });
  assert.deepEqual(parseDisplayResolution('320x240'), { w: 320, h: 240 });
  assert.equal(parseDisplayResolution('3840X2160'), null);
  assert.equal(parseDisplayResolution('3840x2160x1'), null);
  assert.equal(parseDisplayResolution('4k'), null);
  assert.equal(parseDisplayResolution(''), null);
  assert.equal(parseDisplayResolution('100x100'), null);
  assert.equal(parseDisplayResolution('99999x2160'), null);
  assert.equal(parseDisplayResolution('3840x99999'), null);
  assert.equal(parseDisplayResolution(undefined), null);
  assert.equal(parseDisplayResolution(null), null);
  assert.equal(parseDisplayResolution({ w: 3840, h: 2160 }), null);
});

test('分辨率边界与格式化', () => {
  assert.deepEqual(DISPLAY_RESOLUTION_LIMITS, {
    minW: 320,
    maxW: 15360,
    minH: 240,
    maxH: 8640,
  });
  assert.deepEqual(parseDisplayResolution('15360x8640'), { w: 15360, h: 8640 });
  assert.equal(parseDisplayResolution('319x240'), null);
  assert.equal(parseDisplayResolution('320x239'), null);
  assert.equal(formatDisplayResolution(3840, 2160), '3840x2160');
  assert.equal(formatDisplayResolution(3840.4, 2160.6), '3840x2161');
});

test('放大强度在 1080p 与目标分辨率之间插值', () => {
  assert.equal(DISPLAY_RESOLUTION_SCALE_DEFAULT, 50);
  assert.equal(displayContentScale(3840, 2160, 0), 1);
  assert.equal(displayContentScale(3840, 2160, 50), 1.5);
  assert.equal(displayContentScale(3840, 2160, 100), 2);
  assert.equal(displayContentScale(1920, 1080, 100), 1);
  assert.ok(Math.abs(displayContentScale(1280, 720, 100) - 2 / 3) < 1e-9);
  // 缺省或非法强度回退到默认 50%
  assert.equal(displayContentScale(3840, 2160, undefined), 1.5);
  assert.equal(displayContentScale(3840, 2160, 'abc'), 1.5);
  // 越界强度收敛到 0–100
  assert.equal(displayContentScale(3840, 2160, 200), 2);
  assert.equal(displayContentScale(3840, 2160, -10), 1);
});

test('服务端提供默认值与格式校验', () => {
  const settings = readFileSync(path.join(root, 'server/settings.js'), 'utf8');
  assert.match(settings, /displayResolution: 'auto'/);
  assert.match(settings, /displayResolutionScale: 50/);
  assert.match(settings, /显示分辨率须为 auto 或 WxH/);
  assert.match(settings, /显示分辨率须在 320–15360 × 240–8640 之间/);
  assert.match(settings, /显示分辨率放大强度须为 0–100/);
});

test('预览面板把所选分辨率写入项目设置', () => {
  const panel = readFileSync(path.join(root, 'web/src/admin/components/PreviewPanel.tsx'), 'utf8');
  assert.match(panel, /formatDisplayResolution/);
  assert.match(panel, /parseDisplayResolution/);
  assert.match(panel, /patch: \{ displayResolution:/);
  // 放大强度同样写入项目设置，并在固定分辨率时出现滑杆
  assert.match(panel, /displayResolutionScale/);
  assert.match(panel, /updateResScale/);
  assert.match(panel, /preview-res-scale/);
  // 真值来自项目设置，不再用 localStorage 里的旧预览分辨率
  assert.doesNotMatch(panel, /localStorage\.getItem\('previewResolution'/);
});

test('显示端按逻辑分辨率渲染画布并缩放', () => {
  const app = readFileSync(path.join(root, 'web/src/display/App.tsx'), 'utf8');
  assert.match(app, /parseDisplayResolution/);
  assert.match(app, /dataset\.displayResolution/);
  assert.match(app, /--display-scale/);
  assert.match(app, /window\.addEventListener\('resize', apply\)/);
  // 内容按 1080p 基准排版后按强度放大，卡片/字号/间距随分辨率变大
  assert.match(app, /displayContentScale/);
  assert.match(app, /displayResolutionScale/);
  assert.match(app, /--canvas-w/);
  assert.match(app, /--canvas-scale/);
  assert.match(app, /display-canvas/);

  const css = readFileSync(path.join(root, 'public/display.css'), 'utf8');
  assert.match(css, /body\[data-display-resolution="on"\]/);
  assert.match(css, /width: var\(--display-w\)/);
  assert.match(css, /transform: translate\(var\(--display-ox[\s\S]*?scale\(var\(--display-scale/);
  assert.match(css, /\.display-canvas \{ display: contents; \}/);
  assert.match(css, /body\[data-display-resolution="on"\] \.display-canvas \{[\s\S]*?transform: scale\(var\(--canvas-scale/);
  // 画布模式下列数跟随画布而非真实窗口
  assert.match(css, /body\[data-display-resolution="on"\] \.board/);
  // 布局铺开与字号放大强度分开：卡片墙始终占画布 94%
  assert.match(css, /max-width: max\(94%, var\(--board-max/);
});
