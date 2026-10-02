'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  file: {
    open: () => ipcRenderer.invoke('file:open'),
    read: (p) => ipcRenderer.invoke('file:read', p),
    save: (p, content) => ipcRenderer.invoke('file:save', p, content),
    saveAs: (content, suggested) => ipcRenderer.invoke('file:saveAs', content, suggested),
    exists: (p) => ipcRenderer.invoke('file:exists', p),
    showInFolder: (p) => ipcRenderer.invoke('file:showInFolder', p),
  },
  openExample: (file) => ipcRenderer.invoke('example:open', file),
  dialog: {
    unsaved: (names) => ipcRenderer.invoke('dialog:unsaved', names),
    message: (opts) => ipcRenderer.invoke('dialog:message', opts),
    choosePython: () => ipcRenderer.invoke('dialog:choosePython'),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
  },
  python: {
    info: () => ipcRenderer.invoke('python:info'),
    test: (p) => ipcRenderer.invoke('python:test', p),
  },
  backend: {
    run: (path, source) => ipcRenderer.send('backend:run', { path, source }),
    shell: () => ipcRenderer.send('backend:shell'),
    stop: () => ipcRenderer.send('backend:stop'),
    input: (text) => ipcRenderer.send('backend:input', text),
    repl: (line) => ipcRenderer.send('backend:repl', line),
    onMessage: (cb) => ipcRenderer.on('backend', (_e, msg) => cb(msg)),
  },
  check: (source) => ipcRenderer.invoke('check', source),
  onMenu: (cb) => ipcRenderer.on('menu', (_e, id, arg) => cb(id, arg)),
  closeNow: () => ipcRenderer.send('app:closeNow'),
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch (_) { return null; } },
});
