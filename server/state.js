'use strict';
// 权威状态：多项目 + 存储后端（json/sqlite/postgres/mysql）
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createStorage } = require('./storage');
const runtime = require('./runtime');
const { config } = require('./config');
const { logger } = require('./logger');
const { OPS } = require('./ops');
const {
  OpError, needString, needAvatar, needBio, needScore, needLayout, intRange,
} = require('./validation');
const { DEFAULT_SETTINGS, THEME_SETTING_KEYS, SETTINGS_VALIDATORS } = require('./settings');
const lock = require('./lock');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const AVATAR_DIR = path.join(DATA_DIR, 'avatars');
const SOUND_DIR = path.join(DATA_DIR, 'sounds');


const storage = createStorage();

let state = { version: 2, projects: {} };
let initialized = false;

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

function setOrderCache(project, value) {
  // 非枚举：不会被 JSON.stringify 写进 state 文件
  Object.defineProperty(project, '__maxOrder', {
    value,
    writable: true,
    enumerable: false,
    configurable: true,
  });
}

function invalidateOrderCache(project) {
  delete project.__maxOrder;
}

function nextOrder(project) {
  if (Number.isFinite(project.__maxOrder)) {
    project.__maxOrder += 1;
    return project.__maxOrder;
  }
  let max = -1;
  for (const entity of [...Object.values(project.people), ...Object.values(project.teams)]) {
    if (Number.isFinite(entity.order) && entity.order > max) max = entity.order;
  }
  const next = max + 1;
  setOrderCache(project, next);
  return next;
}

function compareOrder(a, b) {
  const ao = orderOf(a);
  const bo = orderOf(b);
  if (ao !== bo) return ao < bo ? -1 : 1;
  return (a.createdAt || 0) - (b.createdAt || 0);
}

function normalizeOrders(project) {
  const entities = [...Object.values(project.people), ...Object.values(project.teams)];
  entities.sort(compareOrder);
  entities.forEach((entity, index) => { entity.order = index; });
  setOrderCache(project, entities.length - 1);
}

// 在同类集合中找排序上紧邻的前/后一项，替代每次 O(n log n) 排序
function findNeighbor(collection, entity, direction) {
  if (!entity || collection[entity.id] !== entity) return null;
  let best = null;
  for (const other of Object.values(collection)) {
    if (other === entity) continue;
    const c = compareOrder(other, entity);
    if (direction === 'up' && c < 0) {
      if (!best || compareOrder(other, best) > 0) best = other;
    } else if (direction === 'down' && c > 0) {
      if (!best || compareOrder(other, best) < 0) best = other;
    }
  }
  return best;
}

function moveEntityByOrder(collection, entity, direction) {
  if (direction !== 'up' && direction !== 'down') throw new OpError('移动方向非法');
  const other = findNeighbor(collection, entity, direction);
  if (!other) return;
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

  // 已移除的内置主题「真·古风」→ 回落到大屏讲演
  if (settings.displayStyle === 'xianxia') settings.displayStyle = 'lecture';

  // 旧版本：座右铭字段/设置改名为简介（bio）
  const rawSettings = p.settings && typeof p.settings === 'object' ? p.settings : {};
  const bioRename = {
    featureMotto: 'featureBio',
    mottoFont: 'bioFont',
    mottoFontCustom: 'bioFontCustom',
    mottoSize: 'bioSize',
    mottoColor: 'bioColor',
    mottoOpacity: 'bioOpacity',
    mottoItalic: 'bioItalic',
  };
  for (const [oldKey, newKey] of Object.entries(bioRename)) {
    if (rawSettings[oldKey] !== undefined && rawSettings[newKey] === undefined) {
      settings[newKey] = rawSettings[oldKey];
    }
    delete settings[oldKey];
  }

  const people = {};
  for (const [id, person] of Object.entries(p.people || {})) {
    if (!person || typeof person !== 'object') continue;
    people[id] = {
      ...person,
      id: person.id || id,
      cardImage: person.cardImage === undefined ? null : person.cardImage,
      layout: person.layout === undefined ? null : person.layout,
      memberLayout: person.memberLayout === undefined ? null : person.memberLayout,
      bio: typeof person.bio === 'string' ? person.bio : (typeof person.motto === 'string' ? person.motto : ''),
    };
    delete people[id].motto;
  }
  const teams = {};
  for (const [id, team] of Object.entries(p.teams || {})) {
    if (!team || typeof team !== 'object') continue;
    teams[id] = {
      ...team,
      id: team.id || id,
      cardImage: team.cardImage === undefined ? null : team.cardImage,
      layout: team.layout === undefined ? null : team.layout,
      bio: typeof team.bio === 'string' ? team.bio : (typeof team.motto === 'string' ? team.motto : ''),
    };
    delete teams[id].motto;
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
  lock.acquire(DATA_DIR);
  await storage.init();
  const raw = await storage.load();
  const normalized = normalizeState(raw);
  for (const key of Object.keys(state)) delete state[key];
  Object.assign(state, normalized);
  initialized = true;
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
  if (!initialized) return;
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
      logger.error('状态保存失败', { error: e.message, stack: e.stack });
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
const shutdownHooks = [];

/** 注册退出钩子（关闭 HTTP/WS 等），在 flush 之前执行 */
function onShutdown(fn) {
  shutdownHooks.push(fn);
}

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  const log = logger.child({ scope: 'shutdown' });

  // 先停止接受新操作，再落盘
  for (const fn of shutdownHooks) {
    try {
      await fn();
    } catch (e) {
      log.error('关闭钩子失败', { error: e.message });
    }
  }

  const timeoutMs = config.shutdownFlushTimeoutMs;
  const flushed = await Promise.race([
    flushSave().then(() => true).catch((e) => {
      log.error('落盘失败', { error: e.message });
      return false;
    }),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
  if (!flushed) log.error('落盘超时，状态可能未保存', { timeoutMs });

  try {
    await Promise.race([storage.close(), new Promise((r) => setTimeout(r, 5000))]);
  } catch (_) {}
  lock.release();
  process.exit(exitCode);
}
process.on('SIGINT', () => { void shutdown(0); });
process.on('SIGTERM', () => { void shutdown(0); });

// ---------- 领域校验辅助 ----------
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
function needEntity(project, kind, id) {
  if (kind === 'person') return needPerson(project, id);
  if (kind === 'team') return needTeam(project, id);
  throw new OpError('实体类型非法');
}
function requireFeature(project, key) {
  if (!project.settings[key]) throw new OpError('该功能未开启');
}

// ---------- op 全集 ----------
function applyOp(op, payload) {
  payload = payload || {};

  // 项目级操作（不需要 projectId）
  switch (op) {
    case OPS.addProject: {
      const project = defaultProject(needString(payload.name, '项目名', 30));
      state.projects[project.id] = project;
      return { projectId: project.id };
    }
    case OPS.renameProject: {
      const p = needProject(payload.projectId);
      p.name = needString(payload.name, '项目名', 30);
      return {};
    }
    case OPS.deleteProject: {
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
    case OPS.addPerson: {
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
    case OPS.addPeopleBatch: {
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
          order: nextOrder(project),
        };
        personIds.push(id);
      });
      if (!personIds.length) throw new OpError('没有可添加的新人员');
      return { personIds, added: personIds.length, skipped };
    }
    case OPS.renamePerson: {
      const p = needPerson(project, payload.personId);
      p.name = needString(payload.name, '姓名', 20);
      return { name: p.name };
    }
    case OPS.setBio: {
      const entity = needEntity(project, payload.kind, payload.id);
      entity.bio = needBio(payload.bio);
      return { bio: entity.bio };
    }
    case OPS.removePerson: {
      needPerson(project, payload.personId);
      delete project.people[payload.personId];
      invalidateOrderCache(project);
      runtime.clearUndo(project.id);
      return {};
    }
    case OPS.movePerson: {
      const p = needPerson(project, payload.personId);
      moveEntityByOrder(project.people, p, payload.direction);
      project.settings.sortBy = 'manual'; // 调序即启用，避免大屏仍按分数排序造成“没反应”
      return { order: p.order };
    }
    case OPS.addTeam: {
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
    case OPS.renameTeam: {
      const t = needTeam(project, payload.teamId);
      t.name = needString(payload.name, '团队名', 20);
      return { name: t.name };
    }
    case OPS.removeTeam: {
      needTeam(project, payload.teamId);
      delete project.teams[payload.teamId];
      for (const p of Object.values(project.people)) {
        if (p.teamId === payload.teamId) p.teamId = null;
      }
      invalidateOrderCache(project);
      return {};
    }
    case OPS.moveTeam: {
      const t = needTeam(project, payload.teamId);
      moveEntityByOrder(project.teams, t, payload.direction);
      project.settings.sortBy = 'manual'; // 调序即启用，避免大屏仍按分数排序造成“没反应”
      return { order: t.order };
    }
    case OPS.assignTeam: {
      const p = needPerson(project, payload.personId);
      if (payload.teamId != null) needTeam(project, payload.teamId);
      p.teamId = payload.teamId || null;
      return {};
    }
    case OPS.addScore: {
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
    case OPS.setScore: {
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
    case OPS.addTeamScore: {
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
    case OPS.resetScores: {
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
    case OPS.undoScore: {
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
    case OPS.undoTo: {
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
    case OPS.setAvatar: {
      requireFeature(project, 'featureAvatarEdit');
      const entity = needEntity(project, payload.kind, payload.id);
      entity.avatar = needAvatar(payload.avatar === '' ? null : payload.avatar);
      return {};
    }
    case OPS.setCardImage: {
      const entity = needEntity(project, payload.kind, payload.id);
      entity.cardImage = needAvatar(payload.image === '' ? null : payload.image);
      return {};
    }
    case OPS.countdownStart: {
      requireFeature(project, 'featureCountdown');
      const sec = payload.durationSec != null
        ? intRange(payload.durationSec, 1, 3600, '倒计时时长须为 1–3600 秒')
        : project.settings.countdownDurationSec;
      const c = runtime.startCountdown(project.id, sec * 1000);
      return { countdown: c };
    }
    case OPS.countdownPause: {
      requireFeature(project, 'featureCountdown');
      const c = runtime.pauseCountdown(project.id);
      if (!c) throw new OpError('没有运行中的倒计时');
      return { countdown: c };
    }
    case OPS.countdownResume: {
      requireFeature(project, 'featureCountdown');
      const c = runtime.resumeCountdown(project.id);
      if (!c) throw new OpError('没有暂停中的倒计时');
      return { countdown: c };
    }
    case OPS.countdownReset: {
      requireFeature(project, 'featureCountdown');
      runtime.resetCountdown(project.id);
      return {};
    }
    case OPS.setLayout: {
      const entity = needEntity(project, payload.kind, payload.id);
      entity.layout = needLayout(payload.layout || payload);
      return { layout: entity.layout };
    }
    case OPS.setMemberLayout: {
      const p = needPerson(project, payload.personId);
      p.memberLayout = needLayout(payload.layout || payload);
      return { memberLayout: p.memberLayout };
    }
    case OPS.resetLayout: {
      for (const p of Object.values(project.people)) {
        p.layout = null;
        p.memberLayout = null;
      }
      for (const t of Object.values(project.teams)) t.layout = null;
      return {};
    }
    case OPS.applyTheme: {
      const patch = payload.settings;
      if (patch !== undefined && (!patch || typeof patch !== 'object' || Array.isArray(patch))) {
        throw new OpError('主题设置非法');
      }
      const validated = {};
      for (const [k, v] of Object.entries(patch || {})) {
        if (!THEME_SETTING_KEYS.has(k)) throw new OpError('主题包含不支持的设置项: ' + k);
        const validator = SETTINGS_VALIDATORS[k];
        if (!validator) throw new OpError('主题包含不支持的设置项: ' + k);
        validated[k] = validator(v);
      }
      let baseStyle = null;
      if (payload.baseStyle !== undefined) {
        baseStyle = SETTINGS_VALIDATORS.displayStyle(payload.baseStyle);
      }
      if (baseStyle) project.settings.displayStyle = baseStyle;
      Object.assign(project.settings, validated);
      return { applied: Object.keys(validated).length, baseStyle: project.settings.displayStyle };
    }
    case OPS.updateSettings: {
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
    // 兼容已删除的内置主题「真·古风」
    if (src.settings.displayStyle === 'xianxia') src.settings.displayStyle = 'lecture';
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
  const rawTeams = src.teams && typeof src.teams === 'object' ? Object.values(src.teams) : [];
  if (rawTeams.length > 200) throw new OpError('团队数量超出上限（200）');
  for (const rawTeam of rawTeams) {
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
      bio: rawTeam.bio ? needBio(rawTeam.bio) : (rawTeam.motto ? needBio(rawTeam.motto) : ''),
      createdAt: Number.isFinite(rawTeam.createdAt) ? rawTeam.createdAt : Date.now(),
      order: Number.isFinite(rawTeam.order) ? rawTeam.order : undefined,
    };
  }

  const people = {};
  const rawPeople = src.people && typeof src.people === 'object' ? Object.values(src.people) : [];
  if (rawPeople.length > 1000) throw new OpError('人员数量超出上限（1000）');
  for (const rawPerson of rawPeople) {
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
      bio: rawPerson.bio ? needBio(rawPerson.bio) : (rawPerson.motto ? needBio(rawPerson.motto) : ''),
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
  DEFAULT_SETTINGS,
  THEME_SETTING_KEYS,
  init,
  applyOp,
  save,
  flushSave,
  onShutdown,
  shutdown,
  OpError,
  DATA_DIR,
  AVATAR_DIR,
  SOUND_DIR,
  storageKind: storage.kind,
  exportProjectData,
  sanitizeImportedProject,
  walkAssetRefs,
};
