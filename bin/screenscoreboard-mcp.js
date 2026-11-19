#!/usr/bin/env node
'use strict';
// MCP stdio 入口：通过 SCOREBOARD_URL 连接已运行的计分板服务
const { startStdio, baseUrl } = require('../server/mcp/stdio');

const url = baseUrl();
fetch(url.replace(/\/$/, '') + '/api/v1/health', { headers: { Accept: 'application/json' } })
  .then((res) => {
    if (!res.ok) throw new Error('HTTP ' + res.status);
    startStdio();
  })
  .catch((error) => {
    process.stderr.write(
      `[screenscoreboard-mcp] 无法连接 ${url}/api/v1/health：${error.message}\n` +
      '请先启动计分板服务，或用 SCOREBOARD_URL 指向正确地址。\n'
    );
    process.exit(1);
  });
