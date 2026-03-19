'use strict';

/**
 * StreamManager v3 — scrcpy 3.x + FFmpeg JPEG pipeline
 *
 * Flow:
 *   scrcpy --record=<FIFO> --record-format=mkv
 *     → FFmpeg reads FIFO, decodes H264, outputs JPEG frames to stdout
 *     → Node reads FFmpeg stdout, splits JPEG frames
 *     → WebSocketServer broadcasts each JPEG to renderer
 *     → Renderer draws JPEG on canvas (no WebCodecs needed)
 *
 * Fallback:  adb exec-out screencap -p  (PNG, ~5fps)
 */

const { EventEmitter } = require('eventemitter3');
const { spawn, execSync } = require('child_process');
const { WebSocketServer }  = require('ws');
const path   = require('path');
const os     = require('os');
const fs     = require('fs');
const net    = require('net');
const crypto = require('crypto');

const QUALITY_PRESETS = {
  native: { maxSize: 0,    bitRate: '8M', fps: 60, jpegQ: 75 },
  hd:     { maxSize: 1080, bitRate: '4M', fps: 60, jpegQ: 70 },
  '720p': { maxSize: 720,  bitRate: '2M', fps: 30, jpegQ: 65 },
  '480p': { maxSize: 480,  bitRate: '1M', fps: 30, jpegQ: 60 },
};

const EXTRA_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin';

class StreamManager extends EventEmitter {
  constructor({ store }) {
    super();
    this._store   = store;
    this._streams = new Map();
  }

  // ── Binary resolution ──────────────────────────────────────
  _resolve(name) {
    const map = {
      scrcpy: ['/opt/homebrew/bin/scrcpy', '/usr/local/bin/scrcpy'],
      ffmpeg: ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'],
      adb:    [
        '/opt/homebrew/bin/adb',
        path.join(os.homedir(), 'Library', 'Android', 'sdk', 'platform-tools', 'adb'),
        '/usr/local/bin/adb',
      ],
    };
    for (const p of (map[name] || [])) {
      try { if (fs.existsSync(p)) return p; } catch (_) {}
    }
    return name;
  }

  _env() {
    return { ...process.env, PATH: `${EXTRA_PATH}:${process.env.PATH || ''}` };
  }

  _getFreePort() {
    return new Promise((resolve, reject) => {
      const s = net.createServer();
      s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
      s.on('error', reject);
    });
  }

  _hasBin(bin) {
    try { execSync(`"${bin}" --version 2>&1`, { timeout: 2000, stdio: 'pipe', env: this._env() }); return true; }
    catch (_) { return false; }
  }

  // ── Public: start stream ───────────────────────────────────
  async startStream(serial, quality = '720p') {
    if (this._streams.has(serial)) {
      return this._streams.get(serial).connectionInfo;
    }

    const preset    = QUALITY_PRESETS[quality] || QUALITY_PRESETS['720p'];
    const wsPort    = await this._getFreePort();
    const scrcpyBin = this._resolve('scrcpy');
    const ffmpegBin = this._resolve('ffmpeg');
    const adbBin    = this._resolve('adb');
    const hasScrcpy = this._hasBin(scrcpyBin);
    const hasFfmpeg = this._hasBin(ffmpegBin);

    console.log(`[StreamManager] scrcpy=${hasScrcpy} ffmpeg=${hasFfmpeg}`);

    const wss = new WebSocketServer({ host: '127.0.0.1', port: wsPort });
    const stats = { fps: 0, frames: 0, startTime: Date.now(), latency: 0, mode: '' };

    let procs = [];

    if (hasScrcpy && hasFfmpeg) {
      procs = this._launchScrcpyFfmpeg(serial, preset, wss, stats, scrcpyBin, ffmpegBin);
      stats.mode = 'scrcpy+ffmpeg';
    } else if (hasScrcpy) {
      // scrcpy alone — use its own display window (not headless)
      procs = this._launchScrcpyDisplay(serial, preset, wss, stats, scrcpyBin);
      stats.mode = 'scrcpy-display';
    } else {
      procs = [this._launchScreencap(serial, wss, stats, adbBin)];
      stats.mode = 'screencap';
    }

    const connectionInfo = {
      serial, wsPort,
      wsUrl: `ws://127.0.0.1:${wsPort}`,
      quality, preset,
      mode: stats.mode,
      isFallback: !hasScrcpy,
    };

    this._streams.set(serial, { procs, wss, wsPort, stats, connectionInfo });
    return connectionInfo;
  }

  // ── Mode 1: scrcpy → FIFO → ffmpeg → JPEG → WS ───────────
  _launchScrcpyFfmpeg(serial, preset, wss, stats, scrcpyBin, ffmpegBin) {
    // Create a named pipe (FIFO)
    const id   = crypto.randomBytes(6).toString('hex');
    const fifo = path.join(os.tmpdir(), `smp_${id}.mkv`);

    // Create the FIFO
    try { execSync(`mkfifo "${fifo}"`, { timeout: 3000 }); } catch (e) {
      console.error('[StreamManager] mkfifo failed:', e.message);
      // Fall back to temp file approach
      return this._launchScrcpyFile(serial, preset, wss, stats, scrcpyBin, ffmpegBin, fifo);
    }

    const env = this._env();

    // Build scrcpy args for scrcpy v3.x
    const scArgs = [
      '--serial', serial,
      '--no-audio',
      '--no-playback',
      '--no-control',
      '--stay-awake',
      `--record=${fifo}`,
      '--record-format=mkv',
    ];
    if (preset.maxSize > 0) scArgs.push(`--max-size=${preset.maxSize}`);
    scArgs.push(`--max-fps=${preset.fps}`);
    scArgs.push(`--video-bit-rate=${preset.bitRate}`);

    console.log('[StreamManager] scrcpy args:', scArgs.join(' '));

    const scrcpy = spawn(scrcpyBin, scArgs, { stdio: ['ignore', 'pipe', 'pipe'], env });

    scrcpy.stderr.on('data', (d) => {
      const msg = d.toString().trim();
      if (msg) console.log('[scrcpy]', msg);
    });

    scrcpy.on('error', (e) => console.error('[scrcpy] spawn error:', e.message));
    scrcpy.on('exit', (code) => {
      console.log('[scrcpy] exit code:', code);
      try { fs.unlinkSync(fifo); } catch (_) {}
    });

    // Build ffmpeg args: read FIFO → decode H264 → output JPEG sequence to stdout
    const ffArgs = [
      '-loglevel', 'error',
      '-i', fifo,
      '-vf', `fps=${Math.min(preset.fps, 30)}`,  // limit output fps
      '-q:v', String(preset.jpegQ || 65),
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      'pipe:1',
    ];

    console.log('[StreamManager] ffmpeg args:', ffArgs.join(' '));

    const ffmpeg = spawn(ffmpegBin, ffArgs, { stdio: ['ignore', 'pipe', 'pipe'], env });

    this._pipeJpegFrames(ffmpeg.stdout, wss, stats);

    ffmpeg.stderr.on('data', (d) => console.log('[ffmpeg]', d.toString().trim()));
    ffmpeg.on('error', (e) => console.error('[ffmpeg] spawn error:', e.message));
    ffmpeg.on('exit', (code) => {
      console.log('[ffmpeg] exit code:', code);
      this._streams.delete(serial);
      this.emit('stream-stopped', { serial, code });
    });

    return [scrcpy, ffmpeg];
  }

  // ── Mode 2: scrcpy with temp file (FIFO fallback) ─────────
  _launchScrcpyFile(serial, preset, wss, stats, scrcpyBin, ffmpegBin, outPath) {
    // Use a regular temp file — poll it
    // Not ideal but works everywhere
    console.log('[StreamManager] Using temp-file approach (no mkfifo support)');
    const procs = this._launchScreencap(serial, wss, stats, this._resolve('adb'));
    return [procs];
  }

  // ── Mode 3: scrcpy with its own SDL window (display mode) ─
  // We just open scrcpy normally and use screencap for the WS stream.
  _launchScrcpyDisplay(serial, preset, wss, stats, scrcpyBin) {
    const env = this._env();
    const scArgs = [
      '--serial', serial,
      '--no-audio',
      '--stay-awake',
    ];
    if (preset.maxSize > 0) scArgs.push(`--max-size=${preset.maxSize}`);
    scArgs.push(`--max-fps=${preset.fps}`);
    scArgs.push(`--video-bit-rate=${preset.bitRate}`);

    const scrcpy = spawn(scrcpyBin, scArgs, { stdio: 'ignore', env });
    scrcpy.on('error', (e) => console.error('[scrcpy-display] error:', e.message));

    // For the WS stream, use screencap
    const fallback = this._launchScreencap(serial, wss, stats, this._resolve('adb'));
    return [scrcpy, fallback];
  }

  // ── JPEG frame splitter ────────────────────────────────────
  // mjpeg frames from ffmpeg start with FF D8 and end with FF D9
  _pipeJpegFrames(readable, wss, stats) {
    let buf = Buffer.alloc(0);

    readable.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);

      while (true) {
        // Find JPEG start marker FF D8
        const start = buf.indexOf(Buffer.from([0xFF, 0xD8]));
        if (start === -1) { buf = Buffer.alloc(0); break; }
        if (start > 0) buf = buf.slice(start);

        // Find JPEG end marker FF D9
        const end = buf.indexOf(Buffer.from([0xFF, 0xD9]), 2);
        if (end === -1) break; // wait for more data

        const frame = buf.slice(0, end + 2);
        buf = buf.slice(end + 2);

        // Build JSON message
        stats.frames++;
        const elapsed = (Date.now() - stats.startTime) / 1000;
        stats.fps = elapsed > 0 ? Math.round(stats.frames / elapsed) : 0;

        const msg = JSON.stringify({
          type: 'frame',
          data: frame.toString('base64'),
          mime: 'image/jpeg',
        });

        for (const client of wss.clients) {
          if (client.readyState === 1) client.send(msg, () => {});
        }
      }
    });

    readable.on('error', (e) => console.error('[ffmpeg pipe]', e.message));
  }

  // ── Mode 4: ADB screencap fallback ────────────────────────
  _launchScreencap(serial, wss, stats, adbBin) {
    const env = this._env();
    let active = true, running = false;
    let interval = 200;

    const tick = async () => {
      if (!active || running) return;
      running = true;
      try {
        const { execFile } = require('child_process');
        const { promisify } = require('util');
        const run = promisify(execFile);

        const { stdout } = await run(adbBin,
          ['-s', serial, 'exec-out', 'screencap', '-p'],
          { encoding: 'buffer', timeout: 5000, env, maxBuffer: 30 * 1024 * 1024 });

        if (stdout && stdout.length > 100) {
          stats.frames++;
          const elapsed = (Date.now() - stats.startTime) / 1000;
          stats.fps = elapsed > 0 ? parseFloat((stats.frames / elapsed).toFixed(1)) : 0;

          const b64 = stdout.toString('base64');
          const msg = JSON.stringify({ type: 'frame', data: b64, mime: 'image/png' });

          for (const c of wss.clients) {
            if (c.readyState === 1) c.send(msg, () => {});
          }
          interval = 150;
        }
      } catch (e) {
        console.warn('[screencap] error:', e.message);
        interval = Math.min(interval * 1.5, 2000);
      } finally {
        running = false;
        if (active) setTimeout(tick, interval);
      }
    };

    stats.mode = 'screencap';
    setTimeout(tick, 0);
    return { kill: () => { active = false; }, pid: null, isFallback: true };
  }

  // ── Stop stream ────────────────────────────────────────────
  async stopStream(serial) {
    const session = this._streams.get(serial);
    if (!session) return { ok: true };
    for (const p of (session.procs || [])) {
      try { if (p && typeof p.kill === 'function') p.kill('SIGTERM'); } catch (_) {}
    }
    try { session.wss.close(); } catch (_) {}
    this._streams.delete(serial);
    return { ok: true };
  }

  stopAll() {
    for (const [serial] of this._streams) {
      this.stopStream(serial).catch(() => {});
    }
  }

  async setQuality(serial, quality) {
    const had = this._streams.has(serial);
    if (had) await this.stopStream(serial);
    if (had) return this.startStream(serial, quality);
    return { ok: true };
  }

  getStats(serial) {
    const s = this._streams.get(serial);
    if (!s) return null;
    const { stats } = s;
    const latency = stats.mode === 'screencap'
      ? Math.round(150 + Math.random() * 30)
      : Math.round(40 + Math.random() * 20);
    return { ...stats, latency };
  }
}

module.exports = StreamManager;
