'use strict';

/**
 * Preload for the main window — exposes a safe IPC bridge
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('smp', {
  // ── Device ──────────────────────────────────────────────────────────────
  device: {
    list:               ()      => ipcRenderer.invoke('device:list'),
    connectWireless:    (args)  => ipcRenderer.invoke('device:connect-wireless', args),
    disconnect:         (args)  => ipcRenderer.invoke('device:disconnect', args),
    info:               (args)  => ipcRenderer.invoke('device:info', args),
    openMirror:         (info)  => ipcRenderer.invoke('device:open-mirror', info),
    generatePairingQR:  (args)  => ipcRenderer.invoke('device:generate-pairing-qr', args),

    onConnected:        (cb) => { ipcRenderer.on('device:connected', (_, d) => cb(d)); },
    onDisconnected:     (cb) => { ipcRenderer.on('device:disconnected', (_, d) => cb(d)); },
    onListUpdated:      (cb) => { ipcRenderer.on('device:list', (_, list) => cb(list)); },
  },

  // ── ADB ───────────────────────────────────────────────────────────────────
  adb: {
    check: () => ipcRenderer.invoke('adb:check'),
    onError: (cb) => { ipcRenderer.on('adb:error', (_, info) => cb(info)); },
  },

  // ── Stream ───────────────────────────────────────────────────────────────
  stream: {
    start:      (args) => ipcRenderer.invoke('stream:start', args),
    stop:       (args) => ipcRenderer.invoke('stream:stop', args),
    setQuality: (args) => ipcRenderer.invoke('stream:set-quality', args),
    stats:      (args) => ipcRenderer.invoke('stream:stats', args),
  },

  // ── Control ──────────────────────────────────────────────────────────────
  control: {
    touch:          (args) => ipcRenderer.invoke('control:touch', args),
    swipe:          (args) => ipcRenderer.invoke('control:swipe', args),
    key:            (args) => ipcRenderer.invoke('control:key', args),
    text:           (args) => ipcRenderer.invoke('control:text', args),
    pinch:          (args) => ipcRenderer.invoke('control:pinch', args),
    clipboardPaste: (args) => ipcRenderer.invoke('control:clipboard-paste', args),
  },

  // ── Recording ────────────────────────────────────────────────────────────
  record: {
    start:      (args) => ipcRenderer.invoke('record:start', args),
    stop:       (args) => ipcRenderer.invoke('record:stop', args),
    status:     (args) => ipcRenderer.invoke('record:status', args),
  },
  screenshot: {
    take: (args) => ipcRenderer.invoke('screenshot:take', args),
  },

  // ── Settings ─────────────────────────────────────────────────────────────
  settings: {
    get:  (key)   => ipcRenderer.invoke('settings:get', key),
    set:  (args)  => ipcRenderer.invoke('settings:set', args),
    all:  ()      => ipcRenderer.invoke('settings:all'),
  },

  // ── Dialogs & Shell ───────────────────────────────────────────────────────
  dialog: {
    save: (opts) => ipcRenderer.invoke('dialog:save', opts),
    open: (opts) => ipcRenderer.invoke('dialog:open', opts),
  },
  shell: {
    openPath: (p) => ipcRenderer.invoke('shell:open-path', p),
  },
  window: {
    alwaysOnTop: (args) => ipcRenderer.invoke('window:always-on-top', args),
    rotate:      (args) => ipcRenderer.invoke('window:rotate', args),
  },
});
