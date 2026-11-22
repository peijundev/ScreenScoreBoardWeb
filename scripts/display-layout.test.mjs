// 团队内成员卡片排列：设置链路与显示端样式契约
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('成员排列提供默认值与三档枚举', () => {
  const settings = readFileSync(path.join(root, 'server/settings.js'), 'utf8');
  assert.match(settings, /teamMemberLayout: 'auto'/);
  assert.match(settings, /\['auto', 'row', 'column'\]\.includes\(v\)/);
  assert.match(settings, /成员卡片排列须为 auto \/ row \/ column/);
  const generated = readFileSync(path.join(root, 'web/src/shared/settings.generated.ts'), 'utf8');
  assert.match(generated, /teamMemberLayout: string;/);
});

test('管理端提供横排 / 竖排 / 自动选项', () => {
  const schema = readFileSync(path.join(root, 'web/src/admin/settings/schema.ts'), 'utf8');
  assert.match(schema, /k: 'teamMemberLayout'/);
  assert.match(schema, /自动（按宽度换行）/);
  assert.match(schema, /横排（一行排开）/);
  assert.match(schema, /竖排（每行一个）/);
});

test('显示端按设置切换排列并应用样式', () => {
  const core = readFileSync(path.join(root, 'web/src/display/lib/core.ts'), 'utf8');
  assert.match(core, /body\.dataset\.memberLayout = s\.teamMemberLayout \|\| 'auto'/);

  const css = readFileSync(path.join(root, 'public/display.css'), 'utf8');
  assert.match(css, /body\[data-member-layout="row"\] \.team-members:not\(\.free\)/);
  assert.match(css, /body\[data-member-layout="row"\] \.team-members:not\(\.free\) \.member/);
  assert.match(css, /body\[data-member-layout="column"\] \.team-members:not\(\.free\)/);
  // 默认网格自动换行，用 auto-fit 让成员卡拉伸铺满
  assert.match(css, /grid-template-columns: repeat\(auto-fit, minmax\(calc\(112px \* var\(--member-scale\)\)/);
});
