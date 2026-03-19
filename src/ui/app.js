/* ============================================================
   ScreenMirror Pro — Main app logic (renderer process)
   ============================================================ */
'use strict';

// ── State ────────────────────────────────────────────────────
const state = {
  devices: [],
  scanning: false,
  theme: 'dark',
};

// ── DOM refs ─────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const deviceList     = $('device-list');
const sidebarEmpty   = $('sidebar-empty');
const btnScan        = $('btn-scan');
const btnAddWireless = $('btn-add-wireless');
const btnTheme       = $('btn-theme');
const btnSettings    = $('btn-settings');

const wirelessModal   = $('wireless-modal');
const wirelessClose   = $('wireless-modal-close');
const wirelessCancel  = $('wireless-cancel');
const wirelessConnect = $('wireless-connect');
const wifiHost        = $('wifi-host');
const wifiPort        = $('wifi-port');
const wirelessStatus  = $('wireless-status');

const settingsPanel   = $('settings-panel');
const settingsOverlay = $('settings-overlay');
const settingsClose   = $('settings-close');
const recordingsDir   = $('recordings-dir');
const btnChooseDir    = $('btn-choose-dir');

const toastContainer  = $('toast-container');
const adbBanner       = $('adb-banner');
const adbBannerMsg    = $('adb-banner-msg');

// ── Init ─────────────────────────────────────────────────────
async function init() {
  await loadSettings();
  setupEventListeners();
  subscribeToDeviceEvents();
  await checkADB();
  await scanDevices();
}

async function loadSettings() {
  const all = await window.smp.settings.all();
  state.theme = all.theme || 'dark';
  document.body.className = state.theme;

  // Quality radio
  const quality = all.quality || '720p';
  const radio = document.querySelector(`input[name="quality"][value="${quality}"]`);
  if (radio) radio.checked = true;

  // Always on top
  const aot = $('setting-always-on-top');
  if (aot) aot.checked = all.alwaysOnTop || false;

  // Recordings dir
  if (recordingsDir) recordingsDir.value = all.recordingsDir || '';
}

// ── Event listeners ───────────────────────────────────────────
function setupEventListeners() {
  // Scan
  btnScan.addEventListener('click', scanDevices);

  // ADB banner
  $('adb-dismiss')?.addEventListener('click', () => adbBanner.classList.add('hidden'));
  $('adb-recheck')?.addEventListener('click', async () => {
    adbBannerMsg.textContent = 'Checking ADB…';
    await checkADB();
    await scanDevices();
  });

  // Wireless modal
  btnAddWireless.addEventListener('click', openWirelessModal);
  wirelessClose.addEventListener('click', closeWirelessModal);
  wirelessCancel.addEventListener('click', closeWirelessModal);
  wirelessConnect.addEventListener('click', connectWireless);
  wirelessModal.addEventListener('click', (e) => { if (e.target === wirelessModal) closeWirelessModal(); });
  wifiHost.addEventListener('keydown', (e) => { if (e.key === 'Enter') connectWireless(); });

  // Theme toggle
  btnTheme.addEventListener('click', toggleTheme);

  // Settings
  btnSettings.addEventListener('click', () => settingsPanel.classList.remove('hidden'));
  settingsClose.addEventListener('click', () => settingsPanel.classList.add('hidden'));
  settingsOverlay.addEventListener('click', () => settingsPanel.classList.add('hidden'));

  // Quality change
  document.querySelectorAll('input[name="quality"]').forEach(r => {
    r.addEventListener('change', (e) => window.smp.settings.set({ key: 'quality', value: e.target.value }));
  });

  // Always on top
  $('setting-always-on-top')?.addEventListener('change', (e) => {
    window.smp.settings.set({ key: 'alwaysOnTop', value: e.target.checked });
  });

  // Choose recordings dir
  btnChooseDir?.addEventListener('click', async () => {
    const result = await window.smp.dialog.open({
      properties: ['openDirectory'],
      title: 'Choose Recordings Folder',
    });
    if (!result.canceled && result.filePaths[0]) {
      const dir = result.filePaths[0];
      recordingsDir.value = dir;
      window.smp.settings.set({ key: 'recordingsDir', value: dir });
    }
  });
}

// ── ADB health check ───────────────────────────────────
// (called on startup and re-check button)
async function checkADB() {
  try {
    const result = await window.smp.adb.check();
    if (result.ok) {
      adbBanner.classList.add('hidden');
    } else {
      adbBannerMsg.textContent = `ADB not found at “${result.resolvedPath || 'adb'}” —`;
      adbBanner.classList.remove('hidden');
    }
  } catch (_) {
    adbBanner.classList.remove('hidden');
  }
}

// ── Device subscription ───────────────────────────────────────────
function subscribeToDeviceEvents() {
  window.smp.device.onConnected((device) => {
    const exists = state.devices.find(d => d.serial === device.serial);
    if (!exists) {
      state.devices.push(device);
      renderDeviceList();
      showToast(`${device.model} connected`, 'success');
    }
  });

  window.smp.device.onDisconnected(({ serial }) => {
    state.devices = state.devices.filter(d => d.serial !== serial);
    renderDeviceList();
    showToast('Device disconnected', 'info');
  });

  window.smp.device.onListUpdated((devices) => {
    state.devices = devices;
    renderDeviceList();
  });
}

// ── Scan ──────────────────────────────────────────────────────
async function scanDevices() {
  if (state.scanning) return;
  state.scanning = true;
  btnScan.querySelector('svg').classList.add('spinning');

  try {
    const devices = await window.smp.device.list();
    state.devices = devices;
    renderDeviceList();
  } catch (err) {
    showToast('Failed to scan: ' + err.message, 'error');
  } finally {
    state.scanning = false;
    btnScan.querySelector('svg').classList.remove('spinning');
  }
}

// ── Render devices ────────────────────────────────────────────
function renderDeviceList() {
  const isEmpty = state.devices.length === 0;
  sidebarEmpty.classList.toggle('hidden', !isEmpty);
  deviceList.innerHTML = '';

  for (const device of state.devices) {
    deviceList.appendChild(buildDeviceCard(device));
  }
}

function buildDeviceCard(device) {
  const card = document.createElement('div');
  card.className = 'device-card';
  card.dataset.serial = device.serial;

  const isWifi  = device.connectionType === 'wireless';
  const battery = device.battery;
  const batteryClass = battery > 60 ? 'high' : battery > 25 ? 'medium' : 'low';
  const batteryPct = battery ? `${battery}%` : '?';

  card.innerHTML = `
    <div class="device-card-header">
      <div class="device-icon">📱</div>
      <div class="device-info">
        <div class="device-model">${escHtml(device.model)}</div>
        <div class="device-serial">${escHtml(device.serial)}</div>
      </div>
      <span class="device-badge ${isWifi ? 'wifi' : 'usb'}">${isWifi ? 'WiFi' : 'USB'}</span>
    </div>
    <div class="device-meta">
      <span>🤖 Android ${escHtml(String(device.androidVersion))}</span>
      <span>📺 ${device.resolution ? `${device.resolution.w}×${device.resolution.h}` : '—'}</span>
      <span>🔋 ${batteryPct}</span>
    </div>
    ${battery !== null ? `
    <div class="battery-bar">
      <div class="battery-fill ${batteryClass}" style="width:${battery}%"></div>
    </div>` : ''}
    <div class="device-actions">
      <button class="btn-mirror" data-action="mirror" data-serial="${escHtml(device.serial)}">▶ Mirror</button>
      <button class="btn-disconnect" data-action="disconnect" data-serial="${escHtml(device.serial)}">Disconnect</button>
    </div>
  `;

  card.addEventListener('click', (e) => {
    const action = e.target.dataset.action;
    if (action === 'mirror') {
      e.stopPropagation();
      openMirror(device);
    } else if (action === 'disconnect') {
      e.stopPropagation();
      disconnectDevice(device.serial);
    }
  });

  return card;
}

// ── Mirror window ─────────────────────────────────────────────
async function openMirror(device) {
  try {
    await window.smp.device.openMirror(device);
  } catch (err) {
    showToast('Failed to open mirror: ' + err.message, 'error');
  }
}

async function disconnectDevice(serial) {
  const result = await window.smp.device.disconnect({ serial });
  if (result.ok) {
    state.devices = state.devices.filter(d => d.serial !== serial);
    renderDeviceList();
    showToast('Device disconnected', 'info');
  } else {
    showToast('Disconnect failed: ' + result.message, 'error');
  }
}

// ── Wireless modal ────────────────────────────────────────────
function openWirelessModal() {
  wirelessModal.classList.remove('hidden');
  wifiHost.focus();
  wirelessStatus.classList.add('hidden');
  wirelessStatus.className = 'modal-status hidden';
}

function closeWirelessModal() {
  wirelessModal.classList.add('hidden');
}

async function connectWireless() {
  const host = wifiHost.value.trim();
  const port = parseInt(wifiPort.value) || 5555;
  if (!host) { wifiHost.focus(); return; }

  wirelessConnect.disabled = true;
  wirelessConnect.textContent = 'Connecting…';
  wirelessStatus.classList.remove('hidden');
  wirelessStatus.className = 'modal-status';
  wirelessStatus.textContent = `Connecting to ${host}:${port}…`;

  try {
    const result = await window.smp.device.connectWireless({ host, port });
    if (result.ok) {
      wirelessStatus.className = 'modal-status success';
      wirelessStatus.textContent = '✓ ' + result.message;
      showToast(`Connected to ${host}`, 'success');
      setTimeout(closeWirelessModal, 1200);
    } else {
      wirelessStatus.className = 'modal-status error';
      wirelessStatus.textContent = '✗ ' + result.message;
    }
  } catch (err) {
    wirelessStatus.className = 'modal-status error';
    wirelessStatus.textContent = '✗ ' + err.message;
  } finally {
    wirelessConnect.disabled = false;
    wirelessConnect.textContent = 'Connect';
  }
}

// ── Theme ─────────────────────────────────────────────────────
async function toggleTheme() {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  document.body.className = state.theme;
  await window.smp.settings.set({ key: 'theme', value: state.theme });
}

// ── Toast ─────────────────────────────────────────────────────
function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('out');
    toast.addEventListener('animationend', () => toast.remove());
  }, 3000);
}

// ── Helpers ───────────────────────────────────────────────────
function escHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// ── Bootstrap ─────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
