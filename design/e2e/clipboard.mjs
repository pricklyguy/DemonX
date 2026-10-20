// Browser check for copy and paste between two tabs of one browser: copy in one, paste in the other (a different design).
//
//   cd design && npm run build
//   DESIGN_DATA=$(mktemp -d) npm run serve &      (any fresh server)
//   node e2e/clipboard.mjs
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
const ctx = await browser.newContext({ viewport: { width: 1360, height: 820 } });
const errors = [];
const open = async () => {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL_BASE);
  await page.waitForSelector('canvas.design-canvas');
  await startDesign(page, { laser: '3018 + laser head' });
  return page;
};
const a = await open();
const b = await open();
const shapes = (p) => p.evaluate(() => window.demonxDesign.doc().shapes.map((s) => ({ layer: s.layer, kind: s.kind })));

await a.bringToFront();
await a.evaluate(() => { window.demonxDesign.run('layer_set', { name: 'Logo', create: true, color: '#ff0000' }); window.demonxDesign.run('add_rect', { x: 10, y: 20, w: 30, h: 15, layer: 'Logo' }); });
check((await shapes(a)).length === 1, 'the first tab has one shape on layer Logo');
// copy through the real keyboard shortcuts: click empty space, select all, copy
await a.locator('canvas.design-canvas').click({ position: { x: 5, y: 5 } });
await a.keyboard.press('Control+a');
await a.keyboard.press('Control+c');
await a.waitForTimeout(200);
check((await a.evaluate(() => window.demonxDesign.selection().length)) === 1, 'Ctrl+A selected the shape');

await b.bringToFront();
await b.locator('canvas.design-canvas').click({ position: { x: 5, y: 5 } });
await b.mouse.move(5, 5);   // the pointer is off the drawing, so the paste keeps its place (with the pointer over it, it goes under the pointer: e2e/polish.mjs)
await b.keyboard.press('Control+v');
await b.waitForTimeout(300);
const got = await shapes(b);
check(got.length === 1 && got[0].layer === 'Logo', 'pasting in the other tab brings the shape with its layer: ' + JSON.stringify(got));
const x0 = async (p, i) => p.evaluate((k) => { const s = window.demonxDesign.doc().shapes[k]; const xs = s.rings.flat().map((q) => q[0]); return Math.min(...xs); }, i);
check(Math.abs((await x0(b, 0)) - 10) < 0.01, 'the first paste lands where it was copied');
await b.mouse.move(5, 5);   // the pointer is off the drawing, so the paste keeps its place (with the pointer over it, it goes under the pointer: e2e/polish.mjs)
await b.keyboard.press('Control+v');
await b.waitForTimeout(300);
check((await shapes(b)).length === 2 && Math.abs((await x0(b, 1)) - 15) < 0.01, 'pasting again steps the copy aside by 5 mm');
check((await shapes(a)).length === 1, 'the first tab is untouched');
// pasting in the tab that copied also steps aside
await a.bringToFront();
await a.mouse.move(5, 5);
await a.keyboard.press('Control+v');
await a.waitForTimeout(300);
check((await shapes(a)).length === 2 && Math.abs((await x0(a, 1)) - 15) < 0.01, 'in the tab that copied, the paste is stepped aside as before');
check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
await browser.close();
process.exit(failures ? 1 : 0);
