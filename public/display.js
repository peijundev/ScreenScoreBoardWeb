'use strict';
/* global avatarURL, connectWS, escapeHTML */
/* 显示端：全量状态驱动渲染；?edit=1 时可在自由布局下拖动/缩放卡片 */

let prevScores = {};   // personId -> 上次分数
let pendingState = null;
let interacting = false;
let drag = null;
let currentSettings = null;
let currentState = null;
let currentRuntime = null;
let runtimeReceivedAt = 0;
let currentProjectId = new URLSearchParams(location.search).get('project') || null;

const isEdit = new URLSearchParams(location.search).get('edit') === '1';
if (isEdit) document.body.classList.add('edit-mode');

// 管理端预览 iframe：标题自由位置时允许直接拖动，无需开启编辑布局
const inPreviewFrame = window.parent !== window;
if (inPreviewFrame) document.body.classList.add('preview-embed');

const board = document.getElementById('board');
const emptyTip = document.getElementById('empty-tip');
const titleEl = document.getElementById('board-title');
const connDot = document.getElementById('conn-dot');
const clockEl = document.getElementById('clock');
const countdownEl = document.getElementById('countdown');
const countdownBigEl = document.getElementById('countdown-big');
const countdownBigTimeEl = document.getElementById('countdown-big-time');
const countdownBigCaptionEl = document.getElementById('countdown-big-caption');
const leaderboardEl = document.getElementById('leaderboard');
const viewParam = new URLSearchParams(location.search).get('view');

const MIN_W = 8;
const MIN_H = 6;

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
function round2(v) {
  return Math.round(v * 100) / 100;
}

function scoreClass(n) {
  return n > 0 ? 'score-pos' : n < 0 ? 'score-neg' : 'score-zero';
}

function hexToRgba(hex, alpha) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  return 'rgba(' + parseInt(m[1], 16) + ',' + parseInt(m[2], 16) + ',' + parseInt(m[3], 16) + ',' + alpha + ')';
}

// 分数变化时：特效类 + 浮动增量数字
function fxAttrs(settings, delta) {
  if (delta == null || delta === 0 || settings.scoreEffect === 'none') return { cls: '', badge: '' };
  if (settings.scoreEffectOnlyPositive && delta < 0) return { cls: '', badge: '' };
  const color = settings.scoreEffectColor || (delta > 0 ? '#6fbf7b' : '#e06c75');
  return {
    cls: ' fx',
    badge: '<span class="fx-delta" style="color:' + color + '">' +
      (delta > 0 ? '+' : '') + delta + '</span>',
  };
}

// ---------- 音效（Web Audio 生成，无需音频文件） ----------
let audioCtx = null;

function getAudioCtx() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return audioCtx;
  } catch (_) {
    return null;
  }
}
// 浏览器要求先有用户操作才能放声音，点一下页面即可解锁
document.addEventListener('pointerdown', getAudioCtx, { once: true });
document.addEventListener('keydown', getAudioCtx, { once: true });

function playScoreSound(delta, settings) {
  if (!settings.soundEnabled) return;
  if (settings.scoreEffectOnlyPositive && delta < 0) return;

  // 自定义音效优先
  if (settings.customSound) {
    try {
      const audio = new Audio('/' + settings.customSound);
      audio.volume = Math.max(0, Math.min(1, settings.soundVolume));
      audio.play().catch(() => {});
    } catch (_) {}
    return;
  }

  const ctx = getAudioCtx();
  if (!ctx || ctx.state !== 'running') return;
  const t = ctx.currentTime;
  const vol = Math.max(0.0001, settings.soundVolume);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.25 * vol, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
  gain.connect(ctx.destination);
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  if (delta > 0) {
    osc.frequency.setValueAtTime(880, t);
    osc.frequency.setValueAtTime(1318.5, t + 0.08);
  } else {
    osc.frequency.setValueAtTime(320, t);
    osc.frequency.exponentialRampToValueAtTime(150, t + 0.22);
  }
  osc.connect(gain);
  osc.start(t);
  osc.stop(t + 0.36);
}

// ---------- 彩带 ----------
function spawnConfetti(el, colors, duration) {
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

// ---------- 居中放大突显：克隆卡片到屏幕中央放大再缩回 ----------
// els 可以是单张卡片，也可以是「人物 + 团队」两张，一起放大展示
function prefersReducedMotion() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// 从原位置飞入居中、停留、再飞回原位
function spawnSpotlightReturn(els, settings) {
  const total = Math.min(Math.max(Number(settings.spotlightReturnDuration) || 1600, 600), 6000);
  const overlay = document.createElement('div');
  overlay.className = 'spotlight-return-overlay';
  overlay.style.setProperty('--spot-duration', total + 'ms');
  const scrim = document.createElement('div');
  scrim.className = 'spotlight-return-scrim';
  overlay.appendChild(scrim);

  const items = [];
  for (const el of els) {
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    const clone = el.cloneNode(true);
    clone.querySelectorAll('.resize-handle, .fx-delta, .confetti-layer').forEach((n) => n.remove());
    ['position', 'left', 'top', 'right', 'bottom', 'width', 'height', 'transform', 'animation', 'zoom']
      .forEach((p) => clone.style.removeProperty(p));
    clone.classList.remove('dragging');
    clone.removeAttribute('data-person');
    clone.removeAttribute('data-kind');
    clone.removeAttribute('data-id');

    const width = Math.min(Math.max(Number(settings.spotlightWidth) || 520, 200), 1600);
    let height = Number(settings.spotlightHeight) || 0;
    if (!height) height = rect.height * (width / rect.width);
    height = Math.min(Math.max(height, 120), window.innerHeight * 0.8);

    const box = document.createElement('div');
    box.className = 'spotlight-return-box';
    box.style.left = rect.left + 'px';
    box.style.top = rect.top + 'px';
    box.style.width = rect.width + 'px';
    box.style.height = rect.height + 'px';
    box.appendChild(clone);
    overlay.appendChild(box);
    items.push({ el, box, rect, width, height });
  }
  if (!items.length) return;

  const gap = 20;
  const totalW = items.reduce((s, it) => s + it.width, 0) + gap * (items.length - 1);
  let x = (window.innerWidth - totalW) / 2;
  for (const it of items) {
    it.target = { left: x, top: (window.innerHeight - it.height) / 2, width: it.width, height: it.height };
    x += it.width + gap;
  }

  document.body.appendChild(overlay);
  items.forEach((it) => { it.el.style.visibility = 'hidden'; });

  scrim.animate(
    [{ opacity: 0 }, { opacity: 1, offset: 0.25 }, { opacity: 1, offset: 0.7 }, { opacity: 0 }],
    { duration: total, easing: 'ease' }
  );

  for (const it of items) {
    const { rect, target, box } = it;
    box.animate([
      { left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px', height: rect.height + 'px', offset: 0 },
      { left: target.left + 'px', top: target.top + 'px', width: target.width + 'px', height: target.height + 'px', offset: 0.34 },
      { left: target.left + 'px', top: target.top + 'px', width: target.width + 'px', height: target.height + 'px', offset: 0.72 },
      { left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px', height: rect.height + 'px', offset: 1 },
    ], { duration: total, easing: 'cubic-bezier(0.25, 0.8, 0.25, 1)' });
  }

  setTimeout(() => {
    overlay.remove();
    items.forEach((it) => {
      if (it.el.isConnected) it.el.style.visibility = '';
    });
  }, total + 150);
}

function spawnSpotlight(els, settings) {
  if (settings.spotlightReturnToOrigin && !prefersReducedMotion()) {
    spawnSpotlightReturn(els, settings);
    return;
  }
  const total = Math.max(1200, settings.scoreEffectDuration + 600);

  const overlay = document.createElement('div');
  overlay.className = 'spotlight-overlay';
  overlay.style.setProperty('--spot-duration', total + 'ms');

  const stack = document.createElement('div');
  stack.className = 'spotlight-stack';
  stack.style.setProperty('--spot-duration', total + 'ms');

  for (const el of els) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll('.resize-handle, .fx-delta, .confetti-layer').forEach((n) => n.remove());
    ['position', 'left', 'top', 'right', 'bottom', 'width', 'height', 'transform', 'animation', 'zoom']
      .forEach((p) => clone.style.removeProperty(p));
    clone.classList.remove('dragging');
    clone.removeAttribute('data-person');
    clone.removeAttribute('data-kind');
    clone.removeAttribute('data-id');

    const width = Math.min(Math.max(Number(settings.spotlightWidth) || 520, 200), 1600);
    const height = Number(settings.spotlightHeight) || 0;
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
  setTimeout(() => overlay.remove(), total + 250);
}

// 管理端点「预览突显效果」时，用当前范围/宽高在预览里演示一次
function previewSpotlight() {
  const settings = currentSettings;
  if (!settings) return;
  const scope = settings.spotlightScope || 'person';
  const teamCard = board.querySelector('.card[data-kind="team"]');
  const memberEl = board.querySelector('.member[data-person]');
  const personCard = board.querySelector('.card[data-kind="person"]');
  let els = [];

  if (scope === 'team') {
    els = teamCard ? [teamCard] : (personCard ? [personCard] : (memberEl ? [memberEl] : []));
  } else if (scope === 'person_team') {
    if (memberEl && teamCard) els = [memberEl, teamCard];
    else if (personCard) els = [personCard];
    else if (teamCard) els = [teamCard];
  } else {
    if (memberEl) els = [memberEl];
    else if (personCard) els = [personCard];
    else if (teamCard) els = [teamCard];
  }
  if (els.length) spawnSpotlight(els, settings);
}

window.addEventListener('message', (e) => {
  if (e.origin !== location.origin) return;
  if (e.data && e.data.type === 'preview-spotlight') previewSpotlight();
});

// 卡片通用属性：数据标识 + 自由布局坐标 + 卡面图
function cardAttrs(kind, entity, layout) {
  const style = [];
  if (layout) {
    style.push('left:' + layout.x + '%', 'top:' + layout.y + '%',
      'width:' + layout.w + '%', 'height:' + layout.h + '%');
  }
  if (entity.cardImage) style.push("--card-img:url('/" + entity.cardImage + "')");
  const cls = 'card ' + (kind === 'person' ? 'person-card' : 'team-card') +
    (entity.cardImage ? ' has-card-image' : '');
  return {
    cls,
    attrs: ' data-kind="' + kind + '" data-id="' + entity.id + '"' +
      (style.length ? ' style="' + style.join(';') + '"' : ''),
  };
}

function resizeHandleHTML(enabled) {
  return enabled ? '<span class="resize-handle" data-handle></span>' : '';
}

// 成员小卡片在团队内未保存位置时的初始排布（按人数做行列网格）
function memberFallbackLayouts(n) {
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

function memberHTML(m, settings, delta, layout, editable) {
  const style = [];
  if (layout) {
    style.push('left:' + layout.x + '%', 'top:' + layout.y + '%',
      'width:' + layout.w + '%', 'height:' + layout.h + '%');
  }
  if (m.cardImage) style.push("--card-img:url('/" + m.cardImage + "')");
  const cls = 'member av-' + settings.avatarPosition + (m.cardImage ? ' has-card-image' : '');
  const fx = fxAttrs(settings, delta);
  return (
    '<div class="' + cls + '" data-person="' + m.id + '"' +
      (style.length ? ' style="' + style.join(';') + '"' : '') + '>' +
      '<img src="' + avatarURL(m, 48) + '" alt="">' +
      '<div class="m-body">' +
        '<div class="member-name">' + escapeHTML(m.name) + '</div>' +
        (settings.showMemberScore
          ? '<div class="score member-score ' + scoreClass(m.score) + fx.cls + '">' + m.score + '</div>'
          : '') +
      '</div>' +
      resizeHandleHTML(editable) +
    '</div>'
  );
}

function rankHTML(meta) {
  return meta && meta.rank != null ? '<span class="rank">' + meta.rank + '</span>' : '';
}

function barHTML(meta) {
  if (!meta) return '';
  const cls = 'score-bar' + (meta.value < 0 ? ' score-bar-neg' : '') +
    (meta.value === 0 ? ' score-bar-zero' : '');
  return '<span class="' + cls + '" style="width:' + meta.barPct + '%"></span>';
}

function personCardHTML(p, delta, layout, editable, settings, meta) {
  const c = cardAttrs('person', p, layout);
  const cls = c.cls + ' av-' + settings.avatarPosition;
  const fx = fxAttrs(settings, delta);
  return (
    '<div class="' + cls + '"' + c.attrs + '>' +
      rankHTML(meta) +
      '<img src="' + avatarURL(p) + '" alt="">' +
      '<div class="person-name">' + escapeHTML(p.name) + '</div>' +
      '<div class="score person-score ' + scoreClass(p.score) + fx.cls + '">' +
        fx.badge + p.score +
      '</div>' +
      barHTML(meta) +
      resizeHandleHTML(editable) +
    '</div>'
  );
}

function teamCardHTML(team, members, settings, deltas, layout, editable, meta) {
  const total = members.reduce((s, m) => s + m.score, 0);
  let teamDelta = 0;
  for (const m of members) {
    const d = deltas.get(m.id);
    if (d != null) teamDelta += d;
  }
  const freeMembers = settings.layoutMode === 'free';
  const fallback = memberFallbackLayouts(members.length);
  const membersHTML = members.map((m, i) => memberHTML(
    m, settings, deltas.get(m.id),
    freeMembers ? (m.memberLayout || fallback[i]) : null,
    editable
  )).join('');
  const tfx = fxAttrs(settings, teamDelta);
  const c = cardAttrs('team', team, layout);
  return (
    '<div class="' + c.cls + '"' + c.attrs + '>' +
      rankHTML(meta) +
      '<div class="team-head av-' + settings.avatarPosition + '">' +
        '<img src="' + avatarURL(team, 64) + '" alt="">' +
        '<div class="team-name">' + escapeHTML(team.name) + '</div>' +
        (settings.showTeamTotal
          ? '<div class="score team-total' + tfx.cls + '">' + tfx.badge + total + '</div>'
          : '') +
      '</div>' +
      '<div class="team-members' + (freeMembers ? ' free' : '') + '">' +
        (membersHTML || '<div class="member-empty">暂无成员</div>') +
      '</div>' +
      barHTML(meta) +
      resizeHandleHTML(editable) +
    '</div>'
  );
}

const FONT_STACKS = {
  system: '"Noto Sans", "Noto Sans CJK SC", "Source Han Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif',
  serif: '"Noto Serif CJK SC", "Source Han Serif SC", "Songti SC", "SimSun", serif',
  kai: '"Kaiti SC", "KaiTi", "STKaiti", "Noto Serif CJK SC", serif',
};

const SHADOWS = {
  none: 'none',
  soft: '0 4px 14px rgba(0, 0, 0, 0.16)',
  medium: '0 10px 28px rgba(0, 0, 0, 0.22)',
  strong: '0 18px 48px rgba(0, 0, 0, 0.3)',
};

function setVar(style, name, value) {
  if (value === '' || value == null) style.removeProperty(name);
  else style.setProperty(name, value);
}

// 高级外观：把可调项映射成 CSS 变量 / data 属性
function applyAdvancedAppearance(settings) {
  const root = document.documentElement;
  const body = document.body;

  // 古风/水墨默认使用宋体；用户显式选字体时以用户设置为准
  const serifStyles = ['guofeng', 'ink'];
  if (settings.fontFamily === 'custom' && settings.fontFamilyCustom) {
    const name = settings.fontFamilyCustom.replace(/["\\]/g, '');
    body.style.fontFamily = '"' + name + '", ' + FONT_STACKS.system;
  } else {
    const fontKey = settings.fontFamily === 'system' && serifStyles.includes(settings.displayStyle)
      ? 'serif' : settings.fontFamily;
    body.style.fontFamily = FONT_STACKS[fontKey] || FONT_STACKS.system;
  }

  setVar(root.style, '--font-scale', String(settings.fontScale));
  setVar(root.style, '--title-size', settings.titleSize ? settings.titleSize + 'px' : '');
  setVar(root.style, '--board-max', settings.boardMaxWidth + 'px');
  setVar(root.style, '--gap-override', settings.cardGap ? settings.cardGap + 'px' : '');
  setVar(root.style, '--card-pad-override', settings.cardPad ? settings.cardPad + 'px' : '');
  setVar(root.style, '--card-border-width', settings.cardBorderWidth + 'px');
  setVar(root.style, '--team-bar-w', settings.teamAccentWidth + 'px');
  setVar(root.style, '--team-accent-color', settings.teamAccentColor || '');
  body.dataset.teamAccent = settings.showTeamAccent === false ? 'off' : 'on';
  setVar(root.style, '--avatar-border-w', settings.avatarBorderWidth + 'px');
  setVar(root.style, '--avatar-radius', settings.avatarShape === 'square' ? '0px' : '50%');
  setVar(root.style, '--rank-size', settings.rankSize + 'px');
  setVar(root.style, '--bar-height', settings.scoreBarHeight + 'px');
  setVar(root.style, '--scrim-opacity', String(settings.scrimOpacity));
  setVar(root.style, '--score-pos', settings.positiveColor);
  setVar(root.style, '--score-neg', settings.negativeColor);
  setVar(root.style, '--title-color', settings.titleColor || '');
  setVar(root.style, '--rank-color', settings.rankColor || '');
  body.dataset.titleColor = settings.titleColor ? 'custom' : 'auto';
  body.dataset.rankColor = settings.rankColor ? 'custom' : 'auto';

  // 这些变量定义在 body 主题规则里，必须写在 body 上才能覆盖
  setVar(body.style, '--text', settings.textColor || '');
  setVar(body.style, '--card-border', settings.cardBorderColor || '');

  if (settings.cardShadow === 'auto') {
    body.dataset.cardShadow = 'auto';
    setVar(root.style, '--card-shadow', '');
  } else {
    body.dataset.cardShadow = 'custom';
    setVar(root.style, '--card-shadow', SHADOWS[settings.cardShadow] || 'none');
  }

  body.dataset.titleAlign = settings.titleAlign;
  body.dataset.titleDecor = settings.titleDecor || 'auto';
  body.dataset.styleFree = settings.styleFreeConfig ? 'on' : 'off';
  body.dataset.titleFree = settings.titleFree ? 'on' : 'off';
  setVar(root.style, '--title-x', settings.titleX + '%');
  setVar(root.style, '--title-y', settings.titleY + '%');
  body.dataset.titleRule = settings.showTitleRule ? 'on' : 'off';
  body.dataset.showRank = settings.showRank ? '1' : '0';
  body.dataset.showBar = settings.showScoreBar ? '1' : '0';
}

function applyAppearance(settings) {
  document.body.dataset.theme = settings.theme;
  document.body.dataset.density = settings.density;
  document.body.dataset.displayStyle = settings.displayStyle || 'lecture';
  applyAdvancedAppearance(settings);
  document.documentElement.style.setProperty('--cols', settings.columns);
  document.documentElement.style.setProperty('--accent', settings.accent);
  document.documentElement.style.setProperty('--radius', settings.cardRadius + 'px');
  document.documentElement.style.setProperty('--member-scale', settings.memberScale);

  // 头像大小：手动模式使用全局像素值；自动模式在自由布局中按卡片尺寸计算
  if (settings.avatarSizeMode === 'manual') {
    document.documentElement.style.setProperty('--person-avatar', settings.avatarSize + 'px');
    document.documentElement.style.setProperty('--team-avatar', Math.round(settings.avatarSize * 0.7) + 'px');
    document.documentElement.style.setProperty('--member-avatar-base', Math.round(settings.avatarSize * 0.56) + 'px');
  } else {
    document.documentElement.style.removeProperty('--person-avatar');
    document.documentElement.style.removeProperty('--team-avatar');
    document.documentElement.style.removeProperty('--member-avatar-base');
  }

  // 卡片底色：跟随主题 / 自定义纯色 / 半透明 / 亚克力
  const themeCard = settings.theme === 'light' ? '#ffffff' : '#1a1f26';
  const baseCard = settings.cardBg || themeCard;
  const cardMode = settings.cardBgMode || 'auto';
  document.body.dataset.cardSurface = cardMode;
  if (cardMode === 'translucent' || cardMode === 'acrylic') {
    document.body.style.setProperty('--card', hexToRgba(baseCard, settings.cardOpacity));
    document.body.style.setProperty('--card-blur', settings.cardAcrylicBlur + 'px');
  } else if (cardMode === 'custom') {
    document.body.style.setProperty('--card', baseCard);
    document.body.style.removeProperty('--card-blur');
  } else {
    if (settings.cardBg) document.body.style.setProperty('--card', settings.cardBg);
    else document.body.style.removeProperty('--card');
    document.body.style.removeProperty('--card-blur');
  }

  // 卡片样式（毛玻璃 / 新拟态 / 霓虹 / 渐变 / 纸片）
  document.body.dataset.cardStyle = settings.cardStyle;
  const glassBase = settings.cardBg || (settings.theme === 'light' ? '#ffffff' : '#1a1f26');
  document.body.style.setProperty('--glass-bg', hexToRgba(glassBase, settings.glassOpacity));
  document.body.style.setProperty('--glass-blur', settings.glassBlur + 'px');

  // 加分特效：类型 / 时长 / 颜色
  document.body.dataset.scoreEffect = settings.scoreEffect;
  document.documentElement.style.setProperty('--fx-duration', settings.scoreEffectDuration + 'ms');
  if (settings.scoreEffectColor) {
    document.documentElement.style.setProperty('--fx-color', settings.scoreEffectColor);
  } else {
    document.documentElement.style.removeProperty('--fx-color');
  }

  document.body.style.backgroundColor = settings.bgColor;
  const useImage = settings.bgType === 'image' && settings.bgImage;
  document.body.classList.toggle('has-bg-image', Boolean(useImage));
  document.body.style.backgroundImage = useImage ? 'url("/' + settings.bgImage + '")' : '';

  titleEl.textContent = settings.title;
  document.title = settings.title;
}

// 自动头像大小：自由布局时按卡片实际尺寸计算，卡片越大头像越大
function applyAutoAvatarSizes() {
  const settings = currentSettings;
  if (!settings || settings.avatarSizeMode !== 'auto' || settings.layoutMode !== 'free') return;
  const boardW = board.clientWidth;
  const boardH = board.clientHeight;
  if (!boardW || !boardH) return;
  board.querySelectorAll('.card[data-kind]').forEach((card) => {
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

let avatarResizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(avatarResizeTimer);
  avatarResizeTimer = setTimeout(applyAutoAvatarSizes, 120);
});

// ---------- 名次 / 时钟 / 倒计时 / 排行榜 ----------
function assignRanks(values, mode) {
  let dense = 0;
  let prev = null;
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

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatDuration(sec) {
  const total = Math.max(0, Math.ceil(sec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? h + ':' + pad2(m) + ':' + pad2(s) : pad2(m) + ':' + pad2(s);
}

function updateClock() {
  const settings = currentSettings;
  if (!settings || !settings.featureClock) {
    clockEl.classList.add('hidden');
    return;
  }
  const now = new Date();
  let hours = now.getHours();
  const suffix = settings.clockFormat === '12' ? (hours >= 12 ? ' PM' : ' AM') : '';
  if (settings.clockFormat === '12') hours = hours % 12 || 12;
  let text = pad2(hours) + ':' + pad2(now.getMinutes());
  if (settings.clockShowSeconds) text += ':' + pad2(now.getSeconds());
  text += suffix;
  if (settings.clockShowDate) {
    text = now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate()) + '  ' + text;
  }
  clockEl.textContent = text;
  clockEl.className = 'overlay-clock clock-pos-' + settings.clockPosition;
}

function updateCountdown() {
  const settings = currentSettings;
  const c = currentRuntime && currentRuntime.countdowns
    ? currentRuntime.countdowns[currentProjectId] : null;
  if (!settings || !settings.featureCountdown || !c) {
    countdownEl.classList.add('hidden');
    countdownBigEl.classList.add('hidden');
    document.body.classList.remove('countdown-fullscreen');
    return;
  }
  let remaining;
  if (c.state === 'running') {
    const offset = currentRuntime.serverNow ? currentRuntime.serverNow - runtimeReceivedAt : 0;
    remaining = Math.max(0, c.endsAt - (Date.now() + offset)) / 1000;
  } else {
    remaining = (c.remainingMs || 0) / 1000;
  }
  const ended = c.state === 'ended' || remaining <= 0;
  const mode = settings.countdownDisplayMode || 'corner';

  if (mode === 'corner') {
    countdownEl.textContent = ended ? '时间到' : formatDuration(remaining);
    const both = settings.featureClock;
    countdownEl.className = 'overlay-countdown clock-pos-' + settings.clockPosition +
      (ended ? ' ended' : '') + (both ? ' shifted' : '');
    countdownBigEl.classList.add('hidden');
    document.body.classList.remove('countdown-fullscreen');
    return;
  }

  // 居中大窗口 / 全屏
  countdownEl.classList.add('hidden');
  countdownBigEl.classList.remove('hidden');
  countdownBigEl.className = 'countdown-big ' +
    (mode === 'fullscreen' ? 'fullscreen-mode' : 'center-mode') +
    (ended ? ' ended' : '') +
    (settings.countdownShowProgress === false ? ' no-progress' : '') +
    (settings.countdownShowBackdrop === false ? ' no-backdrop' : '');
  countdownBigEl.dataset.shape = settings.countdownShape || 'circle';
  countdownBigEl.dataset.position = settings.countdownPosition || 'center';
  const shape = settings.countdownShape || 'circle';
  const cdWidth = Number(settings.countdownSize) || 520;
  const canResize = shape === 'rounded' || shape === 'rounded-rect' || shape === 'rect';
  const cdHeight = canResize && Number(settings.countdownHeight) > 0
    ? Number(settings.countdownHeight) : cdWidth;
  countdownBigEl.style.setProperty('--cd-size', cdWidth + 'px');
  countdownBigEl.style.setProperty('--cd-height', cdHeight + 'px');
  const manualSize = Number(settings.countdownFontSize) || 0;
  const timeSize = manualSize > 0
    ? manualSize
    : Math.min(180, Math.max(30, Math.round(Math.min(cdWidth, cdHeight) * 0.22)));
  countdownBigEl.style.setProperty('--cd-time-size', timeSize + 'px');
  countdownBigEl.style.setProperty('--cd-radius', settings.countdownRadius + 'px');
  const baseBg = settings.countdownBg || settings.cardBg ||
    (settings.theme === 'light' ? '#ffffff' : '#1a1f26');
  countdownBigEl.style.setProperty('--cd-panel-bg', hexToRgba(baseBg, settings.countdownOpacity));
  if (settings.countdownTextColor) {
    countdownBigEl.style.setProperty('--cd-text', settings.countdownTextColor);
  } else {
    countdownBigEl.style.removeProperty('--cd-text');
  }
  countdownBigTimeEl.textContent = formatDuration(remaining);
  countdownBigCaptionEl.textContent = ended ? '时间到' : '倒计时';
  const duration = (c.durationMs || 1) / 1000;
  const progress = Math.max(0, Math.min(1, remaining / duration));
  countdownBigEl.style.setProperty('--cd-progress', String(progress));
  document.body.classList.toggle('countdown-fullscreen', mode === 'fullscreen');
}

function applyRuntimeUI() {
  updateClock();
  updateCountdown();
}

setInterval(() => {
  updateClock();
  updateCountdown();
}, 500);

function leaderboardEntries(project, settings) {
  const people = Object.values(project.people);
  const teams = Object.values(project.teams);
  const scope = settings.leaderboardScope || 'auto';
  const entries = [];

  const teamScore = (team) => people
    .filter((p) => p.teamId === team.id)
    .reduce((s, p) => s + p.score, 0);

  if (scope === 'people') {
    for (const p of people) {
      entries.push({
        kind: 'person',
        id: p.id,
        name: p.name,
        avatar: p.avatar,
        score: p.score,
        teamName: p.teamId && project.teams[p.teamId] ? project.teams[p.teamId].name : '',
        createdAt: p.createdAt,
      });
    }
  } else if (scope === 'teams') {
    for (const t of teams) {
      entries.push({
        kind: 'team', id: t.id, name: t.name, avatar: t.avatar,
        score: teamScore(t), teamName: '', createdAt: t.createdAt,
      });
    }
  } else {
    for (const p of people) {
      if (p.teamId && project.teams[p.teamId]) continue;
      entries.push({
        kind: 'person', id: p.id, name: p.name, avatar: p.avatar,
        score: p.score, teamName: '', createdAt: p.createdAt,
      });
    }
    for (const t of teams) {
      entries.push({
        kind: 'team', id: t.id, name: t.name, avatar: t.avatar,
        score: teamScore(t), teamName: '', createdAt: t.createdAt,
      });
    }
  }

  entries.sort((a, b) => (b.score - a.score) || (a.createdAt - b.createdAt));
  const limit = Number(settings.leaderboardLimit) || 0;
  const limited = limit > 0 ? entries.slice(0, limit) : entries;
  const tieMode = settings.featureRankTies ? settings.rankTieMode : 'none';
  const ranks = assignRanks(limited.map((e) => e.score), tieMode);
  limited.forEach((e, i) => { e.rank = ranks[i]; });
  return limited;
}

function renderLeaderboard(project, settings) {
  const entries = leaderboardEntries(project, settings);
  const maxAbs = Math.max(1, ...entries.map((e) => Math.abs(e.score)));
  leaderboardEl.style.setProperty('--lb-scale', settings.leaderboardScale);
  leaderboardEl.innerHTML = entries.map((e) => {
    const pct = Math.min(100, Math.round((Math.abs(e.score) / maxAbs) * 100));
    const rowClass = 'lb-row' + (e.score < 0 ? ' lb-neg' : '') +
      (e.rank === 1 ? ' lb-top-1' : e.rank === 2 ? ' lb-top-2' : e.rank === 3 ? ' lb-top-3' : '');
    return (
      '<div class="' + rowClass + '">' +
        '<span class="lb-rank">' + e.rank + '</span>' +
        '<img src="' + avatarURL(e, 64) + '" alt="">' +
        '<div class="lb-main">' +
          '<div class="lb-name">' + escapeHTML(e.name) + '</div>' +
          (e.teamName ? '<div class="lb-team">' + escapeHTML(e.teamName) + '</div>' : '') +
        '</div>' +
        '<span class="score lb-score ' + scoreClass(e.score) + '">' + e.score + '</span>' +
        '<span class="lb-bar" style="width:' + pct + '%"></span>' +
      '</div>'
    );
  }).join('') || '<div class="lb-empty">暂无数据</div>';
  leaderboardEl.classList.remove('hidden');
  board.classList.add('hidden');
  emptyTip.classList.add('hidden');
}

// 未保存过位置的卡片：按 16:9 画布做货架式初始摆放（各端计算结果一致）
function shelfLayouts(items) {
  const out = [];
  let x = 2, y = 2, rowH = 0;
  for (const it of items) {
    const w = it.kind === 'team' ? 34 : 22;
    const h = it.kind === 'team' ? 26 : 14;
    if (x + w > 98) { x = 2; y += rowH + 2; rowH = 0; }
    if (y + h > 98) { x = 2; y = 2; rowH = 0; }
    out.push({ x, y, w, h });
    x += w + 2;
    rowH = Math.max(rowH, h);
  }
  return out;
}

function buildItems(project, settings) {
  const people = Object.values(project.people);
  const teams = Object.values(project.teams);
  const items = [];

  for (const p of people) {
    if (!p.teamId || !project.teams[p.teamId]) {
      items.push({ kind: 'person', person: p, sortKey: settings.sortBy === 'score' ? p.score : p.createdAt });
    }
  }
  for (const t of teams) {
    const members = people
      .filter((p) => p.teamId === t.id)
      .sort((a, b) => (settings.sortBy === 'score'
        ? (settings.sortOrder === 'asc' ? a.score - b.score : b.score - a.score)
        : a.createdAt - b.createdAt));
    const total = members.reduce((s, m) => s + m.score, 0);
    items.push({ kind: 'team', team: t, members, sortKey: settings.sortBy === 'score' ? total : t.createdAt });
  }
  const dir = settings.sortOrder === 'asc' ? 1 : -1;
  items.sort(settings.sortBy === 'score'
    ? (a, b) => dir * (b.sortKey - a.sortKey)
    : (a, b) => (settings.sortOrder === 'asc' ? b.sortKey - a.sortKey : a.sortKey - b.sortKey));
  return items;
}

function render(project) {
  const settings = project.settings;
  currentSettings = settings;
  applyAppearance(settings);

  const people = Object.values(project.people);
  const deltas = new Map();
  for (const p of people) {
    const prev = prevScores[p.id];
    if (prev !== undefined && prev !== p.score) deltas.set(p.id, p.score - prev);
  }
  prevScores = Object.fromEntries(people.map((p) => [p.id, p.score]));

  const items = buildItems(project, settings);

  // 展板式信息：按分数展示时的名次 + 相对分数条
  const itemScore = (it) => it.kind === 'person'
    ? it.person.score
    : it.members.reduce((sum, m) => sum + m.score, 0);
  const maxAbs = Math.max(1, ...items.map((it) => Math.abs(itemScore(it))));
  const ranked = settings.sortBy === 'score' && settings.sortOrder === 'desc';
  const tieMode = settings.featureRankTies ? settings.rankTieMode : 'none';
  const ranks = ranked
    ? assignRanks(items.map(itemScore), tieMode)
    : items.map(() => null);
  const metaFor = (it, i) => {
    const value = itemScore(it);
    return {
      rank: ranked ? ranks[i] : null,
      value,
      barPct: Math.min(100, Math.round((Math.abs(value) / maxAbs) * 100)),
    };
  };

  const free = settings.layoutMode === 'free';
  board.classList.toggle('free', free);

  if (free) {
    const fallback = shelfLayouts(items);
    const editable = isEdit;
    board.innerHTML = items.map((it, i) => {
      const saved = it.kind === 'person' ? it.person.layout : it.team.layout;
      const layout = saved || fallback[i];
      const meta = metaFor(it, i);
      return it.kind === 'person'
        ? personCardHTML(it.person, deltas.get(it.person.id), layout, editable, settings, meta)
        : teamCardHTML(it.team, it.members, settings, deltas, layout, editable, meta);
    }).join('');
  } else {
    board.innerHTML = items.map((it, i) => {
      const meta = metaFor(it, i);
      return it.kind === 'person'
        ? personCardHTML(it.person, deltas.get(it.person.id), null, false, settings, meta)
        : teamCardHTML(it.team, it.members, settings, deltas, null, false, meta);
    }).join('');
  }

  applyAutoAvatarSizes();

  // 音效与彩带（一次状态更新只播一次声音）
  const totalDelta = Array.from(deltas.values()).reduce((a, b) => a + b, 0);
  if (totalDelta !== 0) playScoreSound(totalDelta, settings);
  if (settings.scoreEffect === 'confetti') {
    const colors = [
      settings.scoreEffectColor || settings.accent,
      '#6fbf7b', '#e06c75', '#e8a33d', '#4f8cff', '#ffffff',
    ];
    for (const it of items) {
      const d = it.kind === 'person'
        ? deltas.get(it.person.id)
        : it.members.reduce((s, m) => s + (deltas.get(m.id) || 0), 0);
      if (!d || (settings.scoreEffectOnlyPositive && d < 0)) continue;
      const id = it.kind === 'person' ? it.person.id : it.team.id;
      const el = board.querySelector('[data-kind="' + it.kind + '"][data-id="' + id + '"]');
      if (el) spawnConfetti(el, colors, settings.scoreEffectDuration);
    }
  }
  if (settings.scoreEffect === 'spotlight') {
    const scope = settings.spotlightScope || 'person';
    const changed = Object.values(project.people).filter((p) => {
      const d = deltas.get(p.id);
      return d && !(settings.scoreEffectOnlyPositive && d < 0);
    });
    // 一次只突显一位（避免批量更新时多个全屏层叠在一起）
    const p = changed[0];
    if (p) {
      const memberEl = board.querySelector('.member[data-person="' + p.id + '"]');
      const personEl = memberEl ||
        board.querySelector('.card[data-kind="person"][data-id="' + p.id + '"]');
      const teamEl = p.teamId
        ? board.querySelector('.card[data-kind="team"][data-id="' + p.teamId + '"]')
        : null;

      const els = [];
      if (scope === 'team') {
        if (teamEl) els.push(teamEl);
        else if (personEl) els.push(personEl); // 没有团队时退回人物
      } else {
        if (personEl) els.push(personEl);
        if (scope === 'person_team' && teamEl) els.push(teamEl);
      }
      if (els.length) spawnSpotlight(els, settings);
    }
  }

  const showLeaderboard = viewParam === 'leaderboard' ||
    (viewParam !== 'board' && settings.featureLeaderboard && settings.displayView === 'leaderboard');
  if (showLeaderboard) {
    renderLeaderboard(project, settings);
  } else {
    leaderboardEl.classList.add('hidden');
    board.classList.remove('hidden');
    emptyTip.classList.toggle('hidden', items.length > 0);
  }
  applyRuntimeUI();
}

// ---------- 自由布局：拖动与缩放（仅 ?edit=1） ----------
function readPctRect(el) {
  return {
    x: parseFloat(el.style.left) || 0,
    y: parseFloat(el.style.top) || 0,
    w: parseFloat(el.style.width) || 0,
    h: parseFloat(el.style.height) || 0,
  };
}

// 对齐候选线：画布边/中线 + 其他卡片的边/中线
function axisLines(rects, axis) {
  const lines = [0, 50, 100];
  for (const r of rects) {
    if (axis === 'x') lines.push(r.x, r.x + r.w / 2, r.x + r.w);
    else lines.push(r.y, r.y + r.h / 2, r.y + r.h);
  }
  return lines;
}

function findSnap(edges, lines, threshold) {
  let best = null;
  for (const line of lines) {
    for (const edge of edges) {
      const diff = line - edge;
      if (Math.abs(diff) <= threshold && (!best || Math.abs(diff) < Math.abs(best.diff))) {
        best = { diff, line };
      }
    }
  }
  return best;
}

function setGuide(el, side, pct) {
  if (!el) return;
  if (pct == null) {
    el.style.display = 'none';
    return;
  }
  el.style.display = 'block';
  el.style[side] = pct + '%';
}

function createGuide(host, cls) {
  const d = document.createElement('div');
  d.className = cls;
  host.appendChild(d);
  return d;
}

function onPointerDown(e) {
  if (!isEdit || !currentSettings || currentSettings.layoutMode !== 'free') return;
  if (e.button !== undefined && e.button !== 0) return;

  const card = e.target.closest('.card[data-kind]');
  if (!card) return;
  e.preventDefault();

  const memberEl = e.target.closest('.member[data-person]');
  if (memberEl) {
    const area = memberEl.closest('.team-members');
    if (!area) return;
    const others = Array.from(area.querySelectorAll('.member[data-person]'))
      .filter((el) => el !== memberEl)
      .map(readPctRect);
    drag = {
      type: 'member',
      el: memberEl,
      personId: memberEl.dataset.person,
      mode: e.target.closest('.resize-handle') ? 'resize' : 'move',
      host: area,
      rect: area.getBoundingClientRect(),
      startX: e.clientX,
      startY: e.clientY,
      x: parseFloat(memberEl.style.left) || 0,
      y: parseFloat(memberEl.style.top) || 0,
      w: parseFloat(memberEl.style.width) || 30,
      h: parseFloat(memberEl.style.height) || 30,
      threshold: 2.2,
      linesX: axisLines(others, 'x'),
      linesY: axisLines(others, 'y'),
      guideV: createGuide(area, 'guide-v'),
      guideH: createGuide(area, 'guide-h'),
    };
  } else {
    const others = Array.from(board.querySelectorAll('.card[data-kind]'))
      .filter((el) => el !== card)
      .map(readPctRect);
    drag = {
      type: 'card',
      el: card,
      kind: card.dataset.kind,
      id: card.dataset.id,
      mode: e.target.closest('.resize-handle') ? 'resize' : 'move',
      host: board,
      rect: board.getBoundingClientRect(),
      startX: e.clientX,
      startY: e.clientY,
      x: parseFloat(card.style.left) || 0,
      y: parseFloat(card.style.top) || 0,
      w: parseFloat(card.style.width) || 22,
      h: parseFloat(card.style.height) || 14,
      threshold: 1.4,
      linesX: axisLines(others, 'x'),
      linesY: axisLines(others, 'y'),
      guideV: createGuide(board, 'guide-v'),
      guideH: createGuide(board, 'guide-h'),
    };
  }
  interacting = true;
  drag.el.classList.add('dragging');
  try { drag.el.setPointerCapture(e.pointerId); } catch (_) {}
  listenParentPointerUp();
}

function onPointerMove(e) {
  if (!drag) return;
  e.preventDefault();
  const { rect, startX, startY, mode, el } = drag;
  const dx = ((e.clientX - startX) / rect.width) * 100;
  const dy = ((e.clientY - startY) / rect.height) * 100;

  let { x, y, w, h } = drag;
  if (mode === 'move') {
    let tx = drag.x + dx;
    let ty = drag.y + dy;
    // 对齐吸附：左/中/右三边分别尝试吸附到其它卡片的边或中线
    const sx = findSnap([tx, tx + drag.w / 2, tx + drag.w], drag.linesX, drag.threshold);
    const sy = findSnap([ty, ty + drag.h / 2, ty + drag.h], drag.linesY, drag.threshold);
    if (sx) tx += sx.diff;
    if (sy) ty += sy.diff;
    x = clamp(tx, 0, 100 - w);
    y = clamp(ty, 0, 100 - h);
    setGuide(drag.guideV, 'left', sx ? sx.line : null);
    setGuide(drag.guideH, 'top', sy ? sy.line : null);
  } else {
    const sx = findSnap([drag.x + drag.w + dx], drag.linesX, drag.threshold);
    const sy = findSnap([drag.y + drag.h + dy], drag.linesY, drag.threshold);
    w = clamp(drag.w + dx + (sx ? sx.diff : 0), MIN_W, 100 - drag.x);
    h = clamp(drag.h + dy + (sy ? sy.diff : 0), MIN_H, 100 - drag.y);
    setGuide(drag.guideV, 'left', sx ? sx.line : null);
    setGuide(drag.guideH, 'top', sy ? sy.line : null);
  }
  el.style.left = round2(x) + '%';
  el.style.top = round2(y) + '%';
  el.style.width = round2(w) + '%';
  el.style.height = round2(h) + '%';
}

function finishCardDrag() {
  if (!drag) return;
  const { el } = drag;
  const layout = {
    x: round2(parseFloat(el.style.left) || 0),
    y: round2(parseFloat(el.style.top) || 0),
    w: round2(parseFloat(el.style.width) || MIN_W),
    h: round2(parseFloat(el.style.height) || MIN_H),
  };
  const isMember = drag.type === 'member';
  const kind = drag.kind;
  const id = drag.id;
  const personId = drag.personId;

  if (drag.guideV) drag.guideV.remove();
  if (drag.guideH) drag.guideH.remove();
  el.classList.remove('dragging');
  drag = null;
  interacting = false;
  unlistenParentPointerUp();
  const op = isMember
    ? conn.sendOp('setMemberLayout', { projectId: currentProjectId, personId, layout })
    : conn.sendOp('setLayout', { projectId: currentProjectId, kind, id, layout });
  op.catch(() => {});
  if (pendingState) {
    currentState = pendingState;
    pendingState = null;
    renderState();
  }
}

function onPointerUp() {
  finishCardDrag();
}

// 在 iframe 预览里拖拽时，如果指针离开 iframe 松手，pointerup 不会回到本页，
// 这里同时在父文档上监听，并在失焦/离开页面时强制结束，避免拖拽状态卡死。
let parentDoc = null;
function listenParentPointerUp() {
  if (parentDoc || window.parent === window) return;
  try {
    parentDoc = window.parent.document;
    parentDoc.addEventListener('pointerup', endAllDrags, true);
    parentDoc.addEventListener('pointercancel', endAllDrags, true);
  } catch (_) {
    parentDoc = null;
  }
}
function unlistenParentPointerUp() {
  if (!parentDoc) return;
  try {
    parentDoc.removeEventListener('pointerup', endAllDrags, true);
    parentDoc.removeEventListener('pointercancel', endAllDrags, true);
  } catch (_) {}
  parentDoc = null;
}
function endAllDrags() {
  finishTitleDrag();
  finishCardDrag();
  unlistenParentPointerUp();
}

// ---------- 项目选择 ----------
function pickProject() {
  if (!currentState || !currentState.projects) return null;
  const projects = currentState.projects;
  if (currentProjectId && projects[currentProjectId]) return projects[currentProjectId];
  const first = Object.values(projects).sort((a, b) => a.createdAt - b.createdAt)[0] || null;
  if (first) currentProjectId = first.id;
  return first;
}

let renderedProjectId = null;

function renderState() {
  const project = pickProject();
  if (!project) return;
  if (project.id !== renderedProjectId) {
    prevScores = {}; // 切项目时重置分数变化检测
    renderedProjectId = project.id;
  }
  render(project);
}

// ---------- 标题自由拖动（编辑模式 + 标题自由位置） ----------
let titleDrag = null;

function onTitlePointerDown(e) {
  if (!currentSettings || !currentSettings.titleFree) return;
  // 真实显示端只在 ?edit=1 时可调；管理端预览 iframe 里可直接拖标题
  if (!isEdit && !inPreviewFrame) return;
  const header = e.target.closest('.topbar');
  if (!header) return;
  if (e.target.closest('a, button, input, select')) return;
  e.preventDefault();
  const rect = header.getBoundingClientRect();
  titleDrag = {
    header,
    dx: e.clientX - (rect.left + rect.width / 2),
    dy: e.clientY - (rect.top + rect.height / 2),
  };
  interacting = true;
  header.classList.add('dragging');
  try { header.setPointerCapture(e.pointerId); } catch (_) {}
  listenParentPointerUp();
}

function onTitlePointerMove(e) {
  if (!titleDrag) return;
  e.preventDefault();
  const x = clamp(((e.clientX - titleDrag.dx) / window.innerWidth) * 100, 2, 98);
  const y = clamp(((e.clientY - titleDrag.dy) / window.innerHeight) * 100, 2, 98);
  document.documentElement.style.setProperty('--title-x', round2(x) + '%');
  document.documentElement.style.setProperty('--title-y', round2(y) + '%');
}

function finishTitleDrag() {
  if (!titleDrag) return;
  const x = round2(parseFloat(document.documentElement.style.getPropertyValue('--title-x')) || 50);
  const y = round2(parseFloat(document.documentElement.style.getPropertyValue('--title-y')) || 8);
  titleDrag.header.classList.remove('dragging');
  titleDrag = null;
  interacting = false;
  unlistenParentPointerUp();
  conn.sendOp('updateSettings', {
    projectId: currentProjectId,
    patch: { titleX: x, titleY: y },
  }).catch(() => {});
  if (pendingState) {
    currentState = pendingState;
    pendingState = null;
    renderState();
  }
}

function onTitlePointerUp() {
  finishTitleDrag();
}

window.addEventListener('pointerdown', onPointerDown);
window.addEventListener('pointermove', onPointerMove);
window.addEventListener('pointerup', onPointerUp);
window.addEventListener('pointercancel', onPointerUp);
window.addEventListener('pointerdown', onTitlePointerDown);
window.addEventListener('pointermove', onTitlePointerMove);
window.addEventListener('pointerup', onTitlePointerUp);
window.addEventListener('pointercancel', onTitlePointerUp);

// 安全兜底：失焦/离开预览 iframe/页面隐藏时结束拖拽，避免状态卡死
window.addEventListener('blur', endAllDrags);
document.addEventListener('pointerleave', endAllDrags);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) endAllDrags();
});

const conn = connectWS(
  (state, runtime) => {
    currentState = state;
    currentRuntime = runtime;
    runtimeReceivedAt = Date.now();
    if (interacting) { pendingState = state; return; }
    renderState();
    applyRuntimeUI();
  },
  (status) => {
    connDot.classList.toggle('connecting', status !== 'connected');
    connDot.title = status === 'connected' ? '已连接' : '连接中…';
  }
);
