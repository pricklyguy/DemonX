// Tool library on the CNC tab: a big window to load a library file, search and filter, fill in a missing size, change a recipe, add a cutter to the
// job; and the same window as the tool picker of a toolpath, with numbers changed for one cut.
// Uses a made-up library (no shop data). Needs a fresh Design server (its tool library file starts empty):
//   DESIGN_DATA=$(mktemp -d) npm run serve
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

const library = {
  v: 1,
  tools: [
    { id: 'A1', name: 'Test upcut 1/4', manufacturer: 'Acme', part: 'UC-14', kind: 'flat', diameter: 6.35, flutes: 3, priority: 'Active', recipes: [
      { machine: 'Router', material: 'MDF', status: 'Approved', rpm: 18000, feed: 1500, plunge: 500, passDepth: 5, stepoverMm: 2.5 },
      { machine: 'Router', material: 'Hardwood', status: 'Testing Required', rpm: 18000, feed: 900, plunge: 300, passDepth: 2 },
    ] },
    { id: 'A2', name: 'Test V-bit', manufacturer: 'Acme', kind: 'vbit', diameter: 12.7, vAngle: 90, recipes: [{ machine: 'Router', material: 'MDF', status: 'Approved', rpm: 16000, feed: 1000, plunge: 400, passDepth: 1.5 }] },
    { id: 'A4', name: 'Test tapered ball', manufacturer: 'Zed', kind: 'ball', diameter: 0.8, flutes: 2, recipes: [] },
    { id: 'A3', name: 'Mystery bit', part: 'MB-9', kind: null, recipes: [{ machine: 'Other machine', material: 'PCB', status: 'Testing Required', rpm: 9000, feed: 400, plunge: 100 }] },
  ],
};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-'));
const file = path.join(dir, 'lib.json');
fs.writeFileSync(file, JSON.stringify(library));

const browser = await chromium.launch({ ...(chromiumPath ? { executablePath: chromiumPath } : {}) });
const ctx = await browser.newContext({ viewport: { width: 1360, height: 820 }, acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(URL_BASE);
await page.waitForSelector('canvas.design-canvas');
await startDesign(page, { type: 'cnc', width: 300, height: 180, thickness: 18 });
const doc = () => page.evaluate(() => window.demonxDesign.doc());
const serverLib = () => page.evaluate(async () => (await fetch('/api/toollib')).json());
await page.getByRole('tablist', { name: 'Design, Laser or CNC' }).getByRole('tab', { name: 'CNC' }).click();
const side = page.locator('aside.side');
await side.getByRole('button', { name: 'Tool library' }).click();
const dlg = page.getByRole('dialog', { name: 'Tool library' });
await dlg.waitFor();
const bb = await dlg.boundingBox();
check(bb && bb.width > 1100 && bb.height > 700, `the library opens as a big window (${Math.round(bb.width)} x ${Math.round(bb.height)})`);
check(await dlg.getByText(/library is empty/).isVisible(), 'a new server starts with an empty library');

await dlg.getByLabel('Tool library file').setInputFiles(file);
await dlg.getByText('4 of 4 tools. 3 are ready for a job.').waitFor();
const upcut = dlg.getByRole('button', { name: 'Test upcut 1/4' });
const ub = await upcut.boundingBox();
check(ub && ub.height > 25 && await upcut.getByText('Test upcut 1/4').isVisible() && await upcut.getByText(/End mill · ⌀ 6.35 mm/).isVisible(), 'the tools are listed with their names and sizes, not squashed');
check(await dlg.getByText('Acme', { exact: true }).isVisible() && await dlg.getByText('Zed', { exact: true }).isVisible() && await dlg.getByText('Other', { exact: true }).isVisible(), 'grouped by maker');
check(await dlg.getByRole('button', { name: 'Mystery bit, geometry missing' }).isVisible() && await dlg.getByText('Needs: the kind, the diameter').isVisible(), 'a tool without its geometry says what it needs');

await dlg.getByLabel('Search tools').fill('v-bit');
check((await dlg.locator('.tdb-item').count()) === 1, 'search narrows the list');
await dlg.getByLabel('Search tools').fill('');
await dlg.getByLabel('Machine', { exact: true }).selectOption('Router');
check((await dlg.locator('.tdb-item').count()) === 3, 'the machine filter keeps the tools with a recipe for it and the ones with no recipes yet');
await dlg.getByLabel('Material', { exact: true }).selectOption('Hardwood');
check((await dlg.locator('.tdb-item').count()) === 2, 'the material filter narrows it further (the tool with no recipe yet stays)');

// a tool, its geometry and its recipe for this machine and material
await upcut.click();
check(await dlg.getByRole('heading', { name: 'Test upcut 1/4' }).isVisible() && await dlg.getByLabel('Spindle speed').inputValue() === '18000' && await dlg.getByLabel('Feed rate').inputValue() === '900', 'selecting a tool shows its recipe for the machine and material (18000 rpm, feed 900)');
await dlg.getByRole('radio', { name: 'Inches' }).click();
await page.waitForFunction(() => document.querySelector('[aria-label="Feed rate"]')?.value.startsWith('35.43'));
check((await dlg.getByLabel('Diameter of Test upcut 1/4').inputValue()) === '0.25', 'inches shows the feed as 35.43 in/min and the diameter as 0.25');
await dlg.getByRole('radio', { name: 'Millimetres' }).click();
await dlg.getByLabel('Feed rate').fill('1000'); await dlg.getByLabel('Feed rate').press('Enter');
await page.waitForFunction(async () => (await (await fetch('/api/toollib')).json()).tools.find((t) => t.id === 'A1').recipes.find((r) => r.material === 'Hardwood').feed === 1000);
check(true, 'changing a number in the library saves it (feed 1000 on the server)');
await dlg.getByLabel('Material', { exact: true }).selectOption('MDF');
await dlg.getByRole('button', { name: 'Add to job with this recipe' }).click();
const t1 = (await doc()).cnc.tools.find((x) => x.id === 'lib-a1-router-mdf');
check(t1 && t1.diameter === 6.35 && t1.rpm === 18000 && t1.feed === 1500 && t1.plunge === 500 && t1.stepdown === 5 && Math.abs(t1.stepover - 39.37) < 0.1, 'Add to job puts the cutter in with the recipe: ' + JSON.stringify(t1 && { rpm: t1.rpm, feed: t1.feed, stepdown: t1.stepdown, stepover: t1.stepover }));

// fill in a missing size
await dlg.getByLabel('Machine', { exact: true }).selectOption('');
await dlg.getByLabel('Material', { exact: true }).selectOption('');
await dlg.getByRole('button', { name: 'Mystery bit, geometry missing' }).click();
await dlg.getByLabel('Kind of Mystery bit').selectOption('ball');
await dlg.getByLabel('Diameter of Mystery bit').fill('3'); await dlg.getByLabel('Diameter of Mystery bit').press('Enter');
await dlg.getByText('4 of 4 tools. 4 are ready for a job.').waitFor();
check(true, 'giving it a kind and a diameter makes it ready');

// a tapered ball nose
await dlg.getByRole('button', { name: 'Test tapered ball' }).click();
await dlg.getByLabel('Taper of Test tapered ball').fill('12'); await dlg.getByLabel('Taper of Test tapered ball').press('Enter');
await dlg.getByText('Needs: the largest diameter of the taper').first().waitFor();
check(true, 'giving a ball nose a taper makes it ask for the largest diameter');
await dlg.getByLabel('Largest diameter of Test tapered ball').fill('6.35'); await dlg.getByLabel('Largest diameter of Test tapered ball').press('Enter');
await dlg.getByText('4 of 4 tools. 4 are ready for a job.').waitFor();
await dlg.getByRole('button', { name: 'Add to job (no recipe)' }).click();
const taperTool = (await doc()).cnc.tools.find((x) => x.name === 'Test tapered ball');
check(taperTool && taperTool.kind === 'ball' && taperTool.diameter === 0.8 && taperTool.taperAngle === 12 && taperTool.maxDiameter === 6.35, 'it goes in the job as a tapered ball nose');

// a new tool and a recipe for it
await dlg.getByRole('button', { name: '+ New tool' }).click();
await dlg.getByRole('heading', { name: 'New tool' }).waitFor();
check(await dlg.getByText(/5 of 5 tools/).isVisible(), '+ New tool adds a blank tool to fill in');
await dlg.getByRole('button', { name: 'Delete tool' }).click();
await dlg.getByRole('button', { name: 'Sure? Delete it' }).click();
await dlg.getByText('4 of 4 tools.').waitFor();
check(true, 'and Delete tool asks twice before it removes it');
await dlg.getByRole('button', { name: 'Close' }).click();

// the job's machine and material, and the same window as the tool picker of a toolpath
await side.getByLabel('Job machine').selectOption('Router');
await side.getByLabel('Job material').selectOption('MDF');
const job = (await doc()).cnc;
check(job.machine === 'Router' && job.material === 'MDF', 'the job has a machine and a material to choose from the library');
await page.evaluate(() => window.demonxDesign.run('add_rect', { x: 20, y: 20, w: 40, h: 30, layer: 'Layer 1' }));
await page.keyboard.press('Control+a');
await side.getByRole('button', { name: 'Profile toolpath' }).click();
const tp = page.getByRole('dialog', { name: 'Profile toolpath' });
await tp.getByRole('button', { name: 'Select from the library…' }).click();
const pickDlg = page.getByRole('dialog', { name: 'Choose a tool' });
await pickDlg.waitFor();
const pb = await pickDlg.boundingBox();
check(pb && pb.width > 1100 && pb.height > 700, 'the tool picker is the same big window');
check(await pickDlg.getByLabel('Machine', { exact: true }).inputValue() === 'Router' && await pickDlg.getByLabel('Material', { exact: true }).inputValue() === 'MDF', 'it starts with the job\'s machine and material');
check(await pickDlg.getByRole('button', { name: 'Test V-bit' }).isVisible() && await pickDlg.getByRole('button', { name: 'Test upcut 1/4' }).isVisible() && !(await pickDlg.getByRole('button', { name: /Mystery bit/ }).count()), 'it lists the cutters that fit');
check(await pickDlg.getByRole('button', { name: 'Select' }).isDisabled(), 'Select waits for a tool');
await pickDlg.getByRole('button', { name: 'Test upcut 1/4' }).click();
check(await pickDlg.getByLabel('Feed rate').inputValue() === '1500', 'the recipe\'s numbers are shown (feed 1500)');
await pickDlg.getByLabel('Feed rate').fill('1234'); await pickDlg.getByLabel('Feed rate').press('Enter');
check(await pickDlg.getByText('Changed for this cut only.').isVisible(), 'changing a number here says it is for this cut only');
await pickDlg.getByRole('button', { name: 'Select', exact: true }).click();
await tp.getByLabel('Tool', { exact: true }).waitFor();
const picked = await tp.getByLabel('Tool', { exact: true }).inputValue();
const t2 = (await doc()).cnc.tools.find((x) => x.id === picked);
check(/^lib-a1-router-mdf-c/.test(picked) && t2.feed === 1234 && /this cut/.test(t2.name), 'Select puts that version in the job and in the panel: ' + picked);
check((await serverLib()).tools.find((x) => x.id === 'A1').recipes.find((r) => r.material === 'MDF').feed === 1500, 'and the library recipe is not changed');
check(await tp.getByText(/1234 mm\/min|feed 1234/).first().isVisible(), 'the panel shows the numbers of the tool it uses');
await tp.getByRole('button', { name: 'Cancel' }).click();

// kept on the server and shown again after a reload
const server = await serverLib();
check(server.tools.length === 4 && server.tools.find((x) => x.id === 'A3').kind === 'ball' && server.tools.find((x) => x.id === 'A3').diameter === 3, 'the server keeps the library, with the changes');
await side.getByRole('button', { name: 'Tool library' }).click();
const [dl] = await Promise.all([page.waitForEvent('download'), dlg.getByRole('button', { name: 'Save a copy' }).click()]);
check(dl.suggestedFilename() === 'tool-library.json', 'Save a copy gives a tool-library.json');
await dlg.getByRole('button', { name: 'Close' }).click();
await page.evaluate(() => localStorage.removeItem('design-tool-library'));
await page.reload();
await page.waitForSelector('canvas.design-canvas');
await startDesign(page, { type: 'cnc', width: 300, height: 180, thickness: 18 });
await page.getByRole('tablist', { name: 'Design, Laser or CNC' }).getByRole('tab', { name: 'CNC' }).click();
await page.locator('aside.side').getByRole('button', { name: 'Tool library' }).click();
await page.getByRole('dialog', { name: 'Tool library' }).getByText('4 of 4 tools. 4 are ready for a job.').waitFor({ timeout: 5000 });
check(true, 'after a reload with nothing kept in the browser, the library comes back from the server');
check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
await browser.close();
process.exit(failures ? 1 : 0);
