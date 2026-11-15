'use strict';
// 运行时状态（仅内存）：撤销栈 + 倒计时 + 运行态快照
const UNDO_LIMIT = 50;

const undoStacks = new Map();   // projectId -> [{ label, entries, at }]
const countdowns = new Map();   // projectId -> { state, durationMs, endsAt, remainingMs, endedAt, timer }

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
}

// ---------- 广播快照 ----------
function getRuntimeSnapshot() {
  const undoCounts = {};
  for (const [projectId, stack] of undoStacks) {
    if (stack.length) undoCounts[projectId] = stack.length;
  }
  const snapshotCountdowns = {};
  for (const [projectId, entry] of countdowns) {
    snapshotCountdowns[projectId] = compactCountdown(entry);
  }
  return {
    undoCounts,
    countdowns: snapshotCountdowns,
    serverNow: Date.now(),
  };
}

module.exports = {
  UNDO_LIMIT,
  pushUndo,
  popUndo,
  undoCount,
  clearUndo,
  startCountdown,
  pauseCountdown,
  resumeCountdown,
  resetCountdown,
  getCountdown,
  clearProjectRuntime,
  getRuntimeSnapshot,
  setBroadcaster,
};
