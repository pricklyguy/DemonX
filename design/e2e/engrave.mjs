// Engraving toolpath from the CNC tab's icon: open lines and closed shapes, V-bit by default, shallow, no side or allowance.
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
await page.evaluate(() => window.demonxDesign.run('add_path', { points: [[20, 20], [80, 20], [80, 60]], closed: false, layer: 'Layer 1' }));
await page.evaluate(() => window.demonxDesign.run('add_rect', { x: 120, y: 30, w: 40, h: 30, layer: 'Layer 1' }));
await page.keyboard.press('Control+a');
check((await page.evaluate(() => window.demonxDesign.selection().length)) === 2, 'the open line and the rectangle are selected');
await page.getByRole('tablist', { name: 'Design, Laser or CNC' }).getByRole('tab', { name: 'CNC' }).click();
const side = page.locator('aside.side');
const icon = side.getByRole('button', { name: 'Engraving toolpath' });
check(await icon.isEnabled(), 'the Engraving icon is on once shapes are selected');
await icon.click();
const dlg = page.getByRole('dialog', { name: 'Engraving toolpath' });
await dlg.waitFor();
check((await dlg.getByLabel('Tool', { exact: true }).inputValue()) === 'vbit-60', 'it starts with the V-bit');
check(!(await dlg.getByLabel('Tool', { exact: true }).locator('option', { hasText: 'drill' }).count()), 'drills are not offered');
check(await dlg.getByRole('radio', { name: 'Outside' }).count() === 0 && await dlg.getByLabel('Allowance').count() === 0, 'no cut side and no allowance for engraving');
check((await dlg.getByLabel('Cut depth').inputValue()) === '1', 'the cut depth starts shallow (1 mm)');
await dlg.getByRole('button', { name: 'Calculate' }).click();
const d = await doc();
const tp = d.cnc.toolpaths[0];
check(tp && tp.kind === 'engrave' && tp.shapeIds.length === 2 && tp.cutDepth === 1 && tp.toolId === 'vbit-60', 'Calculate adds an engraving toolpath for both shapes');
check(await side.getByText('Engraving 1', { exact: true }).first().isVisible(), 'and lists it');
check(await side.getByRole('button', { name: /^Save G-code for this tool/ }).count() === 1, 'one G-code file is made for the V-bit');
check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
await browser.close();
process.exit(failures ? 1 : 0);
