'use strict';

/**
 * Preload for the mirror window — exposes stream/control/record bridge
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('smp', {
  stream: {
    start:      (args) => ipcRenderer.invoke('stream:start', args),
    stop:       (args) => ipcRenderer.invoke('stream:stop', args),
    setQuality: (args) => ipcRenderer.invoke('stream:set-quality', args),
    stats:      (args) => ipcRenderer.invoke('stream:stats', args),
  },
  control: {
    touch:          (args) => ipcRenderer.invoke('control:touch', args),
    swipe:          (args) => ipcRenderer.invoke('control:swipe', args),
    key:            (args) => ipcRenderer.invoke('control:key', args),
    text:           (args) => ipcRenderer.invoke('control:text', args),
    pinch:          (args) => ipcRenderer.invoke('control:pinch', args),
    clipboardPaste: (args) => ipcRenderer.invoke('control:clipboard-paste', args),
  },
  record: {
    start:  (args) => ipcRenderer.invoke('record:start', args),
    stop:   (args) => ipcRenderer.invoke('record:stop', args),
    status: (args) => ipcRenderer.invoke('record:status', args),
  },
  screenshot: {
    take: (args) => ipcRenderer.invoke('screenshot:take', args),
  },
  settings: {
    get: (key)  => ipcRenderer.invoke('settings:get', key),
    set: (args) => ipcRenderer.invoke('settings:set', args),
  },
  dialog: {
    save: (opts) => ipcRenderer.invoke('dialog:save', opts),
  },
  shell: {
    openPath: (p) => ipcRenderer.invoke('shell:open-path', p),
  },
  window: {
    alwaysOnTop: (args) => ipcRenderer.invoke('window:always-on-top', args),
    rotate:      (args) => ipcRenderer.invoke('window:rotate', args),
  },
  on: {
    hotkeyRecord:       (cb) => ipcRenderer.on('hotkey:toggle-record', cb),
    hotkeyScreenshot:   (cb) => ipcRenderer.on('hotkey:screenshot', cb),
  },
});
