// Browser check for saving where the browser has no Save As window (an address that is not secure, such as http://<other computer>:8090):
// the name is asked for in the app, the file goes to Downloads under that name, and the banner says why. Any fresh server.
//
//   cd design && npm run build && npm run serve &       (any fresh server)
//   node e2e/save.mjs
//
// Stop the server by its port when done (fuser -k 8090/tcp), not with pkill -f.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
const shots = process.env.SHOTS ?? fs.mkdtempSync(path.join(os.tmpdir(), 'design-save-'));
let failures = 0;
const check = (ok, what) => { console.log((ok ? 'PASS ' : 'FAIL ') + what); if (!ok) failures++; };

const browser = await chromium.launch({ ...(chromiumPath ? { executablePath: chromiumPath } : {}) });
const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, acceptDownloads: true });
// what an insecure address looks like to the page: no file pickers
await ctx.addInitScript(() => { delete window.showSaveFilePicker; delete window.showOpenFilePicker; });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(URL_BASE);
await page.waitForSelector('canvas.design-canvas');
await startDesign(page);
await page.evaluate(() => window.demonxDesign.run('add_rect', { x: 10, y: 10, w: 40, h: 30, layer: 'Layer 1' }));

await page.getByRole('button', { name: /^File/ }).click();
const [dl0] = await Promise.all([page.waitForEvent('download', { timeout: 4000 }).catch(() => null), page.getByRole('menuitem', { name: /^Save as/ }).click()]);
check(dl0 === null, 'Save as does not just drop a file into Downloads: it asks for a name first');
const dlg = page.getByRole('dialog', { name: 'Name and save' });
await dlg.waitFor({ timeout: 3000 });
await dlg.getByLabel('Design name').fill('kiosk front');
const [dl] = await Promise.all([page.waitForEvent('download'), dlg.getByRole('button', { name: 'Save' }).click()]);
check(dl.suggestedFilename() === 'kiosk front.dxd', 'the file gets the name that was typed: ' + dl.suggestedFilename());
const banner = page.locator('.banner');
await banner.waitFor();
check(/Downloads folder/.test(await banner.innerText()) && /secure/.test(await banner.innerText()), 'and the page says why it went to Downloads');
// Save again: the same name, no questions
const [dl2] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Control+s')]);
check(dl2.suggestedFilename() === 'kiosk front.dxd', 'Save again keeps the name');
check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
await browser.close();
console.log('screenshots in ' + shots);
process.exit(failures ? 1 : 0);
