/* global window */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ssbShell', {
  isElectron: true,
  returnToLauncher: () => ipcRenderer.invoke('ssb:shell:return-to-launcher'),
});

// 浏览器式缩放：Ctrl/Cmd + 滚轮由主进程处理
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
