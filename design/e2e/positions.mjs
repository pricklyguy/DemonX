// Browser check for the Positions tab (Laser tab, Cuts/Layers box), against the SIMULATED Ruida controller. Nothing here talks to a real machine.
//
//   cd design && npm run build
//   DESIGN_DATA=$(mktemp -d) DESIGN_RUIDA=1 DESIGN_SIM_SPEED=20 npm run serve &      (a fresh server)
//   node e2e/positions.mjs
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
const page = await (await browser.newContext({ viewport: { width: 1360, height: 900 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(URL_BASE);
await page.waitForSelector('canvas.design-canvas');
await startDesign(page, { laser: '3018 + laser head' });
await page.getByRole('tablist', { name: 'Design, Laser or CNC' }).getByRole('tab', { name: 'Laser' }).click();
const side = page.locator('aside.side');
await side.getByRole('tab', { name: 'Positions', exact: true }).click();
check(await side.getByText(/Connect to a laser/).isVisible(), 'not connected: the tab says to connect first');

await side.getByRole('tab', { name: 'Job', exact: true }).click();
const lc = page.locator('section.panel').filter({ has: page.locator('h2', { hasText: 'Laser control' }) });
await lc.getByLabel('Port').selectOption('ruida-sim');
await lc.getByRole('button', { name: 'Connect' }).click();
await lc.locator('.pill', { hasText: 'Idle' }).waitFor({ timeout: 10000 });
const head = async () => { const m = /X ([\d.]+) · Y ([\d.]+)/.exec(await lc.locator('.pos').innerText()); return { x: Number(m[1]), y: Number(m[2]) }; };
const home = await head();

await side.getByRole('tab', { name: 'Positions', exact: true }).click();
const headNow = async () => { const m = /Head: X ([\d.]+) · Y ([\d.]+)/.exec(await side.getByLabel('Head position').innerText()); return { x: Number(m[1]), y: Number(m[2]) }; };
const waitHead = (x, y) => page.waitForFunction(([ex, ey]) => { const m = /Head: X ([\d.]+) · Y ([\d.]+)/.exec(document.querySelector('[aria-label="Head position"]')?.textContent ?? ''); return m && Math.abs(Number(m[1]) - ex) < 0.06 && Math.abs(Number(m[2]) - ey) < 0.06; }, [x, y], { timeout: 12000 });
const pressGo = async (btn) => { await btn.click(); check(/Press again/.test(await btn.innerText()), 'the first press of Go asks to press again'); await btn.click(); };

// type a place and go there
await side.getByLabel('Move to X').fill('40'); await side.getByLabel('Move to X').press('Enter');
await side.getByLabel('Move to Y').fill('30'); await side.getByLabel('Move to Y').press('Enter');
const before = await headNow();
await side.getByRole('button', { name: 'Go to the typed position' }).click();
await page.waitForTimeout(400);
const still = await headNow();
check(Math.abs(still.x - before.x) < 0.01 && Math.abs(still.y - before.y) < 0.01, 'one press of Go does not move the head');
await side.getByRole('button', { name: 'Go to the typed position' }).click();
await waitHead(40, 30);
check(true, 'typing X 40 and Y 30 and pressing Go twice sends the head to 40, 30');

// save it, with a name, and change it
await side.getByRole('button', { name: 'Add new' }).click();
await side.getByLabel('Name of position 1').waitFor();
await side.getByLabel('Name of position 1').fill('Start spot'); await side.getByLabel('Name of position 1').press('Enter');
await side.getByLabel('X of Start spot').fill('25'); await side.getByLabel('X of Start spot').press('Enter');
await side.getByLabel('Y of Start spot').fill('25'); await side.getByLabel('Y of Start spot').press('Enter');
check(await side.getByLabel('Name of position 1').inputValue() === 'Start spot', 'Add new makes a position that can be named and given X and Y');

// the arrows are in this window too
await side.getByRole('button', { name: 'Jog X plus' }).click();
await waitHead(50, 30);
check(true, 'the arrow buttons are here and move the head');
await pressGo(side.getByRole('button', { name: 'Go to Start spot' }));
await waitHead(25, 25);
check(true, 'Go on a saved position sends the head to 25, 25');

// a second position, sorted by name
await side.getByRole('button', { name: 'Add new' }).click();
await side.getByLabel('Name of position 2').fill('Alpha'); await side.getByLabel('Name of position 2').press('Enter');
await side.getByRole('button', { name: 'Sort by name' }).click();
await page.waitForTimeout(300);
check(await side.getByLabel('Name of position 1').inputValue() === 'Alpha', 'Sort by name puts Alpha first');
await side.getByLabel('Name of position 2').fill('Alpha'); await side.getByLabel('Name of position 2').press('Enter');
check(await side.getByLabel('Name of position 2').inputValue() === 'Start spot', 'a name that is already used is refused');

await page.reload();
await page.waitForSelector('canvas.design-canvas');
await startDesign(page);
await page.getByRole('tablist', { name: 'Design, Laser or CNC' }).getByRole('tab', { name: 'Laser' }).click();
await side.getByRole('tab', { name: 'Positions', exact: true }).click();
await side.getByLabel('Name of position 2').waitFor({ timeout: 10000 });
check((await side.getByLabel('Name of position 2').inputValue()) === 'Start spot', 'the saved positions are still there after a reload (kept on the server)');

await side.getByRole('button', { name: 'Delete Start spot' }).click();
await side.getByRole('button', { name: 'Delete Alpha' }).click();
check((await side.getByRole('listitem').count()) === 0, 'Delete removes the positions');
check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
await browser.close();
process.exit(failures ? 1 : 0);
