'use strict';
// 通用校验辅助（不依赖具体状态）
class OpError extends Error {}

function needString(v, field, max = 40) {
  if (typeof v !== 'string' || !v.trim()) throw new OpError(`${field}不能为空`);
  if (v.trim().length > max) throw new OpError(`${field}过长（最多 ${max} 字）`);
  return v.trim();
}
function needAvatar(v) {
  if (v == null) return null;
  if (typeof v !== 'string' || !/^avatars\/[\w.-]+$/.test(v)) throw new OpError('头像路径非法');
  return v;
}
function needBio(v) {
  if (v == null || v === '') return '';
  if (typeof v !== 'string') throw new OpError('简介必须是字符串');
  const text = v.trim();
  if (text.length > 60) throw new OpError('简介过长（最多 60 字）');
  return text;
}
function needScore(v, field) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new OpError(`${field}必须是数字`);
  return Math.max(-10000, Math.min(10000, Math.round(n)));
}
function needLayout(l) {
  if (!l || typeof l !== 'object') throw new OpError('布局参数非法');
  const num = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new OpError('布局参数非法');
    return Math.round(n * 100) / 100;
  };
  let x = num(l.x), y = num(l.y), w = num(l.w), h = num(l.h);
  w = Math.max(4, Math.min(200, w));
  h = Math.max(3, Math.min(200, h));
  x = Math.max(-100, Math.min(200, x));
  y = Math.max(-100, Math.min(200, y));
  return { x, y, w, h };
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function hexOrEmpty(v, message) {
  if (v === '' || v == null) return '';
  if (HEX_COLOR.test(v)) return v;
  throw new OpError(message);
}
function intRange(v, lo, hi, message) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) throw new OpError(message);
  return n;
}
function boolStrict(v, label) {
  if (typeof v !== 'boolean') throw new OpError(label + '须为布尔值');
  return v;
}
function fontNameOrEmpty(v) {
  if (v == null || v === '') return '';
  if (typeof v !== 'string') throw new OpError('字体名称非法');
  const name = v.trim();
  if (!name) return '';
  if (name.length > 60) throw new OpError('字体名称过长（最多 60 字）');
  if (!/^[\p{L}\p{N} ._-]+$/u.test(name)) throw new OpError('字体名称包含非法字符');
  return name;
}
function fontChoice(label) {
  return (v) => (['auto', 'system', 'serif', 'kai', 'custom'].includes(v)
    ? v
    : (() => { throw new OpError(label + '非法'); })());
}

module.exports = {
  OpError, needString, needAvatar, needBio, needScore, needLayout,
  HEX_COLOR, hexOrEmpty, intRange, boolStrict, fontNameOrEmpty, fontChoice,
};
