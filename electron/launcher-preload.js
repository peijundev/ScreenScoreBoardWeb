'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ssbLauncher', {
  get: () => ipcRenderer.invoke('ssb:launcher:get'),
  local: () => ipcRenderer.invoke('ssb:launcher:local'),
  remote: (config) => ipcRenderer.invoke('ssb:launcher:remote', config),
  display: (config) => ipcRenderer.invoke('ssb:launcher:display', config),
  quit: () => ipcRenderer.invoke('ssb:launcher:quit'),
});
