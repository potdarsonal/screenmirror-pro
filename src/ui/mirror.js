/* ============================================================
   ScreenMirror Pro — Mirror window renderer
   Handles: WebSocket video stream, mouse/keyboard control,
            recording, screenshots, hardware buttons
   ============================================================ */
'use strict';

// ── Parse serial from query string ───────────────────────────
const params   = new URLSearchParams(window.location.search);
const SERIAL   = params.get('serial') || '';
const MODEL    = params.get('model') || 'Android Device';

// ── DOM refs ─────────────────────────────────────────────────
const canvas       = document.getElementById('mirror-canvas');
const mirrorImg    = document.getElementById('mirror-img');
const ctx          = canvas.getContext('2d');
const overlay      = document.getElementById('mirror-overlay');
const mirrorMsg    = document.getElementById('mirror-message');
const kbInput      = document.getElementById('keyboard-input');
const windowTitle  = document.getElementById('window-title');

const connDot      = document.getElementById('conn-dot');
const connStatus   = document.getElementById('conn-status');
const statFps      = document.getElementById('stat-fps');
const statLatency  = document.getElementById('stat-latency');
const recTimerWrap = document.getElementById('rec-timer-wrap');
const recTimer     = document.getElementById('rec-timer');
const recordLabel  = document.getElementById('record-label');
const btnRecord    = document.getElementById('btn-record');
const qualitySelect = document.getElementById('quality-select');

// ── State ─────────────────────────────────────────────────────
const state = {
  ws: null,
  connected: false,
  recording: false,
  recStart: null,
  recInterval: null,
  statsInterval: null,
  pinned: false,
  quality: '720p',
  deviceWidth: 1080,
  deviceHeight: 1920,
  isFallback: false,
  // Touch gesture support
  lastTouchX: 0,
  lastTouchY: 0,
  mouseDown: false,
  downX: 0,
  downY: 0,
};

// ── Init ──────────────────────────────────────────────────────
async function init() {
  windowTitle.textContent = `${MODEL} — Mirror`;
  document.title = `${MODEL} — ScreenMirror Pro`;

  // Load saved quality
  const savedQuality = await window.smp.settings.get('quality') || '720p';
  qualitySelect.value = savedQuality;
  state.quality = savedQuality;

  setupToolbar();
  setupInputHandlers();
  setupHotkeyHandlers();

  await startStream();
  startStatsPolling();
}

// ── Streaming ─────────────────────────────────────────────────
async function startStream() {
  setStatus('connecting', 'Connecting…');
  mirrorMsg.textContent = 'Starting stream…';
  overlay.classList.remove('hidden');

  try {
    const info = await window.smp.stream.start({ serial: SERIAL, quality: state.quality });
    state.isFallback = info.isFallback;

    if (!info.wsUrl) throw new Error('No stream URL returned');

    connectWebSocket(info.wsUrl, info.isFallback);
  } catch (err) {
    mirrorMsg.textContent = 'Failed to start stream: ' + err.message;
    setStatus('disconnected', 'Error');
  }
}

function connectWebSocket(wsUrl, isFallback) {
  const ws = new WebSocket(wsUrl);
  ws.binaryType = 'arraybuffer';
  state.ws = ws;

  ws.onopen = () => {
    setStatus('connected', isFallback ? 'Screencap mode' : 'Streaming');
    mirrorMsg.textContent = 'Connected! Waiting for first frame…';
  };

  ws.onmessage = (event) => {
    if (isFallback) {
      handleFallbackFrame(event.data);
    } else {
      handleH264Frame(event.data);
    }
  };

  ws.onerror = () => {
    setStatus('disconnected', 'Stream error');
    mirrorMsg.textContent = 'Stream connection failed';
    overlay.classList.remove('hidden');
  };

  ws.onclose = () => {
    if (state.connected) {
      setStatus('disconnected', 'Disconnected');
      overlay.classList.remove('hidden');
    }
  };
}

// H264 frames: display via canvas (requires a decoder — use fallback img approach)
let h264FrameCount = 0;
const h264StartTime = Date.now();

function handleH264Frame(data) {
  // In production you'd decode H264 with WebCodecs API
  // For now, render frame count as indicator
  h264FrameCount++;
  if (overlay.classList.contains('hidden') === false) {
    overlay.classList.add('hidden');
  }
  // Draw a placeholder indicating stream is active
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#00d4aa';
  ctx.font = '14px Inter';
  ctx.textAlign = 'center';
  ctx.fillText(`H264 stream active — Frame ${h264FrameCount}`, canvas.width/2, canvas.height/2 - 20);
  ctx.fillStyle = '#606060';
  ctx.font = '11px Inter';
  ctx.fillText('Install scrcpy for full hardware-decoded rendering', canvas.width/2, canvas.height/2 + 10);
}

// Fallback: base64 PNG frames
function handleFallbackFrame(data) {
  try {
    const msg = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data));
    if (msg.type === 'frame' && msg.data) {
      const img = new Image();
      img.onload = () => {
        canvas.width  = img.naturalWidth  || 720;
        canvas.height = img.naturalHeight || 1280;
        ctx.drawImage(img, 0, 0);
        if (!overlay.classList.contains('hidden')) {
          overlay.classList.add('hidden');
        }
        state.deviceWidth  = img.naturalWidth;
        state.deviceHeight = img.naturalHeight;
        state.connected = true;
      };
      img.src = `data:${msg.mime};base64,${msg.data}`;
    }
  } catch (_) {
    // Binary frame, try as raw PNG
    try {
      const blob = new Blob([data], { type: 'image/png' });
      const url  = URL.createObjectURL(blob);
      const img  = new Image();
      img.onload = () => {
        canvas.width  = img.naturalWidth;
        canvas.height = img.naturalHeight;
        ctx.drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
        state.deviceWidth  = img.naturalWidth;
        state.deviceHeight = img.naturalHeight;
        if (!overlay.classList.contains('hidden')) overlay.classList.add('hidden');
        state.connected = true;
      };
      img.src = url;
    } catch (_) {}
  }
}

// ── Input: mouse events → ADB touch ──────────────────────────
function setupInputHandlers() {
  const wrap = document.getElementById('mirror-wrap');

  canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    state.mouseDown = true;
    const [dx, dy] = canvasToDevice(e.offsetX, e.offsetY);
    state.downX = dx; state.downY = dy;
    state.lastTouchX = e.offsetX; state.lastTouchY = e.offsetY;
  });

  canvas.addEventListener('mouseup', (e) => {
    if (!state.mouseDown) return;
    state.mouseDown = false;
    const [dx, dy] = canvasToDevice(e.offsetX, e.offsetY);
    const [ox, oy] = [state.downX, state.downY];
    const dist = Math.hypot(dx - ox, dy - oy);

    if (dist < 10) {
      // TAP
      window.smp.control.touch({ serial: SERIAL, action: 'tap', x: dx, y: dy });
    } else {
      // SWIPE
      window.smp.control.swipe({ serial: SERIAL, x1: ox, y1: oy, x2: dx, y2: dy, duration: 300 });
    }
  });

  // Context menu → right-click (long press)
  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const [dx, dy] = canvasToDevice(e.offsetX, e.offsetY);
    window.smp.control.swipe({ serial: SERIAL, x1: dx, y1: dy, x2: dx, y2: dy, duration: 600 });
  });

  // Scroll wheel → swipe up/down
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const [cx, cy] = canvasToDevice(e.offsetX, e.offsetY);
    const delta = e.deltaY;
    const endY = cy - delta * 2;
    window.smp.control.swipe({ serial: SERIAL, x1: cx, y1: cy, x2: cx, y2: endY, duration: 200 });
  }, { passive: false });

  // Keyboard input
  wrap.addEventListener('click', () => kbInput.focus());
  canvas.addEventListener('click', () => kbInput.focus());

  kbInput.addEventListener('keydown', handleKeyDown);
  kbInput.addEventListener('input', handleTextInput);

  // Drag canvas for swipe
  canvas.addEventListener('mousemove', (e) => {
    // No-op for now; swipe handled on mouseup
  });
}

function canvasToDevice(cx, cy) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = state.deviceWidth  / canvas.width;
  const scaleY = state.deviceHeight / canvas.height;
  return [
    Math.round(cx * scaleX),
    Math.round(cy * scaleY),
  ];
}

// Key handling
const ANDROID_KEYS = {
  F1:          3,   // Home
  F2:          4,   // Back
  F3:        187,   // Recents
  F4:         26,   // Power
  Escape:      4,
  Backspace:  67,
  Enter:      66,
  Tab:        61,
  ArrowUp:    19,
  ArrowDown:  20,
  ArrowLeft:  21,
  ArrowRight: 22,
  Delete:     67,
};

function handleKeyDown(e) {
  const keycode = ANDROID_KEYS[e.key];
  if (keycode !== undefined) {
    e.preventDefault();
    window.smp.control.key({ serial: SERIAL, keycode });
  }
}

function handleTextInput(e) {
  const val = kbInput.value;
  if (val.length > 0) {
    window.smp.control.text({ serial: SERIAL, text: val });
    kbInput.value = '';
  }
}

// ── Toolbar ───────────────────────────────────────────────────
function setupToolbar() {
  document.getElementById('btn-home').addEventListener('click',   () => window.smp.control.key({ serial: SERIAL, keycode: 3 }));
  document.getElementById('btn-back').addEventListener('click',   () => window.smp.control.key({ serial: SERIAL, keycode: 4 }));
  document.getElementById('btn-recent').addEventListener('click', () => window.smp.control.key({ serial: SERIAL, keycode: 187 }));
  document.getElementById('btn-vol-up').addEventListener('click', () => window.smp.control.key({ serial: SERIAL, keycode: 24 }));
  document.getElementById('btn-vol-down').addEventListener('click',() => window.smp.control.key({ serial: SERIAL, keycode: 25 }));

  document.getElementById('dpad-home').addEventListener('click',   () => window.smp.control.key({ serial: SERIAL, keycode: 3 }));
  document.getElementById('dpad-back').addEventListener('click',   () => window.smp.control.key({ serial: SERIAL, keycode: 4 }));
  document.getElementById('dpad-recent').addEventListener('click', () => window.smp.control.key({ serial: SERIAL, keycode: 187 }));

  document.getElementById('btn-record').addEventListener('click', toggleRecording);
  document.getElementById('btn-screenshot').addEventListener('click', takeScreenshot);

  document.getElementById('btn-pin').addEventListener('click', togglePin);
  document.getElementById('btn-rotate').addEventListener('click', rotateWindow);

  qualitySelect.addEventListener('change', async (e) => {
    state.quality = e.target.value;
    await window.smp.settings.set({ key: 'quality', value: state.quality });
    await window.smp.stream.stop({ serial: SERIAL });
    await startStream();
  });

  // Clipboard paste from PC
  document.addEventListener('paste', async (e) => {
    const text = e.clipboardData?.getData('text');
    if (text) {
      await window.smp.control.clipboardPaste({ serial: SERIAL, text });
    }
  });
}

// ── Record ────────────────────────────────────────────────────
async function toggleRecording() {
  if (state.recording) {
    const result = await window.smp.record.stop({ serial: SERIAL });
    state.recording = false;
    clearInterval(state.recInterval);
    recTimerWrap.style.display = 'none';
    btnRecord.classList.remove('recording');
    recordLabel.textContent = 'Record';
    if (result?.ok && result.outputPath) {
      showNotification(`Saved: ${result.outputPath}`);
    }
  } else {
    const dir = await window.smp.settings.get('recordingsDir') || require('os').homedir() + '/Movies/ScreenMirror Pro';
    const now = new Date();
    const ts  = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const outputPath = `${dir}/${MODEL}_${ts}.mp4`;

    const result = await window.smp.record.start({ serial: SERIAL, outputPath });
    if (result?.ok) {
      state.recording = true;
      state.recStart  = Date.now();
      btnRecord.classList.add('recording');
      recordLabel.textContent = 'Stop';
      recTimerWrap.style.display = 'flex';
      state.recInterval = setInterval(updateRecTimer, 1000);
    } else {
      showNotification('Recording failed: ' + (result?.message || 'Unknown error'));
    }
  }
}

function updateRecTimer() {
  const elapsed = Math.floor((Date.now() - state.recStart) / 1000);
  recTimer.textContent = `${pad(Math.floor(elapsed/60))}:${pad(elapsed%60)}`;
}

// ── Screenshot ────────────────────────────────────────────────
async function takeScreenshot() {
  const dir = await window.smp.settings.get('recordingsDir') || require('os').homedir() + '/Pictures/ScreenMirror Pro';
  const now  = new Date();
  const ts   = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const outputPath = `${dir}/${MODEL}_${ts}.png`;

  const result = await window.smp.screenshot.take({ serial: SERIAL, outputPath });
  if (result?.ok) {
    showNotification(`Screenshot saved`);
    await window.smp.shell.openPath(result.path);
  } else {
    showNotification('Screenshot failed: ' + (result?.message || ''));
  }
}

// ── Stats polling ─────────────────────────────────────────────
function startStatsPolling() {
  state.statsInterval = setInterval(async () => {
    try {
      const stats = await window.smp.stream.stats({ serial: SERIAL });
      if (stats) {
        statFps.textContent     = stats.fps || '—';
        statLatency.textContent = stats.latency ? `${stats.latency}ms` : '—';
      }
    } catch (_) {}
  }, 1500);
}

// ── Pin / rotate ───────────────────────────────────────────────
async function togglePin() {
  state.pinned = !state.pinned;
  const btn = document.getElementById('btn-pin');
  btn.style.opacity = state.pinned ? '1' : '0.5';
  await window.smp.window.alwaysOnTop({ serial: SERIAL, enabled: state.pinned });
}

async function rotateWindow() {
  await window.smp.window.rotate({ serial: SERIAL });
}

// ── Hotkey handlers ───────────────────────────────────────────
function setupHotkeyHandlers() {
  window.smp.on.hotkeyRecord(() => toggleRecording());
  window.smp.on.hotkeyScreenshot(() => takeScreenshot());
}

// ── Status helper ─────────────────────────────────────────────
function setStatus(type, text) {
  connStatus.textContent = text;
  connDot.className = 'dot ' + (type === 'connected' ? 'dot-green' : type === 'connecting' ? 'dot-grey' : 'dot-red');
  state.connected = type === 'connected';
}

// ── Notification ──────────────────────────────────────────────
function showNotification(msg) {
  const el = document.createElement('div');
  el.textContent = msg;
  Object.assign(el.style, {
    position: 'fixed', bottom: '60px', left: '50%',
    transform: 'translateX(-50%)',
    background: 'rgba(0,0,0,0.8)',
    color: '#00d4aa',
    padding: '8px 16px',
    borderRadius: '20px',
    fontSize: '11px',
    fontFamily: 'Inter, sans-serif',
    border: '1px solid rgba(0,212,170,0.3)',
    zIndex: '9999',
    transition: 'opacity 0.3s ease',
  });
  document.body.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 2500);
}

// ── Helpers ───────────────────────────────────────────────────
function pad(n) { return String(n).padStart(2, '0'); }

// ── Bootstrap ─────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);

// Cleanup on unload
window.addEventListener('beforeunload', () => {
  clearInterval(state.statsInterval);
  clearInterval(state.recInterval);
  if (state.ws) state.ws.close();
});
