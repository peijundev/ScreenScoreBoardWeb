#!/usr/bin/env node
'use strict';
// npm 包 CLI 入口：启动计分板服务
const { start } = require('../server/index');

start().catch((e) => {
  console.error('[启动失败]', e && e.message ? e.message : e);
  process.exit(1);
});
