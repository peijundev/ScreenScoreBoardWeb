// 居中突显自动缩放与数值直填：共享计算、设置链路与控件契约
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const {
  SPOTLIGHT_LIMITS,
  SPOTLIGHT_BASE_WIDTH,
  SPOTLIGHT_BASE_AVATAR,
  spotlightMetrics,
} = await import('../web/src/shared/spotlightMetrics.ts');

test('突显尺寸范围已扩大', () => {
  assert.deepEqual(SPOTLIGHT_LIMITS, {
    width: { min: 200, max: 4000 },
    height: { min: 0, max: 3000 },
    fontScale: { min: 0.5, max: 8 },
    avatarSize: { min: 24, max: 1024 },
  });
  assert.equal(SPOTLIGHT_BASE_WIDTH, 520);
  assert.equal(SPOTLIGHT_BASE_AVATAR, 96);
});

test('自动模式让字号与头像跟随突显宽度', () => {
  const normal = spotlightMetrics({ spotlightWidth: 520, spotlightAutoScale: false });
  assert.equal(normal.fontScale, 1);
  assert.equal(normal.avatarSize, 96);
  assert.equal(normal.auto, false);

  const half = spotlightMetrics({ spotlightWidth: 260, spotlightAutoScale: true });
  assert.equal(half.fontScale, 0.5);
  assert.equal(half.avatarSize, 48);

  const wide = spotlightMetrics({ spotlightWidth: 1600, spotlightAutoScale: true });
  assert.equal(wide.fontScale, 3.08);
  assert.equal(wide.avatarSize, 295);

  const huge = spotlightMetrics({ spotlightWidth: 4000, spotlightAutoScale: true });
  assert.equal(huge.fontScale, 7.69);
  assert.equal(huge.avatarSize, 738);

  // 手动值在自动模式下不生效
  const overridden = spotlightMetrics({
    spotlightWidth: 1040,
    spotlightAutoScale: true,
    spotlightFontScale: 1.2,
    spotlightAvatarSize: 120,
  });
  assert.equal(overridden.fontScale, 2);
  assert.equal(overridden.avatarSize, 192);
});

test('按比例放大模式不再单独放大字号与头像', () => {
  const scaleMode = spotlightMetrics({
    spotlightSizeMode: 'scale',
    spotlightWidth: 1600,
    spotlightAutoScale: true,
    spotlightFontScale: 2.5,
    spotlightAvatarSize: 240,
  });
  assert.equal(scaleMode.proportional, true);
  assert.equal(scaleMode.auto, false);
  assert.equal(scaleMode.height, 0);
  assert.equal(scaleMode.width, 1600);
  // 内部尺寸保持原值，由整体缩放完成
  assert.equal(scaleMode.fontScale, 2.5);
  assert.equal(scaleMode.avatarSize, 240);

  const custom = spotlightMetrics({ spotlightSizeMode: 'custom' });
  assert.equal(custom.proportional, false);
  assert.equal(custom.auto, false);
});

test('手动模式保留字号与头像设置并限制到范围内', () => {
  const manual = spotlightMetrics({
    spotlightWidth: 1600,
    spotlightAutoScale: false,
    spotlightFontScale: 2.4,
    spotlightAvatarSize: 240,
  });
  assert.equal(manual.fontScale, 2.4);
  assert.equal(manual.avatarSize, 240);
  assert.equal(manual.width, 1600);

  const clamped = spotlightMetrics({
    spotlightWidth: 99999,
    spotlightHeight: 99999,
    spotlightFontScale: 99,
    spotlightAvatarSize: 99999,
  });
  assert.equal(clamped.width, SPOTLIGHT_LIMITS.width.max);
  assert.equal(clamped.height, SPOTLIGHT_LIMITS.height.max);
  assert.equal(clamped.fontScale, SPOTLIGHT_LIMITS.fontScale.max);
  assert.equal(clamped.avatarSize, SPOTLIGHT_LIMITS.avatarSize.max);
});

test('服务端默认值与校验范围同步', () => {
  const settings = readFileSync(path.join(root, 'server/settings.js'), 'utf8');
  assert.match(settings, /spotlightSizeMode: 'custom'/);
  assert.match(settings, /突显尺寸模式须为 custom 或 scale/);
  assert.match(settings, /spotlightAutoScale: false/);
  assert.match(settings, /突显宽度须为 200–4000/);
  assert.match(settings, /突显高度须为 0–3000/);
  assert.match(settings, /突显字号缩放须在 0\.5–8 之间/);
  assert.match(settings, /突显头像大小须为 24–1024/);
  const generated = readFileSync(path.join(root, 'web/src/shared/settings.generated.ts'), 'utf8');
  assert.match(generated, /spotlightSizeMode: string;/);
  assert.match(generated, /spotlightAutoScale: boolean;/);
});

test('显示端与管理端接入自动缩放与等比放大', () => {
  const core = readFileSync(path.join(root, 'web/src/display/lib/core.ts'), 'utf8');
  assert.match(core, /spotlightMetrics/);
  assert.match(core, /!metrics\.proportional && \(metrics\.auto \|\| s\.spotlightAvatarSizeMode === 'manual'\)/);
  // 按比例放大：保持原卡片尺寸，用整体缩放填满目标框
  assert.match(core, /s\.spotlightSizeMode === 'scale'/);
  assert.match(core, /clone\.style\.transform = 'scale\(' \+ ratio \+ '\)'/);
  assert.match(core, /spotlight-scaled/);
  // 图片式缩放动画：从原卡片位置放大、停留、缩回，并保留联动避开
  assert.match(core, /function spawnSpotlightZoom/);
  assert.match(core, /function runSqueezeAway/);
  assert.match(core, /s\.spotlightSizeMode === 'scale'\) \{\s*const setup = theme === 'squeeze'/);
  // 半透明 / 亚克力卡片放大后要用实心底色还原原卡片观感
  assert.match(core, /--card-solid/);
  // 并列模式有独立渲染路径，也必须支持按比例放大
  const parallel = readFileSync(path.join(root, 'web/src/display/lib/spotlight.ts'), 'utf8');
  assert.match(parallel, /s\.spotlightSizeMode === 'scale'/);
  assert.match(parallel, /clone\.style\.transform = 'scale\(' \+ ratio \+ '\)'/);
  assert.match(parallel, /spotlight-scaled/);
  const css = readFileSync(path.join(root, 'public/display.css'), 'utf8');
  assert.match(css, /body\[data-card-surface="acrylic"\] \.spotlight-card/);
  assert.match(css, /body\[data-card-surface="translucent"\] \.spotlight-card/);

  const schema = readFileSync(path.join(root, 'web/src/admin/settings/schema.ts'), 'utf8');
  assert.match(schema, /k: 'spotlightSizeMode'/);
  assert.match(schema, /原卡片按比例放大（图片式缩放/);
  assert.match(schema, /k: 'spotlightAutoScale'/);
  assert.match(schema, /字号与头像随突显宽度自动缩放/);
  assert.match(schema, /k: 'spotlightWidth', label: '突显宽度', min: 200, max: 4000/);
  assert.match(schema, /k: 'spotlightFontScale',[\s\S]*?max: 8/);
  assert.match(schema, /k: 'spotlightAvatarSize',[\s\S]*?max: 1024/);
  assert.match(schema, /s\.spotlightSizeMode === 'scale'/);
});

test('突显设置只在选择居中放大突显时显示，压暗对两种特效生效', () => {
  const schema = readFileSync(path.join(root, 'web/src/admin/settings/schema.ts'), 'utf8');
  assert.match(schema, /title: '居中放大突显'/);
  assert.match(schema, /visible: \(s\) => s\.scoreEffect === 'spotlight'/);
  assert.match(
    schema,
    /visible: \(s\) => s\.scoreEffect === 'spotlight' \|\| s\.scoreEffect === 'highlight'/,
  );
  // 压暗设置已移出突显分组，位于通用特效分组
  const dialog = readFileSync(
    path.join(root, 'web/src/admin/components/SettingsDialog.tsx'),
    'utf8',
  );
  assert.match(dialog, /group\.visible \|\| group\.visible\(project\.settings\)/);
  assert.match(dialog, /field\.visible \|\| field\.visible\(project\.settings\)/);

  const css = readFileSync(path.join(root, 'public/display.css'), 'utf8');
  assert.match(css, /\.highlight-scrim \{[\s\S]*?var\(--spot-scrim-alpha/);
});

test('所有滑块都提供数值直填输入框', () => {
  const control = readFileSync(path.join(root, 'web/src/admin/settings/FieldControl.tsx'), 'utf8');
  assert.match(control, /className="range-row"/);
  assert.match(control, /className="range-number"/);
  assert.match(control, /snapToStep/);
  assert.match(control, /title="直接输入数值"/);

  const css = readFileSync(path.join(root, 'public/admin.css'), 'utf8');
  assert.match(css, /\.settings-form \.range-number/);
  assert.match(css, /\.settings-form \.range-row input\[type="range"\]/);
  // Android 主题的 filled 输入框不能把数值框也套进去
  assert.match(css, /:not\(\.range-number\)/);
});

test('团队突显使用独立团队/队长大卡片，抢答开始提示可开关', () => {
  const app = readFileSync(path.join(root, 'web/src/display/App.tsx'), 'utf8');
  assert.match(app, /function teamSpotlightEl/);
  assert.match(app, /teamSpotlightCard === 'captain'/);
  assert.match(app, /spotlight-team-card/);
  assert.match(app, /buzzShowStartPrompt/);
  assert.match(app, /prompt=\{buzzStartPrompt \? '开始抢答'/);

  const overlays = readFileSync(
    path.join(root, 'web/src/display/components/Overlays.tsx'),
    'utf8',
  );
  assert.match(overlays, /prompt\?: string/);
  assert.match(overlays, /第一个按下的队员获胜/);

  const css = readFileSync(path.join(root, 'public/display.css'), 'utf8');
  assert.match(css, /\.spotlight-team-card/);
  assert.match(css, /\.countdown-big\.is-buzz-start/);

  const schema = readFileSync(path.join(root, 'web/src/admin/settings/schema.ts'), 'utf8');
  assert.match(schema, /k: 'teamSpotlightCard'/);
  const dialog = readFileSync(
    path.join(root, 'web/src/admin/components/MemberMenuDialog.tsx'),
    'utf8',
  );
  assert.match(dialog, /buzzShowStartPrompt/);
});

test('特效空引用与「显示不跟设置」修复契约', () => {
  const app = readFileSync(path.join(root, 'web/src/display/App.tsx'), 'utf8');
  const core = readFileSync(path.join(root, 'web/src/display/lib/core.ts'), 'utf8');
  const css = readFileSync(path.join(root, 'public/display.css'), 'utf8');
  const canvas = readFileSync(path.join(root, 'web/src/display/theme/ThemeCanvas.tsx'), 'utf8');
  const codec = readFileSync(path.join(root, 'web/src/admin/theme/codec.ts'), 'utf8');
  const preview = readFileSync(path.join(root, 'web/src/admin/components/PreviewPanel.tsx'), 'utf8');

  assert.match(app, /function isPreviewTheme/, '预览主题结构校验存在');
  assert.match(app, /setPreviewTheme\(isPreviewTheme/, '非法预览主题不会进入渲染');
  assert.match(app, /realTeamCard/, '团队突显读取真实团队卡位置');
  assert.match(app, /new DOMRect\(/, '团队突显起点使用真实卡片坐标');
  assert.match(app, /interruptSpotlights\(0\)/, '切换项目清理普通突显');
  assert.match(app, /'rank-up', 'rank-down'\)/, '名次动画结束后移除 class');
  assert.match(app, /data-team-score/, '团队总分参与滚动数字');
  assert.match(app, /Number\.isFinite\(volume\)/, '背景音乐音量非法值有回退');
  assert.match(core, /export function effectDuration/, '特效时长统一校验');
  assert.match(core, /effectDuration\(s\)/, '特效时长使用统一校验');
  assert.match(core, /configuredCardBg/, 'auto 卡片底色忽略残留自定义颜色');
  assert.match(css, /data-score-effect="float"/, '飘浮数字有独立动画');
  assert.doesNotMatch(css, /data-display-style="custom"\] \.rank/, '自由配置不再强制隐藏名次');
  assert.match(canvas, /Array\.isArray\(theme\.layers\)/, '主题画布对缺字段主题降级');
  assert.match(codec, /assertV2Theme/, '主题导入校验 v2 结构');
  assert.match(preview, /function writeStorage/, '预览面板 localStorage 写入有异常保护');
});
