// Browser check for the keyboard shortcuts: the gear opens the list, a key is changed by pressing it, the tool bar follows, a taken key moves, Reset puts it back, and the choice is remembered.
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
await page.goto(URL_BASE);
await page.waitForSelector('canvas.design-canvas');
await startDesign(page, { laser: '3018 + laser head' });
const tools = page.getByRole('navigation', { name: 'Tools' });
const pressed = async (name) => (await tools.getByRole('button', { name }).getAttribute('aria-pressed')) === 'true';
const cv = await page.locator('canvas.design-canvas').boundingBox();
await page.mouse.move(cv.x + 300, cv.y + 300);

// the defaults work
await page.keyboard.press('r');
check(await pressed(/^Rectangle \(R\)/), 'R picks the Rectangle tool to begin with');
await page.keyboard.press('v');

await tools.getByRole('button', { name: /^Keyboard shortcuts \(the gear\)/ }).click();
const D = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
await D.waitFor();
check((await D.getByRole('button', { name: 'Key for Rectangle' }).innerText()) === 'R', 'the list shows Rectangle on R');
check((await D.getByRole('button', { name: 'Key for Ungroup' }).innerText()) === 'Ctrl+Shift+G', 'and Ungroup on Ctrl+Shift+G');

// change Rectangle to Q
await D.getByRole('button', { name: 'Key for Rectangle' }).click();
await D.getByRole('button', { name: 'Key for Rectangle' }).filter({ hasText: 'Press a key' }).waitFor();
await page.keyboard.press('q');
check((await D.getByRole('button', { name: 'Key for Rectangle' }).innerText()) === 'Q', 'pressing Q gives it to Rectangle');
// it takes a key that was Circle's
await D.getByRole('button', { name: 'Key for Rectangle' }).click();
await page.keyboard.press('c');
check((await D.getByRole('button', { name: 'Key for Circle' }).innerText()) === 'none', 'a key that was taken leaves the other action with none (Circle)');
check(await D.getByRole('status').innerText().then((t) => /Circle now has no key/.test(t)), 'and says so');
// Escape cancels, a reserved key is refused
await D.getByRole('button', { name: 'Key for Trim' }).click();
await page.keyboard.press('Space');
check(await D.getByRole('status').innerText().then((t) => /fixed/.test(t)), 'Space is kept for panning and is refused');
await page.keyboard.press('Escape');
check((await D.getByRole('button', { name: 'Key for Trim' }).innerText()) === 'T', 'Escape leaves it as it was');
await page.keyboard.press('Escape');
await D.waitFor({ state: 'detached' });

// the tool bar and the keys follow
check(await tools.getByRole('button', { name: /^Rectangle \(C\)/ }).count() === 1, 'the tool bar says Rectangle (C)');
await page.mouse.move(cv.x + 300, cv.y + 300);
await page.keyboard.press('r');
check(await pressed(/^Select/), 'R does nothing now');
await page.keyboard.press('c');
check(await pressed(/^Rectangle/), 'C picks Rectangle');
await page.keyboard.press('v');

// remembered after a reload, and Reset all
await page.reload();
await startDesign(page);
check(await tools.getByRole('button', { name: /^Rectangle \(C\)/ }).count() === 1, 'the change is remembered after a reload');
await tools.getByRole('button', { name: /^Keyboard shortcuts \(the gear\)/ }).click();
await D.waitFor();
await D.getByRole('button', { name: 'Reset all' }).click();
check((await D.getByRole('button', { name: 'Key for Rectangle' }).innerText()) === 'R' && (await D.getByRole('button', { name: 'Key for Circle' }).innerText()) === 'C', 'Reset all puts every key back');
await D.getByRole('button', { name: 'Close' }).click();
check(await tools.getByRole('button', { name: /^Rectangle \(R\)/ }).count() === 1, 'and the tool bar with them');

// an Edit key can move too: Delete -> X
await tools.getByRole('button', { name: /^Keyboard shortcuts \(the gear\)/ }).click();
await D.getByRole('button', { name: 'Key for Duplicate' }).click();
await page.keyboard.press('Control+Shift+d');
check((await D.getByRole('button', { name: 'Key for Duplicate' }).innerText()) === 'Ctrl+Shift+D', 'a key with Ctrl and Shift is taken whole');
await D.getByRole('button', { name: 'Close' }).click();
await page.evaluate(() => window.demonxDesign.run('add_rect', { x: 10, y: 10, w: 10, h: 10, layer: 'Layer 1' }));
await page.mouse.move(cv.x + 300, cv.y + 300);
await page.keyboard.press('Control+a');
await page.keyboard.press('Control+d');
check((await page.evaluate(() => window.demonxDesign.doc().shapes.length)) === 1, 'the old Ctrl+D does nothing now');
await page.keyboard.press('Control+Shift+d');
await page.waitForTimeout(150);
check((await page.evaluate(() => window.demonxDesign.doc().shapes.length)) === 2, 'and the new Ctrl+Shift+D duplicates');
await page.evaluate(() => localStorage.removeItem('design-shortcuts'));
check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
await browser.close();
process.exit(failures ? 1 : 0);
