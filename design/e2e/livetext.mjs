// Browser check for typing text on the drawing: click and type, the bar above shows font and height, Ctrl+Enter places it, double-click edits it, the curve handle bends it.
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
const box = await page.locator('canvas.design-canvas').boundingBox();
const atV = async (x, y) => { await page.waitForTimeout(200); const v = await page.evaluate(() => window.demonxDesignView()); return [box.x + v.w / 2 + (x - v.cx) * v.scale, box.y + v.h / 2 - (y - v.cy) * v.scale]; };
await page.getByRole('button', { name: 'Fit', exact: true }).click();
const tools = page.getByRole('navigation', { name: 'Tools' });
const bar = page.getByRole('group', { name: 'Text on the drawing' });
const input = page.getByLabel('Type the text here');

// click with the Text tool, then just type
await tools.getByRole('button', { name: /^Text \(A\)/ }).click();
const [cx, cy] = await atV(60, 80);
await page.mouse.click(cx, cy);
await input.waitFor({ state: 'attached' });
check(await bar.isVisible(), 'the bar above the drawing shows the text settings while typing');
check(await bar.getByLabel('Font').inputValue() === 'Roboto Bold' && await bar.getByLabel('Letter height').inputValue() === '20', 'font (Roboto Bold) and height (20) are in it');
await page.keyboard.type('Hello');
await page.waitForTimeout(400);
check((await doc()).shapes.length === 0, 'nothing is in the drawing yet, only drawn as a preview');
await page.screenshot({ path: '/tmp/design-live-text.png' });
// change the height from the bar: typing carries on
await bar.getByLabel('Letter height').fill('30'); await bar.getByLabel('Letter height').press('Enter');
await page.waitForTimeout(100);   // a person takes longer than this to go back to typing
check(!(await input.inputValue()).includes('\n'), 'the Enter that confirmed the height is not typed into the text as a new line');
await page.keyboard.type('!');
await page.keyboard.press('Control+Enter');
await page.waitForTimeout(300);
let d = await doc();
check(d.texts?.length === 1 && d.texts[0].text === 'Hello!' && d.texts[0].height === 30, 'Ctrl+Enter places "Hello!" at height 30: ' + d.texts?.[0]?.text + ', ' + d.texts?.[0]?.height);
check(d.shapes.length === 6, 'six letters');
check(await bar.count() === 0, 'and the bar goes away');

// Ctrl+Enter works from anywhere in the bar too, and counts a number typed there but not yet confirmed
await tools.getByRole('button', { name: /^Text \(A\)/ }).click();
await page.mouse.click(...(await atV(60, 20)));
await input.waitFor({ state: 'attached' });
await page.keyboard.type('Ab');
await bar.getByLabel('Letter spacing').click();
await bar.getByLabel('Letter spacing').fill('4');   // typed, not confirmed with Enter, and the focus is in the box
await page.keyboard.press('Control+Enter');
await page.waitForTimeout(400);
d = await doc();
check(d.texts?.length === 2 && d.texts[1].text === 'Ab' && d.texts[1].spacing === 4 && await bar.count() === 0, 'Ctrl+Enter with the focus in a box of the bar places the text, with the number typed there: ' + d.texts?.[1]?.spacing);
await page.keyboard.press('Control+z');
await page.waitForTimeout(150);
d = await doc();

// Escape drops a new text
await tools.getByRole('button', { name: /^Text \(A\)/ }).click();
await page.mouse.click(...(await atV(60, 30)));
await page.keyboard.type('nope');
await page.keyboard.press('Escape');
await page.waitForTimeout(150);
check((await doc()).shapes.length === 6 && await bar.count() === 0, 'Escape leaves the drawing as it was');

// double-click the text: it is edited where it stands
const tb = (() => { const b = d.shapes.map((s) => s.rings.flat()).flat(); const xs = b.map((p) => p[0]), ys = b.map((p) => p[1]); return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) }; })();
const [mx, my] = await atV((tb.x0 + tb.x1) / 2, (tb.y0 + tb.y1) / 2);
await page.mouse.dblclick(mx, my);
await input.waitFor({ state: 'attached' });
check(await bar.isVisible() && await bar.getByLabel('Letter height').inputValue() === '30', 'a double-click opens it for typing, with its settings (height 30) in the bar');
await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace');
await page.keyboard.type('?!');
await page.keyboard.press('Control+Enter');
await page.waitForTimeout(300);
d = await doc();
check(d.texts?.length === 1 && d.texts[0].text === 'Hell?!' && d.shapes.length === 6, 'edited in place to "Hell?!" (still one piece of text, 6 letters)');
const ox = Math.min(...d.shapes.map((s) => Math.min(...s.rings.flat().map((p) => p[0]))));
check(Math.abs(ox - tb.x0) < 0.6, 'and it stayed where it was (left edge ' + ox.toFixed(1) + ' vs ' + tb.x0.toFixed(1) + ')');

// the curve handle: pick the text, drag the square up
await page.mouse.move(box.x + 40, box.y + 40);
await page.keyboard.press('Control+a');
await page.waitForTimeout(150);
const tb2 = (() => { const b = d.shapes.map((s) => s.rings.flat()).flat(); const xs = b.map((p) => p[0]), ys = b.map((p) => p[1]); return { x0: Math.min(...xs), x1: Math.max(...xs), y1: Math.max(...ys) }; })();
const [hx, hy] = await atV((tb2.x0 + tb2.x1) / 2, tb2.y1);
await page.screenshot({ path: '/tmp/design-text-handle.png' });
await page.mouse.move(hx, hy - 22); await page.mouse.down(); await page.mouse.move(hx, hy - 22 - 30, { steps: 6 }); await page.mouse.up();
await page.waitForTimeout(300);
d = await doc();
check(d.texts?.[0]?.bend > 5, 'dragging the curve square up bends the text into an arch: ' + d.texts?.[0]?.bend + '°');
await page.mouse.move(box.x + 40, box.y + 40);
await page.keyboard.press('Control+a');
const b3 = d.shapes.map((s) => s.rings.flat()).flat(); const xs3 = b3.map((p) => p[0]), ys3 = b3.map((p) => p[1]);
const [hx3, hy3] = await atV((Math.min(...xs3) + Math.max(...xs3)) / 2, Math.max(...ys3));
await page.mouse.move(hx3, hy3 - 22); await page.mouse.down(); await page.mouse.move(hx3, hy3 - 22 + 200, { steps: 8 }); await page.mouse.up();
await page.waitForTimeout(300);
check((await doc()).texts?.[0]?.bend < 0, 'and dragging it down far enough makes a smile: ' + (await doc()).texts?.[0]?.bend + '°');
await page.keyboard.press('Control+z');
check((await doc()).texts?.[0]?.bend > 5, 'undo takes a bend back in one step');
// a font remembered from last time that is not here now (a font file loaded then) must not leave the text tool silent
await page.evaluate(() => localStorage.setItem('design-text', JSON.stringify({ font: 'Balloon', height: 25, align: 'left', spacing: 0, lineSpacing: 1, weld: true })));
await page.reload();
await startDesign(page);
await tools.getByRole('button', { name: /^Text \(A\)/ }).click();
await page.mouse.click(...(await atV(60, 80)));
await input.waitFor({ state: 'attached' });
check(await bar.getByLabel('Font').inputValue() === 'Roboto Bold', 'a remembered font that is not here is replaced by Roboto Bold');
await page.keyboard.type('Ok');
await page.keyboard.press('Control+Enter');
await page.waitForTimeout(400);
check((await doc()).texts?.[0]?.text === 'Ok', 'and the text is placed');
// a font that cannot be loaded says so in the bar
await tools.getByRole('button', { name: /^Text \(A\)/ }).click();
await page.mouse.click(...(await atV(60, 40)));
await input.waitFor({ state: 'attached' });
await bar.getByLabel('Font').evaluate((el) => { const o = document.createElement('option'); o.value = 'Nowhere Sans'; o.textContent = 'Nowhere Sans'; el.appendChild(o); });
await bar.getByLabel('Font').selectOption('Nowhere Sans');
await bar.getByRole('alert').waitFor();
check(/not available here/.test(await bar.getByRole('alert').innerText()), 'a font that cannot be loaded says so in the bar, and the cursor is still shown');
await page.keyboard.press('Escape');
check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
await browser.close();
process.exit(failures ? 1 : 0);
