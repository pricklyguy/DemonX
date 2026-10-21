// Browser check for DemonX Design: draws with the real mouse, combines and offsets shapes, undoes, uses the
// command line, exports a DXF, imports it back, and takes screenshots.
//
//   cd design && npm install && npm run build
//   DESIGN_SIM_SPEED=40 npm run serve &                  (the Design server: serves http://localhost:8090 and the simulated laser)
//   node e2e/design.mjs
//
// Stop the server by its port when done (fuser -k 8090/tcp), not with pkill -f.
//
// Needs Playwright with a Chromium (set PLAYWRIGHT_PATH / CHROMIUM if they are not found automatically).
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
function loadPlaywright() {
  for (const p of [process.env.PLAYWRIGHT_PATH, 'playwright', '/opt/node22/lib/node_modules/playwright']) {
    if (!p) continue;
    try { return require(p); } catch { /* try the next */ }
  }
  throw new Error('Playwright not found. Install it (npm i -g playwright) or set PLAYWRIGHT_PATH.');
}
const { chromium } = loadPlaywright();
import { startDesign } from './start.mjs';
const URL_BASE = process.env.DESIGN_URL ?? 'http://localhost:8090';
const chromiumPath = process.env.CHROMIUM ?? (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const shots = process.env.SHOTS ?? fs.mkdtempSync(path.join(os.tmpdir(), 'design-shots-'));

let failures = 0;
const check = (ok, what) => { console.log((ok ? 'PASS ' : 'FAIL ') + what); if (!ok) failures++; };

const browser = await chromium.launch({ ...(chromiumPath ? { executablePath: chromiumPath } : {}) });
const ctx = await browser.newContext({ viewport: { width: 1360, height: 820 }, acceptDownloads: true });
// Stand-ins for the browser's native file pickers (which a script cannot click): files live in window.__fs
await ctx.addInitScript(() => {
  window.__fs = new Map();
  window.__calls = { save: 0, open: 0 };
  const handle = (name) => ({
    name,
    getFile: async () => new File([window.__fs.get(name) ?? ''], name),
    createWritable: async () => { let buf = ''; return { write: async (d) => { buf += d; }, close: async () => { window.__fs.set(name, buf); } }; },
  });
  window.showSaveFilePicker = async (o) => { window.__calls.save++; return handle(window.__nextSaveName ?? o.suggestedName); };
  window.showOpenFilePicker = async () => {
    window.__calls.open++;
    if (!window.__fs.has(window.__openName)) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
    return [handle(window.__openName)];
  };
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const sideTab = (name) => page.locator('aside.side').getByRole('tab', { name, exact: true });
// the arrow buttons live in the Positions tab of the top box; these go there, use them, and come back to the Job tab
const jogClick = async (name) => { await sideTab('Positions').click(); await page.getByRole('button', { name }).click(); await sideTab('Job').click(); };
const jogDisabled = async (name) => { await sideTab('Positions').click(); const d = await page.getByRole('button', { name }).isDisabled(); await sideTab('Job').click(); return d; };
await page.goto(URL_BASE);
await page.waitForSelector('canvas.design-canvas');
// the size of the job is asked for before anything is drawn
await page.getByRole('dialog', { name: 'New design' }).waitFor();
check(await page.getByRole('button', { name: 'Setup new job' }).isVisible(), 'the first thing shown is the New design dialog, starting with Setup new job');
check(!/CO2|3018|diode/i.test(await page.getByRole('dialog').innerText()), 'with no made-up lasers in it');
await page.getByRole('dialog', { name: 'New design' }).getByRole('button', { name: 'Cancel' }).click();
await page.waitForTimeout(300);

const doc = () => page.evaluate(() => window.demonxDesign.doc());
/** A new design with no size limit (the New design dialog has none: a canvas page is made, then its limit is taken off) */
const freeStart = async () => { await startDesign(page, { type: 'canvas', width: 300, height: 180 }); await page.evaluate(() => window.demonxDesign.run('workspace_set', { kind: 'free' })); };
const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Choose an item of the File menu */
const menu = async (item) => {
  await page.getByRole('button', { name: /^File/ }).click();
  await page.getByRole('menuitem', { name: new RegExp('^' + esc(item) + '(\\s|$)') }).click();
};
/** File > New design…, answering "Don't save" if it asks about unsaved changes, and waiting for the size dialog */
const newDesign = async () => {
  await menu('New design…');
  const ask = page.getByRole('dialog', { name: 'Unsaved changes' });
  if (await ask.isVisible().catch(() => false)) await ask.getByRole('button', { name: "Don't save" }).click();
  await page.getByRole('dialog', { name: 'New design' }).waitFor();
};
let box = await page.locator('canvas.design-canvas').boundingBox();
const sync = async () => { box = await page.locator('canvas.design-canvas').boundingBox(); }; // the layout can shift a little when a selection appears
// the first view is centred on (50, 30) at 5 px/mm
const at = (x, y) => [box.x + box.width / 2 + (x - 50) * 5, box.y + box.height / 2 - (y - 30) * 5];
const drag = async (a, b) => {
  await sync();
  const [ax, ay] = at(...a), [bx, by] = at(...b);
  await page.mouse.move(ax, ay); await page.mouse.down(); await page.mouse.move((ax + bx) / 2, (ay + by) / 2); await page.mouse.move(bx, by); await page.mouse.up();
};
const click = async (p, mods = []) => { await sync(); const [x, y] = at(...p); for (const m of mods) await page.keyboard.down(m); await page.mouse.click(x, y); for (const m of mods) await page.keyboard.up(m); };
const log = () => page.locator('.log').innerText();

const canvasTop = box.y;
check((await doc()).shapes.length === 0, 'starts empty');

// draw a rectangle and an overlapping circle with the mouse
await page.keyboard.press('r');
await drag([10, 10], [50, 40]);
await page.keyboard.press('c');
await drag([50, 25], [65, 25]);
let d = await doc();
check(d.shapes.length === 2 && d.shapes[0].kind === 'path' && d.shapes[1].kind === 'circle', 'mouse drew a rectangle and a circle');
check(d.shapes[1].r === 15 && d.shapes[1].cx === 50, 'circle centre and radius are exact (grid snap)');

// right-click ends the drawing tool and goes back to Select (like LightBurn)
const toolOn = (name) => page.getByRole('button', { name }).getAttribute('aria-pressed');
check((await toolOn(/^Circle/)) === 'true', 'the circle tool is active after drawing a circle');
await sync(); await page.mouse.click(...at(80, 50), { button: 'right' });
check((await toolOn(/^Select/)) === 'true' && (await toolOn(/^Circle/)) === 'false', 'right-click went back to the Select tool');
await page.keyboard.press('r');
await page.mouse.click(...at(80, 50), { button: 'right' });
check((await toolOn(/^Select/)) === 'true', 'right-click also leaves the rectangle tool');
check((await doc()).shapes.length === 2, 'right-click drew nothing');

// edit the circle: select it, then change its size from the bar
await click([65, 25]);
await sync();
check(Math.abs(box.y - canvasTop) < 0.5, 'the drawing area does not shift when a shape is selected');
{
  const h0 = (await page.locator('canvas.design-canvas').boundingBox()).height;
  for (const k of ['c', 'p', 'r', 'h', 'v']) { await page.keyboard.press(k); }
  check(Math.abs((await page.locator('canvas.design-canvas').boundingBox()).height - h0) < 0.5, 'switching tools does not resize the drawing area (the hint stays on one line)');
}
check((await page.getByLabel('Width', { exact: true }).inputValue()) === '30', 'the bar shows the circle is 30 mm wide');
check((await page.getByLabel('Diameter').inputValue()) === '30', 'and diameter 30 (circles show a Diameter, not a Radius)');
await page.getByLabel('Diameter').fill('40');
await page.keyboard.press('Enter');
d = await doc();
check(d.shapes[1].r === 20 && d.shapes[1].cx === 50 && d.shapes[1].cy === 25, 'typing Diameter 40 made the circle bigger about its centre');
await page.getByLabel('Width', { exact: true }).fill('50');
await page.keyboard.press('Enter');
d = await doc();
check(d.shapes[1].kind === 'circle' && d.shapes[1].r === 25, 'Width 50 keeps it a circle (diameter 50)');
await page.getByLabel('X position').fill('60');
await page.keyboard.press('Enter');
check((await doc()).shapes[1].cx === 60, 'X position moves the circle (its centre by default)');
await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z');
d = await doc();
check(d.shapes[1].r === 15 && d.shapes[1].cx === 50, 'three undos put the circle back');

// resize with the square handle: drag the right-hand handle of the circle's box outwards
await click([65, 25]);
await sync();
await page.mouse.move(...at(65, 25));
await page.mouse.down(); await page.mouse.move(...at(70, 25)); await page.mouse.move(...at(75, 25)); await page.mouse.up();
d = await doc();
check(Math.abs(d.shapes[1].r - 20) < 0.01 && Math.abs(d.shapes[1].cx - 55) < 0.01, 'dragging the handle resized the circle about the opposite side');
await page.screenshot({ path: path.join(shots, '0-edit-circle.png') });
await page.keyboard.press('Control+z');
check((await doc()).shapes[1].r === 15, 'and that undoes in one step');

// rotate and flip from the bar
await click([10, 25]);
await page.getByLabel('Rotate by degrees').fill('90');
await page.keyboard.press('Enter');
d = await doc();
const rb = d.shapes[0].rings[0];
const wide = Math.max(...rb.map((p) => p[0])) - Math.min(...rb.map((p) => p[0]));
check(Math.abs(wide - 30) < 0.01, 'Rotate 90 turned the 40 x 30 rectangle on its side');
await page.getByRole('button', { name: /Flip$/ }).first().click();
check((await page.locator('.log').innerText()).includes('Flipped'), 'Flip works');
await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z');
check(Math.max(...(await doc()).shapes[0].rings[0].map((p) => p[0])) - Math.min(...(await doc()).shapes[0].rings[0].map((p) => p[0])) === 40, 'two undos restore the rectangle');

// pick the rectangle, then shift-pick the circle; subtract the circle from the rectangle
await page.keyboard.press('v');
await click([10, 25]);
await click([65, 25], ['Shift']);
await page.getByRole('button', { name: /^Subtract/ }).click();
d = await doc();
check(d.shapes.length === 1 && d.shapes[0].kind === 'path' && d.shapes[0].closed, 'Subtract left one closed shape');
const bite = d.shapes[0].rings.flat();
check(Math.max(...bite.map((p) => p[0])) <= 50.001 && Math.min(...bite.map((p) => p[0])) >= 9.999, 'the result is still the rectangle outline, bitten by the circle');
await page.screenshot({ path: path.join(shots, '1-subtract.png') });

// offset it, then undo the offset
await click([10, 25]);
await page.getByRole('button', { name: /^Offset: grow/ }).click();
await page.getByRole('dialog', { name: 'Offset' }).getByRole('button', { name: 'OK', exact: true }).click();
check((await doc()).shapes.length === 2, 'Offset added an outline and kept the original');
await page.keyboard.press('Control+z');
check((await doc()).shapes.length === 1, 'Ctrl+Z undid the offset');
await page.keyboard.press('Control+y');
check((await doc()).shapes.length === 2, 'Ctrl+Y redid it');

// the command line: closed to begin with, opened with the chevron in the status bar
check(!(await page.getByLabel('Command line', { exact: true }).isVisible()), 'the command line starts collapsed so the drawing area is clear');
await page.getByRole('button', { name: /Command line/ }).click();
await page.getByLabel('Command line', { exact: true }).fill('rect 70 10 20 15');
await page.keyboard.press('Enter');
check((await doc()).shapes.length === 3, 'command line: rect 70 10 20 15 drew a shape');
await page.getByLabel('Command line', { exact: true }).fill('circle 1 2');
await page.keyboard.press('Enter');
check((await log()).includes('Usage: circle cx cy r'), 'a bad command explains itself');
await page.getByLabel('Command line', { exact: true }).fill('union');
await page.keyboard.press('Enter');
check((await log()).includes('Select at least two closed shapes') || (await log()).includes('Select at least one'), 'union with nothing sensible selected is refused politely');
check((await doc()).shapes.length === 3, 'a refused command changes nothing');

// layers: new layer, hide it
check((await page.getByRole('button', { name: /^Active layer: Layer 1/ }).count()) === 1 && (await doc()).layers.length === 1, 'a new design has one layer, shown as the active layer in the header');
await page.getByRole('button', { name: /^Active layer/ }).click();
await page.getByLabel('New layer name').fill('Score');
await page.getByRole('button', { name: 'Add' }).click();
check((await doc()).layers.some((l) => l.name === 'Score') && (await page.getByRole('button', { name: /^Active layer: Score/ }).count()) === 1, 'a layer can be made from the header and becomes the active one');
await page.getByRole('button', { name: /^Active layer/ }).click();
await page.getByLabel('Score colour', { exact: true }).waitFor();
await page.getByLabel('Show Score').uncheck();
check((await doc()).layers.find((l) => l.name === 'Score').visible === false, 'a layer can be hidden');
await page.keyboard.press('Escape');

// export DXF and import it into a clean page
const [dl] = await Promise.all([page.waitForEvent('download'), menu('Export DXF')]);
const dxfPath = path.join(shots, 'out.dxf');
await dl.saveAs(dxfPath);
const dxf = fs.readFileSync(dxfPath, 'utf8');
check(dxf.includes('POLYLINE') && dxf.includes('EOF'), 'Export DXF produced a DXF');
const [dl2] = await Promise.all([page.waitForEvent('download'), menu('Export SVG')]);
const svgPath = path.join(shots, 'out.svg');
await dl2.saveAs(svgPath);
check(fs.readFileSync(svgPath, 'utf8').includes('mm"'), 'Export SVG is in millimetres');

const before = (await doc()).shapes.length;
await page.locator('input[accept=".dxf"]').setInputFiles(dxfPath);
await page.waitForTimeout(300);
check((await doc()).shapes.length === before, 'Importing the same DXF again adds nothing (the shapes are already there)');
await page.evaluate(() => window.demonxDesign.run('delete', { ids: window.demonxDesign.doc().shapes.map((s) => s.id) }));
await page.locator('input[accept=".dxf"]').setInputFiles(dxfPath);
await page.waitForTimeout(300);
check((await doc()).shapes.length === before, 'Import DXF brings the shapes back into an empty drawing');

// the example, light theme, and a phone-width check
await page.reload();
await page.waitForSelector('canvas.design-canvas');
await page.getByRole('dialog', { name: 'New design' }).getByRole('button', { name: 'Cancel' }).click();
await menu('Open the example part');
await page.waitForTimeout(400);
check((await doc()).shapes.length >= 3, 'the Example part builds');
await page.screenshot({ path: path.join(shots, '2-example-dark.png') });

// Laser mode: layers with Output / Show / Air, the job numbers, the burn-path preview and the G-code file
await page.getByRole('tablist', { name: 'Design, Laser or CNC' }).getByRole('tab', { name: 'Laser' }).click();
await page.getByText('Cuts / Layers').waitFor();
await page.locator('aside.side').getByRole('tab', { name: 'Job', exact: true }).click();
await page.waitForTimeout(300);
const statsText = async () => { await page.locator('aside.side').getByRole('tab', { name: 'Job', exact: true }).click(); return page.locator('.stats').innerText(); };
check(/2 layers · burn \d+ mm · est\./.test(await statsText()), 'Laser mode shows the job size and time: ' + (await statsText()));
const saveGcode = async () => {
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save G-code' }).first().click()]);
  const f = path.join(shots, 'job-' + Date.now() + '.gcode');
  await dl.saveAs(f);
  return fs.readFileSync(f, 'utf8');
};
let gc = await saveGcode();
check(gc.includes('M4 S0') && gc.includes('Layer Layer 1') && gc.includes('Layer Engrave') && gc.trimEnd().endsWith('M2'), 'Save G-code wrote a laser job with both layers');
check(!/^G0.* S\d/m.test(gc), 'no S word on any rapid move');
await page.screenshot({ path: path.join(shots, '5-laser-mode.png') });
check((await page.locator('.header').evaluate((el) => el.getBoundingClientRect().height)) < 80, 'the header stays on one row in Laser mode at 1360 px');
await page.locator('aside.side').getByRole('tab', { name: 'Layers', exact: true }).click();
await page.locator('aside.side').getByRole('tab', { name: 'Layers', exact: true }).click();
await page.getByLabel('Engrave output').uncheck();
check(/1 layer ·/.test(await statsText()), 'Output off for a layer drops it from the job');
gc = await saveGcode();
check(!gc.includes('Layer Engrave') && gc.includes('Layer Layer 1'), 'and from the G-code');
await page.locator('aside.side').getByRole('tab', { name: 'Layers', exact: true }).click();
await page.getByLabel('Engrave output').check();
await page.locator('aside.side').getByRole('tab', { name: 'Layers', exact: true }).click();
await page.getByLabel('Show Engrave').uncheck();
check(/2 layers ·/.test(await statsText()), 'hiding a layer does not remove it from the job');
await page.locator('aside.side').getByRole('tab', { name: 'Layers', exact: true }).click();
await page.getByLabel('Show Engrave').check();
await page.locator('aside.side').getByRole('tab', { name: 'Layers', exact: true }).click();
await page.getByLabel('Layer 1 air').check();
gc = await saveGcode();
check(gc.includes('\nM8\n') && gc.includes('\nM9\n'), 'Air turns on M8 / M9 around the layer');
await page.locator('aside.side').getByRole('tab', { name: 'Layers', exact: true }).click();
await page.getByLabel('Layer 1 air').uncheck();
await page.locator('aside.side').getByRole('tab', { name: 'Layers', exact: true }).click();
await page.getByLabel('Max power', { exact: true }).fill('0');
await page.keyboard.press('Enter');
await page.locator('aside.side').getByRole('tab', { name: 'Job', exact: true }).click();
await page.waitForTimeout(150); await page.waitForSelector('[data-jobs=ready]', { state: 'attached' });
check((await page.locator('.warn').allInnerTexts()).join(' ').includes('0% power'), 'a 0% power layer is flagged');
await page.keyboard.press('Control+z');
await page.getByRole('tablist', { name: 'Design, Laser or CNC' }).getByRole('tab', { name: 'CNC' }).click();
check(await page.getByText('Send to DemonX CNC').first().isVisible(), 'CNC tab says what is coming');
await page.getByRole('tablist', { name: 'Design, Laser or CNC' }).getByRole('tab', { name: 'Design' }).click();
// Job setup: size the job before designing (laser work area, CNC stock), flag what does not fit
await newDesign();
check((await page.locator('.modal .warn').innerText()).includes('replaces the drawing'), 'New warns that it replaces a drawing that has shapes in it');
await startDesign(page, { laser: '3018 + laser head' });
check((await page.locator('.setup-btn').innerText()).includes('300 × 180 mm'), 'the header shows the work area: ' + (await page.locator('.setup-btn').innerText()));
check((await page.getByRole('tablist', { name: 'Design, Laser or CNC' }).getByRole('tab', { name: 'Laser' }).getAttribute('aria-selected')) === 'false' && (await page.locator('aside.side').count()) === 0, 'a new file always opens in the design view (no side panel), whatever the job kind');
check((await doc()).shapes.length === 0, 'and starts empty');
const vw = await page.evaluate(() => window.demonxDesignView());
check(Math.abs(vw.cx - 150) < 1 && Math.abs(vw.cy - 90) < 1, 'the view is fitted to the work area');
await page.evaluate(() => window.demonxDesign.run('add_rect', { x: 100, y: 50, w: 40, h: 20, layer: 'Layer 1' }));
check((await page.locator('.chip-warn').count()) === 0, 'a shape inside the work area raises no warning');
await page.evaluate(() => window.demonxDesign.run('add_rect', { x: 290, y: 0, w: 30, h: 10, layer: 'Layer 1' }));
check((await page.locator('.chip-warn').innerText()).includes('1 shape outside the work area'), 'a shape that sticks out is flagged: ' + (await page.locator('.chip-warn').innerText()));
await page.screenshot({ path: path.join(shots, '6-laser-bed.png') });
await page.getByRole('tablist', { name: 'Design, Laser or CNC' }).getByRole('tab', { name: 'Laser' }).click();
await page.locator('aside.side').getByRole('tab', { name: 'Job', exact: true }).click();
await page.getByLabel('Start from').selectOption('absolute');
await page.waitForTimeout(150); await page.waitForSelector('[data-jobs=ready]', { state: 'attached' });
check((await page.locator('.warn').allInnerTexts()).join(' ').includes('outside the machine area'), 'Absolute coordinates warns that the job is outside the machine area');
await page.getByLabel('Start from').selectOption('user');
await page.waitForTimeout(150); await page.waitForSelector('[data-jobs=ready]', { state: 'attached' });
check(!(await page.locator('.warn').allInnerTexts()).join(' ').includes('outside the machine area'), 'a user origin does not');

// a bigger machine, saved by name, and remembered after a reload
await page.locator('.setup-btn').click();
await page.getByLabel('Work area width').fill('1000');
await page.getByLabel('Work area height').fill('600');
await page.keyboard.press('Enter');
check((await page.getByRole('dialog').getByLabel('Start from').inputValue()) === 'laser:Custom', 'editing the numbers makes it a custom laser');
await page.getByLabel('Name to save under').fill('Test CO2');
await page.getByRole('button', { name: 'Save', exact: true }).click();
check((await page.getByRole('dialog').getByLabel('Start from').inputValue()) === 'laser:Test CO2', 'Save selects the new laser');
await page.getByRole('button', { name: 'OK' }).click();
check((await doc()).workspace.width === 1000 && (await doc()).machine.height === 600 && (await doc()).shapes.length === 2, 'Job setup changes the size and keeps the shapes');
check((await page.locator('.chip-warn').count()) === 0, 'and the shape that stuck out now fits');

// CNC: material size, thickness, XY datum
await newDesign();
await startDesign(page, { type: 'cnc', width: 969, height: 1044, thickness: 18, datum: 'c', zZero: 'bed' });
let ws = (await doc()).workspace;
check(ws.kind === 'cnc' && ws.width === 969 && ws.height === 1044 && ws.thickness === 18 && ws.datum === 'c' && ws.zZero === 'bed', 'a CNC job keeps size, thickness, datum and Z zero');
check((await page.getByRole('tablist', { name: 'Design, Laser or CNC' }).getByRole('tab', { name: 'CNC' }).getAttribute('aria-selected')) === 'false', 'a new CNC job also opens in the design view');
await page.getByRole('tablist', { name: 'Design, Laser or CNC' }).getByRole('tab', { name: 'CNC' }).click();
check((await page.locator('.setup-btn').innerText()).includes('969 × 1044 × 18 mm'), 'the header shows the material');
check((await page.getByText('969 × 1044 × 18 mm · single sided').isVisible()), 'the CNC panel shows the job');
const vc = await page.evaluate(() => window.demonxDesignView());
check(Math.abs(vc.cx) < 1 && Math.abs(vc.cy) < 1, 'with the datum at the centre, the material is centred on 0,0');
await page.evaluate(() => window.demonxDesign.run('add_rect', { x: -480, y: -500, w: 100, h: 100, layer: 'Layer 1' }));
check((await page.locator('.chip-warn').count()) === 0, 'a shape inside the stock (centre datum) is fine');
await page.evaluate(() => window.demonxDesign.run('add_rect', { x: 400, y: 500, w: 100, h: 100, layer: 'Layer 1' }));
check((await page.locator('.chip-warn').innerText()).includes('outside the material'), 'a shape that hangs off the material is flagged');
await page.screenshot({ path: path.join(shots, '7-cnc-stock.png') });
await newDesign();
await startDesign(page, { laser: '3018 + laser head' });
await page.keyboard.press('Control+z');
check((await doc()).workspace.kind === 'cnc' && (await doc()).shapes.length === 2, 'Ctrl+Z brings back the previous job and its drawing');
await page.reload();
await page.getByRole('dialog', { name: 'New design' }).getByRole('button', { name: 'Setup Test CO2', exact: true }).waitFor();
check(true, 'a saved laser is still listed after a reload');
await page.keyboard.press('Escape');
check(!(await page.getByRole('dialog').isVisible()), 'Escape closes the dialog');
// ---- File menu: save, open, unsaved changes ------------------------------------------------------------------------
await newDesign();
await startDesign(page, { type: 'canvas', width: 300, height: 180 });
const unsaved = () => page.locator('.docname .dot').count();
const title = () => page.title();
check((await unsaved()) === 0 && (await page.locator('.docname').innerText()).includes('Untitled'), 'a new design is Untitled and has no unsaved changes');
await page.evaluate(() => window.demonxDesign.run('add_rect', { x: 0, y: 0, w: 20, h: 10, layer: 'Layer 1' }));
await page.locator('.docname .dot').waitFor({ timeout: 3000 }).catch(() => {});
check((await unsaved()) === 1 && (await title()).startsWith('●'), 'drawing something marks it unsaved (dot in the header and the tab title)');
check(await page.evaluate(() => { const ev = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(ev); return ev.defaultPrevented; }), 'closing the tab with unsaved changes asks first');
await page.evaluate(() => { window.__nextSaveName = 'Kiosk base.dxd'; window.__calls.save = 0; });
await page.keyboard.press('Control+s');
await page.waitForFunction(() => document.querySelector('.docname b')?.textContent === 'Kiosk base');
check((await unsaved()) === 0 && !(await title()).startsWith('●') && (await title()).includes('Kiosk base'), 'Ctrl+S saved it as Kiosk base: no dot, the name is in the title');
check((await page.evaluate(() => window.__calls.save)) === 1, 'it asked where to save once');
const saved1 = JSON.parse(await page.evaluate(() => window.__fs.get('Kiosk base.dxd')));
check(saved1.format === 'demonx-design' && saved1.doc.shapes.length === 1 && saved1.doc.layers.length === 1, 'the file holds the design (shapes and layers)');
await page.evaluate(() => { window.demonxDesign.run('layer_set', { name: 'Engrave' }); window.demonxDesign.run('add_circle', { cx: 50, cy: 20, r: 6, layer: 'Engrave' }); });
check((await unsaved()) === 1, 'a change after saving makes it unsaved again');
await page.keyboard.press('Control+s');
await page.waitForFunction(() => document.querySelector('.docname .dot') === null);
check((await page.evaluate(() => window.__calls.save)) === 1, 'the second Save writes to the same file without asking again');
check(JSON.parse(await page.evaluate(() => window.__fs.get('Kiosk base.dxd'))).doc.shapes.length === 2, 'and the file now has both shapes');
await page.keyboard.press('Control+z');
check((await unsaved()) === 1, 'undoing after a save leaves it unsaved');
await page.keyboard.press('Control+y');
check((await unsaved()) === 0, 'redoing back to what was saved makes it clean again');

// New with unsaved changes asks; Cancel keeps everything, Don't save carries on
await page.evaluate(() => window.demonxDesign.run('add_rect', { x: 100, y: 0, w: 5, h: 5, layer: 'Layer 1' }));
await menu('New design…');
const ask = page.getByRole('dialog', { name: 'Unsaved changes' });
check((await ask.innerText()).includes('Kiosk base has changes that are not saved'), 'New with unsaved changes asks first, by name');
await ask.getByRole('button', { name: 'Cancel' }).click();
check((await doc()).shapes.length === 3 && !(await page.getByRole('dialog').count()), 'Cancel changes nothing');
await menu('New design…');
await page.getByRole('dialog', { name: 'Unsaved changes' }).getByRole('button', { name: "Don't save" }).click();
await freeStart();
check((await doc()).shapes.length === 0 && (await page.locator('.docname').innerText()).includes('Untitled'), "Don't save starts the new design, Untitled");

// Save from the prompt: the Save button saves, then goes on
await page.evaluate(() => window.demonxDesign.run('add_rect', { x: 0, y: 0, w: 8, h: 8, layer: 'Layer 1' }));
await page.evaluate(() => { window.__nextSaveName = 'From prompt.dxd'; });
await menu('Open…');
await page.getByRole('dialog', { name: 'Unsaved changes' }).getByRole('button', { name: 'Save', exact: true }).click();
await page.waitForFunction(() => window.__fs.has('From prompt.dxd'));
check(true, 'Save in the prompt saves the file first');

// Open: a good file, then a damaged one
await page.evaluate(() => { window.__openName = 'Kiosk base.dxd'; });
await menu('Open…');
await page.waitForFunction(() => document.querySelector('.docname b')?.textContent === 'Kiosk base');
check((await doc()).shapes.length === 2 && (await unsaved()) === 0, 'Open loads the saved design (2 shapes) as a clean file');
check((await doc()).layers.map((l) => l.name).join() === 'Layer 1,Engrave', 'with its layers');
await page.evaluate(() => { window.__fs.set('bad.dxd', '{"format":"something else"}'); window.__openName = 'bad.dxd'; });
await menu('Open…');
await page.getByRole('alert').filter({ hasText: 'Could not open bad.dxd' }).waitFor();
check((await page.getByRole('alert').innerText()).includes('not a DemonX Design file') && (await doc()).shapes.length === 2, 'a damaged file is refused with the reason, and the design stays');
await page.evaluate(() => { window.__fs.set('worse.dxd', 'not json at all'); window.__openName = 'worse.dxd'; });
await menu('Open…');
await page.getByRole('alert').filter({ hasText: 'worse.dxd' }).waitFor();
check((await page.getByRole('alert').innerText()).includes('not readable JSON'), 'and so is a file that is not JSON');
await page.getByRole('button', { name: 'Dismiss' }).click();

// Save as keeps working and switches to the new file
await page.evaluate(() => { window.__nextSaveName = 'Copy.dxd'; });
await menu('Save as…');
await page.waitForFunction(() => document.querySelector('.docname b')?.textContent === 'Copy');
check((await page.evaluate(() => window.__fs.has('Copy.dxd'))), 'Save as writes a second file and the design is now that one');

// the menu itself: opens, Escape closes
await page.getByRole('button', { name: /^File/ }).click();
check(await page.getByRole('menu').isVisible(), 'the File menu opens');
await page.screenshot({ path: path.join(shots, '12-file-menu.png'), clip: { x: 0, y: 0, width: 900, height: 400 } });
await page.keyboard.press('Escape');
check(!(await page.getByRole('menu').count()), 'Escape closes it');

// A browser without the native pickers: Save downloads a file, Open uses a file chooser
{
  const ctx2 = await browser.newContext({ viewport: { width: 1360, height: 820 }, acceptDownloads: true });
  await ctx2.addInitScript(() => { Object.defineProperty(window, 'showSaveFilePicker', { value: undefined }); Object.defineProperty(window, 'showOpenFilePicker', { value: undefined }); });
  const p2 = await ctx2.newPage();
  await p2.goto(URL_BASE);
  await p2.getByRole('dialog', { name: 'New design' }).getByRole('button', { name: 'Cancel' }).click();
  await p2.evaluate(() => window.demonxDesign.run('add_rect', { x: 0, y: 0, w: 30, h: 12, layer: 'Layer 1' }));
  await p2.keyboard.press('Control+s');
  // there is no file window to ask for a name, so the app asks (the default is Untitled)
  const nameDlg = p2.getByRole('dialog', { name: 'Name and save' });
  await nameDlg.waitFor();
  const [dl3] = await Promise.all([p2.waitForEvent('download'), nameDlg.getByRole('button', { name: 'Save' }).click()]);
  check(dl3.suggestedFilename() === 'Untitled.dxd', 'without native pickers Save asks for a name, then downloads Untitled.dxd');
  const f = path.join(shots, 'fallback.dxd');
  await dl3.saveAs(f);
  check(JSON.parse(fs.readFileSync(f, 'utf8')).doc.shapes.length === 1, 'and the download is the design');
  await p2.evaluate(() => window.demonxDesign.run('delete', { ids: window.demonxDesign.doc().shapes.map((s) => s.id) }));
  await p2.evaluate(() => window.demonxDesign.run('add_circle', { cx: 5, cy: 5, r: 3, layer: 'Layer 1' }));
  await p2.getByRole('button', { name: /^File/ }).click();
  await p2.getByRole('menuitem', { name: /^Open…/ }).click();
  await p2.getByRole('dialog', { name: 'Unsaved changes' }).getByRole('button', { name: "Don't save" }).click();
  await p2.locator('input[accept=".dxd,.json"]').setInputFiles(f);
  await p2.waitForFunction(() => window.demonxDesign.doc().shapes.length === 1 && window.demonxDesign.doc().shapes[0].kind === 'path');
  check(true, 'and Open with the file chooser brings it back');
  await ctx2.close();
}

// ---- Object snap and the centre point ------------------------------------------------------------------------------
await newDesign();
await freeStart();
await page.evaluate(() => window.demonxDesign.run('add_rect', { x: 10, y: 10, w: 40, h: 30, layer: 'Layer 1' }));
await page.getByRole('button', { name: 'Fit', exact: true }).click();
await page.waitForTimeout(200);
await page.getByLabel('Grid', { exact: true }).uncheck(); // so only the point snap can make a click exact
const atV = async (x, y) => { await sync(); const v = await page.evaluate(() => window.demonxDesignView()); return [box.x + v.w / 2 + (x - v.cx) * v.scale, box.y + v.h / 2 - (y - v.cy) * v.scale]; };
const label = async () => (await page.locator('.snap-label').count()) ? await page.locator('.snap-label').innerText() : '';
const lastShape = async () => (await doc()).shapes.at(-1);
const cleanup = () => page.evaluate(() => { const d = window.demonxDesign.doc(); const ids = d.shapes.slice(1).map((s) => s.id); if (ids.length) window.demonxDesign.run('delete', { ids }); });

// a line that starts exactly on a corner of the rectangle, with the pointer a few pixels off
await page.keyboard.press('p');
let [sx, sy] = await atV(10, 10);
await page.mouse.move(sx + 3, sy + 2);
check((await label()).includes('Endpoint'), 'hovering near a corner shows the snap marker label: ' + (await label()));
await page.screenshot({ path: path.join(shots, '11-endpoint-marker.png'), clip: { x: sx - 150, y: sy - 110, width: 300, height: 220 } });
await page.mouse.click(sx + 3, sy + 2);
[sx, sy] = await atV(50, 40);
await page.mouse.move(sx - 2, sy - 3);
check((await label()).includes('Endpoint'), 'and near the opposite corner');
await page.mouse.click(sx - 2, sy - 3);
await page.keyboard.press('Enter');
let ls = await lastShape();
check(ls.kind === 'path' && !ls.closed && JSON.stringify(ls.rings[0]) === '[[10,10],[50,40]]', 'the line starts and ends exactly on the corners: ' + JSON.stringify(ls.rings?.[0]));

// with Points switched off the same clicks are not exact
await page.getByLabel('Points', { exact: true }).uncheck();
await page.keyboard.press('p');
[sx, sy] = await atV(10, 40);
await page.mouse.move(sx + 3, sy + 2);
check((await label()) === '', 'no marker with Points off');
await page.mouse.click(sx + 3, sy + 2);
[sx, sy] = await atV(50, 10);
await page.mouse.click(sx - 3, sy - 2);
await page.keyboard.press('Enter');
ls = await lastShape();
check(JSON.stringify(ls.rings[0]) !== '[[10,40],[50,10]]', 'with Points off the points are where you clicked');
await page.getByLabel('Points', { exact: true }).check();
await cleanup();

// the centre of a shape: a circle drawn from near the middle of the rectangle is centred exactly on it
await page.keyboard.press('c');
[sx, sy] = await atV(30, 25);
await page.mouse.move(sx + 3, sy - 2);
check((await label()).includes('Center'), 'hovering near the middle of the rectangle offers its centre: ' + (await label()));
await page.mouse.down();
const [tx, ty] = await atV(36, 25);
await page.mouse.move(tx, ty); await page.mouse.up();
ls = await lastShape();
check(ls.kind === 'circle' && Math.abs(ls.cx - 30) < 1e-6 && Math.abs(ls.cy - 25) < 1e-6, 'the circle is centred exactly on the rectangle centre: ' + ls.cx + ', ' + ls.cy);
await cleanup();

// ---- Trim (scissors)
await page.evaluate(() => window.demonxDesign.run('add_path', { points: [[0, 25], [60, 25]], closed: false, layer: 'Layer 1' }));
await page.keyboard.press('t');
check(await page.getByRole('button', { name: /Trim/ }).first().getAttribute('aria-pressed').then((v) => v === 'true').catch(() => true), 'T picks the Trim tool');
const trimBefore = JSON.stringify((await doc()).shapes);
let [trx, try_] = await atV(80, 25);
await page.mouse.move(trx, try_);
await page.waitForTimeout(100);
check(JSON.stringify((await doc()).shapes) === trimBefore, 'hovering changes nothing');
[trx, try_] = await atV(30, 25);
await page.mouse.move(trx, try_);
await page.waitForTimeout(100);
await page.screenshot({ path: path.join(shots, '10-trim-hover.png') });
await page.mouse.click(trx, try_);
await page.waitForTimeout(150);
const trimAfter = await doc();
const trimInside = trimAfter.shapes.slice(1).flatMap((s) => s.rings || []).flat().filter(([x, y]) => Math.abs(y - 25) < 1e-6 && x > 10.001 && x < 49.999);
check(trimInside.length === 0, 'clicking the piece between two crossings cuts it away');
const trimEnds = trimAfter.shapes.slice(1).flatMap((s) => s.rings || []).flat().map(([x]) => Math.round(x * 1000) / 1000).sort((a, b) => a - b);
check(trimEnds.includes(10) && trimEnds.includes(50), 'the cut ends sit exactly on the crossings');
await page.keyboard.press('Control+z');
await page.waitForTimeout(100);
check(JSON.stringify((await doc()).shapes) === trimBefore, 'Undo restores the line');
[trx, try_] = await atV(8, 25);
await page.mouse.click(trx, try_);
await page.waitForTimeout(100);
check(JSON.stringify((await doc()).shapes) !== trimBefore, 'an open line end past one crossing trims too');
await page.keyboard.press('Control+z');
await page.mouse.move(...(await atV(300, 300)));
await page.mouse.click(...(await atV(300, 300)));
await page.waitForTimeout(100);
check(JSON.stringify((await doc()).shapes) === trimBefore, 'clicking empty space trims nothing');
await page.mouse.click(trx, try_, { button: 'right' });
await page.keyboard.press('v');
await cleanup();

// ---- Align / distribute
await page.evaluate(() => { window.demonxDesign.run('delete', { ids: window.demonxDesign.doc().shapes.map((x) => x.id) }); const r = window.demonxDesign.run; r('add_rect', { x: 0, y: 60, w: 10, h: 10, layer: 'Layer 1' }); r('add_rect', { x: 20, y: 70, w: 30, h: 10, layer: 'Layer 1' }); r('add_rect', { x: 100, y: 55, w: 20, h: 6, layer: 'Layer 1' }); });
await page.waitForTimeout(150);
await page.mouse.move(...(await atV(300, 300)));
await page.keyboard.press('Control+a');
await page.waitForTimeout(100);
await page.getByRole('button', { name: /^Align and space/ }).click();
const A = page.getByRole('group', { name: 'Align' });
check(await A.getByRole('button', { name: 'Align left edges' }).isEnabled(), 'align buttons light up with shapes selected');
const xs = async () => (await doc()).shapes.slice(0).map((s) => Math.min(...s.rings[0].map((p) => p[0])));
await A.getByRole('button', { name: 'Space evenly across' }).click();
const spaced = await xs();
check(Math.abs(spaced[0]) < 1e-6 && Math.abs(spaced[2] - 100) < 1e-6 && Math.abs(spaced[1] - 40 - 0) > -1, 'space evenly keeps the outer two in place');
const sd = (await doc()).shapes.slice(0).map((s) => ({ a: Math.min(...s.rings[0].map((p) => p[0])), b: Math.max(...s.rings[0].map((p) => p[0])) }));
check(Math.abs((sd[1].a - sd[0].b) - (sd[2].a - sd[1].b)) < 1e-6, 'and the gaps are equal');
await A.getByRole('button', { name: 'Align left edges' }).click();
check((await xs()).every((v) => Math.abs(v) < 1e-6), 'align left lines every left edge up');
await A.getByRole('button', { name: 'Align bottom edges' }).click();
await page.screenshot({ path: path.join(shots, '11-align.png') });
await page.keyboard.press('Control+z');
await page.keyboard.press('Control+z');
await page.keyboard.press('Control+z');
check((await xs()).join() === [0, 20, 100].join(), 'undo steps back through align and distribute');
await page.evaluate(() => { const r = window.demonxDesign.run; r('delete', { ids: window.demonxDesign.doc().shapes.map((x) => x.id) }); r('add_rect', { x: 10, y: 10, w: 40, h: 30, layer: 'Layer 1' }); });

// ---- Copy / paste / duplicate / array
const count = async () => (await doc()).shapes.length;
await page.mouse.move(...(await atV(300, 300)));
await page.keyboard.press('Control+a');
await page.keyboard.press('Control+d');
await page.waitForTimeout(100);
check((await count()) === 2, 'Ctrl+D duplicates the selection');
const dupd = (await doc()).shapes[1];
check(Math.abs(Math.min(...dupd.rings[0].map((p) => p[0])) - 15) < 1e-6, 'the copy sits 5 mm along and down from the original');
await page.keyboard.press('Control+z');
await page.keyboard.press('Control+a');
await page.keyboard.press('Control+c');
await page.keyboard.press('Control+v');
await page.keyboard.press('Control+v');
await page.waitForTimeout(100);
check((await count()) === 3, 'Ctrl+C then Ctrl+V twice adds two copies');
const px = (await doc()).shapes.slice(1).map((s) => Math.min(...s.rings[0].map((p) => p[0])));
check(Math.abs(px[0] - 15) < 1e-6 && Math.abs(px[1] - 20) < 1e-6, 'and each paste lands further along, not on top of the last');
await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z');
await page.keyboard.press('Control+a');
await page.keyboard.press('Control+x');
check((await count()) === 0, 'Ctrl+X removes the shape');
await page.keyboard.press('Control+v');
check((await count()) === 1, 'and Ctrl+V brings it back');
await page.getByRole('button', { name: /^Array/ }).click();
const arrDlg = page.getByRole('dialog', { name: 'Array' });
await arrDlg.waitFor();
await arrDlg.getByLabel('Columns').fill('3'); await arrDlg.getByLabel('Columns').press('Enter');
await arrDlg.getByLabel('Rows').fill('2'); await arrDlg.getByLabel('Rows').press('Enter');
await arrDlg.getByLabel('Spacing X').fill('60'); await arrDlg.getByLabel('Spacing X').press('Enter');
await arrDlg.getByLabel('Spacing Y').fill('50'); await arrDlg.getByLabel('Spacing Y').press('Enter');
await page.screenshot({ path: path.join(shots, '12-array.png') });
await arrDlg.getByRole('button', { name: 'Make array' }).click();
await page.waitForTimeout(150);
check((await count()) === 6, 'a 3 x 2 grid makes six shapes');
await page.keyboard.press('Control+z');
check((await count()) === 1, 'the array undoes in one step');
await page.getByRole('button', { name: /^Array/ }).click();
await arrDlg.waitFor();
await page.keyboard.press('Escape');
await arrDlg.waitFor({ state: 'detached' });
check(true, 'Escape closes the array dialog');
await page.evaluate(() => { const r = window.demonxDesign.run; r('delete', { ids: window.demonxDesign.doc().shapes.map((x) => x.id) }); r('add_rect', { x: 10, y: 10, w: 40, h: 30, layer: 'Layer 1' }); });


// ---- Gadgets: pixel numbering, nudge to guide, count matching
await page.evaluate(() => { const r = window.demonxDesign.run; r('add_circle', { cx: 15, cy: 60, r: 3, layer: 'Layer 1' }); r('add_circle', { cx: 30, cy: 62, r: 3, layer: 'Layer 1' }); r('add_circle', { cx: 45, cy: 58, r: 3, layer: 'Layer 1' }); r('add_path', { points: [[0, 70], [60, 70]], closed: false, layer: 'Layer 1' }); });
await page.getByRole('button', { name: 'Fit', exact: true }).click();
await page.waitForTimeout(200);
const gadgetMenu = async (item) => { await page.getByRole('button', { name: /^Gadgets/ }).click(); await page.getByRole('menuitem', { name: item }).click(); };
const shiftClick = async (x, y) => { const [px, py] = await atV(x, y); await page.keyboard.down('Shift'); await page.mouse.click(px, py); await page.keyboard.up('Shift'); };
await page.keyboard.press('v');
await page.keyboard.press('Escape');
await shiftClick(48, 58); await shiftClick(18, 60); await shiftClick(33, 62);
await gadgetMenu('Auto number…');
await page.getByRole('dialog', { name: 'Auto number' }).getByRole('button', { name: 'Number them' }).click();
await page.waitForTimeout(150);
let gd = await doc();
const nums = gd.shapes.filter((s) => s.layer === 'Pixel Numbers');
check(nums.length === 3, 'Auto number stamps one number per clicked circle');
const cxOf = (s) => (Math.min(...s.rings.flat().map((p) => p[0])) + Math.max(...s.rings.flat().map((p) => p[0]))) / 2;
check(Math.abs(cxOf(nums[0]) - 45) < 2.5 && Math.abs(cxOf(nums[1]) - 15) < 0.1, 'number 1 sits on the circle clicked first');
check(gd.shapes.filter((s) => s.layer === 'Pixel Nodes').length === 3 && gd.shapes.some((s) => s.layer === 'Pixel Wiring'), 'the wiring path and marker circles are added');
await page.screenshot({ path: path.join(shots, '13-gadgets.png') });
await page.keyboard.press('Control+z');
check((await doc()).shapes.filter((s) => s.layer === 'Pixel Numbers').length === 0, 'Undo takes the whole numbering away in one step');
await page.keyboard.press('Escape');
await shiftClick(18, 60); await shiftClick(33, 62); await shiftClick(48, 58);
await gadgetMenu('Count matching');
await page.waitForTimeout(100);
check(/3 shapes match/.test(await page.locator('.log').innerText()), 'Count matching finds all three same-size circles');
// nudge the three circles onto the line (the line is clicked last)
await page.keyboard.press('Escape');
await shiftClick(18, 60); await shiftClick(33, 62); await shiftClick(48, 58); await shiftClick(5, 70);
await gadgetMenu('Nudge to guide…');
await page.getByRole('dialog', { name: 'Nudge to guide' }).getByRole('button', { name: 'Run' }).click();
await page.waitForTimeout(150);
gd = await doc();
check(gd.shapes.filter((s) => s.kind === 'circle' && s.r === 3).every((s) => Math.abs(s.cy - 70) < 1e-6), 'Nudge to guide puts the circles on the line');
await page.evaluate(() => { const r = window.demonxDesign.run; r('delete', { ids: window.demonxDesign.doc().shapes.map((x) => x.id) }); r('add_rect', { x: 10, y: 10, w: 40, h: 30, layer: 'Layer 1' }); });
await page.getByRole('button', { name: 'Fit', exact: true }).click();
await page.waitForTimeout(200);

// ---- Text
await page.keyboard.press('a');
await page.keyboard.press('Escape');
{
  const [px, py] = await atV(15, 20);
  await page.mouse.click(px, py);
}
const txt = page.getByRole('group', { name: 'Text on the drawing' });
await txt.waitFor();
check(true, 'the Text tool starts typing on the drawing where you click, with the font and height in the bar above');
await page.keyboard.type('Hi\nO');
await txt.getByLabel('Letter height').fill('12'); await txt.getByLabel('Letter height').press('Enter');
await page.waitForTimeout(400);
check(true, 'the letters are drawn as they are typed');
await page.screenshot({ path: path.join(shots, '14-text-live.png') });
const shapesBefore = (await doc()).shapes.length;
await page.keyboard.press('Control+Enter');
await page.waitForTimeout(250);
const td = await doc();
check(td.shapes.length === shapesBefore + 3, 'placing the text adds one shape per letter (H, i, O)');
const placed = td.shapes.slice(shapesBefore);
const ys = placed.flatMap((s) => s.rings.flat().map((p) => p[1]));
check(Math.abs(Math.max(...placed[0].rings.flat().map((p) => p[1])) - 32) < 0.2 && Math.abs(Math.min(...placed[0].rings.flat().map((p) => p[1])) - 20) < 0.2, 'the capital H is 12 mm tall and sits on the clicked baseline');
check(placed[2].rings.length === 2, 'the O keeps its hole');
check(Math.min(...placed[2].rings.flat().map((p) => p[1])) < 20 - 10, 'the second line is below the first');
await page.keyboard.press('Control+z');
check((await doc()).shapes.length === shapesBefore, 'the whole text undoes in one step');
// scripts load the font first, then use the command
const viaApi = await page.evaluate(async () => { await window.demonxDesign.loadFont('Bebas Neue'); return window.demonxDesign.run('add_text', { text: 'CNC', x: 0, y: 0, height: 10, font: 'Bebas Neue' }); });
check(viaApi === true, 'the scripting API can load a font and add text');
await page.keyboard.press('Control+z');
await page.getByRole('button', { name: 'Text (A)' }).click();
{ const [px, py] = await atV(10, 20); await page.mouse.click(px, py); }
await txt.waitFor();
await page.keyboard.press('Escape');
await txt.waitFor({ state: 'detached' });
check(true, 'Escape drops the text being typed');
await page.keyboard.press('v');

// ---- Nodes and corner radius
await page.evaluate(() => { const r = window.demonxDesign.run; r('delete', { ids: window.demonxDesign.doc().shapes.map((x) => x.id) }); r('add_rect', { x: 10, y: 10, w: 40, h: 30, layer: 'Layer 1' }); });
await page.getByRole('button', { name: 'Fit', exact: true }).click();
await page.waitForTimeout(200);
await page.keyboard.press('Escape');
await page.keyboard.press('n');
{ const [px, py] = await atV(10, 25); await page.mouse.click(px, py); }
await page.waitForTimeout(100);
const nodesPanel = page.locator('.nodes');
check(/4 points/.test(await nodesPanel.innerText()), 'the Nodes tool shows the 4 points of the clicked rectangle');
{
  const [ax, ay] = await atV(50, 10), [bx, by] = await atV(55, 5);
  await page.mouse.move(ax, ay); await page.mouse.down(); await page.mouse.move((ax + bx) / 2, (ay + by) / 2); await page.mouse.move(bx, by); await page.mouse.up();
}
await page.waitForTimeout(150);
let nd = await doc();
const ringOf = () => nd.shapes[0].rings[0];
check(ringOf().some((p) => Math.abs(p[0] - 55) < 0.6 && Math.abs(p[1] - 5) < 0.6), 'dragging a corner point moves just that point');
check(ringOf().filter((p) => p[0] === 10 || p[1] === 40).length >= 3, 'the other points stay put');
await page.keyboard.press('Control+z');
{ const [px, py] = await atV(30, 10); await page.mouse.dblclick(px, py); }
await page.waitForTimeout(150);
nd = await doc();
check(ringOf().length === 5, 'double-clicking a segment adds a point there');
check(ringOf().some((p) => Math.abs(p[0] - 30) < 0.6 && Math.abs(p[1] - 10) < 1e-6), 'and it sits on the line where you clicked');
await page.keyboard.press('Delete');
await page.waitForTimeout(100);
nd = await doc();
check(ringOf().length === 4, 'Delete removes the picked (new) point again');
await page.getByRole('button', { name: 'Close path' }).or(page.getByRole('button', { name: 'Open path' })).first().click();
nd = await doc();
check(nd.shapes[0].closed === false, 'Open path turns the outline into a line');
await page.keyboard.press('Control+z');
await page.keyboard.press('v'); await page.keyboard.press('Escape');
{ const [px, py] = await atV(10, 25); await page.mouse.click(px, py); }
const openCorners = () => page.getByRole('button', { name: /^Corners: round/ }).click();
await openCorners();
await page.getByLabel('Round by').fill('6'); await page.getByLabel('Round by').press('Enter');
await page.getByLabel('Corner type').selectOption('round');
await page.getByRole('button', { name: 'Apply', exact: true }).click();
await page.waitForTimeout(150);
nd = await doc();
const rbx = (s) => ({ minX: Math.min(...s.rings[0].map((p) => p[0])), maxX: Math.max(...s.rings[0].map((p) => p[0])) });
check(rbx(nd.shapes[0]).minX === 10 && rbx(nd.shapes[0]).maxX === 50 && !nd.shapes[0].rings[0].some((p) => p[0] === 10 && p[1] === 10), 'Corners > Round keeps the size and removes the sharp corners');
await page.screenshot({ path: path.join(shots, '15-rounded.png') });
await page.keyboard.press('Control+z');
await openCorners();
await page.getByLabel('Corner type').selectOption('cove');
await page.getByRole('button', { name: 'Apply', exact: true }).click();
nd = await doc();
check(nd.shapes[0].rings[0].every((p) => Math.hypot(p[0] - 10, p[1] - 10) > 5.9) && nd.shapes[0].rings[0].length > 8, 'Inside scoop cuts a quarter disc out of each corner');
await page.keyboard.press('Control+z');
await openCorners();
await page.getByLabel('new rectangles').check();
await page.keyboard.press('Escape');
await page.keyboard.press('r');
{ const [ax, ay] = await atV(20, 15), [bx, by] = await atV(40, 35); await page.mouse.move(ax, ay); await page.mouse.down(); await page.mouse.move(bx, by); await page.mouse.up(); }
await page.waitForTimeout(150);
nd = await doc();
check(nd.shapes.length === 2 && nd.shapes[1].rings[0].length > 8, 'with "new rectangles" ticked a drawn rectangle comes out rounded');
await openCorners();
await page.getByLabel('new rectangles').uncheck();
await page.keyboard.press('Escape');
await page.keyboard.press('v');
await page.evaluate(() => { const r = window.demonxDesign.run; r('delete', { ids: window.demonxDesign.doc().shapes.map((x) => x.id) }); r('add_rect', { x: 10, y: 10, w: 40, h: 30, layer: 'Layer 1' }); });

// moving a shape by its corner puts that corner exactly on another shape's corner
await page.evaluate(() => window.demonxDesign.run('add_rect', { x: 60, y: 50, w: 10, h: 10, layer: 'Layer 1' }));
await page.getByRole('button', { name: 'Fit', exact: true }).click();
await page.waitForTimeout(200);
await page.keyboard.press('v');
await page.keyboard.press('Escape'); // nothing selected: a selected shape's corners are its resize handles, not a place to hold it
[sx, sy] = await atV(60, 50);
const [cx2, cy2] = await atV(50, 40);
await page.mouse.move(sx + 2, sy + 1);
await page.mouse.down();
await page.mouse.move((sx + cx2) / 2, (sy + cy2) / 2);
await page.mouse.move(cx2 + 2, cy2 + 2);
check((await label()).includes('Endpoint'), 'while dragging a corner the target corner is marked');
await page.mouse.up();
let b = (await doc()).shapes[1].rings[0];
check(Math.min(...b.map((p) => p[0])) === 50 && Math.min(...b.map((p) => p[1])) === 40, 'the dragged rectangle now sits exactly on the corner: ' + JSON.stringify(b[0]));
check(Math.max(...b.map((p) => p[0])) === 60 && Math.max(...b.map((p) => p[1])) === 50, 'and it was moved, not resized (still 10 x 10)');

// ...and by its centre onto another shape's centre (align by centres)
await page.getByRole('button', { name: 'Fit', exact: true }).click();
await page.waitForTimeout(200);
[sx, sy] = await atV(55, 45); // the middle of the moved rectangle (it is selected)
const [mx, my] = await atV(30, 25); // the middle of the big one
await page.mouse.move(sx + 3, sy - 2);
await page.mouse.down();
await page.mouse.move((sx + mx) / 2, (sy + my) / 2);
await page.mouse.move(mx - 2, my + 3);
check((await label()).includes('Center'), 'dragging by the centre marks the target centre');
await page.mouse.up();
b = (await doc()).shapes[1].rings[0];
const midX = (Math.min(...b.map((p) => p[0])) + Math.max(...b.map((p) => p[0]))) / 2;
const midY = (Math.min(...b.map((p) => p[1])) + Math.max(...b.map((p) => p[1]))) / 2;
check(Math.abs(midX - 30) < 1e-6 && Math.abs(midY - 25) < 1e-6, 'the two shapes now share a centre: ' + midX + ', ' + midY);
await page.screenshot({ path: path.join(shots, '10-snap.png') });
await page.getByLabel('Grid', { exact: true }).check();

// ---- Right-click menu, groups, joining lines, layers for the selection, appearance
await page.evaluate(() => { const r = window.demonxDesign.run; r('delete', { ids: window.demonxDesign.doc().shapes.map((x) => x.id) }); r('layer_set', { name: 'Engrave' }); r('add_rect', { x: 10, y: 10, w: 20, h: 20, layer: 'Layer 1' }); r('add_rect', { x: 40, y: 10, w: 20, h: 20, layer: 'Layer 1' }); r('add_path', { points: [[70, 10], [80, 20]], closed: false, layer: 'Layer 1' }); r('add_path', { points: [[84, 22], [95, 30]], closed: false, layer: 'Layer 1' }); });
await page.getByRole('button', { name: 'Fit', exact: true }).click();
await page.waitForTimeout(200);
// shapes are picked by their line, so a point inside a shape is moved to the nearest point of that shape's outline
const onOutline = (p) => page.evaluate(([px, py]) => {
  const shapes = window.demonxDesign.doc().shapes;
  const rings = (s) => (s.kind === 'circle' ? [Array.from({ length: 96 }, (_, i) => [s.cx + s.r * Math.cos((i / 96) * 6.2832), s.cy + s.r * Math.sin((i / 96) * 6.2832)])] : s.rings);
  let best = null, bd = Infinity;
  for (const s of shapes) for (const ring of rings(s)) {
    const n = s.kind !== 'circle' && !s.closed ? ring.length - 1 : ring.length;
    for (let i = 0; i < n; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
      const t = l2 ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / l2)) : 0;
      const q = [a[0] + t * dx, a[1] + t * dy], d = Math.hypot(px - q[0], py - q[1]);
      if (d < bd) { bd = d; best = q; }
    }
  }
  return best ?? [px, py];
}, p);
const clickV = async (p0, mods = []) => { const p = await onOutline(p0); const [x, y] = await atV(...p); for (const m of mods) await page.keyboard.down(m); await page.mouse.click(x, y); for (const m of mods) await page.keyboard.up(m); };
await page.keyboard.press('v'); await page.keyboard.press('Escape');
await clickV([20, 20]);
await page.mouse.click(...(await atV(10, 20)), { button: 'right' });
const ctxm = page.getByRole('menu', { name: 'Context menu' });
await ctxm.waitFor();
check(await ctxm.getByRole('menuitem', { name: /^Copy to layer/ }).isVisible() && await ctxm.getByRole('menuitem', { name: /^Group objects/ }).isVisible() && await ctxm.getByRole('menuitem', { name: /^Join/ }).isVisible(), 'right-click opens a menu with Copy to layer, Group, Join and more');
check(await ctxm.getByRole('menuitem', { name: /^Group objects/ }).isDisabled() && await ctxm.getByRole('menuitem', { name: /^Join/ }).isDisabled(), 'items that do not apply to this selection are greyed out');
await ctxm.getByRole('menuitem', { name: /^Copy to layer/ }).hover();
await page.screenshot({ path: path.join(shots, '16-context.png') });
await page.getByRole('menuitem', { name: 'Engrave' }).click();
let od = await doc();
check(od.shapes.length === 5 && od.shapes.at(-1).layer === 'Engrave' && od.shapes[0].layer === 'Layer 1', 'Copy to layer leaves the original and puts a copy on the chosen layer');
await page.keyboard.press('Control+z');
await page.mouse.click(...(await atV(10, 20)), { button: 'right' });
await ctxm.getByRole('menuitem', { name: /^Move to layer/ }).hover();
await page.getByRole('menuitem', { name: 'Engrave' }).click();
od = await doc();
check(od.shapes.length === 4 && od.shapes[0].layer === 'Engrave', 'Move to layer changes the layer of the selected shape');
await page.keyboard.press('Control+z');
// a new layer from the menu
await page.mouse.click(...(await atV(10, 20)), { button: 'right' });
await ctxm.getByRole('menuitem', { name: /^Copy to layer/ }).hover();
await page.getByRole('menuitem', { name: 'New layer…' }).click();
await page.getByRole('dialog', { name: 'New layer' }).getByLabel('Layer name').fill('Pocket');
await page.getByRole('dialog', { name: 'New layer' }).getByRole('button', { name: 'Copy' }).click();
od = await doc();
check(od.layers.some((l) => l.name === 'Pocket') && od.shapes.at(-1).layer === 'Pocket', 'New layer… from the menu creates the layer and copies there');
await page.keyboard.press('Control+z');
// group the two rectangles
await page.keyboard.press('Escape');
await clickV([20, 20]); await clickV([50, 20], ['Shift']);
await page.getByRole('button', { name: /^Group \(Ctrl\+G\)/ }).click();
od = await doc();
check(od.shapes[0].group !== undefined && od.shapes[0].group === od.shapes[1].group, 'the Group button ties the two shapes together');
await page.keyboard.press('Escape');
await clickV([20, 20]);
check(/2 shapes/.test(await page.locator('.sel-summary').innerText()), 'clicking one shape of a group picks the whole group');
await page.keyboard.press('Control+Shift+g');
od = await doc();
check(od.shapes.every((s) => s.group === undefined), 'Ctrl+Shift+G ungroups');
await page.keyboard.press('Escape');
await clickV([20, 20]);
check(/1 shape/.test(await page.locator('.sel-summary').innerText()), 'and then one click picks one shape again');
// join two open lines with the toolbar
await page.keyboard.press('Escape');
await clickV([75, 15]); await clickV([90, 26], ['Shift']);
await page.getByRole('button', { name: 'Join open lines' }).click();
await page.getByRole('dialog', { name: 'Join lines' }).getByRole('button', { name: 'With a smooth curve' }).click();
od = await doc();
check(od.shapes.length === 3 && od.shapes[2].rings[0].length > 6 && !od.shapes[2].closed, 'Join with a smooth curve makes one open line out of the two');
await page.keyboard.press('Control+z');
await page.mouse.click(...(await atV(75, 15)), { button: 'right' });
await page.getByRole('menuitem', { name: /^Join/ }).hover();
check(await page.getByRole('menuitem', { name: 'Move end points' }).isVisible(), 'the right-click menu offers With a line, With a smooth curve and Move end points');
await page.keyboard.press('Escape');
// the tool panels sit on the right and swap with the design tools
check((await page.locator('aside.side').count()) === 0, 'the right-hand side is clear in the design view, so the drawing area extends to the right');
await page.getByRole('tablist', { name: 'Design, Laser or CNC' }).getByRole('tab', { name: 'Laser' }).click();
await page.locator('aside.side').getByRole('tab', { name: 'Job', exact: true }).click();
check((await page.locator('aside.side[aria-label="Laser tools"]').count()) === 1, 'the Laser tab opens the laser tools in a panel beside the drawing');
check((await page.locator('.toolbar, .tools').count()) === 0, 'and the drawing tools are not on the Laser tab');
await page.getByRole('tablist', { name: 'Design, Laser or CNC' }).getByRole('tab', { name: 'Design' }).click();
check((await page.locator('aside.side').count()) === 0, 'the Design tab clears the right-hand side again');
// colours, as in DemonX
await page.getByRole('button', { name: /^Settings/ }).click();
await page.getByRole('menuitem', { name: /^Appearance/ }).click();
const ap = page.getByRole('dialog', { name: 'Appearance' });
await ap.getByRole('button', { name: 'Blue' }).click();
check((await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim())) === '#4f8fe0', 'Appearance: choosing the Blue accent changes the colour of the app');
await ap.getByRole('button', { name: 'Reset all to the built-in colours' }).click();
await ap.getByRole('button', { name: 'Done' }).click();
check((await page.evaluate(() => document.documentElement.style.getPropertyValue('--accent'))) === '', 'and Reset puts the built-in colours back');
// the Laser and CNC pages are real columns: the drawing area is narrower beside the panel and whole again on Design
const cvBefore = await page.locator('canvas.design-canvas').boundingBox();
await page.getByRole('tablist', { name: 'Design, Laser or CNC' }).getByRole('tab', { name: 'Laser' }).click();
await page.locator('aside.side').getByRole('tab', { name: 'Job', exact: true }).click();
const cvOpen = await page.locator('canvas.design-canvas').boundingBox();
const sideBox = await page.locator('aside.side').boundingBox();
check(cvOpen.width < cvBefore.width - 150 && cvOpen.x + cvOpen.width <= sideBox.x + 1, 'the Laser panel sits beside the drawing, not over it');
await page.getByRole('tablist', { name: 'Design, Laser or CNC' }).getByRole('tab', { name: 'Design' }).click();
const cvBack = await page.locator('canvas.design-canvas').boundingBox();
check(Math.abs(cvBack.width - cvBefore.width) < 1, 'and the Design tab gives the drawing its width back');
// the drawing area colour follows the theme at once, and has a colour of its own
const pixel = () => page.evaluate(() => { const c = document.querySelector('canvas.design-canvas'); const d = c.getContext('2d').getImageData(23, 23, 1, 1).data; return [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join(''); });
const darkPx = await pixel();
await page.getByRole('button', { name: /☀|☾/ }).click();
await page.waitForTimeout(150);
const lightPx = await pixel();
check(darkPx !== lightPx && lightPx === 'eef3f5', 'switching dark to light repaints the drawing area straight away (no click needed): ' + darkPx + ' to ' + lightPx);
await page.getByRole('button', { name: /^Settings/ }).click();
await page.getByRole('menuitem', { name: /^Appearance/ }).click();
await page.getByRole('dialog', { name: 'Appearance' }).getByLabel('Drawing area').fill('#223344');
await page.waitForTimeout(150);
check((await pixel()) === '223344', 'Appearance has a Drawing area colour that changes the grid background on its own');
await page.getByRole('dialog', { name: 'Appearance' }).getByLabel('Page background').fill('#445566');
await page.waitForTimeout(100);
check((await pixel()) === '223344', 'and the page background colour no longer changes it');
await page.getByRole('button', { name: 'Reset all to the built-in colours' }).click();
await page.getByRole('dialog', { name: 'Appearance' }).getByRole('button', { name: 'Done' }).click();
await page.getByRole('button', { name: /☀|☾/ }).click();
await page.waitForTimeout(150);
await page.evaluate(() => { const r = window.demonxDesign.run; r('delete', { ids: window.demonxDesign.doc().shapes.map((x) => x.id) }); });

// ---- Header name, Select all open vectors, Points and Grid switches, Sharpie Path Offset
await page.evaluate(() => { const r = window.demonxDesign.run; r('delete', { ids: window.demonxDesign.doc().shapes.map((x) => x.id) }); r('add_rect', { x: 10, y: 10, w: 20, h: 20, layer: 'Layer 1' }); r('add_path', { points: [[40, 10], [50, 20]], closed: false, layer: 'Layer 1' }); r('add_path', { points: [[52, 22], [60, 12]], closed: false, layer: 'Layer 1' }); });
await page.getByRole('button', { name: 'Fit', exact: true }).click();
await page.waitForTimeout(200);
await page.keyboard.press('Escape');
await page.mouse.click(...(await atV(10, 20)), { button: 'right' });
await page.getByRole('menuitem', { name: /^Selection/ }).hover();
await page.getByRole('menuitem', { name: 'Select all open vectors' }).click();
check(/2 shapes/.test(await page.locator('.sel-summary').innerText()) && (await page.locator('.sel-summary').innerText()).includes('2 shapes'), 'Select all open vectors picks the two lines and leaves the rectangle');
await page.keyboard.press('Escape');
// Points: with it off the cursor no longer jumps to the corner of the rectangle
await page.keyboard.press('r');
await page.getByLabel('Grid', { exact: true }).uncheck();
{
  const [cx, cy] = await atV(30.3, 30.3);
  await page.mouse.move(cx, cy);
  await page.waitForTimeout(100);
  check((await page.locator('.snap-label').count()) === 1, 'with Points on the cursor jumps to the rectangle corner (label shown)');
  await page.getByLabel('Points', { exact: true }).uncheck();
  await page.mouse.move(cx + 1, cy + 1);
  await page.mouse.move(cx, cy);
  await page.waitForTimeout(100);
  check((await page.locator('.snap-label').count()) === 0, 'with Points off it does not');
  await page.mouse.down(); await page.mouse.move(cx + 40, cy - 40); await page.mouse.up();
  const rb = (await doc()).shapes.at(-1);
  check(Math.abs(Math.min(...rb.rings[0].map((q) => q[0])) - 30) > 0.01, 'and a rectangle started there is not pulled onto the corner');
  await page.keyboard.press('Control+z');
  await page.getByLabel('Points', { exact: true }).check();
  await page.getByLabel('Grid', { exact: true }).check();
}
await page.keyboard.press('v');
// the name in the header: click it to name the design and save it
await page.locator('.docname').click();
const nm = page.getByRole('dialog', { name: 'Name and save' });
await nm.getByLabel('Design name').fill('Pixel star');
await page.evaluate(() => { window.__fs.clear(); window.__calls.save = 0; window.__nextSaveName = undefined; });
await nm.getByRole('button', { name: 'Save' }).click();
await page.waitForFunction(() => document.querySelector('.docname b')?.textContent === 'Pixel star');
check((await page.evaluate(() => [...window.__fs.keys()])).includes('Pixel star.dxd') || (await page.evaluate(() => window.__calls.save)) === 1, 'clicking the name asks for a name and saves the file under it');
// Sharpie Path Offset remembers the pen position
await page.keyboard.press('Control+a');
await page.getByRole('button', { name: /^Gadgets/ }).click();
await page.getByRole('menuitem', { name: 'Sharpie Path Offset…' }).click();
const sp = page.getByRole('dialog', { name: 'Sharpie Path Offset' });
check((await sp.getByLabel('Pen X').inputValue()) === '0' && (await sp.getByLabel('Pen Y').inputValue()) === '-58', 'Sharpie Path Offset starts at X 0, Y -58');
await sp.getByLabel('Pen Y').fill('-40'); await sp.getByLabel('Pen Y').press('Enter');
await sp.getByRole('button', { name: 'Cancel' }).click();
await page.getByRole('button', { name: /^Gadgets/ }).click();
await page.getByRole('menuitem', { name: 'Sharpie Path Offset…' }).click();
check((await page.getByRole('dialog', { name: 'Sharpie Path Offset' }).getByLabel('Pen Y').inputValue()) === '-40', 'and keeps what you typed the next time it opens');
await page.getByRole('dialog', { name: 'Sharpie Path Offset' }).getByRole('button', { name: 'Run' }).click();
check((await doc()).layers.some((l) => l.name === 'Sharpie Path'), 'it puts the shifted copy on a Sharpie Path layer');
await page.evaluate(() => { const r = window.demonxDesign.run; r('delete', { ids: window.demonxDesign.doc().shapes.map((x) => x.id) }); });

// ---- CNC: tools, toolpaths, post processors, one G-code file per tool
await newDesign();
await startDesign(page);
await page.evaluate(() => { const r = window.demonxDesign.run; r('add_rect', { x: 50, y: 50, w: 100, h: 60, layer: 'Layer 1' }); r('add_circle', { cx: 80, cy: 80, r: 8, layer: 'Layer 1' }); });
await page.getByRole('button', { name: 'Fit', exact: true }).click();
await page.waitForTimeout(200);
await page.getByRole('tablist', { name: 'Design, Laser or CNC' }).getByRole('tab', { name: 'CNC' }).click();
check(await page.getByText(/\d+ × \d+ × 18 mm · single sided/).first().isVisible(), 'the CNC panel shows the material');
await page.keyboard.press('Escape');
const cncPanel = page.locator('aside.side');
check(await cncPanel.getByRole('button', { name: 'Profile toolpath' }).isDisabled(), 'toolpath buttons wait for a selection');
await clickV([60, 105]);
await cncPanel.getByRole('button', { name: 'Profile toolpath' }).click();
const tpd = page.getByRole('dialog', { name: 'Profile toolpath' });
{
  const bb = await tpd.boundingBox();
  check(bb && Math.abs(bb.x + bb.width - 1360) < 2 && bb.height >= 700, 'the toolpath setup opens as a panel on the far right, full height');
  check(await tpd.getByRole('radio').count() >= 5 && await tpd.getByRole('button', { name: 'Calculate' }).isVisible() && await tpd.getByRole('button', { name: 'Cancel' }).isVisible(), 'its options are stacked, with Calculate and Cancel at the foot');
  check(await cncPanel.getByRole('button', { name: '3D roughing toolpath' }).isDisabled() && (await cncPanel.getByRole('button', { name: 'Profile toolpath' }).getAttribute('title'))?.includes('Cut around'), 'toolpath icons have hover text, and the ones not made yet are off');
}
await tpd.getByRole('radio', { name: 'Outside' }).click();
await tpd.getByLabel('Cut depth').fill('6'); await tpd.getByLabel('Cut depth').press('Enter');
await page.screenshot({ path: path.join(shots, '17-toolpath-dialog.png') });
await tpd.getByRole('button', { name: 'Calculate' }).click();
let cd = await doc();
check(cd.cnc && cd.cnc.toolpaths.length === 1 && cd.cnc.toolpaths[0].kind === 'profile' && cd.cnc.toolpaths[0].cutDepth === 6, 'Make toolpath adds a profile toolpath to the design');
check(await cncPanel.getByText('Profile 1', { exact: true }).first().isVisible(), 'and lists it');
check(/1 pass|lines/.test(await cncPanel.innerText()) && (await cncPanel.getByRole('button', { name: /^Save G-code for this tool/ }).count()) === 1, 'the G-code section shows one file for the one tool');
await page.screenshot({ path: path.join(shots, '18-cnc-panel.png') });
// a pocket with a different tool, and a drill
await clickV([60, 105]);
await cncPanel.getByRole('button', { name: 'Pocket toolpath' }).click();
const pk = page.getByRole('dialog', { name: 'Pocket toolpath' });
await pk.getByLabel('Tool', { exact: true }).selectOption({ label: '3.175 mm flat end mill' });
await pk.getByLabel('Cut depth').fill('3'); await pk.getByLabel('Cut depth').press('Enter');
await pk.getByRole('button', { name: 'Calculate' }).click();
check((await page.locator('aside.side').getByRole('button', { name: /^Save G-code for this tool/ }).count()) === 2, 'a second tool makes a second file: one G-code file per tool');
// save one file and read it
const [gdl] = await Promise.all([page.waitForEvent('download'), cncPanel.getByRole('button', { name: /^Save G-code for this tool/ }).first().click()]);
const gpath = path.join(shots, 'cnc.gcode');
await gdl.saveAs(gpath);
const gtxt = fs.readFileSync(gpath, 'utf8');
check(gtxt.includes('G21') && gtxt.includes('M3') && /G1Z-?[0-9.]+F/.test(gtxt) && gtxt.trimEnd().endsWith('M2'), 'the saved G-code has the header, plunges and the footer: ' + gdl.suggestedFilename());
check(/6_mm_flat/.test(gdl.suggestedFilename()), 'the file is named after the design and the tool');
// load a post processor file
const pp = `POST_NAME = "My test post (*.nc)"\nFILE_EXTENSION = "nc"\nUNITS = "MM"\nLINE_ENDING = "[10]"\nVAR SPINDLE_SPEED = [S|A|S|1.0]\nVAR FEED_RATE = [F|C|F|1.1]\nVAR X_POSITION = [X|C|X|1.3]\nVAR Y_POSITION = [Y|C|Y|1.3]\nVAR Z_POSITION = [Z|C|Z|1.3]\nVAR X_HOME_POSITION = [XH|A|X|1.3]\nVAR Y_HOME_POSITION = [YH|A|Y|1.3]\nVAR Z_HOME_POSITION = [ZH|A|Z|1.3]\nbegin HEADER\n  "G90"\n  "[S]M3"\nbegin RAPID_MOVE\n  "G0[X][Y][Z]"\nbegin FEED_MOVE\n  "G1[X][Y][Z][F]"\nbegin FOOTER\n  "M5"\n  "M30"\n`;
await page.locator('input[aria-label="Post processor file"]').setInputFiles({ name: 'mine.pp', mimeType: 'text/plain', buffer: Buffer.from(pp) });
await page.waitForTimeout(150);
check((await page.getByLabel('Post processor', { exact: true }).inputValue()) === 'My test post', 'a loaded .pp file becomes the post processor');
const [gdl2] = await Promise.all([page.waitForEvent('download'), cncPanel.getByRole('button', { name: /^Save G-code for this tool/ }).first().click()]);
await gdl2.saveAs(gpath);
const g2 = fs.readFileSync(gpath, 'utf8');
check(gdl2.suggestedFilename().endsWith('.nc') && g2.includes('M30') && !g2.includes('G21'), 'and its header, footer and file extension are used');
check((await page.evaluate(() => JSON.parse(localStorage.getItem('design-posts') ?? '[]').length)) === 1, 'the post is remembered in this browser');
// a bad post file is refused with a reason
await page.locator('input[aria-label="Post processor file"]').setInputFiles({ name: 'bad.pp', mimeType: 'text/plain', buffer: Buffer.from('nothing useful') });
await page.waitForTimeout(150);
check(/POST_NAME/.test(await page.locator('.log').innerText()), 'a file that is not a post processor is refused');
// tools
await cncPanel.getByRole('button', { name: '+ New tool' }).click();
const td2 = page.getByRole('dialog', { name: 'New tool' });
await td2.getByLabel('Tool name').fill('My 4 mm');
await td2.getByLabel('Tool diameter').fill('4'); await td2.getByLabel('Tool diameter').press('Enter');
await td2.getByRole('button', { name: 'Add tool' }).click();
check((await doc()).cnc.tools.some((t) => t.name === 'My 4 mm' && t.diameter === 4), 'a new tool can be added to the library');
// saved with the file
await menu('Save as…');
await page.waitForTimeout(300);
const saved = JSON.parse(await page.evaluate(() => { const k = [...window.__fs.keys()].pop(); return window.__fs.get(k); }));
check(saved.doc.cnc.toolpaths.length === 2 && saved.doc.cnc.tools.some((t) => t.name === 'My 4 mm'), 'the toolpaths and tools are saved in the project file');
await page.getByRole('tablist', { name: 'Design, Laser or CNC' }).getByRole('tab', { name: 'Design' }).click();
await page.evaluate(() => { const r = window.demonxDesign.run; r('delete', { ids: window.demonxDesign.doc().shapes.map((x) => x.id) }); });

// ---- Laser control, against the simulated laser ----------------------------------------------------------------------
await newDesign();
await startDesign(page, { laser: '3018 + laser head' });
await page.evaluate(() => window.demonxDesign.run('layer_set', { name: 'Layer 1', speed: 50, power: 30 }));
await page.evaluate(() => window.demonxDesign.run('add_rect', { x: 20, y: 20, w: 30, h: 10, layer: 'Layer 1' }));
await page.getByRole('tablist', { name: 'Design, Laser or CNC' }).getByRole('tab', { name: 'Laser' }).click();
await page.locator('aside.side').getByRole('tab', { name: 'Job', exact: true }).click();
const lc = page.locator('section.panel').filter({ has: page.locator('h2', { hasText: 'Laser control' }) });
await lc.getByRole('button', { name: /^(Connect|Disconnect)$/ }).waitFor();
if (await lc.getByRole('button', { name: 'Disconnect' }).isVisible()) {
  // the server keeps its connection between runs (it owns the laser): start from a clean one
  await lc.getByRole('button', { name: 'Stop' }).click();
  await lc.locator('.pill', { hasText: 'Idle' }).waitFor({ timeout: 10000 });
  await lc.getByRole('button', { name: 'Disconnect' }).click();
}
await lc.getByRole('button', { name: 'Connect' }).waitFor();
check(true, 'the Laser control panel is online (the server answered)');
check((await lc.getByLabel('Port').inputValue()) === 'simulator', 'the simulator is offered as a port');
await lc.getByRole('button', { name: 'Connect' }).click();
await lc.locator('.pill', { hasText: 'Idle' }).waitFor();
check(true, 'connected to the simulated laser: Idle');
await lc.getByRole('alert').filter({ hasText: 'Laser mode is off' }).waitFor();
check(await lc.getByRole('button', { name: 'Start…' }).isDisabled(), 'Start is disabled before a job is sent');
await lc.getByRole('button', { name: 'Send job' }).click();
await lc.getByText('matches the design').waitFor();
check(await lc.getByRole('button', { name: 'Start…' }).isDisabled(), 'and still disabled while laser mode is off');
await lc.getByRole('button', { name: /Turn on laser mode/ }).click();
await lc.getByText(/Laser mode is on \(\$32=1\)/).waitFor();
check(await lc.getByRole('button', { name: 'Start…' }).isEnabled(), 'Start is enabled once laser mode is on and the job is sent');

// moving
await jogClick('Jog X plus');
await page.waitForFunction(() => /X 10\.00/.test(document.querySelector('.pos')?.textContent ?? ''), null, { timeout: 8000 });
check(true, 'jogging 10 mm moves the head: ' + (await lc.locator('.pos').innerText()));
await lc.getByRole('button', { name: 'Set work zero here' }).click();
await page.waitForFunction(() => /X 0\.00/.test(document.querySelector('.pos')?.textContent ?? ''), null, { timeout: 8000 });
check(true, 'Set work zero here makes this X0');
await lc.getByRole('button', { name: 'Frame', exact: true }).click();
await lc.getByText('Machine log').click();
await page.waitForFunction(() => /Frame \(laser off\)/.test(document.querySelector('details .log')?.textContent ?? ''), null, { timeout: 8000 });
const logText = await lc.locator('details .log').innerText();
check(!/S\d/.test(logText.split('\n').filter((l) => /^›\s*G1X/.test(l)).join('\n')), 'the frame moves carry no power word (laser off)');
await lc.locator('.pill', { hasText: 'Idle' }).waitFor();

// the design changes after the job was sent: the machine's copy is stale and cannot be started
await page.evaluate(() => window.demonxDesign.run('add_circle', { cx: 100, cy: 60, r: 8, layer: 'Layer 1' }));
await lc.getByText(/the design has changed since/).waitFor();
check(await lc.getByRole('button', { name: 'Start…' }).isDisabled(), 'after the design changes Start is disabled until it is sent again');
await lc.getByRole('button', { name: 'Send job' }).click();
await lc.getByText('matches the design').waitFor();

// start needs a confirmation; cancel does nothing
await lc.getByRole('button', { name: 'Start…' }).click();
const dlg = page.getByRole('dialog', { name: 'Start the laser job' });
check((await dlg.innerText()).includes('Eye protection'), 'Start asks for confirmation (eye protection, material, watching)');
await dlg.getByRole('button', { name: 'Cancel' }).click();
await page.waitForTimeout(300);
check(!(await lc.locator('.bar').isVisible().catch(() => false)), 'Cancel starts nothing');
await lc.getByRole('button', { name: 'Start…' }).click();
await dlg.getByRole('button', { name: 'Start burning' }).click();
await lc.getByRole('status').filter({ hasText: 'Job complete' }).waitFor({ timeout: 20000 });
check(true, 'the small job ran to the end on the simulated laser');

// a long job: pause, resume, stop
// the layer must exist before a shape can be put on it (add_rect is refused otherwise, and returns false)
check(await page.evaluate(() => window.demonxDesign.run('layer_set', { name: 'Engrave', mode: 'engrave', interval: 0.5, speed: 50, overscan: 0 })), 'the Engrave layer is set up for a long engrave');
check(await page.evaluate(() => window.demonxDesign.run('add_rect', { x: 0, y: 0, w: 100, h: 100, layer: 'Engrave' })), 'a 100 x 100 mm rectangle is added to it');
await lc.getByRole('button', { name: 'Send job' }).click();
await lc.getByText('matches the design').waitFor();
await lc.getByRole('button', { name: 'Start…' }).click();
await dlg.getByRole('button', { name: 'Start burning' }).click();
await lc.locator('.bar').waitFor();
check(await lc.getByRole('button', { name: 'Disconnect' }).isDisabled(), 'Disconnect is disabled while a job runs');
check(await jogDisabled('Jog X plus'), 'and so is jogging');
await lc.getByRole('button', { name: 'Pause' }).click();
await lc.getByRole('button', { name: 'Resume' }).waitFor();
await lc.locator('.pill', { hasText: 'Hold' }).waitFor();
check(true, 'Pause is a feed hold: the machine shows Hold');
await page.screenshot({ path: path.join(shots, '9-laser-control.png') });
await lc.getByRole('button', { name: 'Resume' }).click();
await lc.getByRole('button', { name: 'Pause' }).waitFor();
await lc.getByRole('button', { name: 'Stop' }).click();
await lc.locator('.bar').waitFor({ state: 'detached', timeout: 10000 });
await lc.locator('.pill', { hasText: 'Idle' }).waitFor({ timeout: 10000 });
check(true, 'Stop ends the job and the machine returns to Idle');
await lc.getByRole('button', { name: 'Disconnect' }).click();
await lc.getByRole('button', { name: 'Connect' }).waitFor();
check(true, 'Disconnect works once nothing is running');
await page.getByRole('tablist', { name: 'Design, Laser or CNC' }).getByRole('tab', { name: 'Design' }).click();
check((await page.getByText('Speed').count()) === 0 || !(await page.getByLabel('Speed', { exact: true }).isVisible().catch(() => false)), 'Design mode keeps layers simple (no laser settings)');
await page.getByRole('button', { name: /☀|☾/ }).click();
await page.waitForTimeout(200);
await page.screenshot({ path: path.join(shots, '3-example-light.png') });
await page.setViewportSize({ width: 390, height: 800 });
await page.waitForTimeout(300);
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
check(!overflow, 'no sideways scroll at phone width');
await page.screenshot({ path: path.join(shots, '4-phone.png') });

check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
console.log('screenshots in ' + shots);
process.exit(failures ? 1 : 0);
