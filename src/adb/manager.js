'use strict';

const { EventEmitter } = require('eventemitter3');
const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const os = require('os');
const fs = require('fs');
const qrcode = require('qrcode');

const execAsync = promisify(exec);

// Android keycodes for common buttons
const KEYCODES = {
  HOME: 3,
  BACK: 4,
  MENU: 82,
  POWER: 26,
  VOLUME_UP: 24,
  VOLUME_DOWN: 25,
  VOLUME_MUTE: 164,
  MEDIA_PLAY_PAUSE: 85,
  MEDIA_NEXT: 87,
  MEDIA_PREV: 88,
  DPAD_UP: 19,
  DPAD_DOWN: 20,
  DPAD_LEFT: 21,
  DPAD_RIGHT: 22,
  DPAD_CENTER: 23,
  APP_SWITCH: 187,
  SCREENSHOT: 120,
};

class ADBManager extends EventEmitter {
  constructor({ store }) {
    super();
    this._store = store;
    this._devices = new Map();       // serial -> deviceInfo
    this._monitorProc = null;
    this._isMonitoring = false;
    this._adbPath = this._resolveADB();
    this._pollInterval = null;
  }

  // -------------------------------------------------------------------------
  // ADB binary resolution
  // -------------------------------------------------------------------------
  _resolveADB() {
    // Check bundled binary first, then system PATH
    const bundledPaths = [
      path.join(process.resourcesPath || '', 'bin', 'adb'),
      path.join(__dirname, '..', '..', 'bin', 'adb'),
      path.join(os.homedir(), 'Library', 'Android', 'sdk', 'platform-tools', 'adb'),
      path.join(os.homedir(), 'Android', 'Sdk', 'platform-tools', 'adb'),
      '/usr/local/bin/adb',
      '/opt/homebrew/bin/adb',
      'adb', // system PATH fallback
    ];

    for (const p of bundledPaths) {
      if (p === 'adb') return 'adb';
      try { if (fs.existsSync(p)) return p; } catch (_) {}
    }
    return 'adb';
  }

  async _adb(args, opts = {}) {
    const cmd = `"${this._adbPath}" ${args}`;
    const { stdout, stderr } = await execAsync(cmd, { timeout: 10000, ...opts });
    return stdout.trim();
  }

  async _adbDevice(serial, args) {
    return this._adb(`-s "${serial}" ${args}`);
  }

  // -------------------------------------------------------------------------
  // Device monitoring
  // -------------------------------------------------------------------------
  async startMonitoring() {
    if (this._isMonitoring) return;
    this._isMonitoring = true;

    // Initial scan
    await this._refreshDevices();

    // Poll every 2 seconds for device changes
    this._pollInterval = setInterval(async () => {
      await this._refreshDevices();
    }, 2000);
  }

  stopMonitoring() {
    this._isMonitoring = false;
    if (this._pollInterval) {
      clearInterval(this._pollInterval);
      this._pollInterval = null;
    }
  }

  async _refreshDevices() {
    try {
      const output = await this._adb('devices -l');
      const lines = output.split('\n').slice(1).filter(l => l.includes('\t'));
      const currentSerials = new Set();

      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        const serial = parts[0];
        const state = parts[1];
        if (!serial || state !== 'device') continue;

        currentSerials.add(serial);
        if (!this._devices.has(serial)) {
          const info = await this._buildDeviceInfo(serial);
          this._devices.set(serial, info);
          this.emit('device-connected', info);
        }
      }

      // Detect disconnected devices
      for (const [serial] of this._devices) {
        if (!currentSerials.has(serial)) {
          this._devices.delete(serial);
          this.emit('device-disconnected', serial);
        }
      }

      this.emit('device-list-updated', Array.from(this._devices.values()));
    } catch (err) {
      // ADB not installed or daemon not running — silent for now
    }
  }

  async _buildDeviceInfo(serial) {
    const props = await this._getDeviceProperties(serial);
    return {
      serial,
      model: props['ro.product.model'] || props['ro.product.name'] || serial,
      brand: props['ro.product.brand'] || 'Android',
      androidVersion: props['ro.build.version.release'] || 'Unknown',
      sdkVersion: props['ro.build.version.sdk'] || '0',
      resolution: await this._getResolution(serial),
      battery: await this._getBattery(serial),
      connectionType: serial.includes(':') ? 'wireless' : 'usb',
      connectedAt: Date.now(),
    };
  }

  async _getDeviceProperties(serial) {
    try {
      const output = await this._adbDevice(serial, 'shell getprop');
      const props = {};
      for (const line of output.split('\n')) {
        const m = line.match(/^\[([^\]]+)\]:\s*\[([^\]]*)\]/);
        if (m) props[m[1]] = m[2];
      }
      return props;
    } catch (_) { return {}; }
  }

  async _getResolution(serial) {
    try {
      const out = await this._adbDevice(serial, 'shell wm size');
      const m = out.match(/(\d+)x(\d+)/);
      return m ? { w: parseInt(m[1]), h: parseInt(m[2]) } : { w: 1080, h: 1920 };
    } catch (_) { return { w: 1080, h: 1920 }; }
  }

  async _getBattery(serial) {
    try {
      const out = await this._adbDevice(serial, 'shell dumpsys battery | grep level');
      const m = out.match(/(\d+)/);
      return m ? parseInt(m[1]) : null;
    } catch (_) { return null; }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------
  getDevices() {
    return Array.from(this._devices.values());
  }

  async connectWireless(host, port = 5555) {
    try {
      const out = await this._adb(`connect ${host}:${port}`);
      if (out.includes('connected') || out.includes('already connected')) {
        await this._refreshDevices();
        return { ok: true, message: out };
      }
      return { ok: false, message: out };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  }

  async disconnect(serial) {
    try {
      if (serial.includes(':')) {
        await this._adb(`disconnect ${serial}`);
      }
      this._devices.delete(serial);
      this.emit('device-disconnected', serial);
      this.emit('device-list-updated', this.getDevices());
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  }

  async getDeviceInfo(serial) {
    if (this._devices.has(serial)) return this._devices.get(serial);
    return this._buildDeviceInfo(serial);
  }

  async takeScreenshot(serial, outputPath) {
    try {
      const tmpRemote = '/sdcard/screenmirror_screenshot.png';
      await this._adbDevice(serial, `shell screencap -p ${tmpRemote}`);
      await this._adbDevice(serial, `pull ${tmpRemote} "${outputPath}"`);
      await this._adbDevice(serial, `shell rm ${tmpRemote}`);
      return { ok: true, path: outputPath };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  }

  async generatePairingQR(serial) {
    // Generate a pairing code for wireless ADB pairing (Android 11+)
    const code = Math.random().toString(36).slice(2, 8).toUpperCase();
    const pairingData = JSON.stringify({ action: 'pair', code, serial });
    const qrDataUrl = await qrcode.toDataURL(pairingData, { margin: 1, width: 200 });
    return { code, qr: qrDataUrl };
  }

  async enableWirelessADB(serial) {
    try {
      await this._adbDevice(serial, 'tcpip 5555');
      const ip = await this._getDeviceIP(serial);
      return { ok: true, ip, port: 5555 };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  }

  async _getDeviceIP(serial) {
    try {
      const out = await this._adbDevice(serial, 'shell ip route');
      const m = out.match(/src\s+([\d.]+)/);
      return m ? m[1] : null;
    } catch (_) { return null; }
  }
}

module.exports = ADBManager;
module.exports.KEYCODES = KEYCODES;
