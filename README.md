# DemonX CNC Controller

Browser-based CNC controller by Prickly Guy Creations. One server owns the machine connection; any device on the network opens the UI to monitor or control the same job. Targets GRBL (including FluidNC in GRBL mode).

> **Test release.** DemonX 2 is ready for volunteers to try; see [`docs/releases/`](docs/releases/) for what has and has not been tested on real machines. The original single-file prototype lives in [`v1-archive/`](v1-archive/).

## Install

- **Windows:** download the zip (a release, or the "Windows package" Action), extract it, double-click `Start DemonX.bat`. Guide: [`docs/WINDOWS.md`](docs/WINDOWS.md).
- **Raspberry Pi:** [`docs/RASPBERRY-PI.md`](docs/RASPBERRY-PI.md).
- **Linux or macOS:** `npm install && npm run build && npm start`, then open http://localhost:8080.

## What it does

- Serial connection owned by the server, shared by all browser clients
- GRBL character-counting streaming, so large files stream at full speed
- Live DRO (work and machine position), jog, zero, home, unlock
- Job: load, start, pause, resume, stop (feed hold, then reset so the spindle stops)
- Feed / rapid / spindle overrides, console, dark and light themes
- Built-in **simulator** so the whole stack runs without hardware

### Probing
- Z probe, PCB Z probe (direct contact) and 3-axis XYZ block probe, two-pass (fast then fine), ported from V1
- **"Is the probe connected?"** confirmation before anything moves, with a live probe-input indicator (touch the bit to the plate to test it)
- **"Remove the probe"** confirmation after every probe, including failed and cancelled ones
- Enforced on the server: while a probe is active nothing can jog, home, send commands or start a job, from any client
- Refuses to start if the probe input is already triggered; stale or double confirmations are ignored

### Autolevel (PCB milling)
Scan, then **write a new levelled G-code file**, then run that. The levelling is done on the server, so what runs is exactly what you can inspect and download.
- Grid scan (2 to 30 points each way) with a **Use loaded G-code area** button; same connect/remove confirmations as every probe
- Heights are measured in work coordinates (0 = your Z0), so set Z0 on the board surface first (PCB Z probe)
- Any missed point aborts the scan; nothing is ever recorded as "flat"
- Height map is saved on the server (survives restarts), and can be downloaded/loaded as JSON per board or fixture
- Apply: every move gets the surface height added; long moves and arcs are split into short segments so the correction follows the surface (bilinear interpolation)
- Programs that cannot be levelled correctly (relative mode G91, inches, R-format arcs, G92/G10/G28/G30/G53, non-XY planes) are **refused with the line number** instead of run partly levelled
- Warnings for points outside the scanned area and for a work zero that moved since the scan; a badge shows whether the loaded program is levelled
- Download the levelled program from the panel; **Use original** puts the file back
- A levelled file carries a header comment (`(DemonX autolevel v1: ...)`). Load it again later, even renamed, and DemonX knows it is already levelled: it shows a green badge, and **refuses to level it a second time** (that would apply the Z correction twice). Older exports are recognised by `.leveled.` in the file name
- The last scan is kept on the server but is **not loaded at startup**: use **Restore last scan** if it is the same board in the same position. A PCB-only machine can opt in to loading it automatically with `DEMONX_AUTOLOAD_MAP=1` (see `ecosystem.config.cjs`)
- The "height map exists but is NOT applied" warning only appears when the program fits inside the scanned area, so wood jobs never see it

### Visualizer and job info
- 3D toolpath view (Three.js): cutting moves, rapids, the work origin axes, a size box, the live tool position, and the autolevel height map
- **X to the right and Y up the screen** in every top/front view. The default is straight on, tilted 32 degrees down, not a 45 degree turntable view. Presets: Front (default), Top, Side, End, Iso, and Fit all (program plus tool). Left-drag rotates, wheel zooms, middle-drag or right-drag pans, as in VCarve and Fusion
- The tool marker keeps a constant size on screen; if the tool is outside the current view a hint says so. Toggles show "(none)" when there is nothing to show (no program, no height map, not connected)
- Done vs still-to-cut colouring follows the running job
- **Z stretch** (1 to 100x) makes a 0.3 mm surface variation visible on a 50 mm board
- The Job panel shows min / max / size of X, Y and Z for the program that will run (cutting moves, with rapids on a second line), so an odd Z is obvious at a glance; for a levelled program these are the corrected values

### Layout
- Panels sit on a snapping 12-column grid: **drag by the title bar, resize from the corner**. Panels never overlap or get cut off (a panel made smaller than its content scrolls inside itself) and the grid closes gaps upward
- **Layout menu** (header): presets **All panels**, **Run** (big visualizer, position and job) and **Setup** (jog, probe, autolevel); **Panels** checkboxes to hide or show each panel (a wood job can hide Probe and Autolevel); **Lock layout** to stop accidental drags on a touchscreen; **Reset layout**
- **Getting your layout back:** clicking a preset never destroys a layout you arranged. **Undo last preset** (in the Layout menu) returns to exactly what you had, and **Save as My layout** keeps an arrangement as a permanent entry that presets never touch (tweaks you make later are not saved over it until you save again)
- The arrow collapses a panel to its title bar and back (so does a double-click or double-tap on the title)
- Saved **per browser**: the Mini PC and a phone each keep their own layout. A damaged saved layout falls back to the default
- On a narrow screen (a phone) the panels stack in one column in reading order; presets and the Panels menu still apply
- Touchscreens: the title bar is the only drag handle, the resize corner is large, and the page cannot be swiped away or pulled to refresh mid-job

### Camera
A **Camera** panel with a **Start camera** button (so a remote viewer can start it on demand). The DemonX computer fetches the video once and shares it with every viewer; it only pulls video while someone is watching and stops a few seconds after the last viewer leaves. Camera logins and the Home Assistant token stay on the server in `data/config.json` (readable only by its owner) and are never sent to a browser.

Camera types (**Setup** in the panel, with a **Test** button that shows a picture before you save):
- **Home Assistant camera**: enter the Home Assistant address and a long-lived access token, press *Load list* and pick any camera entity. The camera needs no login of its own
- **Reolink camera or NVR**: address, channel (as numbered in the Reolink app, from 1), user and password. Snapshots work everywhere; *Smooth video* uses RTSP and needs ffmpeg
- **Web camera address**: an MJPEG stream or a picture that refreshes (basic login optional)
- **RTSP stream**: needs `ffmpeg` on the DemonX computer
- **Direct**: the viewer's own browser opens the camera address (no server involved)

### Also built
- **PCB mode** (fixture position, safe height, PCB Home, a checklist), **macros** (they cannot bypass the probe safety), a **spindle panel**, **controller settings** (GRBL `$` settings and FluidNC `config.yaml`, with backups)
- **Access PIN**, on by default: a fresh install lets every device only *watch* until a PIN is set (on the DemonX computer, with a setup code from another device, or `npm run set-pin`). The DemonX computer itself never needs it; anything outside your home network, including VPNs such as Tailscale, needs the PIN
- **Home Assistant** through MQTT (the machine as a device, with Home, Unlock, Reset, Feed Hold, Resume and Stop buttons) and events for automations; see [`docs/ha-dashboard.yaml`](docs/ha-dashboard.yaml)
- **Windows package**, Raspberry Pi installer, millimetres or inches, colour options

Not built yet: a Tool Change panel, hold-to-jog, HTTPS, user accounts.

## Run it

```bash
npm install
npm run build        # builds the UI into web/dist
npm start            # http://<server-ip>:8080
```

Open the page, type `simulator` in the port box to try it with no machine, or pick the real serial port on the server.

Development with hot reload: `npm run dev:server` and `npm run dev:web` (UI on :5173).
Tests: `npm test` (parser, streamer, pause/resume/stop against the simulator).

## Run at boot with PM2 (the mini PC)

One-time setup, after `npm install && npm run build`:

```bash
pm2 start ecosystem.config.cjs
pm2 save
```

PM2's boot service (`pm2 startup`, only needed once per machine) then starts DemonX every time the PC powers on. After a reboot there is nothing to type: open `http://localhost:8080`.

| Task | Command |
|------|---------|
| Is it running? | `pm2 status` |
| See what it is doing / errors | `pm2 logs demonx` |
| Restart | `pm2 restart demonx` |
| Update to the latest code | `./scripts/update.sh` |
| Stop it from starting at boot | `pm2 delete demonx && pm2 save` |

To also open the controller in a browser window at every login (a dedicated CNC PC):

```bash
./scripts/install-browser-autostart.sh           # install
./scripts/install-browser-autostart.sh --remove  # undo
```

It waits for the server to be ready, then opens Chrome/Chromium in a clean app window (or Firefox if that is all that is installed).

If `pm2 status` shows `errored`, a lot of restarts, or no memory use, run `pm2 logs demonx --lines 30 --nostream` to see why. A busy port 8080 is the usual cause.

The serial port needs the PM2 user in the `dialout` group: `sudo usermod -aG dialout $USER`, then log out and back in.

## Raspberry Pi

A step-by-step guide, with a one-command setup script, is in [docs/RASPBERRY-PI.md](docs/RASPBERRY-PI.md).

## Docker

```bash
docker build -t demonx .
docker run -p 8080:8080 -v demonx-data:/app/data --device=/dev/ttyUSB0 demonx
```

## Layout

- `server/` Node + TypeScript: GRBL controller, streamer, simulator, WebSocket hub
- `web/` React + Vite UI
- `shared/protocol.ts` message types shared by both
- `v1-archive/` original prototype

How it is built, and the safety behaviour that must not regress: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). What each release contains and what has been tested: [docs/releases/](docs/releases/).

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Contributors agree once to the [Contributor License Agreement](CLA.md): you keep your copyright, and DemonX's owner may also offer the code under other licences.

## License

DemonX is free software: you can redistribute it and modify it under the terms of the GNU General Public License,
version 3 or (at your option) any later version. See [`LICENSE`](LICENSE).

Copyright (C) 2026 Prickly Guy Creations (PGC). DemonX comes with no warranty. A CNC machine can hurt people and break
things: test with the machine's emergency stop in reach, and run new programs in the air first.

The Windows package also contains Node.js (MIT licence, included as `node/LICENSE-node.txt`) and the open-source packages
DemonX uses (MIT, ISC, BSD and Apache-2.0 licences, included with each package).
