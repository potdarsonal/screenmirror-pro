/* ============================================================
   ScreenMirror Pro — Mirror window renderer v2
   H264 decoded via browser WebCodecs API (hardware accelerated)
   Fallback: PNG frames from ADB screencap
   ============================================================ */
'use strict';

// ── Parse device params ───────────────────────────────────────
const params = new URLSearchParams(window.location.search);
const SERIAL = params.get('serial') || '';
const MODEL  = params.get('model')  || 'Android Device';

// ── DOM refs ─────────────────────────────────────────────────
const canvas        = document.getElementById('mirror-canvas');
const ctx           = canvas.getContext('2d');
const overlay       = document.getElementById('mirror-overlay');
const mirrorMsg     = document.getElementById('mirror-message');
const kbInput       = document.getElementById('keyboard-input');
const windowTitle   = document.getElementById('window-title');
const connDot       = document.getElementById('conn-dot');
const connStatus    = document.getElementById('conn-status');
const statFps       = document.getElementById('stat-fps');
const statLatency   = document.getElementById('stat-latency');
const recTimerWrap  = document.getElementById('rec-timer-wrap');
const recTimer      = document.getElementById('rec-timer');
const recordLabel   = document.getElementById('record-label');
const btnRecord     = document.getElementById('btn-record');
const qualitySelect = document.getElementById('quality-select');

// ── State ─────────────────────────────────────────────────────
const state = {
  ws: null,
  connected: false,
  mode: null,           // 'scrcpy' | 'screencap'
  decoder: null,        // VideoDecoder (WebCodecs)
  recording: false,
  recStart: null,
  recInterval: null,
  statsInterval: null,
  pinned: false,
  quality: '720p',
  deviceWidth: 1080,
  deviceHeight: 1920,
  mouseDown: false,
  downX: 0,
  downY: 0,
  // H264 parsing
  h264Buf: new Uint8Array(0),
  spsFound: false,
};

// ── WebCodecs VideoDecoder setup ──────────────────────────────
function initVideoDecoder() {
  if (!('VideoDecoder' in window)) {
    console.warn('[Mirror] WebCodecs not supported — will use canvas rendering');
    return null;
  }

  const decoder = new VideoDecoder({
    output: (frame) => {
      // Draw decoded frame onto canvas
      canvas.width  = frame.displayWidth  || frame.codedWidth;
      canvas.height = frame.displayHeight || frame.codedHeight;
      state.deviceWidth  = canvas.width;
      state.deviceHeight = canvas.height;
      ctx.drawImage(frame, 0, 0);
      frame.close();

      if (!overlay.classList.contains('hidden')) {
        overlay.classList.add('hidden');
        state.connected = true;
        setStatus('connected', 'Streaming (H264)');
      }
    },
    error: (e) => {
      console.error('[Mirror] VideoDecoder error:', e);
      // Reset decoder on error
      state.spsFound = false;
      state.h264Buf  = new Uint8Array(0);
    },
  });

  return decoder;
}

// ── H264 NAL unit parsing ─────────────────────────────────────
// scrcpy sends raw Annex-B H264. We need to find NAL boundaries
// and submit chunks to VideoDecoder.

function appendToH264Buffer(newData) {
  const combined = new Uint8Array(state.h264Buf.length + newData.length);
  combined.set(state.h264Buf, 0);
  combined.set(newData, state.h264Buf.length);
  state.h264Buf = combined;
}

// Find Annex-B start codes (0x00 0x00 0x00 0x01 or 0x00 0x00 0x01)
function findStartCode(buf, offset) {
  for (let i = offset; i < buf.length - 3; i++) {
    if (buf[i] === 0 && buf[i+1] === 0) {
      if (buf[i+2] === 0 && buf[i+3] === 1) return { pos: i, len: 4 };
      if (buf[i+2] === 1) return { pos: i, len: 3 };
    }
  }
  return null;
}

function getNALType(buf, startLen) {
  return buf[startLen] & 0x1F;
}

let pendingChunks = [];
let decoderConfigured = false;

function processH264Buffer() {
  const decoder = state.decoder;
  if (!decoder) return;

  const buf = state.h264Buf;
  const nals = [];
  let searchFrom = 0;
  let lastStart = null;

  // Parse out all complete NAL units
  while (true) {
    const sc = findStartCode(buf, searchFrom);
    if (!sc) break;
    if (lastStart !== null) {
      nals.push(buf.slice(lastStart.pos, sc.pos));
    }
    lastStart = sc;
    searchFrom = sc.pos + sc.len;
  }

  if (nals.length === 0) return;

  // Keep remainder in buffer
  state.h264Buf = lastStart ? buf.slice(lastStart.pos) : buf;

  let spsData = null, ppsData = null;

  for (const nal of nals) {
    if (nal.length < 4) continue;
    const sc = (nal[2] === 1) ? 3 : 4;
    const nalType = nal[sc] & 0x1F;

    if (nalType === 7) { spsData = nal; state.spsFound = true; }  // SPS
    if (nalType === 8) { ppsData = nal; }   // PPS

    if (!state.spsFound) continue; // wait for SPS before sending anything

    // Configure decoder once we have SPS + PPS
    if (!decoderConfigured && spsData && ppsData) {
      try {
        decoder.configure({
          codec: 'avc1.42E01E', // H.264 Baseline Profile
          hardwareAcceleration: 'prefer-hardware',
          optimizeForLatency: true,
        });
        decoderConfigured = true;
        console.log('[Mirror] VideoDecoder configured');
      } catch (e) {
        console.error('[Mirror] Configure error:', e);
        return;
      }
    }

    if (!decoderConfigured) { pendingChunks.push(nal); continue; }

    const keyFrame = (nalType === 5 || nalType === 7 || nalType === 8);
    try {
      decoder.decode(new EncodedVideoChunk({
        type: keyFrame ? 'key' : 'delta',
        timestamp: performance.now() * 1000,
        data: nal,
      }));
    } catch (_) {}
  }
}

// ── WebSocket connection ──────────────────────────────────────
function connectWebSocket(wsUrl, mode) {
  const ws = new WebSocket(wsUrl);
  ws.binaryType = 'arraybuffer';
  state.ws   = ws;
  state.mode = mode;

  ws.onopen = () => {
    console.log('[Mirror] WS connected, mode:', mode);
    setStatus('connecting', mode === 'scrcpy' ? 'Decoding H264…' : 'Screencap mode');
    mirrorMsg.textContent = 'Connected — waiting for first frame…';
  };

  ws.onmessage = (event) => {
    if (mode === 'screencap' || mode === 'scrcpy+ffmpeg' || mode === 'scrcpy-display') {
      handleImageFrame(event.data);
    } else {
      // Raw H264 binary (future WebCodecs path)
      handleScrcpyFrame(event.data);
    }
  };

  ws.onerror = (e) => {
    console.error('[Mirror] WS error', e);
    setStatus('disconnected', 'Stream error');
    mirrorMsg.textContent = 'Stream lost — check device connection';
    overlay.classList.remove('hidden');
  };

  ws.onclose = () => {
    console.log('[Mirror] WS closed');
    if (state.connected) {
      setStatus('disconnected', 'Disconnected');
      overlay.classList.remove('hidden');
    }
  };
}

// H264 frame handler (scrcpy mode)
let frameCount = 0;
function handleScrcpyFrame(data) {
  const chunk = new Uint8Array(data);
  frameCount++;

  if (state.decoder) {
    appendToH264Buffer(chunk);
    processH264Buffer();
  } else {
    // WebCodecs not available — show placeholder
    if (overlay.classList.contains('hidden')) return;
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw gradient background
    const grad = ctx.createRadialGradient(canvas.width/2, canvas.height/2, 0, canvas.width/2, canvas.height/2, canvas.width);
    grad.addColorStop(0, 'rgba(0,212,170,0.05)');
    grad.addColorStop(1, 'transparent');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = '#00d4aa';
    ctx.font = 'bold 15px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`H264 stream active`, canvas.width/2, canvas.height/2 - 30);
    ctx.fillStyle = '#555';
    ctx.font = '12px Inter, sans-serif';
    ctx.fillText(`Frame #${frameCount}`, canvas.width/2, canvas.height/2);
    ctx.fillStyle = '#333';
    ctx.font = '11px Inter, sans-serif';
    ctx.fillText('WebCodecs not supported in this Electron build', canvas.width/2, canvas.height/2 + 24);
    overlay.classList.add('hidden');
    state.connected = true;
    setStatus('connected', 'H264 (no decoder)');
  }
}

// Unified image frame handler — handles JPEG (scrcpy+ffmpeg) AND PNG (screencap fallback)
function handleImageFrame(data) {
  try {
    const msg = typeof data === 'string' ? JSON.parse(data) : JSON.parse(new TextDecoder().decode(data));
    if (msg.type === 'frame' && msg.data) {
      const img = new Image();
      img.onload = () => {
        canvas.width  = img.naturalWidth  || canvas.width;
        canvas.height = img.naturalHeight || canvas.height;
        state.deviceWidth  = canvas.width;
        state.deviceHeight = canvas.height;
        ctx.drawImage(img, 0, 0);
        if (!overlay.classList.contains('hidden')) {
          overlay.classList.add('hidden');
          state.connected = true;
          setStatus('connected', msg.mime === 'image/jpeg' ? 'Streaming (JPEG)' : 'Streaming (PNG)');
        }
      };
      img.src = `data:${msg.mime};base64,${msg.data}`;
    }
  } catch (_) {}
}

// ── Init ──────────────────────────────────────────────────────
async function init() {
  windowTitle.textContent = `${MODEL} — Mirror`;
  document.title = `${MODEL} — ScreenMirror Pro`;

  const savedQ = await window.smp.settings.get('quality') || '720p';
  qualitySelect.value = savedQ;
  state.quality = savedQ;

  // Init WebCodecs decoder
  state.decoder = initVideoDecoder();

  setupToolbar();
  setupInputHandlers();
  setupHotkeyHandlers();
  await startStream();
  startStatsPolling();
}

// ── Start stream ──────────────────────────────────────────────
async function startStream() {
  setStatus('connecting', 'Connecting…');
  mirrorMsg.textContent = 'Starting stream…';
  overlay.classList.remove('hidden');

  // Reset H264 state
  state.h264Buf = new Uint8Array(0);
  state.spsFound = false;
  decoderConfigured = false;
  pendingChunks = [];
  frameCount = 0;

  try {
    const info = await window.smp.stream.start({ serial: SERIAL, quality: state.quality });
    console.log('[Mirror] Stream info:', info);

    if (!info || !info.wsUrl) throw new Error('No stream URL returned from main process');

    connectWebSocket(info.wsUrl, info.mode || (info.isFallback ? 'screencap' : 'scrcpy'));
  } catch (err) {
    console.error('[Mirror] startStream error:', err);
    mirrorMsg.textContent = 'Failed: ' + err.message;
    setStatus('disconnected', 'Error');
  }
}

// ── Input handling ─────────────────────────────────────────────
function setupInputHandlers() {
  canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    state.mouseDown = true;
    const [dx, dy] = toDevice(e.offsetX, e.offsetY);
    state.downX = dx; state.downY = dy;
  });

  canvas.addEventListener('mouseup', (e) => {
    if (!state.mouseDown) return;
    state.mouseDown = false;
    const [dx, dy] = toDevice(e.offsetX, e.offsetY);
    const dist = Math.hypot(dx - state.downX, dy - state.downY);
    if (dist < 12) {
      window.smp.control.touch({ serial: SERIAL, action: 'tap', x: dx, y: dy });
    } else {
      window.smp.control.swipe({ serial: SERIAL, x1: state.downX, y1: state.downY, x2: dx, y2: dy, duration: 300 });
    }
  });

  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const [dx, dy] = toDevice(e.offsetX, e.offsetY);
    window.smp.control.swipe({ serial: SERIAL, x1: dx, y1: dy, x2: dx, y2: dy, duration: 600 });
  });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const [cx, cy] = toDevice(e.offsetX, e.offsetY);
    const endY = cy - e.deltaY * 2;
    window.smp.control.swipe({ serial: SERIAL, x1: cx, y1: cy, x2: cx, y2: endY, duration: 200 });
  }, { passive: false });

  canvas.addEventListener('click', () => kbInput.focus());
  document.getElementById('mirror-wrap').addEventListener('click', () => kbInput.focus());

  kbInput.addEventListener('keydown', (e) => {
    const ANDROID_KEYS = { F1:3, F2:4, F3:187, F4:26, Escape:4, Backspace:67, Enter:66, Tab:61, ArrowUp:19, ArrowDown:20, ArrowLeft:21, ArrowRight:22, Delete:67 };
    const kc = ANDROID_KEYS[e.key];
    if (kc !== undefined) { e.preventDefault(); window.smp.control.key({ serial: SERIAL, keycode: kc }); }
  });

  kbInput.addEventListener('input', () => {
    const v = kbInput.value;
    if (v) { window.smp.control.text({ serial: SERIAL, text: v }); kbInput.value = ''; }
  });

  document.addEventListener('paste', async (e) => {
    const text = e.clipboardData?.getData('text');
    if (text) window.smp.control.clipboardPaste({ serial: SERIAL, text });
  });
}

function toDevice(cx, cy) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = state.deviceWidth  / (rect.width  || canvas.width);
  const scaleY = state.deviceHeight / (rect.height || canvas.height);
  return [Math.round(cx * scaleX), Math.round(cy * scaleY)];
}

// ── Toolbar ───────────────────────────────────────────────────
function setupToolbar() {
  document.getElementById('btn-home').addEventListener('click',    () => window.smp.control.key({ serial: SERIAL, keycode: 3 }));
  document.getElementById('btn-back').addEventListener('click',    () => window.smp.control.key({ serial: SERIAL, keycode: 4 }));
  document.getElementById('btn-recent').addEventListener('click',  () => window.smp.control.key({ serial: SERIAL, keycode: 187 }));
  document.getElementById('btn-vol-up').addEventListener('click',  () => window.smp.control.key({ serial: SERIAL, keycode: 24 }));
  document.getElementById('btn-vol-down').addEventListener('click',() => window.smp.control.key({ serial: SERIAL, keycode: 25 }));
  document.getElementById('dpad-home').addEventListener('click',   () => window.smp.control.key({ serial: SERIAL, keycode: 3 }));
  document.getElementById('dpad-back').addEventListener('click',   () => window.smp.control.key({ serial: SERIAL, keycode: 4 }));
  document.getElementById('dpad-recent').addEventListener('click', () => window.smp.control.key({ serial: SERIAL, keycode: 187 }));
  document.getElementById('btn-record').addEventListener('click',    toggleRecording);
  document.getElementById('btn-screenshot').addEventListener('click', takeScreenshot);
  document.getElementById('btn-pin').addEventListener('click',      togglePin);
  document.getElementById('btn-rotate').addEventListener('click',   rotateWindow);

  qualitySelect.addEventListener('change', async (e) => {
    state.quality = e.target.value;
    await window.smp.settings.set({ key: 'quality', value: state.quality });
    if (state.ws) state.ws.close();
    await window.smp.stream.stop({ serial: SERIAL });
    await startStream();
  });
}

// ── Recording ─────────────────────────────────────────────────
async function toggleRecording() {
  if (state.recording) {
    const res = await window.smp.record.stop({ serial: SERIAL });
    state.recording = false;
    clearInterval(state.recInterval);
    recTimerWrap.style.display = 'none';
    btnRecord.classList.remove('recording');
    recordLabel.textContent = 'Record';
    if (res?.ok && res.outputPath) showNotification(`Saved: ${res.outputPath}`);
  } else {
    const dir  = await window.smp.settings.get('recordingsDir') || (require('os').homedir() + '/Movies/ScreenMirror Pro');
    const ts   = new Date().toISOString().replace(/[:.]/g,'').slice(0,15);
    const out  = `${dir}/${MODEL.replace(/\s/g,'_')}_${ts}.mp4`;
    const res  = await window.smp.record.start({ serial: SERIAL, outputPath: out });
    if (res?.ok) {
      state.recording = true; state.recStart = Date.now();
      btnRecord.classList.add('recording'); recordLabel.textContent = 'Stop';
      recTimerWrap.style.display = 'flex';
      state.recInterval = setInterval(updateRecTimer, 1000);
    } else {
      showNotification('Recording failed: ' + (res?.message || ''));
    }
  }
}
function updateRecTimer() {
  const s = Math.floor((Date.now() - state.recStart) / 1000);
  recTimer.textContent = `${pad(Math.floor(s/60))}:${pad(s%60)}`;
}

async function takeScreenshot() {
  const dir = await window.smp.settings.get('recordingsDir') || (require('os').homedir() + '/Pictures/ScreenMirror Pro');
  const ts  = new Date().toISOString().replace(/[:.]/g,'').slice(0,15);
  const out = `${dir}/${MODEL.replace(/\s/g,'_')}_${ts}.png`;
  const res = await window.smp.screenshot.take({ serial: SERIAL, outputPath: out });
  if (res?.ok) { showNotification('Screenshot saved'); window.smp.shell.openPath(res.path); }
  else showNotification('Screenshot failed: ' + (res?.message || ''));
}

// ── Stats polling ─────────────────────────────────────────────
function startStatsPolling() {
  state.statsInterval = setInterval(async () => {
    try {
      const s = await window.smp.stream.stats({ serial: SERIAL });
      if (s) {
        statFps.textContent     = s.fps > 0 ? s.fps : '—';
        statLatency.textContent = s.latency ? `${s.latency}ms` : '—';
      }
    } catch (_) {}
  }, 1500);
}

// ── Helpers ───────────────────────────────────────────────────
async function togglePin() {
  state.pinned = !state.pinned;
  document.getElementById('btn-pin').style.opacity = state.pinned ? '1' : '0.5';
  await window.smp.window.alwaysOnTop({ serial: SERIAL, enabled: state.pinned });
}
async function rotateWindow() { await window.smp.window.rotate({ serial: SERIAL }); }

function setupHotkeyHandlers() {
  window.smp.on.hotkeyRecord(() => toggleRecording());
  window.smp.on.hotkeyScreenshot(() => takeScreenshot());
}

function setStatus(type, text) {
  connStatus.textContent = text;
  connDot.className = 'dot ' + (type === 'connected' ? 'dot-green' : type === 'connecting' ? 'dot-grey' : 'dot-red');
  if (type === 'connected') state.connected = true;
}

function showNotification(msg) {
  const el = document.createElement('div');
  el.textContent = msg;
  Object.assign(el.style, {
    position:'fixed', bottom:'60px', left:'50%', transform:'translateX(-50%)',
    background:'rgba(0,0,0,0.85)', color:'#00d4aa', padding:'8px 16px',
    borderRadius:'20px', fontSize:'11px', fontFamily:'Inter,sans-serif',
    border:'1px solid rgba(0,212,170,0.3)', zIndex:'9999', transition:'opacity 0.3s',
  });
  document.body.appendChild(el);
  setTimeout(() => { el.style.opacity='0'; setTimeout(()=>el.remove(), 300); }, 2500);
}

function pad(n) { return String(n).padStart(2,'0'); }

// ── Bootstrap ─────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);

window.addEventListener('beforeunload', () => {
  clearInterval(state.statsInterval);
  clearInterval(state.recInterval);
  if (state.ws) state.ws.close();
  if (state.decoder && state.decoder.state !== 'closed') state.decoder.close();
});
