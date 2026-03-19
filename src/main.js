'use strict';

const { app, BrowserWindow, ipcMain, globalShortcut, Menu, Tray, dialog, shell, nativeImage, screen } = require('electron');
const path = require('path');
const Store = require('electron-store');

const ADBManager = require('./adb/manager');
const StreamManager = require('./stream/manager');
const ControlManager = require('./control/manager');
const RecordingManager = require('./recording/manager');

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------
const store = new Store({ name: 'screenmirror-pro-config' });
let mainWindow = null;
let tray = null;
const deviceWindows = new Map(); // deviceSerial -> BrowserWindow

let adbManager = null;
let streamManager = null;
let controlManager = null;
let recordingManager = null;

const isDev = process.env.NODE_ENV === 'development';

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
app.on('ready', async () => {
  await createMainWindow();
  initTray();
  registerGlobalHotkeys();
  await initManagers();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  cleanup();
});

// ---------------------------------------------------------------------------
// Main window
// ---------------------------------------------------------------------------
async function createMainWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    width: Math.min(1200, width),
    height: Math.min(800, height),
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    frame: process.platform !== 'darwin',
    backgroundColor: '#0f0f0f',
    icon: getAppIcon(),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'ui', 'preload.js'),
      webSecurity: false, // needed for local video streams
    },
    show: false,
    title: 'ScreenMirror Pro',
  });

  mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  mainWindow.on('closed', () => { mainWindow = null; });
  return mainWindow;
}

// ---------------------------------------------------------------------------
// Mirror window for a specific device
// ---------------------------------------------------------------------------
function openMirrorWindow(deviceInfo) {
  const serial = deviceInfo.serial;
  if (deviceWindows.has(serial)) {
    deviceWindows.get(serial).focus();
    return;
  }

  const win = new BrowserWindow({
    width: 400,
    height: 720,
    minWidth: 250,
    minHeight: 400,
    resizable: true,
    frame: false,
    transparent: false,
    alwaysOnTop: store.get('alwaysOnTop', false),
    backgroundColor: '#000000',
    title: `${deviceInfo.model} — Mirror`,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'ui', 'preload-mirror.js'),
      webSecurity: false,
    },
    show: false,
  });

  win.loadFile(path.join(__dirname, 'ui', 'mirror.html'), {
    query: { serial, model: deviceInfo.model },
  });

  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    deviceWindows.delete(serial);
    streamManager?.stopStream(serial).catch(() => {});
    recordingManager?.stopRecording(serial).catch(() => {});
  });

  deviceWindows.set(serial, win);
}

// ---------------------------------------------------------------------------
// System tray
// ---------------------------------------------------------------------------
function initTray() {
  const icon = nativeImage.createFromDataURL(getTrayIconBase64());
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show ScreenMirror Pro', click: () => mainWindow?.show() },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
  tray.setToolTip('ScreenMirror Pro');
  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => mainWindow?.show());
}

// ---------------------------------------------------------------------------
// Global hotkeys
// ---------------------------------------------------------------------------
function registerGlobalHotkeys() {
  // Toggle main window
  globalShortcut.register('CommandOrControl+Alt+D', () => {
    if (!mainWindow) return;
    mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
  });

  // Toggle recording for focused device
  globalShortcut.register('CommandOrControl+Alt+R', () => {
    const focused = BrowserWindow.getFocusedWindow();
    if (!focused) return;
    for (const [serial, win] of deviceWindows) {
      if (win === focused) {
        win.webContents.send('hotkey:toggle-record');
        break;
      }
    }
  });

  // Screenshot
  globalShortcut.register('CommandOrControl+Alt+S', () => {
    const focused = BrowserWindow.getFocusedWindow();
    if (!focused) return;
    for (const [serial, win] of deviceWindows) {
      if (win === focused) {
        win.webContents.send('hotkey:screenshot');
        break;
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Manager initialisation
// ---------------------------------------------------------------------------
async function initManagers() {
  adbManager = new ADBManager({ store });
  streamManager = new StreamManager({ store });
  controlManager = new ControlManager({ store });
  recordingManager = new RecordingManager({ store });

  adbManager.on('device-connected', (device) => {
    mainWindow?.webContents.send('device:connected', device);
  });

  adbManager.on('device-disconnected', (serial) => {
    mainWindow?.webContents.send('device:disconnected', { serial });
    const win = deviceWindows.get(serial);
    if (win) win.close();
  });

  adbManager.on('device-list-updated', (devices) => {
    mainWindow?.webContents.send('device:list', devices);
  });

  adbManager.on('adb-error', (info) => {
    mainWindow?.webContents.send('adb:error', info);
  });

  await adbManager.startMonitoring();
}

function cleanup() {
  adbManager?.stopMonitoring();
  streamManager?.stopAll();
  recordingManager?.stopAll();
}

// ---------------------------------------------------------------------------
// IPC handlers — Device
// ---------------------------------------------------------------------------
ipcMain.handle('device:list', async () => {
  return adbManager ? adbManager.getDevices() : [];
});

ipcMain.handle('adb:check', async () => {
  if (!adbManager) return { ok: false, message: 'ADB manager not initialised' };
  return adbManager.checkADB();
});

ipcMain.handle('device:connect-wireless', async (_, { host, port }) => {
  return adbManager.connectWireless(host, port || 5555);
});

ipcMain.handle('device:disconnect', async (_, { serial }) => {
  return adbManager.disconnect(serial);
});

ipcMain.handle('device:info', async (_, { serial }) => {
  return adbManager.getDeviceInfo(serial);
});

ipcMain.handle('device:open-mirror', async (_, deviceInfo) => {
  openMirrorWindow(deviceInfo);
  return { ok: true };
});

ipcMain.handle('device:generate-pairing-qr', async (_, { serial }) => {
  return adbManager.generatePairingQR(serial);
});

// ---------------------------------------------------------------------------
// IPC handlers — Stream
// ---------------------------------------------------------------------------
ipcMain.handle('stream:start', async (_, { serial, quality }) => {
  return streamManager.startStream(serial, quality);
});

ipcMain.handle('stream:stop', async (_, { serial }) => {
  return streamManager.stopStream(serial);
});

ipcMain.handle('stream:set-quality', async (_, { serial, quality }) => {
  return streamManager.setQuality(serial, quality);
});

ipcMain.handle('stream:stats', async (_, { serial }) => {
  return streamManager.getStats(serial);
});

// ---------------------------------------------------------------------------
// IPC handlers — Control
// ---------------------------------------------------------------------------
ipcMain.handle('control:touch', async (_, { serial, action, x, y }) => {
  return controlManager.sendTouch(serial, action, x, y);
});

ipcMain.handle('control:swipe', async (_, { serial, x1, y1, x2, y2, duration }) => {
  return controlManager.sendSwipe(serial, x1, y1, x2, y2, duration);
});

ipcMain.handle('control:key', async (_, { serial, keycode }) => {
  return controlManager.sendKey(serial, keycode);
});

ipcMain.handle('control:text', async (_, { serial, text }) => {
  return controlManager.sendText(serial, text);
});

ipcMain.handle('control:pinch', async (_, { serial, fromZoom, toZoom, cx, cy }) => {
  return controlManager.sendPinch(serial, fromZoom, toZoom, cx, cy);
});

ipcMain.handle('control:clipboard-paste', async (_, { serial, text }) => {
  return controlManager.pasteClipboard(serial, text);
});

// ---------------------------------------------------------------------------
// IPC handlers — Recording
// ---------------------------------------------------------------------------
ipcMain.handle('record:start', async (_, { serial, outputPath }) => {
  return recordingManager.startRecording(serial, outputPath);
});

ipcMain.handle('record:stop', async (_, { serial }) => {
  return recordingManager.stopRecording(serial);
});

ipcMain.handle('record:status', async (_, { serial }) => {
  return recordingManager.getStatus(serial);
});

ipcMain.handle('screenshot:take', async (_, { serial, outputPath }) => {
  return adbManager.takeScreenshot(serial, outputPath);
});

// ---------------------------------------------------------------------------
// IPC handlers — Settings & UI
// ---------------------------------------------------------------------------
ipcMain.handle('settings:get', async (_, key) => store.get(key));
ipcMain.handle('settings:set', async (_, { key, value }) => { store.set(key, value); });
ipcMain.handle('settings:all', async () => store.store);

ipcMain.handle('dialog:save', async (_, opts) => {
  const result = await dialog.showSaveDialog(mainWindow, opts);
  return result;
});

ipcMain.handle('dialog:open', async (_, opts) => {
  const result = await dialog.showOpenDialog(mainWindow, opts);
  return result;
});

ipcMain.handle('shell:open-path', async (_, filePath) => {
  shell.showItemInFolder(filePath);
});

ipcMain.handle('window:always-on-top', async (_, { serial, enabled }) => {
  const win = deviceWindows.get(serial);
  if (win) win.setAlwaysOnTop(enabled);
  store.set('alwaysOnTop', enabled);
});

ipcMain.handle('window:rotate', async (_, { serial }) => {
  const win = deviceWindows.get(serial);
  if (!win) return;
  const [w, h] = win.getSize();
  win.setSize(h, w, true);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function getAppIcon() {
  // Use default icon path if exists
  const iconPath = path.join(__dirname, '..', 'assets', 'icon.png');
  return iconPath;
}

function getTrayIconBase64() {
  // Inline minimal 16x16 tray icon as base64 PNG
  return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAA2ElEQVQ4T6WTMQqDQBBFZ7MgWHkBCx7Axht4AAtPYOkJPIE5gkfwCB7Ai3iBgI2lEBBBCEk2u8v+ZCTuZmMSYdxmmJn33wwDgDEGxhiUUqCU4t8gIiilwHmeYduWG7dt2xVCCDjnwBjDOecYYzDGEEIIEEIQ0zQN27blnHNusixDkiQopYi7rutQSuG6LhARoigCESGKIhARwzCISCkl4jiGMQYiIkIIAQCQUkqappFSStdaa00ppVBKKSilVEoppVxKvfcOAM65B4wxBmOMUsqlaZr2k/7+AfcC57MAAAAASUVORK5CYII=';
}
