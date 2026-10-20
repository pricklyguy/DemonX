// Browser check for the Move and resize card: move by a distance (Y counts down on a laser page), resize with X and Y linked or apart, percent boxes, which point stays.
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
const box = (s) => { const pts = s.rings[0]; const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]); return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) }; };
const last = async () => box((await doc()).shapes.at(-1));
await run('add_rect', { x: 10, y: 10, w: 40, h: 20, layer: 'Layer 1' });
await page.waitForTimeout(150);
const cv = await page.locator('canvas.design-canvas').boundingBox();
await page.mouse.move(cv.x + cv.width / 2, cv.y + cv.height / 2);
await page.keyboard.press('Control+a');
await page.waitForTimeout(100);
await page.getByRole('button', { name: 'Move and resize the selection', exact: true }).click();
const M = page.getByRole('group', { name: 'Move and resize' });
await M.waitFor();
await page.waitForTimeout(150);
check((await M.getByLabel('Resize width', { exact: true }).inputValue()) === '40' && (await M.getByLabel('Resize height', { exact: true }).inputValue()) === '20', 'the card shows the size of the selection (40 by 20)');

// move: Y counts down on a laser page, so +10 goes down the page (smaller machine Y)
await M.getByLabel('Move X distance').fill('5'); await M.getByLabel('Move X distance').press('Enter');
await M.getByLabel('Move Y distance').fill('10'); await M.getByLabel('Move Y distance').press('Enter');
await M.getByRole('button', { name: 'Move the selection' }).click();
let b = await last();
check(Math.abs(b.x0 - 15) < 1e-6 && Math.abs(b.y0 - 0) < 1e-6, 'Move by 5, 10 shifts it right 5 and down the page 10: x ' + b.x0 + ', y ' + b.y0);
await M.getByRole('button', { name: 'Move the selection' }).click();
b = await last();
check(Math.abs(b.x0 - 20) < 1e-6, 'and can be pressed again: x ' + b.x0);

// resize, linked
check(await M.getByRole('button', { name: 'Link X and Y' }).getAttribute('aria-pressed') === 'true', 'X and Y are linked to start with');
await M.getByLabel('Resize width', { exact: true }).fill('80'); await M.getByLabel('Resize width', { exact: true }).press('Enter');
await page.waitForTimeout(150);
check((await M.getByLabel('Resize height', { exact: true }).inputValue()) === '40', 'linked: a width of 80 makes the height 40');
check((await M.getByLabel('Resize height percent').inputValue()) === '200', 'and both show 200 %');
await M.getByRole('button', { name: 'Apply the new size' }).click();
b = await last();
check(Math.abs(b.x1 - b.x0 - 80) < 1e-6 && Math.abs(b.y1 - b.y0 - 40) < 1e-6, 'Resize makes it 80 by 40');
check(Math.abs((b.x0 + b.x1) / 2 - 40) < 1e-6, 'about the centre by default (the centre stayed at x 40)');

// unlinked, from the top-left
await M.getByRole('button', { name: 'Link X and Y' }).click();
await M.getByRole('radio', { name: /top-left/ }).click();
const before = await last();
await M.getByLabel('Resize height', { exact: true }).fill('10'); await M.getByLabel('Resize height', { exact: true }).press('Enter');
check((await M.getByLabel('Resize width', { exact: true }).inputValue()) === '80', 'apart: changing the height leaves the width at 80');
await M.getByRole('button', { name: 'Apply the new size' }).click();
b = await last();
check(Math.abs(b.x1 - b.x0 - 80) < 1e-6 && Math.abs(b.y1 - b.y0 - 10) < 1e-6, 'Resize makes it 80 by 10');
check(Math.abs(b.x0 - before.x0) < 1e-6 && Math.abs(b.y1 - before.y1) < 1e-6, 'with the top-left corner where it was');

// percent, apart
await M.getByLabel('Resize width percent').fill('50'); await M.getByLabel('Resize width percent').press('Enter');
await page.waitForTimeout(150);
check((await M.getByLabel('Resize width', { exact: true }).inputValue()) === '40' && (await M.getByLabel('Resize height', { exact: true }).inputValue()) === '10', '50 % of the width gives 40 and leaves the height');
await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z');
check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
await browser.close();
process.exit(failures ? 1 : 0);
