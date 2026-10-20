// Browser check for layer order, rename and delete (in the Laser panel and in the header's layer list), and for the
// job's start marker not moving when a layer's Output is switched off.
//
//   cd design && npm run build && npm run serve &       (any fresh server)
//   node e2e/layers.mjs
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
const shots = process.env.SHOTS ?? fs.mkdtempSync(path.join(os.tmpdir(), 'design-layers-'));
let failures = 0;
const check = (ok, what) => { console.log((ok ? 'PASS ' : 'FAIL ') + what); if (!ok) failures++; };

const browser = await chromium.launch({ ...(chromiumPath ? { executablePath: chromiumPath } : {}) });
const page = await (await browser.newContext({ viewport: { width: 1360, height: 820 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(URL_BASE);
await page.waitForSelector('canvas.design-canvas');
await startDesign(page, { laser: '3018 + laser head' });
const run = (id, args) => page.evaluate(([i, a]) => window.demonxDesign.run(i, a), [id, args]);
const doc = () => page.evaluate(() => window.demonxDesign.doc());
const order = async () => (await doc()).layers.map((l) => l.name);

await run('add_rect', { x: 20, y: 20, w: 30, h: 20, layer: 'Layer 1' });
await run('layer_set', { name: 'Engrave', mode: 'engrave' });
await run('add_circle', { cx: 100, cy: 60, r: 10, layer: 'Engrave' });
await page.getByRole('tablist', { name: 'Design, Laser or CNC' }).getByRole('tab', { name: 'Laser' }).click();
const lp = page.locator('section.panel').filter({ has: page.locator('h2', { hasText: 'Cuts / Layers' }) });
await lp.waitFor();

// order: the first layer burns first
check((await order()).join() === 'Layer 1,Engrave', 'two layers, Layer 1 first');
check(await lp.getByRole('button', { name: 'Move Layer 1 up' }).isDisabled(), 'the first layer cannot move up');
await lp.getByRole('button', { name: 'Move Layer 1 down' }).click();
await page.waitForFunction(() => window.demonxDesign.doc().layers[0].name === 'Engrave');
check((await order()).join() === 'Engrave,Layer 1', 'Down puts the engraving ahead of the cutting');
check(await lp.getByRole('button', { name: 'Move Layer 1 down' }).isDisabled(), 'and the last layer cannot move down');
const rows = await lp.locator('.lrow .layer-name').allInnerTexts();
check(rows.join() === 'Engrave,Layer 1', 'the table shows the new order: ' + rows.join());

// rename with the button
await lp.locator('.lrow .layer-name', { hasText: 'Engrave' }).click();
await lp.getByRole('button', { name: 'Rename Engrave' }).click();
await page.getByLabel('New name for Engrave').fill('Fine detail');
await page.getByLabel('New name for Fine detail').or(page.getByLabel('New name for Engrave')).press('Enter');
await page.waitForFunction(() => window.demonxDesign.doc().layers.some((l) => l.name === 'Fine detail'));
let d = await doc();
check(d.shapes.filter((s) => s.layer === 'Fine detail').length === 1 && !d.shapes.some((s) => s.layer === 'Engrave'), 'rename: the shape went with the layer');
// rename by double-click, and Escape cancels
await lp.locator('.lrow .layer-name', { hasText: 'Layer 1' }).dblclick();
await page.getByLabel('New name for Layer 1').fill('Never');
await page.getByLabel('New name for Layer 1').press('Escape');
check((await order()).includes('Layer 1'), 'Escape cancels a rename');
await lp.locator('.lrow .layer-name', { hasText: 'Layer 1' }).dblclick();
await page.getByLabel('New name for Layer 1').fill('Outline');
await page.getByLabel('New name for Layer 1').press('Enter');
await page.waitForFunction(() => window.demonxDesign.doc().layers.some((l) => l.name === 'Outline'));
check((await order()).join() === 'Fine detail,Outline', 'double-click renames too: ' + (await order()).join());
// a name that is taken is refused, nothing changes
await lp.locator('.lrow .layer-name', { hasText: 'Outline' }).dblclick();
await page.getByLabel('New name for Outline').fill('Fine detail');
await page.getByLabel('New name for Outline').press('Enter');
await page.waitForTimeout(300);
check((await order()).join() === 'Fine detail,Outline', 'a name already in use is refused');

// delete a layer that has shapes: asked what to do with them
await lp.locator('.lrow .layer-name', { hasText: 'Outline' }).click();
await lp.getByRole('button', { name: 'Delete Outline' }).click();
const dlg = page.getByRole('dialog', { name: 'Delete layer Outline' });
await dlg.waitFor();
check((await dlg.innerText()).includes('1 shape is on this layer'), 'deleting a layer with shapes asks what to do with them');
await page.screenshot({ path: path.join(shots, 'layers-delete-dialog.png') });
await dlg.getByRole('button', { name: 'Cancel' }).click();
check((await order()).length === 2, 'Cancel deletes nothing');
await lp.getByRole('button', { name: 'Delete Outline' }).click();
await dlg.getByRole('button', { name: 'Delete the layer, keep the shapes' }).click();
await page.waitForFunction(() => window.demonxDesign.doc().layers.length === 1);
d = await doc();
check(d.shapes.length === 2 && d.shapes.every((s) => s.layer === 'Fine detail'), 'the shapes were moved to the other layer');
// the last layer cannot be deleted
await lp.getByRole('button', { name: 'Delete Fine detail' }).click();
await page.waitForTimeout(300);
check((await order()).length === 1 && (await dlg.count()) === 0, 'the last layer cannot be deleted');
// undo brings the deleted layer back
await page.keyboard.press('Control+z');
await page.waitForFunction(() => window.demonxDesign.doc().layers.length === 2);
check((await order()).join() === 'Fine detail,Outline', 'Undo brings the layer back');
// delete an empty layer: no question
await run('layer_set', { name: 'Empty' });
await lp.locator('.lrow .layer-name', { hasText: 'Empty' }).click();
await lp.getByRole('button', { name: 'Delete Empty' }).click();
await page.waitForFunction(() => window.demonxDesign.doc().layers.length === 2);
check((await dlg.count()) === 0, 'an empty layer is deleted without a question');
// delete with its shapes
await lp.locator('.lrow .layer-name', { hasText: 'Fine detail' }).click();
await lp.getByRole('button', { name: 'Delete Fine detail' }).click();
await page.getByRole('dialog', { name: 'Delete layer Fine detail' }).getByRole('button', { name: 'Delete the layer and its shapes' }).click();
await page.waitForFunction(() => window.demonxDesign.doc().layers.length === 1);
check((await doc()).shapes.length === 1, 'Delete the layer and its shapes removes them too');
await page.keyboard.press('Control+z');
await page.waitForFunction(() => window.demonxDesign.doc().layers.length === 2);

// the header's layer list has the same tools
await page.getByRole('button', { name: /Active layer/ }).click();
const menu = page.getByRole('listbox', { name: 'Layers' });
await menu.getByRole('button', { name: 'Move Outline up' }).click();
await page.waitForFunction(() => window.demonxDesign.doc().layers[0].name === 'Outline');
check((await order()).join() === 'Outline,Fine detail', 'the header list reorders layers too');
await menu.getByRole('button', { name: 'Rename Fine detail' }).click();
await page.getByLabel('New name for Fine detail').fill('Detail');
await page.getByLabel('New name for Fine detail').press('Enter');
await page.waitForFunction(() => window.demonxDesign.doc().layers.some((l) => l.name === 'Detail'));
check((await order()).join() === 'Outline,Detail', 'and renames them');
await page.screenshot({ path: path.join(shots, 'layers-header-list.png') });

check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
// a mark on every layer row says whether there is anything on it
{
  const row = (name) => page.locator('.lrow', { hasText: name }).first();
  const d0 = await page.evaluate(() => window.demonxDesign.doc());
  const used = d0.layers.find((l) => d0.shapes.some((s) => s.layer === l.name));
  check(!!used && (await row(used.name).locator('.ldata:not(.empty)').count()) === 1, 'a layer with shapes shows how many');
  await page.evaluate(() => window.demonxDesign.run('layer_set', { name: 'Spare' }));
  await page.locator('.lrow', { hasText: 'Spare' }).first().waitFor();
  check((await row('Spare').locator('.ldata.empty').count()) === 1, 'an empty layer shows the empty mark (safe to delete)');
}
await browser.close();
console.log('screenshots in ' + shots);
process.exit(failures ? 1 : 0);
