// Browser check for the Fillet tool: click a corner to round it; click the ends of two separate lines to join and round them in one step.
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
await run('add_rect', { x: 20, y: 20, w: 40, h: 30, layer: 'Layer 1' });
await run('add_path', { points: [[100, 30], [130, 30]], closed: false, layer: 'Layer 1' });
await run('add_path', { points: [[150, 80], [150, 45]], closed: false, layer: 'Layer 1' });
await page.getByRole('button', { name: 'Fit', exact: true }).click();
await page.waitForTimeout(250);
await page.getByRole('navigation', { name: 'Tools' }).getByRole('button', { name: /^Fillet \(B\)/ }).click();
const F = page.getByRole('group', { name: 'Fillet' });
await F.waitFor();
await F.getByLabel('Fillet radius').fill('5'); await F.getByLabel('Fillet radius').press('Enter');

// one click on a corner of the rectangle
let [cx, cy] = await atV(20, 20);
await page.mouse.move(cx + 3, cy - 2); await page.mouse.click(cx + 3, cy - 2);
await page.waitForTimeout(200);
let d = await doc();
const rect = d.shapes[0];
check(rect.rings[0].length > 4 && !rect.rings[0].some((p) => Math.abs(p[0] - 20) < 1e-6 && Math.abs(p[1] - 20) < 1e-6), 'a click on a corner rounds just that corner (the sharp point is gone, the others stay): ' + rect.rings[0].length + ' points');
check([[60, 20], [60, 50], [20, 50]].every(([x, y]) => rect.rings[0].some((p) => Math.abs(p[0] - x) < 1e-6 && Math.abs(p[1] - y) < 1e-6)), 'the other three corners are still sharp');

// two separate lines: the end of one, then the end of the other
let [x1, y1] = await atV(130, 30), [x2, y2] = await atV(150, 45);
await page.mouse.move(x1 - 2, y1 + 2); await page.mouse.click(x1 - 2, y1 + 2);
await page.waitForTimeout(100);
check((await doc()).shapes.length === 3, 'the first end alone changes nothing');
await page.mouse.move(x2 + 2, y2 + 2); await page.mouse.click(x2 + 2, y2 + 2);
await page.waitForTimeout(200);
d = await doc();
check(d.shapes.length === 2, 'the second end joins the two lines into one (2 shapes now)');
const line = d.shapes.at(-1) ?? d.shapes[1];
const r = d.shapes.find((s) => s.rings[0].some((p) => p[0] === 100 && p[1] === 30)).rings[0];
check(r[0][0] === 100 && r.at(-1)[0] === 150 && r.at(-1)[1] === 80, 'it runs from the start of the first line to the far end of the second');
check(!r.some((p) => Math.abs(p[0] - 150) < 1e-6 && Math.abs(p[1] - 30) < 1e-6) && r.some((p) => Math.abs(p[0] - 145) < 1e-3 && Math.abs(p[1] - 30) < 1e-3), 'with the corner at (150, 30) rounded by 5 mm');
await page.screenshot({ path: '/tmp/design-fillet.png' });

// right-click goes back to Select, Escape drops a half-made pick
await page.keyboard.press('Control+z');
await page.keyboard.press('Control+z');
await page.mouse.move(x1 - 2, y1 + 2); await page.mouse.click(x1 - 2, y1 + 2);
await page.keyboard.press('Escape');
await page.mouse.move(x2 + 2, y2 + 2); await page.mouse.click(x2 + 2, y2 + 2);
await page.waitForTimeout(150);
check((await doc()).shapes.length === 3, 'Escape forgets the first end, so the second click alone does nothing');
// the card says what a click did, and why when nothing could change
// an outline that repeats its first point (as an imported drawing's does): the corner where it starts and ends rounds too
await run('add_path', { points: [[200, 20], [240, 20], [240, 50], [200, 50], [200, 20]], closed: true, layer: 'Layer 1' });
await page.getByRole('button', { name: 'Fit', exact: true }).click();
await page.waitForTimeout(250);
const [qx, qy] = await atV(200, 20);
await page.mouse.move(qx + 2, qy - 2); await page.mouse.click(qx + 2, qy - 2);
await page.waitForTimeout(250);
d = await doc();
const closedRing = d.shapes.at(-1).rings[0];
check(closedRing.length > 5 && !closedRing.some((p) => p[0] === 200 && p[1] === 20), 'the corner where a closed outline starts and ends rounds as well: ' + closedRing.length + ' points');
check(/Rounded 1 corner/.test(await F.getByRole('status', { name: 'Last fillet' }).innerText()), 'and the card says "Rounded 1 corner"');
// a click on a circle or on nothing says nothing (nothing to round)
await F.getByRole('button', { name: 'Close' }).click();
check(await page.getByRole('navigation', { name: 'Tools' }).getByRole('button', { name: /^Select \(V\)/ }).getAttribute('aria-pressed') === 'true', 'Close goes back to Select');
check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
await browser.close();
process.exit(failures ? 1 : 0);
