'use strict';
// 上传资源命名：保留用户导入时的文件名（清洗后），冲突时追加序号。
const fs = require('fs');
const path = require('path');

/** 资产路径段允许的字符：Unicode 字母/数字、下划线、连字符、点 */
const ASSET_NAME_RE = /^[\p{L}\p{N}_.-]+$/u;

/** 完整资产引用路径：avatars/xxx 或 sounds/xxx */
const ASSET_KEY_RE = /^(avatars|sounds)\/[\p{L}\p{N}_.-]+$/u;

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
const AUDIO_EXT = ['wav', 'ogg', 'mp3', 'm4a'];

function assetPathRe(kind) {
  return new RegExp('^' + kind + '/[\\p{L}\\p{N}_.-]+$', 'u');
}

/** 前端通过 X-File-Name（encodeURIComponent）传入原始文件名 */
function decodeOriginalName(req) {
  const raw = req && req.headers ? req.headers['x-file-name'] : '';
  if (!raw) return '';
  try {
    return decodeURIComponent(String(raw));
  } catch (_) {
    return String(raw);
  }
}

function safeBaseName(rawName, fallback) {
  let base = String(rawName || '').split(/[\\/]/).pop() || '';
  base = base.replace(/\.[^.]+$/, '');
  base = base
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base || fallback;
}

/**
 * 生成目录内不冲突的文件名。调用方随后同步写盘，
 * 保证 exists 检查与写入之间不会被其他上传请求插入。
 */
function uniqueFileName(dir, rawName, ext, fallback) {
  const base = safeBaseName(rawName, fallback);
  let name = base + '.' + ext;
  let index = 1;
  while (fs.existsSync(path.join(dir, name))) {
    name = base + '-' + index + '.' + ext;
    index += 1;
  }
  return name;
}

/** 资源列表/清理用的文件名匹配（扩展名白名单） */
function assetFileRe(exts) {
  return new RegExp('^[\\p{L}\\p{N}_.-]+\\.(' + exts.join('|') + ')$', 'iu');
}

module.exports = {
  ASSET_NAME_RE,
  ASSET_KEY_RE,
  IMAGE_EXT,
  AUDIO_EXT,
  assetPathRe,
  assetFileRe,
  decodeOriginalName,
  safeBaseName,
  uniqueFileName,
};
