// Browser check for the three tabs (Design, Laser, CNC), the Settings menu and Laser setup.
//
//   cd design && npm run build && npm run serve &       (any fresh server)
//   node e2e/tabs.mjs
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
const shots = process.env.SHOTS ?? fs.mkdtempSync(path.join(os.tmpdir(), 'design-tabs-'));
let failures = 0;
const check = (ok, what) => { console.log((ok ? 'PASS ' : 'FAIL ') + what); if (!ok) failures++; };

const browser = await chromium.launch({ ...(chromiumPath ? { executablePath: chromiumPath } : {}) });
const page = await (await browser.newContext({ viewport: { width: 1360, height: 820 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(URL_BASE);
await page.waitForSelector('canvas.design-canvas');
const doc = () => page.evaluate(() => window.demonxDesign.doc());
const run = (id, args) => page.evaluate(([i, a]) => window.demonxDesign.run(i, a), [id, args]);
const dlg = page.getByRole('dialog');

// the work area is asked first, and offers stored lasers; a laser from the list fills in its size
await startDesign(page, { laser: 'CO2 laser 1000 x 600 (Ruida)' });
const tabs = page.getByRole('tablist', { name: 'Design, Laser or CNC' });
check((await tabs.getByRole('tab').allTextContents()).join() === 'Design,Laser,CNC', 'there are three tabs: Design, Laser, CNC');
check((await tabs.getByRole('tab', { name: 'Design' }).getAttribute('aria-selected')) === 'true', 'a new design opens on the Design tab');
check((await doc()).workspace.kind === 'laser' && (await doc()).machine.name.startsWith('CO2 laser 1000'), 'and the laser it started from is the design\'s laser');
check(await page.locator('nav.tools').isVisible(), 'the Design tab has the drawing tools');
await run('add_rect', { x: 100, y: 100, w: 40, h: 30, layer: 'Layer 1' });

// the Laser tab: its own page beside the drawing, no drawing tools, the laser picked for this design
await tabs.getByRole('tab', { name: 'Laser' }).click();
await page.locator('aside.side').getByRole('tab', { name: 'Job', exact: true }).click();
check(await page.locator('aside.side[aria-label="Laser tools"]').isVisible() && !(await page.locator('nav.tools').count()), 'the Laser tab has the laser panel beside the drawing and no drawing tools');
check((await page.locator('select[aria-label="Laser"]').inputValue()) === 'CO2 laser 1000 x 600 (Ruida)', 'the Laser tab shows the design\'s laser');
// 0,0 follows the laser: top-left by default, so the Y box counts down from the top of the page (like the ruler); bottom-left flips it back
const tab = (n) => page.locator('aside.side').getByRole('tab', { name: n, exact: true }).click();
const yBox = page.getByLabel('Y position');
const yTopLeft = Number(await yBox.inputValue());
await page.getByRole('radio', { name: 'Bottom-left', exact: true }).first().check();
await page.waitForFunction((v) => document.querySelector('[aria-label="Y position"]').value !== v, String(yTopLeft), { timeout: 3000 }).catch(() => {});
const yBottomLeft = Number(await yBox.inputValue());
check(Math.abs(yTopLeft + yBottomLeft - 600) < 0.01 && yTopLeft !== yBottomLeft, `the Y box counts from the top for a top-left laser (${yTopLeft}) and from the bottom otherwise (${yBottomLeft})`);
await page.getByRole('radio', { name: 'Top-left', exact: true }).first().check();
// six quick colours under the colour picker
await tab('Layers');
await page.getByRole('button', { name: 'Layer 1 colour: Red' }).click();
check((await doc()).layers[0].color === '#ff0000', 'a quick colour sets the layer colour');
await page.keyboard.press('r'); // the rectangle tool's key
const box = await page.locator('canvas.design-canvas').boundingBox();
await page.mouse.move(box.x + 200, box.y + 200); await page.mouse.down(); await page.mouse.move(box.x + 300, box.y + 260); await page.mouse.up();
check((await doc()).shapes.length === 1, 'drawing tools do nothing on the Laser tab (the key and a drag drew nothing)');
await page.screenshot({ path: path.join(shots, 'tabs-laser.png') });

// Settings menu: Laser setup, with the rest listed as coming
await page.getByRole('button', { name: /^Settings/ }).click();
const items = await page.getByRole('menuitem').allInnerTexts();
check(items.some((t) => /Laser setup/.test(t)) && items.some((t) => /Appearance/.test(t)) && items.some((t) => /CNC settings/.test(t)), 'the Settings menu has Laser setup, Appearance and CNC settings: ' + items.join(' | '));
check(await page.getByRole('menuitem', { name: /Keyboard shortcuts/ }).isDisabled(), 'what is not built yet is shown disabled, not hidden');
await page.getByRole('menuitem', { name: /^Laser setup/ }).click();
const ls = page.getByRole('dialog', { name: 'Laser setup' });
await ls.getByLabel('New laser name').fill('Bench diode');
await ls.getByLabel('New laser width').fill('400');
await ls.getByLabel('New laser height').fill('400');
await ls.getByRole('button', { name: 'Add laser' }).click();
check(await ls.getByText('Bench diode').isVisible(), 'Laser setup adds a laser');
await page.waitForFunction(async () => (await (await fetch('/api/lasers')).json()).lasers.some((l) => l.name === 'Bench diode'), null, { timeout: 5000 }).catch(() => {});
check(await page.evaluate(async () => (await (await fetch('/api/lasers')).json()).lasers.some((l) => l.name === 'Bench diode')), 'and the server keeps it, so every computer sees the same lasers');
await page.screenshot({ path: path.join(shots, 'tabs-laser-setup.png') });
await ls.getByRole('row').filter({ hasText: 'Bench diode' }).getByRole('button', { name: 'Use' }).click();
await page.waitForFunction(() => window.demonxDesign.doc().machine.name === 'Bench diode');
check((await doc()).machine.width === 400, 'Use makes it this design\'s laser');
await ls.getByRole('button', { name: 'Done' }).click();
await page.locator('aside.side').getByRole('tab', { name: 'Job', exact: true }).click();
check((await page.locator('select[aria-label="Laser"]').inputValue()) === 'Bench diode', 'and the Laser tab shows it');
await page.locator('select[aria-label="Laser"]').selectOption('CO2 laser 1000 x 600 (Ruida)');
await page.waitForFunction(() => window.demonxDesign.doc().machine.name.startsWith('CO2 laser 1000'));
check((await doc()).machine.height === 600, 'the Laser tab\'s list switches the laser');
await page.getByRole('button', { name: /^Settings/ }).click();
await page.getByRole('menuitem', { name: /^Laser setup/ }).click();
await ls.getByRole('button', { name: 'Remove Bench diode' }).click();
check((await ls.getByText('Bench diode').count()) === 0, 'Laser setup removes a saved laser');
await ls.getByRole('button', { name: 'Done' }).click();

// Laser tab layer settings: max and min power, and a tool (T1/T2) layer that has no burn settings
await tabs.getByRole('tab', { name: 'Laser' }).click();
await page.locator('aside.side').getByRole('tab', { name: 'Job', exact: true }).click();
await tab('Layers');
await tab('Layers');
const side = page.locator('aside.side');
await side.getByLabel('Max power').fill('40'); await side.getByLabel('Max power').press('Enter');
await side.getByLabel('Min power').fill('10'); await side.getByLabel('Min power').press('Enter');
let l0 = (await doc()).layers[0];
check(l0.power === 40 && l0.minPower === 10, 'Max and Min power can be set per layer');
await side.getByLabel(`${l0.name} mode`).selectOption('tool');
check((await side.getByLabel('Max power').count()) === 0 && (await side.getByText(/never burned/).count()) > 0, 'a Tool layer shows no burn settings');
await side.getByLabel(`${l0.name} mode`).selectOption('cut');

// Settings > Access: this computer controls without a PIN; it can set the first one for other computers
await page.getByRole('button', { name: /^Settings/ }).click();
await page.getByRole('menuitem', { name: /^Access/ }).click();
const acc = page.getByRole('dialog', { name: 'Access' });
check(/You can control the laser from this browser/.test(await acc.innerText()) && /computer that runs the server/.test(await acc.innerText()), 'Access says this computer can control the laser');
await acc.getByLabel('New PIN', { exact: true }).fill('2468');
await acc.getByLabel('New PIN again').fill('2468');
await acc.getByRole('button', { name: 'Set PIN' }).click();
await acc.getByText(/PIN set/).waitFor({ timeout: 5000 });
check(true, 'the first PIN can be set from this computer');
await acc.getByRole('button', { name: 'Done' }).click();

// CNC tab, then back to Design: the drawing is still there, and the tools come back
await tabs.getByRole('tab', { name: 'CNC' }).click();
check(await page.locator('aside.side[aria-label="CNC tools"]').isVisible() && !(await page.locator('nav.tools').count()), 'the CNC tab has its own panel and no drawing tools');
await tabs.getByRole('tab', { name: 'Design' }).click();
check(await page.locator('nav.tools').isVisible() && (await doc()).shapes.length === 1, 'back on Design the tools return and the drawing is unchanged');
check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
await browser.close();
console.log('screenshots in ' + shots);
process.exit(failures ? 1 : 0);
