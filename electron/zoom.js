'use strict';
// 浏览器式缩放的纯函数：范围、步进与快捷键解析，便于在 Node 测试中直接验证

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
// 每档 10%，便于在电视/投影上微调
const ZOOM_STEP = 0.1;

function clampZoom(factor) {
  const value = Number(factor);
  if (!Number.isFinite(value)) return 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value));
}

/** command: 'in' | 'out' | 'reset' */
function nextZoom(current, command) {
  if (command === 'reset') return 1;
  if (command !== 'in' && command !== 'out') return clampZoom(current);
  const delta = command === 'in' ? ZOOM_STEP : -ZOOM_STEP;
  return Math.round(clampZoom(clampZoom(current) + delta) * 100) / 100;
}

/** 从 before-input-event 的 input 解析缩放命令；不是缩放快捷键时返回 null */
function zoomCommand(input, platform = process.platform) {
  if (!input || input.type !== 'keyDown') return null;
  const modifier = platform === 'darwin' ? input.meta : input.control;
  if (!modifier || input.alt) return null;
  const key = String(input.key == null ? '' : input.key);
  if (key === '0') return 'reset';
  if (key === '=' || key === '+' || key === 'Add') return 'in';
  if (key === '-' || key === '_' || key === 'Subtract') return 'out';
  return null;
}

module.exports = {
  ZOOM_MIN,
  ZOOM_MAX,
  ZOOM_STEP,
  clampZoom,
  nextZoom,
  zoomCommand,
};
