// 3D finishing from the CNC tab: the icon waits for a 3D shape, then makes a toolpath that follows it (ball nose, lines, stepover).
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

const A = [0, 0, 0], B = [30, 0, 0], C = [30, 30, 0], D = [0, 30, 0], T = [15, 15, 12];
const tris = [[A, B, T], [B, C, T], [C, D, T], [D, A, T], [A, C, B], [A, D, C]];
const buf = Buffer.alloc(84 + tris.length * 50);
buf.writeUInt32LE(tris.length, 80);
tris.forEach((t, i) => t.flat().forEach((v, k) => buf.writeFloatLE(v, 84 + i * 50 + 12 + k * 4)));
const stl = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'f3-')), 'pyr.stl');
fs.writeFileSync(stl, buf);

const browser = await chromium.launch({ ...(chromiumPath ? { executablePath: chromiumPath } : {}) });
const page = await (await browser.newContext({ viewport: { width: 1360, height: 820 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(URL_BASE);
await page.waitForSelector('canvas.design-canvas');
await startDesign(page, { type: 'cnc', width: 200, height: 150, thickness: 20 });
const doc = () => page.evaluate(() => window.demonxDesign.doc());
await page.getByRole('tablist', { name: 'Design, Laser or CNC' }).getByRole('tab', { name: 'CNC' }).click();
const side = page.locator('aside.side');
const icon = side.getByRole('button', { name: '3D finishing toolpath' });
check(await icon.isDisabled() && /import a 3D shape first/.test(await icon.getAttribute('title')), 'the 3D finishing icon is off until there is a 3D shape, and says why');

await side.getByRole('button', { name: 'Import STL…' }).click();
const imp = page.getByRole('dialog', { name: 'Import STL' });
await imp.getByLabel('STL file').setInputFiles(stl);
await imp.getByText(/pyr: 6 triangles/).waitFor();
await imp.getByLabel('Shaded preview').waitFor();
await imp.getByRole('button', { name: 'Add to job' }).click();
await page.waitForFunction(() => window.demonxDesign.doc().reliefs?.length === 1);
check(await icon.isEnabled(), 'importing a 3D shape turns it on');
await icon.click();
const dlg = page.getByRole('dialog', { name: '3D finishing toolpath' });
await dlg.waitFor();
const bb = await dlg.boundingBox();
check(bb && Math.abs(bb.x + bb.width - 1360) < 2, 'it opens as the panel on the far right');
check((await dlg.getByLabel('Tool', { exact: true }).inputValue()) === 'ball-3', 'it starts with the ball nose');
check((await dlg.getByLabel('Stepover').inputValue()) === '0.476', 'the stepover follows the tool (15 percent of 3.175 mm)');
check(await dlg.getByText(/\d+ lines\./).isVisible(), 'it says how many lines that makes');
await dlg.getByLabel('Stepover').fill('1'); await dlg.getByLabel('Stepover').press('Enter');
await dlg.getByRole('radio', { name: 'Along Y' }).click();
await dlg.getByRole('checkbox', { name: /second pass at right angles/ }).check();
await dlg.getByRole('button', { name: 'Calculate' }).click();
await page.waitForFunction(() => window.demonxDesign.doc().cnc?.toolpaths.length === 1);
const tp = (await doc()).cnc.toolpaths[0];
check(tp.kind === 'finish3d' && tp.reliefId === 1 && tp.scan.dir === 'y' && tp.scan.stepoverMm === 1 && tp.scan.cross === true && tp.toolId === 'ball-3', 'Calculate adds a 3D finishing toolpath with the choices, including the cross pass');
check(await side.getByText('3D finishing 1', { exact: true }).first().isVisible() && await side.getByText(/pyr, lines along Y 1 mm apart/).isVisible(), 'and lists it');
check(await side.getByRole('button', { name: /^Save G-code for this tool/ }).count() === 1, 'a G-code file is made');
check(await side.getByText(/cut \d+ mm/).first().isVisible(), 'with its cutting length');
// 3D roughing: the flat end mill, allowance 0.5, then both toolpaths make two G-code files
const rough = side.getByRole('button', { name: '3D roughing toolpath' });
check(await rough.isEnabled(), 'the 3D roughing icon is on too');
await rough.click();
const rd = page.getByRole('dialog', { name: '3D roughing toolpath' });
await rd.waitFor();
check(/flat/i.test(await rd.getByLabel('Tool', { exact: true }).locator('option:checked').innerText()), 'it starts with a flat end mill');
check(await rd.getByLabel('Allowance').inputValue() === '0.5', 'and leaves 0.5 mm for the finishing pass');
check(await rd.getByRole('radio', { name: 'Ramp in along the line' }).isChecked() && await rd.getByLabel('Ramp angle').inputValue() === '3', 'it ramps in at 3 degrees by default');
await rd.getByLabel('Ramp angle').fill('5'); await rd.getByLabel('Ramp angle').press('Enter');
await rd.getByRole('button', { name: 'Calculate' }).click();
await page.waitForFunction(() => window.demonxDesign.doc().cnc?.toolpaths.length === 2);
check((await doc()).cnc.toolpaths[1].rampAngle === 5, 'the ramp angle is kept (5 degrees)');
const kinds = (await doc()).cnc.toolpaths.map((t) => t.kind);
check(kinds.join() === 'finish3d,rough3d' && await side.getByRole('button', { name: /^Save G-code for this tool/ }).count() === 2, 'roughing is added beside the finishing: two tools, two G-code files');
// the 3D shape in use cannot be removed until the toolpath is
await side.getByRole('button', { name: 'Delete pyr' }).click();
check((await doc()).reliefs?.length === 1, 'the 3D shape cannot be deleted while a toolpath cuts it');
await side.getByRole('button', { name: 'Edit 3D finishing 1' }).click();
const ed = page.getByRole('dialog', { name: 'Edit toolpath' });
await ed.getByRole('radio', { name: 'Along X' }).click();
await ed.getByRole('button', { name: 'Save' }).click();
check((await doc()).cnc.toolpaths[0].scan.dir === 'x', 'the lines can be changed in the toolpath');
check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
await browser.close();
process.exit(failures ? 1 : 0);
