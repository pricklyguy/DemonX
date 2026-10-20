// Browser check for the material library (Laser tab): import a LightBurn .clb, assign, make from layer, edit, and it is kept
// on the server across a reload. Needs a server with its own data folder:  DESIGN_DATA=$(mktemp -d) npm run serve
//
//   cd design && npm run build && npm run serve &       (any fresh server)
//   node e2e/library.mjs
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
const shots = process.env.SHOTS ?? fs.mkdtempSync(path.join(os.tmpdir(), 'design-library-'));
let failures = 0;
const check = (ok, what) => { console.log((ok ? 'PASS ' : 'FAIL ') + what); if (!ok) failures++; };

const browser = await chromium.launch({ ...(chromiumPath ? { executablePath: chromiumPath } : {}) });
const page = await (await browser.newContext({ viewport: { width: 1360, height: 900 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(URL_BASE);
await page.waitForSelector('canvas.design-canvas');
const doc = () => page.evaluate(() => window.demonxDesign.doc());
await startDesign(page);
await page.getByRole('tablist', { name: 'Design, Laser or CNC' }).getByRole('tab', { name: 'Laser' }).click();
await page.locator('aside.side').getByRole('tab', { name: 'Library', exact: true }).click();
const side = page.locator('aside.side');
const lib = side.locator('section', { has: page.getByRole('heading', { name: 'Material library' }) });

const clb = path.join(os.tmpdir(), 'e2e-bench.clb');
fs.writeFileSync(clb, `<?xml version="1.0"?><LightBurnLibrary DisplayName="Bench laser">
<Material name="Acrylic"><Entry Thickness="5.0000" Desc="Cutout"><CutSetting type="Cut"><minPower Value="45"/><maxPower Value="62.5"/><speed Value="10"/><numPasses Value="2"/></CutSetting></Entry>
<Entry Thickness="-1.0000" Desc="Fill" NoThickTitle="Engraving"><CutSetting type="Scan"><minPower Value="16.5"/><maxPower Value="19"/><speed Value="400"/><interval Value="0.08"/></CutSetting></Entry></Material></LightBurnLibrary>`);
await lib.getByLabel('Import a LightBurn library').setInputFiles(clb);
await lib.getByRole('treeitem', { name: 'Cutout' }).waitFor({ state: 'attached' }).catch(() => {});
check((await lib.locator('select[aria-label="Library"]').inputValue()) === 'Bench laser', 'importing a .clb makes a library with its name');
await lib.locator('summary', { hasText: 'Acrylic' }).click();
await lib.locator('summary', { hasText: '5 mm' }).click();
await lib.getByRole('treeitem', { name: 'Cutout' }).click();
await lib.getByRole('button', { name: /^Assign to/ }).click();
let l0 = (await doc()).layers[0];
check(l0.mode === 'cut' && l0.power === 62.5 && l0.minPower === 45 && l0.passes === 2 && l0.speed === 10, 'Assign copies mode, speed, min/max power and passes to the layer');

// edit the entry: it changes the library, not the layer
await lib.getByLabel('Entry max power').fill('70'); await lib.getByLabel('Entry max power').press('Enter');
l0 = (await doc()).layers[0];
check(l0.power === 62.5, 'editing a library entry does not touch the layer until Assign');

// new entry from the layer
await lib.getByRole('button', { name: 'New from layer' }).click();
await lib.getByLabel('Material', { exact: true }).fill('Birch');
await lib.getByLabel('Thickness', { exact: true }).fill('3');
await lib.getByLabel('Settings name').fill('Cut 3mm');
await lib.getByRole('button', { name: 'Save', exact: true }).click();
check((await lib.locator('summary', { hasText: 'Birch' }).count()) === 1, 'New from layer adds a material and an entry');

// Air assist travels with the settings: tick it on an entry, assign, and the layer has it; make an entry from an air layer and it keeps it
await lib.locator('summary', { hasText: 'Acrylic' }).click();
await lib.locator('summary', { hasText: '5 mm' }).click();
await lib.getByRole('treeitem', { name: 'Cutout' }).click();
await lib.getByLabel('Entry air').check();
await page.waitForTimeout(300);
await lib.getByRole('button', { name: /^Assign to/ }).click();
check((await doc()).layers[0].air === true, 'Air assist ticked on a library entry is switched on in the layer by Assign');
await page.evaluate(() => window.demonxDesign.run('layer_set', { name: 'Layer 1', air: false }));
await lib.getByRole('button', { name: /^Assign to/ }).click();
check((await doc()).layers[0].air === true, 'and again after the layer had it off');
await page.evaluate(() => window.demonxDesign.run('layer_set', { name: 'Layer 1', air: true }));
await lib.getByRole('button', { name: 'New from layer' }).click();
await lib.getByLabel('Material', { exact: true }).fill('Birch');
await lib.getByLabel('Settings name').fill('Air cut');
await lib.getByRole('button', { name: 'Save', exact: true }).click();
await page.waitForTimeout(400);
const saved = await page.evaluate(async () => (await (await fetch('/api/library')).json()).libraries[0].materials.flatMap((m) => m.entries).find((e) => e.name === 'Air cut'));
check(saved && saved.air === true, 'an entry made from a layer with Air on keeps Air on, and the server stores it');
// kept on the server across a reload
await page.waitForTimeout(500);
await page.reload();
await page.waitForSelector('canvas.design-canvas');
await startDesign(page);
await page.getByRole('tablist', { name: 'Design, Laser or CNC' }).getByRole('tab', { name: 'Laser' }).click();
await page.locator('aside.side').getByRole('tab', { name: 'Library', exact: true }).click();
await lib.locator('summary', { hasText: 'Birch' }).waitFor({ timeout: 5000 }).catch(() => {});
check((await lib.locator('select[aria-label="Library"]').inputValue()) === 'Bench laser' && (await lib.locator('summary', { hasText: 'Birch' }).count()) === 1, 'the library is still there after a reload (kept by the server)');
await lib.locator('summary', { hasText: 'Acrylic' }).click();
await lib.locator('summary', { hasText: '5 mm' }).click();
await lib.getByRole('treeitem', { name: 'Cutout' }).click();
check((await lib.getByLabel('Entry max power').inputValue()) === '70', 'and so is the edit');
await lib.getByRole('button', { name: 'Duplicate' }).click();
check((await lib.getByRole('treeitem', { name: 'Cutout copy' }).count()) === 1, 'Duplicate makes a copy with a free name');
page.once('dialog', (d) => d.accept());
await lib.getByRole('button', { name: 'Delete', exact: true }).click();
check((await lib.getByRole('treeitem', { name: 'Cutout copy' }).count()) === 0, 'Delete removes the selected entry');
check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
await browser.close();
console.log('screenshots in ' + shots);
process.exit(failures ? 1 : 0);
