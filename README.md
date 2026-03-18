# ScreenMirror Pro

> **Low-latency Android screen mirroring & control desktop app**
> Real-time H.264 streaming · Mouse/keyboard control · Recording · Multi-device · USB + WiFi

![ScreenMirror Pro](assets/screenshot.png)

---

## Features

| Feature | Details |
|---|---|
| 📱 **Real-time Mirror** | H.264 via scrcpy · PNG screencap fallback |
| 🖱️ **Full Control** | Mouse click/drag/scroll · Keyboard · Gestures |
| ⏺️ **Recording** | MP4 via scrcpy or ADB screenrecord |
| 📷 **Screenshots** | One-click PNG capture |
| 📶 **USB + WiFi** | ADB over cable or wireless TCP/IP |
| 🖥️ **Multi-device** | One mirror window per device |
| 🌙 **Dark / Light theme** | Toggleable with ⌘⌥D |
| ⌨️ **Global hotkeys** | Toggle window, record, screenshot |

---

## Prerequisites

| Tool | Install |
|---|---|
| **Node.js 18+** | https://nodejs.org |
| **ADB** | `brew install android-platform-tools` (Mac) |
| **scrcpy** *(recommended)* | `brew install scrcpy` (Mac) |

### Enable USB Debugging on Android

1. Go to **Settings → About phone**
2. Tap **Build number** 7 times → "You are now a developer"
3. Go to **Settings → Developer options**
4. Enable **USB debugging**
5. Connect via USB → tap **Allow** on "Allow USB debugging?" prompt

---

## Setup

```bash
# Clone / unzip the project
cd "Phone screen mirroring app"

# Install dependencies
npm install

# Start in development mode
npm run dev
```

---

## Wireless Connection

```bash
# 1. Connect device via USB first, then run:
adb tcpip 5555

# 2. Find device IP (Settings → WiFi → device name → IP address)
# 3. Use "Add Wireless" in the app and enter the IP
```

---

## Project Structure

```
screenmirror-pro/
├── src/
│   ├── main.js              # Electron main process
│   ├── adb/
│   │   └── manager.js       # ADB device discovery & control
│   ├── stream/
│   │   └── manager.js       # scrcpy / screencap streaming
│   ├── control/
│   │   └── manager.js       # Touch / keyboard ADB input
│   ├── recording/
│   │   └── manager.js       # MP4 recording manager
│   └── ui/
│       ├── index.html       # Main window
│       ├── mirror.html      # Per-device mirror window
│       ├── styles.css       # Design system (dark/light)
│       ├── app.js           # Main window renderer
│       ├── mirror.js        # Mirror window renderer
│       ├── preload.js       # Main window IPC bridge
│       └── preload-mirror.js# Mirror window IPC bridge
├── assets/                  # Icons, images
├── package.json
└── README.md
```

---

## Global Hotkeys

| Hotkey | Action |
|---|---|
| `⌘⌥D` | Toggle main window |
| `⌘⌥R` | Toggle recording (focused mirror) |
| `⌘⌥S` | Screenshot (focused mirror) |
| `F1` | Android Home button |
| `F2` | Android Back button |
| `F3` | Android Recents |

---

## Build

```bash
# Mac DMG
npm run build:mac

# Windows installer
npm run build:win

# Linux AppImage + deb
npm run build:linux

# All platforms
npm run build
```

Outputs land in `dist/`.

---

## Architecture

```
Main Process (Node.js)
├── ADBManager    — polls `adb devices`, wraps all ADB commands
├── StreamManager — launches scrcpy → pipes H264 to local WS server  
├── ControlManager— translates UI events to `adb shell input` commands
└── RecordingManager— launches scrcpy --record or adb screenrecord

Renderer (Browser)
├── Main window — device list sidebar, wireless modal, settings
└── Mirror window — WebSocket client, canvas rendering, input capture
```

---

## Legal

- No root access required
- Uses standard Android USB Debugging feature only
- All data stays local — no cloud, no analytics
- Users must agree to enable Developer Options themselves

---

## License

MIT © 2026 ScreenMirror Pro
