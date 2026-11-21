'use strict';
// 数据目录的单一来源：所有需要落盘位置的模块都从这里取，避免各自读取环境变量。
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const AVATAR_DIR = path.join(DATA_DIR, 'avatars');
const SOUND_DIR = path.join(DATA_DIR, 'sounds');
const STORAGE_CONFIG_FILE = path.join(DATA_DIR, 'storage.json');
const LOCK_FILE = path.join(DATA_DIR, 'scoreboard.lock');
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(DATA_DIR, 'backups');

module.exports = {
  DATA_DIR,
  AVATAR_DIR,
  SOUND_DIR,
  STORAGE_CONFIG_FILE,
  LOCK_FILE,
  BACKUP_DIR,
};
