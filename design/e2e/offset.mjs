// Browser check for offset (radio buttons, movable card), selecting a shape inside another, and the top-left defaults.
// Any fresh server.
//
//   cd design && npm run build && npm run serve &       (any fresh server)
//   node e2e/offset.mjs
//
// Stop the server by its port when done (fuser -k 8090/tcp), not with pkill -f.
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
const shots = process.env.SHOTS ?? fs.mkdtempSync(path.join(os.tmpdir(), 'design-offset-'));
let failures = 0;
const check = (ok, what) => { console.log((ok ? 'PASS ' : 'FAIL ') + what); if (!ok) failures++; };

const browser = await chromium.launch({ ...(chromiumPath ? { executablePath: chromiumPath } : {}) });
const page = await (await browser.newContext({ viewport: { width: 1360, height: 900 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(URL_BASE);
await page.waitForSelector('canvas.design-canvas');
const doc = () => page.evaluate(() => window.demonxDesign.doc());
const run = (id, args) => page.evaluate(([i, a]) => window.demonxDesign.run(i, a), [id, args]);
await startDesign(page);

// a square, offset outwards by 20 mm with square corners, original kept
await run('add_rect', { x: 100, y: 100, w: 300, h: 350, layer: 'Layer 1' });
const canvas = page.locator('canvas.design-canvas');
const box = await canvas.boundingBox();
await page.evaluate(() => window.demonxDesign.run('select', { ids: window.demonxDesign.doc().shapes.map((s) => s.id) })).catch(() => {});
if (!(await page.evaluate(() => window.demonxDesign.selection().length))) { await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2); await page.keyboard.press('Control+a'); }
await page.getByRole('button', { name: 'Offset: grow or shrink' }).click();
const card = page.getByRole('dialog', { name: 'Offset' });
check(await card.getByRole('radio', { name: 'Outward' }).isChecked() && await card.getByRole('radio', { name: 'Round' }).isChecked(), 'the Offset card has radio buttons, Outward and Round to start with');
await card.getByRole('radio', { name: 'Square', exact: true }).check();
await card.getByLabel('Offset distance').fill('20'); await card.getByLabel('Offset distance').press('Enter');
// move the card by its title
const before = await card.boundingBox();
await card.getByRole('heading', { name: 'Offset' }).hover();
await page.mouse.down(); await page.mouse.move(before.x + 160, before.y + 90, { steps: 4 }); await page.mouse.up();
const after = await card.boundingBox();
check(Math.abs(after.x - before.x) > 20 || Math.abs(after.y - before.y) > 20, 'the Offset card can be dragged by its title');
await card.getByRole('button', { name: 'OK', exact: true }).click();
let d = await doc();
check(d.shapes.length === 2, 'offset keeps the original and adds the new shape');

// the inner (original) shape can still be picked: click on its line
await page.keyboard.press('Escape');
const v = await page.evaluate(() => window.demonxDesignView());
const wx = 100, wy = 275; // the middle of the inner square's left side
const pt = [box.x + v.w / 2 + (wx - v.cx) * v.scale, box.y + v.h / 2 - (wy - v.cy) * v.scale];
{
  await page.mouse.click(pt[0], pt[1]);
  const sel = await page.evaluate(() => window.demonxDesign.selection());
  check(sel.length === 1 && sel[0] === d.shapes[0].id, 'a click on the inner shape\'s line selects the inner shape, not the outer one');
}
// a shape inside another: a drag that starts in the empty space inside the outer shape is a selection box, not a move
const scr = (wx, wy) => [box.x + v.w / 2 + (wx - v.cx) * v.scale, box.y + v.h / 2 - (wy - v.cy) * v.scale];
const drag = async (a, b) => { const [x0, y0] = scr(...a), [x1, y1] = scr(...b); await page.mouse.move(x0, y0); await page.mouse.down(); await page.mouse.move((x0 + x1) / 2, (y0 + y1) / 2, { steps: 3 }); await page.mouse.move(x1, y1, { steps: 3 }); await page.mouse.up(); };
const bounds = async () => (await doc()).shapes.map((s) => JSON.stringify(s.rings));
const unmoved = await bounds();
await page.keyboard.press('Escape');
await drag([60, 60], [440, 490]);   // from outside both, across everything
check((await page.evaluate(() => window.demonxDesign.selection())).length === 2, 'a selection box across everything selects the outer shape and the one inside it');
await page.keyboard.press('Escape');
await drag([90, 90], [410, 460]);   // boxes in the inner shape only
const only = await page.evaluate(() => window.demonxDesign.selection());
check(only.length === 1 && only[0] === d.shapes[0].id, 'a box that holds only the inner shape selects just that one');
await page.keyboard.press('Escape');
await drag([150, 150], [250, 250]); // starts in the empty inside of both shapes
check(JSON.stringify(await bounds()) === JSON.stringify(unmoved), 'a drag that starts inside the empty space moves nothing');
// clicking in empty space (even inside a shape) selects nothing; a shape is picked by its line
await page.keyboard.press('Escape');
{ const [x, y] = scr(150, 150); await page.mouse.click(x, y); }
check((await page.evaluate(() => window.demonxDesign.selection())).length === 0, 'a click in the empty space inside a shape selects nothing');
{ const [x, y] = scr(100, 275); await page.mouse.click(x, y); }
check((await page.evaluate(() => window.demonxDesign.selection())).length === 1, 'a click on a line picks that shape');
{ const [x, y] = scr(150, 150); await page.mouse.click(x, y); }
check((await page.evaluate(() => window.demonxDesign.selection())).length === 0, 'and a click in empty space clears the selection again');
// Ctrl+click adds to the selection (and takes a shape out again), like Shift+click
{ const [x, y] = scr(100, 275); await page.mouse.click(x, y); }
{ const [x, y] = scr(80, 275); await page.keyboard.down('Control'); await page.mouse.click(x, y); await page.keyboard.up('Control'); }
check((await page.evaluate(() => window.demonxDesign.selection())).length === 2, 'Ctrl+click adds a second shape to the selection');
{ const [x, y] = scr(80, 200); await page.keyboard.down('Control'); await page.mouse.click(x, y); await page.keyboard.up('Control'); }
check((await page.evaluate(() => window.demonxDesign.selection())).length === 1, 'and Ctrl+click on a picked shape takes it out again');
check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
await browser.close();
console.log('screenshots in ' + shots);
process.exit(failures ? 1 : 0);
