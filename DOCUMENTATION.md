# ScreenMirror Pro — Application Documentation

> **Version**: 1.0.0  
> **Platform**: macOS · Windows · Linux  
> **Tech stack**: Electron 29 · Node.js · ADB · scrcpy  
> **License**: MIT

---

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
3. [Installation & Setup](#3-installation--setup)
4. [Connecting Your Android Device](#4-connecting-your-android-device)
5. [Features In-Depth](#5-features-in-depth)
6. [Keyboard & Mouse Control Reference](#6-keyboard--mouse-control-reference)
7. [Global Hotkeys](#7-global-hotkeys)
8. [Quality & Performance Tuning](#8-quality--performance-tuning)
9. [Recording & Screenshots](#9-recording--screenshots)
10. [Wireless (WiFi) Connection](#10-wireless-wifi-connection)
11. [Multi-Device Support](#11-multi-device-support)
12. [Settings](#12-settings)
13. [Building for Distribution](#13-building-for-distribution)
14. [Troubleshooting](#14-troubleshooting)
15. [Security & Privacy](#15-security--privacy)
16. [Project File Structure](#16-project-file-structure)

---

## 1. Overview

**ScreenMirror Pro** is a cross-platform desktop application that mirrors your Android device's
screen in real-time with ultra-low latency and gives you full mouse and keyboard control — all
without root access or any special Android app installation.

### Why ScreenMirror Pro?

| | ScreenMirror Pro | Vysor | AirDroid |
|---|---|---|---|
| Open protocol | ✅ scrcpy | ❌ proprietary | ❌ proprietary |
| No root | ✅ | ✅ | ✅ |
| Local only | ✅ | ❌ cloud | ❌ cloud |
| Multi-device | ✅ | 💰 paid | 💰 paid |
| Recording | ✅ | 💰 paid | 💰 paid |
| Dark UI | ✅ | ❌ | ❌ |
| Free | ✅ | limited | limited |

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Electron Main Process                 │
│                                                         │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │ ADBManager  │  │StreamManager │  │ControlManager │  │
│  │             │  │              │  │               │  │
│  │• Poll devs  │  │• Launch scrcpy│  │• touch/swipe  │  │
│  │• Wireless   │  │• WS server   │  │• keyevent     │  │
│  │• QR pair    │  │• Screencap   │  │• text input   │  │
│  │• Screenshot │  │  fallback    │  │• clipboard    │  │
│  └─────────────┘  └──────────────┘  └───────────────┘  │
│                                                         │
│  ┌──────────────────┐  ┌─────────────────────────────┐  │
│  │ RecordingManager │  │         IPC Layer            │  │
│  │• scrcpy --record │  │  contextBridge (secure)      │  │
│  │• adb screenrecord│  │  No nodeIntegration          │  │
│  └──────────────────┘  └─────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
                         │ IPC
        ┌────────────────┴────────────────┐
        │                                 │
┌───────▼────────┐               ┌────────▼────────┐
│  Main Window   │               │  Mirror Window  │
│  (Renderer)    │               │  (per device)   │
│                │               │                 │
│ • Device list  │               │ • Canvas/WebGL  │
│ • Sidebar      │               │ • WS client     │
│ • Wireless     │               │ • Input capture │
│   modal        │               │ • Toolbar       │
│ • Settings     │               │ • Status bar    │
└────────────────┘               └─────────────────┘
```

### Key Design Decisions

| Decision | Rationale |
|---|---|
| **Electron over Tauri** | Wider ecosystem, faster iteration, no Rust toolchain required |
| **scrcpy subprocess** | Battle-tested <100ms latency, H264 hardware acceleration |
| **WebSocket bridge** | Decouples stream from IPC; supports future WebRTC upgrade |
| **contextBridge IPC** | Security: renderer has no direct Node.js access |
| **Screencap fallback** | Works even without scrcpy installed (lower fps, higher compat) |
| **ADB polling vs events** | Simple 2s poll avoids `adb track-devices` daemon dependency |

---

## 3. Installation & Setup

### Prerequisites

```bash
# macOS (Homebrew)
brew install node
brew install android-platform-tools    # provides ADB
brew install scrcpy                    # recommended for full 60fps H264

# Ubuntu/Debian
sudo apt install adb scrcpy nodejs npm

# Windows
# 1. Install Node.js from https://nodejs.org
# 2. Install ADB: https://developer.android.com/studio/releases/platform-tools
# 3. Install scrcpy: https://github.com/Genymobile/scrcpy/releases
# 4. Add both to PATH
```

### Install & Run

```bash
# Install dependencies
npm install

# Development mode (with DevTools)
npm run dev

# Production mode
npm start
```

---

## 4. Connecting Your Android Device

### Enable USB Debugging (one-time setup)

1. Open **Settings** on your Android device
2. Go to **About phone** (or About device)
3. Tap **Build number** exactly **7 times** — you'll see "You are now a developer!"
4. Go back to **Settings → System → Developer options**
5. Enable **USB debugging**
6. Connect via USB cable
7. On the "Allow USB debugging?" prompt on device — tap **Allow** ✓

> **Android 11+**: For wireless pairing, also enable **Wireless debugging** in Developer options.

### Verify ADB sees your device

```bash
adb devices
# Should show:
# List of devices attached
# ABCDEF123456   device
```

---

## 5. Features In-Depth

### 5.1 Real-Time Screen Mirror

The app uses **scrcpy** to capture and stream the device screen:

- H.264 hardware-encoded on the device (very low CPU overhead)
- Streamed as a binary H264 bitstream over a local WebSocket
- Rendered on an HTML5 `<canvas>` element in the mirror window
- **Fallback**: if scrcpy is not installed, uses `adb exec-out screencap -p` at ~10fps

### 5.2 Quality Presets

| Preset | Max Resolution | Bitrate | Target FPS |
|---|---|---|---|
| Native | Device native | 8 Mbps | 60 |
| HD 1080p | 1080p | 4 Mbps | 60 |
| 720p (default) | 720p | 2 Mbps | 30 |
| 480p | 480p | 1 Mbps | 30 |

### 5.3 Input Control

All input is relayed via `adb shell input` commands:

| User action | ADB command |
|---|---|
| Mouse click | `input tap X Y` |
| Mouse drag | `input swipe X1 Y1 X2 Y2 duration` |
| Right-click | `input swipe X Y X Y 600` (long press) |
| Scroll wheel | `input swipe cx cy cx ey 200` |
| Keyboard char | `input text 'char'` |
| Special key | `input keyevent KEYCODE` |
| Paste clipboard | ADB broadcast → device clipboard |

### 5.4 Device Info Shown

- Model name & brand
- Android version
- Screen resolution
- Battery level (with color indicator)
- Connection type (USB / WiFi)

---

## 6. Keyboard & Mouse Control Reference

### Mouse

| Action | Result on Device |
|---|---|
| **Left click** | Tap at position |
| **Click + drag** | Swipe gesture |
| **Right click** | Long press (600ms) |
| **Scroll up/down** | Swipe up/down |

### Keyboard

| Key | Android Action |
|---|---|
| `F1` | Home button |
| `F2` / `Escape` | Back button |
| `F3` | Recent apps |
| `F4` | Power button |
| `Arrow keys` | D-pad navigation |
| `Enter` | Confirm / OK |
| `Backspace` | Delete |
| All printable chars | Text input to device |

### Paste to Device

Press `⌘V` / `Ctrl+V` while the mirror window is focused — the clipboard text is
sent to the Android device's clipboard and can be pasted with long-press → Paste.

---

## 7. Global Hotkeys

These work system-wide (even when the app window is not focused):

| Hotkey | Action |
|---|---|
| `⌘⌥D` (Mac) / `Ctrl+Alt+D` (Win/Linux) | Show / hide main window |
| `⌘⌥R` (Mac) / `Ctrl+Alt+R` (Win/Linux) | Toggle recording on focused mirror |
| `⌘⌥S` (Mac) / `Ctrl+Alt+S` (Win/Linux) | Screenshot on focused mirror |

---

## 8. Quality & Performance Tuning

### For <100ms USB latency

```bash
brew install scrcpy    # required for H264 path
```

scrcpy uses hardware H264 encoding on device and streams at full 60fps over the
USB 2.0 bus, which has ~5ms physical latency.

### For wireless (WiFi)

- Use 5GHz WiFi for best results
- Expected latency: 50–150ms on same network
- Recommended quality: 720p @ 2Mbps

### If you see lag

1. Switch to a lower quality preset in the toolbar dropdown
2. Ensure USB cable is USB 3.0 (blue port preferred)
3. Close other apps consuming network bandwidth
4. Try `adb kill-server && adb start-server` to restart ADB daemon

---

## 9. Recording & Screenshots

### Recording

1. Click **⏺ Record** in the mirror window toolbar (or `⌘⌥R`)
2. A timer appears in the status bar
3. Click **Stop** (or `⌘⌥R` again) when done
4. File saved to your configured recordings directory (default: `~/Movies/ScreenMirror Pro/`)

Recording uses:
- **scrcpy `--record`** if available → proper MP4 with timestamps
- **`adb shell screenrecord`** fallback → pulls file from device after stop

### Screenshots

1. Click **📷 Screenshot** in toolbar (or `⌘⌥S`)
2. Saved as PNG to `~/Pictures/ScreenMirror Pro/` by default
3. File is automatically revealed in Finder/Explorer

---

## 10. Wireless (WiFi) Connection

### Method A — From a connected USB device

```bash
# 1. While device is connected via USB:
adb tcpip 5555

# 2. Find device IP (Settings → WiFi → your network → IP address)

# 3. In the app: click "+" → enter IP → Connect
```

### Method B — Android 11+ Wireless Debugging

1. Settings → Developer options → Wireless debugging → Enable
2. Tap **Pair device with pairing code**
3. In the app, the QR Pair feature will appear (click the QR icon on a device card)

### Disconnecting

Click **Disconnect** on the device card — for wireless devices, this also runs
`adb disconnect IP:PORT`.

---

## 11. Multi-Device Support

- Each connected device appears as a card in the left sidebar
- Click **▶ Mirror** on any device → opens a separate floating mirror window
- Multiple mirror windows can be open simultaneously
- Each window has independent quality, recording, and always-on-top settings

---

## 12. Settings

Access via the ⚙️ icon in the top-right corner.

| Setting | Default | Description |
|---|---|---|
| Default quality | 720p | Preset for new mirror windows |
| Always on top | Off | Mirror windows stay above other apps |
| Recordings directory | ~/Movies/ScreenMirror Pro | MP4 save location |
| Theme | Dark | Dark / Light toggle in titlebar |

Settings are persisted via `electron-store` in the OS app data directory:
- **macOS**: `~/Library/Application Support/screenmirror-pro/`
- **Windows**: `%APPDATA%\screenmirror-pro\`
- **Linux**: `~/.config/screenmirror-pro/`

---

## 13. Building for Distribution

### macOS (.dmg)

```bash
npm run build:mac
# Output: dist/ScreenMirror Pro-1.0.0-arm64.dmg (Apple Silicon)
#          dist/ScreenMirror Pro-1.0.0.dmg (Intel)
```

### Windows (.exe NSIS installer)

```bash
npm run build:win
# Output: dist/ScreenMirror Pro Setup 1.0.0.exe
```

### Linux (AppImage + .deb)

```bash
npm run build:linux
# Output: dist/ScreenMirror Pro-1.0.0.AppImage
#          dist/screenmirror-pro_1.0.0_amd64.deb
```

### All platforms at once

```bash
npm run build
```

> **Note**: macOS builds require Xcode Command Line Tools. Windows builds on CI
> require Wine if cross-compiling from macOS/Linux.

---

## 14. Troubleshooting

### "No devices connected" even with USB plugged in

```bash
# Check ADB sees the device
adb devices

# If "unauthorized":
# → On the device: tap "Allow" on the USB debugging popup
# → Or: adb kill-server && adb start-server
```

### Stream is blank / black screen

```bash
# Check scrcpy works standalone
scrcpy -s YOUR_DEVICE_SERIAL

# If scrcpy not installed, install it:
brew install scrcpy
```

### "Failed to start stream" error

- Ensure no other scrcpy instance is running on the same device
- Try changing quality preset (device may not support native resolution)
- Check `adb shell getprop ro.build.version.sdk` — scrcpy requires SDK 21+

### Recording file not found after stop

- The app pulls the file from the device via `adb pull` — give it a few seconds
- Check the recordings directory in Settings
- Ensure the device has free storage space

### App won't launch on macOS

```bash
# If "cannot be opened because the developer cannot be verified"
xattr -cr /Applications/ScreenMirror\ Pro.app
```

---

## 15. Security & Privacy

| Property | Detail |
|---|---|
| **Root required?** | ❌ No |
| **Special Android app?** | ❌ No — uses standard ADB |
| **Data sent to cloud?** | ❌ Never — fully local |
| **Analytics/telemetry?** | ❌ None |
| **Storage** | Settings only, in OS app-data directory |
| **Network** | Only local loopback (127.0.0.1) for WebSocket stream |
| **Permissions** | USB access, file system (recordings dir only) |

ADB must be enabled by the device owner through Developer Options. The app cannot
connect without the user physically accepting the USB debugging authorization on the device.

---

## 16. Project File Structure

```
screenmirror-pro/
│
├── package.json                # Dependencies & build config
├── README.md                   # Quick-start guide
├── DOCUMENTATION.md            # This file — full docs
├── PROMPT.txt                  # The AI prompt used to generate this app
│
└── src/
    ├── main.js                 # Electron main process
    │                           # → Creates windows, registers IPC, hotkeys, tray
    │
    ├── adb/
    │   └── manager.js          # ADB facade
    │                           # → Device polling, wireless connect, props, screenshot, QR
    │
    ├── stream/
    │   └── manager.js          # Streaming engine
    │                           # → Launches scrcpy, WS server, screencap fallback
    │
    ├── control/
    │   └── manager.js          # Input translation
    │                           # → Mouse events → adb shell input, keyboard mapping
    │
    ├── recording/
    │   └── manager.js          # Session recording
    │                           # → scrcpy --record, adb screenrecord fallback
    │
    └── ui/
        ├── preload.js          # Main window IPC bridge (contextBridge)
        ├── preload-mirror.js   # Mirror window IPC bridge
        ├── index.html          # Main window layout
        ├── styles.css          # Full design system (CSS variables, dark/light)
        ├── app.js              # Main window renderer logic
        ├── mirror.html         # Per-device mirror window
        └── mirror.js           # Mirror renderer (WS, canvas, input, record)
```

---

*ScreenMirror Pro — Built with ❤️ using Electron, Node.js, and the scrcpy protocol.*
