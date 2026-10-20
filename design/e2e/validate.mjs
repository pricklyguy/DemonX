// Browser check for the Check vectors card: lists the problems, Show picks the shapes, Fix puts right what is safe.
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
const open = () => page.getByRole('button', { name: /^Check the vectors/ }).click();
const C = page.getByRole('group', { name: 'Check vectors' });

await run('add_rect', { x: 10, y: 10, w: 20, h: 20, layer: 'Layer 1' });
await open();
await C.waitFor();
await C.getByText('No problems found.').waitFor();
check(true, 'a clean drawing says No problems found');
await open();   // closes

// a nearly closed line, a shape drawn twice, a figure 8, and an open line
await run('add_path', { points: [[50, 10], [70, 10], [70, 30], [50, 30], [50, 10.05]], closed: false, layer: 'Layer 1' });
await run('add_rect', { x: 10, y: 10, w: 20, h: 20, layer: 'Layer 1' });
await run('add_path', { points: [[100, 10], [120, 30], [120, 10], [100, 30]], closed: true, layer: 'Layer 1' });
await run('add_path', { points: [[150, 10], [170, 30]], closed: false, layer: 'Layer 1' });
await page.waitForTimeout(150);
await open();
await C.getByRole('checkbox', { name: 'only the picked shapes' }).uncheck();   // the last shape drawn is picked; look at everything
await C.getByRole('list', { name: 'Problems' }).waitFor();
const text = await C.getByRole('list', { name: 'Problems' }).innerText();
check(/nearly meet/.test(text) && /identical one/.test(text) && /cross themselves/.test(text) && /open line/.test(text), 'it lists all four kinds of problem');
check(/can be fixed/.test(text), 'and says which can be fixed');

await C.getByRole('button', { name: 'Show self-cross' }).click();
await page.waitForTimeout(100);
check(await page.getByRole('group', { name: 'Selected shape' }).getByLabel('Width').inputValue() === '20', 'Show picks the shape it means (the figure 8, 20 wide)');

await C.getByRole('button', { name: 'Fix what can be fixed' }).click();
await page.waitForTimeout(300);
const d = await doc();
check(d.shapes.length === 4, 'Fix deletes the duplicate square and keeps the rest (4 shapes): ' + d.shapes.length);
check(d.shapes.some((s) => s.closed && s.rings[0].length === 4 && s.rings[0][0][0] === 50), 'and closes the nearly closed line');
const after = await C.getByRole('list', { name: 'Problems' }).innerText();
check(!/nearly meet/.test(after) && !/identical one/.test(after) && /cross themselves/.test(after) && /open line/.test(after), 'what is left is the crossing and the open line, which need a decision');
check(await C.getByRole('button', { name: 'Fix what can be fixed' }).isDisabled(), 'and Fix is off');
await page.keyboard.press('Control+z');
check((await doc()).shapes.length === 5, 'undo puts it all back in one step');
check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
await browser.close();
process.exit(failures ? 1 : 0);
