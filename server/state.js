'use strict';
// 权威状态：多项目 + 存储后端（json/sqlite/postgres/mysql）
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createStorage } = require('./storage');
const runtime = require('./runtime');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const AVATAR_DIR = path.join(DATA_DIR, 'avatars');
const SOUND_DIR = path.join(DATA_DIR, 'sounds');

const DEFAULT_SETTINGS = {
  title: '计分板',
  displayStyle: 'lecture',  // lecture | ppt | seewo | kde | custom
  columns: 4,
  density: 'comfortable',   // comfortable | compact
  sortBy: 'score',          // score | created | manual
  sortOrder: 'desc',        // desc | asc
  theme: 'dark',            // dark | light
  accent: '#e8a33d',
  showMemberScore: true,
  showTeamTotal: true,
  bgType: 'color',          // color | image
  bgColor: '',              // '' = 跟随主题
  bgImage: null,            // avatars/xxx.png
  bgImageBlur: false,       // 背景图虚化
  bgImageBlurAmount: 12,    // 背景图虚化度 px（0–40）
  bgScrimEnabled: true,     // 背景图遮罩（防止图片干扰文字；浅色主题下即“发白”层）
  cardBg: '',               // '' = 跟随主题
  cardBgMode: 'auto',       // auto | custom | translucent | acrylic
  cardOpacity: 0.55,        // 半透明/亚克力不透明度 0.15–1
  cardAcrylicBlur: 12,      // 亚克力模糊 px（0–40）
  cardRadius: 10,           // 0–32
  showTeamAccent: true,     // 团队卡左侧色条
  teamAccentColor: '',      // '' = 使用强调色
  layoutMode: 'auto',       // auto | free（自由布局：百分比坐标）
  memberScale: 1,           // 成员小卡片缩放 0.6–2
  avatarPosition: 'left',   // left | right | top | bottom（头像相对姓名）
  avatarSizeMode: 'auto',   // auto（随卡片自适应）| manual
  avatarSize: 64,           // 手动头像大小 px（24–160）
  cardStyle: 'solid',       // solid | glass | neumorph | neon | gradient | paper
  glassBlur: 12,            // 毛玻璃模糊强度 px（0–40）
  glassOpacity: 0.55,       // 毛玻璃卡片不透明度（0.15–0.95）
  scoreEffect: 'bounce',    // none | bounce | glow | float | shake | confetti | spotlight
  spotlightScope: 'person', // team（仅团队）| person_team（人物 + 团队）| person（仅人物）
  spotlightWidth: 520,      // 居中突显宽度 px（200–1600）
  spotlightHeight: 0,       // 居中突显高度 px；0 = 自动
  spotlightTheme: 'pop',    // pop | fly | genie | squeeze
  spotlightReturnToOrigin: false, // （兼容）fly 主题开关
  spotlightReturnDuration: 1600,  // fly 主题时长 ms（600–6000）
  scoreEffectDuration: 700, // 特效时长 ms（200–3000）
  scoreEffectColor: '',     // '' = 自动（加分绿/减分红）；或 #rrggbb
  scoreEffectOnlyPositive: false, // 仅加分触发特效
  soundEnabled: false,      // 记分音效
  soundVolume: 0.5,         // 音效音量 0–1
  customSound: '',          // '' = 内置合成音；否则 sounds/xxx.mp3

  // ---- 高级外观 ----
  fontFamily: 'system',     // system | serif | kai | custom
  fontFamilyCustom: '',     // 自定义系统字体名称（fontFamily=custom 时生效）
  scoreFont: 'auto',        // 分数数字字体：auto | system | serif | kai | custom
  scoreFontCustom: '',      // 分数自定义系统字体名称
  fontScale: 1,             // 姓名/分数/成员字号缩放 0.7–1.5
  titleSize: 0,             // 标题字号 px；0 = 自动
  titleFont: 'auto',        // 标题字体：auto（跟随全局）| system | serif | kai | custom
  titleFontCustom: '',      // 标题自定义系统字体名称（titleFont=custom 时生效）
  titleAlign: 'auto',       // auto（跟随风格）| center | left | right
  titleDecor: 'auto',       // auto（跟随风格）| plain（纯标题，去掉胶囊/竖条）
  styleFreeConfig: false,   // true = 高级外观设置覆盖风格皮肤的固定排版
  titleFree: false,         // 标题自由位置（可在预览中拖动）
  titleX: 50,               // 标题中心 X（视口百分比 0–100）
  titleY: 8,                // 标题中心 Y（视口百分比 0–100）
  titleColor: '',           // '' = 跟随主题
  showTitleRule: true,      // 标题下方短横线
  boardMaxWidth: 1800,      // 卡片区最大宽度 px（900–2600）
  cardGap: 0,               // 卡片间距；0 = 跟随密度
  cardPad: 0,               // 卡片内边距；0 = 跟随密度
  cardBorderWidth: 1,       // 卡片边框宽度 px（0–6）
  cardBorderColor: '',      // '' = 跟随主题
  cardShadow: 'auto',       // auto | none | soft | medium | strong
  teamAccentWidth: 4,       // 团队卡左侧色条宽度 px（0–12）
  avatarBorderWidth: 1,     // 头像边框宽度 px（0–6）
  avatarShape: 'circle',    // circle | square
  textColor: '',            // '' = 跟随主题
  positiveColor: '#6fbf7b', // 正分颜色
  negativeColor: '#e06c75', // 负分颜色
  rankColor: '',            // 名次颜色；'' = 强调色
  scrimOpacity: 1,          // 背景图压暗倍率 0–1
  showRank: true,           // 显示名次角标
  rankSize: 15,             // 名次字号 px（10–40）
  showScoreBar: true,       // 显示分数比例条
  scoreBarHeight: 5,        // 比例条高度 px（0–16）

  // ---- 功能开关 ----
  featureAvatarEdit: true,
  featureSettingsResize: true,
  featureBatchAdd: true,
  featureSearch: true,
  featureQuickScore: true,
  featureTeamScore: true,
  featureUndo: true,
  featureResetScores: true,
  featureClock: false,
  featureCountdown: false,
  featureLeaderboard: false,
  featureRankTies: false,
  featureExportImport: true,
  featureCsvExport: true,
  featureDataMaintenance: true,

  // ---- 大屏演示 ----
  clockPosition: 'top-right', // top-left | top-right | bottom-left | bottom-right
  clockFont: 'auto',          // 时钟字体：auto | system | serif | kai | custom
  clockFontCustom: '',        // 时钟自定义系统字体名称
  clockFontSize: 0,           // 时钟字号 px；0=自动
  clockFormat: '24',          // '24' | '12'
  clockShowSeconds: true,
  clockShowDate: false,
  countdownDurationSec: 300,  // 1–3600
  countdownDisplayMode: 'corner', // corner | center | fullscreen
  countdownTheme: 'classic',  // classic | ink（水墨）
  countdownShape: 'circle',   // circle | square | rounded | rounded-rect | rect
  countdownRadius: 28,        // 圆角 px（0–120）
  countdownSize: 520,         // 窗口宽度 px（200–900）
  countdownHeight: 0,         // 窗口高度 px（0=与宽度相同，最大 900）
  countdownFontSize: 0,       // 数字字号 px；0=自动
  countdownFont: 'auto',      // 倒计时字体：auto | system | serif | kai | custom
  countdownFontCustom: '',    // 倒计时自定义系统字体名称
  countdownPosition: 'center', // center | top-left | top | top-right | left | right | bottom-left | bottom | bottom-right
  countdownShowProgress: true,
  countdownShowBackdrop: true,
  countdownBg: '',            // '' = 跟随主题
  countdownBgMode: 'theme',   // theme | custom | translucent | acrylic
  countdownOpacity: 1,        // 0.2–1
  countdownBlur: 12,          // 亚克力模糊 px（0–40）
  countdownTextColor: '',     // '' = 跟随主题
  displayView: 'cards',       // cards | leaderboard
  leaderboardScope: 'auto',   // auto | people | teams
  leaderboardLimit: 0,        // 0 = 全部
  leaderboardScale: 1,        // 0.8–1.6
  leaderboardFont: 'auto',    // 排行榜字体：auto | system | serif | kai | custom
  leaderboardFontCustom: '',  // 排行榜自定义系统字体名称
  rankTieMode: 'competition', // competition | dense | none

  // ---- 记分效率与动效 ----
  quickScorePresets: [1, 5, 10, -1], // 快捷记分预设
  scoreRolling: true,         // 滚动数字
  sortAnimation: true,        // 排序重排动画（FLIP）
  rankChangeAnimation: true,  // 名次升降动画
  featureMarquee: false,      // 跑马灯横幅
  bgmEnabled: false,          // 背景音乐
  bgmFile: '',                // 背景音乐文件（sounds/xxx）
  bgmVolume: 0.3,             // 背景音乐音量 0–1
  bgmLoop: true,              // 背景音乐循环
  featureBuzzer: false,       // 抢答模式
  featureTeamPk: false,       // 团队 PK
  featureCarousel: false,     // 轮播多屏
  carouselViews: ['cards', 'leaderboard', 'welcome'], // 轮播视图顺序
  carouselIntervalSec: 15,    // 轮播间隔秒
  featureWelcome: false,      // 欢迎幕布
  marqueeText: '',            // 跑马灯文字
  marqueeFontSize: 0,         // 跑马灯字号 px；0=自动
  marqueeFont: 'auto',        // 跑马灯字体：auto | system | serif | kai | custom
  marqueeFontCustom: '',      // 跑马灯自定义系统字体名称
  marqueePosition: 'top',     // top | bottom
  marqueeEffect: 'scroll',    // scroll | blink | none
  marqueeColor: '',           // '' = 跟随强调色
  marqueeBgColor: '',         // '' = 跟随主题
  marqueeSpeed: 1,            // 滚动速度倍率 0.5–3
  welcomeText: '',            // 欢迎幕布文字
  welcomeFont: 'auto',        // 欢迎幕布字体：auto | system | serif | kai | custom
  welcomeFontCustom: '',      // 欢迎幕布自定义系统字体名称
  welcomeFontSize: 0,         // 欢迎幕布字号 px；0=自动
  welcomeImage: '',           // 欢迎幕布背景图
  welcomeBgColor: '',         // 欢迎幕布纯色画板底色（图空时用）
};

const storage = createStorage();

let state = { version: 2, projects: {} };

function genId(prefix) {
  return prefix + '_' + crypto.randomBytes(4).toString('hex');
}

function defaultSettings() {
  return { ...DEFAULT_SETTINGS };
}

function defaultProject(name) {
  return {
    id: genId('pr'),
    name: name || '新项目',
    createdAt: Date.now(),
    people: {},
    teams: {},
    settings: defaultSettings(),
  };
}

// 人员和团队共用一个项目内序号空间；手动调序只与同类相邻项交换，
// 大屏上人员与团队的相对穿插保持不变。
function orderOf(entity) {
  return Number.isFinite(entity.order) ? entity.order : Number.POSITIVE_INFINITY;
}

function nextOrder(project) {
  let max = -1;
  for (const entity of [...Object.values(project.people), ...Object.values(project.teams)]) {
    if (Number.isFinite(entity.order) && entity.order > max) max = entity.order;
  }
  return max + 1;
}

function normalizeOrders(project) {
  const entities = [...Object.values(project.people), ...Object.values(project.teams)];
  entities.sort((a, b) => {
    const ao = orderOf(a);
    const bo = orderOf(b);
    if (ao !== bo) return ao < bo ? -1 : 1;
    return (a.createdAt || 0) - (b.createdAt || 0);
  });
  entities.forEach((entity, index) => { entity.order = index; });
}

function moveEntityByOrder(collection, entity, direction) {
  if (direction !== 'up' && direction !== 'down') throw new OpError('移动方向非法');
  const list = Object.values(collection).sort((a, b) => orderOf(a) - orderOf(b));
  const index = list.indexOf(entity);
  const target = direction === 'up' ? index - 1 : index + 1;
  if (index < 0 || target < 0 || target >= list.length) return;
  const other = list[target];
  const tmp = entity.order;
  entity.order = other.order;
  other.order = tmp;
}

function normalizeProject(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const settings = { ...DEFAULT_SETTINGS, ...(p.settings || {}) };
  // 旧版本：毛玻璃开关 → 卡片样式
  if (p.settings && !p.settings.cardStyle) {
    settings.cardStyle = p.settings.glassEnabled ? 'glass' : 'solid';
  }
  // 旧版本：有自定义卡片底色 → 迁移为「自定义纯色」模式
  if (p.settings && p.settings.cardBgMode == null) {
    settings.cardBgMode = p.settings.cardBg ? 'custom' : 'auto';
  }
  // 旧版本：有自定义倒计时窗口底色 → 迁移为「自定义颜色」模式
  if (p.settings && p.settings.countdownBgMode == null) {
    settings.countdownBgMode = p.settings.countdownBg ? 'custom' : 'theme';
  }
  // 旧版本：开启「从哪来回哪去」→ 迁移为 fly 主题
  if (p.settings && p.settings.spotlightTheme == null) {
    settings.spotlightTheme = p.settings.spotlightReturnToOrigin ? 'fly' : 'pop';
  }
  delete settings.glassEnabled;

  const people = {};
  for (const [id, person] of Object.entries(p.people || {})) {
    if (!person || typeof person !== 'object') continue;
    people[id] = {
      ...person,
      id: person.id || id,
      cardImage: person.cardImage === undefined ? null : person.cardImage,
      layout: person.layout === undefined ? null : person.layout,
      memberLayout: person.memberLayout === undefined ? null : person.memberLayout,
    };
  }
  const teams = {};
  for (const [id, team] of Object.entries(p.teams || {})) {
    if (!team || typeof team !== 'object') continue;
    teams[id] = {
      ...team,
      id: team.id || id,
      cardImage: team.cardImage === undefined ? null : team.cardImage,
      layout: team.layout === undefined ? null : team.layout,
    };
  }
  const project = {
    id: typeof p.id === 'string' && p.id ? p.id : genId('pr'),
    name: typeof p.name === 'string' && p.name.trim() ? p.name.trim().slice(0, 30) : '未命名项目',
    createdAt: p.createdAt || Date.now(),
    people,
    teams,
    settings,
  };
  normalizeOrders(project);
  return project;
}

function normalizeState(raw) {
  const out = { version: 2, projects: {} };
  if (raw && raw.projects && typeof raw.projects === 'object') {
    for (const [id, p] of Object.entries(raw.projects)) {
      const project = normalizeProject({ ...(p && typeof p === 'object' ? p : {}), id });
      out.projects[project.id] = project;
    }
  } else if (raw && (raw.people || raw.teams || raw.settings)) {
    // 旧版单积分榜 → 包成一个项目
    const project = normalizeProject({
      id: genId('pr'),
      name: '默认项目',
      createdAt: Date.now(),
      people: raw.people,
      teams: raw.teams,
      settings: raw.settings,
    });
    out.projects[project.id] = project;
  }
  if (!Object.keys(out.projects).length) {
    const project = defaultProject('默认项目');
    out.projects[project.id] = project;
  }
  return out;
}

// ---------- 初始化 ----------
async function init() {
  fs.mkdirSync(AVATAR_DIR, { recursive: true });
  fs.mkdirSync(SOUND_DIR, { recursive: true });
  await storage.init();
  const raw = await storage.load();
  const normalized = normalizeState(raw);
  for (const key of Object.keys(state)) delete state[key];
  Object.assign(state, normalized);
}

// ---------- 持久化（100ms 防抖 + 串行写队列） ----------
let saveTimer = null;
let saving = false;
let dirty = false;

function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void doSave();
  }, 100);
}

async function doSave() {
  if (saving) {
    dirty = true;
    return;
  }
  saving = true;
  do {
    dirty = false;
    try {
      await storage.save(state);
    } catch (e) {
      console.error('[state] 保存失败:', e.message);
    }
  } while (dirty);
  saving = false;
}

async function flushSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  await doSave();
}

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await Promise.race([flushSave(), new Promise((r) => setTimeout(r, 3000))]);
  try {
    await Promise.race([storage.close(), new Promise((r) => setTimeout(r, 2000))]);
  } catch (_) {}
  process.exit(0);
}
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });

// ---------- 校验辅助 ----------
class OpError extends Error {}

function needString(v, field, max = 40) {
  if (typeof v !== 'string' || !v.trim()) throw new OpError(`${field}不能为空`);
  if (v.trim().length > max) throw new OpError(`${field}过长（最多 ${max} 字）`);
  return v.trim();
}
function needProject(id) {
  const p = state.projects[id];
  if (!p) throw new OpError('项目不存在');
  return p;
}
function needPerson(project, id) {
  const p = project.people[id];
  if (!p) throw new OpError('人员不存在');
  return p;
}
function needTeam(project, id) {
  const t = project.teams[id];
  if (!t) throw new OpError('团队不存在');
  return t;
}
function needAvatar(v) {
  if (v == null) return null;
  if (typeof v !== 'string' || !/^avatars\/[\w.-]+$/.test(v)) throw new OpError('头像路径非法');
  return v;
}
function needScore(v, field) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new OpError(`${field}必须是数字`);
  return Math.max(-10000, Math.min(10000, Math.round(n)));
}
function needLayout(l) {
  if (!l || typeof l !== 'object') throw new OpError('布局参数非法');
  const num = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new OpError('布局参数非法');
    return Math.round(n * 100) / 100;
  };
  let x = num(l.x), y = num(l.y), w = num(l.w), h = num(l.h);
  // 不强制贴边：允许卡片拖出画布（负坐标或超出 100%），仅做极端值保护
  w = Math.max(4, Math.min(200, w));
  h = Math.max(3, Math.min(200, h));
  x = Math.max(-100, Math.min(200, x));
  y = Math.max(-100, Math.min(200, y));
  return { x, y, w, h };
}
function needEntity(project, kind, id) {
  if (kind === 'person') return needPerson(project, id);
  if (kind === 'team') return needTeam(project, id);
  throw new OpError('实体类型非法');
}

function requireFeature(project, key) {
  if (!project.settings[key]) throw new OpError('该功能未开启');
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function hexOrEmpty(v, message) {
  if (v === '' || v == null) return '';
  if (HEX_COLOR.test(v)) return v;
  throw new OpError(message);
}

function intRange(v, lo, hi, message) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) throw new OpError(message);
  return n;
}

function boolStrict(v, label) {
  if (typeof v !== 'boolean') throw new OpError(label + '须为布尔值');
  return v;
}

function fontNameOrEmpty(v) {
  if (v == null || v === '') return '';
  if (typeof v !== 'string') throw new OpError('字体名称非法');
  const name = v.trim();
  if (!name) return '';
  if (name.length > 60) throw new OpError('字体名称过长（最多 60 字）');
  if (!/^[\p{L}\p{N} ._-]+$/u.test(name)) throw new OpError('字体名称包含非法字符');
  return name;
}

function fontChoice(label) {
  return (v) => (['auto', 'system', 'serif', 'kai', 'custom'].includes(v)
    ? v
    : (() => { throw new OpError(label + '非法'); })());
}

const SETTINGS_VALIDATORS = {
  title: (v) => needString(v, '标题', 30),
  displayStyle: (v) =>
    (['lecture', 'ppt', 'seewo', 'kde', 'custom',
      'guofeng', 'ink', 'modern', 'neon', 'poster'].includes(v)
      ? v
      : (() => { throw new OpError('显示风格非法'); })()),
  columns: (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 8) throw new OpError('列数须为 1–8 的整数');
    return n;
  },
  density: (v) => (['comfortable', 'compact'].includes(v) ? v : (() => { throw new OpError('密度取值非法'); })()),
  sortBy: (v) => (['score', 'created', 'manual'].includes(v) ? v : (() => { throw new OpError('排序方式非法'); })()),
  sortOrder: (v) => (['desc', 'asc'].includes(v) ? v : (() => { throw new OpError('排序方向非法'); })()),
  theme: (v) => (['dark', 'light'].includes(v) ? v : (() => { throw new OpError('主题取值非法'); })()),
  accent: (v) => (/^#[0-9a-fA-F]{6}$/.test(v) ? v : (() => { throw new OpError('强调色须为 #rrggbb'); })()),
  showMemberScore: (v) => Boolean(v),
  showTeamTotal: (v) => Boolean(v),
  bgType: (v) => (['color', 'image'].includes(v) ? v : (() => { throw new OpError('背景类型非法'); })()),
  bgColor: (v) => {
    if (v === '' || v == null) return '';
    return /^#[0-9a-fA-F]{6}$/.test(v) ? v : (() => { throw new OpError('背景色须为 #rrggbb 或留空'); })();
  },
  bgImage: (v) => needAvatar(v === '' ? null : v),
  bgImageBlur: (v) => boolStrict(v, '背景图虚化开关'),
  bgImageBlurAmount: (v) => intRange(v, 0, 40, '背景图虚化度须为 0–40 px'),
  bgScrimEnabled: (v) => boolStrict(v, '背景遮罩开关'),
  cardBg: (v) => {
    if (v === '' || v == null) return '';
    return /^#[0-9a-fA-F]{6}$/.test(v) ? v : (() => { throw new OpError('卡片底色须为 #rrggbb 或留空'); })();
  },
  cardBgMode: (v) =>
    (['auto', 'custom', 'translucent', 'acrylic'].includes(v)
      ? v
      : (() => { throw new OpError('卡片底色模式非法'); })()),
  cardOpacity: (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0.15 || n > 1) throw new OpError('卡片不透明度须在 0.15–1 之间');
    return Math.round(n * 100) / 100;
  },
  cardAcrylicBlur: (v) => intRange(v, 0, 40, '亚克力模糊须为 0–40'),
  showTeamAccent: (v) => Boolean(v),
  teamAccentColor: (v) => hexOrEmpty(v, '团队色条颜色须为 #rrggbb 或留空'),
  cardRadius: (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 32) throw new OpError('圆角须为 0–32 的整数');
    return n;
  },
  layoutMode: (v) => (['auto', 'free'].includes(v) ? v : (() => { throw new OpError('布局模式非法'); })()),
  memberScale: (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0.6 || n > 2) throw new OpError('成员卡片大小须在 0.6–2 之间');
    return Math.round(n * 100) / 100;
  },
  avatarPosition: (v) =>
    (['left', 'right', 'top', 'bottom'].includes(v)
      ? v
      : (() => { throw new OpError('头像位置非法'); })()),
  avatarSizeMode: (v) =>
    (['auto', 'manual'].includes(v) ? v : (() => { throw new OpError('头像大小模式非法'); })()),
  avatarSize: (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 24 || n > 160) throw new OpError('头像大小须为 24–160 的整数');
    return n;
  },
  cardStyle: (v) =>
    (['solid', 'glass', 'neumorph', 'neon', 'gradient', 'paper'].includes(v)
      ? v
      : (() => { throw new OpError('卡片样式非法'); })()),
  glassBlur: (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 40) throw new OpError('毛玻璃模糊强度须为 0–40 的整数');
    return n;
  },
  glassOpacity: (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0.15 || n > 0.95) throw new OpError('卡片透明度须在 0.15–0.95 之间');
    return Math.round(n * 100) / 100;
  },
  scoreEffect: (v) =>
    (['none', 'bounce', 'glow', 'float', 'shake', 'confetti', 'spotlight', 'highlight'].includes(v)
      ? v
      : (() => { throw new OpError('加分特效类型非法'); })()),
  spotlightScope: (v) =>
    (['team', 'person_team', 'person'].includes(v)
      ? v
      : (() => { throw new OpError('突显范围非法'); })()),
  spotlightWidth: (v) => intRange(v, 200, 1600, '突显宽度须为 200–1600'),
  spotlightHeight: (v) => intRange(v, 0, 1200, '突显高度须为 0–1200（0=自动）'),
  spotlightReturnToOrigin: (v) => boolStrict(v, '从哪来回哪去开关'),
  spotlightReturnDuration: (v) => intRange(v, 600, 6000, '飞入飞回时长须为 600–6000 ms'),
  spotlightTheme: (v) =>
    (['pop', 'fly', 'genie', 'squeeze'].includes(v)
      ? v
      : (() => { throw new OpError('突显主题非法'); })()),
  scoreEffectDuration: (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 200 || n > 3000) throw new OpError('特效时长须为 200–3000 的整数');
    return n;
  },
  scoreEffectColor: (v) => {
    if (v === '' || v == null) return '';
    return /^#[0-9a-fA-F]{6}$/.test(v) ? v : (() => { throw new OpError('特效颜色须为 #rrggbb 或留空'); })();
  },
  scoreEffectOnlyPositive: (v) => Boolean(v),
  soundEnabled: (v) => Boolean(v),
  soundVolume: (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 1) throw new OpError('音效音量须在 0–1 之间');
    return Math.round(n * 100) / 100;
  },
  customSound: (v) => {
    if (v === '' || v == null) return '';
    return typeof v === 'string' && /^sounds\/[\w.-]+$/.test(v)
      ? v
      : (() => { throw new OpError('音效文件路径非法'); })();
  },

  // ---- 高级外观 ----
  fontFamily: (v) =>
    (['system', 'serif', 'kai', 'custom'].includes(v)
      ? v
      : (() => { throw new OpError('字体选择非法'); })()),
  fontFamilyCustom: fontNameOrEmpty,
  scoreFont: fontChoice('分数字体'),
  scoreFontCustom: fontNameOrEmpty,
  fontScale: (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0.7 || n > 1.5) throw new OpError('字号缩放须在 0.7–1.5 之间');
    return Math.round(n * 100) / 100;
  },
  titleSize: (v) => intRange(v, 0, 120, '标题字号须为 0–120 的整数（0=自动）'),
  titleFont: (v) =>
    (['auto', 'system', 'serif', 'kai', 'custom'].includes(v)
      ? v
      : (() => { throw new OpError('标题字体非法'); })()),
  titleFontCustom: fontNameOrEmpty,
  titleAlign: (v) =>
    (['auto', 'center', 'left', 'right'].includes(v) ? v : (() => { throw new OpError('标题对齐非法'); })()),
  titleDecor: (v) =>
    (['auto', 'plain'].includes(v) ? v : (() => { throw new OpError('标题装饰取值非法'); })()),
  styleFreeConfig: (v) => Boolean(v),
  titleFree: (v) => Boolean(v),
  titleX: (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 100) throw new OpError('标题位置 X 须在 0–100 之间');
    return Math.round(n * 100) / 100;
  },
  titleY: (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 100) throw new OpError('标题位置 Y 须在 0–100 之间');
    return Math.round(n * 100) / 100;
  },
  titleColor: (v) => hexOrEmpty(v, '标题颜色须为 #rrggbb 或留空'),
  showTitleRule: (v) => Boolean(v),
  boardMaxWidth: (v) => intRange(v, 900, 2600, '页面最大宽度须为 900–2600'),
  cardGap: (v) => intRange(v, 0, 60, '卡片间距须为 0–60'),
  cardPad: (v) => intRange(v, 0, 60, '卡片内边距须为 0–60'),
  cardBorderWidth: (v) => intRange(v, 0, 6, '卡片边框宽度须为 0–6'),
  cardBorderColor: (v) => hexOrEmpty(v, '卡片边框颜色须为 #rrggbb 或留空'),
  cardShadow: (v) =>
    (['auto', 'none', 'soft', 'medium', 'strong'].includes(v)
      ? v
      : (() => { throw new OpError('卡片阴影取值非法'); })()),
  teamAccentWidth: (v) => intRange(v, 0, 12, '团队色条宽度须为 0–12'),
  avatarBorderWidth: (v) => intRange(v, 0, 6, '头像边框宽度须为 0–6'),
  avatarShape: (v) =>
    (['circle', 'square'].includes(v) ? v : (() => { throw new OpError('头像形状非法'); })()),
  textColor: (v) => hexOrEmpty(v, '文字颜色须为 #rrggbb 或留空'),
  positiveColor: (v) => (HEX_COLOR.test(v) ? v : (() => { throw new OpError('正分颜色须为 #rrggbb'); })()),
  negativeColor: (v) => (HEX_COLOR.test(v) ? v : (() => { throw new OpError('负分颜色须为 #rrggbb'); })()),
  rankColor: (v) => hexOrEmpty(v, '名次颜色须为 #rrggbb 或留空'),
  scrimOpacity: (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 1) throw new OpError('背景遮罩强度须在 0–1 之间');
    return Math.round(n * 100) / 100;
  },
  showRank: (v) => Boolean(v),
  rankSize: (v) => intRange(v, 10, 40, '名次字号须为 10–40'),
  showScoreBar: (v) => Boolean(v),
  scoreBarHeight: (v) => intRange(v, 0, 16, '比例条高度须为 0–16'),

  // ---- 功能开关 ----
  featureAvatarEdit: (v) => boolStrict(v, '头像修改开关'),
  featureSettingsResize: (v) => boolStrict(v, '设置窗口缩放开关'),
  featureBatchAdd: (v) => boolStrict(v, '批量添加开关'),
  featureSearch: (v) => boolStrict(v, '搜索开关'),
  featureQuickScore: (v) => boolStrict(v, '快捷记分开关'),
  featureTeamScore: (v) => boolStrict(v, '团队记分开关'),
  featureUndo: (v) => boolStrict(v, '撤销开关'),
  featureResetScores: (v) => boolStrict(v, '重置分数开关'),
  featureClock: (v) => boolStrict(v, '时钟开关'),
  featureCountdown: (v) => boolStrict(v, '倒计时开关'),
  featureLeaderboard: (v) => boolStrict(v, '排行榜开关'),
  featureRankTies: (v) => boolStrict(v, '并列名次开关'),
  featureExportImport: (v) => boolStrict(v, '导出导入开关'),
  featureCsvExport: (v) => boolStrict(v, 'CSV 导出开关'),
  featureDataMaintenance: (v) => boolStrict(v, '数据维护开关'),

  // ---- 大屏演示 ----
  clockPosition: (v) =>
    (['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(v)
      ? v
      : (() => { throw new OpError('时钟位置非法'); })()),
  clockFormat: (v) =>
    (['24', '12'].includes(v) ? v : (() => { throw new OpError('时钟制式非法'); })()),
  clockShowSeconds: (v) => boolStrict(v, '时钟秒数开关'),
  clockShowDate: (v) => boolStrict(v, '时钟日期开关'),
  clockFont: fontChoice('时钟字体'),
  clockFontCustom: fontNameOrEmpty,
  clockFontSize: (v) => intRange(v, 0, 200, '时钟字号须为 0–200（0=自动）'),
  countdownDurationSec: (v) => intRange(v, 1, 3600, '倒计时时长须为 1–3600 秒'),
  countdownDisplayMode: (v) =>
    (['corner', 'center', 'fullscreen'].includes(v)
      ? v
      : (() => { throw new OpError('倒计时显示模式非法'); })()),
  countdownTheme: (v) =>
    (['classic', 'ink', 'video'].includes(v)
      ? v
      : (() => { throw new OpError('倒计时主题非法'); })()),
  countdownShape: (v) =>
    (['circle', 'square', 'rounded', 'rounded-rect', 'rect'].includes(v)
      ? v
      : (() => { throw new OpError('倒计时窗口形状非法'); })()),
  countdownRadius: (v) => intRange(v, 0, 120, '倒计时圆角须为 0–120'),
  countdownSize: (v) => intRange(v, 200, 900, '倒计时窗口尺寸须为 200–900'),
  countdownHeight: (v) => intRange(v, 0, 900, '倒计时窗口高度须为 0–900（0=与宽度相同）'),
  countdownFontSize: (v) => intRange(v, 0, 300, '倒计时数字字号须为 0–300（0=自动）'),
  countdownFont: fontChoice('倒计时字体'),
  countdownFontCustom: fontNameOrEmpty,
  countdownPosition: (v) =>
    (['center', 'top-left', 'top', 'top-right', 'left', 'right',
      'bottom-left', 'bottom', 'bottom-right'].includes(v)
      ? v
      : (() => { throw new OpError('倒计时窗口位置非法'); })()),
  countdownShowProgress: (v) => boolStrict(v, '倒计时进度环开关'),
  countdownShowBackdrop: (v) => boolStrict(v, '倒计时遮罩开关'),
  countdownBg: (v) => hexOrEmpty(v, '倒计时窗口底色须为 #rrggbb 或留空'),
  countdownBgMode: (v) =>
    (['theme', 'custom', 'translucent', 'acrylic'].includes(v)
      ? v
      : (() => { throw new OpError('倒计时窗口背景模式非法'); })()),
  countdownBlur: (v) => intRange(v, 0, 40, '倒计时亚克力模糊须为 0–40'),
  countdownOpacity: (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0.2 || n > 1) throw new OpError('倒计时窗口不透明度须在 0.2–1 之间');
    return Math.round(n * 100) / 100;
  },
  countdownTextColor: (v) => hexOrEmpty(v, '倒计时文字颜色须为 #rrggbb 或留空'),
  displayView: (v) =>
    (['cards', 'leaderboard', 'welcome'].includes(v)
      ? v
      : (() => { throw new OpError('显示视图非法'); })()),
  leaderboardScope: (v) =>
    (['auto', 'people', 'teams'].includes(v) ? v : (() => { throw new OpError('排行榜范围非法'); })()),
  leaderboardLimit: (v) => intRange(v, 0, 200, '排行榜条数须为 0–200'),
  leaderboardScale: (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0.8 || n > 1.6) throw new OpError('排行榜缩放须在 0.8–1.6 之间');
    return Math.round(n * 100) / 100;
  },
  leaderboardFont: fontChoice('排行榜字体'),
  leaderboardFontCustom: fontNameOrEmpty,
  rankTieMode: (v) =>
    (['competition', 'dense', 'none'].includes(v)
      ? v
      : (() => { throw new OpError('并列名次模式非法'); })()),

  // ---- 记分效率与动效 ----
  quickScorePresets: (v) => {
    if (!Array.isArray(v)) throw new OpError('快捷分预设须为数组');
    if (v.length < 1 || v.length > 6) throw new OpError('快捷分预设须为 1–6 个');
    const out = v.map((n) => {
      const num = Number(n);
      if (!Number.isInteger(num) || num === 0 || Math.abs(num) > 10000) {
        throw new OpError('快捷分预设每项须为 ±10000 内非 0 整数');
      }
      return num;
    });
    return out;
  },
  scoreRolling: (v) => boolStrict(v, '滚动数字开关'),
  sortAnimation: (v) => boolStrict(v, '排序重排开关'),
  rankChangeAnimation: (v) => boolStrict(v, '名次升降开关'),
  featureMarquee: (v) => boolStrict(v, '跑马灯开关'),
  bgmEnabled: (v) => boolStrict(v, '背景音乐开关'),
  bgmFile: (v) => needAvatar(v === '' ? null : v),
  bgmVolume: (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 1) throw new OpError('背景音乐音量须在 0–1 之间');
    return Math.round(n * 100) / 100;
  },
  bgmLoop: (v) => boolStrict(v, '背景音乐循环开关'),
  featureBuzzer: (v) => boolStrict(v, '抢答模式开关'),
  featureTeamPk: (v) => boolStrict(v, '团队 PK 开关'),
  featureCarousel: (v) => boolStrict(v, '轮播开关'),
  carouselViews: (v) => {
    if (!Array.isArray(v)) throw new OpError('轮播视图须为数组');
    if (v.length < 1 || v.length > 5) throw new OpError('轮播视图须为 1–5 个');
    const allowed = ['cards', 'leaderboard', 'welcome'];
    const out = v.map((x) => {
      if (!allowed.includes(x)) throw new OpError('轮播视图取值非法');
      return x;
    });
    return out;
  },
  carouselIntervalSec: (v) => intRange(v, 3, 300, '轮播间隔须为 3–300 秒'),
  featureWelcome: (v) => boolStrict(v, '欢迎幕布开关'),
  marqueeText: (v) => (typeof v === 'string' ? v.slice(0, 200) : ''),
  marqueeFontSize: (v) => intRange(v, 0, 120, '跑马灯字号须为 0–120（0=自动）'),
  marqueeFont: fontChoice('跑马灯字体'),
  marqueeFontCustom: fontNameOrEmpty,
  marqueePosition: (v) =>
    (['top', 'bottom'].includes(v) ? v : (() => { throw new OpError('跑马灯位置非法'); })()),
  marqueeEffect: (v) =>
    (['scroll', 'blink', 'none'].includes(v)
      ? v
      : (() => { throw new OpError('跑马灯特效非法'); })()),
  marqueeColor: (v) => hexOrEmpty(v, '跑马灯文字颜色须为 #rrggbb 或留空'),
  marqueeBgColor: (v) => hexOrEmpty(v, '跑马灯背景色须为 #rrggbb 或留空'),
  marqueeSpeed: (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0.5 || n > 3) throw new OpError('跑马灯速度须在 0.5–3 之间');
    return Math.round(n * 100) / 100;
  },
  welcomeText: (v) => (typeof v === 'string' ? v.slice(0, 200) : ''),
  welcomeFont: fontChoice('欢迎幕布字体'),
  welcomeFontCustom: fontNameOrEmpty,
  welcomeFontSize: (v) => intRange(v, 0, 300, '欢迎幕布字号须为 0–300（0=自动）'),
  welcomeImage: (v) => needAvatar(v === '' ? null : v),
  welcomeBgColor: (v) => hexOrEmpty(v, '欢迎幕布底色须为 #rrggbb 或留空'),
};

// ---------- op 全集 ----------
function applyOp(op, payload) {
  payload = payload || {};

  // 项目级操作（不需要 projectId）
  switch (op) {
    case 'addProject': {
      const project = defaultProject(needString(payload.name, '项目名', 30));
      state.projects[project.id] = project;
      return { projectId: project.id };
    }
    case 'renameProject': {
      const p = needProject(payload.projectId);
      p.name = needString(payload.name, '项目名', 30);
      return {};
    }
    case 'deleteProject': {
      needProject(payload.projectId);
      if (Object.keys(state.projects).length <= 1) throw new OpError('至少保留一个项目');
      delete state.projects[payload.projectId];
      runtime.clearProjectRuntime(payload.projectId);
      return {};
    }
  }

  // 其余操作都属于某个项目
  const project = needProject(payload.projectId);

  switch (op) {
    case 'addPerson': {
      const id = genId('p');
      project.people[id] = {
        id,
        name: needString(payload.name, '姓名', 20),
        avatar: needAvatar(payload.avatar),
        cardImage: needAvatar(payload.cardImage),
        score: 0,
        teamId: null,
        layout: null,
        memberLayout: null,
        createdAt: Date.now(),
        order: nextOrder(project),
      };
      return { personId: id };
    }
    case 'addPeopleBatch': {
      requireFeature(project, 'featureBatchAdd');
      const rawNames = Array.isArray(payload.names) ? payload.names : [];
      if (!rawNames.length) throw new OpError('姓名列表为空');
      if (rawNames.length > 200) throw new OpError('单次最多添加 200 人');
      if (Object.keys(project.people).length + rawNames.length > 2000) {
        throw new OpError('项目人数已达上限（2000）');
      }
      const teamId = payload.teamId || null;
      if (teamId) needTeam(project, teamId);
      const existingNames = new Set(Object.values(project.people).map((p) => p.name));
      const seen = new Set();
      const personIds = [];
      const skipped = [];
      const now = Date.now();
      const baseOrder = nextOrder(project);
      rawNames.forEach((raw, index) => {
        if (typeof raw !== 'string') throw new OpError(`第 ${index + 1} 个姓名非法`);
        const name = raw.trim();
        if (!name) return;
        if (name.length > 20) throw new OpError(`第 ${index + 1} 个姓名过长（最多 20 字）`);
        if (seen.has(name) || existingNames.has(name)) {
          skipped.push(name);
          return;
        }
        seen.add(name);
        const id = genId('p');
        project.people[id] = {
          id,
          name,
          avatar: null,
          cardImage: null,
          score: 0,
          teamId,
          layout: null,
          memberLayout: null,
          createdAt: now + personIds.length,
          order: baseOrder + personIds.length,
        };
        personIds.push(id);
      });
      if (!personIds.length) throw new OpError('没有可添加的新人员');
      return { personIds, added: personIds.length, skipped };
    }
    case 'renamePerson': {
      const p = needPerson(project, payload.personId);
      p.name = needString(payload.name, '姓名', 20);
      return { name: p.name };
    }
    case 'removePerson': {
      needPerson(project, payload.personId);
      delete project.people[payload.personId];
      runtime.clearUndo(project.id);
      return {};
    }
    case 'movePerson': {
      const p = needPerson(project, payload.personId);
      moveEntityByOrder(project.people, p, payload.direction);
      project.settings.sortBy = 'manual'; // 调序即启用，避免大屏仍按分数排序造成“没反应”
      return { order: p.order };
    }
    case 'addTeam': {
      const id = genId('t');
      project.teams[id] = {
        id,
        name: needString(payload.name, '团队名', 20),
        avatar: needAvatar(payload.avatar),
        cardImage: needAvatar(payload.cardImage),
        layout: null,
        createdAt: Date.now(),
        order: nextOrder(project),
      };
      return { teamId: id };
    }
    case 'renameTeam': {
      const t = needTeam(project, payload.teamId);
      t.name = needString(payload.name, '团队名', 20);
      return { name: t.name };
    }
    case 'removeTeam': {
      needTeam(project, payload.teamId);
      delete project.teams[payload.teamId];
      for (const p of Object.values(project.people)) {
        if (p.teamId === payload.teamId) p.teamId = null;
      }
      return {};
    }
    case 'moveTeam': {
      const t = needTeam(project, payload.teamId);
      moveEntityByOrder(project.teams, t, payload.direction);
      project.settings.sortBy = 'manual'; // 调序即启用，避免大屏仍按分数排序造成“没反应”
      return { order: t.order };
    }
    case 'assignTeam': {
      const p = needPerson(project, payload.personId);
      if (payload.teamId != null) needTeam(project, payload.teamId);
      p.teamId = payload.teamId || null;
      return {};
    }
    case 'addScore': {
      const p = needPerson(project, payload.personId);
      const delta = needScore(payload.delta, '分数');
      const before = p.score;
      p.score = Math.max(-100000, Math.min(100000, before + delta));
      if (p.score !== before) {
        const label = `${p.name} ${delta > 0 ? '+' : ''}${delta}`;
        runtime.pushUndo(project.id, label, [{ personId: p.id, before }]);
        runtime.pushScoreLog(project.id, label, delta);
      }
      return { score: p.score };
    }
    case 'setScore': {
      const p = needPerson(project, payload.personId);
      const before = p.score;
      p.score = needScore(payload.score, '分数');
      if (p.score !== before) {
        const label = `${p.name} 改为 ${p.score}`;
        runtime.pushUndo(project.id, label, [{ personId: p.id, before }]);
        runtime.pushScoreLog(project.id, label, p.score - before);
      }
      return { score: p.score };
    }
    case 'addTeamScore': {
      requireFeature(project, 'featureTeamScore');
      const team = needTeam(project, payload.teamId);
      const delta = needScore(payload.delta, '分数');
      const members = Object.values(project.people).filter((p) => p.teamId === team.id);
      if (!members.length) throw new OpError('团队暂无成员');
      const entries = members.map((p) => {
        const before = p.score;
        p.score = Math.max(-100000, Math.min(100000, before + delta));
        return { personId: p.id, before };
      });
      const label = `${team.name} 各 ${delta > 0 ? '+' : ''}${delta}`;
      runtime.pushUndo(project.id, label, entries);
      runtime.pushScoreLog(project.id, label, delta);
      return { count: members.length };
    }
    case 'resetScores': {
      requireFeature(project, 'featureResetScores');
      const changed = Object.values(project.people).filter((p) => p.score !== 0);
      if (!changed.length) return { count: 0 };
      const entries = changed.map((p) => {
        const before = p.score;
        p.score = 0;
        return { personId: p.id, before };
      });
      runtime.pushUndo(project.id, '重置本局分数', entries);
      runtime.pushScoreLog(project.id, '重置本局分数', 0);
      return { count: changed.length };
    }
    case 'undoScore': {
      requireFeature(project, 'featureUndo');
      const entry = runtime.popUndo(project.id);
      if (!entry) throw new OpError('没有可撤销的记分');
      for (const item of entry.entries) {
        const p = project.people[item.personId];
        if (p) p.score = item.before;
      }
      runtime.pushScoreLog(project.id, '撤销：' + entry.label, 0);
      return { label: entry.label, undoCount: runtime.undoCount(project.id) };
    }
    case 'undoTo': {
      requireFeature(project, 'featureUndo');
      const keep = intRange(payload.keep, 0, runtime.UNDO_LIMIT, '撤销目标数量非法');
      const undone = runtime.undoTo(project.id, keep);
      if (!undone.length) throw new OpError('没有可撤销的记分');
      for (const entry of undone) {
        for (const item of entry.entries) {
          const p = project.people[item.personId];
          if (p) p.score = item.before;
        }
      }
      runtime.pushScoreLog(project.id, '连续撤销 ' + undone.length + ' 步', 0);
      return { count: undone.length, undoCount: runtime.undoCount(project.id) };
    }
    case 'setAvatar': {
      requireFeature(project, 'featureAvatarEdit');
      const entity = needEntity(project, payload.kind, payload.id);
      entity.avatar = needAvatar(payload.avatar === '' ? null : payload.avatar);
      return {};
    }
    case 'setCardImage': {
      const entity = needEntity(project, payload.kind, payload.id);
      entity.cardImage = needAvatar(payload.image === '' ? null : payload.image);
      return {};
    }
    case 'countdownStart': {
      requireFeature(project, 'featureCountdown');
      const sec = payload.durationSec != null
        ? intRange(payload.durationSec, 1, 3600, '倒计时时长须为 1–3600 秒')
        : project.settings.countdownDurationSec;
      const c = runtime.startCountdown(project.id, sec * 1000);
      return { countdown: c };
    }
    case 'countdownPause': {
      requireFeature(project, 'featureCountdown');
      const c = runtime.pauseCountdown(project.id);
      if (!c) throw new OpError('没有运行中的倒计时');
      return { countdown: c };
    }
    case 'countdownResume': {
      requireFeature(project, 'featureCountdown');
      const c = runtime.resumeCountdown(project.id);
      if (!c) throw new OpError('没有暂停中的倒计时');
      return { countdown: c };
    }
    case 'countdownReset': {
      requireFeature(project, 'featureCountdown');
      runtime.resetCountdown(project.id);
      return {};
    }
    case 'setLayout': {
      const entity = needEntity(project, payload.kind, payload.id);
      entity.layout = needLayout(payload.layout || payload);
      return { layout: entity.layout };
    }
    case 'setMemberLayout': {
      const p = needPerson(project, payload.personId);
      p.memberLayout = needLayout(payload.layout || payload);
      return { memberLayout: p.memberLayout };
    }
    case 'resetLayout': {
      for (const p of Object.values(project.people)) {
        p.layout = null;
        p.memberLayout = null;
      }
      for (const t of Object.values(project.teams)) t.layout = null;
      return {};
    }
    case 'updateSettings': {
      const patch = payload.patch;
      if (!patch || typeof patch !== 'object') throw new OpError('patch 非法');
      const validated = {};
      for (const [k, v] of Object.entries(patch)) {
        const validator = SETTINGS_VALIDATORS[k];
        if (!validator) continue; // 白名单之外的字段忽略
        validated[k] = validator(v);
      }
      const next = { ...project.settings, ...validated };
      // 排行榜功能关闭时不允许停留在排行榜视图；主动开启则拒绝
      if (next.displayView === 'leaderboard' && !next.featureLeaderboard) {
        if (validated.displayView === 'leaderboard') throw new OpError('排行榜功能未开启');
        next.displayView = 'cards';
      }
      Object.assign(project.settings, next);
      // 关闭倒计时开关时立即清掉运行态，避免后台计时器继续跑
      if (validated.featureCountdown === false) runtime.resetCountdown(project.id);
      return {};
    }
    default:
      throw new OpError('未知操作: ' + op);
  }
}

// ---------- 项目导出 / 导入 ----------
function exportProjectData(projectId) {
  return JSON.parse(JSON.stringify(needProject(projectId)));
}

function walkAssetRefs(project, mapper) {
  for (const p of Object.values(project.people)) {
    p.avatar = mapper(p.avatar);
    p.cardImage = mapper(p.cardImage);
  }
  for (const t of Object.values(project.teams)) {
    t.avatar = mapper(t.avatar);
    t.cardImage = mapper(t.cardImage);
  }
  project.settings.bgImage = mapper(project.settings.bgImage);
  project.settings.customSound = mapper(project.settings.customSound);
}

function sanitizeImportedProject(raw) {
  const src = raw && typeof raw === 'object' && raw.project ? raw.project : raw;
  if (!src || typeof src !== 'object') throw new OpError('导入数据格式非法');
  const settings = { ...DEFAULT_SETTINGS };
  if (src.settings && typeof src.settings === 'object') {
    for (const [key, value] of Object.entries(src.settings)) {
      const validator = SETTINGS_VALIDATORS[key];
      if (!validator) continue;
      try {
        settings[key] = validator(value);
      } catch (e) {
        throw new OpError('设置项 ' + key + ' 非法：' + e.message);
      }
    }
    // 旧数据兼容
    if (!src.settings.cardStyle && src.settings.glassEnabled) settings.cardStyle = 'glass';
    if (src.settings.cardBgMode == null) settings.cardBgMode = src.settings.cardBg ? 'custom' : 'auto';
  }

  const teams = {};
  const rawTeams = src.teams && typeof src.teams === 'object' ? Object.entries(src.teams) : [];
  if (rawTeams.length > 200) throw new OpError('团队数量超出上限（200）');
  for (const [id, rawTeam] of rawTeams) {
    if (!rawTeam || typeof rawTeam !== 'object') throw new OpError('团队数据非法');
    let teamId = typeof rawTeam.id === 'string' && /^[A-Za-z0-9_-]+$/.test(rawTeam.id) && !teams[rawTeam.id]
      ? rawTeam.id : genId('t');
    if (teams[teamId]) teamId = genId('t');
    teams[teamId] = {
      id: teamId,
      name: needString(rawTeam.name, '团队名', 20),
      avatar: rawTeam.avatar ? needAvatar(rawTeam.avatar) : null,
      cardImage: rawTeam.cardImage ? needAvatar(rawTeam.cardImage) : null,
      layout: rawTeam.layout ? needLayout(rawTeam.layout) : null,
      createdAt: Number.isFinite(rawTeam.createdAt) ? rawTeam.createdAt : Date.now(),
      order: Number.isFinite(rawTeam.order) ? rawTeam.order : undefined,
    };
  }

  const people = {};
  const rawPeople = src.people && typeof src.people === 'object' ? Object.entries(src.people) : [];
  if (rawPeople.length > 1000) throw new OpError('人员数量超出上限（1000）');
  for (const [id, rawPerson] of rawPeople) {
    if (!rawPerson || typeof rawPerson !== 'object') throw new OpError('人员数据非法');
    let personId = typeof rawPerson.id === 'string' && /^[A-Za-z0-9_-]+$/.test(rawPerson.id) && !people[rawPerson.id]
      ? rawPerson.id : genId('p');
    if (people[personId]) personId = genId('p');
    const rawScore = Number(rawPerson.score);
    people[personId] = {
      id: personId,
      name: needString(rawPerson.name, '姓名', 20),
      avatar: rawPerson.avatar ? needAvatar(rawPerson.avatar) : null,
      cardImage: rawPerson.cardImage ? needAvatar(rawPerson.cardImage) : null,
      score: Number.isFinite(rawScore) ? Math.max(-100000, Math.min(100000, Math.round(rawScore))) : 0,
      teamId: rawPerson.teamId && teams[rawPerson.teamId] ? rawPerson.teamId : null,
      layout: rawPerson.layout ? needLayout(rawPerson.layout) : null,
      memberLayout: rawPerson.memberLayout ? needLayout(rawPerson.memberLayout) : null,
      createdAt: Number.isFinite(rawPerson.createdAt) ? rawPerson.createdAt : Date.now(),
      order: Number.isFinite(rawPerson.order) ? rawPerson.order : undefined,
    };
  }

  const baseName = needString(typeof src.name === 'string' && src.name.trim() ? src.name : '导入项目', '项目名', 30);
  const existing = new Set(Object.values(state.projects).map((p) => p.name));
  let name = baseName;
  let index = 2;
  while (existing.has(name)) {
    const suffix = '（' + index + '）';
    name = baseName.slice(0, 30 - suffix.length) + suffix;
    index += 1;
  }

  const project = {
    id: genId('pr'),
    name,
    createdAt: Date.now(),
    people,
    teams,
    settings,
  };
  normalizeOrders(project);
  return project;
}

module.exports = {
  state,
  init,
  applyOp,
  save,
  flushSave,
  OpError,
  DATA_DIR,
  AVATAR_DIR,
  SOUND_DIR,
  storageKind: storage.kind,
  exportProjectData,
  sanitizeImportedProject,
  walkAssetRefs,
};
