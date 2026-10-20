// Browser check for the camera: set it up in Settings, see the picture in the Camera tab. Uses a small stand-in for Home Assistant.
// Needs a fresh server with its own data folder:  DESIGN_DATA=$(mktemp -d) npm run serve
//
//   cd design && npm run build && npm run serve &       (any fresh server)
//   node e2e/camera.mjs
//
// Stop the server by its port when done (fuser -k 8090/tcp), not with pkill -f.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

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
const shots = process.env.SHOTS ?? fs.mkdtempSync(path.join(os.tmpdir(), 'design-camera-'));
let failures = 0;
const check = (ok, what) => { console.log((ok ? 'PASS ' : 'FAIL ') + what); if (!ok) failures++; };

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
let hits = 0;
const ha = http.createServer((req, res) => {
  if (req.headers.authorization !== 'Bearer e2e-secret-token') { res.writeHead(401).end(); return; }
  if (req.url === '/api/camera_proxy/camera.e2e_cam') { hits++; res.writeHead(200, { 'content-type': 'image/png' }).end(PNG); } else res.writeHead(404).end();
});
await new Promise((r) => ha.listen(0, '127.0.0.1', r));
const haUrl = `http://127.0.0.1:${ha.address().port}`;

const browser = await chromium.launch({ ...(chromiumPath ? { executablePath: chromiumPath } : {}) });
const page = await (await browser.newContext({ viewport: { width: 1360, height: 900 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(URL_BASE);
await page.waitForSelector('canvas.design-canvas');
await startDesign(page);

await page.getByRole('tablist', { name: 'Design, Laser or CNC' }).getByRole('tab', { name: 'Laser' }).click();
await page.locator('aside.side').getByRole('tab', { name: 'Camera', exact: true }).click();
await page.getByText('No camera is set up yet').waitFor({ timeout: 5000 });
check(true, 'before setup the Camera tab says no camera is set up');
await page.getByRole('button', { name: 'Set up the camera…' }).click();
const dlg = page.getByRole('dialog', { name: 'Camera setup' });
await dlg.getByLabel('Home Assistant address').fill(haUrl);
await dlg.getByLabel('Access token').fill('e2e-secret-token');
await dlg.getByLabel('Camera name').fill('camera.e2e_cam');
await dlg.getByRole('button', { name: 'Save' }).click();
await dlg.getByText('Saved.').waitFor({ timeout: 5000 });
check(true, 'the camera can be set up from Settings');
await dlg.getByRole('button', { name: 'Close' }).click();
await page.locator('aside.side').getByRole('tab', { name: 'Laser', exact: true }).click();
await page.locator('aside.side').getByRole('tab', { name: 'Camera', exact: true }).click();
const img = page.locator('.camera-pic img');
await img.waitFor({ timeout: 8000 });
check(await img.evaluate((i) => i.naturalWidth > 0), 'the Camera tab shows the picture from Home Assistant');
const before = hits;
await page.waitForTimeout(2600);
check(hits > before, 'and renews it every couple of seconds (' + before + ' to ' + hits + ' requests)');
check(!(await page.content()).includes('e2e-secret-token') && !(await page.evaluate(async () => JSON.stringify(await (await fetch('/api/camera/status')).json()))).includes('e2e-secret-token'), 'the access token never reaches the page');
check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
await browser.close();
ha.close();
console.log('screenshots in ' + shots);
process.exit(failures ? 1 : 0);
