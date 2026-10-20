// Inlay from the CNC tab's icon: pocket + plug (+ cut-out) toolpaths, and the branded post processors in the list.
// Needs the Design server running (default http://localhost:8090), e.g. DESIGN_DATA=$(mktemp -d) npm run serve.
import fs from 'node:fs';
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
const page = await (await browser.newContext({ viewport: { width: 1360, height: 820 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(URL_BASE);
await page.waitForSelector('canvas.design-canvas');
await startDesign(page, { type: 'cnc', width: 300, height: 180, thickness: 18 });
const doc = () => page.evaluate(() => window.demonxDesign.doc());
await page.evaluate(() => window.demonxDesign.run('add_circle', { cx: 80, cy: 80, r: 25, layer: 'Layer 1' }));
await page.keyboard.press('Control+a');
await page.getByRole('tablist', { name: 'Design, Laser or CNC' }).getByRole('tab', { name: 'CNC' }).click();
const side = page.locator('aside.side');
const icon = side.getByRole('button', { name: 'Inlay toolpath' });
check(await icon.isEnabled(), 'the Inlay icon is on once a shape is selected');
await icon.click();
const dlg = page.getByRole('dialog', { name: 'Inlay toolpaths' });
await dlg.waitFor();
const bb = await dlg.boundingBox();
check(bb && Math.abs(bb.x + bb.width - 1360) < 2, 'it opens as the panel on the far right');
check((await dlg.getByLabel('V-bit', { exact: true }).locator('option').count()) >= 1, 'a V-bit is chosen from the tool list');
await dlg.getByLabel('Pocket depth').fill('3'); await dlg.getByLabel('Pocket depth').press('Enter');
await dlg.getByLabel('Glue gap').fill('0.15'); await dlg.getByLabel('Glue gap').press('Enter');
await dlg.getByRole('button', { name: 'Calculate' }).click();
const tps = (await doc()).cnc.toolpaths;
check(tps.length === 3 && tps[0].kind === 'vcarve' && tps[1].kind === 'plug' && tps[2].kind === 'profile', 'Calculate adds the pocket, the plug and the cut-out: ' + tps.map((t) => t.name).join(', '));
check(tps[0].allowance === 0.15 && tps[0].cutDepth === 3 && tps[1].mirror === true && tps[2].mirror === true, 'the gap, the depth and the mirror are kept');
check(await side.getByText('Inlay pocket 1', { exact: true }).first().isVisible() && await side.getByText('Inlay plug 2', { exact: true }).first().isVisible(), 'and they are listed');
check(await side.getByRole('button', { name: /^Save G-code for this tool/ }).count() === 2, 'two G-code files: one for the V-bit, one for the end mill');

// the branded post processors
const names = await side.getByLabel('Post processor', { exact: true }).locator('option').allInnerTexts();
check(['DemonX - Genmitsu Cubiko (mm)', 'DemonX - Baby CNC 3018 (mm)', 'DemonX - DemonCarve Vacuum M2 (mm)', 'DemonX - DemonCarve PCB (mm)'].every((n) => names.includes(n)), 'the four DemonX post processors are in the list');
await side.getByLabel('Post processor', { exact: true }).selectOption('DemonX - DemonCarve Vacuum M2 (mm)');
check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
await browser.close();
process.exit(failures ? 1 : 0);
