'use strict';
/* global avatarURL, connectWS, uploadAvatar, uploadSound, escapeHTML */
/* 管理端：所有操作经 WS op，渲染由广播驱动（不做乐观更新） */

let currentState = null;
let currentRuntime = null;
let currentProjectId = new URLSearchParams(location.search).get('project') || null;
const connDot = document.getElementById('conn-dot');
const toastEl = document.getElementById('toast');
const projectSelect = document.getElementById('project-select');
const projectAddBtn = document.getElementById('project-add');
const projectRenameBtn = document.getElementById('project-rename');
const projectDeleteBtn = document.getElementById('project-delete');
const previewFrame = document.getElementById('display-preview');
const previewWrap = document.getElementById('preview-wrap');
const previewStage = document.getElementById('preview-stage');
const previewResolution = document.getElementById('preview-resolution');
const settingsDialog = document.getElementById('settings-dialog');
const settingsOpenBtn = document.getElementById('settings-open');
const settingsCloseBtn = document.getElementById('settings-close');
const featuresDialog = document.getElementById('features-dialog');
const featuresOpenBtn = document.getElementById('features-open');
const featuresCloseBtn = document.getElementById('features-close');
const previewOutBtn = document.getElementById('preview-out');
const previewInBtn = document.getElementById('preview-in');
const previewResetBtn = document.getElementById('preview-reset');
const previewZoomLabel = document.getElementById('preview-zoom-label');
const quick = {
  style: document.getElementById('quick-style'),
  theme: document.getElementById('quick-theme'),
  columns: document.getElementById('quick-columns'),
  columnsVal: document.getElementById('quick-columns-val'),
  density: document.getElementById('quick-density'),
  sort: document.getElementById('quick-sort'),
  accent: document.getElementById('quick-accent'),
  edit: document.getElementById('quick-edit'),
  view: document.getElementById('quick-view'),
};

let previewEdit = false;
let previewZoom = 1;
let previewResolutionMode = '1920x1080';   // auto | custom | WxH
let previewCustomW = 3840;
let previewCustomH = 2160;
try {
  previewResolutionMode = localStorage.getItem('previewResolution') || '1920x1080';
  previewCustomW = Number(localStorage.getItem('previewCustomW')) || 3840;
  previewCustomH = Number(localStorage.getItem('previewCustomH')) || 2160;
  previewZoom = Number(localStorage.getItem('previewZoom')) || 1;
} catch (_) {}
previewResolution.value = previewResolutionMode;
const previewCustomSizeEl = document.getElementById('preview-custom-size');
const previewCustomWEl = document.getElementById('preview-custom-w');
const previewCustomHEl = document.getElementById('preview-custom-h');
const previewCustomApplyBtn = document.getElementById('preview-custom-apply');
let toastTimer = null;

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 2600);
}

const conn = connectWS(
  (state, runtime) => {
    currentState = state;
    currentRuntime = runtime;
    const project = currentProject();
    if (!project) return;
    syncProjectUI(state);
    render(project);
    applyRuntimeUI();
  },
  (status) => {
    connDot.classList.toggle('connecting', status !== 'connected');
    connDot.title = status === 'connected' ? '已连接' : '连接中…';
  }
);

function currentProject() {
  if (!currentState || !currentState.projects) return null;
  const projects = currentState.projects;
  if (currentProjectId && projects[currentProjectId]) return projects[currentProjectId];
  const first = Object.values(projects).sort((a, b) => a.createdAt - b.createdAt)[0] || null;
  if (first) currentProjectId = first.id;
  return first;
}

// 项目级 op：自动带上当前项目 id
function projectOp(op, payload) {
  return conn.sendOp(op, Object.assign({ projectId: currentProjectId }, payload || {}));
}

function doOp(op, payload) {
  projectOp(op, payload).catch((e) => toast(e.message));
}

// 手动调序：首次使用时会自动切到「自定义顺序」，给出一次提示
function moveOp(kind, id, direction) {
  const project = currentProject();
  const wasManual = Boolean(project && project.settings.sortBy === 'manual');
  const op = kind === 'person' ? 'movePerson' : 'moveTeam';
  const payload = kind === 'person'
    ? { personId: id, direction }
    : { teamId: id, direction };
  projectOp(op, payload).then(() => {
    if (!wasManual) toast('已切换为自定义顺序');
  }).catch((e) => toast(e.message));
}

function syncProjectUI(state) {
  const projects = Object.values(state.projects).sort((a, b) => a.createdAt - b.createdAt);
  projectSelect.innerHTML = projects.map((p) =>
    '<option value="' + p.id + '"' + (p.id === currentProjectId ? ' selected' : '') + '>' +
    escapeHTML(p.name) + '</option>'
  ).join('');
  const displayLink = document.querySelector('.open-display');
  displayLink.href = '/display?project=' + encodeURIComponent(currentProjectId);
  const previewSrc = '/display?project=' + encodeURIComponent(currentProjectId) +
    (previewEdit ? '&edit=1' : '');
  if (previewFrame.getAttribute('src') !== previewSrc) previewFrame.src = previewSrc;
  // 地址栏同步当前项目，便于刷新/分享
  const url = new URL(location.href);
  if (url.searchParams.get('project') !== currentProjectId) {
    url.searchParams.set('project', currentProjectId);
    history.replaceState(null, '', url);
  }
}

function selectProject(id) {
  currentProjectId = id;
  const project = currentProject();
  if (!project) return;
  syncProjectUI(currentState);
  render(project);
  applyRuntimeUI();
}

projectSelect.addEventListener('change', () => selectProject(projectSelect.value));

projectAddBtn.addEventListener('click', async () => {
  const name = prompt('新项目名称（每个项目是一个独立积分榜）', '新项目');
  if (!name || !name.trim()) return;
  try {
    const res = await conn.sendOp('addProject', { name: name.trim() });
    selectProject(res.projectId);
  } catch (e) { toast(e.message); }
});

projectRenameBtn.addEventListener('click', async () => {
  const project = currentProject();
  if (!project) return;
  const name = prompt('项目名称', project.name);
  if (!name || !name.trim()) return;
  try {
    await conn.sendOp('renameProject', { projectId: currentProjectId, name: name.trim() });
  } catch (e) { toast(e.message); }
});

projectDeleteBtn.addEventListener('click', async () => {
  const project = currentProject();
  if (!project) return;
  if (!confirm('确定删除项目「' + project.name + '」？该项目的人员、团队、分数都会删除，且不可恢复。')) return;
  try {
    await conn.sendOp('deleteProject', { projectId: currentProjectId });
    selectProject(null);
  } catch (e) { toast(e.message); }
});

// ============ 排版设置窗口：非模态、可拖动 ============
function clampNum(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function placeSettingsDialog() {
  let left = null;
  let top = null;
  try {
    const saved = JSON.parse(localStorage.getItem('settingsDialogPos') || 'null');
    if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
      left = saved.left;
      top = saved.top;
    }
  } catch (_) {}

  const rect = settingsDialog.getBoundingClientRect();
  if (left == null) left = (window.innerWidth - rect.width) / 2;
  if (top == null) top = Math.max(16, Math.min(80, window.innerHeight * 0.08));

  left = clampNum(left, 4, Math.max(4, window.innerWidth - rect.width - 4));
  top = clampNum(top, 4, Math.max(4, window.innerHeight - 44));
  settingsDialog.style.left = left + 'px';
  settingsDialog.style.top = top + 'px';
}

settingsOpenBtn.addEventListener('click', () => {
  if (settingsDialog.open) {
    settingsDialog.close();
    return;
  }
  settingsDialog.show(); // 非模态：不挡预览，可以边看边调
  applySettingsDialogSize();
  placeSettingsDialog();
});
settingsCloseBtn.addEventListener('click', () => settingsDialog.close());

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (settingsDialog.open) settingsDialog.close();
    if (featuresDialog.open) featuresDialog.close();
  }
});

// 拖标题栏移动窗口
const dialogHeader = settingsDialog.querySelector('.dialog-header');
let dialogDrag = null;

dialogHeader.addEventListener('pointerdown', (e) => {
  if (e.target.closest('button')) return;
  e.preventDefault();
  const rect = settingsDialog.getBoundingClientRect();
  dialogDrag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
  dialogHeader.setPointerCapture(e.pointerId);
  settingsDialog.classList.add('dragging');
});

dialogHeader.addEventListener('pointermove', (e) => {
  if (!dialogDrag) return;
  // 不强制边界：窗口可以拖到屏幕外，方便把预览让出来
  settingsDialog.style.left = (e.clientX - dialogDrag.dx) + 'px';
  settingsDialog.style.top = (e.clientY - dialogDrag.dy) + 'px';
});

function endDialogDrag() {
  if (!dialogDrag) return;
  dialogDrag = null;
  settingsDialog.classList.remove('dragging');
  try {
    localStorage.setItem('settingsDialogPos', JSON.stringify({
      left: parseFloat(settingsDialog.style.left) || 0,
      top: parseFloat(settingsDialog.style.top) || 0,
    }));
  } catch (_) {}
}
dialogHeader.addEventListener('pointerup', endDialogDrag);
dialogHeader.addEventListener('pointercancel', endDialogDrag);

// ============ 功能窗口：非模态、可拖动、可缩放 ============
function placeFeaturesDialog() {
  let left = null;
  let top = null;
  try {
    const saved = JSON.parse(localStorage.getItem('featuresDialogPos') || 'null');
    if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
      left = saved.left;
      top = saved.top;
    }
  } catch (_) {}

  const rect = featuresDialog.getBoundingClientRect();
  if (left == null) left = (window.innerWidth - rect.width) / 2;
  if (top == null) top = Math.max(16, Math.min(80, window.innerHeight * 0.08));
  left = clampNum(left, 4, Math.max(4, window.innerWidth - rect.width - 4));
  top = clampNum(top, 4, Math.max(4, window.innerHeight - 44));
  featuresDialog.style.left = left + 'px';
  featuresDialog.style.top = top + 'px';
}

function applyFeaturesDialogSize() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('featuresDialogSize') || 'null'); } catch (_) {}
  const maxW = Math.max(480, window.innerWidth * 0.96);
  const maxH = Math.max(260, window.innerHeight * 0.92);
  let w = saved && Number.isFinite(saved.w) ? saved.w : 900;
  const h = saved && Number.isFinite(saved.h) ? saved.h : 0;
  w = Math.min(Math.max(480, w), maxW);
  if (h > 0) {
    featuresDialog.style.height = Math.min(Math.max(260, h), maxH) + 'px';
  }
  featuresDialog.style.width = w + 'px';
}

featuresOpenBtn.addEventListener('click', () => {
  if (featuresDialog.open) {
    featuresDialog.close();
    return;
  }
  featuresDialog.show();
  applyFeaturesDialogSize();
  placeFeaturesDialog();
});
featuresCloseBtn.addEventListener('click', () => featuresDialog.close());

const featuresHeader = featuresDialog.querySelector('.dialog-header');
let featuresDrag = null;
featuresHeader.addEventListener('pointerdown', (e) => {
  if (e.target.closest('button')) return;
  e.preventDefault();
  const rect = featuresDialog.getBoundingClientRect();
  featuresDrag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
  featuresHeader.setPointerCapture(e.pointerId);
  featuresDialog.classList.add('dragging');
});
featuresHeader.addEventListener('pointermove', (e) => {
  if (!featuresDrag) return;
  // 不强制边界
  featuresDialog.style.left = (e.clientX - featuresDrag.dx) + 'px';
  featuresDialog.style.top = (e.clientY - featuresDrag.dy) + 'px';
});
function endFeaturesDrag() {
  if (!featuresDrag) return;
  featuresDrag = null;
  featuresDialog.classList.remove('dragging');
  try {
    localStorage.setItem('featuresDialogPos', JSON.stringify({
      left: parseFloat(featuresDialog.style.left) || 0,
      top: parseFloat(featuresDialog.style.top) || 0,
    }));
  } catch (_) {}
}
featuresHeader.addEventListener('pointerup', endFeaturesDrag);
featuresHeader.addEventListener('pointercancel', endFeaturesDrag);

const featuresResize = document.getElementById('features-resize');
let featuresResizeDrag = null;
featuresResize.addEventListener('pointerdown', (e) => {
  const project = currentProject();
  if (!project || !project.settings.featureSettingsResize) return;
  e.preventDefault();
  const rect = featuresDialog.getBoundingClientRect();
  featuresResizeDrag = { startX: e.clientX, startY: e.clientY, w: rect.width, h: rect.height };
  featuresResize.setPointerCapture(e.pointerId);
});
window.addEventListener('pointermove', (e) => {
  if (!featuresResizeDrag) return;
  const maxW = Math.max(480, window.innerWidth * 0.96);
  const maxH = Math.max(260, window.innerHeight * 0.92);
  const w = Math.min(Math.max(480, featuresResizeDrag.w + (e.clientX - featuresResizeDrag.startX)), maxW);
  const h = Math.min(Math.max(260, featuresResizeDrag.h + (e.clientY - featuresResizeDrag.startY)), maxH);
  featuresDialog.style.width = w + 'px';
  featuresDialog.style.height = h + 'px';
});
window.addEventListener('pointerup', () => {
  if (!featuresResizeDrag) return;
  featuresResizeDrag = null;
  try {
    localStorage.setItem('featuresDialogSize', JSON.stringify({
      w: featuresDialog.offsetWidth,
      h: featuresDialog.offsetHeight,
    }));
  } catch (_) {}
});

// ============ 预览：固定分辨率复刻 + 缩放 ============
function currentPreviewSize() {
  if (previewResolutionMode === 'custom') {
    return { w: Math.max(320, Math.min(15360, previewCustomW)), h: Math.max(240, Math.min(8640, previewCustomH)) };
  }
  const [w, h] = previewResolutionMode.split('x').map(Number);
  return { w, h };
}

function applyPreviewLayout() {
  previewZoom = Math.min(3, Math.max(0.25, Math.round(previewZoom * 100) / 100));
  previewZoomLabel.textContent = Math.round(previewZoom * 100) + '%';
  try { localStorage.setItem('previewZoom', String(previewZoom)); } catch (_) {}
  previewCustomSizeEl.classList.toggle('hidden', previewResolutionMode !== 'custom');

  if (previewResolutionMode === 'auto') {
    previewStage.style.width = '100%';
    previewStage.style.height = '100%';
    previewFrame.style.width = '100%';
    previewFrame.style.height = '100%';
    previewFrame.style.transform = '';
    previewFrame.style.zoom = String(previewZoom);
    return;
  }

  const { w, h } = currentPreviewSize();
  if (!w || !h) return;
  const fit = Math.min(previewWrap.clientWidth / w, previewWrap.clientHeight / h) * previewZoom;
  previewStage.style.width = w * fit + 'px';
  previewStage.style.height = h * fit + 'px';
  previewFrame.style.zoom = '';
  previewFrame.style.width = w + 'px';
  previewFrame.style.height = h + 'px';
  previewFrame.style.transform = 'scale(' + fit + ')';
  previewFrame.style.transformOrigin = 'top left';
}

previewOutBtn.addEventListener('click', () => { previewZoom -= 0.1; applyPreviewLayout(); });
previewInBtn.addEventListener('click', () => { previewZoom += 0.1; applyPreviewLayout(); });
previewResetBtn.addEventListener('click', () => { previewZoom = 1; applyPreviewLayout(); });
previewResolution.addEventListener('change', () => {
  previewResolutionMode = previewResolution.value;
  if (previewResolutionMode === 'custom') {
    previewCustomWEl.value = String(previewCustomW);
    previewCustomHEl.value = String(previewCustomH);
  }
  try { localStorage.setItem('previewResolution', previewResolutionMode); } catch (_) {}
  applyPreviewLayout();
});
previewCustomApplyBtn.addEventListener('click', () => {
  const w = Math.max(320, Math.min(15360, Math.round(Number(previewCustomWEl.value) || previewCustomW)));
  const h = Math.max(240, Math.min(8640, Math.round(Number(previewCustomHEl.value) || previewCustomH)));
  previewCustomW = w; previewCustomH = h;
  previewCustomWEl.value = String(w); previewCustomHEl.value = String(h);
  try {
    localStorage.setItem('previewCustomW', String(w));
    localStorage.setItem('previewCustomH', String(h));
  } catch (_) {}
  applyPreviewLayout();
});

// 按住 Alt 拖动可平移预览超出的部分（不受边界限制）
let previewPan = null;
document.addEventListener('keydown', (e) => {
  if (e.key === 'Alt') previewWrap.classList.add('pan-ready');
});
document.addEventListener('keyup', (e) => {
  if (e.key === 'Alt') previewWrap.classList.remove('pan-ready');
});
window.addEventListener('blur', () => previewWrap.classList.remove('pan-ready'));
previewWrap.addEventListener('pointerdown', (e) => {
  if (!previewWrap.classList.contains('pan-ready')) return;
  e.preventDefault();
  previewPan = {
    x: e.clientX, y: e.clientY,
    sl: previewWrap.scrollLeft, st: previewWrap.scrollTop,
  };
  previewWrap.setPointerCapture(e.pointerId);
  previewWrap.classList.add('panning');
});
previewWrap.addEventListener('pointermove', (e) => {
  if (!previewPan) return;
  previewWrap.scrollLeft = previewPan.sl - (e.clientX - previewPan.x);
  previewWrap.scrollTop = previewPan.st - (e.clientY - previewPan.y);
});
function endPreviewPan() {
  if (!previewPan) return;
  previewPan = null;
  previewWrap.classList.remove('panning');
}
previewWrap.addEventListener('pointerup', endPreviewPan);
previewWrap.addEventListener('pointercancel', endPreviewPan);
let previewLayoutTimer = null;
function schedulePreviewLayout() {
  clearTimeout(previewLayoutTimer);
  previewLayoutTimer = setTimeout(applyPreviewLayout, 60);
}
window.addEventListener('resize', schedulePreviewLayout);
if (window.ResizeObserver) {
  new ResizeObserver(schedulePreviewLayout).observe(previewWrap);
}

// ============ 预览旁：常用排版快速调节 ============
quick.style.addEventListener('change', () => pushSetting('displayStyle', quick.style.value, true));
quick.theme.addEventListener('change', () => pushSetting('theme', quick.theme.value, true));
quick.density.addEventListener('change', () => pushSetting('density', quick.density.value, true));
quick.columns.addEventListener('input', () => {
  quick.columnsVal.textContent = quick.columns.value;
  pushSetting('columns', Number(quick.columns.value));
});
quick.accent.addEventListener('input', () => pushSetting('accent', quick.accent.value));
quick.sort.addEventListener('change', () => {
  const map = {
    score_desc: ['score', 'desc'],
    score_asc: ['score', 'asc'],
    created_asc: ['created', 'asc'],
    created_desc: ['created', 'desc'],
    manual_asc: ['manual', 'asc'],
  };
  const [sortBy, sortOrder] = map[quick.sort.value] || ['score', 'desc'];
  projectOp('updateSettings', { patch: { sortBy, sortOrder } }).catch((e) => toast(e.message));
});
quick.edit.addEventListener('change', () => {
  previewEdit = quick.edit.checked;
  if (currentState) syncProjectUI(currentState);
});
quick.view.addEventListener('change', () => {
  const v = quick.view.value;
  const patch = {};
  if (v === 'leaderboard') { patch.displayView = 'leaderboard'; patch.featureLeaderboard = true; }
  else if (v === 'welcome') { patch.displayView = 'welcome'; patch.featureWelcome = true; }
  else patch.displayView = 'cards';
  projectOp('updateSettings', { patch }).catch((e) => toast(e.message));
});

applyPreviewLayout();

// ============ 人员面板 ============
const personNameInput = document.getElementById('person-name');
const personAvatarInput = document.getElementById('person-avatar');
const personAvatarPreview = document.getElementById('person-avatar-preview');
const teamNameInput = document.getElementById('team-name');
const teamAvatarInput = document.getElementById('team-avatar');
const teamAvatarPreview = document.getElementById('team-avatar-preview');

function bindAvatarPreview(fileInput, previewImg, nameInput) {
  fileInput.addEventListener('change', () => {
    const f = fileInput.files[0];
    previewImg.src = f ? URL.createObjectURL(f) : avatarURL({ name: nameInput.value || '?' });
  });
  nameInput.addEventListener('input', () => {
    if (!fileInput.files[0]) previewImg.src = avatarURL({ name: nameInput.value || '?' });
  });
  previewImg.src = avatarURL({ name: '?' });
}
bindAvatarPreview(personAvatarInput, personAvatarPreview, personNameInput);
bindAvatarPreview(teamAvatarInput, teamAvatarPreview, teamNameInput);

document.getElementById('add-person-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = personNameInput.value.trim();
  if (!name) return;
  try {
    let avatar = null;
    if (personAvatarInput.files[0]) avatar = await uploadAvatar(personAvatarInput.files[0]);
    await projectOp('addPerson', { name, avatar });
    personNameInput.value = '';
    personAvatarInput.value = '';
    personAvatarPreview.src = avatarURL({ name: '?' });
  } catch (err) { toast(err.message); }
});

document.getElementById('add-team-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = teamNameInput.value.trim();
  if (!name) return;
  try {
    let avatar = null;
    if (teamAvatarInput.files[0]) avatar = await uploadAvatar(teamAvatarInput.files[0]);
    await projectOp('addTeam', { name, avatar });
    teamNameInput.value = '';
    teamAvatarInput.value = '';
    teamAvatarPreview.src = avatarURL({ name: '?' });
  } catch (err) { toast(err.message); }
});

function scoreClass(n) {
  return n > 0 ? 'score-pos' : n < 0 ? 'score-neg' : 'score-zero';
}

function renderPeople(project) {
  const list = document.getElementById('people-list');
  const allPeople = Object.values(project.people).sort((a, b) => a.order - b.order);
  const q = peopleQuery.trim().toLowerCase();
  const people = q ? allPeople.filter((p) => {
    const team = p.teamId ? project.teams[p.teamId] : null;
    return p.name.toLowerCase().includes(q) ||
      (team && team.name.toLowerCase().includes(q));
  }) : allPeople;

  if (classEls.peopleCount) {
    classEls.peopleCount.textContent = q
      ? people.length + ' / ' + allPeople.length + ' 人'
      : allPeople.length + ' 人';
  }

  if (!allPeople.length) {
    list.innerHTML = '<p style="color:var(--text-dim);font-size:13px">暂无人员，先添加一个吧</p>';
    return;
  }
  if (!people.length) {
    list.innerHTML = '<p style="color:var(--text-dim);font-size:13px">没有匹配的人员</p>';
    return;
  }

  list.innerHTML = people.map((p) => {
    const index = allPeople.indexOf(p);
    const canUp = index > 0;
    const canDown = index < allPeople.length - 1;
    const teamOptions = '<option value="">无团队</option>' + Object.values(project.teams)
      .sort((a, b) => a.order - b.order).map((t) =>
      '<option value="' + t.id + '"' + (p.teamId === t.id ? ' selected' : '') + '>' + escapeHTML(t.name) + '</option>'
    ).join('');
    const presets = Array.isArray(project.settings.quickScorePresets)
      ? project.settings.quickScorePresets : [1, 5, 10, -1];
    const quickScores = project.settings.featureQuickScore
      ? '<span class="quick-scores">' + presets.map((v) =>
        '<button class="btn small quick-score" data-delta="' + v + '">' + (v > 0 ? '+' : '') + v + '</button>'
      ).join('') + '</span>'
      : '';
    const avatarEdit = project.settings.featureAvatarEdit
      ? '<label class="btn small file-mini" title="更换头像">头像' +
        '<input type="file" class="avatar-change-input" accept="image/png,image/jpeg,image/webp,image/gif" hidden></label>' +
        (p.avatar ? '<button class="btn small avatar-clear">默认</button>' : '')
      : '';
    return (
      '<div class="person-row" data-id="' + p.id + '">' +
        '<span class="move-btns">' +
          '<button class="btn small move-up" title="上移"' + (canUp ? '' : ' disabled') + '>↑</button>' +
          '<button class="btn small move-down" title="下移"' + (canDown ? '' : ' disabled') + '>↓</button>' +
        '</span>' +
        '<img src="' + avatarURL(p, 48) + '" alt="">' +
        avatarEdit +
        '<span class="p-name editable" title="点击改名">' + escapeHTML(p.name) + '</span>' +
        '<span class="p-score ' + scoreClass(p.score) + '">' + p.score + '</span>' +
        quickScores +
        '<span class="score-ctl">' +
          '<input type="number" class="delta-input" value="1" step="1">' +
          '<button class="btn small score-plus">+分</button>' +
          '<button class="btn small score-minus">−分</button>' +
        '</span>' +
        '<select class="team-select">' + teamOptions + '</select>' +
        '<label class="btn small file-mini" title="卡片背景图（也用于团队内小卡片）">卡面<input type="file" class="card-img-input" accept="image/png,image/jpeg,image/webp,image/gif" hidden></label>' +
        (p.cardImage ? '<button class="btn small card-img-clear">清卡面</button>' : '') +
        '<button class="btn small danger person-del">删除</button>' +
      '</div>'
    );
  }).join('');

  list.querySelectorAll('.person-row').forEach((row) => {
    const id = row.dataset.id;
    const deltaInput = row.querySelector('.delta-input');
    const delta = () => {
      const n = Math.round(Number(deltaInput.value));
      return Number.isFinite(n) && n !== 0 ? Math.max(-10000, Math.min(10000, n)) : null;
    };
    row.querySelector('.score-plus').addEventListener('click', () => {
      const d = delta();
      if (d != null) doOp('addScore', { personId: id, delta: d });
    });
    row.querySelector('.score-minus').addEventListener('click', () => {
      const d = delta();
      if (d != null) doOp('addScore', { personId: id, delta: -d });
    });
    row.querySelectorAll('.quick-score').forEach((btn) => {
      btn.addEventListener('click', () => {
        doOp('addScore', { personId: id, delta: Number(btn.dataset.delta) });
      });
    });
    const avatarInput = row.querySelector('.avatar-change-input');
    if (avatarInput) {
      avatarInput.addEventListener('change', async () => {
        const f = avatarInput.files[0];
        if (!f) return;
        try {
          const path = await uploadAvatar(f);
          await projectOp('setAvatar', { kind: 'person', id, avatar: path });
        } catch (e) { toast(e.message); }
        avatarInput.value = '';
      });
    }
    const avatarClear = row.querySelector('.avatar-clear');
    if (avatarClear) {
      avatarClear.addEventListener('click', () => {
        projectOp('setAvatar', { kind: 'person', id, avatar: null }).catch((e) => toast(e.message));
      });
    }
    row.querySelector('.team-select').addEventListener('change', (e) => {
      doOp('assignTeam', { personId: id, teamId: e.target.value || null });
    });
    const cardImgInput = row.querySelector('.card-img-input');
    cardImgInput.addEventListener('change', async () => {
      const f = cardImgInput.files[0];
      if (!f) return;
      try {
        const path = await uploadAvatar(f);
        await projectOp('setCardImage', { kind: 'person', id, image: path });
      } catch (e) { toast(e.message); }
      cardImgInput.value = '';
    });
    const cardImgClear = row.querySelector('.card-img-clear');
    if (cardImgClear) {
      cardImgClear.addEventListener('click', () => {
        projectOp('setCardImage', { kind: 'person', id, image: null }).catch((e) => toast(e.message));
      });
    }
    row.querySelector('.move-up').addEventListener('click', () => moveOp('person', id, 'up'));
    row.querySelector('.move-down').addEventListener('click', () => moveOp('person', id, 'down'));
    row.querySelector('.p-name').addEventListener('click', () => {
      const p = currentProject().people[id];
      if (!p) return;
      const name = prompt('修改姓名（最多 20 字）', p.name);
      if (name == null) return;
      const value = name.trim();
      if (!value || value === p.name) return;
      projectOp('renamePerson', { personId: id, name: value }).catch((e) => toast(e.message));
    });
    row.querySelector('.person-del').addEventListener('click', () => {
      const p = currentProject().people[id];
      if (p && confirm('确定删除「' + p.name + '」？')) doOp('removePerson', { personId: id });
    });
  });
}

// ============ 团队面板 ============
function renderTeams(project) {
  const list = document.getElementById('teams-list');
  const allTeams = Object.values(project.teams).sort((a, b) => a.order - b.order);
  const q = teamsQuery.trim().toLowerCase();
  const teams = q ? allTeams.filter((t) => t.name.toLowerCase().includes(q)) : allTeams;

  if (!allTeams.length) {
    list.innerHTML = '<p style="color:var(--text-dim);font-size:13px">暂无团队</p>';
    return;
  }
  if (!teams.length) {
    list.innerHTML = '<p style="color:var(--text-dim);font-size:13px">没有匹配的团队</p>';
    return;
  }

  list.innerHTML = teams.map((t) => {
    const index = allTeams.indexOf(t);
    const canUp = index > 0;
    const canDown = index < allTeams.length - 1;
    const members = Object.values(project.people)
      .filter((p) => p.teamId === t.id)
      .sort((a, b) => a.order - b.order);
    const total = members.reduce((s, m) => s + m.score, 0);
    const chips = members.map((m) =>
      '<span class="chip"><img src="' + avatarURL(m, 24) + '" alt="">' +
      escapeHTML(m.name) +
      '<span class="x" data-person="' + m.id + '" title="移出团队">×</span></span>'
    ).join('') || '<span style="color:var(--text-dim);font-size:13px">暂无成员（在人员列表中选择团队加入）</span>';
    const presets = Array.isArray(project.settings.quickScorePresets)
      ? project.settings.quickScorePresets : [1, 5, 10, -1];
    const quickScores = project.settings.featureTeamScore
      ? '<span class="quick-scores">' + presets.map((v) =>
        '<button class="btn small team-quick" data-delta="' + v +
        '" title="每位成员 ' + (v > 0 ? '+' : '') + v + '">' +
        (v > 0 ? '+' : '') + v + '</button>'
      ).join('') + '</span>'
      : '';
    const avatarEdit = project.settings.featureAvatarEdit
      ? '<label class="btn small file-mini" title="更换团队头像">头像' +
        '<input type="file" class="avatar-change-input" accept="image/png,image/jpeg,image/webp,image/gif" hidden></label>' +
        (t.avatar ? '<button class="btn small avatar-clear">默认</button>' : '')
      : '';
    return (
      '<div class="team-block" data-id="' + t.id + '">' +
        '<div class="team-top">' +
          '<span class="move-btns">' +
            '<button class="btn small move-up" title="上移"' + (canUp ? '' : ' disabled') + '>↑</button>' +
            '<button class="btn small move-down" title="下移"' + (canDown ? '' : ' disabled') + '>↓</button>' +
          '</span>' +
          '<img src="' + avatarURL(t, 48) + '" alt="">' +
          avatarEdit +
          '<span class="t-name editable" title="点击改名">' + escapeHTML(t.name) + '</span>' +
          '<span class="t-total">' + total + ' 分</span>' +
          quickScores +
          '<label class="btn small file-mini" title="团队卡片背景图">卡面<input type="file" class="card-img-input" accept="image/png,image/jpeg,image/webp,image/gif" hidden></label>' +
          (t.cardImage ? '<button class="btn small card-img-clear">清卡面</button>' : '') +
          '<button class="btn small danger team-del">删除团队</button>' +
        '</div>' +
        '<div class="chips">' + chips + '</div>' +
      '</div>'
    );
  }).join('');

  list.querySelectorAll('.team-block').forEach((block) => {
    const id = block.dataset.id;
    block.querySelector('.move-up').addEventListener('click', () => moveOp('team', id, 'up'));
    block.querySelector('.move-down').addEventListener('click', () => moveOp('team', id, 'down'));
    block.querySelector('.t-name').addEventListener('click', () => {
      const t = currentProject().teams[id];
      if (!t) return;
      const name = prompt('修改团队名（最多 20 字）', t.name);
      if (name == null) return;
      const value = name.trim();
      if (!value || value === t.name) return;
      projectOp('renameTeam', { teamId: id, name: value }).catch((e) => toast(e.message));
    });
    block.querySelector('.team-del').addEventListener('click', () => {
      const t = currentProject().teams[id];
      if (t && confirm('确定删除团队「' + t.name + '」？成员会被移出但不会删除。')) {
        doOp('removeTeam', { teamId: id });
      }
    });
    block.querySelectorAll('.chip .x').forEach((x) => {
      x.addEventListener('click', () => {
        doOp('assignTeam', { personId: x.dataset.person, teamId: null });
      });
    });
    block.querySelectorAll('.team-quick').forEach((btn) => {
      btn.addEventListener('click', () => {
        doOp('addTeamScore', { teamId: id, delta: Number(btn.dataset.delta) });
      });
    });
    const avatarInput = block.querySelector('.avatar-change-input');
    if (avatarInput) {
      avatarInput.addEventListener('change', async () => {
        const f = avatarInput.files[0];
        if (!f) return;
        try {
          const path = await uploadAvatar(f);
          await projectOp('setAvatar', { kind: 'team', id, avatar: path });
        } catch (e) { toast(e.message); }
        avatarInput.value = '';
      });
    }
    const avatarClear = block.querySelector('.avatar-clear');
    if (avatarClear) {
      avatarClear.addEventListener('click', () => {
        projectOp('setAvatar', { kind: 'team', id, avatar: null }).catch((e) => toast(e.message));
      });
    }
    const cardImgInput = block.querySelector('.card-img-input');
    cardImgInput.addEventListener('change', async () => {
      const f = cardImgInput.files[0];
      if (!f) return;
      try {
        const path = await uploadAvatar(f);
        await projectOp('setCardImage', { kind: 'team', id, image: path });
      } catch (e) { toast(e.message); }
      cardImgInput.value = '';
    });
    const cardImgClear = block.querySelector('.card-img-clear');
    if (cardImgClear) {
      cardImgClear.addEventListener('click', () => {
        projectOp('setCardImage', { kind: 'team', id, image: null }).catch((e) => toast(e.message));
      });
    }
  });
}

// ============ 排版设置 ============
const settingEls = {
  title: document.getElementById('set-title'),
  displayStyle: document.getElementById('set-display-style'),
  styleFree: document.getElementById('set-style-free'),
  titleFree: document.getElementById('set-title-free'),
  resetTitlePos: document.getElementById('reset-title-pos'),
  titleDecor: document.getElementById('set-title-decor'),
  columns: document.getElementById('set-columns'),
  density: document.getElementById('set-density'),
  sortBy: document.getElementById('set-sortby'),
  sortOrder: document.getElementById('set-sortorder'),
  theme: document.getElementById('set-theme'),
  accent: document.getElementById('set-accent'),
  showMemberScore: document.getElementById('set-show-member-score'),
  showTeamTotal: document.getElementById('set-show-team-total'),
  bgColorEnabled: document.getElementById('set-bg-color-enabled'),
  bgColor: document.getElementById('set-bg-color'),
  bgImageInput: document.getElementById('set-bg-image'),
  bgImagePreview: document.getElementById('bg-image-preview'),
  bgImageClear: document.getElementById('set-bg-image-clear'),
  bgImageBlur: document.getElementById('set-bg-image-blur'),
  bgImageBlurAmount: document.getElementById('set-bg-image-blur-amount'),
  bgImageBlurVal: document.getElementById('bg-image-blur-val'),
  bgScrimEnabled: document.getElementById('set-bg-scrim-enabled'),
  bgScrimOpacity: document.getElementById('set-bg-scrim-opacity'),
  bgScrimOpacityVal: document.getElementById('bg-scrim-opacity-val'),
  cardBgMode: document.getElementById('set-card-bg-mode'),
  cardBg: document.getElementById('set-card-bg'),
  cardOpacity: document.getElementById('set-card-opacity'),
  cardAcrylicBlur: document.getElementById('set-card-acrylic-blur'),
  cardRadius: document.getElementById('set-card-radius'),
  bgTypeRadios: document.querySelectorAll('input[name="bg-type"]'),
  layoutMode: document.getElementById('set-layout-mode'),
  memberScale: document.getElementById('set-member-scale'),
  avatarPosition: document.getElementById('set-avatar-position'),
  avatarAuto: document.getElementById('set-avatar-auto'),
  avatarSize: document.getElementById('set-avatar-size'),
  cardStyle: document.getElementById('set-card-style'),
  glassBlur: document.getElementById('set-glass-blur'),
  glassOpacity: document.getElementById('set-glass-opacity'),
  scoreEffect: document.getElementById('set-score-effect'),
  spotlightScope: document.getElementById('set-spotlight-scope'),
  spotlightWidth: document.getElementById('set-spotlight-width'),
  spotlightHeight: document.getElementById('set-spotlight-height'),
  spotlightTheme: document.getElementById('set-spotlight-theme'),
  spotlightReturnDuration: document.getElementById('set-spotlight-return-duration'),
  previewSpotlight: document.getElementById('preview-spotlight'),
  fxDuration: document.getElementById('set-fx-duration'),
  fxOnlyPositive: document.getElementById('set-fx-only-positive'),
  fxColorEnabled: document.getElementById('set-fx-color-enabled'),
  fxColor: document.getElementById('set-fx-color'),
  sound: document.getElementById('set-sound'),
  soundVolume: document.getElementById('set-sound-volume'),
  customSoundInput: document.getElementById('set-custom-sound'),
  customSoundName: document.getElementById('custom-sound-name'),
  clearCustomSound: document.getElementById('clear-custom-sound'),
  scoreRolling: document.getElementById('set-score-rolling'),
  sortAnimation: document.getElementById('set-sort-animation'),
  rankChangeAnimation: document.getElementById('set-rank-change-animation'),
};
const columnsVal = document.getElementById('columns-val');
const radiusVal = document.getElementById('radius-val');
const memberScaleVal = document.getElementById('member-scale-val');
const cardOpacityVal = document.getElementById('card-opacity-val');
const cardBlurVal = document.getElementById('card-blur-val');
const avatarSizeVal = document.getElementById('avatar-size-val');
const glassBlurVal = document.getElementById('glass-blur-val');
const glassOpacityVal = document.getElementById('glass-opacity-val');
const fxDurationVal = document.getElementById('fx-duration-val');
const spotlightWidthVal = document.getElementById('spotlight-width-val');
const spotlightHeightVal = document.getElementById('spotlight-height-val');
const spotlightReturnDurationVal = document.getElementById('spotlight-return-duration-val');
const soundVolumeVal = document.getElementById('sound-volume-val');
const resetLayoutBtn = document.getElementById('reset-layout');

// ---- 课堂工具 / 大屏演示 / 数据 ----
const classEls = {
  undo: document.getElementById('undo-score'),
  resetScores: document.getElementById('reset-scores'),
  peopleSearch: document.getElementById('people-search'),
  teamsSearch: document.getElementById('teams-search'),
  peopleCount: document.getElementById('people-count'),
  batchOpen: document.getElementById('batch-add-open'),
  batchDialog: document.getElementById('batch-add-dialog'),
  batchClose: document.getElementById('batch-add-close'),
  batchNames: document.getElementById('batch-names'),
  batchTeam: document.getElementById('batch-team'),
  batchPreview: document.getElementById('batch-preview'),
  batchSubmit: document.getElementById('batch-add-submit'),
  clockPosition: document.getElementById('set-clock-position'),
  clockFormat: document.getElementById('set-clock-format'),
  clockSeconds: document.getElementById('set-clock-seconds'),
  clockDate: document.getElementById('set-clock-date'),
  clockFont: document.getElementById('set-clock-font'),
  clockFontCustom: document.getElementById('set-clock-font-custom'),
  clockFontSize: document.getElementById('set-clock-font-size'),
  clockFontSizeVal: document.getElementById('clock-font-size-val'),
  countdownMin: document.getElementById('set-countdown-min'),
  countdownMode: document.getElementById('set-countdown-mode'),
  countdownTheme: document.getElementById('set-countdown-theme'),
  cdShape: document.getElementById('set-cd-shape'),
  cdPosition: document.getElementById('set-cd-position'),
  cdSize: document.getElementById('set-cd-size'),
  cdSizeVal: document.getElementById('cd-size-val'),
  cdHeight: document.getElementById('set-cd-height'),
  cdHeightVal: document.getElementById('cd-height-val'),
  cdRadius: document.getElementById('set-cd-radius'),
  cdRadiusVal: document.getElementById('cd-radius-val'),
  cdFontSize: document.getElementById('set-cd-fontsize'),
  cdFontSizeVal: document.getElementById('cd-fontsize-val'),
  cdFont: document.getElementById('set-cd-font'),
  cdFontCustom: document.getElementById('set-cd-font-custom'),
  cdOpacity: document.getElementById('set-cd-opacity'),
  cdOpacityVal: document.getElementById('cd-opacity-val'),
  cdProgress: document.getElementById('set-cd-progress'),
  cdBackdrop: document.getElementById('set-cd-backdrop'),
  cdBgMode: document.getElementById('set-cd-bg-mode'),
  cdBg: document.getElementById('set-cd-bg'),
  cdBlur: document.getElementById('set-cd-blur'),
  cdBlurVal: document.getElementById('cd-blur-val'),
  cdTextEnabled: document.getElementById('set-cd-text-enabled'),
  cdText: document.getElementById('set-cd-text'),
  cdStart: document.getElementById('cd-start'),
  cdPause: document.getElementById('cd-pause'),
  cdResume: document.getElementById('cd-resume'),
  cdReset: document.getElementById('cd-reset'),
  quickCdMin: document.getElementById('quick-cd-min'),
  quickCdStart: document.getElementById('quick-cd-start'),
  quickCdPause: document.getElementById('quick-cd-pause'),
  quickCdResume: document.getElementById('quick-cd-resume'),
  quickCdReset: document.getElementById('quick-cd-reset'),
  quickCdStatus: document.getElementById('quick-cd-status'),
  countdownStatus: document.getElementById('countdown-status'),
  lbScope: document.getElementById('set-lb-scope'),
  lbLimit: document.getElementById('set-lb-limit'),
  lbScale: document.getElementById('set-lb-scale'),
  lbScaleVal: document.getElementById('lb-scale-val'),
  lbFont: document.getElementById('set-lb-font'),
  lbFontCustom: document.getElementById('set-lb-font-custom'),
  toggleLeaderboard: document.getElementById('toggle-leaderboard'),
  rankTieMode: document.getElementById('set-rank-tie-mode'),
  exportProject: document.getElementById('export-project'),
  importProject: document.getElementById('import-project'),
  exportCsv: document.getElementById('export-csv'),
  backupNow: document.getElementById('backup-now'),
  scanOrphans: document.getElementById('scan-orphans'),
  cleanupOrphans: document.getElementById('cleanup-orphans'),
  dataStatus: document.getElementById('data-status'),
  settingsResize: document.getElementById('settings-resize'),
  quickPresets: document.getElementById('set-quick-presets'),
  scoreLogBtn: document.getElementById('score-log'),
  scoreLogDialog: document.getElementById('score-log-dialog'),
  scoreLogBody: document.getElementById('score-log-body'),
  scoreLogClose: document.getElementById('score-log-close'),
  undoHistoryBtn: document.getElementById('undo-history'),
  undoHistoryDialog: document.getElementById('undo-history-dialog'),
  undoHistoryBody: document.getElementById('undo-history-body'),
  undoHistoryClose: document.getElementById('undo-history-close'),
  featureMarquee: document.getElementById('set-feature-marquee'),
  marqueeText: document.getElementById('set-marquee-text'),
  marqueePosition: document.getElementById('set-marquee-position'),
  marqueeEffect: document.getElementById('set-marquee-effect'),
  marqueeFontSize: document.getElementById('set-marquee-font-size'),
  marqueeFontVal: document.getElementById('marquee-font-val'),
  marqueeFont: document.getElementById('set-marquee-font'),
  marqueeFontCustom: document.getElementById('set-marquee-font-custom'),
  marqueeSpeed: document.getElementById('set-marquee-speed'),
  marqueeSpeedVal: document.getElementById('marquee-speed-val'),
  marqueeColorEnabled: document.getElementById('set-marquee-color-enabled'),
  marqueeColor: document.getElementById('set-marquee-color'),
  marqueeBgEnabled: document.getElementById('set-marquee-bg-enabled'),
  marqueeBgColor: document.getElementById('set-marquee-bg-color'),
  bgmEnabled: document.getElementById('set-bgm-enabled'),
  bgmFile: document.getElementById('set-bgm-file'),
  clearBgmFile: document.getElementById('clear-bgm-file'),
  bgmVolume: document.getElementById('set-bgm-volume'),
  bgmVolumeVal: document.getElementById('bgm-volume-val'),
  bgmLoop: document.getElementById('set-bgm-loop'),
  featureWelcome: document.getElementById('set-feature-welcome'),
  welcomeText: document.getElementById('set-welcome-text'),
  welcomeFont: document.getElementById('set-welcome-font'),
  welcomeFontCustom: document.getElementById('set-welcome-font-custom'),
  welcomeFontSize: document.getElementById('set-welcome-font-size'),
  welcomeFontSizeVal: document.getElementById('welcome-font-size-val'),
  welcomeBgColorEnabled: document.getElementById('set-welcome-bg-color-enabled'),
  welcomeBgColor: document.getElementById('set-welcome-bg-color'),
  welcomeImage: document.getElementById('set-welcome-image'),
  clearWelcomeImage: document.getElementById('clear-welcome-image'),
};

const featureEls = {
  featureAvatarEdit: document.getElementById('f-avatar-edit'),
  featureSettingsResize: document.getElementById('f-settings-resize'),
  featureBatchAdd: document.getElementById('f-batch-add'),
  featureSearch: document.getElementById('f-search'),
  featureQuickScore: document.getElementById('f-quick-score'),
  featureTeamScore: document.getElementById('f-team-score'),
  featureUndo: document.getElementById('f-undo'),
  featureResetScores: document.getElementById('f-reset-scores'),
  featureClock: document.getElementById('f-clock'),
  featureCountdown: document.getElementById('f-countdown'),
  featureLeaderboard: document.getElementById('f-leaderboard'),
  featureRankTies: document.getElementById('f-rank-ties'),
  featureExportImport: document.getElementById('f-export-import'),
  featureCsvExport: document.getElementById('f-csv-export'),
  featureDataMaintenance: document.getElementById('f-data-maintenance'),
};

let peopleQuery = '';
let teamsQuery = '';

// ---- 高级外观控件 ----
const adv = {
  fontFamily: document.getElementById('set-font-family'),
  fontCustom: document.getElementById('set-font-custom'),
  loadFonts: document.getElementById('load-system-fonts'),
  fontScale: document.getElementById('set-font-scale'),
  fontScaleVal: document.getElementById('font-scale-val'),
  scoreFont: document.getElementById('set-score-font'),
  scoreFontCustom: document.getElementById('set-score-font-custom'),
  titleSize: document.getElementById('set-title-size'),
  titleSizeVal: document.getElementById('title-size-val'),
  titleFont: document.getElementById('set-title-font'),
  titleFontCustom: document.getElementById('set-title-font-custom'),
  titleAlign: document.getElementById('set-title-align'),
  titleRule: document.getElementById('set-title-rule'),
  titleColorEnabled: document.getElementById('set-title-color-enabled'),
  titleColor: document.getElementById('set-title-color'),
  boardMax: document.getElementById('set-board-max'),
  boardMaxVal: document.getElementById('board-max-val'),
  cardGap: document.getElementById('set-card-gap'),
  cardGapVal: document.getElementById('card-gap-val'),
  cardPad: document.getElementById('set-card-pad'),
  cardPadVal: document.getElementById('card-pad-val'),
  cardBorderWidth: document.getElementById('set-card-border-width'),
  cardBorderWidthVal: document.getElementById('card-border-width-val'),
  cardBorderColorEnabled: document.getElementById('set-card-border-color-enabled'),
  cardBorderColor: document.getElementById('set-card-border-color'),
  cardShadow: document.getElementById('set-card-shadow'),
  teamBarWidth: document.getElementById('set-team-bar-width'),
  teamBarVal: document.getElementById('team-bar-val'),
  showTeamAccent: document.getElementById('set-show-team-accent'),
  teamAccentColorEnabled: document.getElementById('set-team-accent-color-enabled'),
  teamAccentColor: document.getElementById('set-team-accent-color'),
  avatarBorderWidth: document.getElementById('set-avatar-border-width'),
  avatarBorderVal: document.getElementById('avatar-border-val'),
  avatarShape: document.getElementById('set-avatar-shape'),
  textColorEnabled: document.getElementById('set-text-color-enabled'),
  textColor: document.getElementById('set-text-color'),
  positiveColor: document.getElementById('set-positive-color'),
  negativeColor: document.getElementById('set-negative-color'),
  rankColorEnabled: document.getElementById('set-rank-color-enabled'),
  rankColor: document.getElementById('set-rank-color'),
  showRank: document.getElementById('set-show-rank'),
  rankSize: document.getElementById('set-rank-size'),
  rankSizeVal: document.getElementById('rank-size-val'),
  showScoreBar: document.getElementById('set-show-score-bar'),
  scoreBarHeight: document.getElementById('set-score-bar-height'),
  scoreBarHeightVal: document.getElementById('score-bar-height-val'),
};


let settingsTimer = null;
function pushSetting(key, value, immediate) {
  clearTimeout(settingsTimer);
  const send = () => doOp('updateSettings', { patch: { [key]: value } });
  if (immediate) send();
  else settingsTimer = setTimeout(send, 300);
}

settingEls.title.addEventListener('input', () => pushSetting('title', settingEls.title.value));
settingEls.displayStyle.addEventListener('change', () =>
  pushSetting('displayStyle', settingEls.displayStyle.value, true));
settingEls.styleFree.addEventListener('change', () =>
  pushSetting('styleFreeConfig', settingEls.styleFree.checked, true));
settingEls.titleFree.addEventListener('change', () =>
  pushSetting('titleFree', settingEls.titleFree.checked, true));
settingEls.resetTitlePos.addEventListener('click', () => {
  projectOp('updateSettings', { patch: { titleX: 50, titleY: 8 } })
    .catch((e) => toast(e.message));
});
settingEls.titleDecor.addEventListener('change', () =>
  pushSetting('titleDecor', settingEls.titleDecor.value, true));
settingEls.columns.addEventListener('input', () => {
  columnsVal.textContent = settingEls.columns.value;
  pushSetting('columns', Number(settingEls.columns.value));
});
settingEls.density.addEventListener('change', () => pushSetting('density', settingEls.density.value, true));
settingEls.sortBy.addEventListener('change', () => pushSetting('sortBy', settingEls.sortBy.value, true));
settingEls.sortOrder.addEventListener('change', () => pushSetting('sortOrder', settingEls.sortOrder.value, true));
settingEls.theme.addEventListener('change', () => pushSetting('theme', settingEls.theme.value, true));
settingEls.accent.addEventListener('input', () => pushSetting('accent', settingEls.accent.value));
settingEls.showMemberScore.addEventListener('change', () =>
  pushSetting('showMemberScore', settingEls.showMemberScore.checked, true));
settingEls.showTeamTotal.addEventListener('change', () =>
  pushSetting('showTeamTotal', settingEls.showTeamTotal.checked, true));

// ---- 背景 ----
settingEls.bgTypeRadios.forEach((radio) => {
  radio.addEventListener('change', () => {
    if (radio.checked) pushSetting('bgType', radio.value, true);
  });
});
settingEls.bgColorEnabled.addEventListener('change', () => {
  const on = settingEls.bgColorEnabled.checked;
  settingEls.bgColor.disabled = !on;
  projectOp('updateSettings', { patch: { bgColor: on ? settingEls.bgColor.value : '' } })
    .catch((e) => toast(e.message));
});
settingEls.bgColor.addEventListener('input', () => {
  if (settingEls.bgColorEnabled.checked) pushSetting('bgColor', settingEls.bgColor.value);
});
settingEls.bgImageInput.addEventListener('change', async () => {
  const file = settingEls.bgImageInput.files[0];
  if (!file) return;
  try {
    const path = await uploadAvatar(file);
    await projectOp('updateSettings', { patch: { bgImage: path, bgType: 'image' } });
  } catch (e) { toast(e.message); }
  settingEls.bgImageInput.value = '';
});
settingEls.bgImageClear.addEventListener('click', () => {
  projectOp('updateSettings', { patch: { bgImage: null, bgType: 'color' } }).catch((e) => toast(e.message));
});
settingEls.bgImageBlur.addEventListener('change', () => {
  settingEls.bgImageBlurAmount.disabled = !settingEls.bgImageBlur.checked;
  pushSetting('bgImageBlur', settingEls.bgImageBlur.checked, true);
});
settingEls.bgImageBlurAmount.addEventListener('input', () => {
  settingEls.bgImageBlurVal.textContent = settingEls.bgImageBlurAmount.value;
  pushSetting('bgImageBlurAmount', Number(settingEls.bgImageBlurAmount.value));
});
settingEls.bgScrimEnabled.addEventListener('change', () => {
  settingEls.bgScrimOpacity.disabled = !settingEls.bgScrimEnabled.checked;
  pushSetting('bgScrimEnabled', settingEls.bgScrimEnabled.checked, true);
});
settingEls.bgScrimOpacity.addEventListener('input', () => {
  settingEls.bgScrimOpacityVal.textContent = String(Math.round(Number(settingEls.bgScrimOpacity.value) * 100));
  pushSetting('scrimOpacity', Number(settingEls.bgScrimOpacity.value));
});

// ---- 卡片底色：跟随主题 / 纯色 / 半透明 / 亚克力 ----
function updateCardBgControls() {
  const mode = settingEls.cardBgMode.value;
  settingEls.cardBg.disabled = mode === 'auto';
  settingEls.cardOpacity.disabled = !(mode === 'translucent' || mode === 'acrylic');
  settingEls.cardAcrylicBlur.disabled = mode !== 'acrylic';
}

settingEls.cardBgMode.addEventListener('change', () => {
  updateCardBgControls();
  pushSetting('cardBgMode', settingEls.cardBgMode.value, true);
});
settingEls.cardBg.addEventListener('input', () => {
  if (settingEls.cardBgMode.value !== 'auto') pushSetting('cardBg', settingEls.cardBg.value);
});
settingEls.cardOpacity.addEventListener('input', () => {
  cardOpacityVal.textContent = Math.round(Number(settingEls.cardOpacity.value) * 100);
  pushSetting('cardOpacity', Number(settingEls.cardOpacity.value));
});
settingEls.cardAcrylicBlur.addEventListener('input', () => {
  cardBlurVal.textContent = settingEls.cardAcrylicBlur.value;
  pushSetting('cardAcrylicBlur', Number(settingEls.cardAcrylicBlur.value));
});
updateCardBgControls();
settingEls.cardRadius.addEventListener('input', () => {
  radiusVal.textContent = settingEls.cardRadius.value;
  pushSetting('cardRadius', Number(settingEls.cardRadius.value));
});
settingEls.memberScale.addEventListener('input', () => {
  memberScaleVal.textContent = Number(settingEls.memberScale.value).toFixed(2).replace(/0+$/, '').replace(/\.$/, '.0');
  pushSetting('memberScale', Number(settingEls.memberScale.value));
});
settingEls.avatarPosition.addEventListener('change', () => {
  pushSetting('avatarPosition', settingEls.avatarPosition.value, true);
});
settingEls.avatarAuto.addEventListener('change', () => {
  settingEls.avatarSize.disabled = settingEls.avatarAuto.checked;
  projectOp('updateSettings', {
    patch: { avatarSizeMode: settingEls.avatarAuto.checked ? 'auto' : 'manual' },
  }).catch((e) => toast(e.message));
});
settingEls.avatarSize.addEventListener('input', () => {
  avatarSizeVal.textContent = settingEls.avatarSize.value;
  if (!settingEls.avatarAuto.checked) {
    pushSetting('avatarSize', Number(settingEls.avatarSize.value));
  }
});

// ---- 特效：卡片样式 + 记分特效 + 音效 ----
settingEls.cardStyle.addEventListener('change', () => {
  pushSetting('cardStyle', settingEls.cardStyle.value, true);
});
settingEls.glassBlur.addEventListener('input', () => {
  glassBlurVal.textContent = settingEls.glassBlur.value;
  pushSetting('glassBlur', Number(settingEls.glassBlur.value));
});
settingEls.glassOpacity.addEventListener('input', () => {
  glassOpacityVal.textContent = Math.round(Number(settingEls.glassOpacity.value) * 100);
  pushSetting('glassOpacity', Number(settingEls.glassOpacity.value));
});
settingEls.scoreEffect.addEventListener('change', () => {
  pushSetting('scoreEffect', settingEls.scoreEffect.value, true);
});
settingEls.spotlightScope.addEventListener('change', () => {
  pushSetting('spotlightScope', settingEls.spotlightScope.value, true);
});
settingEls.spotlightWidth.addEventListener('input', () => {
  spotlightWidthVal.textContent = settingEls.spotlightWidth.value;
  pushSetting('spotlightWidth', Number(settingEls.spotlightWidth.value));
});
settingEls.spotlightHeight.addEventListener('input', () => {
  const v = Number(settingEls.spotlightHeight.value);
  spotlightHeightVal.textContent = v === 0 ? '自动' : v;
  pushSetting('spotlightHeight', v);
});
settingEls.spotlightTheme.addEventListener('change', () =>
  pushSetting('spotlightTheme', settingEls.spotlightTheme.value, true));
settingEls.spotlightReturnDuration.addEventListener('input', () => {
  spotlightReturnDurationVal.textContent = settingEls.spotlightReturnDuration.value;
  pushSetting('spotlightReturnDuration', Number(settingEls.spotlightReturnDuration.value));
});
settingEls.previewSpotlight.addEventListener('click', () => {
  try {
    previewFrame.contentWindow.postMessage({ type: 'preview-spotlight' }, location.origin);
  } catch (_) {}
});
settingEls.fxDuration.addEventListener('input', () => {
  fxDurationVal.textContent = settingEls.fxDuration.value;
  pushSetting('scoreEffectDuration', Number(settingEls.fxDuration.value));
});
settingEls.fxOnlyPositive.addEventListener('change', () => {
  pushSetting('scoreEffectOnlyPositive', settingEls.fxOnlyPositive.checked, true);
});
settingEls.sound.addEventListener('change', () => {
  pushSetting('soundEnabled', settingEls.sound.checked, true);
});
settingEls.soundVolume.addEventListener('input', () => {
  soundVolumeVal.textContent = Math.round(Number(settingEls.soundVolume.value) * 100);
  pushSetting('soundVolume', Number(settingEls.soundVolume.value));
});
settingEls.customSoundInput.addEventListener('change', async () => {
  const file = settingEls.customSoundInput.files[0];
  if (!file) return;
  try {
    const path = await uploadSound(file);
    await projectOp('updateSettings', { patch: { customSound: path } });
  } catch (e) { toast(e.message); }
  settingEls.customSoundInput.value = '';
});
settingEls.clearCustomSound.addEventListener('click', () => {
  projectOp('updateSettings', { patch: { customSound: '' } }).catch((e) => toast(e.message));
});
settingEls.scoreRolling.addEventListener('change', () =>
  pushSetting('scoreRolling', settingEls.scoreRolling.checked, true));
settingEls.sortAnimation.addEventListener('change', () =>
  pushSetting('sortAnimation', settingEls.sortAnimation.checked, true));
settingEls.rankChangeAnimation.addEventListener('change', () =>
  pushSetting('rankChangeAnimation', settingEls.rankChangeAnimation.checked, true));

// ---- 高级外观：滑块 / 下拉 / 开关 / 颜色 ----
const fmtAuto = (v) => (Number(v) === 0 ? '自动' : String(v));
const fmtNum = (v) => String(Number(v));
const fmtPercent = (v) => String(Math.round(Number(v) * 100));

const advRanges = [
  [adv.fontScale, adv.fontScaleVal, 'fontScale', fmtNum],
  [adv.titleSize, adv.titleSizeVal, 'titleSize', fmtAuto],
  [adv.boardMax, adv.boardMaxVal, 'boardMaxWidth', fmtNum],
  [adv.cardGap, adv.cardGapVal, 'cardGap', fmtAuto],
  [adv.cardPad, adv.cardPadVal, 'cardPad', fmtAuto],
  [adv.cardBorderWidth, adv.cardBorderWidthVal, 'cardBorderWidth', fmtNum],
  [adv.teamBarWidth, adv.teamBarVal, 'teamAccentWidth', fmtNum],
  [adv.avatarBorderWidth, adv.avatarBorderVal, 'avatarBorderWidth', fmtNum],
  [adv.rankSize, adv.rankSizeVal, 'rankSize', fmtNum],
  [adv.scoreBarHeight, adv.scoreBarHeightVal, 'scoreBarHeight', fmtNum],
];
advRanges.forEach(([input, label, key, fmt]) => {
  input.addEventListener('input', () => {
    label.textContent = fmt(input.value);
    pushSetting(key, Number(input.value));
  });
});

[[adv.titleAlign, 'titleAlign'], [adv.cardShadow, 'cardShadow'],
  [adv.avatarShape, 'avatarShape']]
  .forEach(([input, key]) => {
    input.addEventListener('change', () => pushSetting(key, input.value, true));
  });

// 字体：预设 / 自定义系统字体（正文字体与标题字体共用系统字体列表）
function updateFontCustomState() {
  const bodyCustom = adv.fontFamily.value === 'custom';
  const titleCustom = adv.titleFont.value === 'custom';
  adv.fontCustom.disabled = !bodyCustom;
  adv.titleFontCustom.disabled = !titleCustom;
  const partSelects = [classEls.clockFont, classEls.cdFont, classEls.lbFont,
    classEls.marqueeFont, classEls.welcomeFont, adv.scoreFont];
  adv.loadFonts.disabled = !(bodyCustom || titleCustom ||
    partSelects.some((sel) => sel && sel.value === 'custom'));
}
adv.fontFamily.addEventListener('change', () => {
  updateFontCustomState();
  pushSetting('fontFamily', adv.fontFamily.value, true);
});
adv.fontCustom.addEventListener('input', () => {
  pushSetting('fontFamilyCustom', adv.fontCustom.value);
});
adv.titleFont.addEventListener('change', () => {
  updateFontCustomState();
  pushSetting('titleFont', adv.titleFont.value, true);
});
adv.titleFontCustom.addEventListener('input', () => {
  pushSetting('titleFontCustom', adv.titleFontCustom.value);
});
adv.loadFonts.addEventListener('click', async () => {
  if (typeof window.queryLocalFonts !== 'function') {
    toast('当前浏览器不支持读取系统字体，请手动输入字体名称');
    return;
  }
  try {
    const fonts = await window.queryLocalFonts();
    const families = Array.from(new Set(fonts.map((f) => f.family).filter(Boolean)))
      .sort((a, b) => a.localeCompare(b));
    const dl = document.getElementById('system-font-list');
    dl.innerHTML = families.map((f) => '<option value="' + escapeHTML(f) + '"></option>').join('');
    toast('已读取 ' + families.length + ' 个系统字体，可在字体名称中搜索选择');
  } catch (e) {
    toast('读取系统字体失败：' + (e && e.message ? e.message : e));
  }
});
updateFontCustomState();

[[adv.titleRule, 'showTitleRule'], [adv.showRank, 'showRank'],
  [adv.showScoreBar, 'showScoreBar'], [adv.showTeamAccent, 'showTeamAccent']]
  .forEach(([input, key]) => {
    input.addEventListener('change', () => pushSetting(key, input.checked, true));
  });

function bindAdvColorToggle(enabled, color, key) {
  enabled.addEventListener('change', () => {
    color.disabled = !enabled.checked;
    projectOp('updateSettings', { patch: { [key]: enabled.checked ? color.value : '' } })
      .catch((e) => toast(e.message));
  });
  color.addEventListener('input', () => {
    if (enabled.checked) pushSetting(key, color.value);
  });
}
bindAdvColorToggle(adv.titleColorEnabled, adv.titleColor, 'titleColor');
bindAdvColorToggle(adv.cardBorderColorEnabled, adv.cardBorderColor, 'cardBorderColor');
bindAdvColorToggle(adv.textColorEnabled, adv.textColor, 'textColor');
bindAdvColorToggle(adv.rankColorEnabled, adv.rankColor, 'rankColor');
bindAdvColorToggle(adv.teamAccentColorEnabled, adv.teamAccentColor, 'teamAccentColor');

[[adv.positiveColor, 'positiveColor'], [adv.negativeColor, 'negativeColor']]
  .forEach(([input, key]) => {
    input.addEventListener('input', () => pushSetting(key, input.value));
  });
settingEls.fxColorEnabled.addEventListener('change', () => {
  const on = settingEls.fxColorEnabled.checked;
  settingEls.fxColor.disabled = !on;
  projectOp('updateSettings', {
    patch: { scoreEffectColor: on ? settingEls.fxColor.value : '' },
  }).catch((e) => toast(e.message));
});
settingEls.fxColor.addEventListener('input', () => {
  if (settingEls.fxColorEnabled.checked) {
    pushSetting('scoreEffectColor', settingEls.fxColor.value);
  }
});

// ---- 自由布局 ----
settingEls.layoutMode.addEventListener('change', () => {
  pushSetting('layoutMode', settingEls.layoutMode.checked ? 'free' : 'auto', true);
});
resetLayoutBtn.addEventListener('click', () => {
  if (!confirm('重置所有卡片的自由布局位置？')) return;
  projectOp('resetLayout', {}).catch((e) => toast(e.message));
});

// ============ 功能开关显隐 ============
function applyFeatureVisibility(settings) {
  for (const [key, el] of Object.entries(featureEls)) {
    if (el) el.checked = Boolean(settings[key]);
  }
  document.querySelectorAll('[data-feature]').forEach((el) => {
    el.classList.toggle('hidden', !settings[el.dataset.feature]);
  });
  settingsDialog.classList.toggle('no-resize', !settings.featureSettingsResize);
  featuresDialog.classList.toggle('no-resize', !settings.featureSettingsResize);
  if (!settings.featureSearch) {
    peopleQuery = '';
    teamsQuery = '';
    if (classEls.peopleSearch) classEls.peopleSearch.value = '';
    if (classEls.teamsSearch) classEls.teamsSearch.value = '';
  }
}

for (const [key, el] of Object.entries(featureEls)) {
  if (!el) continue;
  el.addEventListener('change', () => pushSetting(key, el.checked, true));
}

// ============ 运行态 UI：撤销数量 / 倒计时状态 ============
let runtimeReceivedAt = 0;

function formatClock(sec) {
  const s = Math.max(0, Math.ceil(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return String(m).padStart(2, '0') + ':' + String(r).padStart(2, '0');
}

function countdownRemaining(c) {
  if (!c) return 0;
  if (c.state === 'running') {
    const offset = currentRuntime && currentRuntime.serverNow ? currentRuntime.serverNow - runtimeReceivedAt : 0;
    return Math.max(0, c.endsAt - (Date.now() + offset)) / 1000;
  }
  return (c.remainingMs || 0) / 1000;
}

function updateCountdownStatus() {
  const project = currentProject();
  const c = currentRuntime && currentRuntime.countdowns ? currentRuntime.countdowns[currentProjectId] : null;
  let text = '未开始';
  if (c) {
    if (c.state === 'running') text = '进行中 ' + formatClock(countdownRemaining(c));
    else if (c.state === 'paused') text = '已暂停 ' + formatClock(countdownRemaining(c));
    else if (c.state === 'ended') text = '时间到';
  }

  // 弹窗内控件
  if (classEls.countdownStatus) classEls.countdownStatus.textContent = text;
  if (classEls.cdPause) classEls.cdPause.disabled = !c || c.state !== 'running';
  if (classEls.cdResume) classEls.cdResume.disabled = !c || c.state !== 'paused';
  if (classEls.cdReset) classEls.cdReset.disabled = !c;

  // 预览旁快捷控件
  if (classEls.quickCdStatus) classEls.quickCdStatus.textContent = text;
  if (classEls.quickCdPause) classEls.quickCdPause.disabled = !c || c.state !== 'running';
  if (classEls.quickCdResume) classEls.quickCdResume.disabled = !c || c.state !== 'paused';
  if (classEls.quickCdReset) classEls.quickCdReset.disabled = !c;

  if (classEls.toggleLeaderboard && project) {
    classEls.toggleLeaderboard.textContent =
      project.settings.displayView === 'leaderboard' ? '返回计分板' : '切换到排行榜';
  }
}

function applyRuntimeUI() {
  runtimeReceivedAt = Date.now();
  const count = currentRuntime && currentRuntime.undoCounts
    ? currentRuntime.undoCounts[currentProjectId] || 0 : 0;
  if (classEls.undo) {
    classEls.undo.disabled = count === 0;
    classEls.undo.textContent = count ? '撤销记分 (' + count + ')' : '撤销记分';
  }
  updateCountdownStatus();
}

setInterval(updateCountdownStatus, 1000);

classEls.undo.addEventListener('click', () => {
  projectOp('undoScore', {}).then((res) => {
    const result = res.result || res;
    toast('已撤销：' + (result && result.label ? result.label : '上一步记分'));
  }).catch((e) => toast(e.message));
});

// ---- 分数日志 / 撤销历史 ----
function formatLogTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return d.getHours() + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

classEls.scoreLogBtn.addEventListener('click', () => {
  const logs = currentRuntime && currentRuntime.scoreLogs
    ? currentRuntime.scoreLogs[currentProjectId] || [] : [];
  classEls.scoreLogBody.innerHTML = logs.length
    ? logs.map((l) => '<div class="log-row"><span class="hint">' + formatLogTime(l.at) +
        '</span><span>' + escapeHTML(l.label) + '</span></div>').join('')
    : '<p class="hint">暂无分数变化记录</p>';
  if (!classEls.scoreLogDialog.open) classEls.scoreLogDialog.showModal();
});
classEls.scoreLogClose.addEventListener('click', () => classEls.scoreLogDialog.close());

classEls.undoHistoryBtn.addEventListener('click', () => {
  const labels = currentRuntime && currentRuntime.undoLabels
    ? currentRuntime.undoLabels[currentProjectId] || [] : [];
  // labels 是最新在前的倒序（index 从大往小）；展示时也按最新在前
  classEls.undoHistoryBody.innerHTML = labels.length
    ? labels.map((l) => '<button class="btn small undo-to" data-keep="' + l.index + '">撤销到：' +
        escapeHTML(l.label) + '</button>').join('')
    : '<p class="hint">没有可撤销的记分</p>';
  classEls.undoHistoryBody.querySelectorAll('.undo-to').forEach((btn) => {
    btn.addEventListener('click', () => {
      projectOp('undoTo', { keep: Number(btn.dataset.keep) }).then((res) => {
        const result = res.result || res;
        toast('已连续撤销 ' + result.count + ' 步');
        classEls.undoHistoryDialog.close();
      }).catch((e) => toast(e.message));
    });
  });
  if (!classEls.undoHistoryDialog.open) classEls.undoHistoryDialog.showModal();
});
classEls.undoHistoryClose.addEventListener('click', () => classEls.undoHistoryDialog.close());

// ---- 快捷分预设 ----
classEls.quickPresets.addEventListener('input', () => {
  const items = classEls.quickPresets.value.split(/[,，、\s]+/)
    .map((s) => s.trim()).filter(Boolean).map(Number);
  if (items.length && items.every((n) => Number.isInteger(n) && n !== 0)) {
    pushSetting('quickScorePresets', items);
  }
});

// ---- 课堂玩法：跑马灯 / 背景音乐 / 欢迎幕布 ----
classEls.featureMarquee.addEventListener('change', () =>
  pushSetting('featureMarquee', classEls.featureMarquee.checked, true));
classEls.marqueeText.addEventListener('input', () =>
  pushSetting('marqueeText', classEls.marqueeText.value));
classEls.marqueePosition.addEventListener('change', () =>
  pushSetting('marqueePosition', classEls.marqueePosition.value, true));
classEls.marqueeEffect.addEventListener('change', () =>
  pushSetting('marqueeEffect', classEls.marqueeEffect.value, true));
classEls.marqueeFontSize.addEventListener('input', () => {
  const v = Number(classEls.marqueeFontSize.value);
  classEls.marqueeFontVal.textContent = v === 0 ? '自动' : v + ' px';
  pushSetting('marqueeFontSize', v);
});
classEls.marqueeSpeed.addEventListener('input', () => {
  classEls.marqueeSpeedVal.textContent = String(Number(classEls.marqueeSpeed.value));
  pushSetting('marqueeSpeed', Number(classEls.marqueeSpeed.value));
});
bindAdvColorToggle(classEls.marqueeColorEnabled, classEls.marqueeColor, 'marqueeColor');
bindAdvColorToggle(classEls.marqueeBgEnabled, classEls.marqueeBgColor, 'marqueeBgColor');

classEls.bgmEnabled.addEventListener('change', () =>
  pushSetting('bgmEnabled', classEls.bgmEnabled.checked, true));
classEls.bgmFile.addEventListener('change', async () => {
  const f = classEls.bgmFile.files[0];
  if (!f) return;
  try {
    const path = await uploadSound(f);
    await projectOp('updateSettings', { patch: { bgmFile: path } });
  } catch (e) { toast(e.message); }
  classEls.bgmFile.value = '';
});
classEls.clearBgmFile.addEventListener('click', () =>
  projectOp('updateSettings', { patch: { bgmFile: '' } }).catch((e) => toast(e.message)));
classEls.bgmVolume.addEventListener('input', () => {
  classEls.bgmVolumeVal.textContent = Math.round(Number(classEls.bgmVolume.value) * 100);
  pushSetting('bgmVolume', Number(classEls.bgmVolume.value));
});
classEls.bgmLoop.addEventListener('change', () =>
  pushSetting('bgmLoop', classEls.bgmLoop.checked, true));

classEls.featureWelcome.addEventListener('change', () =>
  pushSetting('featureWelcome', classEls.featureWelcome.checked, true));
classEls.welcomeText.addEventListener('input', () =>
  pushSetting('welcomeText', classEls.welcomeText.value));
bindAdvColorToggle(classEls.welcomeBgColorEnabled, classEls.welcomeBgColor, 'welcomeBgColor');
classEls.welcomeImage.addEventListener('change', async () => {
  const f = classEls.welcomeImage.files[0];
  if (!f) return;
  try {
    const path = await uploadAvatar(f);
    await projectOp('updateSettings', { patch: { welcomeImage: path } });
  } catch (e) { toast(e.message); }
  classEls.welcomeImage.value = '';
});
classEls.clearWelcomeImage.addEventListener('click', () =>
  projectOp('updateSettings', { patch: { welcomeImage: '' } }).catch((e) => toast(e.message)));

classEls.resetScores.addEventListener('click', () => {
  if (!confirm('将所有人员分数清零？此操作可以撤销。')) return;
  projectOp('resetScores', {}).then((res) => {
    const result = res.result || res;
    toast('已重置 ' + (result && result.count != null ? result.count : 0) + ' 人分数');
  }).catch((e) => toast(e.message));
});

// ============ 搜索 ============
classEls.peopleSearch.addEventListener('input', () => {
  peopleQuery = classEls.peopleSearch.value;
  const project = currentProject();
  if (project) renderPeople(project);
});
classEls.teamsSearch.addEventListener('input', () => {
  teamsQuery = classEls.teamsSearch.value;
  const project = currentProject();
  if (project) renderTeams(project);
});

// ============ 批量添加 ============
function parseBatchNames(text) {
  const raw = String(text || '').split(/[\n\r,，、;；\t]+/).map((s) => s.trim()).filter(Boolean);
  const unique = [];
  const seen = new Set();
  for (const name of raw) {
    if (seen.has(name)) continue;
    seen.add(name);
    unique.push(name);
  }
  return { raw, unique };
}

function updateBatchPreview() {
  const { raw, unique } = parseBatchNames(classEls.batchNames.value);
  const tooLong = unique.find((n) => Array.from(n).length > 20);
  const dup = raw.length - unique.length;
  let text = '将添加 ' + unique.length + ' 人';
  if (dup > 0) text += '，批内重复 ' + dup + ' 个已合并';
  if (tooLong) text += '；存在超过 20 字的姓名：' + tooLong;
  classEls.batchPreview.textContent = text;
}

classEls.batchNames.addEventListener('input', updateBatchPreview);

function openBatchDialog() {
  const project = currentProject();
  if (!project) return;
  classEls.batchTeam.innerHTML = '<option value="">无团队</option>' +
    Object.values(project.teams).sort((a, b) => a.order - b.order)
      .map((t) => '<option value="' + t.id + '">' + escapeHTML(t.name) + '</option>').join('');
  classEls.batchNames.value = '';
  updateBatchPreview();
  if (!classEls.batchDialog.open) classEls.batchDialog.showModal();
}
classEls.batchOpen.addEventListener('click', openBatchDialog);
classEls.batchClose.addEventListener('click', () => classEls.batchDialog.close());
classEls.batchSubmit.addEventListener('click', async () => {
  const { unique } = parseBatchNames(classEls.batchNames.value);
  if (!unique.length) { toast('请先输入姓名'); return; }
  try {
    const res = await projectOp('addPeopleBatch', {
      names: unique,
      teamId: classEls.batchTeam.value || null,
    });
    const result = res.result || res;
    let msg = '已添加 ' + result.added + ' 人';
    if (result.skipped && result.skipped.length) msg += '，跳过重名 ' + result.skipped.length + ' 个';
    toast(msg);
    classEls.batchDialog.close();
  } catch (e) { toast(e.message); }
});

// ============ 时钟 / 倒计时 / 排行榜 ============
// 部件字体：下拉 + 自定义字体名（共用系统字体列表）
const partFontBindings = [];
function bindPartFont(sel, custom, fontKey, customKey) {
  const syncDisabled = () => { custom.disabled = sel.value !== 'custom'; };
  sel.addEventListener('change', () => {
    syncDisabled();
    pushSetting(fontKey, sel.value, true);
  });
  custom.addEventListener('input', () => pushSetting(customKey, custom.value));
  partFontBindings.push((settings) => {
    sel.value = settings[fontKey] || 'auto';
    if (document.activeElement !== custom && custom.value !== (settings[customKey] || '')) {
      custom.value = settings[customKey] || '';
    }
    syncDisabled();
  });
}
bindPartFont(classEls.clockFont, classEls.clockFontCustom, 'clockFont', 'clockFontCustom');
bindPartFont(classEls.cdFont, classEls.cdFontCustom, 'countdownFont', 'countdownFontCustom');
bindPartFont(classEls.lbFont, classEls.lbFontCustom, 'leaderboardFont', 'leaderboardFontCustom');
bindPartFont(classEls.marqueeFont, classEls.marqueeFontCustom, 'marqueeFont', 'marqueeFontCustom');
bindPartFont(classEls.welcomeFont, classEls.welcomeFontCustom, 'welcomeFont', 'welcomeFontCustom');
bindPartFont(adv.scoreFont, adv.scoreFontCustom, 'scoreFont', 'scoreFontCustom');

classEls.clockPosition.addEventListener('change', () =>
  pushSetting('clockPosition', classEls.clockPosition.value, true));
classEls.clockFormat.addEventListener('change', () =>
  pushSetting('clockFormat', classEls.clockFormat.value, true));
classEls.clockSeconds.addEventListener('change', () =>
  pushSetting('clockShowSeconds', classEls.clockSeconds.checked, true));
classEls.clockDate.addEventListener('change', () =>
  pushSetting('clockShowDate', classEls.clockDate.checked, true));
classEls.clockFontSize.addEventListener('input', () => {
  const v = Number(classEls.clockFontSize.value);
  classEls.clockFontSizeVal.textContent = v === 0 ? '自动' : v + ' px';
  pushSetting('clockFontSize', v);
});
classEls.welcomeFontSize.addEventListener('input', () => {
  const v = Number(classEls.welcomeFontSize.value);
  classEls.welcomeFontSizeVal.textContent = v === 0 ? '自动' : v + ' px';
  pushSetting('welcomeFontSize', v);
});
classEls.countdownMin.addEventListener('input', () => {
  const secs = Number(classEls.countdownMin.value);
  if (Number.isFinite(secs) && secs >= 1 && secs <= 3600) {
    pushSetting('countdownDurationSec', Math.round(secs));
  }
});
classEls.countdownMode.addEventListener('change', () =>
  pushSetting('countdownDisplayMode', classEls.countdownMode.value, true));
classEls.countdownTheme.addEventListener('change', () =>
  pushSetting('countdownTheme', classEls.countdownTheme.value, true));
classEls.cdShape.addEventListener('change', () =>
  pushSetting('countdownShape', classEls.cdShape.value, true));
classEls.cdPosition.addEventListener('change', () =>
  pushSetting('countdownPosition', classEls.cdPosition.value, true));
classEls.cdSize.addEventListener('input', () => {
  classEls.cdSizeVal.textContent = classEls.cdSize.value;
  pushSetting('countdownSize', Number(classEls.cdSize.value));
});
classEls.cdHeight.addEventListener('input', () => {
  const v = Number(classEls.cdHeight.value);
  classEls.cdHeightVal.textContent = v === 0 ? '自动' : v + ' px';
  pushSetting('countdownHeight', v);
});
classEls.cdRadius.addEventListener('input', () => {
  classEls.cdRadiusVal.textContent = classEls.cdRadius.value;
  pushSetting('countdownRadius', Number(classEls.cdRadius.value));
});
classEls.cdFontSize.addEventListener('input', () => {
  const v = Number(classEls.cdFontSize.value);
  classEls.cdFontSizeVal.textContent = v === 0 ? '自动' : v + ' px';
  pushSetting('countdownFontSize', v);
});
classEls.cdOpacity.addEventListener('input', () => {
  classEls.cdOpacityVal.textContent = Math.round(Number(classEls.cdOpacity.value) * 100);
  pushSetting('countdownOpacity', Number(classEls.cdOpacity.value));
});
classEls.cdProgress.addEventListener('change', () =>
  pushSetting('countdownShowProgress', classEls.cdProgress.checked, true));
classEls.cdBackdrop.addEventListener('change', () =>
  pushSetting('countdownShowBackdrop', classEls.cdBackdrop.checked, true));
function updateCountdownBgControls() {
  const mode = classEls.cdBgMode.value;
  classEls.cdBg.disabled = mode === 'theme';
  classEls.cdOpacity.disabled = !(mode === 'translucent' || mode === 'acrylic');
  classEls.cdBlur.disabled = mode !== 'acrylic';
}
classEls.cdBgMode.addEventListener('change', () => {
  const mode = classEls.cdBgMode.value;
  const patch = { countdownBgMode: mode };
  // 半透明/亚克力：若当前是不透明，自动给一个能看出效果的默认值
  if ((mode === 'translucent' || mode === 'acrylic') && Number(classEls.cdOpacity.value) >= 0.95) {
    patch.countdownOpacity = 0.55;
    classEls.cdOpacity.value = '0.55';
    classEls.cdOpacityVal.textContent = '55';
  }
  if (mode === 'acrylic' && Number(classEls.cdBlur.value) === 0) {
    patch.countdownBlur = 12;
    classEls.cdBlur.value = '12';
    classEls.cdBlurVal.textContent = '12';
  }
  updateCountdownBgControls();
  projectOp('updateSettings', { patch }).catch((e) => toast(e.message));
});
classEls.cdBg.addEventListener('input', () => {
  if (classEls.cdBgMode.value !== 'theme') pushSetting('countdownBg', classEls.cdBg.value);
});
classEls.cdBlur.addEventListener('input', () => {
  classEls.cdBlurVal.textContent = classEls.cdBlur.value;
  pushSetting('countdownBlur', Number(classEls.cdBlur.value));
});
updateCountdownBgControls();
bindAdvColorToggle(classEls.cdTextEnabled, classEls.cdText, 'countdownTextColor');
classEls.cdStart.addEventListener('click', () => {
  const secs = Number(classEls.countdownMin.value) || 300;
  projectOp('countdownStart', { durationSec: Math.round(secs) })
    .catch((e) => toast(e.message));
});
classEls.cdPause.addEventListener('click', () =>
  projectOp('countdownPause', {}).catch((e) => toast(e.message)));
classEls.cdResume.addEventListener('click', () =>
  projectOp('countdownResume', {}).catch((e) => toast(e.message)));
classEls.cdReset.addEventListener('click', () =>
  projectOp('countdownReset', {}).catch((e) => toast(e.message)));

// 预览旁倒计时快捷操作
classEls.quickCdMin.addEventListener('input', () => {
  const secs = Number(classEls.quickCdMin.value);
  if (Number.isFinite(secs) && secs >= 1 && secs <= 3600) {
    pushSetting('countdownDurationSec', Math.round(secs));
  }
});
const quickCdSecs = () => {
  const secs = Number(classEls.quickCdMin.value);
  return Number.isFinite(secs) && secs >= 1 && secs <= 3600 ? Math.round(secs) : 300;
};
classEls.quickCdStart.addEventListener('click', () =>
  projectOp('countdownStart', { durationSec: quickCdSecs() }).catch((e) => toast(e.message)));
classEls.quickCdPause.addEventListener('click', () =>
  projectOp('countdownPause', {}).catch((e) => toast(e.message)));
classEls.quickCdResume.addEventListener('click', () =>
  projectOp('countdownResume', {}).catch((e) => toast(e.message)));
classEls.quickCdReset.addEventListener('click', () =>
  projectOp('countdownReset', {}).catch((e) => toast(e.message)));

classEls.lbScope.addEventListener('change', () =>
  pushSetting('leaderboardScope', classEls.lbScope.value, true));
classEls.lbLimit.addEventListener('input', () =>
  pushSetting('leaderboardLimit', Number(classEls.lbLimit.value) || 0));
classEls.lbScale.addEventListener('input', () => {
  classEls.lbScaleVal.textContent = String(Number(classEls.lbScale.value));
  pushSetting('leaderboardScale', Number(classEls.lbScale.value));
});
classEls.rankTieMode.addEventListener('change', () =>
  pushSetting('rankTieMode', classEls.rankTieMode.value, true));
classEls.toggleLeaderboard.addEventListener('click', () => {
  const project = currentProject();
  if (!project) return;
  const next = project.settings.displayView === 'leaderboard' ? 'cards' : 'leaderboard';
  projectOp('updateSettings', { patch: { displayView: next } }).catch((e) => toast(e.message));
});

// ============ 数据面板 ============
classEls.exportProject.addEventListener('click', () => {
  if (!currentProjectId) return;
  window.location.href = '/api/export?project=' + encodeURIComponent(currentProjectId) + '&assets=1';
});
classEls.exportCsv.addEventListener('click', () => {
  if (!currentProjectId) return;
  window.location.href = '/api/scores.csv?project=' + encodeURIComponent(currentProjectId) + '&scope=all';
});
classEls.importProject.addEventListener('change', async () => {
  const file = classEls.importProject.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const res = await fetch('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: text,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '导入失败');
    toast('导入成功：' + data.name);
    // 等广播把新项目带回来后再切换
    const switchToImported = (tries = 20) => {
      if (currentState && currentState.projects[data.projectId]) {
        selectProject(data.projectId);
      } else if (tries > 0) {
        setTimeout(() => switchToImported(tries - 1), 100);
      }
    };
    switchToImported();
  } catch (e) {
    toast(e.message);
  }
  classEls.importProject.value = '';
});
classEls.backupNow.addEventListener('click', async () => {
  try {
    const res = await fetch('/api/backups/run', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '备份失败');
    classEls.dataStatus.textContent = '已备份：' + data.file;
    toast('备份完成');
  } catch (e) { toast(e.message); }
});
classEls.scanOrphans.addEventListener('click', async () => {
  try {
    const res = await fetch('/api/orphans');
    const data = await res.json();
    classEls.dataStatus.textContent =
      '头像孤儿 ' + data.avatars.count + ' 个，音效孤儿 ' + data.sounds.count + ' 个';
  } catch (e) { toast(e.message); }
});
classEls.cleanupOrphans.addEventListener('click', async () => {
  if (!confirm('删除超过宽限期且未被引用的上传文件？')) return;
  try {
    const res = await fetch('/api/orphans/cleanup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '清理失败');
    classEls.dataStatus.textContent = '已清理 ' + data.removed.length + ' 个文件';
    toast('清理完成');
  } catch (e) { toast(e.message); }
});

// ============ 设置窗口尺寸 ============
function applySettingsDialogSize() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('settingsDialogSize') || 'null'); } catch (_) {}
  const maxW = Math.max(480, window.innerWidth * 0.96);
  const maxH = Math.max(260, window.innerHeight * 0.92);
  let w = saved && Number.isFinite(saved.w) ? saved.w : 900;
  let h = saved && Number.isFinite(saved.h) ? saved.h : 0;
  w = Math.min(Math.max(480, w), maxW);
  if (h > 0) {
    h = Math.min(Math.max(260, h), maxH);
    settingsDialog.style.height = h + 'px';
  }
  settingsDialog.style.width = w + 'px';
}

let dialogResize = null;
classEls.settingsResize.addEventListener('pointerdown', (e) => {
  const project = currentProject();
  if (!project || !project.settings.featureSettingsResize) return;
  e.preventDefault();
  const rect = settingsDialog.getBoundingClientRect();
  dialogResize = { startX: e.clientX, startY: e.clientY, w: rect.width, h: rect.height };
  classEls.settingsResize.setPointerCapture(e.pointerId);
});
window.addEventListener('pointermove', (e) => {
  if (!dialogResize) return;
  const maxW = Math.max(480, window.innerWidth * 0.96);
  const maxH = Math.max(260, window.innerHeight * 0.92);
  const w = Math.min(Math.max(480, dialogResize.w + (e.clientX - dialogResize.startX)), maxW);
  const h = Math.min(Math.max(260, dialogResize.h + (e.clientY - dialogResize.startY)), maxH);
  settingsDialog.style.width = w + 'px';
  settingsDialog.style.height = h + 'px';
});
window.addEventListener('pointerup', () => {
  if (!dialogResize) return;
  dialogResize = null;
  try {
    localStorage.setItem('settingsDialogSize', JSON.stringify({
      w: settingsDialog.offsetWidth,
      h: settingsDialog.offsetHeight,
    }));
  } catch (_) {}
});
window.addEventListener('resize', () => {
  if (settingsDialog.open) applySettingsDialogSize();
  if (featuresDialog.open) applyFeaturesDialogSize();
});

function syncAdvRange(input, label, val, fmt) {
  if (Number(input.value) !== Number(val)) input.value = val;
  label.textContent = fmt(val);
}

function syncAdvColorToggle(enabled, color, val, fallback) {
  enabled.checked = Boolean(val);
  color.disabled = !val;
  if (val) {
    if (document.activeElement !== color && color.value !== val) color.value = val;
  } else if (fallback) {
    color.value = fallback;
  }
}

function renderSettings(settings) {
  // 避免打字时被广播回写打断：仅当值不同时才更新
  if (document.activeElement !== settingEls.title && settingEls.title.value !== settings.title) {
    settingEls.title.value = settings.title;
  }
  settingEls.displayStyle.value = settings.displayStyle || 'lecture';
  settingEls.styleFree.checked = Boolean(settings.styleFreeConfig);
  settingEls.titleFree.checked = Boolean(settings.titleFree);
  settingEls.titleDecor.value = settings.titleDecor || 'auto';
  if (Number(settingEls.columns.value) !== settings.columns) {
    settingEls.columns.value = settings.columns;
    columnsVal.textContent = settings.columns;
  }

  // 预览旁快速调节同步
  quick.style.value = settings.displayStyle || 'lecture';
  quick.theme.value = settings.theme;
  quick.density.value = settings.density;
  if (Number(quick.columns.value) !== settings.columns) {
    quick.columns.value = settings.columns;
    quick.columnsVal.textContent = settings.columns;
  }
  const sortKey = settings.sortBy === 'manual' ? 'manual_asc' : settings.sortBy + '_' + settings.sortOrder;
  if (['score_desc', 'score_asc', 'created_asc', 'created_desc', 'manual_asc'].includes(sortKey)) {
    quick.sort.value = sortKey;
  }
  if (document.activeElement !== quick.accent && quick.accent.value !== settings.accent) {
    quick.accent.value = settings.accent;
  }
  quick.view.value = settings.displayView || 'cards';
  settingEls.density.value = settings.density;
  settingEls.sortBy.value = settings.sortBy;
  settingEls.sortOrder.value = settings.sortOrder;
  settingEls.sortOrder.disabled = settings.sortBy === 'manual';
  settingEls.sortOrder.title = settings.sortBy === 'manual'
    ? '自定义顺序由人员/团队列表中的 ↑↓ 调整'
    : '';
  settingEls.theme.value = settings.theme;
  if (settingEls.accent.value !== settings.accent) settingEls.accent.value = settings.accent;
  settingEls.showMemberScore.checked = settings.showMemberScore;
  settingEls.showTeamTotal.checked = settings.showTeamTotal;

  // 背景
  settingEls.bgTypeRadios.forEach((r) => { r.checked = r.value === settings.bgType; });
  settingEls.bgColorEnabled.checked = Boolean(settings.bgColor);
  settingEls.bgColor.disabled = !settings.bgColor;
  if (settings.bgColor) {
    if (document.activeElement !== settingEls.bgColor && settingEls.bgColor.value !== settings.bgColor) {
      settingEls.bgColor.value = settings.bgColor;
    }
  } else {
    // 未自定义时，取色器预置为当前主题背景色，勾选后即可微调
    settingEls.bgColor.value = settings.theme === 'light' ? '#e9ebee' : '#12161c';
  }
  if (settings.bgImage) {
    settingEls.bgImagePreview.src = '/' + settings.bgImage;
    settingEls.bgImagePreview.classList.remove('hidden');
  } else {
    settingEls.bgImagePreview.classList.add('hidden');
  }
  settingEls.bgImageBlur.checked = Boolean(settings.bgImageBlur);
  if (Number(settingEls.bgImageBlurAmount.value) !== settings.bgImageBlurAmount) {
    settingEls.bgImageBlurAmount.value = settings.bgImageBlurAmount;
  }
  settingEls.bgImageBlurVal.textContent = String(settings.bgImageBlurAmount);
  settingEls.bgImageBlurAmount.disabled = !settings.bgImageBlur;
  settingEls.bgScrimEnabled.checked = settings.bgScrimEnabled !== false;
  if (Number(settingEls.bgScrimOpacity.value) !== settings.scrimOpacity) {
    settingEls.bgScrimOpacity.value = settings.scrimOpacity;
  }
  settingEls.bgScrimOpacityVal.textContent = String(Math.round(settings.scrimOpacity * 100));
  settingEls.bgScrimOpacity.disabled = !settingEls.bgScrimEnabled.checked;

  // 卡片底色
  settingEls.cardBgMode.value = settings.cardBgMode || 'auto';
  updateCardBgControls();
  if (document.activeElement !== settingEls.cardBg) {
    const themeCard = settings.theme === 'light' ? '#ffffff' : '#1a1f26';
    const color = settings.cardBg || themeCard;
    if (settingEls.cardBg.value !== color) settingEls.cardBg.value = color;
  }
  if (Number(settingEls.cardOpacity.value) !== settings.cardOpacity) {
    settingEls.cardOpacity.value = settings.cardOpacity;
  }
  cardOpacityVal.textContent = Math.round(settings.cardOpacity * 100);
  if (Number(settingEls.cardAcrylicBlur.value) !== settings.cardAcrylicBlur) {
    settingEls.cardAcrylicBlur.value = settings.cardAcrylicBlur;
  }
  cardBlurVal.textContent = settings.cardAcrylicBlur;
  if (Number(settingEls.cardRadius.value) !== settings.cardRadius) {
    settingEls.cardRadius.value = settings.cardRadius;
    radiusVal.textContent = settings.cardRadius;
  }
  if (Number(settingEls.memberScale.value) !== settings.memberScale) {
    settingEls.memberScale.value = settings.memberScale;
    memberScaleVal.textContent = String(settings.memberScale);
  }
  settingEls.layoutMode.checked = settings.layoutMode === 'free';
  settingEls.avatarPosition.value = settings.avatarPosition;
  settingEls.avatarAuto.checked = settings.avatarSizeMode === 'auto';
  settingEls.avatarSize.disabled = settings.avatarSizeMode === 'auto';
  if (Number(settingEls.avatarSize.value) !== settings.avatarSize) {
    settingEls.avatarSize.value = settings.avatarSize;
    avatarSizeVal.textContent = settings.avatarSize;
  }

  // 特效
  settingEls.cardStyle.value = settings.cardStyle;
  if (Number(settingEls.glassBlur.value) !== settings.glassBlur) {
    settingEls.glassBlur.value = settings.glassBlur;
    glassBlurVal.textContent = settings.glassBlur;
  }
  if (Number(settingEls.glassOpacity.value) !== settings.glassOpacity) {
    settingEls.glassOpacity.value = settings.glassOpacity;
    glassOpacityVal.textContent = Math.round(settings.glassOpacity * 100);
  }
  settingEls.scoreEffect.value = settings.scoreEffect;
  settingEls.spotlightScope.value = settings.spotlightScope || 'person';
  if (Number(settingEls.spotlightWidth.value) !== settings.spotlightWidth) {
    settingEls.spotlightWidth.value = settings.spotlightWidth;
    spotlightWidthVal.textContent = settings.spotlightWidth;
  }
  if (Number(settingEls.spotlightHeight.value) !== settings.spotlightHeight) {
    settingEls.spotlightHeight.value = settings.spotlightHeight;
    spotlightHeightVal.textContent = settings.spotlightHeight === 0 ? '自动' : settings.spotlightHeight;
  }
  settingEls.spotlightTheme.value = settings.spotlightTheme ||
    (settings.spotlightReturnToOrigin ? 'fly' : 'pop');
  if (Number(settingEls.spotlightReturnDuration.value) !== settings.spotlightReturnDuration) {
    settingEls.spotlightReturnDuration.value = settings.spotlightReturnDuration;
    spotlightReturnDurationVal.textContent = settings.spotlightReturnDuration;
  }
  if (Number(settingEls.fxDuration.value) !== settings.scoreEffectDuration) {
    settingEls.fxDuration.value = settings.scoreEffectDuration;
    fxDurationVal.textContent = settings.scoreEffectDuration;
  }
  settingEls.fxOnlyPositive.checked = settings.scoreEffectOnlyPositive;
  settingEls.sound.checked = settings.soundEnabled;
  if (Number(settingEls.soundVolume.value) !== settings.soundVolume) {
    settingEls.soundVolume.value = settings.soundVolume;
    soundVolumeVal.textContent = Math.round(settings.soundVolume * 100);
  }
  settingEls.customSoundName.textContent = settings.customSound
    ? settings.customSound.replace(/^sounds\//, '')
    : '未设置（内置合成音）';
  settingEls.fxColorEnabled.checked = Boolean(settings.scoreEffectColor);
  settingEls.fxColor.disabled = !settings.scoreEffectColor;
  if (settings.scoreEffectColor) {
    if (document.activeElement !== settingEls.fxColor && settingEls.fxColor.value !== settings.scoreEffectColor) {
      settingEls.fxColor.value = settings.scoreEffectColor;
    }
  } else {
    settingEls.fxColor.value = settings.accent;
  }

  // 高级外观
  adv.fontFamily.value = settings.fontFamily || 'system';
  if (document.activeElement !== adv.fontCustom &&
    adv.fontCustom.value !== (settings.fontFamilyCustom || '')) {
    adv.fontCustom.value = settings.fontFamilyCustom || '';
  }
  adv.titleFont.value = settings.titleFont || 'auto';
  if (document.activeElement !== adv.titleFontCustom &&
    adv.titleFontCustom.value !== (settings.titleFontCustom || '')) {
    adv.titleFontCustom.value = settings.titleFontCustom || '';
  }
  updateFontCustomState();
  adv.titleAlign.value = settings.titleAlign || 'auto';
  adv.cardShadow.value = settings.cardShadow || 'auto';
  adv.avatarShape.value = settings.avatarShape || 'circle';
  adv.titleRule.checked = settings.showTitleRule !== false;
  adv.showRank.checked = settings.showRank !== false;
  adv.showScoreBar.checked = settings.showScoreBar !== false;
  adv.showTeamAccent.checked = settings.showTeamAccent !== false;

  syncAdvRange(adv.fontScale, adv.fontScaleVal, settings.fontScale, fmtNum);
  syncAdvRange(adv.titleSize, adv.titleSizeVal, settings.titleSize, fmtAuto);
  syncAdvRange(adv.boardMax, adv.boardMaxVal, settings.boardMaxWidth, fmtNum);
  syncAdvRange(adv.cardGap, adv.cardGapVal, settings.cardGap, fmtAuto);
  syncAdvRange(adv.cardPad, adv.cardPadVal, settings.cardPad, fmtAuto);
  syncAdvRange(adv.cardBorderWidth, adv.cardBorderWidthVal, settings.cardBorderWidth, fmtNum);
  syncAdvRange(adv.teamBarWidth, adv.teamBarVal, settings.teamAccentWidth, fmtNum);
  syncAdvRange(adv.avatarBorderWidth, adv.avatarBorderVal, settings.avatarBorderWidth, fmtNum);
  syncAdvRange(adv.rankSize, adv.rankSizeVal, settings.rankSize, fmtNum);
  syncAdvRange(adv.scoreBarHeight, adv.scoreBarHeightVal, settings.scoreBarHeight, fmtNum);

  syncAdvColorToggle(adv.titleColorEnabled, adv.titleColor, settings.titleColor,
    settings.theme === 'light' ? '#191d23' : '#e9e5dc');
  syncAdvColorToggle(adv.cardBorderColorEnabled, adv.cardBorderColor, settings.cardBorderColor,
    settings.theme === 'light' ? '#d3d8de' : '#2b323b');
  syncAdvColorToggle(adv.textColorEnabled, adv.textColor, settings.textColor,
    settings.theme === 'light' ? '#191d23' : '#e9e5dc');
  syncAdvColorToggle(adv.rankColorEnabled, adv.rankColor, settings.rankColor, settings.accent);
  syncAdvColorToggle(adv.teamAccentColorEnabled, adv.teamAccentColor, settings.teamAccentColor, settings.accent);

  if (document.activeElement !== adv.positiveColor && adv.positiveColor.value !== settings.positiveColor) {
    adv.positiveColor.value = settings.positiveColor;
  }
  if (document.activeElement !== adv.negativeColor && adv.negativeColor.value !== settings.negativeColor) {
    adv.negativeColor.value = settings.negativeColor;
  }

  // 功能开关与演示设置
  applyFeatureVisibility(settings);
  classEls.clockPosition.value = settings.clockPosition;
  classEls.clockFormat.value = settings.clockFormat;
  classEls.clockSeconds.checked = settings.clockShowSeconds;
  classEls.clockDate.checked = settings.clockShowDate;
  if (document.activeElement !== classEls.countdownMin) {
    classEls.countdownMin.value = String(Math.max(1, Math.round(settings.countdownDurationSec)));
  }
  if (document.activeElement !== classEls.quickCdMin) {
    classEls.quickCdMin.value = String(Math.max(1, Math.round(settings.countdownDurationSec)));
  }
  classEls.countdownMode.value = settings.countdownDisplayMode || 'corner';
  classEls.countdownTheme.value = settings.countdownTheme || 'classic';
  classEls.cdShape.value = settings.countdownShape || 'circle';
  classEls.cdPosition.value = settings.countdownPosition || 'center';
  if (Number(classEls.cdSize.value) !== settings.countdownSize) {
    classEls.cdSize.value = settings.countdownSize;
  }
  classEls.cdSizeVal.textContent = settings.countdownSize;
  if (Number(classEls.cdHeight.value) !== settings.countdownHeight) {
    classEls.cdHeight.value = settings.countdownHeight;
  }
  classEls.cdHeightVal.textContent = settings.countdownHeight === 0 ? '自动' : settings.countdownHeight + ' px';
  if (Number(classEls.cdRadius.value) !== settings.countdownRadius) {
    classEls.cdRadius.value = settings.countdownRadius;
  }
  classEls.cdRadiusVal.textContent = settings.countdownRadius;
  if (Number(classEls.cdFontSize.value) !== settings.countdownFontSize) {
    classEls.cdFontSize.value = settings.countdownFontSize;
  }
  classEls.cdFontSizeVal.textContent = settings.countdownFontSize === 0
    ? '自动' : settings.countdownFontSize + ' px';
  if (Number(classEls.cdOpacity.value) !== settings.countdownOpacity) {
    classEls.cdOpacity.value = settings.countdownOpacity;
  }
  classEls.cdOpacityVal.textContent = Math.round(settings.countdownOpacity * 100);
  classEls.cdProgress.checked = settings.countdownShowProgress !== false;
  classEls.cdBackdrop.checked = settings.countdownShowBackdrop !== false;
  classEls.cdBgMode.value = settings.countdownBgMode || 'theme';
  if (document.activeElement !== classEls.cdBg) {
    const themeCard = settings.theme === 'light' ? '#ffffff' : '#1a1f26';
    const color = settings.countdownBg || themeCard;
    if (classEls.cdBg.value !== color) classEls.cdBg.value = color;
  }
  if (Number(classEls.cdBlur.value) !== settings.countdownBlur) {
    classEls.cdBlur.value = settings.countdownBlur;
  }
  classEls.cdBlurVal.textContent = settings.countdownBlur;
  updateCountdownBgControls();
  syncAdvColorToggle(classEls.cdTextEnabled, classEls.cdText, settings.countdownTextColor,
    settings.theme === 'light' ? '#191d23' : '#e9e5dc');
  classEls.lbScope.value = settings.leaderboardScope;
  if (document.activeElement !== classEls.lbLimit) classEls.lbLimit.value = String(settings.leaderboardLimit);
  classEls.lbScale.value = settings.leaderboardScale;
  classEls.lbScaleVal.textContent = String(settings.leaderboardScale);
  classEls.rankTieMode.value = settings.rankTieMode;
  if (document.activeElement !== classEls.quickPresets) {
    const presets = (settings.quickScorePresets || [1, 5, 10, -1]).join(', ');
    if (classEls.quickPresets.value !== presets) classEls.quickPresets.value = presets;
  }
  settingEls.scoreRolling.checked = settings.scoreRolling !== false;
  settingEls.sortAnimation.checked = settings.sortAnimation !== false;
  settingEls.rankChangeAnimation.checked = settings.rankChangeAnimation !== false;

  // 课堂玩法
  classEls.featureMarquee.checked = settings.featureMarquee;
  if (document.activeElement !== classEls.marqueeText &&
    classEls.marqueeText.value !== (settings.marqueeText || '')) {
    classEls.marqueeText.value = settings.marqueeText || '';
  }
  classEls.marqueePosition.value = settings.marqueePosition || 'top';
  classEls.marqueeEffect.value = settings.marqueeEffect || 'scroll';
  if (Number(classEls.marqueeFontSize.value) !== settings.marqueeFontSize) {
    classEls.marqueeFontSize.value = settings.marqueeFontSize;
  }
  classEls.marqueeFontVal.textContent = settings.marqueeFontSize === 0 ? '自动' : settings.marqueeFontSize + ' px';
  if (Number(classEls.marqueeSpeed.value) !== settings.marqueeSpeed) {
    classEls.marqueeSpeed.value = settings.marqueeSpeed;
  }
  classEls.marqueeSpeedVal.textContent = String(settings.marqueeSpeed);
  syncAdvColorToggle(classEls.marqueeColorEnabled, classEls.marqueeColor, settings.marqueeColor, settings.accent);
  syncAdvColorToggle(classEls.marqueeBgEnabled, classEls.marqueeBgColor, settings.marqueeBgColor,
    settings.theme === 'light' ? '#ffffff' : '#1a1f26');
  classEls.bgmEnabled.checked = settings.bgmEnabled;
  if (Number(classEls.bgmVolume.value) !== settings.bgmVolume) {
    classEls.bgmVolume.value = settings.bgmVolume;
  }
  classEls.bgmVolumeVal.textContent = Math.round(settings.bgmVolume * 100);
  classEls.bgmLoop.checked = settings.bgmLoop !== false;
  classEls.featureWelcome.checked = settings.featureWelcome;
  if (document.activeElement !== classEls.welcomeText &&
    classEls.welcomeText.value !== (settings.welcomeText || '')) {
    classEls.welcomeText.value = settings.welcomeText || '';
  }
  syncAdvColorToggle(classEls.welcomeBgColorEnabled, classEls.welcomeBgColor, settings.welcomeBgColor,
    settings.theme === 'light' ? '#ffffff' : '#12161c');

  // 各部件字体与字号
  partFontBindings.forEach((sync) => sync(settings));
  if (Number(classEls.clockFontSize.value) !== settings.clockFontSize) {
    classEls.clockFontSize.value = settings.clockFontSize;
  }
  classEls.clockFontSizeVal.textContent =
    settings.clockFontSize === 0 ? '自动' : settings.clockFontSize + ' px';
  if (Number(classEls.welcomeFontSize.value) !== settings.welcomeFontSize) {
    classEls.welcomeFontSize.value = settings.welcomeFontSize;
  }
  classEls.welcomeFontSizeVal.textContent =
    settings.welcomeFontSize === 0 ? '自动' : settings.welcomeFontSize + ' px';
}

// ============ 总渲染 ============
function render(project) {
  applyFeatureVisibility(project.settings);
  renderPeople(project);
  renderTeams(project);
  renderSettings(project.settings);
}
