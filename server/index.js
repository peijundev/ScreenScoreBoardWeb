'use strict';
// 入口：http server、路由表、头像上传、挂载 WebSocket
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { serveStatic, send, PUBLIC_DIR } = require('./static');
const { state, init: initState, AVATAR_DIR, storageKind } = require('./state');
const { attachWSS } = require('./wss');

const PORT = Number(process.env.PORT) || 3000;
const MAX_UPLOAD = 2 * 1024 * 1024; // 2 MB

// 魔数 → 扩展名（不信任客户端声明的 Content-Type）
function sniffImage(buf) {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 4 && buf.toString('ascii', 0, 4) === 'GIF8') return 'gif';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

function handleAvatarUpload(req, res) {
  const chunks = [];
  let size = 0;
  let aborted = false;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_UPLOAD) {
      aborted = true;
      send(res, 413, JSON.stringify({ error: '文件超过 2MB 上限' }), { 'Content-Type': 'application/json' });
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => {
    if (aborted) return;
    const buf = Buffer.concat(chunks);
    if (buf.length === 0) {
      return send(res, 400, JSON.stringify({ error: '空文件' }), { 'Content-Type': 'application/json' });
    }
    const ext = sniffImage(buf);
    if (!ext) {
      return send(res, 415, JSON.stringify({ error: '仅支持 png/jpeg/webp/gif 图片' }), { 'Content-Type': 'application/json' });
    }
    const name = crypto.randomBytes(8).toString('hex') + '.' + ext;
    fs.writeFileSync(path.join(AVATAR_DIR, name), buf);
    send(res, 200, JSON.stringify({ path: 'avatars/' + name }), { 'Content-Type': 'application/json' });
  });
  req.on('error', () => {});
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (req.method === 'GET' && p === '/') {
    res.writeHead(302, { Location: '/display' });
    return res.end();
  }
  if (req.method === 'GET' && (p === '/display' || p === '/admin')) {
    if (serveStatic(res, PUBLIC_DIR, p + '.html')) return;
  }
  if (req.method === 'GET' && p === '/api/state') {
    return send(res, 200, JSON.stringify(state), { 'Content-Type': 'application/json' });
  }
  if (req.method === 'POST' && p === '/api/avatar') {
    return handleAvatarUpload(req, res);
  }
  if (req.method === 'GET' && p.startsWith('/avatars/')) {
    if (serveStatic(res, AVATAR_DIR, p.slice('/avatars'.length))) return;
    return send(res, 404, 'Not Found');
  }
  if (req.method === 'GET' && /\.[a-z0-9]+$/i.test(p)) {
    if (serveStatic(res, PUBLIC_DIR, p)) return;
    return send(res, 404, 'Not Found');
  }
  send(res, 404, 'Not Found');
});

async function main() {
  await initState();
  attachWSS(server);
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`计分板服务已启动（存储: ${storageKind}）:`);
    console.log(`  显示端  http://localhost:${PORT}/display`);
    console.log(`  管理端  http://localhost:${PORT}/admin`);
  });
}

main().catch((e) => {
  console.error('[启动失败]', e.message);
  process.exit(1);
});
