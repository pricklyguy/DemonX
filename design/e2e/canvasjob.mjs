// Browser check for a canvas job on the Laser tab (no output until it is made a laser job, the drawing kept) and for CNC sides in the Work area dialog.
//
//   cd design && npm run build
//   DESIGN_DATA=$(mktemp -d) npm run serve &      (any fresh server)
//   node e2e/shapes.mjs
//
// Stop the server by its port when done (fuser -k 8090/tcp), not with pkill -f.
import { createRequire } from 'node:module';
import fs from 'node:fs';

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
let failures = 0;
const check = (ok, what) => { console.log((ok ? 'PASS ' : 'FAIL ') + what); if (!ok) failures++; };

const browser = await chromium.launch({ ...(chromiumPath ? { executablePath: chromiumPath } : {}) });
const page = await (await browser.newContext({ viewport: { width: 1360, height: 820 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(URL_BASE);
await page.waitForSelector('canvas.design-canvas');
await startDesign(page, { type: 'canvas', width: 300, height: 180 });
const doc = () => page.evaluate(() => window.demonxDesign.doc());
await page.evaluate(() => window.demonxDesign.run('add_rect', { x: 20, y: 20, w: 40, h: 30, layer: 'Layer 1' }));
check((await doc()).workspace.kind === 'canvas', 'the design is a canvas');
await page.getByRole('tablist', { name: 'Design, Laser or CNC' }).getByRole('tab', { name: 'Laser' }).click();
const side = page.locator('aside.side');
await side.getByRole('tab', { name: 'Job', exact: true }).click();
const note = side.getByRole('group', { name: 'This design is a canvas' });
await note.waitFor();
check(true, 'the Laser tab says the design is a canvas and offers to make it a laser job (the tab is not removed)');
await page.waitForSelector('[data-jobs=ready]', { state: 'attached' });
const save = page.getByRole('button', { name: /Save G-code|Save .*gcode/i });
check(await save.count() === 0 || await save.first().isDisabled(), 'and no G-code can be saved from a canvas');
check((await page.locator('.warn').allInnerTexts()).join(' ').includes('canvas'), 'the reason is shown');
check((await doc()).shapes.length === 1, 'the drawing is untouched');
await note.getByRole('button', { name: 'Make it a laser job' }).click();
await page.waitForTimeout(300);
const d = await doc();
check(d.workspace.kind === 'laser' && d.shapes.length === 1, 'Make it a laser job converts the design and keeps its shapes: ' + d.workspace.kind + ', ' + d.workspace.width + ' x ' + d.workspace.height);
check(await note.count() === 0, 'and the notice goes away');
await page.waitForSelector('[data-jobs=ready]', { state: 'attached' });
check(await save.count() > 0 && await save.first().isEnabled(), 'now the G-code can be saved');

// a canvas makes no CNC job either, and the CNC tab offers to make it one
await page.evaluate(() => window.demonxDesign.run('workspace_set', { kind: 'canvas', width: 300, height: 180 }));
await page.getByRole('tablist', { name: 'Design, Laser or CNC' }).getByRole('tab', { name: 'CNC' }).click();
const cnc = page.locator('aside.side[aria-label="CNC tools"]');
const cncNote = cnc.getByRole('group', { name: 'This design is a canvas' });
await cncNote.waitFor();
check(true, 'the CNC tab says the design is a canvas and offers to make it a CNC job');
await page.evaluate(() => window.demonxDesign.run('select', { ids: window.demonxDesign.doc().shapes.map((s) => s.id) }));
for (const b of ['Profile toolpath', 'Pocket toolpath', 'Drill toolpath']) check(await cnc.getByRole('button', { name: b }).isDisabled(), b + ' is off for a canvas');
check((await cnc.locator('.warn').allInnerTexts()).join(' ').includes('canvas'), 'the CNC reason is shown');
await cncNote.getByRole('button', { name: 'Make it a CNC job' }).click();
await page.waitForTimeout(300);
const dc = await doc();
check(dc.workspace.kind === 'cnc' && dc.shapes.length === 1 && dc.workspace.thickness === 18, 'Make it a CNC job converts the design and keeps its shapes: ' + dc.workspace.kind + ', thickness ' + dc.workspace.thickness);
check(await cncNote.count() === 0, 'and the CNC notice goes away');
await page.getByRole('tablist', { name: 'Design, Laser or CNC' }).getByRole('tab', { name: 'Design' }).click();

// the Work area dialog keeps a CNC setup's sides
await page.getByRole('tablist', { name: 'Design, Laser or CNC' }).getByRole('tab', { name: 'Design' }).click();
await startDesign(page, { open: true, type: 'cnc', width: 800, height: 600, thickness: 18, sides: 2, save: 'Two sided' });
check((await doc()).workspace.sides === 2, 'a double sided CNC job is made');
await startDesign(page, { open: true, type: 'canvas', width: 300, height: 180 });
await page.locator('.setup-btn').click();
const wa = page.getByRole('dialog', { name: 'Job setup' });
await wa.waitFor();
await wa.getByLabel('Start from').selectOption('cnc:Two sided');
await wa.getByText('Material details for the CNC tab').click();
check(await wa.getByRole('radio', { name: 'Double sided' }).isChecked(), 'picking the saved CNC setup in the Work area dialog shows Double sided');
await wa.getByRole('button', { name: 'OK' }).click();
check((await doc()).workspace.kind === 'cnc' && (await doc()).workspace.sides === 2, 'and applying it keeps the sides: ' + (await doc()).workspace.sides);
check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
await browser.close();
process.exit(failures ? 1 : 0);
