'use strict';
// 权威状态：多项目 + 存储后端（json/sqlite/postgres/mysql）
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createStorage } = require('./storage');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const AVATAR_DIR = path.join(DATA_DIR, 'avatars');
const SOUND_DIR = path.join(DATA_DIR, 'sounds');

const DEFAULT_SETTINGS = {
  title: '计分板',
  displayStyle: 'lecture',  // lecture | ppt | seewo | kde | custom
  columns: 4,
  density: 'comfortable',   // comfortable | compact
  sortBy: 'score',          // score | created
  sortOrder: 'desc',        // desc | asc
  theme: 'dark',            // dark | light
  accent: '#e8a33d',
  showMemberScore: true,
  showTeamTotal: true,
  bgType: 'color',          // color | image
  bgColor: '',              // '' = 跟随主题
  bgImage: null,            // avatars/xxx.png
  cardBg: '',               // '' = 跟随主题
  cardRadius: 10,           // 0–32
  layoutMode: 'auto',       // auto | free（自由布局：百分比坐标）
  memberScale: 1,           // 成员小卡片缩放 0.6–2
  avatarPosition: 'left',   // left | right | top | bottom（头像相对姓名）
  avatarSizeMode: 'auto',   // auto（随卡片自适应）| manual
  avatarSize: 64,           // 手动头像大小 px（24–160）
  cardStyle: 'solid',       // solid | glass | neumorph | neon | gradient | paper
  glassBlur: 12,            // 毛玻璃模糊强度 px（0–40）
  glassOpacity: 0.55,       // 毛玻璃卡片不透明度（0.15–0.95）
  scoreEffect: 'bounce',    // none | bounce | glow | float | shake | confetti | spotlight
  spotlightScope: 'person', // person（只突显人物）| person_team（人物 + 团队）
  scoreEffectDuration: 700, // 特效时长 ms（200–3000）
  scoreEffectColor: '',     // '' = 自动（加分绿/减分红）；或 #rrggbb
  scoreEffectOnlyPositive: false, // 仅加分触发特效
  soundEnabled: false,      // 记分音效
  soundVolume: 0.5,         // 音效音量 0–1
  customSound: '',          // '' = 内置合成音；否则 sounds/xxx.mp3
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

function normalizeProject(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const settings = { ...DEFAULT_SETTINGS, ...(p.settings || {}) };
  // 旧版本：毛玻璃开关 → 卡片样式
  if (p.settings && !p.settings.cardStyle) {
    settings.cardStyle = p.settings.glassEnabled ? 'glass' : 'solid';
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
  return {
    id: typeof p.id === 'string' && p.id ? p.id : genId('pr'),
    name: typeof p.name === 'string' && p.name.trim() ? p.name.trim().slice(0, 30) : '未命名项目',
    createdAt: p.createdAt || Date.now(),
    people,
    teams,
    settings,
  };
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
  w = Math.max(8, Math.min(100, w));
  h = Math.max(6, Math.min(100, h));
  x = Math.max(0, Math.min(100 - w, x));
  y = Math.max(0, Math.min(100 - h, y));
  return { x, y, w, h };
}
function needEntity(project, kind, id) {
  if (kind === 'person') return needPerson(project, id);
  if (kind === 'team') return needTeam(project, id);
  throw new OpError('实体类型非法');
}

const SETTINGS_VALIDATORS = {
  title: (v) => needString(v, '标题', 30),
  displayStyle: (v) =>
    (['lecture', 'ppt', 'seewo', 'kde', 'custom'].includes(v)
      ? v
      : (() => { throw new OpError('显示风格非法'); })()),
  columns: (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 8) throw new OpError('列数须为 1–8 的整数');
    return n;
  },
  density: (v) => (['comfortable', 'compact'].includes(v) ? v : (() => { throw new OpError('密度取值非法'); })()),
  sortBy: (v) => (['score', 'created'].includes(v) ? v : (() => { throw new OpError('排序方式非法'); })()),
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
  cardBg: (v) => {
    if (v === '' || v == null) return '';
    return /^#[0-9a-fA-F]{6}$/.test(v) ? v : (() => { throw new OpError('卡片底色须为 #rrggbb 或留空'); })();
  },
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
    (['none', 'bounce', 'glow', 'float', 'shake', 'confetti', 'spotlight'].includes(v)
      ? v
      : (() => { throw new OpError('加分特效类型非法'); })()),
  spotlightScope: (v) =>
    (['person', 'person_team'].includes(v)
      ? v
      : (() => { throw new OpError('突显范围非法'); })()),
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
      };
      return { personId: id };
    }
    case 'removePerson': {
      needPerson(project, payload.personId);
      delete project.people[payload.personId];
      return {};
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
      };
      return { teamId: id };
    }
    case 'removeTeam': {
      needTeam(project, payload.teamId);
      delete project.teams[payload.teamId];
      for (const p of Object.values(project.people)) {
        if (p.teamId === payload.teamId) p.teamId = null;
      }
      return {};
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
      p.score = Math.max(-100000, Math.min(100000, p.score + delta));
      return { score: p.score };
    }
    case 'setScore': {
      const p = needPerson(project, payload.personId);
      p.score = needScore(payload.score, '分数');
      return { score: p.score };
    }
    case 'setCardImage': {
      const entity = needEntity(project, payload.kind, payload.id);
      entity.cardImage = needAvatar(payload.image === '' ? null : payload.image);
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
      for (const [k, v] of Object.entries(patch)) {
        const validator = SETTINGS_VALIDATORS[k];
        if (!validator) continue; // 白名单之外的字段忽略
        project.settings[k] = validator(v);
      }
      return {};
    }
    default:
      throw new OpError('未知操作: ' + op);
  }
}

module.exports = {
  state,
  init,
  applyOp,
  save,
  OpError,
  AVATAR_DIR,
  SOUND_DIR,
  storageKind: storage.kind,
};
