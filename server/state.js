'use strict';
// 权威状态：多项目 + 存储后端（json/sqlite/postgres/mysql）
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { createStorageFromConfig, StorageConflictError, StorageConfigError } = require('./storage');
const { resolveStorageConfig, configFingerprint } = require('./storage-config');
const { retry, withTimeout } = require('./storage/common');
const runtime = require('./runtime');
const { config } = require('./config');
const { logger } = require('./logger');
const { OPS } = require('./ops');
const {
  OpError, NotFoundError, FeatureDisabledError,
  needString, needAvatar, needBio, needScore, needLayout, intRange,
} = require('./validation');
const {
  DEFAULT_SETTINGS, THEME_SETTING_KEYS, SETTINGS_VALIDATORS,
  normalizeMemberMenuButton, normalizeMemberMenuConfig, MEMBER_MENU_ENTRY_LIMIT,
} = require('./settings');
const { currentActor } = require('./auth/context');
const { assertCanOp } = require('./auth/policy');
const {
  THEME_FORMAT, THEME_VERSION, LIMITS,
  genThemeId, normalizeTheme, normalizeDraft, themeBytes, themeSummary,
} = require('./theme/schema');
const lock = require('./lock');
const { DATA_DIR, AVATAR_DIR, SOUND_DIR } = require('./paths');

/** @type {any} */
let storage = null;
/** 启动时实际生效的后端配置；用于管理端展示「当前数据位置」。 */
let activeStorageConfig = /** @type {any} */ (null);
let storageKind = 'uninitialized';
let storageSource = 'default';
let storageConfigHash = '';
let storageRevision = /** @type {any} */ (null);
let storageConflict = false;
let distributedLockHeld = false;
let lastSaveAt = 0;
let lastSaveError = /** @type {string|null} */ (null);
const storageOwnerId = `${os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString('hex')}`;

let state = { version: 2, projects: {}, themes: {}, themeDrafts: {} };
let initialized = false;

function getStorageKind() {
  return storageKind;
}

function getStorageStatus() {
  return {
    kind: storageKind,
    source: storageSource,
    revision: storageRevision,
    lastSaveAt: lastSaveAt || null,
    lastSaveError,
    conflict: storageConflict,
    initialized,
    configHash: storageConfigHash,
  };
}

/**
 * @param {{ probe?: boolean }} [options]
 */
async function getStorageHealth(options = {}) {
  if (!storage) {
    return {
      ok: false,
      kind: storageKind,
      revision: storageRevision,
      lastSaveAt: lastSaveAt || null,
      lastSaveError,
      conflict: storageConflict,
      warnings: ['存储尚未初始化'],
    };
  }
  try {
    const result = await withTimeout(
      storage.health(options),
      config.storage.healthTimeoutMs,
      '存储健康检查',
    );
    return {
      ...result,
      conflict: storageConflict,
      lock: {
        supported: Boolean(storage.capabilities && storage.capabilities.distributedLock),
        acquired: distributedLockHeld,
        kind: storage.capabilities ? storage.capabilities.lockKind : null,
      },
    };
  } catch (error) {
    return {
      ok: false,
      kind: storageKind,
      revision: storageRevision,
      lastSaveAt: lastSaveAt || null,
      lastSaveError: lastSaveError || (error && error.message ? error.message : String(error)),
      conflict: storageConflict,
      warnings: [error && error.message ? error.message : String(error)],
    };
  }
}

function genId(prefix) {
  return prefix + '_' + crypto.randomBytes(4).toString('hex');
}

function defaultSettings() {
  // 深拷贝：memberMenus 等数组/对象不能被多个项目共享引用
  return structuredClone(DEFAULT_SETTINGS);
}

function defaultProject(name) {
  return {
    id: genId('pr'),
    name: name || '新项目',
    createdAt: Date.now(),
    people: {},
    teams: {},
    settings: defaultSettings(),
    themeId: null,
    themeRevision: 0,
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

/** 加载旧数据时宽容清洗人员菜单：损坏项丢弃，不阻断启动。 */
function coerceMemberMenus(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (out.length >= MEMBER_MENU_ENTRY_LIMIT) break;
    try {
      const menu = normalizeMemberMenuConfig(item);
      if (seen.has(menu.userId)) continue;
      seen.add(menu.userId);
      out.push(menu);
    } catch (_) {
      // 忽略损坏菜单，保留其余可用配置
    }
  }
  return out;
}

function normalizeProject(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const settings = { ...DEFAULT_SETTINGS, ...(p.settings || {}) };
  // 队员控制台：按账号的菜单做宽容收敛，避免损坏的持久化数据进入广播
  settings.featureMemberConsole = settings.featureMemberConsole !== false;
  settings.memberMenus = coerceMemberMenus(settings.memberMenus);
  // 移除早期版本的项目级共享菜单字段
  delete settings.memberMenuColumns;
  delete settings.memberMenuGap;
  delete settings.memberMenuButtons;
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
      captainId: typeof team.captainId === 'string' ? team.captainId : null,
    };
    delete teams[id].motto;
  }
  // 队长必须是该团队的成员；悬空或跨队时清空。
  for (const team of Object.values(teams)) {
    const captain = team.captainId ? people[team.captainId] : null;
    if (!captain || captain.teamId !== team.id) team.captainId = null;
  }
  const project = {
    id: typeof p.id === 'string' && p.id ? p.id : genId('pr'),
    name: typeof p.name === 'string' && p.name.trim() ? p.name.trim().slice(0, 30) : '未命名项目',
    createdAt: p.createdAt || Date.now(),
    people,
    teams,
    settings,
    themeId: typeof p.themeId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(p.themeId) ? p.themeId : null,
    themeRevision: Math.max(0, Math.floor(Number(p.themeRevision) || 0)),
  };
  normalizeOrders(project);
  return project;
}

function normalizeThemeMap(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, theme] of Object.entries(raw)) {
    if (!theme || typeof theme !== 'object') continue;
    try {
      const meta = theme.meta && typeof theme.meta === 'object' ? theme.meta : {};
      out[id] = normalizeTheme(theme, {
        id,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        revision: meta.revision,
      });
    } catch (e) {
      logger.warn('忽略非法主题', { id, error: e.message });
    }
  }
  return out;
}

function normalizeState(raw) {
  const out = { version: 2, projects: {}, themes: {}, themeDrafts: {} };
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
  // 允许零项目：管理端会显示欢迎页，由用户新建/导入项目
  out.themes = normalizeThemeMap(raw && raw.themes);
  if (raw && raw.themeDrafts && typeof raw.themeDrafts === 'object') {
    for (const [projectId, draft] of Object.entries(raw.themeDrafts)) {
      if (!out.projects[projectId] || !draft || typeof draft !== 'object') continue;
      try {
        const meta = draft.meta && typeof draft.meta === 'object' ? draft.meta : {};
        out.themeDrafts[projectId] = normalizeTheme(draft, {
          id: 'draft_' + projectId,
          createdAt: meta.createdAt,
          updatedAt: meta.updatedAt,
          revision: meta.revision,
        });
      } catch (e) {
        logger.warn('忽略非法主题草稿', { projectId, error: e.message });
      }
    }
  }
  return out;
}

// ---------- 初始化 ----------
async function init() {
  if (initialized) return;
  fs.mkdirSync(AVATAR_DIR, { recursive: true });
  fs.mkdirSync(SOUND_DIR, { recursive: true });
  let localLocked = false;
  let distributedLocked = false;
  try {
    // 先拿本地文件锁：同机双实例应在连接数据库前就失败。
    lock.acquire(DATA_DIR);
    localLocked = true;

    const resolved = resolveStorageConfig();
    storageSource = resolved.source;
    storageConfigHash = configFingerprint(resolved.config);
    storage = createStorageFromConfig(resolved.config);
    activeStorageConfig = resolved.config;
    storageKind = storage.kind;

    const st = config.storage;
    await retry(
      () => withTimeout(storage.init(), st.connectTimeoutMs, '初始化存储'),
      { retries: st.retries, baseDelayMs: st.retryBaseMs, label: '初始化存储' },
    );

    if (
      !config.allowMultiInstance &&
      storage.capabilities && storage.capabilities.distributedLock &&
      typeof storage.acquireLock === 'function'
    ) {
      await withTimeout(
        storage.acquireLock(storageOwnerId, {
          ttlMs: st.lockTtlMs,
          renewMs: st.lockRenewMs,
          waitMs: st.lockWaitMs,
        }),
        st.connectTimeoutMs,
        '获取存储锁',
      );
      distributedLocked = true;
      distributedLockHeld = true;
    }

    const raw = await withTimeout(storage.load(), st.connectTimeoutMs, '读取状态');
    storageRevision = typeof storage.getRevision === 'function' ? storage.getRevision() : null;
    const normalized = normalizeState(raw);
    for (const key of Object.keys(state)) delete state[key];
    Object.assign(state, normalized);
    initialized = true;
  } catch (error) {
    if (distributedLocked && storage && typeof storage.releaseLock === 'function') {
      try { await storage.releaseLock(storageOwnerId); } catch (_) {}
    }
    distributedLockHeld = false;
    if (storage) {
      try { await storage.close(); } catch (_) {}
    }
    if (localLocked) lock.release();
    storage = null;
    activeStorageConfig = null;
    storageKind = 'uninitialized';
    throw error;
  }
}

// ---------- 持久化（100ms 防抖 + 串行写队列 + 失败退避重试） ----------
let saveTimer = null;
let saveRetryTimer = null;
let saveRetryDelayMs = 0;
let saving = false;
let dirty = false;

function save() {
  if (!initialized || storageConflict) return;
  if (saveTimer || saveRetryTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void doSave();
  }, 100);
}

function scheduleSaveRetry() {
  if (saveRetryTimer || storageConflict || !initialized) return;
  saveRetryDelayMs = saveRetryDelayMs
    ? Math.min(config.storage.saveRetryMaxMs, saveRetryDelayMs * 2)
    : config.storage.saveRetryBaseMs;
  saveRetryTimer = setTimeout(() => {
    saveRetryTimer = null;
    void doSave();
  }, saveRetryDelayMs);
  if (saveRetryTimer && typeof saveRetryTimer.unref === 'function') saveRetryTimer.unref();
}

async function doSave() {
  if (!initialized || !storage || storageConflict) return;
  if (saving) {
    dirty = true;
    return;
  }
  saving = true;
  do {
    dirty = false;
    try {
      const snapshotLimit = Number(storage.maxSnapshotBytes) || 0;
      if (snapshotLimit > 0) {
        const bytes = Buffer.byteLength(JSON.stringify(state), 'utf8');
        if (bytes > snapshotLimit) {
          throw new StorageConfigError(
            `状态快照 ${bytes} 字节超过 ${storageKind} 的保存上限 ${snapshotLimit} 字节，请精简项目或更换后端`,
            { code: 'SNAPSHOT_TOO_LARGE' },
          );
        }
      }
      const result = await storage.save(state, { expectedRevision: storageRevision });
      storageRevision = result && result.revision !== undefined
        ? result.revision
        : (typeof storage.getRevision === 'function' ? storage.getRevision() : storageRevision);
      lastSaveAt = Date.now();
      lastSaveError = null;
      saveRetryDelayMs = 0;
    } catch (e) {
      lastSaveError = e && e.message ? e.message : String(e);
      if (e instanceof StorageConflictError || (e && e.name === 'StorageConflictError')) {
        storageConflict = true;
        logger.error('检测到外部写入，已停止落盘以避免覆盖新数据；请重启或检查是否有另一个实例', {
          error: lastSaveError,
          expected: storageRevision,
          current: e && e.currentRevision,
        });
        break;
      }
      logger.error('状态保存失败', { error: e.message, stack: e.stack });
      if (e && e.code === 'SNAPSHOT_TOO_LARGE') {
        // 快照超限是永久错误，自动重试没有意义。
        break;
      }
      scheduleSaveRetry();
      dirty = true;
      break;
    }
  } while (dirty);
  saving = false;
}

async function flushSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (saveRetryTimer) {
    clearTimeout(saveRetryTimer);
    saveRetryTimer = null;
  }
  if (saving) {
    await new Promise((resolve) => {
      const timer = setInterval(() => {
        if (!saving) {
          clearInterval(timer);
          resolve(undefined);
        }
      }, 10);
      if (timer && typeof timer.unref === 'function') timer.unref();
    });
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

  if (storage) {
    if (distributedLockHeld && typeof storage.releaseLock === 'function') {
      try {
        await Promise.race([
          storage.releaseLock(storageOwnerId),
          new Promise((r) => setTimeout(r, 2000)),
        ]);
      } catch (_) {}
      distributedLockHeld = false;
    }
    try {
      await Promise.race([storage.close(), new Promise((r) => setTimeout(r, 5000))]);
    } catch (_) {}
  }
  lock.release();
  process.exit(exitCode);
}
process.on('SIGINT', () => { void shutdown(0); });
process.on('SIGTERM', () => { void shutdown(0); });

// ---------- 领域校验辅助 ----------
function needProject(id) {
  const p = state.projects[id];
  if (!p) throw new NotFoundError('项目不存在');
  return p;
}
function needPerson(project, id) {
  const p = project.people[id];
  if (!p) throw new NotFoundError('人员不存在');
  return p;
}
function needTeam(project, id) {
  const t = project.teams[id];
  if (!t) throw new NotFoundError('团队不存在');
  return t;
}
function needEntity(project, kind, id) {
  if (kind === 'person') return needPerson(project, id);
  if (kind === 'team') return needTeam(project, id);
  throw new OpError('实体类型非法');
}
function requireFeature(project, key) {
  if (!project.settings[key]) throw new FeatureDisabledError('该功能未开启');
}

// ---- 记分 / 突显内部实现：操作员 op、队员菜单 op、REST 共用同一语义 ----
function applyPersonScore(project, person, delta) {
  const before = person.score;
  person.score = Math.max(-100000, Math.min(100000, before + delta));
  if (person.score !== before) {
    const label = `${person.name} ${delta > 0 ? '+' : ''}${delta}`;
    runtime.pushUndo(project.id, label, [{ personId: person.id, before }]);
    runtime.pushScoreLog(project.id, label, delta);
  }
  return { score: person.score };
}

function applyTeamScore(project, team, delta) {
  requireFeature(project, 'featureTeamScore');
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

function pushSpotlightEvent(project, targetType, targetId, durationMs) {
  requireFeature(project, 'featureSpotlightTrigger');
  if (targetType !== 'person' && targetType !== 'team') {
    throw new OpError('突显目标类型须为 person 或 team');
  }
  if (targetType === 'person') needPerson(project, targetId);
  else needTeam(project, targetId);
  let normalized;
  if (durationMs !== undefined && durationMs !== null) {
    normalized = intRange(durationMs, 0, 10000, '突显时长须为 0–10000 ms（0=跟随主题）');
    if (normalized === 0) normalized = undefined;
  }
  return runtime.pushSpotlight(project.id, { targetType, targetId, durationMs: normalized });
}

function needTheme(themeId) {
  if (typeof themeId !== 'string' || !themeId) throw new NotFoundError('缺少主题 ID');
  const theme = state.themes[themeId];
  if (!theme) throw new NotFoundError('主题不存在');
  return theme;
}

function assertThemeQuota(theme, replacedId) {
  const count = Object.keys(state.themes).length + (replacedId ? 0 : 1);
  if (count > LIMITS.libraryCount) throw new OpError('主题库数量已达上限（200）');
  let bytes = themeBytes(theme);
  for (const [id, item] of Object.entries(state.themes)) {
    if (id !== replacedId) bytes += themeBytes(item);
  }
  if (bytes > LIMITS.libraryBytes) throw new OpError('主题库总大小已达上限（5MB）');
}

function publicState() {
  const { themes: _themes, themeDrafts: _themeDrafts, ...hot } = state;
  return hot;
}

function getTheme(themeId) {
  return needTheme(themeId);
}

function getThemeDraft(projectId) {
  needProject(projectId);
  return state.themeDrafts[projectId] || null;
}

// ---------- op 全集 ----------
function applyOp(op, payload, actor = currentActor()) {
  assertCanOp(actor, op);
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
      delete state.projects[payload.projectId];
      delete state.themeDrafts[payload.projectId];
      runtime.clearProjectRuntime(payload.projectId);
      return {};
    }
    case OPS.themeCreate: {
      const name = needString(payload.name, '主题名', LIMITS.name);
      const theme = normalizeTheme({
        format: THEME_FORMAT,
        version: THEME_VERSION,
        meta: { name, baseStyle: 'custom' },
        settings: {},
      }, { id: genThemeId() });
      assertThemeQuota(theme);
      state.themes[theme.meta.id] = theme;
      return { themeId: theme.meta.id, theme: themeSummary(theme) };
    }
    case OPS.themeUpdate: {
      if (!payload.theme || typeof payload.theme !== 'object') throw new OpError('主题内容非法');
      const existing = needTheme(payload.themeId);
      const theme = normalizeTheme(payload.theme, {
        id: existing.meta.id,
        createdAt: existing.meta.createdAt,
        updatedAt: Date.now(),
        revision: existing.meta.revision + 1,
      });
      assertThemeQuota(theme, existing.meta.id);
      state.themes[theme.meta.id] = theme;
      return { themeId: theme.meta.id, theme: themeSummary(theme) };
    }
    case OPS.themeRename: {
      const existing = needTheme(payload.themeId);
      const theme = JSON.parse(JSON.stringify(existing));
      theme.meta.name = needString(payload.name, '主题名', LIMITS.name);
      theme.meta.updatedAt = Date.now();
      theme.meta.revision += 1;
      assertThemeQuota(theme, existing.meta.id);
      state.themes[theme.meta.id] = theme;
      return { themeId: theme.meta.id, theme: themeSummary(theme) };
    }
    case OPS.themeDuplicate: {
      const source = needTheme(payload.themeId);
      const copy = JSON.parse(JSON.stringify(source));
      copy.meta.id = genThemeId();
      copy.meta.name = (source.meta.name + '（副本）').slice(0, LIMITS.name);
      copy.meta.createdAt = Date.now();
      copy.meta.updatedAt = Date.now();
      copy.meta.revision = 1;
      const theme = normalizeTheme(copy, { id: copy.meta.id });
      assertThemeQuota(theme);
      state.themes[theme.meta.id] = theme;
      return { themeId: theme.meta.id, theme: themeSummary(theme) };
    }
    case OPS.themeDelete: {
      needTheme(payload.themeId);
      delete state.themes[payload.themeId];
      const unbound = [];
      for (const project of Object.values(state.projects)) {
        if (project.themeId === payload.themeId) {
          project.themeId = null;
          project.themeRevision = 0;
          unbound.push(project.id);
        }
      }
      return { unbound };
    }
    case OPS.themeImport: {
      if (!payload.theme || typeof payload.theme !== 'object') throw new OpError('主题内容非法');
      const theme = normalizeTheme(payload.theme, { id: genThemeId() });
      assertThemeQuota(theme);
      state.themes[theme.meta.id] = theme;
      return { themeId: theme.meta.id, theme: themeSummary(theme) };
    }
  }

  // 其余操作都属于某个项目
  const project = needProject(payload.projectId);

  switch (op) {
    case OPS.addPerson: {
      const id = genId('p');
      const teamId = payload.teamId == null || payload.teamId === '' ? null : needTeam(project, payload.teamId).id;
      project.people[id] = {
        id,
        name: needString(payload.name, '姓名', 20),
        avatar: needAvatar(payload.avatar),
        cardImage: needAvatar(payload.cardImage),
        bio: payload.bio === undefined ? '' : needBio(payload.bio),
        score: 0,
        teamId,
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
    case OPS.updatePerson: {
      const p = needPerson(project, payload.personId);
      if (payload.name !== undefined) p.name = needString(payload.name, '姓名', 20);
      if (payload.avatar !== undefined) p.avatar = needAvatar(payload.avatar);
      if (payload.cardImage !== undefined) p.cardImage = needAvatar(payload.cardImage);
      if (payload.bio !== undefined) p.bio = needBio(payload.bio);
      if (payload.teamId !== undefined) {
        if (p.teamId) {
          const oldTeam = project.teams[p.teamId];
          if (oldTeam && oldTeam.captainId === p.id) oldTeam.captainId = null;
        }
        if (payload.teamId == null || payload.teamId === '') p.teamId = null;
        else p.teamId = needTeam(project, payload.teamId).id;
      }
      return { personId: p.id };
    }
    case OPS.setBio: {
      const entity = needEntity(project, payload.kind, payload.id);
      entity.bio = needBio(payload.bio);
      return { bio: entity.bio };
    }
    case OPS.removePerson: {
      const person = needPerson(project, payload.personId);
      if (person.teamId) {
        const team = project.teams[person.teamId];
        if (team && team.captainId === person.id) team.captainId = null;
      }
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
        bio: payload.bio === undefined ? '' : needBio(payload.bio),
        layout: null,
        captainId: null,
        createdAt: Date.now(),
        order: nextOrder(project),
      };
      return { teamId: id };
    }
    case OPS.addTeamsBatch: {
      requireFeature(project, 'featureBatchAdd');
      const rawNames = Array.isArray(payload.names) ? payload.names : [];
      if (!rawNames.length) throw new OpError('团队名列表为空');
      if (rawNames.length > 200) throw new OpError('单次最多添加 200 个团队');
      if (Object.keys(project.teams).length + rawNames.length > 500) {
        throw new OpError('项目团队数已达上限（500）');
      }
      const existingNames = new Set(Object.values(project.teams).map((t) => t.name));
      const seen = new Set();
      const teamIds = [];
      const skipped = [];
      const now = Date.now();
      rawNames.forEach((raw, index) => {
        if (typeof raw !== 'string') throw new OpError(`第 ${index + 1} 个团队名非法`);
        const name = raw.trim();
        if (!name) return;
        if (name.length > 20) throw new OpError(`第 ${index + 1} 个团队名过长（最多 20 字）`);
        if (seen.has(name) || existingNames.has(name)) {
          skipped.push(name);
          return;
        }
        seen.add(name);
        const id = genId('t');
        project.teams[id] = {
          id,
          name,
          avatar: null,
          cardImage: null,
          bio: '',
          layout: null,
          captainId: null,
          createdAt: now + teamIds.length,
          order: nextOrder(project),
        };
        teamIds.push(id);
      });
      if (!teamIds.length) throw new OpError('没有可添加的新团队');
      return { teamIds, added: teamIds.length, skipped };
    }
    case OPS.renameTeam: {
      const t = needTeam(project, payload.teamId);
      t.name = needString(payload.name, '团队名', 20);
      return { name: t.name };
    }
    case OPS.updateTeam: {
      const t = needTeam(project, payload.teamId);
      if (payload.name !== undefined) t.name = needString(payload.name, '团队名', 20);
      if (payload.avatar !== undefined) t.avatar = needAvatar(payload.avatar);
      if (payload.cardImage !== undefined) t.cardImage = needAvatar(payload.cardImage);
      if (payload.bio !== undefined) t.bio = needBio(payload.bio);
      return { teamId: t.id };
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
      if (p.teamId) {
        const oldTeam = project.teams[p.teamId];
        if (oldTeam && oldTeam.captainId === p.id) oldTeam.captainId = null;
      }
      p.teamId = payload.teamId || null;
      return {};
    }
    case OPS.setTeamCaptain: {
      requireFeature(project, 'featureTeamCaptain');
      const team = needTeam(project, payload.teamId);
      if (payload.personId == null || payload.personId === '') {
        team.captainId = null;
        return { teamId: team.id, captainId: null };
      }
      const person = needPerson(project, payload.personId);
      if (person.teamId !== team.id) {
        throw new OpError('只有加入该团队的人员才能设为队长');
      }
      team.captainId = person.id;
      return { teamId: team.id, captainId: person.id };
    }
    case OPS.addScore: {
      const p = needPerson(project, payload.personId);
      const delta = needScore(payload.delta, '分数');
      return applyPersonScore(project, p, delta);
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
      const team = needTeam(project, payload.teamId);
      const delta = needScore(payload.delta, '分数');
      return applyTeamScore(project, team, delta);
    }
    case OPS.triggerSpotlight: {
      const targetType = payload.targetType;
      const targetId = needString(payload.targetId, '突显目标', 64);
      return pushSpotlightEvent(project, targetType, targetId, payload.durationMs);
    }
    case OPS.memberAction: {
      requireFeature(project, 'featureMemberConsole');
      if (project.settings.memberButtonsPaused) {
        throw new OpError('管理员已暂停所有队员按钮');
      }
      const userId = actor && actor.userId;
      if (!userId) throw new OpError('该操作仅限已绑定人员的队员账号');
      if (actor.role === 'member' && actor.memberProjectId !== project.id) {
        throw new OpError('该账号未绑定当前项目');
      }
      const menus = Array.isArray(project.settings.memberMenus)
        ? project.settings.memberMenus
        : [];
      const rawMenu = menus.find((item) => item && item.userId === userId);
      if (!rawMenu) throw new OpError('管理员尚未为该账号配置人员菜单');
      let menu;
      try {
        menu = normalizeMemberMenuConfig(rawMenu);
      } catch (_) {
        throw new OpError('人员菜单配置非法，请让管理员重新保存');
      }
      if (!menu.enabled) throw new OpError('该账号的人员菜单已停用');
      const buttonId = needString(payload.buttonId, '按钮 ID', 40);
      const raw = menu.buttons.find((item) => item && item.id === buttonId);
      if (!raw) throw new OpError('按钮不存在或已被删除');
      let button;
      try {
        button = normalizeMemberMenuButton(raw);
      } catch (_) {
        throw new OpError('按钮配置非法，请让管理员重新保存人员菜单');
      }
      if (!button.enabled) throw new OpError('按钮已停用');
      const activeBuzz = runtime.getBuzz(project.id);
      if (activeBuzz) {
        // 抢答期间只允许「仅抢答时启用 + 不参与抢答」的按钮执行原动作；
        // 参与抢答的按钮必须走 buzzPress，保证第一个按下的人获胜。
        if (button.onlyDuringBuzz !== true || button.buzz !== false) {
          throw new OpError('抢答进行中，请使用抢答按钮');
        }
        if (activeBuzz.phase !== 'open') {
          throw new OpError('抢答尚未开放或已结束');
        }
      } else if (button.onlyDuringBuzz) {
        throw new OpError('该按钮仅在抢答时可用');
      }
      if (button.action === 'score') {
        if (button.targetType === 'person') {
          const person = needPerson(project, button.targetId);
          const result = applyPersonScore(project, person, button.delta);
          return {
            action: button.action,
            targetType: button.targetType,
            targetId: button.targetId,
            delta: button.delta,
            ...result,
          };
        }
        const team = needTeam(project, button.targetId);
        const result = applyTeamScore(project, team, button.delta);
        return {
          action: button.action,
          targetType: button.targetType,
          targetId: button.targetId,
          delta: button.delta,
          ...result,
        };
      }
      const event = pushSpotlightEvent(
        project, button.targetType, button.targetId, button.durationMs,
      );
      return {
        action: button.action,
        targetType: button.targetType,
        targetId: button.targetId,
        seq: event && event.seq,
      };
    }
    case OPS.buzzStart: {
      requireFeature(project, 'featureBuzzer');
      requireFeature(project, 'featureMemberConsole');
      if (runtime.getBuzz(project.id)) throw new OpError('本轮抢答已开始');
      const mode = project.settings.buzzTimerMode === 'window' ? 'window' : 'prepare';
      const durationSec = intRange(
        project.settings.buzzDurationSec, 1, 3600, '抢答倒计时时长须为 1–3600 秒',
      );
      const durationMs = durationSec * 1000;
      // arm:false：由抢答计时器在结束点统一清空，避免“时间到”红字
      runtime.startCountdown(project.id, durationMs, undefined, { arm: false });
      return runtime.startBuzz(project.id, { mode, durationMs });
    }
    case OPS.buzzEnd: {
      // 不要求 featureBuzzer：管理员关闭开关后也要能清理进行中的轮次
      return { ended: runtime.endBuzz(project.id) };
    }
    case OPS.buzzPress: {
      requireFeature(project, 'featureBuzzer');
      if (project.settings.memberButtonsPaused) return { won: false, reason: 'paused' };
      const buzz = runtime.getBuzz(project.id);
      if (!buzz) return { won: false, reason: 'inactive' };
      if (buzz.winner) return { won: false, reason: 'taken', winner: buzz.winner };
      // 计时已到但定时器回调尚未执行时，按结束时间判定，避免边界漏判
      let phase = buzz.phase;
      if (buzz.endsAt && Date.now() >= buzz.endsAt) {
        phase = buzz.mode === 'prepare' ? 'open' : 'locked';
      }
      if (phase !== 'open') return { won: false, reason: phase };
      const userId = actor && actor.userId;
      if (!userId) throw new OpError('该操作仅限已绑定人员的队员账号');
      if (actor.role === 'member' && actor.memberProjectId !== project.id) {
        throw new OpError('该账号未绑定当前项目');
      }
      const person = actor.memberPersonId ? project.people[actor.memberPersonId] : null;
      if (!person) return { won: false, reason: 'binding-missing' };
      const menus = Array.isArray(project.settings.memberMenus)
        ? project.settings.memberMenus
        : [];
      const rawMenu = menus.find((item) => item && item.userId === userId);
      if (!rawMenu) return { won: false, reason: 'no-menu' };
      let menu;
      try {
        menu = normalizeMemberMenuConfig(rawMenu);
      } catch (_) {
        return { won: false, reason: 'no-menu' };
      }
      if (!menu.enabled) return { won: false, reason: 'no-menu' };
      const buttonId = needString(payload.buttonId, '按钮 ID', 40);
      const raw = menu.buttons.find((item) => item && item.id === buttonId);
      if (!raw) return { won: false, reason: 'no-button' };
      let button;
      try {
        button = normalizeMemberMenuButton(raw);
      } catch (_) {
        return { won: false, reason: 'no-button' };
      }
      if (!button.enabled) return { won: false, reason: 'button-disabled' };
      // 「仅抢答时启用 + 不参与抢答」的按钮只执行原动作，不参与首个获胜判定。
      if (button.onlyDuringBuzz === true && button.buzz === false) {
        return { won: false, reason: 'not-buzz-button' };
      }
      if (project.settings.buzzButtonMode === 'marked' && button.buzz !== true) {
        return { won: false, reason: 'not-buzz-button' };
      }

      let targetType = 'person';
      let targetId = person.id;
      let targetName = person.name;
      let team = null;
      if (
        project.settings.buzzTarget === 'team'
        && person.teamId
        && project.teams[person.teamId]
      ) {
        team = project.teams[person.teamId];
        targetType = 'team';
        targetId = team.id;
        targetName = team.name;
      }
      const winner = {
        userId,
        username: actor.username || '',
        personId: person.id,
        personName: person.name,
        teamId: team ? team.id : null,
        teamName: team ? team.name : '',
        targetType,
        targetId,
        targetName,
        buttonId: button.id,
        at: Date.now(),
      };
      runtime.setBuzzWinner(project.id, winner);

      let warning = '';
      const buzzDelta = Number(project.settings.buzzScoreDelta) || 0;
      if (buzzDelta > 0) {
        try {
          if (targetType === 'team') applyTeamScore(project, team, buzzDelta);
          else applyPersonScore(project, person, buzzDelta);
        } catch (error) {
          warning = error.message;
        }
      }
      if (project.settings.buzzRunButtonAction) {
        if (button.action === 'score') {
          try {
            if (button.targetType === 'person') {
              const target = needPerson(project, button.targetId);
              applyPersonScore(project, target, button.delta);
            } else {
              const target = needTeam(project, button.targetId);
              applyTeamScore(project, target, button.delta);
            }
          } catch (error) {
            warning = warning || error.message;
          }
        } else {
          warning = warning || '按钮为突显动作，已由锁定突显覆盖';
        }
      }
      if (buzz.mode === 'window' && project.settings.buzzStopTimerOnWin !== false) {
        runtime.lockBuzz(project.id);
      }
      return { won: true, winner, warning: warning || undefined };
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
    case OPS.themeApply: {
      const theme = needTheme(payload.themeId);
      Object.assign(project.settings, theme.settings);
      project.settings.displayStyle = theme.meta.baseStyle;
      project.themeId = theme.meta.id;
      project.themeRevision = theme.meta.revision;
      return {
        themeId: theme.meta.id,
        revision: theme.meta.revision,
        applied: Object.keys(theme.settings).length,
        baseStyle: theme.meta.baseStyle,
      };
    }
    case OPS.draftSave: {
      if (!payload.theme || typeof payload.theme !== 'object') throw new OpError('主题草稿非法');
      const existing = state.themeDrafts[project.id];
      const theme = normalizeDraft(payload.theme, project.id, existing);
      // 草稿也参与乐观并发：每次保存递增 revision（旧 WS 客户端不受影响）
      theme.meta.revision = ((existing && existing.meta && existing.meta.revision) || 0) + 1;
      state.themeDrafts[project.id] = theme;
      return { theme: themeSummary(theme) };
    }
    case OPS.draftDelete: {
      delete state.themeDrafts[project.id];
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
      // 关闭抢答总开关时立即结束当前轮次并清掉计时器
      if (validated.featureBuzzer === false) runtime.endBuzz(project.id);
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
  for (const menu of project.settings.memberMenus || []) {
    for (const button of menu.buttons || []) {
      if (button && typeof button.image === 'string' && button.image) {
        button.image = mapper(button.image);
      }
    }
  }
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
      captainId: null,
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
    themeId: null,
    themeRevision: 0,
  };
  normalizeOrders(project);
  return project;
}

// ---------- 整库导出 / 导入 ----------
const LIBRARY_SECTIONS = Object.freeze(['projects', 'themes', 'themeDrafts']);

/** 从当前状态取选定范围的整库快照（不做深拷贝，调用方负责序列化）。 */
function exportLibraryState(scope = LIBRARY_SECTIONS) {
  const out = { version: state.version };
  if (scope.includes('projects')) out.projects = state.projects;
  if (scope.includes('themes')) out.themes = state.themes;
  if (scope.includes('themeDrafts')) out.themeDrafts = state.themeDrafts;
  return out;
}

/** 校验并清洗整库导入数据；只返回请求的范围，任何一节非法都不会修改现有状态。 */
function sanitizeLibraryImport(raw, scope = LIBRARY_SECTIONS) {
  const source = raw && raw.state && typeof raw.state === 'object' ? raw.state : raw;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new OpError('导入文件格式非法');
  }
  const out = {};
  if (scope.includes('projects')) {
    const rawProjects = source.projects;
    if (!rawProjects || typeof rawProjects !== 'object' || Array.isArray(rawProjects)) {
      throw new OpError('导入文件不包含项目数据');
    }
    const entries = Object.entries(rawProjects);
    if (!entries.length) throw new OpError('导入文件不包含项目数据');
    if (entries.length > 50) throw new OpError('导入项目数量超出上限（50）');
    const projects = {};
    for (const [id, item] of entries) {
      if (!item || typeof item !== 'object') continue;
      const projectId = typeof item.id === 'string' && item.id ? item.id : id;
      try {
        const project = normalizeProject({ ...item, id: projectId });
        projects[project.id] = project;
      } catch (error) {
        logger.warn('忽略非法导入项目', { id, error: error.message });
      }
    }
    if (!Object.keys(projects).length) throw new OpError('导入文件不包含可用项目');
    out.projects = projects;
  }
  if (scope.includes('themes')) {
    if (!source.themes || typeof source.themes !== 'object') {
      throw new OpError('导入文件不包含主题数据');
    }
    const themes = normalizeThemeMap(source.themes);
    if (Object.keys(themes).length > LIMITS.libraryCount) {
      throw new OpError('导入主题数量超出上限（' + LIMITS.libraryCount + '）');
    }
    out.themes = themes;
  }
  if (scope.includes('themeDrafts')) {
    const rawDrafts = source.themeDrafts && typeof source.themeDrafts === 'object'
      ? source.themeDrafts
      : {};
    const projectIds = new Set(
      out.projects ? Object.keys(out.projects) : Object.keys(state.projects),
    );
    const drafts = {};
    for (const [projectId, draft] of Object.entries(rawDrafts)) {
      if (!projectIds.has(projectId) || !draft || typeof draft !== 'object') continue;
      try {
        drafts[projectId] = normalizeDraft(draft, projectId);
      } catch (error) {
        logger.warn('忽略非法主题草稿', { projectId, error: error.message });
      }
      if (Object.keys(drafts).length >= 100) break;
    }
    out.themeDrafts = drafts;
  }
  return out;
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
  NotFoundError,
  FeatureDisabledError,
  DATA_DIR,
  AVATAR_DIR,
  SOUND_DIR,
  getStorageKind,
  getStorageStatus,
  getStorageHealth,
  getActiveStorageConfig() { return activeStorageConfig; },
  get storageKind() { return storageKind; },
  exportProjectData,
  sanitizeImportedProject,
  LIBRARY_SECTIONS,
  exportLibraryState,
  sanitizeLibraryImport,
  walkAssetRefs,
  publicState,
  getTheme,
  getThemeDraft,
};
