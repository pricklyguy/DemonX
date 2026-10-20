// Browser check for the Design tab's tool bar: VCarve-style groups in four columns, snap pinned at the top, file buttons.
//
//   cd design && npm run build
//   DESIGN_DATA=$(mktemp -d) npm run serve &      (any fresh server)
//   node e2e/toolbar.mjs
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
// a short window: the snap boxes used to sit at the very bottom of the tool bar and were pushed out of sight
const page = await (await browser.newContext({ viewport: { width: 1280, height: 600 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(URL_BASE);
await page.waitForSelector('canvas.design-canvas');
await startDesign(page, { laser: '3018 + laser head' });
const tools = page.getByRole('navigation', { name: 'Tools' });

const grid = tools.getByRole('checkbox', { name: 'Grid' }), points = tools.getByRole('checkbox', { name: 'Points' });
const inView = async (loc) => { const b = await loc.boundingBox(); return !!b && b.y >= 0 && b.y + b.height <= 600; };
check(await inView(grid) && await inView(points), 'the Grid and Points snap boxes are at the top of the tool bar, in view on a short window');
check(await grid.isChecked() && await points.isChecked(), 'both snaps are on at the start');
await grid.uncheck();
check(!(await grid.isChecked()), 'the Grid box switches grid snap off');

for (const h of ['File Operations', 'Create Vectors', 'Edit Objects', 'Offset and Layout']) check(await tools.getByRole('heading', { name: h }).isVisible(), `the group "${h}" is there`);
const rect = await tools.getByRole('button', { name: /^Rectangle \(R\)/ }).boundingBox();
const circ = await tools.getByRole('button', { name: /^Circle \(C\)/ }).boundingBox();
const poly = await tools.getByRole('button', { name: 'Ellipse', exact: true }).boundingBox();
const text = await tools.getByRole('button', { name: /^Regular polygon/ }).boundingBox();
check(Math.abs(rect.y - circ.y) < 2 && Math.abs(circ.y - poly.y) < 2 && Math.abs(poly.y - text.y) < 2, 'the first four drawing tools sit side by side in one row (four columns)');


// the file buttons work: New asks for the job size, Save asks for a name, Import opens the file chooser
await tools.getByRole('button', { name: /^New design/ }).click();
await page.getByRole('dialog', { name: 'New design' }).waitFor();
check(true, 'the New button opens the New design dialog');
await page.getByRole('dialog', { name: 'New design' }).getByRole('button', { name: 'Cancel' }).click();
const chooser = page.waitForEvent('filechooser');
await tools.getByRole('button', { name: /^Import a vector file/ }).click();
check(!!(await chooser), 'Import a vector file opens the file chooser');
check(await tools.getByRole('button', { name: /^Import a bitmap/ }).isEnabled(), 'Import a bitmap is on (e2e/bitmap.mjs covers what it does)');
check(await tools.getByRole('button', { name: /^Save/ }).isEnabled() && await tools.getByRole('button', { name: /^Open a saved design/ }).isEnabled(), 'Open and Save are offered (e2e/save.mjs covers what they do)');
check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
await browser.close();
process.exit(failures ? 1 : 0);
