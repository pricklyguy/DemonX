// Browser check for the job preview (Laser tab): burn path, distances, estimated time, travel moves and play-back.
// Any fresh server.
//
//   cd design && npm run build && npm run serve &       (any fresh server)
//   node e2e/preview.mjs
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
const shots = process.env.SHOTS ?? fs.mkdtempSync(path.join(os.tmpdir(), 'design-preview-'));
let failures = 0;
const check = (ok, what) => { console.log((ok ? 'PASS ' : 'FAIL ') + what); if (!ok) failures++; };

const browser = await chromium.launch({ ...(chromiumPath ? { executablePath: chromiumPath } : {}) });
const page = await (await browser.newContext({ viewport: { width: 1360, height: 900 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(URL_BASE);
await page.waitForSelector('canvas.design-canvas');
const run = (id, args) => page.evaluate(([i, a]) => window.demonxDesign.run(i, a), [id, args]);
await startDesign(page);
await run('add_rect', { x: 10, y: 10, w: 60, h: 40, layer: 'Layer 1' });
await run('layer_set', { name: 'Layer 1', mode: 'engrave', speed: 100, power: 20, interval: 1, overscan: 2 });
await page.getByRole('tablist', { name: 'Design, Laser or CNC' }).getByRole('tab', { name: 'Laser' }).click();
await page.locator('aside.side').getByRole('tab', { name: 'Job', exact: true }).click();
const preview = page.locator('.tabbar').getByRole('button', { name: 'Preview…' });
check(await preview.isEnabled(), 'Preview is offered once there is something to burn');
await preview.click();
const dlg = page.getByRole('dialog', { name: 'Job preview' });
const stats = await dlg.locator('.mono').first().innerText();
check(/Cut distance: \d+ mm \(~\d+:\d\d\) · Rapid moves: \d+ mm .*Total time estimated: \d+:\d\d/.test(stats), 'the preview shows cut and rapid distances and the total time: ' + stats);
const px = async () => dlg.locator('canvas').evaluate((c) => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; });
const full = await px();
check(full > 500, 'the burn path is drawn (' + full + ' pixels)');
await dlg.getByLabel('Position in the job').fill('0');
check((await px()) < full / 20, 'moving the slider to the start shows (almost) nothing burned yet');
await dlg.getByLabel('Position in the job').evaluate((el) => { el.value = String(Number(el.max) / 2); el.dispatchEvent(new Event('input', { bubbles: true })); });
const half = await px();
check(half > 0 && half < full, 'half way shows part of the path');
await dlg.getByLabel('Show traversal moves').check();
check((await px()) > half, 'Show traversal moves adds the travel lines');
// the wheel zooms the preview in (the whole job fills less of a zoomed picture's box), and a double click brings the whole job back
const before = await px();
const cv = dlg.locator('canvas');
const bb = await cv.boundingBox();
await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -300);
await page.waitForTimeout(200);
const zoomed = await px();
check(zoomed !== before, `the mouse wheel zooms the preview (${before} to ${zoomed} pixels)`);
await cv.dblclick();
await page.waitForTimeout(200);
check((await px()) === before, 'a double click shows the whole job again');
await dlg.getByRole('button', { name: 'Play' }).click();
await dlg.getByRole('button', { name: 'Pause' }).waitFor();
await page.screenshot({ path: path.join(shots, 'preview.png') });
await dlg.getByRole('button', { name: 'OK' }).click();
check((await page.getByRole('dialog', { name: 'Job preview' }).count()) === 0, 'OK closes the preview');
// fill modes: a frame filled all at once crosses its empty middle; Fastest finds the cut and says so
await page.evaluate(() => window.demonxDesign.run('delete', { ids: window.demonxDesign.doc().shapes.map((s) => s.id) }));
await run('add_rect', { x: 100, y: 100, w: 200, h: 120, layer: 'Layer 1' });
await run('add_rect', { x: 106, y: 106, w: 188, h: 108, layer: 'Layer 1' });
await page.evaluate(() => { window.demonxDesign.run('boolean', { op: 'difference', ids: window.demonxDesign.doc().shapes.map((s) => s.id) }); window.demonxDesign.run('layer_set', { name: 'Layer 1', interval: 0.5, speed: 415 }); });
const side = page.locator('aside.side');
const tab = (n) => page.locator('aside.side').getByRole('tab', { name: n, exact: true }).click();
const timeOf = async () => { await page.waitForTimeout(250); await page.waitForSelector('[data-jobs=ready]', { state: 'attached' }); return timeOfNow(); };
const timeOfNow = async () => (await side.locator('.stats').innerText()).match(/est\. ([\d:]+)/)?.[1] ?? '';
const secs = (t) => t.split(':').reduce((a, b) => a * 60 + Number(b), 0);
await tab('Layers'); await side.getByLabel('Fill mode').selectOption('all'); await tab('Job');
const slow = secs(await timeOf());
await tab('Layers'); await side.getByLabel('Fill mode').selectOption('auto'); await tab('Job');
await side.getByText(/cut through \d+ wide gap/).waitFor({ timeout: 8000 });
const fast = secs(await timeOf());
check(slow > 0 && fast < slow * 0.7, `Fastest cuts through the border's gap and the time drops (${slow} s to ${fast} s)`);
await page.screenshot({ path: path.join(shots, 'fill.png') });
// cut order: scattered parts on a line layer, Reduce travel moves off and on
await page.evaluate(() => {
  const w = window.demonxDesign;
  w.run('delete', { ids: w.doc().shapes.map((s) => s.id) });
  w.run('layer_set', { name: 'Layer 1', mode: 'cut', speed: 100, power: 20 });
  let seed = 11; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < 30; i++) w.run('add_rect', { x: Math.round(rnd() * 400), y: Math.round(rnd() * 250), w: 8, h: 8, layer: 'Layer 1' });
});
await side.getByLabel('Reduce travel moves').uncheck();
const unordered = secs(await timeOf());
await side.getByLabel('Reduce travel moves').check();
await side.getByText(/Cut order: empty travel/).waitFor({ timeout: 8000 });
const ordered = secs(await timeOf());
check(unordered > 0 && ordered < unordered, `Reduce travel moves shortens the job (${unordered} s to ${ordered} s) and says so`);
check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
await browser.close();
console.log('screenshots in ' + shots);
process.exit(failures ? 1 : 0);
