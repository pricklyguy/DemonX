// Browser check for the Boundary card: an outline round the selected shapes (each, joined, convex), with a gap.
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
const bounds = (s) => { const p = s.rings.flat(); const xs = p.map((q) => q[0]), ys = p.map((q) => q[1]); return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) }; };
await run('add_rect', { x: 50, y: 50, w: 20, h: 20, layer: 'Layer 1' });
await run('add_rect', { x: 60, y: 60, w: 20, h: 20, layer: 'Layer 1' });
await page.waitForTimeout(200);
await page.mouse.move(cv.x + cv.width / 2, cv.y + cv.height / 2);
await page.keyboard.press('Control+a');
await page.getByRole('button', { name: /^Boundary: draw/ }).click();
const B = page.getByRole('group', { name: 'Boundary' });
await B.waitFor();
await B.getByLabel('Boundary gap').fill('5'); await B.getByLabel('Boundary gap').press('Enter');
await B.getByLabel('Boundary corners').selectOption('miter');
await B.getByRole('button', { name: 'Create' }).click();
await page.waitForTimeout(200);
let d = await doc();
check(d.shapes.length === 3, 'Create adds one outline round the two overlapping squares (3 shapes now): ' + d.shapes.length);
const b = bounds(d.shapes.at(-1));
check(Math.abs(b.x0 - 45) < 1e-6 && Math.abs(b.x1 - 85) < 1e-6 && Math.abs(b.y0 - 45) < 1e-6 && Math.abs(b.y1 - 85) < 1e-6, `it runs 5 mm out from both: ${b.x0}..${b.x1}, ${b.y0}..${b.y1}`);
await page.keyboard.press('Control+z');
check((await doc()).shapes.length === 2, 'undo takes it back in one step');
await page.mouse.move(cv.x + cv.width / 2, cv.y + cv.height / 2);
await page.keyboard.press('Control+a');
await page.getByRole('button', { name: /^Boundary: draw/ }).click();
await B.getByRole('radio', { name: /every shape/ }).check();
await B.getByRole('button', { name: 'Create' }).click();
await page.waitForTimeout(200);
check((await doc()).shapes.length === 4, 'One round every shape adds two outlines (4 shapes)');
check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
await browser.close();
process.exit(failures ? 1 : 0);
