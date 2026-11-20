#!/usr/bin/env node
'use strict';
// 本机密码恢复：服务停止后重置用户密码，或在零用户时补建管理员
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { DATA_DIR } = require('../server/state');
const store = require('../server/auth/store');
const { assertPasswordPolicy } = require('../server/auth/passwords');

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

function assertServiceStopped() {
  const lockFile = path.join(DATA_DIR, 'scoreboard.lock');
  if (!fs.existsSync(lockFile)) return;
  let pid = NaN;
  try {
    pid = Number(JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid);
  } catch (_) {
    return;
  }
  if (pidAlive(pid)) {
    console.error('服务仍在运行（PID ' + pid + '）。请先停止服务再重置密码，避免内存状态覆盖文件。');
    process.exit(1);
  }
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function askHidden(question) {
  if (!process.stdin.isTTY) {
    return ask(question);
  }
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    let value = '';
    stdin.resume();
    stdin.setRawMode(true);
    const onData = (buffer) => {
      const text = buffer.toString('utf8');
      for (const ch of text) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u0003') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') {
          value = value.slice(0, -1);
        } else {
          value += ch;
        }
      }
    };
    stdin.on('data', onData);
  });
}

async function main() {
  assertServiceStopped();
  store.init({ enabled: true, bootstrap: false });

  const users = store.listUsers();
  let username = '';
  const argIndex = process.argv.indexOf('--username');
  if (argIndex > 0 && process.argv[argIndex + 1]) {
    username = process.argv[argIndex + 1];
  } else if (users.length === 0) {
    username = (await ask('管理员用户名 [admin]：')).trim() || 'admin';
  } else {
    console.log('现有用户：' + users.map((user) => user.username + '（' + user.role + '）').join('、'));
    username = (await ask('要重置密码的用户名：')).trim();
  }
  if (!username) {
    console.error('用户名不能为空');
    process.exit(1);
  }

  let password = process.env.AUTH_RESET_PASSWORD || '';
  if (!password) {
    password = await askHidden('新密码（至少 8 位）：');
    const confirm = await askHidden('确认新密码：');
    if (password !== confirm) {
      console.error('两次输入的密码不一致');
      process.exit(1);
    }
  }
  try {
    assertPasswordPolicy(password);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  const hash = await store.hashPassword(password);
  const user = store.findUserByUsername(username);
  if (user) {
    store.setUserPassword(user.id, hash);
    console.log('已重置「' + user.username + '」的密码，并吊销其全部会话与令牌。');
  } else if (users.length === 0) {
    store.createUser({
      username,
      passwordHash: hash,
      role: 'admin',
      displayName: username,
    });
    console.log('已创建管理员「' + username + '」。');
  } else {
    console.error('用户不存在：' + username);
    process.exit(1);
  }
  store.flush();
  process.exit(0);
}

main().catch((error) => {
  console.error('重置失败：' + (error && error.message ? error.message : String(error)));
  process.exit(1);
});
