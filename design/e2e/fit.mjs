// Browser check for Fit curves: a rough line of many points becomes a smooth curve of far fewer, corners kept.
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
const pts = [];
for (let i = 0; i < 600; i++) { const a = (i / 600) * Math.PI * 2, w = Math.sin(i * 12.9898) * 0.04; pts.push([100 + (30 + w) * Math.cos(a), 90 + (30 + w) * Math.sin(a)]); }
await run('add_path', { points: pts, closed: true, layer: 'Layer 1' });
await run('add_rect', { x: 200, y: 60, w: 40, h: 30, layer: 'Layer 1' });
await page.waitForTimeout(200);
await page.mouse.move(cv.x + cv.width / 2, cv.y + cv.height / 2);
await page.keyboard.press('Control+a');
await page.getByRole('button', { name: /^Fit curves:/ }).click();
const F = page.getByRole('group', { name: 'Fit curves' });
await F.waitFor();
await F.getByLabel('Fit tolerance').fill('0.1'); await F.getByLabel('Fit tolerance').press('Enter');
await F.getByRole('button', { name: 'Fit' }).click();
await page.waitForTimeout(250);
const d = await doc();
const n1 = d.shapes[0].rings[0].length;
check(n1 < 300 && n1 > 8, `the 600-point circle now has ${n1} points`);
check(d.shapes[0].rings[0].every((p) => Math.abs(Math.hypot(p[0] - 100, p[1] - 90) - 30) < 0.15), 'and stays within 0.15 mm of the true circle');
const sq = d.shapes[1].rings[0];
check(sq.length === 4, 'the rectangle keeps its four corners (' + sq.length + ' points)');
await page.keyboard.press('Control+z');
check((await doc()).shapes[0].rings[0].length === 600, 'undo gives the 600 points back in one step');
check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
await browser.close();
process.exit(failures ? 1 : 0);
