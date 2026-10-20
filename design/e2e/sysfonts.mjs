// Browser check for system fonts in the Text dialog, with a stand-in for the browser's Local Font Access (headless Chromium has no installed fonts to offer).
//
//   cd design && npm run build
//   DESIGN_DATA=$(mktemp -d) npm run serve &      (any fresh server)
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
await page.addInitScript(() => {
  // one "installed" font whose file is the Roboto Bold the app already loaded
  window.queryLocalFonts = async () => [{ family: 'Fake Sans', fullName: 'Fake Sans Bold', postscriptName: 'FakeSans-Bold', style: 'Bold', blob: async () => { const e = performance.getEntriesByType('resource').find((r) => /roboto-latin-700/.test(r.name)); return (await fetch(e.name)).blob(); } }];
});
await page.goto(URL_BASE);
await page.waitForSelector('canvas.design-canvas');
await startDesign(page, { laser: '3018 + laser head' });
const doc = () => page.evaluate(() => window.demonxDesign.doc());
const cv = await page.locator('canvas.design-canvas').boundingBox();
await page.getByRole('navigation', { name: 'Tools' }).getByRole('button', { name: /^Text \(A\)/ }).click();
await page.mouse.click(cv.x + 300, cv.y + 300);
const bar = page.getByRole('group', { name: 'Text on the drawing' });
await bar.waitFor();
check(await bar.getByRole('option', { name: 'Fake Sans Bold' }).count() === 0, 'the installed fonts are not listed until they are asked for');
await bar.getByRole('button', { name: 'System fonts…' }).click();
await bar.getByRole('option', { name: 'Fake Sans Bold' }).waitFor({ state: 'attached' });
check(true, 'System fonts… lists them under "On this computer"');
check((await bar.getByRole('button', { name: /1 system fonts/ }).count()) === 1, 'and the button says how many (1)');
await bar.getByLabel('Font', { exact: true }).selectOption('Fake Sans Bold');
await page.keyboard.type('Hi');
await page.waitForTimeout(500);
await page.keyboard.press('Control+Enter');
await page.waitForTimeout(300);
const d = await doc();
check(d.shapes.length === 2 && d.texts?.[0]?.font === 'Fake Sans Bold', 'the text is made from the installed font: ' + d.shapes.length + ' letters in ' + d.texts?.[0]?.font);
check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
await browser.close();
process.exit(failures ? 1 : 0);
