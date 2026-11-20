'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ssbShell', {
  isElectron: true,
  returnToLauncher: () => ipcRenderer.invoke('ssb:shell:return-to-launcher'),
});
