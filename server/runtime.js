'use strict';
// 运行时状态（仅内存）：撤销栈 + 倒计时 + 运行态快照
const UNDO_LIMIT = 50;

const undoStacks = new Map();   // projectId -> [{ label, entries, at }]
const countdowns = new Map();   // projectId -> { state, durationMs, endsAt, remainingMs, endedAt, timer }
const scoreLogs = new Map();    // projectId -> [{ at, label, delta }]
const spotlightEvents = new Map(); // projectId -> [{ seq, targetType, targetId, at, durationMs? }]

const SCORE_LOG_LIMIT = 200;
const SPOTLIGHT_EVENT_LIMIT = 20;
let spotlightSeq = 0;

let broadcast = () => {};
function setBroadcaster(fn) {
  broadcast = typeof fn === 'function' ? fn : () => {};
}
function notify() {
  try { broadcast(); } catch (_) {}
}

// ---------- 撤销栈 ----------
function pushUndo(projectId, label, entries) {
  if (!projectId || !entries || !entries.length) return;
  const stack = undoStacks.get(projectId) || [];
  stack.push({ label, entries, at: Date.now() });
  while (stack.length > UNDO_LIMIT) stack.shift();
  undoStacks.set(projectId, stack);
}

function popUndo(projectId) {
  const stack = undoStacks.get(projectId);
  if (!stack || !stack.length) return null;
  const entry = stack.pop();
  if (!stack.length) undoStacks.delete(projectId);
  return entry;
}

function undoCount(projectId) {
  const stack = undoStacks.get(projectId);
  return stack ? stack.length : 0;
}

function clearUndo(projectId) {
  undoStacks.delete(projectId);
}

// 撤销到剩余 keep 条：返回被撤销的 entry 列表（最新在前）
function undoTo(projectId, keep) {
  const stack = undoStacks.get(projectId);
  if (!stack || stack.length <= keep) return [];
  const undone = [];
  while (stack.length > keep) undone.push(stack.pop());
  if (!stack.length) undoStacks.delete(projectId);
  return undone;
}

function undoLabels(projectId, n) {
  const stack = undoStacks.get(projectId);
  if (!stack || !stack.length) return [];
  return stack.slice(-n).map((entry, i) => ({
    index: stack.length - n + i,
    label: entry.label,
  })).reverse();
}

// ---------- 分数日志 ----------
function pushScoreLog(projectId, label, delta) {
  if (!projectId) return;
  const logs = scoreLogs.get(projectId) || [];
  logs.push({ at: Date.now(), label, delta });
  while (logs.length > SCORE_LOG_LIMIT) logs.shift();
  scoreLogs.set(projectId, logs);
}

function getScoreLogs(projectId, n) {
  const logs = scoreLogs.get(projectId);
  if (!logs || !logs.length) return [];
  return logs.slice(-n).reverse();
}

// ---------- 纯突显事件（不加分） ----------
function pushSpotlight(projectId, event) {
  if (!projectId) return null;
  const entry = {
    seq: ++spotlightSeq,
    targetType: event.targetType,
    targetId: event.targetId,
    at: Date.now(),
  };
  if (Number.isFinite(event.durationMs) && event.durationMs > 0) entry.durationMs = event.durationMs;
  const list = spotlightEvents.get(projectId) || [];
  list.push(entry);
  while (list.length > SPOTLIGHT_EVENT_LIMIT) list.shift();
  spotlightEvents.set(projectId, list);
  return entry;
}

function getSpotlightEvents(projectId) {
  return spotlightEvents.get(projectId) || [];
}

// ---------- 倒计时 ----------
function stopTimer(entry) {
  if (entry && entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
}

function armTimer(projectId, entry) {
  stopTimer(entry);
  const delay = Math.max(0, entry.endsAt - Date.now());
  const timer = setTimeout(() => {
    const current = countdowns.get(projectId);
    if (!current || current !== entry) return;
    current.state = 'ended';
    current.remainingMs = 0;
    current.endedAt = Date.now();
    current.endsAt = 0;
    current.timer = null;
    notify();
  }, delay);
  if (typeof timer.unref === 'function') timer.unref();
  entry.timer = timer;
}

function startCountdown(projectId, durationMs, remainingMs) {
  const entry = countdowns.get(projectId);
  const total = remainingMs != null ? remainingMs : durationMs;
  const fresh = {
    state: 'running',
    durationMs,
    endsAt: Date.now() + total,
    remainingMs: total,
    endedAt: 0,
    timer: null,
  };
  if (entry) stopTimer(entry);
  countdowns.set(projectId, fresh);
  armTimer(projectId, fresh);
  return compactCountdown(fresh);
}

function pauseCountdown(projectId) {
  const entry = countdowns.get(projectId);
  if (!entry || entry.state !== 'running') return null;
  const remaining = Math.max(0, entry.endsAt - Date.now());
  stopTimer(entry);
  entry.state = remaining > 0 ? 'paused' : 'ended';
  entry.remainingMs = remaining;
  if (entry.state === 'ended') {
    entry.endedAt = Date.now();
    entry.endsAt = 0;
  }
  return compactCountdown(entry);
}

function resumeCountdown(projectId) {
  const entry = countdowns.get(projectId);
  if (!entry || entry.state !== 'paused' || entry.remainingMs <= 0) return null;
  entry.state = 'running';
  entry.endsAt = Date.now() + entry.remainingMs;
  entry.endedAt = 0;
  armTimer(projectId, entry);
  return compactCountdown(entry);
}

function resetCountdown(projectId) {
  const entry = countdowns.get(projectId);
  if (entry) stopTimer(entry);
  countdowns.delete(projectId);
}

function getCountdown(projectId) {
  const entry = countdowns.get(projectId);
  return entry ? compactCountdown(entry) : null;
}

function compactCountdown(entry) {
  return {
    state: entry.state,
    durationMs: entry.durationMs,
    endsAt: entry.endsAt || 0,
    remainingMs: entry.remainingMs || 0,
    endedAt: entry.endedAt || 0,
  };
}

// ---------- 项目清理 ----------
function clearProjectRuntime(projectId) {
  resetCountdown(projectId);
  clearUndo(projectId);
  scoreLogs.delete(projectId);
  spotlightEvents.delete(projectId);
}

// ---------- 广播快照 ----------
function getRuntimeSnapshot() {
  const undoCounts = {};
  const undoLabelsMap = {};
  for (const [projectId, stack] of undoStacks) {
    if (stack.length) {
      undoCounts[projectId] = stack.length;
      undoLabelsMap[projectId] = undoLabels(projectId, 10);
    }
  }
  const snapshotCountdowns = {};
  for (const [projectId, entry] of countdowns) {
    snapshotCountdowns[projectId] = compactCountdown(entry);
  }
  const snapshotLogs = {};
  for (const [projectId] of scoreLogs) {
    snapshotLogs[projectId] = getScoreLogs(projectId, 50);
  }
  const snapshotSpotlights = {};
  for (const [projectId, events] of spotlightEvents) {
    if (events.length) snapshotSpotlights[projectId] = events.slice();
  }
  return {
    undoCounts,
    undoLabels: undoLabelsMap,
    scoreLogs: snapshotLogs,
    countdowns: snapshotCountdowns,
    spotlightEvents: snapshotSpotlights,
    serverNow: Date.now(),
  };
}

module.exports = {
  UNDO_LIMIT,
  pushUndo,
  popUndo,
  undoTo,
  undoCount,
  undoLabels,
  clearUndo,
  pushScoreLog,
  getScoreLogs,
  pushSpotlight,
  getSpotlightEvents,
  startCountdown,
  pauseCountdown,
  resumeCountdown,
  resetCountdown,
  getCountdown,
  clearProjectRuntime,
  getRuntimeSnapshot,
  setBroadcaster,
};
