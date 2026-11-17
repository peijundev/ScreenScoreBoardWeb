'use strict';
// 静态文件服务：public/ 与 data/avatars/，防路径穿越
const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
};

// 从 baseDir 中安全地取文件；越界返回 null
function resolveSafe(baseDir, urlPath) {
  const rel = decodeURIComponent(urlPath).replace(/^\/+/, '');
  const full = path.normalize(path.join(baseDir, rel));
  if (!full.startsWith(baseDir + path.sep) && full !== baseDir) return null;
  return full;
}

function send(res, code, body, headers = {}) {
  res.writeHead(code, headers);
  res.end(body);
}

// 尝试服务静态文件；命中返回 true，否则 false
function serveStatic(res, baseDir, urlPath) {
  const full = resolveSafe(baseDir, urlPath);
  if (!full) { send(res, 400, 'Bad Request'); return true; }
  let stat;
  try { stat = fs.statSync(full); } catch (_) { return false; }
  if (!stat.isFile()) return false;
  const mime = MIME[path.extname(full).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mime, 'Content-Length': stat.size, 'Cache-Control': 'no-cache' });
  fs.createReadStream(full).pipe(res);
  return true;
}

module.exports = { serveStatic, send, PUBLIC_DIR };
