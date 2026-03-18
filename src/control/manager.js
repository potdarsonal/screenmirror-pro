'use strict';

/**
 * ControlManager — translates desktop mouse/keyboard events into
 * ADB input commands sent to the Android device.
 */

const { exec } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const os = require('os');
const fs = require('fs');

const execAsync = promisify(exec);

// Mapping of common keyboard keys → Android keycodes
const KEY_MAP = {
  Home:        3,
  Back:        4,
  Escape:      4,  // Back
  F1:          3,  // Home
  F2:          4,  // Back
  F3:        187,  // Recents
  F4:         26,  // Power
  F5:         82,  // Menu
  VolumeUp:   24,
  VolumeDown: 25,
  AudioVolumeMute: 164,
  MediaPlayPause:   85,
  MediaTrackNext:   87,
  MediaTrackPrevious: 88,
  ArrowUp:    19,
  ArrowDown:  20,
  ArrowLeft:  21,
  ArrowRight: 22,
  Enter:      66,
  Delete:     67,
  Tab:        61,
};

class ControlManager {
  constructor({ store }) {
    this._store = store;
    this._adbPath = this._resolveADB();
    this._queue = new Map(); // serial -> queue array
    this._processing = new Set();
  }

  _resolveADB() {
    const candidates = [
      path.join(process.resourcesPath || '', 'bin', 'adb'),
      path.join(__dirname, '..', '..', 'bin', 'adb'),
      path.join(os.homedir(), 'Library', 'Android', 'sdk', 'platform-tools', 'adb'),
      '/usr/local/bin/adb',
      '/opt/homebrew/bin/adb',
      'adb',
    ];
    for (const p of candidates) {
      if (p === 'adb') return 'adb';
      try { if (fs.existsSync(p)) return p; } catch (_) {}
    }
    return 'adb';
  }

  async _exec(serial, args) {
    const cmd = `"${this._adbPath}" -s "${serial}" ${args}`;
    try {
      const { stdout } = await execAsync(cmd, { timeout: 5000 });
      return { ok: true, stdout };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  }

  // -------------------------------------------------------------------------
  // Touch events (scaled from mirror display coords to device coords)
  // -------------------------------------------------------------------------
  async sendTouch(serial, action, x, y) {
    const xi = Math.round(x);
    const yi = Math.round(y);
    switch (action) {
      case 'tap':
        return this._exec(serial, `shell input tap ${xi} ${yi}`);
      case 'down':
        // No perfect ADB equivalent for press-hold without swipe
        return this._exec(serial, `shell input tap ${xi} ${yi}`);
      default:
        return { ok: true };
    }
  }

  async sendSwipe(serial, x1, y1, x2, y2, duration = 300) {
    const args = [x1, y1, x2, y2].map(Math.round);
    return this._exec(serial, `shell input swipe ${args.join(' ')} ${Math.round(duration)}`);
  }

  async sendLongPress(serial, x, y, duration = 600) {
    return this.sendSwipe(serial, x, y, x, y, duration);
  }

  // -------------------------------------------------------------------------
  // Keyboard
  // -------------------------------------------------------------------------
  async sendKey(serial, key) {
    const keycode = typeof key === 'number' ? key : (KEY_MAP[key] ?? null);
    if (keycode === null) {
      // Try sending as text character
      return this.sendText(serial, key);
    }
    return this._exec(serial, `shell input keyevent ${keycode}`);
  }

  async sendText(serial, text) {
    // Escape special shell characters
    const safe = text.replace(/['"\\`$!&|;<>(){}#~]/g, '\\$&').replace(/ /g, '%s');
    return this._exec(serial, `shell input text '${safe}'`);
  }

  // -------------------------------------------------------------------------
  // Clipboard paste from PC → device
  // -------------------------------------------------------------------------
  async pasteClipboard(serial, text) {
    // Set clipboard via content provider (Android 7+)
    const escaped = text.replace(/'/g, "'\\''");
    const result = await this._exec(
      serial,
      `shell am broadcast -a clipper.set -e text '${escaped}'`
    );
    if (!result.ok) {
      // Fallback: type the text directly
      return this.sendText(serial, text);
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // Pinch to zoom (simulated via two-finger swipe)
  // -------------------------------------------------------------------------
  async sendPinch(serial, fromZoom, toZoom, cx, cy) {
    const spread = 100;
    const scale = toZoom / fromZoom;
    const newSpread = spread * scale;
    const cmd = `shell input touchscreen swipe ${cx - spread} ${cy} ${cx - newSpread} ${cy} 300 & `
              + `adb -s "${serial}" shell input touchscreen swipe ${cx + spread} ${cy} ${cx + newSpread} ${cy} 300`;
    return this._exec(serial, `shell input touchscreen swipe ${Math.round(cx - spread)} ${Math.round(cy)} ${Math.round(cx - newSpread)} ${Math.round(cy)} 300`);
  }

  // -------------------------------------------------------------------------
  // Hardware buttons
  // -------------------------------------------------------------------------
  async home(serial)   { return this._exec(serial, 'shell input keyevent 3');   }
  async back(serial)   { return this._exec(serial, 'shell input keyevent 4');   }
  async recent(serial) { return this._exec(serial, 'shell input keyevent 187'); }
  async power(serial)  { return this._exec(serial, 'shell input keyevent 26');  }

  async volumeUp(serial)   { return this._exec(serial, 'shell input keyevent 24'); }
  async volumeDown(serial) { return this._exec(serial, 'shell input keyevent 25'); }

  // -------------------------------------------------------------------------
  // Rotate screen (toggle auto-rotate)
  // -------------------------------------------------------------------------
  async setRotation(serial, rotation /* 0,1,2,3 */) {
    await this._exec(serial, 'shell content insert --uri content://settings/system --bind name:s:accelerometer_rotation --bind value:i:0');
    return this._exec(serial, `shell content insert --uri content://settings/system --bind name:s:user_rotation --bind value:i:${rotation}`);
  }
}

module.exports = ControlManager;
