// Browser check for the New design dialog: only saved setups are listed, Setup new job (size, CNC / Laser / Canvas only, thickness rules, sides, Z zero, five datum positions), saving a setup, opening it again, removing it.
//
//   cd design && npm run build
//   DESIGN_DATA=$(mktemp -d) npm run serve &      (a FRESH server: it checks that no lasers are listed before one is saved)
//   node e2e/shapes.mjs
//
// Stop the server by its port when done (fuser -k 8090/tcp), not with pkill -f.
import { createRequire } from 'node:module';
import fs from 'node:fs';

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
const doc = () => page.evaluate(() => window.demonxDesign.doc());
const dlg = page.getByRole('dialog', { name: 'New design' });
const job = page.getByRole('dialog', { name: 'Setup new job' });
await dlg.waitFor();

// nothing made up is listed
check(await dlg.getByRole('button', { name: 'Setup new job' }).isVisible(), 'the dialog starts with Setup new job');
check(await dlg.getByText(/Saved (laser|CNC|canvas) setups/).count() === 0, 'and lists no saved setups when there are none');
check(!/CO2|3018|diode/i.test(await dlg.innerText()), 'no built-in laser names are offered');
check(await dlg.getByRole('button', { name: 'Open' }).isDisabled(), 'Open waits for a setup to be picked');

// the New job screen
await dlg.getByRole('button', { name: 'Setup new job' }).click();
await job.waitFor();
check(await job.getByRole('radio', { name: 'CNC', exact: true }).isChecked(), 'CNC is chosen to begin with');
check(await job.getByLabel('Material thickness').isVisible() && /\*/.test(await job.getByText(/Thickness \(Z\)/).first().innerText()), 'CNC shows Thickness (Z), marked as required');
check(await job.getByRole('radio', { name: 'Single sided' }).isChecked() && await job.getByRole('radio', { name: 'Material surface' }).isChecked(), 'with Single sided and Material surface chosen');
const enabled = await job.getByRole('radio', { name: /^datum / }).evaluateAll((els) => els.filter((e) => !e.disabled).map((e) => e.getAttribute('aria-label')).sort());
check(enabled.join() === ['datum bl', 'datum br', 'datum c', 'datum tl', 'datum tr'].join(), 'only five XY datum positions are offered (the corners and the centre): ' + enabled.join(', '));
await job.getByLabel('Material thickness').fill('0'); await job.getByLabel('Material thickness').press('Enter');
check(await job.getByLabel('Material thickness').inputValue() === '18', 'a thickness of 0 is refused for CNC (the box goes back to 18)');

await job.getByRole('radio', { name: 'Laser', exact: true }).check();
check(/optional/i.test(await job.getByText(/Thickness \(Z\)/).first().innerText()), 'Laser shows Thickness as optional');
check(await job.getByRole('radio', { name: 'Double sided' }).count() === 0 && await job.getByRole('radio', { name: 'Machine bed' }).count() === 0 && await job.getByRole('radio', { name: /^datum / }).count() === 0, 'and has no sides, Z zero or datum');
await job.getByRole('radio', { name: 'Canvas only', exact: true }).check();
check(await job.getByLabel('Material thickness').count() === 0, 'Canvas only has no thickness');
await job.getByRole('radio', { name: 'CNC', exact: true }).check();

// save a CNC setup: double sided, machine bed, centre datum
const fill = async (label, v) => { const f = job.getByLabel(label, { exact: true }); await f.fill(String(v)); await f.press('Enter'); };
await fill('Work area width', 1290); await fill('Work area height', 1300); await fill('Material thickness', 19);
await job.getByRole('radio', { name: 'Double sided' }).check();
await job.getByRole('radio', { name: 'Machine bed' }).check();
await job.getByRole('radio', { name: 'datum c' }).click();
await job.getByRole('checkbox', { name: 'Save this setup' }).check();
check(await job.getByRole('button', { name: 'Create job' }).isDisabled(), 'saving needs a name first');
await job.getByLabel('Setup name', { exact: true }).fill('Shop CNC');
await job.getByRole('button', { name: 'Create job' }).click();
await job.waitFor({ state: 'detached' });
let ws = (await doc()).workspace;
check(ws.kind === 'cnc' && ws.width === 1290 && ws.height === 1300 && ws.thickness === 19 && ws.sides === 2 && ws.zZero === 'bed' && ws.datum === 'c', 'Create job makes the CNC job: ' + JSON.stringify(ws));

// a laser (with an optional thickness) and a canvas, both saved
await startDesign(page, { open: true, laser: 'CO2 laser 600 x 400', thickness: 3 });
ws = (await doc()).workspace;
check(ws.kind === 'laser' && ws.width === 600 && ws.height === 400 && ws.thickness === 3, 'a laser job keeps its optional thickness: ' + JSON.stringify(ws));
check((await doc()).machine.name === 'CO2 laser 600 x 400', 'and is the laser that was saved');
await startDesign(page, { open: true, type: 'canvas', width: 609, height: 609, save: 'Sign 24 x 24' });
ws = (await doc()).workspace;
check(ws.kind === 'canvas' && ws.width === 609 && ws.height === 609, 'a canvas job is a page of the size given: ' + JSON.stringify(ws));
check(await page.locator('.setup-btn').innerText().then((t) => /609 × 609 mm \(canvas\)/.test(t)), 'and the header says so');

// the saved setups are listed, in this order, and open as they were saved
await page.getByRole('navigation', { name: 'Tools' }).getByRole('button', { name: /^New design/ }).click();
await dlg.waitFor();
const order = await dlg.locator('section.nd-group h2, section.nd-group .nd-title').allInnerTexts();
check(order.join() === ['Saved laser setups', 'Saved CNC setups', 'Saved canvas setups'].join(), 'the lists are Saved laser, CNC, canvas setups: ' + order.join(' | '));
check(await dlg.getByRole('button', { name: 'Setup Shop CNC', exact: true }).isVisible() && /1290 × 1300 × 19 mm/.test(await dlg.getByRole('button', { name: 'Setup Shop CNC', exact: true }).innerText()), 'the CNC setup is listed with its size');
await dlg.getByRole('button', { name: 'Setup Shop CNC', exact: true }).click();
await dlg.getByRole('button', { name: 'Open', exact: true }).click();
await dlg.waitFor({ state: 'detached' });
ws = (await doc()).workspace;
check(ws.kind === 'cnc' && ws.thickness === 19 && ws.sides === 2 && ws.zZero === 'bed' && ws.datum === 'c', 'opening it gives the job back as saved: ' + JSON.stringify(ws));

// double-click opens straight away; a list can be closed; a setup can be removed
await page.getByRole('navigation', { name: 'Tools' }).getByRole('button', { name: /^New design/ }).click();
await dlg.waitFor();
await dlg.getByRole('button', { name: 'Setup CO2 laser 600 x 400', exact: true }).dblclick();
await dlg.waitFor({ state: 'detached' });
check((await doc()).workspace.kind === 'laser', 'a double-click on a saved setup opens it at once');
await page.getByRole('navigation', { name: 'Tools' }).getByRole('button', { name: /^New design/ }).click();
await dlg.waitFor();
await dlg.getByRole('button', { name: /Saved CNC setups/ }).click();
check(await dlg.getByRole('button', { name: 'Setup Shop CNC', exact: true }).count() === 0, 'the chevron closes a list');
await dlg.getByRole('button', { name: /Saved CNC setups/ }).click();
await dlg.getByRole('button', { name: 'Remove setup Shop CNC' }).click();
check(await dlg.getByRole('button', { name: 'Setup Shop CNC', exact: true }).count() === 1, 'the first press of the cross only asks (Sure?)');
await dlg.getByRole('button', { name: 'Remove setup Shop CNC' }).click();
check(await dlg.getByRole('button', { name: 'Setup Shop CNC', exact: true }).count() === 0, 'and the second removes it');
// Back and Escape
await dlg.getByRole('button', { name: 'Setup new job' }).click();
await job.waitFor();
await job.getByRole('button', { name: 'Back to the setups' }).click();
await dlg.waitFor();
check(true, 'Back returns to the list of setups');
await page.keyboard.press('Escape');
await dlg.waitFor({ state: 'detached' });
check(true, 'Escape closes the dialog');
check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
await browser.close();
process.exit(failures ? 1 : 0);
