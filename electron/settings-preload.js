'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ssbConfig', {
  get: () => ipcRenderer.invoke('ssb:config:get'),
  test: (url) => ipcRenderer.invoke('ssb:config:test', url),
  save: (config) => ipcRenderer.invoke('ssb:config:save', config),
});
