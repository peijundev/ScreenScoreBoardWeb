// 显示端核心：外观变量、排序、名次、排行榜、特效（移植自 public/display.js）
import type { Layout, Person, Project, Settings, Team } from '../../shared/types';
import { playPresetSound, playSoundFile } from '../../shared/sound';

export const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
export const round2 = (v: number): number => Math.round(v * 100) / 100;

export function scoreClass(n: number): string {
  return n > 0 ? 'score-pos' : n < 0 ? 'score-neg' : 'score-zero';
}

export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function formatDuration(sec: number): string {
  const total = Math.max(0, Math.ceil(sec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? h + ':' + pad2(m) + ':' + pad2(s) : pad2(m) + ':' + pad2(s);
}

export function orderOf(entity: { order?: number }): number {
  return Number.isFinite(entity.order) ? (entity.order as number) : Number.POSITIVE_INFINITY;
}

export const FONT_STACKS: Record<string, string> = {
  system: '"Noto Sans", "Noto Sans CJK SC", "Source Han Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif',
  serif: '"Noto Serif CJK SC", "Source Han Serif SC", "Songti SC", "SimSun", serif',
  kai: '"Kaiti SC", "KaiTi", "STKaiti", "Noto Serif CJK SC", serif',
};

const SHADOWS: Record<string, string> = {
  none: 'none',
  soft: '0 4px 14px rgba(0, 0, 0, 0.16)',
  medium: '0 10px 28px rgba(0, 0, 0, 0.22)',
  strong: '0 18px 48px rgba(0, 0, 0, 0.3)',
};

export function hexToRgba(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  return 'rgba(' + parseInt(m[1], 16) + ',' + parseInt(m[2], 16) + ',' + parseInt(m[3], 16) + ',' + alpha + ')';
}

function setVar(style: CSSStyleDeclaration, name: string, value: string | null | undefined): void {
  if (value === '' || value == null) style.removeProperty(name);
  else style.setProperty(name, value);
}

export function fontStackOf(s: Settings, fontKey: string, customKey: string): string {
  const choice = String(s[fontKey] || 'auto');
  if (choice === 'custom' && s[customKey]) {
    return '"' + String(s[customKey]).replace(/["\\]/g, '') + '", ' + FONT_STACKS.system;
  }
  if (choice !== 'auto') return FONT_STACKS[choice] || '';
  return '';
}

export function prefersReducedMotion(): boolean {
  return Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

/** 应用全部外观设置（body data-* + CSS 变量），移植自 applyAppearance */
export function applyAppearance(s: Settings): void {
  const root = document.documentElement;
  const body = document.body;

  // featureMobileAdmin / adminTouchTargetSize 只影响管理端布局与触控目标，
  // 显示端没有对应语义，明确跳过（设置仍走完整校验、契约与持久化链路）。
  void s.featureMobileAdmin;
  void s.adminTouchTargetSize;

  // 字体
  const serifStyles = ['guofeng', 'ink', 'trueage'];
  if (s.fontFamily === 'custom' && s.fontFamilyCustom) {
    const name = String(s.fontFamilyCustom).replace(/["\\]/g, '');
    body.style.fontFamily = '"' + name + '", ' + FONT_STACKS.system;
  } else {
    const fontKey = s.fontFamily === 'system' && serifStyles.includes(s.displayStyle) ? 'serif' : s.fontFamily;
    body.style.fontFamily = FONT_STACKS[fontKey] || FONT_STACKS.system;
  }

  const titleFont = fontStackOf(s, 'titleFont', 'titleFontCustom');
  setVar(root.style, '--title-font', titleFont);
  body.dataset.titleFont = titleFont ? 'custom' : 'auto';

  setVar(root.style, '--clock-font', fontStackOf(s, 'clockFont', 'clockFontCustom'));
  setVar(root.style, '--clock-size', s.clockFontSize ? s.clockFontSize + 'px' : '');
  setVar(root.style, '--cd-font', fontStackOf(s, 'countdownFont', 'countdownFontCustom'));
  setVar(root.style, '--lb-font', fontStackOf(s, 'leaderboardFont', 'leaderboardFontCustom'));
  setVar(root.style, '--marquee-font-family', fontStackOf(s, 'marqueeFont', 'marqueeFontCustom'));
  setVar(root.style, '--welcome-font', fontStackOf(s, 'welcomeFont', 'welcomeFontCustom'));
  setVar(root.style, '--welcome-size', s.welcomeFontSize ? s.welcomeFontSize + 'px' : '');
  setVar(root.style, '--score-font', fontStackOf(s, 'scoreFont', 'scoreFontCustom'));
  setVar(root.style, '--bio-font', fontStackOf(s, 'bioFont', 'bioFontCustom'));
  setVar(root.style, '--bio-size', s.bioSize ? s.bioSize + 'px' : '');
  setVar(root.style, '--bio-color', s.bioColor || '');
  setVar(root.style, '--bio-opacity', String(s.bioOpacity ?? 1));
  body.dataset.bioItalic = s.bioItalic ? 'on' : 'off';

  setVar(root.style, '--font-scale', String(s.fontScale));
  setVar(root.style, '--title-size', s.titleSize ? s.titleSize + 'px' : '');
  setVar(root.style, '--board-max', s.boardMaxWidth + 'px');
  setVar(root.style, '--gap-override', s.cardGap ? s.cardGap + 'px' : '');
  setVar(root.style, '--card-pad-override', s.cardPad ? s.cardPad + 'px' : '');
  setVar(root.style, '--card-border-width', s.cardBorderWidth + 'px');
  setVar(root.style, '--team-bar-w', s.teamAccentWidth + 'px');
  setVar(root.style, '--team-accent-color', s.teamAccentColor || '');
  body.dataset.teamAccent = s.showTeamAccent === false ? 'off' : 'on';
  setVar(root.style, '--avatar-border-w', s.avatarBorderWidth + 'px');
  setVar(root.style, '--avatar-radius', s.avatarShape === 'square' ? '0px' : '50%');
  setVar(root.style, '--rank-size', s.rankSize + 'px');
  setVar(root.style, '--bar-height', s.scoreBarHeight + 'px');
  setVar(root.style, '--scrim-opacity', s.bgScrimEnabled === false ? '0' : String(s.scrimOpacity));
  const spotDimOn = s.spotlightScrimEnabled !== false;
  const spotDimRaw = Number(s.spotlightScrimOpacity);
  const spotDim = spotDimOn ? clamp(Number.isFinite(spotDimRaw) ? spotDimRaw : 0.45, 0, 1) : 0;
  // 主题变量定义在 body 上，必须同样写在 body 才能覆盖，不能只挂在 html 根节点
  setVar(body.style, '--spot-scrim-alpha', String(spotDim));
  setVar(root.style, '--score-pos', s.positiveColor);
  setVar(root.style, '--score-neg', s.negativeColor);
  setVar(root.style, '--title-color', s.titleColor || '');
  setVar(root.style, '--rank-color', s.rankColor || '');
  body.dataset.titleColor = s.titleColor ? 'custom' : 'auto';
  body.dataset.rankColor = s.rankColor ? 'custom' : 'auto';

  setVar(body.style, '--text', s.textColor || '');
  setVar(body.style, '--card-border', s.cardBorderColor || '');

  if (s.cardShadow === 'auto') {
    body.dataset.cardShadow = 'auto';
    setVar(root.style, '--card-shadow', '');
  } else {
    body.dataset.cardShadow = 'custom';
    setVar(root.style, '--card-shadow', SHADOWS[s.cardShadow] || 'none');
  }

  body.dataset.titleAlign = s.titleAlign;
  body.dataset.titleDecor = s.titleDecor || 'auto';
  body.dataset.styleFree = s.styleFreeConfig ? 'on' : 'off';
  body.dataset.titleFree = s.titleFree ? 'on' : 'off';
  setVar(root.style, '--title-x', s.titleX + '%');
  setVar(root.style, '--title-y', s.titleY + '%');
  body.dataset.titleRule = s.showTitleRule ? 'on' : 'off';
  body.dataset.showRank = s.showRank ? '1' : '0';
  body.dataset.showBar = s.showScoreBar ? '1' : '0';

  body.dataset.theme = s.theme;
  body.dataset.density = s.density;
  body.dataset.displayStyle = s.displayStyle || 'guofeng';
  root.style.setProperty('--cols', String(s.columns));
  root.style.setProperty('--accent', s.accent);
  root.style.setProperty('--radius', s.cardRadius + 'px');
  root.style.setProperty('--member-scale', String(s.memberScale));
  body.dataset.memberLayout = s.teamMemberLayout || 'auto';

  if (s.avatarSizeMode === 'manual') {
    root.style.setProperty('--person-avatar', s.avatarSize + 'px');
    root.style.setProperty('--team-avatar', Math.round(s.avatarSize * 0.7) + 'px');
    root.style.setProperty('--member-avatar-base', Math.round(s.avatarSize * 0.56) + 'px');
  } else {
    root.style.removeProperty('--person-avatar');
    root.style.removeProperty('--team-avatar');
    root.style.removeProperty('--member-avatar-base');
  }

  const themeCard = s.theme === 'light' ? '#ffffff' : '#1a1f26';
  const baseCard = s.cardBg || themeCard;
  const cardMode = s.cardBgMode || 'auto';
  body.dataset.cardSurface = cardMode;
  if (cardMode === 'translucent' || cardMode === 'acrylic') {
    body.style.setProperty('--card', hexToRgba(baseCard, s.cardOpacity));
    body.style.setProperty('--card-blur', s.cardAcrylicBlur + 'px');
  } else if (cardMode === 'custom') {
    body.style.setProperty('--card', baseCard);
    body.style.removeProperty('--card-blur');
  } else {
    if (s.cardBg) body.style.setProperty('--card', s.cardBg);
    else body.style.removeProperty('--card');
    body.style.removeProperty('--card-blur');
  }

  body.dataset.cardStyle = s.cardStyle;
  const glassBase = s.cardBg || themeCard;
  body.style.setProperty('--glass-bg', hexToRgba(glassBase, s.glassOpacity));
  body.style.setProperty('--glass-blur', s.glassBlur + 'px');

  body.dataset.scoreEffect = s.scoreEffect;
  root.style.setProperty('--fx-duration', s.scoreEffectDuration + 'ms');
  if (s.scoreEffectColor) root.style.setProperty('--fx-color', s.scoreEffectColor);
  else root.style.removeProperty('--fx-color');

  body.style.backgroundColor = s.bgColor;
  const useImage = s.bgType === 'image' && s.bgImage;
  body.classList.toggle('has-bg-image', Boolean(useImage));
  body.style.backgroundImage = '';
  setVar(body.style, '--bg-image', useImage ? 'url("/' + s.bgImage + '")' : '');
  const bgBlur =
    useImage && s.bgImageBlur ? Math.max(0, Math.min(40, Number(s.bgImageBlurAmount) || 0)) : 0;
  setVar(body.style, '--bg-blur', bgBlur > 0 ? bgBlur + 'px' : '');
  setVar(body.style, '--bg-blur-scale', bgBlur > 0 ? String(1 + bgBlur * 0.0025) : '');

  document.title = s.title;
}

// ---------- 排序 ----------
export interface Item {
  kind: 'person' | 'team';
  person?: Person;
  team?: Team;
  members: Person[];
  sortKey: number;
}

function sortMembers(members: Person[], s: Settings): Person[] {
  const list = members.slice();
  if (s.sortBy === 'manual') {
    list.sort((a, b) => orderOf(a) - orderOf(b));
  } else if (s.sortBy === 'score') {
    list.sort((a, b) => (s.sortOrder === 'asc' ? a.score - b.score : b.score - a.score));
  } else {
    list.sort((a, b) => (s.sortOrder === 'asc' ? a.createdAt - b.createdAt : b.createdAt - a.createdAt));
  }
  return list;
}

export function buildItems(project: Project, s: Settings): Item[] {
  const people = Object.values(project.people);
  const teams = Object.values(project.teams);
  const items: Item[] = [];

  for (const p of people) {
    if (!p.teamId || !project.teams[p.teamId]) {
      items.push({ kind: 'person', person: p, members: [], sortKey: s.sortBy === 'score' ? p.score : p.createdAt });
    }
  }
  for (const t of teams) {
    const members = sortMembers(people.filter((p) => p.teamId === t.id), s);
    const total = members.reduce((sum, m) => sum + m.score, 0);
    items.push({ kind: 'team', team: t, members, sortKey: s.sortBy === 'score' ? total : t.createdAt });
  }

  if (s.sortBy === 'manual') {
    items.sort((a, b) => {
      const ea = a.kind === 'person' ? a.person : a.team;
      const eb = b.kind === 'person' ? b.person : b.team;
      return orderOf(ea as { order?: number }) - orderOf(eb as { order?: number });
    });
    return items;
  }
  if (s.sortBy === 'score') {
    const dir = s.sortOrder === 'asc' ? 1 : -1;
    items.sort((a, b) => dir * (a.sortKey - b.sortKey));
    return items;
  }
  items.sort((a, b) => (s.sortOrder === 'asc' ? a.sortKey - b.sortKey : b.sortKey - a.sortKey));
  return items;
}

// 未保存位置时的货架式初始摆放
export function shelfLayouts(items: Item[]): Layout[] {
  const out: Layout[] = [];
  let x = 2;
  let y = 2;
  let rowH = 0;
  for (const it of items) {
    const w = it.kind === 'team' ? 34 : 22;
    const h = it.kind === 'team' ? 26 : 14;
    if (x + w > 98) {
      x = 2;
      y += rowH + 2;
      rowH = 0;
    }
    if (y + h > 98) {
      x = 2;
      y = 2;
      rowH = 0;
    }
    out.push({ x, y, w, h });
    x += w + 2;
    rowH = Math.max(rowH, h);
  }
  return out;
}

export function memberFallbackLayouts(n: number): Layout[] {
  const cols = Math.min(3, Math.max(1, Math.ceil(Math.sqrt(n))));
  const rows = Math.ceil(n / cols) || 1;
  const gap = 3;
  const w = round2((100 - gap * (cols - 1)) / cols);
  const h = round2((100 - gap * (rows - 1)) / rows);
  return Array.from({ length: n }, (_, i) => ({
    x: round2((i % cols) * (w + gap)),
    y: round2(Math.floor(i / cols) * (h + gap)),
    w,
    h,
  }));
}

// ---------- 名次 ----------
export function assignRanks(values: number[], mode: string): number[] {
  let dense = 0;
  let prev: number | null = null;
  let competition = 0;
  return values.map((score, i) => {
    const isNew = i === 0 || score !== prev;
    if (isNew) {
      dense += 1;
      competition = i + 1;
      prev = score;
    }
    if (mode === 'dense') return dense;
    if (mode === 'competition') return competition;
    return i + 1;
  });
}

export interface LeaderEntry {
  kind: 'person' | 'team';
  id: string;
  name: string;
  avatar: string | null;
  score: number;
  teamName: string;
  createdAt: number;
  order?: number;
  rank?: number;
}

export function leaderboardEntries(project: Project, s: Settings): LeaderEntry[] {
  const people = Object.values(project.people);
  const teams = Object.values(project.teams);
  const scope = s.leaderboardScope || 'auto';
  const entries: LeaderEntry[] = [];
  const teamScore = (team: Team): number =>
    people.filter((p) => p.teamId === team.id).reduce((sum, p) => sum + p.score, 0);

  if (scope === 'people') {
    for (const p of people) {
      entries.push({
        kind: 'person', id: p.id, name: p.name, avatar: p.avatar, score: p.score,
        teamName: p.teamId && project.teams[p.teamId] ? project.teams[p.teamId].name : '',
        createdAt: p.createdAt, order: p.order,
      });
    }
  } else if (scope === 'teams') {
    for (const t of teams) {
      entries.push({
        kind: 'team', id: t.id, name: t.name, avatar: t.avatar, score: teamScore(t),
        teamName: '', createdAt: t.createdAt, order: t.order,
      });
    }
  } else {
    for (const p of people) {
      if (p.teamId && project.teams[p.teamId]) continue;
      entries.push({
        kind: 'person', id: p.id, name: p.name, avatar: p.avatar, score: p.score,
        teamName: '', createdAt: p.createdAt, order: p.order,
      });
    }
    for (const t of teams) {
      entries.push({
        kind: 'team', id: t.id, name: t.name, avatar: t.avatar, score: teamScore(t),
        teamName: '', createdAt: t.createdAt, order: t.order,
      });
    }
  }

  const tieBreak =
    s.sortBy === 'manual'
      ? (a: LeaderEntry, b: LeaderEntry) => orderOf(a) - orderOf(b)
      : (a: LeaderEntry, b: LeaderEntry) => a.createdAt - b.createdAt;
  entries.sort((a, b) => b.score - a.score || tieBreak(a, b));
  const limit = Number(s.leaderboardLimit) || 0;
  const limited = limit > 0 ? entries.slice(0, limit) : entries;
  const tieMode = s.featureRankTies ? s.rankTieMode : 'none';
  const ranks = assignRanks(limited.map((e) => e.score), tieMode);
  limited.forEach((e, i) => {
    e.rank = ranks[i];
  });
  return limited;
}

// ---------- 分数特效 ----------
export interface FxInfo {
  cls: string;
  badge: { text: string; color: string } | null;
}

export function fxInfo(s: Settings, delta: number | null | undefined): FxInfo {
  if (s.displayStyle === 'trueage') return { cls: '', badge: null };
  if (delta == null || delta === 0 || s.scoreEffect === 'none') return { cls: '', badge: null };
  if (s.scoreEffectOnlyPositive && delta < 0) return { cls: '', badge: null };
  const color = s.scoreEffectColor || (delta > 0 ? '#6fbf7b' : '#e06c75');
  return { cls: ' fx', badge: { text: (delta > 0 ? '+' : '') + delta, color } };
}

interface LiveSpotlight {
  overlay: HTMLElement;
  cleanup: () => void;
}

const liveSpotlights = new Set<LiveSpotlight>();

// 原卡可见性用引用计数管理：打断瞬间新旧特效可能同时隐藏同一张卡，
// 旧的清理回调不能把仍被新特效占用的原卡提前显示出来。
const hiddenOriginals = new Map<HTMLElement, number>();

export function hideOriginalCard(el: HTMLElement): void {
  hiddenOriginals.set(el, (hiddenOriginals.get(el) || 0) + 1);
  el.style.visibility = 'hidden';
}

export function showOriginalCard(el: HTMLElement): void {
  const left = (hiddenOriginals.get(el) || 0) - 1;
  if (left > 0) {
    hiddenOriginals.set(el, left);
    return;
  }
  hiddenOriginals.delete(el);
  if (el.isConnected) el.style.visibility = '';
}

function registerSpotlight(overlay: HTMLElement, cleanup: () => void): () => void {
  const handle: LiveSpotlight = { overlay, cleanup };
  liveSpotlights.add(handle);
  return () => {
    liveSpotlights.delete(handle);
  };
}

/**
 * 打断模式：清除正在播放的居中突显特效。
 * fadeMs <= 0 立即移除；否则整体淡出后再移除并恢复原卡。
 */
export function interruptSpotlights(fadeMs = 0): void {
  const dur = clamp(Number(fadeMs) || 0, 0, 2000);
  for (const handle of Array.from(liveSpotlights)) {
    liveSpotlights.delete(handle);
    if (dur <= 0 || !handle.overlay.isConnected) {
      handle.cleanup();
      continue;
    }
    const anim = handle.overlay.animate(
      [{ opacity: 1 }, { opacity: 0 }],
      { duration: dur, easing: 'ease', fill: 'forwards' },
    );
    anim.onfinish = () => handle.cleanup();
  }
}

export function rollNumber(el: HTMLElement | null, from: number, to: number): void {
  if (!el || from === to) return;
  el.textContent = String(from);
  const dur = 500;
  const start = performance.now();
  const step = (now: number): void => {
    const t = Math.min(1, (now - start) / dur);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = String(Math.round(from + (to - from) * eased));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

export function playScoreSound(delta: number, s: Settings): void {
  if (!s.soundEnabled) return;
  if (s.scoreEffectOnlyPositive && delta < 0) return;
  if (s.customSound) {
    playSoundFile(String(s.customSound), Number(s.soundVolume));
    return;
  }
  playPresetSound(String(s.soundPreset || 'default'), delta, Number(s.soundVolume));
}

export function spawnConfetti(el: HTMLElement, colors: string[], duration: number): void {
  const layer = document.createElement('div');
  layer.className = 'confetti-layer';
  const n = 16;
  for (let i = 0; i < n; i++) {
    const p = document.createElement('i');
    const angle = (Math.PI * 2 * i) / n + Math.random() * 0.4;
    const dist = 40 + Math.random() * 70;
    p.style.setProperty('--dx', Math.round(Math.cos(angle) * dist) + 'px');
    p.style.setProperty('--dy', Math.round(Math.sin(angle) * dist - 12) + 'px');
    p.style.setProperty('--rot', Math.round(Math.random() * 720 - 360) + 'deg');
    p.style.background = colors[i % colors.length];
    p.style.animationDelay = (Math.random() * 0.08).toFixed(2) + 's';
    layer.appendChild(p);
  }
  el.appendChild(layer);
  setTimeout(() => layer.remove(), duration + 500);
}

export function injectSpotDelta(clone: HTMLElement, delta: number | null | undefined, s: Settings): void {
  if (delta == null || delta === 0) return;
  if (s.scoreEffectOnlyPositive && delta < 0) return;
  const scoreEl = clone.querySelector('.person-score, .member-score, .team-total');
  if (!scoreEl) return;
  const color = s.scoreEffectColor || (delta > 0 ? '#6fbf7b' : '#e06c75');
  const badge = document.createElement('span');
  badge.className = 'spot-delta';
  badge.textContent = (delta > 0 ? '+' : '') + delta;
  badge.style.color = color;
  scoreEl.appendChild(badge);
}

export function cloneCard(el: HTMLElement, s?: Settings): HTMLElement {
  const clone = el.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('.resize-handle, .fx-delta, .confetti-layer').forEach((n) => n.remove());
  // visibility 必须清掉：特效播放期间原卡是内联 hidden，cloneNode 会把该内联样式一起复制，
  // 导致同一张卡连续触发特效时新克隆卡不可见。
  ['position', 'left', 'top', 'right', 'bottom', 'width', 'height', 'transform', 'animation', 'zoom', 'visibility'].forEach(
    (p) => clone.style.removeProperty(p),
  );
  clone.classList.remove('dragging');
  clone.removeAttribute('data-person');
  clone.removeAttribute('data-kind');
  clone.removeAttribute('data-id');
  if (s) applySpotlightCardStyle(clone, s);
  return clone;
}

/** 把突显专属的字体、字号、头像大小/位置覆盖到克隆卡片上。 */
function applySpotlightCardStyle(clone: HTMLElement, s: Settings): void {
  clone.classList.add('spotlight-card');

  const family = String(s.spotlightFontFamily || 'auto');
  if (family !== 'auto') {
    const stack = family === 'custom' && s.spotlightFontFamilyCustom
      ? '"' + String(s.spotlightFontFamilyCustom).replace(/["\\]/g, '') + '", ' + FONT_STACKS.system
      : (FONT_STACKS[family] || FONT_STACKS.system);
    clone.style.fontFamily = stack;
    clone.style.setProperty('--score-font', stack);
  }

  const scale = clamp(Number(s.spotlightFontScale) || 1, 0.7, 2.5);
  if (scale !== 1) {
    const base = clamp(Number(s.fontScale) || 1, 0.7, 1.5);
    clone.style.setProperty('--font-scale', String(Math.round(base * scale * 100) / 100));
  }

  if (s.spotlightAvatarEnabled === false) {
    clone.classList.add('spotlight-hide-avatar');
    return;
  }

  if (s.spotlightAvatarSizeMode === 'manual') {
    const size = clamp(Number(s.spotlightAvatarSize) || 96, 24, 240);
    clone.style.setProperty('--person-avatar', size + 'px');
    clone.style.setProperty('--team-avatar', Math.round(size * 0.7) + 'px');
    clone.style.setProperty('--avatar', size + 'px');
  }

  const position = String(s.spotlightAvatarPosition || 'auto');
  if (['left', 'right', 'top', 'bottom'].includes(position)) {
    const targets: HTMLElement[] = [clone, ...Array.from(clone.querySelectorAll<HTMLElement>('.team-head'))];
    for (const target of targets) {
      for (const side of ['left', 'right', 'top', 'bottom']) target.classList.remove('av-' + side);
      target.classList.add('av-' + position);
    }
  }
}

export function spotlightSize(el: HTMLElement, s: Settings): { width: number; height: number; rect: DOMRect } {
  const rect = el.getBoundingClientRect();
  const width = clamp(Number(s.spotlightWidth) || 520, 200, 1600);
  let height = Number(s.spotlightHeight) || 0;
  if (!height) height = rect.height * (width / rect.width);
  height = Math.min(Math.max(height, 120), window.innerHeight * 0.8);
  return { width, height, rect };
}

function buildSpotlightItems(
  els: HTMLElement[],
  s: Settings,
  delta: number | undefined,
  boxClass: string,
): Array<{ el: HTMLElement; box: HTMLElement; rect: DOMRect; width: number; height: number; target?: { left: number; top: number; width: number; height: number } }> {
  const items = [];
  for (const el of els) {
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    const clone = cloneCard(el, s);
    injectSpotDelta(clone, delta, s);
    const { width, height } = spotlightSize(el, s);
    const box = document.createElement('div');
    box.className = boxClass;
    box.style.left = rect.left + 'px';
    box.style.top = rect.top + 'px';
    box.style.width = rect.width + 'px';
    box.style.height = rect.height + 'px';
    box.appendChild(clone);
    items.push({ el, box, rect, width, height });
  }
  return items;
}

function centerTargets(
  items: Array<{ width: number; height: number; target?: { left: number; top: number; width: number; height: number } }>,
): void {
  const gap = 20;
  const totalW = items.reduce((sum, it) => sum + it.width, 0) + gap * (items.length - 1);
  let x = (window.innerWidth - totalW) / 2;
  for (const it of items) {
    it.target = { left: x, top: (window.innerHeight - it.height) / 2, width: it.width, height: it.height };
    x += it.width + gap;
  }
}

/** 手动/API 突显可覆盖总时长；0/非法值回退到主题自身的时长。 */
function spotlightTotal(override: number | undefined, fallback: number): number {
  const n = Number(override);
  if (Number.isFinite(n) && n > 0) return clamp(n, 200, 10000);
  return fallback;
}

function spawnSpotlightReturn(
  els: HTMLElement[],
  s: Settings,
  delta?: number,
  extraCleanup?: () => void,
  durationOverride?: number,
): void {
  const total = spotlightTotal(
    durationOverride,
    clamp(Number(s.spotlightReturnDuration) || 1600, 600, 6000),
  );
  const overlay = document.createElement('div');
  overlay.className = 'spotlight-return-overlay';
  overlay.style.setProperty('--spot-duration', total + 'ms');
  const scrim = document.createElement('div');
  scrim.className = 'spotlight-return-scrim';
  // 先置 0：append 到 WAAPI 生效之间、以及动画结束 fill 回默认值时都不能闪白罩
  scrim.style.opacity = '0';
  overlay.appendChild(scrim);

  const items = buildSpotlightItems(els, s, delta, 'spotlight-return-box');
  if (!items.length) return;
  centerTargets(items);
  items.forEach((it) => overlay.appendChild(it.box));

  document.body.appendChild(overlay);
  items.forEach((it) => {
    hideOriginalCard(it.el);
  });
  scrim.animate(
    [{ opacity: 0 }, { opacity: 1, offset: 0.25 }, { opacity: 1, offset: 0.7 }, { opacity: 0 }],
    { duration: total, easing: 'ease' },
  );

  for (const it of items) {
    const { rect, target, box } = it;
    if (!target) continue;
    box.animate(
      [
        { left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px', height: rect.height + 'px', offset: 0 },
        { left: target.left + 'px', top: target.top + 'px', width: target.width + 'px', height: target.height + 'px', offset: 0.34 },
        { left: target.left + 'px', top: target.top + 'px', width: target.width + 'px', height: target.height + 'px', offset: 0.72 },
        { left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px', height: rect.height + 'px', offset: 1 },
      ],
      { duration: total, easing: 'cubic-bezier(0.25, 0.8, 0.25, 1)' },
    );
  }

  const cleanup = () => {
    items.forEach((it) => showOriginalCard(it.el));
    overlay.remove();
    if (extraCleanup) extraCleanup();
  };
  const unregister = registerSpotlight(overlay, cleanup);
  setTimeout(() => {
    cleanup();
    unregister();
  }, total + 150);
}

function spawnSpotlightGenie(
  els: HTMLElement[],
  s: Settings,
  delta?: number,
  durationOverride?: number,
): void {
  const total = spotlightTotal(
    durationOverride,
    clamp(Number(s.spotlightReturnDuration) || 1800, 600, 6000),
  );
  const overlay = document.createElement('div');
  overlay.className = 'spotlight-return-overlay';
  const scrim = document.createElement('div');
  scrim.className = 'spotlight-return-scrim';
  // 先置 0：append 到 WAAPI 生效之间、以及动画结束 fill 回默认值时都不能闪白罩
  scrim.style.opacity = '0';
  overlay.appendChild(scrim);

  const items = buildSpotlightItems(els, s, delta, 'spotlight-return-box genie-box');
  if (!items.length) return;
  centerTargets(items);
  items.forEach((it) => overlay.appendChild(it.box));

  document.body.appendChild(overlay);
  items.forEach((it) => {
    hideOriginalCard(it.el);
  });
  scrim.animate(
    [{ opacity: 0 }, { opacity: 1, offset: 0.2 }, { opacity: 1, offset: 0.72 }, { opacity: 0 }],
    { duration: total, easing: 'ease' },
  );

  for (const it of items) {
    const { rect, target, box } = it;
    if (!target) continue;
    const midX = (rect.left + target.left) / 2;
    const midY = (rect.top + target.top) / 2;
    const midW = (rect.width + target.width) / 2;
    const midH = (rect.height + target.height) / 2;
    box.animate(
      [
        { left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px', height: rect.height + 'px', transform: 'scale(1,1) skewX(0deg)', borderRadius: '0px', offset: 0 },
        { left: midX + 'px', top: midY + 'px', width: midW + 'px', height: midH + 'px', transform: 'scale(0.55,1.28) skewX(-10deg)', borderRadius: '26px', offset: 0.26 },
        { left: target.left + 'px', top: target.top + 'px', width: target.width + 'px', height: target.height + 'px', transform: 'scale(1.02,1.02) skewX(0deg)', borderRadius: '14px', offset: 0.4 },
        { left: target.left + 'px', top: target.top + 'px', width: target.width + 'px', height: target.height + 'px', transform: 'scale(1,1) skewX(0deg)', borderRadius: '12px', offset: 0.7 },
        { left: midX + 'px', top: midY + 'px', width: midW + 'px', height: midH + 'px', transform: 'scale(0.55,1.28) skewX(10deg)', borderRadius: '26px', offset: 0.82 },
        { left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px', height: rect.height + 'px', transform: 'scale(1,1) skewX(0deg)', borderRadius: '0px', offset: 1 },
      ],
      { duration: total, easing: 'cubic-bezier(0.2,0.8,0.2,1)' },
    );
  }

  const cleanup = () => {
    items.forEach((it) => showOriginalCard(it.el));
    overlay.remove();
  };
  const unregister = registerSpotlight(overlay, cleanup);
  setTimeout(() => {
    cleanup();
    unregister();
  }, total + 150);
}

function spawnSpotlightSqueeze(
  board: HTMLElement,
  els: HTMLElement[],
  s: Settings,
  delta?: number,
  durationOverride?: number,
): void {
  const total = spotlightTotal(
    durationOverride,
    clamp(Number(s.spotlightReturnDuration) || 1600, 600, 6000),
  );
  const boardRect = board.getBoundingClientRect();
  const centerX = boardRect.left + boardRect.width / 2;

  const awayAnims: Animation[] = [];
  board.querySelectorAll<HTMLElement>('.card[data-kind], .member[data-person]').forEach((n) => {
    if (els.includes(n)) return;
    const r = n.getBoundingClientRect();
    const dir = r.left + r.width / 2 < centerX ? -1 : 1;
    const dist = Math.min(260, Math.max(70, Math.abs(centerX - (r.left + r.width / 2)) * 0.35));
    const away = 'translateX(' + Math.round(dir * dist) + 'px) scale(0.8)';
    awayAnims.push(
      n.animate(
        [
          { transform: 'none', filter: 'blur(0px)', opacity: 1, offset: 0 },
          { transform: away, filter: 'blur(5px)', opacity: 0.5, offset: 0.34 },
          { transform: away, filter: 'blur(5px)', opacity: 0.5, offset: 0.72 },
          { transform: 'none', filter: 'blur(0px)', opacity: 1, offset: 1 },
        ],
        { duration: total, easing: 'cubic-bezier(0.22, 0.61, 0.36, 1)' },
      ),
    );
  });

  spawnSpotlightReturn(els, s, delta, () => awayAnims.forEach((a) => a.cancel()), durationOverride);
}

function spawnSpotlightPop(
  els: HTMLElement[],
  s: Settings,
  delta?: number,
  durationOverride?: number,
): void {
  const total = spotlightTotal(durationOverride, Math.max(1200, Number(s.scoreEffectDuration) + 600));
  const overlay = document.createElement('div');
  overlay.className = 'spotlight-overlay';
  overlay.style.setProperty('--spot-duration', total + 'ms');
  const stack = document.createElement('div');
  stack.className = 'spotlight-stack';
  stack.style.setProperty('--spot-duration', total + 'ms');

  for (const el of els) {
    const clone = cloneCard(el, s);
    injectSpotDelta(clone, delta, s);
    const width = clamp(Number(s.spotlightWidth) || 520, 200, 1600);
    const height = Number(s.spotlightHeight) || 0;
    const box = document.createElement('div');
    box.className = 'spotlight-item';
    box.style.width = width + 'px';
    if (height > 0) {
      box.style.height = Math.min(height, 1200) + 'px';
      clone.style.height = '100%';
    }
    box.appendChild(clone);
    stack.appendChild(box);
  }
  overlay.appendChild(stack);
  document.body.appendChild(overlay);
  const cleanup = () => overlay.remove();
  const unregister = registerSpotlight(overlay, cleanup);
  setTimeout(() => {
    cleanup();
    unregister();
  }, total + 250);
}

export function spawnSpotlight(
  board: HTMLElement,
  els: HTMLElement[],
  s: Settings,
  delta?: number,
  durationOverride?: number,
): void {
  const theme = s.spotlightTheme || (s.spotlightReturnToOrigin ? 'fly' : 'pop');
  if (!prefersReducedMotion()) {
    if (theme === 'fly') return spawnSpotlightReturn(els, s, delta, undefined, durationOverride);
    if (theme === 'genie') return spawnSpotlightGenie(els, s, delta, durationOverride);
    if (theme === 'squeeze') return spawnSpotlightSqueeze(board, els, s, delta, durationOverride);
  }
  spawnSpotlightPop(els, s, delta, durationOverride);
}

export function spawnHighlight(els: HTMLElement[], s: Settings): void {
  const total = Math.max(1000, Number(s.scoreEffectDuration) + 400);
  const scrim = document.createElement('div');
  scrim.className = 'highlight-scrim';
  document.body.appendChild(scrim);

  for (const el of els) {
    el.classList.add('highlighting');
    const glow = s.scoreEffectColor || s.accent || '#e8a33d';
    el.animate(
      [
        { transform: 'scale(1)', filter: 'brightness(1)' },
        { transform: 'scale(1.07)', filter: 'brightness(1.35)', offset: 0.35 },
        { transform: 'scale(1.02)', filter: 'brightness(1.1)', offset: 0.7 },
        { transform: 'scale(1)', filter: 'brightness(1)' },
      ],
      { duration: total, easing: 'ease' },
    );
    el.style.setProperty('--hl-glow', glow);
  }

  setTimeout(() => {
    scrim.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, easing: 'ease' }).onfinish = () =>
      scrim.remove();
    els.forEach((el) => {
      el.style.transition = 'box-shadow 300ms ease, filter 300ms ease';
      el.classList.remove('highlighting');
      setTimeout(() => {
        el.style.transition = '';
      }, 320);
    });
  }, total);
}

export function applyAutoAvatarSizes(board: HTMLElement | null, s: Settings): void {
  if (!board || s.avatarSizeMode !== 'auto' || s.layoutMode !== 'free') return;
  const boardW = board.clientWidth;
  const boardH = board.clientHeight;
  if (!boardW || !boardH) return;
  board.querySelectorAll<HTMLElement>('.card[data-kind]').forEach((card) => {
    const w = ((parseFloat(card.style.width) || 20) / 100) * boardW;
    const h = ((parseFloat(card.style.height) || 14) / 100) * boardH;
    const av = Math.round(clamp(Math.min(w * 0.28, h * 0.5), 20, 140));
    if (card.dataset.kind === 'person') {
      card.style.setProperty('--person-avatar', av + 'px');
    } else {
      card.style.setProperty('--team-avatar', Math.round(clamp(av * 0.7, 18, 110)) + 'px');
      card.style.setProperty('--member-avatar-base', Math.round(clamp(av * 0.5, 16, 72)) + 'px');
    }
  });
}
