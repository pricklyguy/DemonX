// Browser check for Import bitmap: pick a picture, see the black and white, trace it into outlines of the width asked.
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
// a picture made in the page: white, with a black ring (outer radius 40, hole radius 15) in the middle of 200 x 100 pixels
const dataUrl = await page.evaluate(() => {
  const c = document.createElement('canvas'); c.width = 200; c.height = 100;
  const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 200, 100);
  x.fillStyle = '#000'; x.beginPath(); x.arc(100, 50, 40, 0, Math.PI * 2); x.fill();
  x.fillStyle = '#fff'; x.beginPath(); x.arc(100, 50, 15, 0, Math.PI * 2); x.fill();
  return c.toDataURL('image/png');
});
const buffer = Buffer.from(dataUrl.split(',')[1], 'base64');
await page.getByLabel('Bitmap file').setInputFiles({ name: 'ring.png', mimeType: 'image/png', buffer });
const D = page.getByRole('dialog', { name: 'Import bitmap' });
await D.waitFor();
await D.locator('canvas').waitFor();
const t = Number(await D.getByLabel('Threshold').inputValue());
check(t > 0 && t < 255, 'the threshold is found by itself: ' + t);
await page.waitForTimeout(300);
// the preview: black ring on white
const px = await D.locator('canvas').evaluate((c) => { const x = c.getContext('2d'); const w = c.width, h = c.height; const at = (fx, fy) => x.getImageData(Math.floor(w * fx), Math.floor(h * fy), 1, 1).data[0]; return { ring: at(0.5 - 0.14, 0.5), hole: at(0.5, 0.5), outside: at(0.05, 0.05) }; });
check(px.ring < 100 && px.hole > 200 && px.outside > 200, `the preview shows the ring black, the hole and the background white: ${JSON.stringify(px)}`);
await D.getByLabel('Traced width').fill('100'); await D.getByLabel('Traced width').press('Enter');
await D.getByRole('button', { name: 'Trace' }).click();
await page.waitForFunction(() => window.demonxDesign.doc().shapes.length > 0, null, { timeout: 15000 });
await page.waitForTimeout(150);
const d = await doc();
check(d.shapes.length === 1 && d.shapes[0].rings.length === 2, 'one shape with two outlines (the ring and its hole): ' + d.shapes.length + ' shape, ' + d.shapes[0].rings.length + ' rings');
const ring = d.shapes[0].rings[0];
const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
check(Math.abs((Math.max(...xs) - Math.min(...xs)) - 40) < 1 && Math.abs((Math.max(...ys) - Math.min(...ys)) - 40) < 1, `the outer outline is 40 mm across (80 of 200 pixels at 100 mm wide): ${(Math.max(...xs) - Math.min(...xs)).toFixed(1)} x ${(Math.max(...ys) - Math.min(...ys)).toFixed(1)}`);
check(Math.abs(Math.min(...xs) - 30) < 1 && Math.abs(Math.min(...ys) - 5) < 1, 'placed with the picture\'s lower left at 0, 0: the circle starts at x ' + Math.min(...xs).toFixed(1) + ', y ' + Math.min(...ys).toFixed(1));
check(await D.count() === 0, 'the dialog closes');
await page.keyboard.press('Control+z');
check((await doc()).shapes.length === 0, 'undo takes the whole trace back in one step');
// a file that is not a picture
await page.getByLabel('Bitmap file').setInputFiles({ name: 'x.png', mimeType: 'image/png', buffer: Buffer.from('not a picture') });
await D.waitFor();
await D.getByText(/could not be read/).waitFor();
check(true, 'a file that is not a picture says so');
await D.getByRole('button', { name: 'Cancel' }).click();
check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
await browser.close();
process.exit(failures ? 1 : 0);
