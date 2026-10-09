# Browser checks

These drive a real browser against a running DemonX and check what a person would see: layout
dragging and resizing, presets and undo, the Home pulse, the camera panel (against a fake
Home Assistant and a fake Reolink NVR), and that no secret ever reaches a browser.

```bash
npm run build
SIM_SPEED=30 DEMONX_DATA=/tmp/demonx-e2e PORT=8080 npm start     # simulator, throwaway data folder

node e2e/layout.mjs        # drag, resize, collapse, hide, presets, lock, reset, touch, phone width
node e2e/layout-undo.mjs   # presets never lose your layout: Undo and My layout
node e2e/home-pulse.mjs    # Home button pulses after connecting, stops everywhere when pressed
node e2e/position-wide.mjs                         # Position panel with 4-digit coordinates (restart the server first)
node e2e/pcb.mjs                                   # PCB mode (fresh DEMONX_DATA)
node e2e/controller.mjs                            # Settings > Controller: start the server with SIM_FIRMWARE=fluidnc; for GRBL start it normally and add the argument: grbl
node e2e/settings.mjs                              # Settings drawer (fresh DEMONX_DATA)
node e2e/spindle.mjs                               # Spindle panel (fresh DEMONX_DATA)
node e2e/macros.mjs                                # Macros panel (fresh DEMONX_DATA)
node e2e/viz-warning.mjs                           # the 'tool is outside this view' warning does not make the 3D view flicker (restart the server first)
node e2e/frame.mjs                                 # Frame button (restart the server first)
node e2e/units.mjs                                 # mm / inch toggle (restart the server first: it leaves the simulator moved)
DEMONX_DATA=/tmp/demonx-e2e node e2e/camera.mjs   # needs a FRESH data folder (starts with no camera set up)
```

Each script prints PASS or FAIL per check. They need Playwright and a Chromium: set
`PLAYWRIGHT_PATH` / `CHROMIUM` if they are not found. The camera script opens ports 8123 and 8124
for its fake servers. Restart the server with a fresh `DEMONX_DATA` before re-running it.

Screenshots are saved to `$TMPDIR/demonx-e2e-shots` (set `E2E_SHOTS` to choose another folder), never the working directory.

The unit and integration tests (`npm test`) need no browser.
