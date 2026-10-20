// Browser check for the rotary settings (Settings menu, Laser panel), against the SIMULATED Ruida controller.
//
//   cd design && npm run build
//   DESIGN_DATA=$(mktemp -d) DESIGN_RUIDA=1 DESIGN_SIM_SPEED=20 npm run serve &      (a fresh server)
//   node e2e/rotary.mjs
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
const start = async () => {
  await page.goto(URL_BASE);
  await page.waitForSelector('canvas.design-canvas');
  await startDesign(page, { laser: '3018 + laser head' });
  await page.evaluate(() => window.demonxDesign.run('add_rect', { x: 20, y: 20, w: 30, h: 20, layer: 'Layer 1' }));
  await page.getByRole('tablist', { name: 'Design, Laser or CNC' }).getByRole('tab', { name: 'Laser' }).click();
};
await start();
const side = page.locator('aside.side');
await side.getByRole('tab', { name: 'Job', exact: true }).click();
const lc = page.locator('section.panel').filter({ has: page.locator('h2', { hasText: 'Laser control' }) });
if (await lc.getByRole('button', { name: 'Disconnect' }).isVisible()) await lc.getByRole('button', { name: 'Disconnect' }).click();
await lc.getByLabel('Port').selectOption('ruida-sim');
await lc.getByRole('button', { name: 'Connect' }).click();
await lc.locator('.pill', { hasText: 'Idle' }).waitFor({ timeout: 10000 });

await page.getByRole('button', { name: /Settings/ }).click();
await page.getByText('Rotary setup…').click();
const dlg = page.getByRole('dialog', { name: 'Rotary setup' });
await dlg.waitFor();
await dlg.getByLabel('Object diameter').fill('80'); await dlg.getByLabel('Object diameter').press('Enter');
await page.waitForTimeout(200);
check((await dlg.getByLabel('Circumference').inputValue()) === '251.327', 'the circumference follows the diameter (80 mm gives 251.327)');
await dlg.getByLabel('Steps per rotation').fill('8000'); await dlg.getByLabel('Steps per rotation').press('Enter');
await dlg.getByRole('radio', { name: 'Roller' }).click();
check(await dlg.getByLabel('Roller diameter').isVisible(), 'a roller also asks for the roller diameter');
await dlg.getByRole('radio', { name: 'Chuck' }).click();
await dlg.getByLabel(/Enable rotary/).check();
await page.waitForTimeout(300);
await dlg.getByRole('button', { name: 'Done' }).click();

check(await lc.getByRole('checkbox', { name: 'Rotary' }).isChecked(), 'the Laser panel shows Rotary on');
check(await lc.getByText(/Rotary is on: jobs are not sent yet/).isVisible(), 'and says jobs are not sent yet');
check(await lc.getByRole('button', { name: 'Start…' }).isDisabled() && await lc.getByRole('button', { name: 'Frame', exact: true }).isDisabled() && await lc.getByRole('button', { name: 'Trace a circle' }).isDisabled(), 'Start and both Frames are blocked while rotary is on');

await page.reload();
await startDesign(page);
await page.evaluate(() => window.demonxDesign.run('add_rect', { x: 20, y: 20, w: 30, h: 20, layer: 'Layer 1' }));
await page.getByRole('tablist', { name: 'Design, Laser or CNC' }).getByRole('tab', { name: 'Laser' }).click();
await side.getByRole('tab', { name: 'Job', exact: true }).click();
await lc.getByRole('checkbox', { name: 'Rotary' }).waitFor({ timeout: 10000 });
await page.waitForTimeout(500);
check(await lc.getByRole('checkbox', { name: 'Rotary' }).isChecked(), 'the settings are still there after a reload (kept on the server)');

await lc.getByRole('checkbox', { name: 'Rotary' }).uncheck();
await page.waitForTimeout(500);
check(await lc.getByRole('button', { name: 'Frame', exact: true }).isEnabled(), 'with Rotary off, Frame is available again');
check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
await browser.close();
process.exit(failures ? 1 : 0);
