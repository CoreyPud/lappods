'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lappods', {
  readLibrary: () => ipcRenderer.invoke('library:read'),
  scanFiles: (options) => ipcRenderer.invoke('scanner:scan', options),
  listDrives: () => ipcRenderer.invoke('drives:list'),
  chooseFolder: () => ipcRenderer.invoke('drives:choose'),
  listDevice: (mountPoint) => ipcRenderer.invoke('device:list', mountPoint),
  deviceIndex: (mountPoint) => ipcRenderer.invoke('device:index', mountPoint),
  removeFromDevice: (mountPoint, paths) =>
    ipcRenderer.invoke('device:remove', { mountPoint, paths }),
  exportEpisodes: (items, options) =>
    ipcRenderer.invoke('export:run', { items, options }),
  revealInFinder: (targetPath) => ipcRenderer.invoke('shell:reveal', targetPath),
  showFileMenu: (filePath) => ipcRenderer.invoke('menu:file', filePath),
  onExportProgress: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on('export:progress', handler);
    return () => ipcRenderer.removeListener('export:progress', handler);
  },
  onScanProgress: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on('scanner:progress', handler);
    return () => ipcRenderer.removeListener('scanner:progress', handler);
  },
});
