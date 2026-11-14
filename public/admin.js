'use strict';
/* global avatarURL, connectWS, uploadAvatar, uploadSound, escapeHTML */
/* 管理端：所有操作经 WS op，渲染由广播驱动（不做乐观更新） */

let currentState = null;
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
};

let previewEdit = false;
let previewZoom = 1;
let previewResolutionValue = '1920x1080';
try {
  previewResolutionValue = localStorage.getItem('previewResolution') || '1920x1080';
  previewZoom = Number(localStorage.getItem('previewZoom')) || 1;
} catch (_) {}
previewResolution.value = previewResolutionValue;
let toastTimer = null;

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 2600);
}

const conn = connectWS(
  (state) => {
    currentState = state;
    const project = currentProject();
    if (!project) return;
    syncProjectUI(state);
    render(project);
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
  placeSettingsDialog();
});
settingsCloseBtn.addEventListener('click', () => settingsDialog.close());

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && settingsDialog.open) settingsDialog.close();
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
  const width = settingsDialog.offsetWidth;
  const left = clampNum(e.clientX - dialogDrag.dx, 4, Math.max(4, window.innerWidth - width - 4));
  const top = clampNum(e.clientY - dialogDrag.dy, 4, Math.max(4, window.innerHeight - 44));
  settingsDialog.style.left = left + 'px';
  settingsDialog.style.top = top + 'px';
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

// ============ 预览：固定分辨率复刻 + 缩放 ============
function applyPreviewLayout() {
  previewZoom = Math.min(1.6, Math.max(0.5, Math.round(previewZoom * 100) / 100));
  previewZoomLabel.textContent = Math.round(previewZoom * 100) + '%';
  try { localStorage.setItem('previewZoom', String(previewZoom)); } catch (_) {}

  if (previewResolutionValue === 'auto') {
    previewStage.style.width = '100%';
    previewStage.style.height = '100%';
    previewFrame.style.width = '100%';
    previewFrame.style.height = '100%';
    previewFrame.style.transform = '';
    previewFrame.style.zoom = String(previewZoom);
    return;
  }

  const [w, h] = previewResolutionValue.split('x').map(Number);
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
  previewResolutionValue = previewResolution.value;
  try { localStorage.setItem('previewResolution', previewResolutionValue); } catch (_) {}
  applyPreviewLayout();
});
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
  };
  const [sortBy, sortOrder] = map[quick.sort.value] || ['score', 'desc'];
  projectOp('updateSettings', { patch: { sortBy, sortOrder } }).catch((e) => toast(e.message));
});
quick.edit.addEventListener('change', () => {
  previewEdit = quick.edit.checked;
  if (currentState) syncProjectUI(currentState);
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
  const people = Object.values(project.people).sort((a, b) => a.createdAt - b.createdAt);
  if (!people.length) {
    list.innerHTML = '<p style="color:var(--text-dim);font-size:13px">暂无人员，先添加一个吧</p>';
    return;
  }
  list.innerHTML = people.map((p) => {
    const teamOptions = '<option value="">无团队</option>' + Object.values(project.teams).map((t) =>
      '<option value="' + t.id + '"' + (p.teamId === t.id ? ' selected' : '') + '>' + escapeHTML(t.name) + '</option>'
    ).join('');
    return (
      '<div class="person-row" data-id="' + p.id + '">' +
        '<img src="' + avatarURL(p, 48) + '" alt="">' +
        '<span class="p-name">' + escapeHTML(p.name) + '</span>' +
        '<span class="p-score ' + scoreClass(p.score) + '">' + p.score + '</span>' +
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
    row.querySelector('.person-del').addEventListener('click', () => {
      const p = currentProject().people[id];
      if (p && confirm('确定删除「' + p.name + '」？')) doOp('removePerson', { personId: id });
    });
  });
}

// ============ 团队面板 ============
function renderTeams(project) {
  const list = document.getElementById('teams-list');
  const teams = Object.values(project.teams).sort((a, b) => a.createdAt - b.createdAt);
  if (!teams.length) {
    list.innerHTML = '<p style="color:var(--text-dim);font-size:13px">暂无团队</p>';
    return;
  }
  list.innerHTML = teams.map((t) => {
    const members = Object.values(project.people).filter((p) => p.teamId === t.id);
    const total = members.reduce((s, m) => s + m.score, 0);
    const chips = members.map((m) =>
      '<span class="chip"><img src="' + avatarURL(m, 24) + '" alt="">' +
      escapeHTML(m.name) +
      '<span class="x" data-person="' + m.id + '" title="移出团队">×</span></span>'
    ).join('') || '<span style="color:var(--text-dim);font-size:13px">暂无成员（在人员列表中选择团队加入）</span>';
    return (
      '<div class="team-block" data-id="' + t.id + '">' +
        '<div class="team-top">' +
          '<img src="' + avatarURL(t, 48) + '" alt="">' +
          '<span class="t-name">' + escapeHTML(t.name) + '</span>' +
          '<span class="t-total">' + total + ' 分</span>' +
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
const soundVolumeVal = document.getElementById('sound-volume-val');
const resetLayoutBtn = document.getElementById('reset-layout');

// ---- 高级外观控件 ----
const adv = {
  fontFamily: document.getElementById('set-font-family'),
  fontScale: document.getElementById('set-font-scale'),
  fontScaleVal: document.getElementById('font-scale-val'),
  titleSize: document.getElementById('set-title-size'),
  titleSizeVal: document.getElementById('title-size-val'),
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
  scrimOpacity: document.getElementById('set-scrim-opacity'),
  scrimOpacityVal: document.getElementById('scrim-opacity-val'),
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
  [adv.scrimOpacity, adv.scrimOpacityVal, 'scrimOpacity', fmtPercent],
  [adv.rankSize, adv.rankSizeVal, 'rankSize', fmtNum],
  [adv.scoreBarHeight, adv.scoreBarHeightVal, 'scoreBarHeight', fmtNum],
];
advRanges.forEach(([input, label, key, fmt]) => {
  input.addEventListener('input', () => {
    label.textContent = fmt(input.value);
    pushSetting(key, Number(input.value));
  });
});

[[adv.fontFamily, 'fontFamily'], [adv.titleAlign, 'titleAlign'],
  [adv.cardShadow, 'cardShadow'], [adv.avatarShape, 'avatarShape']]
  .forEach(([input, key]) => {
    input.addEventListener('change', () => pushSetting(key, input.value, true));
  });

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
  const sortKey = settings.sortBy + '_' + settings.sortOrder;
  if (['score_desc', 'score_asc', 'created_asc', 'created_desc'].includes(sortKey)) {
    quick.sort.value = sortKey;
  }
  if (document.activeElement !== quick.accent && quick.accent.value !== settings.accent) {
    quick.accent.value = settings.accent;
  }
  settingEls.density.value = settings.density;
  settingEls.sortBy.value = settings.sortBy;
  settingEls.sortOrder.value = settings.sortOrder;
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
  syncAdvRange(adv.scrimOpacity, adv.scrimOpacityVal, settings.scrimOpacity, fmtPercent);
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
}

// ============ 总渲染 ============
function render(project) {
  renderPeople(project);
  renderTeams(project);
  renderSettings(project.settings);
}
