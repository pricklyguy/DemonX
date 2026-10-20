// Browser check for the Align and space card: align to the material, the selection or the first object, a group moving as one object, even spacing and a fixed gap.
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
const minX = (s) => Math.min(...s.rings[0].map((p) => p[0]));
const maxX = (s) => Math.max(...s.rings[0].map((p) => p[0]));
const minY = (s) => Math.min(...s.rings[0].map((p) => p[1]));
const mid = (s) => (Math.min(...s.rings[0].map((p) => p[1])) + Math.max(...s.rings[0].map((p) => p[1]))) / 2;

async function setup() {
  await run('delete', { ids: (await doc()).shapes.map((x) => x.id) });
  // a group of two (0..10 and 40..50), then a loose one at 100 and one at 200
  await run('add_rect', { x: 0, y: 0, w: 10, h: 10, layer: 'Layer 1' });
  await run('add_rect', { x: 40, y: 0, w: 10, h: 10, layer: 'Layer 1' });
  let sh = (await doc()).shapes;
  await run('group', { ids: [sh[0].id, sh[1].id] });
  await run('add_rect', { x: 100, y: 20, w: 10, h: 10, layer: 'Layer 1' });
  await run('add_rect', { x: 200, y: 40, w: 10, h: 10, layer: 'Layer 1' });
  await page.waitForTimeout(150);
  const cv = await page.locator('canvas.design-canvas').boundingBox();
  await page.mouse.move(cv.x + cv.width / 2, cv.y + cv.height / 2);
  await page.keyboard.press('Control+a');
  await page.waitForTimeout(100);
}
const xs = async () => (await doc()).shapes.map(minX);

await setup();
await page.getByRole('button', { name: /^Align and space/ }).click();
const A = page.getByRole('group', { name: 'Align' });
await A.waitFor();
check(await A.getByRole('radio', { name: 'Selection' }).isChecked(), 'the card aligns to the selection by default');
check(await A.getByText('A group moves as one object.').count() === 1, 'and says a group moves as one object');

await A.getByRole('button', { name: 'Align left edges' }).click();
let x = await xs();
check(x.join() === [0, 40, 0, 0].join(), 'Left to the selection: the group keeps its shape (0 and 40) and the others join its left edge: ' + x.join());
await page.keyboard.press('Control+z');

await A.getByRole('radio', { name: 'Material' }).check();
await A.getByRole('button', { name: 'Align right edges' }).click();
const w = (await doc()).workspace;
x = (await doc()).shapes.map(maxX);
check(x.join() === [w.width - 40, w.width, w.width, w.width].join(), 'Right to the material: the group as a whole has its right edge at the right of the work area (' + w.width + '), its two shapes still 40 apart: ' + x.join());
await A.getByRole('button', { name: 'Centre on both' }).click();
let sh = (await doc()).shapes;
check(Math.abs((minX(sh[2]) + maxX(sh[2])) / 2 - w.width / 2) < 1e-6 && Math.abs(mid(sh[2]) - w.height / 2) < 1e-6, 'Centre both ways puts a loose shape in the middle of the material');
const gmin = Math.min(minX(sh[0]), minX(sh[1])), gmax = Math.max(maxX(sh[0]), maxX(sh[1]));
check(Math.abs((gmin + gmax) / 2 - w.width / 2) < 1e-6 && Math.abs((maxX(sh[1]) - minX(sh[0])) - 50) < 1e-6, 'and the group by its whole box, still 50 wide');
await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z');
check((await xs()).join() === [0, 40, 100, 200].join(), 'undo puts everything back');

// the first object picked stays
await A.getByRole('radio', { name: 'First picked' }).check();
await A.getByRole('button', { name: 'Align left edges' }).click();
x = await xs();
check(x.join() === [0, 40, 0, 0].join(), 'First picked: the first (the group) stays where it is: ' + x.join());
await page.keyboard.press('Control+z');

// spacing
await A.getByRole('button', { name: 'Space evenly across' }).click();
sh = (await doc()).shapes;
check(Math.abs(minX(sh[2]) - 120) < 1e-6 && minX(sh[0]) === 0 && minX(sh[3]) === 200, 'evenly across counts the group as one box: the loose middle shape goes to 120 (' + minX(sh[2]) + ')');
await page.keyboard.press('Control+z');
await A.getByLabel('Space between objects').fill('5'); await A.getByLabel('Space between objects').press('Enter');
await A.getByRole('button', { name: 'Set the gap across' }).click();
sh = (await doc()).shapes;
check(Math.abs(minX(sh[2]) - 55) < 1e-6 && Math.abs(minX(sh[3]) - 70) < 1e-6 && minX(sh[0]) === 0 && minX(sh[1]) === 40, 'a 5 mm gap puts the loose shapes 5 mm after the group (55) and after each other (70): ' + minX(sh[2]) + ', ' + minX(sh[3]));
await page.screenshot({ path: '/tmp/design-align.png' });
check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
await browser.close();
process.exit(failures ? 1 : 0);
