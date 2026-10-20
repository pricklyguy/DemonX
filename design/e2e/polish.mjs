// Browser check for the polish items: Diameter box for circles, Ctrl+V pastes under the pointer, a bar above Copy/Paste/Cut/Duplicate/Delete.
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
await startDesign(page, { laser: '3018 + laser head' });
const doc = () => page.evaluate(() => window.demonxDesign.doc());
const run = (id, args) => page.evaluate(([i, a]) => window.demonxDesign.run(i, a), [id, args]);
const box = await page.locator('canvas.design-canvas').boundingBox();
const atV = async (x, y) => { await page.waitForTimeout(150); const v = await page.evaluate(() => window.demonxDesignView()); return [box.x + v.w / 2 + (x - v.cx) * v.scale, box.y + v.h / 2 - (y - v.cy) * v.scale]; };
await page.getByLabel('Grid', { exact: true }).uncheck();
await page.getByLabel('Points', { exact: true }).uncheck();

// a circle shows its Diameter, and typing one resizes it
await run('add_circle', { cx: 100, cy: 80, r: 25, layer: 'Layer 1' });
await page.getByRole('button', { name: 'Fit', exact: true }).click();
await page.waitForTimeout(250);
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.keyboard.press('Control+a');
const bar = page.getByRole('group', { name: 'Selected shape' });
check(await bar.getByLabel('Diameter').inputValue() === '50', 'a circle shows its Diameter (50 for radius 25)');
check(await bar.getByLabel('Radius').count() === 0, 'and no Radius box');
await bar.getByLabel('Diameter').fill('40'); await bar.getByLabel('Diameter').press('Enter');
await page.waitForTimeout(150);
check(Math.abs((await doc()).shapes[0].r - 20) < 1e-6, 'typing 40 makes the radius 20');

// Ctrl+V pastes the copy with its middle under the pointer
await page.keyboard.press('Control+a');
await page.keyboard.press('Control+c');
const [tx, ty] = await atV(150, 40);
await page.mouse.move(tx, ty);
await page.keyboard.press('Control+v');
await page.waitForTimeout(200);
const d = await doc();
check(d.shapes.length === 2, 'Ctrl+V adds the copy');
const c = d.shapes[1];
check(Math.abs(c.cx - 150) < 0.5 && Math.abs(c.cy - 40) < 0.5, `with its centre under the pointer (150, 40): ${c.cx.toFixed(2)}, ${c.cy.toFixed(2)}`);

// the bar above Copy, Paste, Cut, Duplicate, Delete
const sep = await page.locator('.tgroup .tsep').boundingBox();
const copy = await page.getByRole('button', { name: /^Copy \(Ctrl\+C\)/ }).boundingBox();
const del = await page.getByRole('button', { name: /^Delete \(Del\)/ }).boundingBox();
const trim = await page.getByRole('button', { name: /^Trim \(T\)/ }).boundingBox();
check(sep && sep.y < copy.y && sep.y > trim.y, 'a thin bar sits above Copy, below the tools (Trim is above it)');
check(Math.abs(copy.y - del.y) < 60 && del.y >= copy.y, 'and Copy to Delete stay together just under it');
check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
await browser.close();
process.exit(failures ? 1 : 0);
