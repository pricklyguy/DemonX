// CNC tab preview: Preview all / selected / Reset, the animated simulation, colours and Save preview image.
// Needs the Design server running (default http://localhost:8090), e.g. DESIGN_DATA=$(mktemp -d) npm run serve.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
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
const ctx = await browser.newContext({ viewport: { width: 1360, height: 820 }, acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(URL_BASE);
await page.waitForSelector('canvas.design-canvas');
await startDesign(page, { type: 'cnc', width: 300, height: 180, thickness: 18 });
const doc = () => page.evaluate(() => window.demonxDesign.doc());
await page.evaluate(() => window.demonxDesign.run('add_rect', { x: 20, y: 20, w: 60, h: 40, layer: 'Layer 1' }));
await page.evaluate(() => window.demonxDesign.run('add_rect', { x: 120, y: 20, w: 50, h: 50, layer: 'Layer 1' }));
const ids = (await doc()).shapes.map((s) => s.id);
await page.evaluate((i) => window.demonxDesign.run('cnc_toolpath_add', { kind: 'profile', toolId: 'flat-6', cutDepth: 6, ids: [i[0]], side: 'outside' }), ids);
await page.evaluate((i) => window.demonxDesign.run('cnc_toolpath_add', { kind: 'pocket', toolId: 'flat-6', cutDepth: 4, ids: [i[1]] }), ids);
await page.getByRole('tablist', { name: 'Design, Laser or CNC' }).getByRole('tab', { name: 'CNC' }).click();
const side = page.locator('aside.side');
const pv = side.getByRole('toolbar', { name: 'Preview' });
const readout = side.locator('section:has(h2:has-text("Preview")) .mono');
const text = async () => (await readout.innerText()).trim();
await pv.waitFor();

check(/\d+ moves shown/.test(await text()), 'the preview starts showing all the toolpaths: ' + await text());
const all = Number((await text()).match(/(\d+) moves/)[1]);
check(await pv.getByRole('button', { name: 'Preview selected' }).isDisabled(), 'Preview selected waits until a toolpath is clicked in the list');
await side.getByRole('button', { name: 'Profile 1', exact: true }).click();
check(await pv.getByRole('button', { name: 'Preview selected' }).isEnabled(), 'clicking a toolpath in the list chooses it');
await pv.getByRole('button', { name: 'Preview selected' }).click();
const some = Number((await text()).match(/(\d+) moves/)[1]);
check(some > 0 && some < all, `Preview selected shows only that toolpath (${some} of ${all} moves)`);
await pv.getByRole('button', { name: 'Preview all' }).click();
check(Number((await text()).match(/(\d+) moves/)[1]) === all, 'Preview all shows them all again');

// the animated simulation
await pv.getByRole('button', { name: 'Simulate' }).click();
await page.waitForTimeout(700);
check(/Z -?\d/.test(await text()), 'Simulate runs and shows the tool depth: ' + await text());
await pv.getByRole('button', { name: 'Pause simulation' }).click();
const t1 = await text();
await page.waitForTimeout(400);
check(await text() === t1, 'Pause holds it where it is');
await side.getByLabel('Simulation speed').selectOption('10');
await pv.getByRole('button', { name: 'Simulate' }).click();
await page.waitForFunction(() => /100%/.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {});
check(/100%/.test(await text()), 'at 10x it runs to the end: ' + await text());
const slider = side.getByLabel('Simulation position');
await slider.fill('500');
check(/5\d%|50%/.test(await text()), 'dragging the slider moves the tool: ' + await text());

if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, 'cnc-sim.png') });
// colours are kept
await side.getByLabel('Material colour').fill('#336699');
await side.getByLabel('Toolpath cut colour').fill('#ff0000');
const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('design-cnc-colours') ?? '{}'));
check(saved.material === '#336699' && saved.cut === '#ff0000', 'the toolpath and material colours are kept in the browser');

// save the picture
const [dl] = await Promise.all([page.waitForEvent('download'), pv.getByRole('button', { name: 'Save preview image' }).click()]);
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pv-')), 'p.png');
await dl.saveAs(out);
const head = fs.readFileSync(out).subarray(0, 8).toString('hex');
check(head === '89504e470d0a1a0a' && fs.statSync(out).size > 2000, 'Save preview image gives a PNG: ' + dl.suggestedFilename());

await pv.getByRole('button', { name: 'Reset preview' }).click();
check(/off/i.test(await text()), 'Reset preview hides the toolpaths and stops the simulation: ' + await text());
check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
await browser.close();
process.exit(failures ? 1 : 0);
