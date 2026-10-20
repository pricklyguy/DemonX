// Browser check for moving the selection with the arrow keys: a step that follows the zoom, Shift for ten times, Alt for a tenth, one undo step each.
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
const pos = async () => { const s = (await doc()).shapes.at(-1); return [Math.min(...s.rings[0].map((p) => p[0])), Math.min(...s.rings[0].map((p) => p[1]))]; };
const cv = await page.locator('canvas.design-canvas').boundingBox();
await run('add_rect', { x: 100, y: 80, w: 20, h: 10, layer: 'Layer 1' });
await page.getByRole('button', { name: 'Fit', exact: true }).click();
await page.waitForTimeout(250);
await page.mouse.move(cv.x + cv.width / 2, cv.y + cv.height / 2);
await page.keyboard.press('Control+a');
await page.waitForTimeout(100);
const scale = async () => (await page.evaluate(() => window.demonxDesignView())).scale;
const s1 = await scale();
const step1 = (() => { const raw = 3 / s1, pow = Math.pow(10, Math.floor(Math.log10(raw))), m = raw / pow; return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * pow; })();
let [x0, y0] = await pos();
await page.keyboard.press('ArrowRight');
let [x1, y1] = await pos();
check(Math.abs(x1 - x0 - step1) < 1e-6 && Math.abs(y1 - y0) < 1e-6, `Right moves it ${step1} mm (about 3 screen pixels at this zoom): ${(x1 - x0).toFixed(3)}`);
await page.keyboard.press('ArrowUp');
let [x2, y2] = await pos();
check(Math.abs(y2 - y1 - step1) < 1e-6 && Math.abs(x2 - x1) < 1e-6, 'Up moves it up the drawing by the same step');
await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowDown');
[x2, y2] = await pos();
check(Math.abs(x2 - x0) < 1e-6 && Math.abs(y2 - y0) < 1e-6, 'Left and Down take it back');
await page.keyboard.press('Shift+ArrowRight');
[x1] = await pos();
check(Math.abs(x1 - x0 - step1 * 10) < 1e-6, 'Shift is ten times the step: ' + (x1 - x0).toFixed(3));
await page.keyboard.press('Alt+ArrowLeft');
[x2] = await pos();
check(Math.abs(x1 - x2 - step1 / 10) < 1e-6, 'Alt is a tenth of the step: ' + (x1 - x2).toFixed(4));
await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z');
[x2] = await pos();
check(Math.abs(x2 - x0) < 1e-6, 'undo takes back the two moves, one key press each');

// zoomed in, the step is smaller
for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -300);
await page.waitForTimeout(300);
const s2 = await scale();
const [xa] = await pos();
await page.keyboard.press('ArrowRight');
const [xb] = await pos();
check(s2 > s1 * 2 && (xb - xa) < step1 && (xb - xa) > 0, `zoomed in (${(s2 / s1).toFixed(1)}x) one press moves less: ${(xb - xa).toFixed(3)} mm`);

// not while typing in a box
await page.getByLabel('Width', { exact: true }).focus();
const [xc] = await pos();
await page.keyboard.press('ArrowRight');
check(Math.abs((await pos())[0] - xc) < 1e-9, 'arrow keys in a number box do not move the shape');
// nothing picked: nothing moves
await page.getByLabel('Width', { exact: true }).blur();
await page.mouse.click(cv.x + cv.width - 60, cv.y + cv.height - 60);
await page.waitForTimeout(100);
const [xd] = await pos();
await page.keyboard.press('ArrowRight');
check(Math.abs((await pos())[0] - xd) < 1e-9, 'with nothing picked, the arrow keys do nothing');
check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
await browser.close();
process.exit(failures ? 1 : 0);
