// 3D shapes on the CNC tab: import an STL (a pyramid made here), size and place it, see it shaded on the drawing, change and remove it.
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

// a pyramid, 40 x 40 at the base and 20 high, as a binary STL
const tri = (a, b, c) => [a, b, c];
const A = [0, 0, 0], B = [40, 0, 0], C = [40, 40, 0], D = [0, 40, 0], T = [20, 20, 20];
const tris = [tri(A, B, T), tri(B, C, T), tri(C, D, T), tri(D, A, T), tri(A, C, B), tri(A, D, C)];
const buf = Buffer.alloc(84 + tris.length * 50);
buf.writeUInt32LE(tris.length, 80);
tris.forEach((t, i) => t.flat().forEach((v, k) => buf.writeFloatLE(v, 84 + i * 50 + 12 + k * 4)));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stl-'));
const stl = path.join(dir, 'pyramid.stl');
fs.writeFileSync(stl, buf);
const bad = path.join(dir, 'bad.stl');
fs.writeFileSync(bad, 'this is not an stl file '.repeat(10));

const browser = await chromium.launch({ ...(chromiumPath ? { executablePath: chromiumPath } : {}) });
const page = await (await browser.newContext({ viewport: { width: 1360, height: 820 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(URL_BASE);
await page.waitForSelector('canvas.design-canvas');
await startDesign(page, { type: 'cnc', width: 300, height: 180, thickness: 18 });
const doc = () => page.evaluate(() => window.demonxDesign.doc());
await page.getByRole('tablist', { name: 'Design, Laser or CNC' }).getByRole('tab', { name: 'CNC' }).click();
const side = page.locator('aside.side');
await side.getByRole('button', { name: 'Import STL…' }).click();
const dlg = page.getByRole('dialog', { name: 'Import STL' });
await dlg.waitFor();
const bb = await dlg.boundingBox();
check(bb && Math.abs(bb.x + bb.width - 1360) < 2, 'Import STL opens as the panel on the far right');
check(await dlg.getByRole('button', { name: 'Add to job' }).isDisabled(), 'Add to job waits for a file');

await dlg.getByLabel('STL file').setInputFiles(bad);
await dlg.getByText(/not an STL file/).waitFor();
check(true, 'a file that is not an STL is refused with a plain message');
await dlg.getByLabel('STL file').setInputFiles(stl);
await dlg.getByText(/pyramid: 6 triangles/).waitFor();
await dlg.getByLabel('Shaded preview').waitFor();
check(await dlg.getByText('As it comes: 40 × 40 mm across, 20 mm high.').isVisible(), 'the file is read and its size shown (40 x 40 x 20)');
check(await dlg.getByLabel('Model width').inputValue() === '40', 'the width starts at the model\'s own');
await dlg.getByLabel('Model width').fill('100'); await dlg.getByLabel('Model width').press('Enter');
await page.waitForFunction(() => document.querySelector('[aria-label="Model height"]')?.value === '50');
check(true, 'changing the width scales the height evenly (100 wide gives 50 high)');
await dlg.getByLabel('Which way is up').selectOption('+z');
check(await dlg.getByText(/Taller than the 18 mm material/).isVisible(), 'a model taller than the material is warned about');
await dlg.getByLabel('Model height').fill('15'); await dlg.getByLabel('Model height').press('Enter');
check(!(await dlg.getByText(/Taller than/).count()), 'and squashing it to 15 mm clears the warning');
check(await dlg.getByLabel('Model X').inputValue() === '-50' || await dlg.getByLabel('Model X').inputValue() === '100', 'it is placed in the middle of the material by default');
await dlg.getByRole('button', { name: 'Add to job' }).click();
await page.waitForFunction(() => window.demonxDesign.doc().reliefs?.length === 1);
let r = (await doc()).reliefs[0];
check(r.name === 'pyramid' && r.width === 100 && r.depth === 15 && r.w === 800 && r.h === 800, 'the 3D shape is in the job: ' + [r.name, r.width, r.depth, r.w + 'x' + r.h].join(', '));
check(await side.getByText('100 × 100 × 15 mm').isVisible(), 'and listed with its size');

// shaded on the drawing: opposite faces of the pyramid are lit differently
await page.waitForTimeout(300);
const area = { x: 330, y: 295, width: 300, height: 300 };   // where the 100 x 100 mm shape sits on the page
const look = async () => (await page.screenshot({ clip: area })).toString('base64');
const shown = await look();
await page.getByRole('checkbox', { name: 'Show pyramid' }).uncheck();
await page.waitForTimeout(300);
const hidden = await look();
await page.getByRole('checkbox', { name: 'Show pyramid' }).check();
await page.waitForTimeout(300);
check(shown !== hidden && shown === await look(), 'the shape is drawn shaded on the page, and gone when hidden (the picture of that area changes)');
// a pyramid has a lit side and a dark side with the light from the upper left: the picture is not one flat tone
const flat = new Set([...Buffer.from(shown, 'base64').subarray(0, 4000)]).size;
check(flat > 3, 'the picture is not one flat colour');

// change it, hide it, remove it
await side.getByLabel('Width of pyramid').fill('60'); await side.getByLabel('Width of pyramid').press('Enter');
r = (await doc()).reliefs[0];
check(r.width === 60 && r.depth === 15, 'the width can be changed in the list');
await side.getByLabel('Show pyramid').uncheck();
check((await doc()).reliefs[0].visible === false, 'it can be hidden');
await side.getByRole('button', { name: 'Delete pyramid' }).click();
check((await doc()).reliefs === undefined, 'and removed');
check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
await browser.close();
process.exit(failures ? 1 : 0);
