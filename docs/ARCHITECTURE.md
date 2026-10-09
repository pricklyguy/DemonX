# DemonX: how it is built, and what must not break

For anyone changing the code. (Users: see the README and the install guides.)

**DemonX** is a browser-based CNC controller by Prickly Guy Creations (PGC). One server owns the machine connection; any browser
on the network (the machine's own computer, an office PC, a phone) shows and controls the same machine. It works with **GRBL**
and **FluidNC** controllers.

Rule of thumb: **the server decides, the browser displays.** Safety rules live on the server so a stale tab or a remote viewer cannot
get around them.

## Layout of the code
```
shared/        types and pure logic used by both sides
  protocol.ts       every message between browser and server, config types
  layout.ts         panels, presets, grid rules (pure, tested)
  toolpath.ts       program analysis (extents, segments)
  colors.ts         colour maths and the CSS variables for a custom look
  machine-settings.ts  what controller settings may be changed, with limits
server/src/    Node + TypeScript (run with tsx)
  controller.ts     the one connection to the machine: GRBL streaming (character counting), jobs, locks,
                    jog/goto/frame/spindle/PCB Home/macro runner, runCommand (capture a reply)
  probe.ts          probe cycles with the two confirmations; autolevel scan
  gcode.ts          the strict autolevel rewriter (refuses what it cannot level correctly)
  heightmap.ts      height map store
  auth.ts           who may control the machine: PIN, setup code, sessions, where a connection comes from
  set-pin.ts        "npm run set-pin": set the PIN from a terminal
  camera.ts         camera hub: one upstream shared by all viewers (HA stills, Reolink, MJPEG, RTSP via ffmpeg)
  hastream.ts       Home Assistant's own HLS video, proxied; the browser plays it with hls.js
  hashare.ts        events pushed to Home Assistant (job finished, alarm, ...)
  mqtt.ts           the machine as a Home Assistant device through MQTT discovery (sensors and six safe buttons)
  config.ts         saved setup (HA token, MQTT, camera, spindle, PCB) with secret handling
  macros.ts         macro store and compiler (G38 refused, %wait, [xmin]..[zmax])
  machinesettings.ts  read/change/save the controller's own settings (GRBL $N, FluidNC config.yaml)
  simulator.ts, sim-config.ts, sim-fluidnc-config.ts   fake GRBL / FluidNC machine for development and tests
  index.ts          HTTP + WebSocket server
web/src/       React + Vite UI
  App.tsx (most panels), Dock.tsx (layout), viewer.ts (3D), Settings.tsx (the drawer), Access.tsx (PIN, phone button, QR),
  CameraPanel, SpindlePanel, MacrosPanel, PcbPanel, ControllerSettings, units.tsx/unitsCore.ts, appearance.ts, probeForms.ts
e2e/           browser checks (see e2e/README.md)
scripts/       update.sh, install-pi.sh, browser autostart, build-windows.mjs (the Windows package) and windows/ (its start files)
docs/          this file, the install guides, release notes (releases/<tag>.md), a Home Assistant dashboard example
```

Where settings live: **per browser** (localStorage): layout, theme, colours, units, jog steps and feeds, probe and autolevel form
values, camera auto-start, spindle RPM choice. **Per machine** (the server's `data/` folder, shared by every browser): camera, Home
Assistant, MQTT, spindle buttons and speeds, PCB mode, macros, height map, the PIN.

## Behaviour that must not regress
- **Probing:** every probe asks "is the probe connected?" (live probe-input readout) before any motion and "remove the probe" after,
  including failed and cancelled runs. While a probe is active the controller is locked against client commands (hold, reset,
  jog-stop and overrides still work). Stale confirmations are ignored. Starting with the probe input already triggered is refused.
  **Macros refuse G38** so they cannot bypass this.
- **Autolevel:** heights relative to work Z0; a missed point aborts the scan; programs using G91, G20, R-arcs, G92/G10/G28/G30,
  non-XY planes, or a cutting move in G53 are refused with the line number (a rapid G53 move is passed through unlevelled); an
  already-levelled file cannot be levelled again; the saved map is not auto-loaded (opt in with `DEMONX_AUTOLOAD_MAP=1`).
- **Jog:** Z jog capped at 20 mm on the server. Go to XY0 refused while below Z0. **Frame** and **PCB Home** refuse unless Idle, no
  job, and (Frame) tool at or above Z0.
- **PCB mode:** while on, Home and `$H` are refused (button disabled, server refuses); PCB Home needs the machine homed since
  connecting, only ever raises Z to the safe height, uses `G53` for the fixture, then `G10 L20 P1 X0 Y0`.
- **Access:** three states (`auth.ts`): *setup* (no PIN yet: every browser can only watch, except the one on the DemonX computer),
  *pin* (only signed-in browsers control), *open* (a deliberate "run without a PIN": browsers on the home network control). A browser
  from outside the home network (a public address, a VPN such as Tailscale, or behind a proxy or tunnel) can only watch unless it is
  signed in. The server checks the role on **every** message, not once per connection. The first PIN needs the DemonX computer's own
  browser or the one-time setup code. Wrong PINs and wrong codes lock the address out with a growing wait. The home computer
  never needs the PIN (`DEMONX_TRUST_LOCAL=0` turns that off). Forwarding headers (`X-Forwarded-For`, ...) mean "not local".
- **Home Assistant:** only six commands may come back from the broker (Home, Unlock, Reset, Feed Hold, Resume, Stop) and they go
  through the normal controller checks. Nothing can jog, probe, start a job or change a setting from there.
- **Secrets** (HA token, MQTT and camera passwords, the PIN hash) never go to a browser; the browser only learns that one is saved.
- **Home reminder:** the Home button pulses after connect until Home or Unlock is sent from anywhere.
- **Spindle:** the server accepts only enabled commands, speed 1..maxRpm, no start in Alarm; M5 is always available.
- **Controller settings:** only when Idle or Alarm with no job; the controller is locked meanwhile; wiring (pins, drivers, `board`,
  stepping engine, uart/spi/i2so/sdcard) is read-only; FluidNC saves via write-new-file, read back, compare, swap, keep the old file
  (on the controller and in `data/fluidnc-backups/`).
- Every number box lets go of focus when the wheel turns (the wheel scrolls, never edits).
- Internally and in saved data everything is **millimetres**; inches exist only for display and typed input.

## Working on it
```bash
npm install
npm run typecheck && npm test            # fast checks, no browser, no hardware
npm run build && npm start               # http://localhost:8080 ; type "simulator" as the port
SIM_FIRMWARE=fluidnc npm start           # a simulated FluidNC, for the Controller settings
npm run package:windows                  # the Windows zip (in PowerShell use npm.cmd)
```
Browser checks: `e2e/README.md` (needs Playwright with Chromium; `PLAYWRIGHT_PATH` and `CHROMIUM` if not found). Start a **fresh**
server (`DEMONX_DATA=<new folder> SIM_SPEED=30 PORT=8080 npm start`), wait for it to be ready (about 7 seconds), run one script,
stop the server. A script that passed can fail if the server was not ready yet.

- The simulator models GRBL well enough for streaming, probing, jogging, autolevel, G53, spindle and coolant status and FluidNC
  config commands, but it cannot show GRBL-versus-FluidNC differences. **First runs on real hardware should be slow and
  supervised**, and anything written from documentation rather than a real controller should be said to be untested.
- Bug fixes: reproduce with a test first, then fix. Commit messages explain the reason, not just the change.
- A **release:** bump the version in the three `package.json` files, add `docs/releases/<tag>.md`, merge to `main`, then publish a
  GitHub release with the tag (`v<version>`). The "Windows package" workflow builds the zip and attaches it; it refuses a tag that
  does not match the version.
