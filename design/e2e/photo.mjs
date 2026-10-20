// Photo toolpath from the CNC tab's icon: choose a picture, lines or dots, then change the style of the finished toolpath.
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

const browser = await chromium.launch({ ...(chromiumPath ? { executablePath: chromiumPath } : {}) });
const page = await (await browser.newContext({ viewport: { width: 1360, height: 820 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(URL_BASE);
await page.waitForSelector('canvas.design-canvas');
await startDesign(page, { type: 'cnc', width: 300, height: 180, thickness: 18 });
const doc = () => page.evaluate(() => window.demonxDesign.doc());

// a picture: a dark disc on white, made in the page
const png = await page.evaluate(() => {
  const c = document.createElement('canvas'); c.width = 120; c.height = 80;
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 120, 80);
  const grad = g.createRadialGradient(60, 40, 2, 60, 40, 32); grad.addColorStop(0, '#000'); grad.addColorStop(1, '#fff');
  g.fillStyle = grad; g.beginPath(); g.arc(60, 40, 32, 0, Math.PI * 2); g.fill();
  return c.toDataURL('image/png').split(',')[1];
});
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ph-')), 'disc.png');
fs.writeFileSync(file, Buffer.from(png, 'base64'));

await page.getByRole('tablist', { name: 'Design, Laser or CNC' }).getByRole('tab', { name: 'CNC' }).click();
const side = page.locator('aside.side');
const icon = side.getByRole('button', { name: 'Photo toolpath' });
check(await icon.isEnabled(), 'the Photo icon is on with no shapes selected');
await icon.click();
const dlg = page.getByRole('dialog', { name: 'Photo toolpath' });
await dlg.waitFor();
const bb = await dlg.boundingBox();
check(bb && Math.abs(bb.x + bb.width - 1360) < 2, 'it opens as the panel on the far right');
check(await dlg.getByRole('button', { name: 'Calculate' }).isDisabled(), 'Calculate waits for a picture');
await dlg.getByLabel('Picture file').setInputFiles(file);
await dlg.getByLabel('Picture preview').waitFor();
check(await dlg.getByText('120 × 80 pixels').isVisible(), 'the picture is shown with its size');
await dlg.getByLabel('Picture width').fill('90'); await dlg.getByLabel('Picture width').press('Enter');
check((await dlg.getByText(/^60 mm$/).count()) === 1, 'the height follows the width (90 x 60 mm)');
await dlg.getByLabel('Spacing').fill('1'); await dlg.getByLabel('Spacing').press('Enter');
await dlg.getByLabel('Cut depth').fill('1.2'); await dlg.getByLabel('Cut depth').press('Enter');
await dlg.getByRole('button', { name: 'Calculate' }).click();
let d = await doc();
const tp = d.cnc.toolpaths[0];
check(tp && tp.kind === 'photo' && tp.photo.w === 120 && tp.photo.h === 80 && tp.photo.width === 90 && tp.photo.mode === 'lines' && tp.cutDepth === 1.2, 'Calculate adds a photo toolpath with the picture and settings');
check(Math.abs(tp.photo.x - 105) < 0.01 && Math.abs(tp.photo.y - 60) < 0.01, 'it sits in the middle of the material by default: ' + tp.photo.x + ', ' + tp.photo.y);
check(await side.getByText('Photo 1', { exact: true }).first().isVisible() && await side.getByText(/90 mm wide, lines/).isVisible(), 'and lists it');
const text = await side.innerText();
check(/cut \d+ mm/.test(text) && await side.getByRole('button', { name: /^Save G-code for this tool/ }).count() === 1, 'a G-code file is made');

// change it to dots
await side.getByRole('button', { name: 'Edit Photo 1' }).click();
const ed = page.getByRole('dialog', { name: 'Edit toolpath' });
await ed.waitFor();
check(await ed.getByLabel('Picture preview').isVisible(), 'editing shows the picture it already has');
await ed.getByRole('radio', { name: /Dots/ }).click();
await ed.getByLabel('Spacing').fill('2'); await ed.getByLabel('Spacing').press('Enter');
await ed.getByRole('button', { name: 'Save' }).click();
d = await doc();
check(d.cnc.toolpaths[0].photo.mode === 'dots' && d.cnc.toolpaths[0].photo.spacing === 2 && d.cnc.toolpaths[0].photo.w === 120, 'Save changes it to dots without sending the picture again');
check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
await browser.close();
process.exit(failures ? 1 : 0);
