'use strict';

/**
 * StreamManager — launches scrcpy as a child process and exposes
 * a local WebSocket port that the renderer reads as an <img> MJPEG
 * stream, or directly pipes through a local WebSocket.
 */

const { EventEmitter } = require('eventemitter3');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const path = require('path');
const os = require('os');
const fs = require('fs');
const net = require('net');

const QUALITY_PRESETS = {
  native: { maxSize: 0, bitRate: '8M', fps: 60 },
  hd:     { maxSize: 1080, bitRate: '4M', fps: 60 },
  '720p': { maxSize: 720, bitRate: '2M', fps: 30 },
  '480p': { maxSize: 480, bitRate: '1M', fps: 30 },
};

class StreamManager extends EventEmitter {
  constructor({ store }) {
    super();
    this._store = store;
    this._streams = new Map(); // serial -> { process, wss, port, stats }
  }

  // -------------------------------------------------------------------------
  // Resolve scrcpy binary
  // -------------------------------------------------------------------------
  _resolveScrcpy() {
    const candidates = [
      path.join(process.resourcesPath || '', 'bin', 'scrcpy'),
      path.join(__dirname, '..', '..', 'bin', 'scrcpy'),
      '/usr/local/bin/scrcpy',
      '/opt/homebrew/bin/scrcpy',
      'scrcpy',
    ];
    for (const p of candidates) {
      if (p === 'scrcpy') return 'scrcpy';
      try { if (fs.existsSync(p)) return p; } catch (_) {}
    }
    return 'scrcpy';
  }

  // -------------------------------------------------------------------------
  // Find a free TCP port
  // -------------------------------------------------------------------------
  _getFreePort() {
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.listen(0, '127.0.0.1', () => {
        const port = srv.address().port;
        srv.close(() => resolve(port));
      });
      srv.on('error', reject);
    });
  }

  // -------------------------------------------------------------------------
  // Start stream for a device
  // -------------------------------------------------------------------------
  async startStream(serial, quality = '720p') {
    if (this._streams.has(serial)) {
      return this._streams.get(serial).connectionInfo;
    }

    const preset = QUALITY_PRESETS[quality] || QUALITY_PRESETS['720p'];
    const wsPort = await this._getFreePort();
    const scrcpyBin = this._resolveScrcpy();
    const scrcpyAvailable = await this._checkScrcpy(scrcpyBin);

    let streamProcess = null;
    const wss = new WebSocketServer({ host: '127.0.0.1', port: wsPort });
    const stats = { fps: 0, latency: 0, bitrate: 0, frames: 0, startTime: Date.now() };

    if (scrcpyAvailable) {
      // Launch scrcpy with video-only output to stdout
      const args = [
        '-s', serial,
        '--video-codec=h264',
        '--video-encoder=OMX.google.h264.encoder',
        '--no-audio',
        '--no-control',  // Control handled separately via ADB
        '--no-display',
        '--no-clipboard-autosync',
        '--power-off-on-close=false',
        '--turn-screen-off',
      ];

      if (preset.maxSize > 0) args.push(`--max-size=${preset.maxSize}`);
      args.push(`--max-fps=${preset.fps}`);
      args.push(`--bit-rate=${preset.bitRate}`);

      streamProcess = spawn(scrcpyBin, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      streamProcess.stderr.on('data', (d) => {
        const msg = d.toString();
        if (msg.includes('ERROR')) {
          this.emit('stream-error', { serial, message: msg });
        }
      });

      // Pipe scrcpy stdout (H264 bitstream) to all connected WS clients
      streamProcess.stdout.on('data', (chunk) => {
        stats.frames++;
        stats.fps = Math.round(stats.frames / ((Date.now() - stats.startTime) / 1000));
        for (const client of wss.clients) {
          if (client.readyState === 1) client.send(chunk);
        }
      });

      streamProcess.on('exit', (code) => {
        this._streams.delete(serial);
        this.emit('stream-stopped', { serial, code });
      });
    } else {
      // Fallback: periodic screencap via ADB (lower quality, for demo)
      const interval = this._startScreencapFallback(serial, wss, stats);
      streamProcess = { kill: () => clearInterval(interval), isFallback: true };
    }

    const connectionInfo = {
      serial,
      wsUrl: `ws://127.0.0.1:${wsPort}`,
      quality,
      preset,
      isFallback: !scrcpyAvailable,
    };

    this._streams.set(serial, { process: streamProcess, wss, port: wsPort, stats, connectionInfo });
    return connectionInfo;
  }

  _startScreencapFallback(serial, wss, stats) {
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);

    // Screencap every 100ms → ~10 FPS fallback
    const interval = setInterval(async () => {
      try {
        const { stdout } = await execAsync(
          `adb -s "${serial}" exec-out screencap -p`,
          { encoding: 'buffer', timeout: 5000 }
        );
        if (stdout && stdout.length > 0) {
          const msg = JSON.stringify({ type: 'frame', data: stdout.toString('base64'), mime: 'image/png' });
          for (const client of wss.clients) {
            if (client.readyState === 1) client.send(msg);
          }
          stats.frames++;
          stats.fps = Math.round(stats.frames / ((Date.now() - stats.startTime) / 1000));
        }
      } catch (_) {}
    }, 100);

    return interval;
  }

  async _checkScrcpy(bin) {
    try {
      const { execSync } = require('child_process');
      execSync(`"${bin}" --version`, { timeout: 3000, stdio: 'pipe' });
      return true;
    } catch (_) { return false; }
  }

  // -------------------------------------------------------------------------
  // Stop stream
  // -------------------------------------------------------------------------
  async stopStream(serial) {
    const entry = this._streams.get(serial);
    if (!entry) return { ok: true };
    try {
      entry.process.kill('SIGTERM');
      entry.wss.close();
    } catch (_) {}
    this._streams.delete(serial);
    return { ok: true };
  }

  stopAll() {
    for (const [serial] of this._streams) {
      this.stopStream(serial).catch(() => {});
    }
  }

  async setQuality(serial, quality) {
    const wasStreaming = this._streams.has(serial);
    if (wasStreaming) await this.stopStream(serial);
    if (wasStreaming) return this.startStream(serial, quality);
    return { ok: true };
  }

  getStats(serial) {
    const entry = this._streams.get(serial);
    if (!entry) return null;
    const { stats } = entry;
    stats.latency = Math.round(1000 / Math.max(stats.fps, 1)); // rough latency estimate
    return stats;
  }
}

module.exports = StreamManager;
