'use strict';
// 单实例锁：防止两个进程同时写同一份状态（JSON/SQLite 的 lost update）
const fs = require('fs');
const path = require('path');
const { logger } = require('./logger');
const { config } = require('./config');

let lockFile = null;

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM'; // 存在但属于其他用户
  }
}

function acquire(dataDir) {
  if (config.allowMultiInstance) return;
  const file = path.join(dataDir, 'scoreboard.lock');
  const write = () => {
    const fd = fs.openSync(file, 'wx');
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
    fs.closeSync(fd);
    lockFile = file;
  };

  try {
    write();
    return;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }

  let pid = NaN;
  try {
    pid = Number(JSON.parse(fs.readFileSync(file, 'utf8')).pid);
  } catch (_) {}

  if (pidAlive(pid)) {
    throw new Error(
      `数据目录已被进程 ${pid} 占用（${file}）。` +
        '如需强制多实例，请设置 ALLOW_MULTI_INSTANCE=1（可能导致数据覆盖）。',
    );
  }

  // 进程已不存在：清理陈旧锁后重试
  try { fs.unlinkSync(file); } catch (_) {}
  write();
  logger.warn('已清理陈旧实例锁', { pid });
}

function release() {
  if (!lockFile) return;
  try { fs.unlinkSync(lockFile); } catch (_) {}
  lockFile = null;
}

process.on('exit', release);

module.exports = { acquire, release };
