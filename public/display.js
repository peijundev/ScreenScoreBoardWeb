'use strict';
/* global avatarURL, connectWS, escapeHTML */
/* 显示端：全量状态驱动渲染；?edit=1 时可在自由布局下拖动/缩放卡片 */

let prevScores = {};   // personId -> 上次分数
let pendingState = null;
let interacting = false;
let drag = null;
let currentSettings = null;
let currentState = null;
let currentProjectId = new URLSearchParams(location.search).get('project') || null;

const isEdit = new URLSearchParams(location.search).get('edit') === '1';
if (isEdit) document.body.classList.add('edit-mode');

const board = document.getElementById('board');
const emptyTip = document.getElementById('empty-tip');
const titleEl = document.getElementById('board-title');
const connDot = document.getElementById('conn-dot');

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

function applyAppearance(settings) {
  document.body.dataset.theme = settings.theme;
  document.body.dataset.density = settings.density;
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

  if (settings.cardBg) document.body.style.setProperty('--card', settings.cardBg);
  else document.body.style.removeProperty('--card');

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
  const metaFor = (it, i) => {
    const value = itemScore(it);
    return {
      rank: ranked ? i + 1 : null,
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

  emptyTip.classList.toggle('hidden', items.length > 0);
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

function onPointerUp() {
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

window.addEventListener('pointerdown', onPointerDown);
window.addEventListener('pointermove', onPointerMove);
window.addEventListener('pointerup', onPointerUp);
window.addEventListener('pointercancel', onPointerUp);

const conn = connectWS(
  (state) => {
    currentState = state;
    if (interacting) { pendingState = state; return; }
    renderState();
  },
  (status) => {
    connDot.classList.toggle('connecting', status !== 'connected');
    connDot.title = status === 'connected' ? '已连接' : '连接中…';
  }
);
