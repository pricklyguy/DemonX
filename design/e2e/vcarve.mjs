// V-bit carving toolpath from the CNC tab's icon: closed shapes, V-bits only, max depth, no side or allowance.
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
const icon = side.getByRole('button', { name: 'V-bit toolpath' });
check(await icon.isEnabled(), 'the V-bit icon is on once a shape is selected');
await icon.click();
const dlg = page.getByRole('dialog', { name: 'V-bit toolpath' });
await dlg.waitFor();
const opts = await dlg.getByLabel('Tool', { exact: true }).locator('option').allInnerTexts();
check(opts.length >= 1 && opts.every((o) => /V-bit/i.test(o)), 'only V-bits are offered: ' + opts.join(', '));
check(await dlg.getByRole('radio', { name: 'Outside' }).count() === 0 && await dlg.getByText('Grow the shape (glue gap)').isVisible(), 'no cut side; the allowance is the glue gap that grows the shape');
check(await dlg.getByText('Max depth (C)').isVisible(), 'the depth is the max depth');
await dlg.getByRole('button', { name: 'Calculate' }).click();
const tp = (await doc()).cnc.toolpaths[0];
check(tp && tp.kind === 'vcarve' && tp.toolId === 'vbit-60', 'Calculate adds a V-carve toolpath with the V-bit');
check(await side.getByText('V-carve 1', { exact: true }).first().isVisible(), 'and lists it');
const text = await side.innerText();
check(/cut \d+ mm/.test(text), 'the G-code section shows the file with cutting length');
check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
await browser.close();
process.exit(failures ? 1 : 0);
