// Browser check for the right-click menu: it opens at the cursor, and the sub-menus can be reached without crossing the wrong one
// (coming down from Copy to layer to Move to layer must move, not copy). Any fresh server.
//
//   cd design && npm run build && npm run serve &
//   node e2e/menu.mjs
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
const shots = process.env.SHOTS ?? fs.mkdtempSync(path.join(os.tmpdir(), 'design-menu-'));
let failures = 0;
const check = (ok, what) => { console.log((ok ? 'PASS ' : 'FAIL ') + what); if (!ok) failures++; };

const browser = await chromium.launch({ ...(chromiumPath ? { executablePath: chromiumPath } : {}) });
const page = await (await browser.newContext({ viewport: { width: 1360, height: 820 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(URL_BASE);
await page.waitForSelector('canvas.design-canvas');
await startDesign(page);
const doc = () => page.evaluate(() => window.demonxDesign.doc());
await page.evaluate(() => { const r = window.demonxDesign.run; r('layer_set', { name: 'Cut' }); r('layer_set', { name: 'Engrave' }); r('add_rect', { x: 20, y: 20, w: 60, h: 40, layer: 'Layer 1' }); });
await page.getByRole('button', { name: 'Fit', exact: true }).click();
await page.waitForTimeout(200);
const box = await page.locator('canvas.design-canvas').boundingBox();
const v = await page.evaluate(() => window.demonxDesignView());
const at = (x, y) => [box.x + v.w / 2 + (x - v.cx) * v.scale, box.y + v.h / 2 - (y - v.cy) * v.scale];

// the shape is picked by its line, then right-click on that line
const [lx, ly] = at(20, 40);
await page.mouse.click(lx, ly);
await page.mouse.click(lx, ly, { button: 'right' });
const menu = page.getByRole('menu', { name: 'Context menu' });
await menu.waitFor();
const mb = await menu.boundingBox();
check(Math.abs(mb.x - lx) < 6 && (Math.abs(mb.y - ly) < 6 || Math.abs(mb.y + mb.height - ly) < 6), 'the menu opens at the cursor (below it, or above it when it does not fit)');

// Copy to layer, then down to Move to layer, straight to its right edge, then across into its list
const copyItem = menu.getByRole('menuitem', { name: /^Copy to layer/ });
const moveItem = menu.getByRole('menuitem', { name: /^Move to layer/ });
await copyItem.hover();
await menu.getByRole('menu', { name: /^Copy to layer/ }).waitFor();
const mv = await moveItem.boundingBox();
await page.mouse.move(mv.x + mv.width - 2, mv.y + mv.height / 2, { steps: 6 });
await page.getByRole('menu', { name: /^Move to layer/ }).waitFor({ timeout: 2000 });
check((await moveItem.getAttribute('aria-expanded')) === 'true' && (await copyItem.getAttribute('aria-expanded')) === 'false', 'coming down from Copy to Move swaps the list, and the item that owns the open list is the one marked');
const sub = page.getByRole('menu', { name: /^Move to layer/ });
const sb = await sub.boundingBox();
await page.mouse.move(sb.x + 30, mv.y + mv.height / 2, { steps: 6 });
await sub.getByRole('menuitem', { name: 'Cut', exact: true }).click();
const d = await doc();
check(d.shapes.length === 1 && d.shapes[0].layer === 'Cut', 'choosing Cut moved the shape (still one shape, now on Cut), it did not copy it');
check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
await browser.close();
console.log('screenshots in ' + shots);
process.exit(failures ? 1 : 0);
