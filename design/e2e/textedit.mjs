// Browser check for editing text: Edit text (words, spacing), running it along a circle, and Text to lines.
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
const doc = () => page.evaluate(() => window.demonxDesign.doc());
const run = (id, args) => page.evaluate(([i, a]) => window.demonxDesign.run(i, a), [id, args]);
const cv = await page.locator('canvas.design-canvas').boundingBox();
const selectAll = async () => { await page.mouse.move(cv.x + cv.width / 2, cv.y + cv.height / 2); await page.keyboard.press('Control+a'); await page.waitForTimeout(150); };
const editBtn = page.getByRole('button', { name: /^Edit text/ });
const linesBtn = page.getByRole('button', { name: /^Text to lines/ });

await page.evaluate(async () => { await window.demonxDesign.loadFont('Bebas Neue'); });
await run('add_text', { text: 'HI', x: 40, y: 100, height: 20, font: 'Bebas Neue', layer: 'Layer 1' });
await page.waitForTimeout(150);
let d = await doc();
check(d.shapes.length === 2 && d.shapes.every((s) => s.group === d.shapes[0].group) && d.texts?.length === 1, 'text comes out grouped (2 letters) with an editable record');
await page.mouse.click(cv.x + cv.width - 60, cv.y + cv.height - 60); await page.waitForTimeout(100);
check(await editBtn.isDisabled(), 'Edit text is off while nothing is picked');
await selectAll();
check(await editBtn.isEnabled() && await linesBtn.isEnabled(), 'and on once the text is picked');

await editBtn.click();
const live = page.getByRole('group', { name: 'Text on the drawing' });
await live.waitFor();
check((await page.getByLabel('Type the text here').inputValue()) === 'HI', 'with the text alone picked, Edit text types over it on the drawing, with the words in it');
check((await live.getByLabel('Letter height').inputValue()) === '20', 'and the height (20) in the bar above');
await page.keyboard.type('YA');
await live.getByLabel('Letter spacing').fill('3'); await live.getByLabel('Letter spacing').press('Enter');
await page.waitForTimeout(150);
await page.keyboard.press('Control+Enter');
await page.waitForTimeout(250);
const dlg = page.getByRole('dialog', { name: 'Edit text' });
d = await doc();
check(d.shapes.length === 4 && d.texts?.[0]?.text === 'HIYA' && d.texts[0].spacing === 3, 'placing it changes the words to HIYA (4 letters) and the spacing to 3');
const b0 = Math.min(...d.shapes.map((s) => Math.min(...s.rings[0].map((p) => p[0]))));
check(Math.abs(b0 - 40) < 2, 'and the text stays where it was (left edge at ' + b0.toFixed(1) + ')');
await page.keyboard.press('Control+z');
check((await doc()).texts?.[0]?.text === 'HI', 'undo takes the edit back in one step');

// along a circle
await run('add_circle', { cx: 100, cy: 80, r: 40, layer: 'Layer 1' });
await page.waitForTimeout(150);
await selectAll();
await editBtn.click();
await dlg.waitFor();
const along = dlg.getByRole('checkbox', { name: 'Run along a curve' });
check(await along.isEnabled() && await along.isChecked(), 'with the circle picked too, Run along a curve is offered (and on)');
await dlg.getByRole('button', { name: 'Apply' }).click();
await page.waitForTimeout(250);
d = await doc();
const letters = d.shapes.filter((s) => s.group !== undefined);
const radii = letters.map((s) => { const xs = s.rings[0].map((p) => p[0]), ys = s.rings[0].map((p) => p[1]); return Math.hypot((Math.min(...xs) + Math.max(...xs)) / 2 - 100, (Math.min(...ys) + Math.max(...ys)) / 2 - 80); });
check(d.texts?.[0]?.curve && letters.length === 2 && radii.every((r) => r > 40 && r < 65), 'the letters stand on the outside of the circle: ' + radii.map((r) => r.toFixed(1)).join(', ') + ' mm from its centre');
await page.screenshot({ path: '/tmp/design-text-curve.png' });

// turn off again, then to lines
await page.keyboard.press('Control+z');
await selectAll();
await linesBtn.click();
await page.waitForTimeout(150);
d = await doc();
check(!d.texts?.length && d.shapes.filter((s) => s.layer === 'Layer 1' && s.kind === 'path').every((s) => s.group === undefined), 'Text to lines frees the letters and drops the record');
await selectAll();
check(await editBtn.isDisabled(), 'and Edit text is off for them');
check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
await browser.close();
process.exit(failures ? 1 : 0);
