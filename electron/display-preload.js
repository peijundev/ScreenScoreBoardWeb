/* global window */
'use strict';
// 显示端 preload：把 Ctrl/Cmd + 滚轮转成缩放命令。
// 不向页面暴露任何 API，只监听 wheel 事件。
const { ipcRenderer } = require('electron');

window.addEventListener(
  'wheel',
  (event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    if (!event.deltaY) return;
    event.preventDefault();
    ipcRenderer.send('ssb:zoom', event.deltaY < 0 ? 'in' : 'out');
  },
  { passive: false },
);
