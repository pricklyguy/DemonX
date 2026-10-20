// Browser check for the Ruida option in DemonX Design's Laser panel, against the SIMULATED Ruida controller.
// Nothing here talks to a real machine.
//
//   cd design && npm install && npm run build
//   DESIGN_DATA=/tmp/design-e2e DESIGN_RUIDA=1 DESIGN_SIM_SPEED=20 npm run serve &      (a fresh server; Ruida stays hidden without DESIGN_RUIDA=1)
//   node e2e/ruida.mjs
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
const shots = process.env.SHOTS ?? fs.mkdtempSync(path.join(os.tmpdir(), 'design-ruida-'));
let failures = 0;
const check = (ok, what) => { console.log((ok ? 'PASS ' : 'FAIL ') + what); if (!ok) failures++; };

const browser = await chromium.launch({ ...(chromiumPath ? { executablePath: chromiumPath } : {}) });
const ctx = await browser.newContext({ viewport: { width: 1360, height: 820 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const sideTab = (name) => page.locator('aside.side').getByRole('tab', { name, exact: true });
// the arrow buttons live in the Positions tab of the top box; these go there, use them, and come back to the Job tab
const jogClick = async (name) => { await sideTab('Positions').click(); await page.getByRole('button', { name }).click(); await sideTab('Job').click(); };
const jogDisabled = async (name) => { await sideTab('Positions').click(); const d = await page.getByRole('button', { name }).isDisabled(); await sideTab('Job').click(); return d; };
await page.goto(URL_BASE);
await page.waitForSelector('canvas.design-canvas');
await startDesign(page, { laser: '3018 + laser head' });
// a CO2-sized job: a cut square with air, and an engraved circle without
await page.evaluate(() => {
  const r = window.demonxDesign.run;
  r('layer_set', { name: 'Layer 1', speed: 40, power: 12.5, air: true });
  r('add_rect', { x: 20, y: 20, w: 30, h: 20, layer: 'Layer 1' });
});
await page.getByRole('tablist', { name: 'Design, Laser or CNC' }).getByRole('tab', { name: 'Laser' }).click();
await page.locator('aside.side').getByRole('tab', { name: 'Job', exact: true }).click();
const lc = page.locator('section.panel').filter({ has: page.locator('h2', { hasText: 'Laser control' }) });
await lc.getByRole('button', { name: /^(Connect|Disconnect)$/ }).waitFor();
if (await lc.getByRole('button', { name: 'Disconnect' }).isVisible()) {
  await lc.getByRole('button', { name: 'Stop' }).click();
  await lc.locator('.pill', { hasText: 'Idle' }).waitFor({ timeout: 10000 });
  await lc.getByRole('button', { name: 'Disconnect' }).click();
}
await lc.getByRole('button', { name: 'Connect' }).waitFor();

const options = await lc.getByLabel('Port').locator('option').allInnerTexts();
check(options.some((o) => /Simulated Ruida/.test(o)), 'the simulated Ruida is offered as a port: ' + options.join(' | '));
// adding a laser by its address, in the panel
check(await lc.getByText('No Ruida laser added yet.').isVisible(), 'the panel says no Ruida laser has been added yet');
await lc.getByRole('button', { name: /Add a Ruida laser/ }).click();
await lc.getByLabel('Laser name').fill('Bench');
await lc.getByLabel('Laser address').fill('8.8.8.8');
await lc.getByRole('button', { name: 'Save' }).click();
await lc.getByRole('alert').filter({ hasText: 'local network' }).waitFor({ timeout: 8000 });
check(true, 'an address that is not on a local network is refused, with the reason');
await lc.getByRole('button', { name: /Add a Ruida laser/ }).click();
await lc.getByLabel('Laser name').fill('Bench');
await lc.getByLabel('Laser address').fill('127.0.0.1');
await lc.getByRole('button', { name: 'Save' }).click();
await page.waitForFunction(() => document.querySelector('select[aria-label="Port"]')?.value === 'ruida:Bench', null, { timeout: 8000 });
check(true, 'the new laser is added and picked in the list');
check((await lc.getByLabel('Port').locator('option:checked').innerText()).includes('127.0.0.1'), 'the list shows its address');
await lc.getByRole('button', { name: 'Connect' }).click();
await lc.getByRole('alert').filter({ hasText: 'did not answer' }).waitFor({ timeout: 8000 });
check(/same network/.test(await lc.getByRole('alert').first().innerText()), 'a laser that does not answer says what to check');
await lc.getByRole('button', { name: /Forget Bench/ }).click();
await page.waitForFunction(() => ![...document.querySelectorAll('select[aria-label="Port"] option')].some((o) => o.value === 'ruida:Bench'), null, { timeout: 8000 });
check(true, 'Forget removes it');

await lc.getByLabel('Port').selectOption('ruida-sim');
await lc.getByRole('button', { name: 'Connect' }).click();
await lc.locator('.pill', { hasText: 'Idle' }).waitFor({ timeout: 10000 });
check(true, 'connected to the simulated Ruida: Idle');
check(await lc.getByText(/has not been tried on a real machine/).first().isVisible(), 'the panel says Ruida support has not been tried on a real machine');
check((await lc.getByText(/Laser mode/).count()) === 0, 'no GRBL laser-mode controls are shown');
check((await lc.getByRole('button', { name: 'Home' }).count()) === 0 && (await lc.getByRole('button', { name: 'Unlock' }).count()) === 0 && (await lc.getByRole('button', { name: 'Set work zero here' }).count()) === 0, 'Home, Unlock and Set work zero are not offered for Ruida');
check((await lc.getByRole('button', { name: 'Pause' }).count()) === 0, 'Pause is not offered (switched off until proven on the machine)');
const pos0 = await lc.locator('.pos').innerText();
check(/X 152\.14 · Y 14\.51/.test(pos0), 'the position is shown from the rear-left corner like LightBurn: ' + pos0);

// moving: right 10 mm
await jogClick('Jog X plus');
await page.waitForFunction(() => /X 162\.1/.test(document.querySelector('.pos')?.textContent ?? ''), null, { timeout: 8000 });
check(true, 'jogging 10 mm moves the head: ' + (await lc.locator('.pos').innerText()));

// send, frame, start
check((await lc.getByRole('button', { name: 'Send job' }).count()) === 0, 'there is no Send job button for Ruida: Frame and Start check and send the job themselves');
await lc.getByText(/Nothing is sent to the laser until you press Start/).waitFor();
check(await lc.getByRole('button', { name: 'Start…' }).isEnabled(), 'Start is available as soon as there is a job');
// the head sits 14.5 mm from the rear edge. With the job's bottom-left under the head the job would run toward the rear: the
// panel says so before anything is pressed, and the buttons wait
await page.getByRole('radio', { name: 'Start point: bottom-left' }).click();
await lc.getByText('The job does not fit from here.').waitFor({ timeout: 8000 });
check(/past the rear edge/.test(await lc.getByRole('status').filter({ hasText: 'does not fit' }).innerText()), 'a job that would run past the rear edge is explained, with the amount');
check(await lc.getByRole('button', { name: 'Frame', exact: true }).isDisabled() && await lc.getByRole('button', { name: 'Start…' }).isDisabled(), 'Frame and Start wait until it fits');
await page.getByRole('radio', { name: 'Start point: top-left' }).click();
await lc.getByText('The job does not fit from here.').waitFor({ state: 'detached', timeout: 8000 });
check(true, 'with the top-left of the job under the head it fits, and the notice goes away');
await lc.getByRole('button', { name: 'Frame', exact: true }).click();
await lc.getByText('Machine log').click();
await page.waitForFunction(() => /Frame \(laser off\)/.test(document.querySelector('details .log')?.textContent ?? ''), null, { timeout: 8000 });
check(true, 'Frame traces the outline with the laser off');
// the pill can still say Idle just before the head starts to move, so wait for the head to be back, not for the pill
await page.waitForFunction(() => /X 162\.1.*Y 14\.5/.test(document.querySelector('.pos')?.textContent ?? ''), null, { timeout: 40000 }).catch(() => {});
check(/X 162\.1.*Y 14\.5/.test(await lc.locator('.pos').innerText()), 'after the frame the head is back where it started: ' + (await lc.locator('.pos').innerText()));
// the circle frame, the job origin picker and the Start from box live in the Laser panel
check((await lc.getByRole('group', { name: 'Run the job' }).getByRole('button').count()) >= 4, 'the Laser panel has the big Stop, Start, Frame and circle Frame buttons');
check((await lc.getByLabel('Start from').inputValue()) === 'current', 'Start from says Current position');
await lc.getByRole('radio', { name: 'Job origin: top-left' }).waitFor();
await page.waitForTimeout(500);
await lc.getByRole('button', { name: 'Trace a circle' }).click();
await page.waitForFunction(() => /Frame \(circle\) \(laser off\)/.test(document.querySelector('details .log')?.textContent ?? ''), null, { timeout: 8000 });
check(true, 'the circle frame traces a circle round the job with the laser off');
await page.waitForFunction(() => /X 162\.1.*Y 14\.5/.test(document.querySelector('.pos')?.textContent ?? ''), null, { timeout: 60000 }).catch(() => {});
check(/X 162\.1.*Y 14\.5/.test(await lc.locator('.pos').innerText()), 'and the head is back at the start after the circle');

await page.evaluate(() => window.demonxDesign.run('add_circle', { cx: 100, cy: 60, r: 8, layer: 'Layer 1' }));
await lc.getByRole('button', { name: 'Start…' }).click();
const dlg = page.getByRole('dialog', { name: 'Start the laser job' });
const dtext = await dlg.innerText();
check(/What will happen/.test(dtext) && /Layer 1: line .* 40 mm\/s .* 12\.5 % power .* air ON/.test(dtext), 'the start confirmation lists each layer: mode, speed, power and air: ' + dtext.split('\n').find((l) => /^Layer 1/.test(l)));
check(/water chiller/.test(dtext), 'and reminds that the controller does not check the water');
await dlg.getByRole('button', { name: 'Cancel' }).click();
await lc.getByRole('button', { name: 'Start…' }).click();
await dlg.getByRole('button', { name: 'Start burning' }).click();
await lc.getByRole('status').filter({ hasText: 'Job complete' }).waitFor({ timeout: 30000 });
check(true, 'the short job ran to the end on the simulated controller');
const mon = page.getByRole('region', { name: 'Job monitor' });
check(await mon.isVisible(), 'the monitor card opened when the job started');
await mon.getByText(/100% ·/).waitFor({ timeout: 8000 }).catch(() => {});
check(/100%/.test(await mon.innerText()) && /finished/.test(await mon.innerText()), 'and shows the finished job at 100%');
await mon.getByRole('button', { name: 'Close the monitor' }).click();
await page.waitForTimeout(300);
const docked = page.locator('section.sidebox[aria-label="Laser"]').getByRole('region', { name: 'Job monitor' });
check((await docked.count()) === 1 && /finished/.test(await docked.innerText()), 'closing the card moves the monitor into the Monitor tab, still showing the finished job');
check((await page.locator('section.sidebox[aria-label="Laser"]').getByRole('tab', { name: 'Monitor', exact: true }).getAttribute('aria-selected')) === 'true', 'and the Monitor tab is the one showing');
await docked.getByRole('button', { name: 'Open the monitor in its own card' }).click();
await page.locator('.monitor:not(.docked)').waitFor();
check(true, 'Pop out opens the card again');
await page.locator('.monitor:not(.docked)').getByRole('button', { name: 'Close the monitor' }).click();
await page.locator('.monitor:not(.docked)').waitFor({ state: 'detached' });
await page.locator('section.sidebox[aria-label="Laser"]').getByRole('tab', { name: 'Laser', exact: true }).click();


// a long engrave: Stop (the head moves another 50 mm toward the front first, so the bigger job fits behind it)
await sideTab('Positions').click(); await page.getByRole('radio', { name: '50' }).click(); await sideTab('Job').click();
const yOf = async () => Number(/Y (-?[\d.]+)/.exec(await lc.locator('.pos').innerText())[1]);
for (let i = 0; i < 3; i++) {
  const yBefore = await yOf();
  await jogClick('Jog Y minus');
  await page.waitForFunction((y) => Math.abs(Number(/Y (-?[\d.]+)/.exec(document.querySelector('.pos').textContent)[1]) - (y + 50)) < 0.5, yBefore, { timeout: 8000 });
}
check(true, 'the head moved 150 mm toward the front (a job ends where its last line ends, not where it started)');
await page.evaluate(() => {
  const r = window.demonxDesign.run;
  r('layer_set', { name: 'Layer 1', mode: 'engrave', speed: 20, power: 15, interval: 1, overscan: 2, air: false });
  r('add_rect', { x: 0, y: 0, w: 80, h: 80, layer: 'Layer 1' });
});
await lc.getByRole('button', { name: 'Start…' }).click();
await dlg.getByRole('button', { name: 'Start burning' }).click();
await lc.getByText(/Running ·/).waitFor({ timeout: 8000 });
check(await jogDisabled('Jog X plus') && await lc.getByRole('button', { name: 'Disconnect' }).isDisabled(), 'while it runs, jogging and Disconnect are disabled');
const mon2 = page.getByRole('region', { name: 'Job monitor' });
await mon2.waitFor({ timeout: 5000 });
await page.waitForFunction(() => { const t = document.querySelector('[aria-label="Job monitor"]')?.textContent ?? ''; const m = /(\d+)% ·/.exec(t); return m && Number(m[1]) > 0; }, null, { timeout: 20000 }).catch(() => {});
const pctNow = Number(/(\d+)% ·/.exec(await mon2.innerText())?.[1] ?? 0);
check(pctNow > 0 && pctNow < 100, 'while the long job runs the monitor shows progress above 0% (' + pctNow + '%)');
check(await mon2.getByRole('button', { name: 'Stop' }).isEnabled(), 'and has its own Stop button');
await page.screenshot({ path: path.join(shots, 'ruida-running.png') });
await lc.getByRole('button', { name: 'Stop' }).click();
await lc.getByText(/Running ·/).waitFor({ state: 'detached', timeout: 10000 });
await lc.locator('.pill', { hasText: 'Idle' }).waitFor({ timeout: 10000 });
check(true, 'Stop ends the job and the controller returns to Idle');
// the start point is remembered: after a reload (the server keeps its connection) it is still the top-left, not the default of the other laser type
await page.reload();
await page.waitForSelector('canvas.design-canvas');
await startDesign(page, { laser: '3018 + laser head' });
await page.getByRole('tablist', { name: 'Design, Laser or CNC' }).getByRole('tab', { name: 'Laser' }).click();
await page.locator('aside.side').getByRole('tab', { name: 'Job', exact: true }).click();
await lc.locator('.pill', { hasText: 'Idle' }).waitFor({ timeout: 10000 });
check((await page.getByRole('radio', { name: 'Start point: top-left' }).getAttribute('aria-checked')) === 'true', 'after a reload the start point is still the top-left for Ruida');
await page.getByRole('radio', { name: 'Start point: bottom-right' }).click();
await page.reload();
await page.waitForSelector('canvas.design-canvas');
await startDesign(page, { laser: '3018 + laser head' });
await page.getByRole('tablist', { name: 'Design, Laser or CNC' }).getByRole('tab', { name: 'Laser' }).click();
await page.locator('aside.side').getByRole('tab', { name: 'Job', exact: true }).click();
await lc.locator('.pill', { hasText: 'Idle' }).waitFor({ timeout: 10000 });
check((await page.getByRole('radio', { name: 'Start point: bottom-right' }).getAttribute('aria-checked')) === 'true', 'a start point you choose is kept across reloads');
await page.getByRole('radio', { name: 'Start point: top-left' }).click();
await lc.getByRole('button', { name: 'Disconnect' }).click();
await lc.getByRole('button', { name: 'Connect' }).waitFor();
check(true, 'Disconnect works once nothing is running');

// switching back: the simulated GRBL laser still works and shows its own controls
await lc.getByLabel('Port').selectOption('simulator');
await lc.getByRole('button', { name: 'Connect' }).click();
await lc.locator('.pill', { hasText: 'Idle' }).waitFor({ timeout: 10000 });
check(await lc.getByRole('button', { name: 'Home' }).isVisible(), 'the GRBL simulator shows its own controls again');
await lc.getByRole('button', { name: 'Disconnect' }).click();

check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
await browser.close();
console.log('screenshots in ' + shots);
process.exit(failures ? 1 : 0);
