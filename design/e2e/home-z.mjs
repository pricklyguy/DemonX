// Browser check for Home and the Z buttons, against the SIMULATED Ruida controller. Nothing here talks to a real machine.
//
//   cd design && npm run build
//   DESIGN_DATA=$(mktemp -d) DESIGN_RUIDA=1 DESIGN_RUIDA_HOME=1 DESIGN_RUIDA_Z=1 DESIGN_SIM_SPEED=20 npm run serve &      (a fresh server)
//   node e2e/home-z.mjs
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
await page.evaluate(() => window.demonxDesign.run('add_rect', { x: 20, y: 20, w: 30, h: 20, layer: 'Layer 1' }));
await page.getByRole('tablist', { name: 'Design, Laser or CNC' }).getByRole('tab', { name: 'Laser' }).click();
const side = page.locator('aside.side');
await side.getByRole('tab', { name: 'Job', exact: true }).click();
const lc = page.locator('section.panel').filter({ has: page.locator('h2', { hasText: 'Laser control' }) });
await lc.getByLabel('Port').selectOption('ruida-sim');
await lc.getByRole('button', { name: 'Connect' }).click();
await lc.locator('.pill', { hasText: 'Idle' }).waitFor({ timeout: 10000 });

// Home: a big button in the Laser panel, pressed twice
const home = lc.getByRole('button', { name: 'Home' });
check(await home.isVisible(), 'a Home button is offered when it is switched on');
await home.click();
await page.waitForTimeout(400);
check(!/ 0\.00 · Y 0\.00/.test(await lc.locator('.pos').innerText()), 'one press of Home does not move the head');
check(/Press again/.test(await home.innerText()), 'the first press asks to press again');
await home.click();
await lc.locator('.pill', { hasText: 'Home' }).waitFor({ timeout: 5000 });
check(true, 'the second press starts homing and the panel says Home');
await lc.locator('.pill', { hasText: 'Idle' }).waitFor({ timeout: 30000 });
check(/X 0\.00 · Y 0\.00/.test(await lc.locator('.pos').innerText()), 'homing ends at 0, 0: ' + (await lc.locator('.pos').innerText()));

// Z: buttons in the Move window, the position shows the change since connecting
await side.getByRole('tab', { name: 'Positions', exact: true }).click();
const head = side.getByLabel('Head position');
check(/Z \+?0(\.00)? /.test(await head.innerText()), 'Z is shown, starting at 0 since connecting: ' + (await head.innerText()));
const z = side.getByRole('group', { name: 'Z' });
await z.getByRole('radio', { name: '5', exact: true }).click();
await side.getByRole('button', { name: 'Jog Z plus' }).click();
await page.waitForFunction(() => /Z \+5/.test(document.querySelector('[aria-label="Head position"]')?.textContent ?? ''), null, { timeout: 15000 });
check(true, 'Z+ with a 5 mm step raises the Z number by 5');
await z.getByRole('radio', { name: '1', exact: true }).click();
await page.waitForTimeout(800);
await side.getByRole('button', { name: 'Jog Z minus' }).click();
await page.waitForFunction(() => /Z \+4/.test(document.querySelector('[aria-label="Head position"]')?.textContent ?? ''), null, { timeout: 15000 });
check(true, 'Z− with a 1 mm step brings it back to +4');
// Auto focus: the controller's own routine, pressed twice; Z changes by itself and the panel goes back to Idle
const zBefore = await head.innerText();
const focus = z.getByRole('button', { name: 'Auto focus' });
await focus.click();
check(/Press again/.test(await focus.innerText()), 'Auto focus asks to be pressed twice');
await focus.click();
await lc.locator('.pill', { hasText: 'Run' }).waitFor({ timeout: 5000 });
await lc.locator('.pill', { hasText: 'Idle' }).waitFor({ timeout: 40000 });
check((await head.innerText()) !== zBefore, 'Auto focus changed Z by itself and the panel is back to Idle: ' + (await head.innerText()));

// Start from: Absolute coordinates and User origin frame from their own start point; Start waits for a capture
await side.getByRole('tab', { name: 'Job', exact: true }).click();
await page.waitForFunction(() => document.querySelector('[data-jobs]')?.getAttribute('data-jobs') === 'ready', null, { timeout: 15000 });
const logText = async () => { await page.evaluate(() => { const d = document.querySelector('details'); if (d) d.open = true; }); return page.locator('details .log').innerText(); };
await lc.getByLabel('Start from').selectOption('absolute');
await lc.getByText(/Frames from X/).waitFor();
check(await lc.getByRole('button', { name: 'Start…' }).isDisabled(), 'Absolute coordinates: Start is blocked (frame only)');
const txt = await lc.getByText(/Frames from X/).innerText();
check(/X 20 · Y 140 mm/.test(txt), 'Absolute coordinates frames from where the job sits in the design (X 20, Y 140: the rect is 20 high at y 20, so its top is at 40, and the page is 180 high): ' + txt.slice(0, 60));
await lc.getByRole('button', { name: 'Frame', exact: true }).click();
await page.waitForFunction(() => /from X 20\.0 Y 140\.0/.test(document.querySelector('details .log')?.textContent ?? ''), null, { timeout: 10000 }).catch(async () => { await logText(); });
check(/Frame \(laser off\).*from X 20\.0 Y 140\.0/.test(await logText()), 'the frame went to X 20, Y 140 first');
await lc.locator('.pill', { hasText: 'Idle' }).waitFor({ timeout: 40000 });
await page.waitForTimeout(800);

await lc.getByLabel('Start from').selectOption('origin');
await lc.getByText(/No job origin/).waitFor();
check(await lc.getByRole('button', { name: 'Frame', exact: true }).isDisabled(), 'User origin with no origin chosen: Frame waits');
await side.getByRole('tab', { name: 'Positions', exact: true }).click();
await side.getByRole('button', { name: 'Add new' }).click();
await side.getByLabel('X of Position 1').fill('100'); await side.getByLabel('X of Position 1').press('Enter');
await side.getByLabel('Y of Position 1').fill('60'); await side.getByLabel('Y of Position 1').press('Enter');
await side.getByRole('button', { name: 'Position 1 is the job origin' }).click();
await side.getByRole('tab', { name: 'Job', exact: true }).click();
await lc.getByText(/Frames from X 100/).waitFor({ timeout: 8000 });
check(true, 'starring a saved position makes it the User origin: ' + (await lc.getByText(/Frames from X/).innerText()).slice(0, 50));
await lc.getByRole('button', { name: 'Frame', exact: true }).click();
await page.waitForFunction(() => /from X 100\.0 Y 60\.0/.test(document.querySelector('details .log')?.textContent ?? ''), null, { timeout: 10000 }).catch(() => {});
check(/from X 100\.0 Y 60\.0/.test(await logText()), 'the frame went round the box placed at the User origin');
await lc.locator('.pill', { hasText: 'Idle' }).waitFor({ timeout: 40000 });
await lc.getByLabel('Start from').selectOption('current');
check(await lc.getByRole('button', { name: 'Start…' }).isEnabled(), 'back to Current position, Start is available again');
check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
await browser.close();
process.exit(failures ? 1 : 0);
