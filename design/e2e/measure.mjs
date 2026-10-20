// Browser check for the Measure tool: click two points or drag, snap to corners, distance / across / up / angle, Escape and Clear.
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
const M = () => page.getByRole('group', { name: 'Measure' });
const val = async (name) => (await M().getByLabel(name, { exact: true }).innerText()).trim();

await run('add_rect', { x: 50, y: 50, w: 40, h: 30, layer: 'Layer 1' });
await page.waitForTimeout(200);
await page.getByRole('navigation', { name: 'Tools' }).getByRole('button', { name: /^Measure \(M\)/ }).click();
await M().waitFor();
check(await M().getByText('Click the first point').isVisible(), 'the Measure card asks for the first point');

// click, click: bottom-left corner (50, 50) to top-right corner (90, 80), a few pixels off, so the corners are what is measured
let [x1, y1] = await atV(50, 50), [x2, y2] = await atV(90, 80);
await page.mouse.move(x1 + 3, y1 + 2); await page.mouse.click(x1 + 3, y1 + 2);
check(await M().getByText('Now click the second point').isVisible(), 'after one click it waits for the second');
await page.mouse.move(x2 - 2, y2 - 3); await page.mouse.click(x2 - 2, y2 - 3);
await page.waitForTimeout(150);
check((await val('Distance')) === '50.000 mm', 'distance 50 mm (3-4-5 corners): ' + await val('Distance'));
check((await val('Across')) === '40.000 mm', 'across 40: ' + await val('Across'));
check((await val('Up')) === '-30.000 mm', 'Y counts down the page on a laser design, so going up the drawing is -30: ' + await val('Up'));
check((await val('Angle')).startsWith('36.87'), 'the angle is as it looks: 36.87° up and right: ' + await val('Angle'));

// a drag measures at once, and replaces the old one
[x1, y1] = await atV(50, 80); [x2, y2] = await atV(50, 50);
await page.mouse.move(x1, y1); await page.mouse.down(); await page.mouse.move(x2, y2, { steps: 5 }); await page.mouse.up();
await page.waitForTimeout(150);
check((await val('Distance')) === '30.000 mm' && (await val('Angle')).startsWith('270'), 'a drag straight down 30 mm: ' + await val('Distance') + ', ' + await val('Angle'));
await page.screenshot({ path: '/tmp/design-measure.png' });

// nothing is added to the drawing
check((await doc()).shapes.length === 1, 'measuring adds nothing to the drawing');
await M().getByRole('button', { name: 'Clear' }).click();
check(await M().getByText('Click the first point').isVisible(), 'Clear starts over');
await page.mouse.click(x1, y1);
await page.keyboard.press('Escape');
await page.waitForTimeout(100);
check(await M().getByText('Click the first point').isVisible(), 'Escape drops a half-made measurement');
await M().getByRole('button', { name: 'Close' }).click();
check(await page.getByRole('navigation', { name: 'Tools' }).getByRole('button', { name: /^Select \(V\)/ }).getAttribute('aria-pressed') === 'true', 'Close goes back to Select');
check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
await browser.close();
process.exit(failures ? 1 : 0);
