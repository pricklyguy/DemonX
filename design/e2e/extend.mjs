// Browser check for Extend: two open lines pulled out to where they meet, then Join and Corners round the corner.
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
const cv = await page.locator('canvas.design-canvas').boundingBox();
const btn = page.getByRole('button', { name: /^Extend two open lines/ });
await run('add_path', { points: [[50, 50], [80, 50]], closed: false, layer: 'Layer 1' });
await run('add_path', { points: [[100, 100], [100, 70]], closed: false, layer: 'Layer 1' });
await page.waitForTimeout(200);
await page.mouse.move(cv.x + cv.width / 2, cv.y + cv.height / 2);
await page.keyboard.press('Control+a');
await page.waitForTimeout(100);
check(await btn.isEnabled(), 'Extend is on with two open lines picked');
await btn.click();
await page.waitForTimeout(150);
let d = await doc();
check(JSON.stringify(d.shapes[0].rings[0][1]) === '[100,50]' && JSON.stringify(d.shapes[1].rings[0][1]) === '[100,50]', 'both lines now end at the corner (100, 50)');
// the corner can be joined and rounded with the tools that were already there
await page.getByRole('button', { name: /^Join open lines/ }).click();
await page.getByRole('button', { name: 'Move end points' }).click();
await page.waitForTimeout(150);
d = await doc();
check(d.shapes.length === 1 && d.shapes[0].rings[0].length >= 3, 'Join makes them one line with a corner: ' + d.shapes[0].rings[0].length + ' points');
await run('add_rect', { x: 0, y: 0, w: 5, h: 5, layer: 'Layer 1' });
await page.keyboard.press('Control+a');
check(await btn.isDisabled(), 'Extend is off for anything but two open lines');
check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
await browser.close();
process.exit(failures ? 1 : 0);
