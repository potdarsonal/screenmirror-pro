'use strict';

/**
 * RecordingManager — records the Android device screen as MP4
 * using either scrcpy's built-in record flag or FFmpeg to capture
 * from a WebSocket stream.
 */

const { spawn } = require('child_process');
const { exec } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const os = require('os');
const fs = require('fs');

const execAsync = promisify(exec);

class RecordingManager {
  constructor({ store }) {
    this._store = store;
    this._recordings = new Map(); // serial -> { process, outputPath, startTime }
    this._adbPath = this._resolveADB();
    this._scrcpyPath = this._resolveScrcpy();
  }

  _resolve(candidates) {
    for (const p of candidates) {
      if (p === candidates[candidates.length - 1]) return p;
      try { if (fs.existsSync(p)) return p; } catch (_) {}
    }
    return candidates[candidates.length - 1];
  }

  _resolveADB() {
    return this._resolve([
      path.join(process.resourcesPath || '', 'bin', 'adb'),
      path.join(__dirname, '..', '..', 'bin', 'adb'),
      path.join(os.homedir(), 'Library', 'Android', 'sdk', 'platform-tools', 'adb'),
      '/usr/local/bin/adb',
      '/opt/homebrew/bin/adb',
      'adb',
    ]);
  }

  _resolveScrcpy() {
    return this._resolve([
      path.join(process.resourcesPath || '', 'bin', 'scrcpy'),
      path.join(__dirname, '..', '..', 'bin', 'scrcpy'),
      '/usr/local/bin/scrcpy',
      '/opt/homebrew/bin/scrcpy',
      'scrcpy',
    ]);
  }

  // -------------------------------------------------------------------------
  // Start recording
  // -------------------------------------------------------------------------
  async startRecording(serial, outputPath) {
    if (this._recordings.has(serial)) {
      return { ok: false, message: 'Already recording for this device' };
    }

    // Ensure directory exists
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const scrcpyAvailable = await this._checkBin(this._scrcpyPath);

    let proc;
    if (scrcpyAvailable) {
      proc = await this._startScrcpyRecord(serial, outputPath);
    } else {
      proc = await this._startADBRecord(serial, outputPath);
    }

    if (!proc) {
      return { ok: false, message: 'Failed to start recording process' };
    }

    const entry = { process: proc, outputPath, startTime: Date.now(), method: scrcpyAvailable ? 'scrcpy' : 'adb' };
    this._recordings.set(serial, entry);

    proc.on('exit', () => this._recordings.delete(serial));

    return { ok: true, outputPath, method: entry.method };
  }

  _startScrcpyRecord(serial, outputPath) {
    return new Promise((resolve) => {
      const args = [
        '-s', serial,
        '--no-display',
        '--record', outputPath,
        '--record-format', 'mp4',
        '--no-audio',
        '--power-off-on-close=false',
        '--turn-screen-off',
      ];
      const proc = spawn(this._scrcpyPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      proc.on('error', () => resolve(null));
      setTimeout(() => resolve(proc), 500); // Give it time to start
    });
  }

  _startADBRecord(serial, outputPath) {
    return new Promise((resolve) => {
      // Use ADB screenrecord (3-min limit, but can rotate files)
      const remotePath = `/sdcard/screenmirror_record_${Date.now()}.mp4`;
      const proc = spawn(
        this._adbPath,
        ['-s', serial, 'shell', 'screenrecord', '--bit-rate', '8000000', remotePath],
        { stdio: 'ignore' }
      );

      proc._remotePath = remotePath;
      proc._localPath = outputPath;
      proc._serial = serial;
      proc._adbPath = this._adbPath;

      proc.on('error', () => resolve(null));
      setTimeout(() => resolve(proc), 300);
    });
  }

  // -------------------------------------------------------------------------
  // Stop recording
  // -------------------------------------------------------------------------
  async stopRecording(serial) {
    const entry = this._recordings.get(serial);
    if (!entry) return { ok: false, message: 'No active recording for this device' };

    const { process: proc, outputPath, startTime, method } = entry;

    try {
      proc.kill('SIGTERM');
    } catch (_) {}

    // If ADB screenrecord, pull the file from device
    if (method === 'adb' && proc._remotePath) {
      await this._pullRecording(proc._serial, proc._remotePath, proc._localPath, proc._adbPath);
    }

    this._recordings.delete(serial);
    const duration = Math.round((Date.now() - startTime) / 1000);
    return { ok: true, outputPath, duration };
  }

  async _pullRecording(serial, remotePath, localPath, adbPath) {
    try {
      await execAsync(`"${adbPath}" -s "${serial}" pull "${remotePath}" "${localPath}"`, { timeout: 30000 });
      await execAsync(`"${adbPath}" -s "${serial}" shell rm "${remotePath}"`, { timeout: 5000 });
    } catch (_) {}
  }

  getStatus(serial) {
    const entry = this._recordings.get(serial);
    if (!entry) return { recording: false };
    return {
      recording: true,
      outputPath: entry.outputPath,
      duration: Math.round((Date.now() - entry.startTime) / 1000),
      method: entry.method,
    };
  }

  stopAll() {
    for (const [serial] of this._recordings) {
      this.stopRecording(serial).catch(() => {});
    }
  }

  async _checkBin(bin) {
    try {
      const { execSync } = require('child_process');
      execSync(`"${bin}" --version`, { timeout: 3000, stdio: 'pipe' });
      return true;
    } catch (_) { return false; }
  }
}

module.exports = RecordingManager;
