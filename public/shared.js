'use strict';
/* 两端共用：WS 客户端（断线重连）、回退头像、HTML 转义 */

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// 名字 hash → 固定调色板取色，保证同人同色
const AVATAR_COLORS = [
  '#e05252', '#e08a3c', '#d8b93c', '#5cb85c',
  '#3ca6a6', '#4f8cff', '#7a5cd6', '#c75ba8',
];
function nameColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

// 有上传头像用头像，否则生成 SVG data URI（姓名首字符 + 彩色底）
function avatarURL(entity, size) {
  if (entity && entity.avatar) return '/' + entity.avatar;
  const name = (entity && entity.name) || '?';
  const ch = Array.from(name)[0] || '?';
  const color = nameColor(name);
  const s = size || 96;
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + s + '" height="' + s + '">' +
    '<rect width="100%" height="100%" rx="50%" fill="' + color + '"/>' +
    '<text x="50%" y="50%" dy="0.35em" text-anchor="middle" font-size="' + Math.round(s * 0.48) +
    '" fill="#fff" font-family="sans-serif">' + escapeHTML(ch) + '</text></svg>';
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}

// WebSocket 封装：指数退避重连，onState(全量状态) / onStatus('connected'|'connecting')
function connectWS(onState, onStatus) {
  let delay = 1000;
  let ws = null;
  let reqSeq = 0;
  const pending = new Map(); // reqId -> {resolve, reject}

  function connect() {
    if (onStatus) onStatus('connecting');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(proto + '://' + location.host + '/ws');

    ws.onopen = () => { delay = 1000; if (onStatus) onStatus('connected'); };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      if (msg.type === 'state') { onState(msg.data); return; }
      if (msg.type === 'ack' && msg.reqId != null && pending.has(msg.reqId)) {
        const p = pending.get(msg.reqId);
        pending.delete(msg.reqId);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(msg.error || '操作失败'));
      }
    };
    ws.onclose = () => {
      for (const p of pending.values()) p.reject(new Error('连接已断开'));
      pending.clear();
      if (onStatus) onStatus('connecting');
      setTimeout(connect, delay);
      delay = Math.min(delay * 2, 15000);
    };
    ws.onerror = () => { try { ws.close(); } catch (_) {} };
  }
  connect();

  // 发送操作，返回 Promise（ack 成功/失败）
  function sendOp(op, payload) {
    return new Promise((resolve, reject) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return reject(new Error('未连接到服务器'));
      }
      const reqId = 'r' + (++reqSeq) + '_' + Math.random().toString(36).slice(2, 8);
      pending.set(reqId, { resolve, reject });
      ws.send(JSON.stringify({ type: 'op', reqId, op, payload }));
    });
  }
  return { sendOp };
}

// 上传头像：POST 裸二进制，返回服务端 path
async function uploadAvatar(file) {
  const res = await fetch('/api/avatar', {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('上传失败 (' + res.status + ')'));
  return data.path;
}
