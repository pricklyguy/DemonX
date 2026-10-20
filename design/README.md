# DemonX Design (2D proof)

A browser app for designing and running laser (and, later, CNC) jobs, next to the DemonX CNC controller. It is a 2D vector
editor (draw, combine, offset, organise by layer, text, DXF and SVG in and out) with three tabs, **Design**, **Laser** and **CNC**,
and a Laser tab that controls a laser through the Design server. It shares some code with DemonX CNC (the GRBL connection, the PIN,
settings files), so the top of the repo needs its `npm install` too. The Laser tab's controllers are a GRBL / FluidNC laser and a
Ruida CO2 laser (see Known limits for what has and has not been tried on a machine).

```bash
# once: DemonX's own dependencies (the laser server reuses its GRBL code) and this app's
cd <repo root> && npm install
cd design && npm install

# drawing only (no laser): the app on http://localhost:5174
npm run dev

# with laser control: build, then start the Design server, which also serves the app on http://localhost:8090
npm run build && npm run serve
#   (development: `npm run dev:server` in one terminal and `npm run dev` in another; the app reaches the server through its own address)
#   DESIGN_SIM_SPEED=40 makes the simulated laser run 40 times faster, for trying things out

npm test             # geometry, DXF, commands, laser G-code, the laser servers and the Ruida driver against its simulator
npm run typecheck
node e2e/design.mjs  # real-browser check with screenshots (needs the build and `npm run serve`, see the header of the file)
```

## What works

- **Draw:** rectangle, circle, polygon / line. Grid snap, pan, zoom, box select, move, delete, undo and redo (Ctrl+Z, Ctrl+Y).
- **Edit a shape:** pick it and the bar along the top shows its X, Y, width, height (and radius for a circle). Type new numbers, or drag the
  square handles on the box around it. The nine-dot picker chooses which point of the selection X and Y refer to (and which
  point stays still when you resize). Rotate by any angle or 90°, and flip. Circles keep their proportions, so they stay circles.
- **Tools:** right-click while a drawing tool is active to finish and go back to Select (the same habit as LightBurn).
- **Snap to points:** while drawing or dragging, the cursor jumps to the ends and corners (square marker), centres (circle),
  middles of sides (triangle) and crossings (X) of existing shapes, and names what it found in the status bar. Start a line exactly on
  a corner, centre a circle on a rectangle. Dragging a shape holds it by its own corner or centre when you grab it there, so that exact
  point lands on the target (align by centres, or corner to corner). The **centre of the selection** is marked with a cyan ⊕ and is
  snappable. The **Grid** and **Points** boxes switch the two kinds of snap. (A selected shape's corners are its resize handles: to
  move by a corner, grab it while the shape is not selected; to move by its centre, grab the ⊕ any time.)
- **Trim (scissors, T):** hover a line or outline and the piece between the two nearest crossings turns red (crossings are amber dots). Click to cut it away. A closed outline needs two crossings, an open line one; otherwise it says why and changes nothing. Undo restores it.
- **Align and distribute:** the Align card on the tool bar line the selected shapes up on their left, right, top or bottom edge or centre (two or more shapes align to each other; one shape, or *to work area* ticked, aligns to the work area). With three or more selected, the two ⇹ / ⥯ buttons space them evenly across or down, keeping the outer two where they are. Commands: `align`, `distribute`.
- **Copy, paste, duplicate, array:** Ctrl+C / Ctrl+X / Ctrl+V and Ctrl+D (or the tool bar or the right-click menu). The clipboard is shared between the tabs of one browser (copy in one tab, paste in another, into a different design); it does not reach other programs or other computers, and a very large selection that the browser cannot store pastes in its own tab only. Each paste lands 5 mm further along so copies never hide each other. *Array…* repeats the selection in a **grid** (columns × rows, spacing from one copy to the next) or **circular** (count including the original, total angle, centre, optionally turning the copies); at most 5000 shapes at a time. Commands: `duplicate`, `paste`, `array`; console words `dup`, `grid cols rows dx dy`, `circular count [angle]`.
- **Gadgets (from the VCarve gadget set):** the *Gadgets* menu in the header carries over the home-made `PGC_*` gadgets as built-in commands, not as Lua scripts. *Rotate each* turns every shape about its own centre. *Sharpie Path Offset* copies the selection to a Sharpie Path layer shifted by minus the pen offset; where the pen sits (default X 0, Y -58) is remembered between uses. *Set template* + *Replace with template* put a copy of the template (held by its first circle) on every selected shape, on that shape's layer, optionally keeping the template and backing up the originals on a hidden layer. *Nudge to guide* moves each shape's centre onto the nearest point of the guide (click the guide last), optionally spacing them evenly. *Count matching* selects every shape that is the same as the one clicked last, however it is moved, turned or started, and reports ones lying exactly on top of each other (matching is by size and outline within a small tolerance, not exact). *Auto number* stamps 1, 2, 3 … in click order using seven-segment digits (one shape per number), with an optional wiring path and marker circles, and carries on from where the last run ended. "Undo Last PGC Change" is not needed: Ctrl+Z undoes any of these. Commands: `rotate_each`, `marker_copy`, `replace_with`, `nudge_to_guide`, `count_matching`, `auto_number`.
- **Text (A):** click where the text should start (its baseline), type it (several lines are fine), pick a font, height, letter and line spacing and alignment, and watch the preview. It becomes ordinary closed outlines, one shape per letter with holes kept (tick *Join the letters* to weld them into one shape, useful for script fonts whose letters overlap). Six fonts come with the app; *Font file…* loads any `.ttf`, `.otf` or `.woff` from your computer for the session (not `.woff2`). Limits: the text is not editable afterwards (undo and retype), only the Latin set of the bundled fonts is included, ligatures and complex scripts are not shaped, and there is no single-line (stroke) font yet, so engraving text on a laser fills the letters. Command: `add_text` (scripts call `demonxDesign.loadFont(name)` first).
- **Nodes (N):** click a line or outline to show its points (the first is ringed). Drag a point to move it (it snaps like everything else), Shift-click or drag a box to pick several, double-click a segment to add a point there, Delete removes the picked points. The Nodes panel adds *Add between* (a point in the middle of each segment between two picked neighbours), *Break here* (an outline becomes an open line starting at that point; a line is split in two), *Open / Close path* and *Turn into a path* for circles, which are exact shapes with no points until converted. Paths are straight segments only: there are no curve handles yet, so a curve is many short lines. Commands: `nodes_move`, `node_insert`, `nodes_delete`, `node_break`, `path_close`, `to_path`.
- **Corner radius:** the *Corners* card on the tool bar rounds every corner of the selected lines and outlines (*Apply*), in one of three styles: **Round (outside)**, the normal rounded corner; **Inside scoop**, a quarter-disc cut out of the corner around the corner point, the kind of inside corner a square part needs to sit in a round-cornered pocket; **Chamfer**, a straight cut. Tick *new rectangles* and every rectangle you draw comes out with that radius and style. With the Nodes tool, *Corners of picked points* does only the picked corners. The radius is limited to half the shorter side so neighbouring corners never collide, and the console says when it was limited. A rounded rectangle is a plain path afterwards, so change the radius by undoing and applying again. The inside scoop is exact on right-angle corners; on other angles it is still an arc about the corner point, not tangent to the sides. Commands: `fillet`, and `add_rect` takes `radius` and `style`.
- **Combine:** union, subtract (the shape you picked first minus the others), intersect. Holes are kept as holes.
- **Offset:** grow or shrink by a distance in mm, with round, sharp or square corners. An open line becomes a closed outline
  around it (for example a kerf or a slot).
- **Layers:** colour, show/hide, and per-layer mode (cut, engrave, score, ignore), speed, power and passes. **Order, names, delete:** layers burn from the top of the list down (put engraving ahead of cutting with ▲ ▼); rename with ✎ or by double-clicking the name; delete asks whether the shapes move to another layer or go too (undo brings it back). The same tools are in the header's layer list and in the Laser panel. Commands `layer_move`, `layer_rename`, `layer_delete`. The settings are kept
  in the SVG export; they are not sent to a laser yet.
- **DXF in:** LINE, ARC, CIRCLE, ELLIPSE, SPLINE, LWPOLYLINE and POLYLINE (bulges become arcs) and blocks (INSERT). Loose lines that meet end to end
  are joined into closed shapes, which is what Vectric and CAD exports usually need. The file is read in a worker, so a big one does not
  freeze the page. TEXT and MTEXT are not imported (they need the font: turn them into outlines in the program that made the file, or
  retype them here); hatches and anything else unknown are skipped, and the console says how many.
- **DXF / SVG out:** DXF is R12 ASCII, the oldest flavour, which VCarve, LightBurn and Fusion all read. SVG is in millimetres.
- **File menu and project files:** *File* has New, Open (Ctrl+O), Open the example part, Save (Ctrl+S), Save as (Ctrl+Shift+S),
  Import DXF, Export DXF, Export SVG and Save laser G-code. A design is saved as a `.dxd` file (JSON) that keeps the shapes, the layers
  with their laser settings, the machine and the job size, so it reopens exactly as it was; the laser job made from a reopened design
  is identical. In Chrome and Edge Save writes back to the same file; other browsers download it, and Open uses a file chooser. The
  header shows the design's name, with a dot when there are unsaved changes (also in the tab title); New and Open ask first, and closing
  the tab warns. Opening is strict: a damaged, wrong or newer file is refused with the reason and nothing in the drawing changes. The
  commands `open_project` and `export_project` do the same for scripts.
- **Start point and the green square:** in the Laser panel a small green square on the drawing shows where the job starts (the head, or work zero). It is measured from **every shape in the design**, whatever a layer's Output switch says, so switching a layer off for one run does not move it and a design cut in several runs still lines up. Shapes on layers with Output off are drawn faint.
- **The page and rulers:** the work area is drawn as the page: the grid is only on the page and outside it is plain, with rulers (in mm) along all four edges. You can still design outside the page; those shapes are flagged. Fit (and opening a file or choosing a job size) fits the page, leaving room for an open tool panel.
- **Job size first:** the New design dialog opens at launch (and from **New**). Pick **Laser** (a machine from the list, or your own
  size, which you can save by name), **CNC** (material width, height, thickness, Z zero, and the XY datum point, like VCarve's Job
  Setup) or **Design only** (no limit). The work area is drawn as the page with its size on it, the view fits it, and a shape that
  sticks out is flagged in the status bar. The header button (for example "Laser 300 × 180 mm") reopens it as **Job setup** and keeps
  your shapes. Last settings are remembered, and New can be undone with Ctrl+Z. Sizes are millimetres only for now.
- **Layout:** the tool bar on the left (small icons, two across) holds the drawing and editing tools, then Union / Subtract / Intersect, Group / Ungroup, Copy / Paste / Cut / Duplicate / Delete, and Array, Offset, Corners and Align (the last three open a small card beside the bar). The right-hand side is empty in the design view, so the drawing area extends across it. The active layer is in the header: click it for the list of layers (show/hide, colour, pick, or make a new one). The command line is behind the chevron at the left of the status bar, and the Nodes panel floats over the drawing while that tool is active. Click the file name in the header to name the design and save it. The Grid box turns the grid lines and grid snapping on and off; Points turns the jump-to-corners snapping on and off. A new design has one layer, *Layer 1*. **Design | Laser | CNC** are three tabs under the header: Design has the drawing tools; Laser and CNC show their own panel in a side column next to the drawing (the drawing tools are hidden there and the tool is Select). The **Settings** menu holds Laser setup (add, remove and edit lasers, Ruida included) and Appearance. A new file always opens in the design view; the New dialog (**Start from**) takes a stored laser or CNC setup, a typed size, or no limit. Pan is the middle mouse button (or Space, or H); the wheel zooms.
- **Right-click menu** (Select and Nodes tools): Undo, Redo, Cut, Copy, Paste, Duplicate, Delete, Selection (all, all open vectors, none, invert, everything on this layer), Activate layer of selection, Group / Ungroup, Join / Close vectors (with a line, with a smooth curve, move end points), Node edit mode, Array, and **Copy to layer / Move to layer** (including a new layer). Drawing tools still end with a right-click.
- **Group and join:** Ctrl+G / Ctrl+Shift+G group and ungroup (picking one shape picks its whole group; copies get groups of their own; groups are saved in the project file). *Join* joins open lines into one: with a line, with a smooth curve that follows both lines, or by moving the two ends together; with several lines the nearest ends are joined first, and with a single line its own ends are joined (closed). Commands `group`, `ungroup`, `join`, `copy_to_layer`.
- **Appearance:** File → Appearance… has the same light/dark and colour choices as DemonX (accent presets and each colour), plus a colour of its own for the drawing area (the grid), kept per browser and separate from the controller's. Switching dark or light repaints the drawing at once.
  (below). **CNC** is a placeholder for toolpaths, post processors and Send to DemonX CNC. It is one drawing and one set of layers
  in all three.
- **Laser job (GRBL):** each layer has Mode (Cut, Engrave, Score), speed, power, passes, and the switches **Out** (burn this
  layer), **Show** (visible on screen; a hidden layer still burns if Out is on) and **Air** (M8/M9 around the layer). Engrave
  layers also have an interval and an overscan. The panel shows the burn path over the drawing, the burn length and an estimate
  of the time, warns about a job bigger than the machine, 0% power and overscan reaching outside the job, and saves a `.gcode`
  file. Holes are cut before the outside. **Start from** is LightBurn's choice: *User origin* (work zero is a point of the job that you put the head on) or *Absolute coordinates* (the drawing's 0,0 is the machine's 0,0, so where you placed the shapes is where they burn, with a warning if the job is outside the work area). Work zero can be any of nine points of the job, or only the selected shapes can burn.
  Power is scaled to the controller's S max ($30). It uses `M4` (needs GRBL laser mode, `$32=1`), so nothing fires on rapid moves.
- **Laser control (GRBL):** the Laser tab's *Laser control* panel connects to the laser through the Design server, shows its state
  and position, jogs (XY only), sets work zero, homes, unlocks and resets, **sends** the job, **frames** it (outline traced with the
  laser off), **starts** it after a confirmation (eye protection, material, watching), pauses (feed hold), resumes and **stops**
  (hold, then reset, so the laser goes off). It reuses DemonX's GRBL streaming. A simulated laser is always offered as a port.
  The server, not the browser, decides: it only opens ports the computer reports; it accepts only laser G-code (G0, G1, G21, G90, M2,
  M4, M5, M8, M9 with X, Y, F, S: no M3, arcs, homing, offsets or `$` commands, power only with M4, the job must end with the laser
  off, and S may not exceed the controller's `$30`); it reads `$32` and **will not start a job unless laser mode is on** (it can turn
  it on with your click; if the controller cannot report it you must confirm it yourself); it refuses to start a job that is not the
  one on screen; and while a job runs it refuses jogging, homing, loading and disconnecting. It answers only this computer: another
  machine, a proxy, a web page from another site (Origin) and a name pointed at this computer later (Host) are all refused.
- **Laser tab layout:** two boxes with their pages as tabs down the right edge. *Cuts / Layers* holds **Layers**, **Job** and **Positions**; *Laser* holds **Laser** (control), **Monitor**, **Library** and **Camera**. The Laser page has big **Stop**, **Start…**, **Frame** and circle **Frame** buttons (Pause and Resume where the controller allows it, Send for GRBL), a *Start from* box, the nine-dot **Job origin**, and a **Rotary** switch. For Ruida, *Current position* runs jobs (the job starts where the head is); *Absolute coordinates* and *User origin* frame only, for now. A red cross marks where the head is on the grid.
- **Positions (the Move window):** the arrow buttons with their step and speed, **Move to** typed X and Y (with *Get position*), and saved positions you can add, rename, change, sort and delete (for example X 25, Y 25 as the place to put work). They are kept per laser on the server, so every computer sees them. Every move is a rapid with the laser off, at most 100 mm/s, only inside the work area, refused while a job runs, operator only, and the Go button asks to be pressed twice. Ruida only for now.
- **Circular frame (Ruida):** traces a circle through the four corners of the job with the laser off and returns to the start; it is checked against the work area like the box frame and refused when the circle would leave it.
- **Rotary (Settings, Rotary setup):** chuck or roller, steps per rotation, object (and roller) diameter, circumference, kept per laser on the server. **The setup is stored but jobs are not sent while Rotary is on**: how the controller wants a rotary job is not known until one is captured from LightBurn.
- **Job monitor:** a card over the drawing while a Ruida job runs (the path, the head and its short trail, progress, time, the camera); *✕ to tab* moves it into the **Monitor** tab, *Pop out* brings the card back. The preview and the monitor zoom with the mouse wheel (drag to move, double-click for the whole job).
- **Big drawings stay usable:** the job for the Laser tab is worked out in a worker, so editing never freezes the page; Frame, Start and Send wait while a newer job is being worked out. The shapes and the job's path are drawn once into a picture and reused.
- **For update scripts:** `GET /api/busy` returns `{ "busy": boolean, "reason": string }` (a laser job running or paused, or the head moving). It answers only this computer.
- **Command line:** every action is a command with JSON arguments (`help` lists them). The buttons, keys, console and
  `window.demonxDesign.run(id, args)` all go through the same function, which is the seam for scripts and AI/MCP tools later.

## CNC mode (first slice)

Open the **CNC** tab on the right. Set the material in Job setup (size, thickness, whether Z zero is the surface or the bed), select shapes, and add toolpaths:

- **Profile:** outside, inside or on the line, climb or conventional, an allowance left on the walls. Several shapes are cut smallest first, so holes go before the outline around them. Open lines can be cut on the line.
- **Pocket:** clears closed shapes with parallel passes inward by the tool's stepover; holes in a shape stay standing as islands. The corners stay rounded by the tool radius, as with any round tool.
- **Drill:** one hole at the middle of each shape, in pecks of the tool's stepdown.
- Every toolpath goes from a start depth to a cut depth in equal passes no deeper than the tool's stepdown, with a safe height for rapid moves; "Through the material" goes 0.3 mm into the spoilboard.
- **Tools:** a small library (flat, ball, V-bit, drill) with diameter, speeds, feeds and stepdown, saved in the project.
- **G-code:** one file per tool, written through a post processor. Two generic GRBL ones are built in (plain, and with vacuum on M7 / off with M9). *Load a .pp file…* reads your own post processor files (the common `POST_NAME`, `VAR` and `begin HEADER / FOOTER / RAPID_MOVE / FEED_MOVE` layout; millimetres only; arcs are not written because toolpaths are straight segments) and keeps them in this browser. The toolpaths are drawn over the drawing while the panel is open.
- Commands: `cnc_tool_set`, `cnc_tool_delete`, `cnc_toolpath_add`, `cnc_toolpath_update`, `cnc_toolpath_delete`, `cnc_post_set`, `cnc_gcode`.

**Not tried on a machine, and not there yet:** nothing here has cut anything (the G-code is checked by reading it back, not by running it). Missing: V-carve, tabs, ramped entry (it plunges), lead-in, arcs, a 3D or simulated preview, importing your Vectric tool database, and **Send to DemonX CNC**.

## Known limits

- **The GRBL / FluidNC laser path has not been run on a real laser yet** (the Ruida path has: see below). The G-code is tested by reading it back (every move, power only on feed moves,
  laser off at the end, extents agree with DemonX's own G-code analyzer). The connection is tested against DemonX's simulated
  GRBL controller, not against a serial port with a laser on it. The first runs should be on scrap at low power, with eye protection,
  watching, and a hand on Stop. FluidNC cannot be asked for laser mode, so you confirm it yourself. Hold-to-jog, a low-power
  "frame with the laser on", test fire and overrides are not built.
- One program at a time can use the laser's port: close DemonX CNC, LightBurn and other senders first.
- **Ruida (CO2 lasers with a Ruida controller) is off by default.** It needs `DESIGN_RUIDA=1` when starting the server; then the Laser panel's **＋ Add a Ruida laser…** takes a name and the laser's address (local network only; kept in `design/data/` on that computer). A simulated one is offered as well. `DESIGN_RUIDA_HOSTS=name=address` still works for setting it up without the panel. It was written from recordings of one machine (an OMTech Pronto 45, firmware RDLC-V1.54.08). **On that machine** the owner has run jobs (cut and engrave, with air), jogs, frames and Stop, and reports that it works. **Not tried on the machine yet:** Pause and Resume (off unless `DESIGN_RUIDA_PAUSE=1`; LightBurn's pause turns the beam off, but whether DemonX's does has to be watched with the power off first), the Positions / Move to X Y moves, the circular frame, multi-pass jobs, and a lost connection mid-job. **Home**, the **Z** moves (Z+ / Z−) and **Auto focus** are built from LightBurn captures but are off unless `DESIGN_RUIDA_HOME=1` / `DESIGN_RUIDA_Z=1`, and have not been run from here. *Start from* **Absolute coordinates** and **User origin** (a starred saved position) can **Frame** (the same moves as LightBurn's, from captures) but **cannot Start** yet: no job sent that way has been captured, so a job starts only from the current position, and **while Rotary is switched on Frame and Start are refused** until a rotary job has been captured. `DESIGN_RUIDA_MAX_POWER` caps the power the server will accept. Close LightBurn first. Code: `server/src/ruida/` (job writer and reader, simulated controller, session).
- Engrave is line fill only (no images or dithering), and circles become many short G1 lines, not G2/G3 arcs.
- Circles and arcs become many short straight segments when combined, offset or imported (at most 0.01 mm from the true curve).
  A combined shape therefore exports as polylines, not true arcs.
- No bitmap trace or image engraving. The layout is meant for a desktop screen. A design is saved as a `.dxd` file (File, Save); nothing is kept between visits otherwise, apart from settings in the browser.
- Geometry uses integer maths at 0.001 mm (Clipper), so anything finer than that is rounded.

## Layout

```
src/core/   the document model and everything that has no screen: types, geom, clip (booleans/offsets), dxf, svg, commands
src/ui/     React: Canvas.tsx (drawing and mouse), App.tsx (panels), useDesign.ts (history, selection, log), the Laser tab's panels, styles.css
server/     the Design server: laser sessions (GRBL and Ruida), access, the HTTP and WebSocket side
test/       vitest: core, server, the Ruida driver against its simulator
e2e/        Playwright checks against the built app (each file says how to run it)
```

## Licence and dependencies

GPL-3.0-or-later like the rest of DemonX. Runtime dependencies: `clipper-lib` (Boost licence), `dxf-parser` (MIT), `opentype.js` (MIT), React (MIT). The bundled fonts (Roboto, Roboto Mono, Oswald, Bebas Neue, Pacifico) come from the Fontsource packages and are under the SIL Open Font Licence 1.1.
- **Material library (Laser tab):** one library per laser, kept in `material-library.json` in the server's data folder (`DESIGN_DATA`, default `data/` beside the app). Materials hold named settings (mode, speed, minimum and maximum power, passes, interval, overscan, air), listed under a thickness for cut-outs or a heading such as *Engraving*. **Assign** copies a setting into the active layer (a saved design does not depend on the library); **New from layer**, **Update**, **Duplicate** and **Delete** manage entries, and the fields below the list edit one. **Import .clb…** reads a LightBurn library (only mode, speed, powers, passes, air, interval and overscan are taken). Not tried on the laser; settings are only as good as what you put in.
- **Fill mode (engrave layers):** *All shapes at once*, *Groups together* or *Shapes individually*, as in LightBurn, or *Fastest*, which tries them and also splits a fill through wide empty gaps (for example a border around a design, where every scan line would otherwise cross the empty middle), judged by the time estimate, and tells you what it did. The estimate is tuned to one Pronto 45 from two timed fills; the split has not been run on the machine.
- **USB (GRBL) lasers are opt-in:** the server only offers the serial ports named in `DESIGN_SERIAL_PORTS` (comma separated, for example `COM5` or `/dev/ttyUSB1`). With nothing set it offers none, so on a computer that also has a CNC on USB the CNC can never be picked as a laser. The simulators and named network (Ruida) lasers are not affected.
- **Using Design from another computer (a shop server):** run the Design server on the computer that is wired to the laser, with `DESIGN_HOST=0.0.0.0` so the home network can reach it (it prints the addresses). The computer that runs it always controls the laser. Other computers on the home network can look, and control after they sign in with a PIN (Settings, Access); until a PIN is set they can only watch. Anything from outside the network (a public address, a VPN, a proxy or tunnel) is refused, as is a web page from another site, and every message is checked again on the server. Wrong PINs lock the address out for a while. To use one PIN for DemonX CNC and Design on the same computer, set `DESIGN_AUTH_DIR` to DemonX CNC's `data` folder; otherwise Design keeps its own PIN. `DESIGN_TRUST_LOCAL=0` makes even the server's own computer sign in. Tried only with simulated computers in tests, not yet on two real ones.

### Setting up a shop computer (Linux, kept running with PM2)
DemonX Design is in the same repository as DemonX CNC, so a computer that already runs DemonX from `main` has everything:
```
cd ~/demonx                                    # the DemonX folder, on main
cd design
cp design.env.example design.env && nano design.env      # the laser's address, the power limit, who can connect
npm install && npm run build                   # (the top of the repo is installed already: Design shares some code with DemonX CNC)
pm2 start ecosystem.config.cjs && pm2 save
```
Update later with **`bash scripts/update.sh`** from the top of the repo: it updates DemonX, and Design too wherever a `demonx-design` PM2 process exists (a CNC-only computer never touches Design). Both are asked first whether they are busy (`GET /api/busy`, this computer only: a laser job or move, a CNC job) and nothing is changed while either is. `design/scripts/update.sh` still updates Design alone. Settings and data that belong to one computer live in `design/design.env` and `design/data/` (the laser list, saved positions, rotary settings, material library, camera setup, Ruida laser addresses), which are never committed: copy them across if you move Design to another folder. Design runs on port 8090 (DemonX CNC keeps 8080), so both can run on the same computer.
- **Camera:** a Home Assistant camera as a **Camera** tab in the Laser box (a new picture every two seconds, enough to see how a long job is going) and an *Include the camera* box in the job monitor. Settings, Camera sets it up. With `DESIGN_CNC_DATA` pointing at DemonX CNC's data folder it uses the Home Assistant address and token saved there, so you only choose the camera; otherwise enter them in Design. The token stays on the server and is never sent to a browser, and it is only ever sent to an address on your own network.
- **Save As, Open and downloads from another computer:** a browser only offers its own Save As / Open windows (a name and a folder, writing back to the same file) on a *secure* address: `https://...` or `http://localhost`. From `http://<shop-pc>:8090` it cannot, so Save as asks for a name in the app and the file goes to Downloads (where Chrome also asks you to Keep it). Two ways to get the real windows back: (1) quickest, in Chrome or Edge open `chrome://flags/#unsafely-treat-insecure-origin-as-secure` (Edge: `edge://flags/...`), add `http://<shop-pc address>:8090`, set it to Enabled and relaunch; (2) serve Design over https: make a certificate for the shop PC's name and address (for example with `mkcert`), set `DESIGN_TLS_CERT` and `DESIGN_TLS_KEY` in `design.env` to the two files, restart, and open `https://<shop-pc>:8090`. Without a certificate the browser's warning page appears first, and the file windows still work once it is passed, but a trusted certificate (mkcert's own root installed on each PC) avoids the warning.
- **Big DXF files:** outlines are simplified on import to within 2 micrometres (a traced logo can come with thousands of points a few micrometres apart), and importing the same file again adds nothing new.

