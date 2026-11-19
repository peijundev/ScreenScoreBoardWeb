import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  THEME_FORMAT, THEME_VERSION, normalizeTheme, themeSummary,
} = require('../server/theme/schema.js');

function theme(extra = {}) {
  return {
    format: THEME_FORMAT,
    version: THEME_VERSION,
    meta: { name: '测试主题', baseStyle: 'custom' },
    canvas: { width: 1920, height: 1080 },
    layers: [],
    widgets: [],
    settings: {},
    ...extra,
  };
}

test('v2 主题归一化并生成摘要', () => {
  const t = normalizeTheme(theme({
    layers: [{
      name: '背景',
      nodes: [{ type: 'rect', x: 10, y: 20, w: 300, h: 200, fill: '#112233' }],
    }],
    widgets: [{ type: 'title', surface: 'canvas', props: { fontSize: 64 } }],
    settings: { accent: '#e8a33d', cardRadius: 16 },
  }), { id: 'th_test' });
  assert.equal(t.meta.id, 'th_test');
  assert.equal(t.layers.length, 1);
  assert.equal(t.layers[0].nodes[0].fill, '#112233');
  assert.equal(t.widgets[0].type, 'title');
  assert.equal(t.settings.cardRadius, 16);
  const summary = themeSummary(t);
  assert.equal(summary.id, 'th_test');
  assert.ok(summary.bytes > 0);
});

test('v1 主题升级为 v2', () => {
  const t = normalizeTheme({
    format: THEME_FORMAT,
    version: 1,
    name: '旧主题',
    author: '作者',
    description: '说明',
    baseStyle: 'ppt',
    settings: { accent: '#112233' },
  }, { id: 'th_v1' });
  assert.equal(t.version, 2);
  assert.equal(t.meta.name, '旧主题');
  assert.equal(t.meta.baseStyle, 'ppt');
  assert.equal(t.settings.accent, '#112233');
  assert.deepEqual(t.layers, []);
});

test('拒绝非白名单设置项与非法值', () => {
  assert.throws(
    () => normalizeTheme(theme({ settings: { title: '不允许' } })),
    /不支持的设置项/,
  );
  assert.throws(
    () => normalizeTheme(theme({ settings: { accent: 'red' } })),
    /强调色/,
  );
});

test('主题脚本归一化：启用、入口名与源码上限', () => {
  const t = normalizeTheme(theme({
    script: { enabled: true, source: 'function drawTheme(ctx) { return []; }', entry: 'drawTheme' },
  }));
  assert.equal(t.script.enabled, true);
  assert.equal(t.script.entry, 'drawTheme');
  assert.match(t.script.source, /function drawTheme/);

  assert.throws(
    () => normalizeTheme(theme({ script: { enabled: true, source: '   ' } })),
    /必须提供源码/,
  );
  assert.throws(
    () => normalizeTheme(theme({ script: { enabled: true, source: 'x'.repeat(33 * 1024) } })),
    /脚本过长/,
  );
  const fallback = normalizeTheme(theme({
    script: { enabled: true, source: 'return [];', entry: 'x; alert(1)' },
  }));
  assert.equal(fallback.script.entry, 'drawTheme', '非法入口名回退到 drawTheme');
});

test('拒绝非法图片源', () => {
  assert.throws(
    () => normalizeTheme(theme({
      layers: [{ nodes: [{ type: 'image', src: 'https://example.com/a.png' }] }],
    })),
    /图片路径非法/,
  );
});

test('限额：图层/节点/路径点', () => {
  const tooManyLayers = Array.from({ length: 51 }, () => ({ nodes: [] }));
  assert.throws(() => normalizeTheme(theme({ layers: tooManyLayers })), /图层数量/);
  const tooManyNodes = Array.from({ length: 501 }, () => ({ type: 'rect' }));
  assert.throws(
    () => normalizeTheme(theme({ layers: [{ nodes: tooManyNodes }] })),
    /元素数量/,
  );
  const tooManyPoints = Array.from({ length: 501 }, () => ({ x: 0, y: 0 }));
  assert.throws(
    () => normalizeTheme(theme({
      layers: [{ nodes: [{ type: 'path', points: tooManyPoints }] }],
    })),
    /路径节点/,
  );
});

test('节点类型保留：圆为 ellipse，线段允许有符号宽高', () => {
  const t = normalizeTheme(theme({
    layers: [{
      nodes: [
        { type: 'ellipse', x: 0, y: 0, w: 180, h: 180, radius: 18 },
        { type: 'line', x: 900, y: 700, w: -320, h: -240 },
        { type: 'rect', x: 0, y: 0, w: -10, h: -10 },
      ],
    }],
  }));
  const [ellipse, line, rect] = t.layers[0].nodes;
  assert.equal(ellipse.type, 'ellipse');
  assert.equal(ellipse.radius, 18, '圆不应被圆角影响');
  assert.equal(line.type, 'line');
  assert.deepEqual([line.w, line.h], [-320, -240], '线段方向信息需保留');
  assert.deepEqual([rect.w, rect.h], [0, 0], '非线段图形的负宽高仍被夹到 0');
});

test('未知字段不会进入归一化结果', () => {
  const t = normalizeTheme(theme({
    evil: '<script>',
    layers: [{ nodes: [{ type: 'rect', onclick: 'alert(1)' }] }],
  }));
  assert.equal(t.evil, undefined);
  assert.equal(t.layers[0].nodes[0].onclick, undefined);
});

test('控件坐标与路径控制柄归一化', () => {
  const t = normalizeTheme(theme({
    layers: [{
      nodes: [{
        type: 'path', closed: true,
        points: [
          { x: 10, y: 20, in: { x: -5, y: 0 }, out: { x: 5, y: 0 }, mode: 'smooth' },
          { x: 100, y: 40 },
        ],
      }],
    }],
    widgets: [{
      type: 'score', surface: 'card', slot: 'score',
      x: 12, y: 34, w: 56, h: 78, props: { fontSize: 48 }, bind: { value: 'self.score' },
    }],
  }));
  const node = t.layers[0].nodes[0];
  assert.equal(node.points[0].out.x, 5);
  assert.equal(node.points[0].in.x, -5);
  assert.equal(node.closed, true);
  assert.deepEqual(
    [t.widgets[0].x, t.widgets[0].y, t.widgets[0].w, t.widgets[0].h],
    [12, 34, 56, 78],
  );
});
