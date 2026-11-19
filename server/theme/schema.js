'use strict';
// 主题 v2：归一化、校验、限额（服务端权威）
// v1（纯 settings patch）在导入时升级为 v2 的最小形态。
const { randomBytes } = require('crypto');
const { OpError } = require('../validation');
const {
  THEME_SETTING_KEYS,
  SETTINGS_VALIDATORS,
} = require('../settings');

const THEME_FORMAT = 'screenscoreboard.theme';
const THEME_VERSION = 2;

const LIMITS = Object.freeze({
  themeBytes: 512 * 1024,
  libraryCount: 200,
  libraryBytes: 5 * 1024 * 1024,
  layers: 50,
  nodesPerLayer: 500,
  nodesTotal: 2000,
  pathPoints: 500,
  widgets: 100,
  depth: 12,
  canvasMin: 8,
  canvasMax: 7680,
  coord: 100000,
  name: 60,
  description: 300,
  text: 500,
  label: 60,
  markup: 2000,
  imageSrc: 64 * 1024,
  scriptBytes: 32 * 1024,
});

const NODE_TYPES = new Set(['rect', 'ellipse', 'line', 'path', 'text', 'image']);
const BLEND_MODES = new Set(['normal', 'multiply', 'screen', 'overlay']);
const WIDGET_TYPES = new Set([
  'text', 'title', 'score', 'rank', 'avatar', 'image', 'progress', 'clock',
  'countdown', 'name', 'bio', 'teamName', 'memberCount',
]);
const WIDGET_SURFACES = new Set(['canvas', 'card', 'teamCard', 'memberChip']);
const WIDGET_SLOTS = new Set([
  'rank', 'avatar', 'name', 'bio', 'score', 'bar', 'teamName', 'teamTotal', 'members', 'extra',
]);
function genThemeId() {
  return 'th_' + randomBytes(4).toString('hex');
}

function isObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function num(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

function int(v, lo, hi, fallback) {
  return Math.round(num(v, lo, hi, fallback));
}

function bool(v, fallback) {
  return typeof v === 'boolean' ? v : fallback;
}

function text(v, max, fallback = '') {
  if (typeof v !== 'string') return fallback;
  const s = v.trim();
  return s.length > max ? s.slice(0, max) : s;
}

function label(v, fallback, max = LIMITS.label) {
  const s = text(v, max, fallback);
  return s || fallback;
}

function idOf(v, prefix) {
  const s = typeof v === 'string' ? v.trim() : '';
  return /^[A-Za-z0-9_-]{1,64}$/.test(s) ? s : prefix + '_' + randomBytes(3).toString('hex');
}

function color(v, fallback = 'none') {
  if (v === 'none' || v === 'transparent') return v;
  if (typeof v === 'string' && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v)) return v;
  return fallback;
}

function imageSrc(v) {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  if (!s) return '';
  if (/^avatars\/[\w.-]+$/.test(s)) return s;
  if (/^\/media\/[\w./-]+$/.test(s)) return s;
  if (/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(s) &&
    s.length <= LIMITS.imageSrc) return s;
  throw new OpError('主题图片路径非法（仅允许 avatars/、/media/ 或内联图片）');
}

function fontFamily(v) {
  const s = text(v, 80, 'system');
  return /^[\p{L}\p{N} ._-]+$/u.test(s) ? s : 'system';
}

function sanitizeValue(v, depth = 0) {
  if (depth > 4) throw new OpError('主题控件属性嵌套过深');
  if (v == null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.length > LIMITS.text ? v.slice(0, LIMITS.text) : v;
  if (Array.isArray(v)) {
    if (v.length > 100) throw new OpError('主题控件数组过长');
    return v.map((item) => sanitizeValue(item, depth + 1));
  }
  if (isObject(v)) {
    const out = {};
    const keys = Object.keys(v);
    if (keys.length > 64) throw new OpError('主题控件属性过多');
    for (const k of keys) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(k)) throw new OpError('主题控件属性名非法');
      out[k] = sanitizeValue(v[k], depth + 1);
    }
    return out;
  }
  throw new OpError('主题控件属性类型非法');
}

function sanitizePathPoint(raw) {
  const p = isObject(raw) ? raw : {};
  const handle = (h) => {
    const o = isObject(h) ? h : {};
    return { x: int(o.x, -LIMITS.coord, LIMITS.coord, 0), y: int(o.y, -LIMITS.coord, LIMITS.coord, 0) };
  };
  return {
    x: int(p.x, -LIMITS.coord, LIMITS.coord, 0),
    y: int(p.y, -LIMITS.coord, LIMITS.coord, 0),
    in: handle(p.in),
    out: handle(p.out),
    mode: p.mode === 'smooth' ? 'smooth' : 'corner',
  };
}

function normalizeNode(raw, depth) {
  if (!isObject(raw)) return null;
  if (depth > LIMITS.depth) throw new OpError('主题嵌套层级过深');
  const type = NODE_TYPES.has(raw.type) ? raw.type : 'rect';
  // 线段用「起点 + 有符号宽高」表达方向，因此允许负值；其他图形宽高必须非负
  const minSize = type === 'line' ? -LIMITS.coord * 2 : 0;
  const node = {
    id: idOf(raw.id, 'nd'),
    type,
    x: int(raw.x, -LIMITS.coord, LIMITS.coord, 0),
    y: int(raw.y, -LIMITS.coord, LIMITS.coord, 0),
    w: int(raw.w, minSize, LIMITS.coord * 2, 100),
    h: int(raw.h, minSize, LIMITS.coord * 2, 100),
    radius: int(raw.radius, 0, 10000, 0),
    rotation: num(raw.rotation, -36000, 36000, 0),
    opacity: num(raw.opacity, 0, 1, 1),
    fill: color(raw.fill, '#ffffff'),
    fillOpacity: num(raw.fillOpacity, 0, 1, 1),
    stroke: color(raw.stroke, 'none'),
    strokeWidth: num(raw.strokeWidth, 0, 1000, 0),
    points: [],
    closed: bool(raw.closed, false),
    text: text(raw.text, LIMITS.text, ''),
    fontSize: int(raw.fontSize, 1, 1000, 32),
    fontFamily: fontFamily(raw.fontFamily),
    fontWeight: int(raw.fontWeight, 100, 900, 700),
    fontStyle: raw.fontStyle === 'italic' ? 'italic' : 'normal',
    textAlign: ['left', 'center', 'right'].includes(raw.textAlign) ? raw.textAlign : 'center',
    src: '',
    name: label(raw.name, ''),
    visible: bool(raw.visible, true),
    locked: bool(raw.locked, false),
  };
  if (type === 'image') node.src = imageSrc(raw.src);
  if (type === 'path') {
    const pts = Array.isArray(raw.points) ? raw.points : [];
    if (pts.length > LIMITS.pathPoints) throw new OpError('主题路径节点过多');
    node.points = pts.map(sanitizePathPoint);
  }
  return node;
}

function normalizeLayer(raw, depth, budget) {
  if (!isObject(raw)) return null;
  if (depth > LIMITS.depth) throw new OpError('主题嵌套层级过深');
  const rawNodes = Array.isArray(raw.nodes) ? raw.nodes : [];
  if (rawNodes.length > LIMITS.nodesPerLayer) throw new OpError('单个图层的元素数量超出上限');
  budget.nodes += rawNodes.length;
  if (budget.nodes > LIMITS.nodesTotal) throw new OpError('主题元素总数超出上限');
  const nodes = [];
  for (const n of rawNodes) {
    const node = normalizeNode(n, depth + 1);
    if (node) nodes.push(node);
  }
  return {
    id: idOf(raw.id, 'ly'),
    name: label(raw.name, '图层'),
    visible: bool(raw.visible, true),
    locked: bool(raw.locked, false),
    opacity: num(raw.opacity, 0, 1, 1),
    blendMode: BLEND_MODES.has(raw.blendMode) ? raw.blendMode : 'normal',
    x: int(raw.x, -LIMITS.coord, LIMITS.coord, 0),
    y: int(raw.y, -LIMITS.coord, LIMITS.coord, 0),
    rotation: num(raw.rotation, -36000, 36000, 0),
    scaleX: num(raw.scaleX, 0.01, 100, 1),
    scaleY: num(raw.scaleY, 0.01, 100, 1),
    nodes,
  };
}

function normalizeCanvas(raw) {
  const c = isObject(raw) ? raw : {};
  const background = isObject(c.background) ? c.background : {};
  const type = ['none', 'color', 'image'].includes(background.type) ? background.type : 'none';
  return {
    width: int(c.width, LIMITS.canvasMin, LIMITS.canvasMax, 1920),
    height: int(c.height, LIMITS.canvasMin, LIMITS.canvasMax, 1080),
    background: {
      type,
      color: color(background.color, '#000000'),
      image: type === 'image' ? imageSrc(background.image) : '',
    },
  };
}

function normalizeWidget(raw) {
  if (!isObject(raw)) return null;
  const type = WIDGET_TYPES.has(raw.type) ? raw.type : 'text';
  const props = isObject(raw.props) ? sanitizeValue(raw.props, 0) : {};
  const bind = isObject(raw.bind) ? sanitizeValue(raw.bind, 0) : {};
  return {
    id: idOf(raw.id, 'wg'),
    type,
    surface: WIDGET_SURFACES.has(raw.surface) ? raw.surface : 'canvas',
    slot: WIDGET_SLOTS.has(raw.slot) ? raw.slot : undefined,
    x: int(raw.x, -LIMITS.coord, LIMITS.coord, 80),
    y: int(raw.y, -LIMITS.coord, LIMITS.coord, 80),
    w: int(raw.w, 0, LIMITS.coord * 2, 420),
    h: int(raw.h, 0, LIMITS.coord * 2, 90),
    props,
    bind,
    visible: bool(raw.visible, true),
  };
}

function normalizeSettings(raw) {
  if (raw == null) return {};
  if (!isObject(raw)) throw new OpError('主题 settings 必须是对象');
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!THEME_SETTING_KEYS.has(k)) throw new OpError('主题包含不支持的设置项: ' + k);
    const validator = SETTINGS_VALIDATORS[k];
    if (!validator) throw new OpError('主题包含不支持的设置项: ' + k);
    out[k] = validator(v);
  }
  return out;
}

function normalizeScript(raw) {
  if (raw == null) return { enabled: false, source: '', entry: 'drawTheme' };
  if (!isObject(raw)) throw new OpError('主题脚本配置非法');
  const source = typeof raw.source === 'string' ? raw.source : '';
  if (source.length > LIMITS.scriptBytes) {
    throw new OpError('主题脚本过长（上限 32KB）');
  }
  const enabled = raw.enabled === true;
  if (enabled && !source.trim()) {
    throw new OpError('启用主题脚本时必须提供源码');
  }
  const entry = typeof raw.entry === 'string' && /^[A-Za-z_$][\w$]{0,63}$/.test(raw.entry)
    ? raw.entry
    : 'drawTheme';
  return { enabled, source, entry };
}

function normalizeMeta(raw, opts) {
  const m = isObject(raw) ? raw : {};
  const now = Date.now();
  const baseStyle = SETTINGS_VALIDATORS.displayStyle(
    m.baseStyle || opts.baseStyle || 'custom',
  );
  return {
    id: opts.id || idOf(m.id, 'th') || genThemeId(),
    name: label(m.name, opts.name || '未命名主题', LIMITS.name),
    author: text(m.author, LIMITS.name, ''),
    description: text(m.description, LIMITS.description, ''),
    baseStyle,
    createdAt: Number.isFinite(Number(opts.createdAt)) ? Number(opts.createdAt) : now,
    updatedAt: Number.isFinite(Number(opts.updatedAt)) ? Number(opts.updatedAt) : now,
    revision: Math.max(1, int(opts.revision, 1, 100000, 1)),
  };
}

function normalizeTheme(raw, opts = {}) {
  if (!isObject(raw)) throw new OpError('主题文件非法');
  if (raw.format !== THEME_FORMAT) throw new OpError('不是有效的计分板主题文件');

  let src = raw;
  if (raw.version === 1) {
    // v1：settings patch → v2 最小形态
    src = {
      format: THEME_FORMAT,
      version: THEME_VERSION,
      meta: {
        name: raw.name,
        author: raw.author,
        description: raw.description,
        baseStyle: raw.baseStyle || 'custom',
      },
      canvas: {},
      layers: [],
      widgets: [],
      settings: raw.settings || {},
      script: { enabled: false },
    };
  } else if (raw.version !== THEME_VERSION) {
    throw new OpError('主题版本不受支持');
  }

  const meta = normalizeMeta(src.meta, opts);
  const canvas = normalizeCanvas(src.canvas);
  const budget = { nodes: 0 };
  const rawLayers = Array.isArray(src.layers) ? src.layers : [];
  if (rawLayers.length > LIMITS.layers) throw new OpError('主题图层数量超出上限');
  const layers = [];
  for (const l of rawLayers) {
    const layer = normalizeLayer(l, 0, budget);
    if (layer) layers.push(layer);
  }
  const rawWidgets = Array.isArray(src.widgets) ? src.widgets : [];
  if (rawWidgets.length > LIMITS.widgets) throw new OpError('主题控件数量超出上限');
  const widgets = rawWidgets.map(normalizeWidget).filter(Boolean);
  const settings = normalizeSettings(src.settings);
  const script = normalizeScript(src.script);

  const theme = {
    format: THEME_FORMAT,
    version: THEME_VERSION,
    meta,
    canvas,
    layers,
    widgets,
    settings,
    script,
  };
  if (themeBytes(theme) > LIMITS.themeBytes) throw new OpError('主题文件过大（上限 512KB）');
  return theme;
}

function normalizeDraft(raw, projectId, existing) {
  return normalizeTheme(raw, {
    id: (existing && existing.meta && existing.meta.id) || 'draft_' + String(projectId).replace(/[^\w-]/g, ''),
    createdAt: existing && existing.meta ? existing.meta.createdAt : undefined,
    revision: existing && existing.meta ? existing.meta.revision : 1,
    updatedAt: Date.now(),
  });
}

function themeBytes(theme) {
  try {
    return Buffer.byteLength(JSON.stringify(theme), 'utf8');
  } catch (_) {
    return Number.POSITIVE_INFINITY;
  }
}

function libraryBytes(themes) {
  let total = 0;
  for (const theme of Object.values(themes || {})) total += themeBytes(theme);
  return total;
}

function themeSummary(theme) {
  return {
    id: theme.meta.id,
    name: theme.meta.name,
    author: theme.meta.author,
    description: theme.meta.description,
    baseStyle: theme.meta.baseStyle,
    revision: theme.meta.revision,
    updatedAt: theme.meta.updatedAt,
    bytes: themeBytes(theme),
    layers: theme.layers.length,
    widgets: theme.widgets.length,
  };
}

module.exports = {
  THEME_FORMAT,
  THEME_VERSION,
  LIMITS,
  WIDGET_TYPES,
  WIDGET_SURFACES,
  WIDGET_SLOTS,
  genThemeId,
  normalizeTheme,
  normalizeDraft,
  normalizeSettings,
  themeBytes,
  libraryBytes,
  themeSummary,
};
