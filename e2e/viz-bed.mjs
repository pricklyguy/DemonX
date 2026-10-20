// The 3D view knows the machine's size: it frames the whole machine before a file is loaded (so the tool is never off screen on a big
// machine), zooms to the file once one is loaded, and a typed-in size can replace what the controller says.
// Start a fresh server first as a FluidNC machine (a DemonCarve-style config, X 1219 by Y 1310 mm):
//   SIM_FIRMWARE=fluidnc SIM_SPEED=30 DEMONX_DATA=/tmp/demonx-e2e PORT=8080 npm start
import fs from 'node:fs';
import path from 'node:path';
import { launch, open, connect, shotPath, SHOT_DIR } from './lib.mjs';
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) process.exitCode = 1; };
const b = await launch();
const p = await open(b, 1300, 900);
await connect(p);
const target = async () => (await p.locator('[data-target]').first().getAttribute('data-target')).split(',').map(Number);
const near = (a, v, tol) => Math.abs(a - v) <= tol;

await p.getByRole('button', { name: 'Machine', exact: true }).waitFor({ timeout: 15000 });
await p.waitForTimeout(500);
let [tx, ty] = await target();
ok(near(tx, 619.5, 2) && near(ty, 665, 2), `before a file is loaded the view is centred on the whole machine (${tx.toFixed(1)}, ${ty.toFixed(1)})`);

ok(/Machine size: X 1219 by Y 1310 mm, from the FluidNC settings/.test(await p.locator('[data-panel=console]').innerText()), 'the Console says where the machine size came from');

// the tool far from the origin is in view (it was off screen with the old 100 mm default)
const box = p.locator('input[placeholder*="Send command"]');
await box.fill('G90 G0 X800 Y900'); await box.press('Enter');
await p.waitForTimeout(3000);
ok(await p.locator('.viz-warn').count() === 0, 'a tool at X800 Y900 is in view (no "outside this view" warning)');

// a file zooms the view to the file
shotPath('x'); const file = path.join(SHOT_DIR, 'viz-bed.nc');
fs.writeFileSync(file, ['G21 G90', 'G0 X790 Y890 Z5', 'G1 X810 F500', 'G1 Y910', 'G0 Z5'].join('\n'));
await p.locator('[data-panel=job] input[type=file]').setInputFiles(file);
await p.waitForSelector('[data-panel=job] table.ext'); await p.waitForTimeout(800);
[tx, ty] = await target();
ok(near(tx, 800, 25) && near(ty, 900, 25), `with a file loaded the view zooms to it (${tx.toFixed(1)}, ${ty.toFixed(1)})`);

// the Machine button pulls back to the whole machine
await p.getByRole('button', { name: 'Machine', exact: true }).click(); await p.waitForTimeout(500);
[tx, ty] = await target();
ok(near(tx, 619.5, 60) && near(ty, 665, 60), `the Machine button frames the whole machine again (${tx.toFixed(1)}, ${ty.toFixed(1)})`);

// Settings shows what was read
await p.getByRole('button', { name: /⚙ Settings/ }).click();
await p.getByText('Machine size', { exact: true }).first().click();
const text = await p.locator('.settings-body').innerText();
ok(/Read from the controller \(FluidNC\)/.test(text) && /1219/.test(text) && /1310/.test(text), 'Settings > Machine size shows what the controller reported (X 1219, Y 1310)');

// Read again asks the controller once more and says so in the Console
await p.getByRole('button', { name: 'Read again' }).click(); await p.waitForTimeout(2500);
const lines = (await p.locator('[data-panel=console]').innerText()).match(/Machine size: X 1219/g) ?? [];
ok(lines.length >= 2, `Read again reads the controller again (${lines.length} messages in the Console)`);

// typed-in numbers replace it (the tool goes back to the origin first, so that it is inside the smaller machine)
await p.getByRole('button', { name: /⚙ Settings/ }).click();
await box.fill('G90 G0 X150 Y100'); await box.press('Enter'); await p.waitForTimeout(3000);
await p.getByRole('button', { name: /⚙ Settings/ }).click();
await p.getByText('Machine size', { exact: true }).first().click();
await p.getByLabel('Use my own numbers instead').check();
await p.locator('.settings-body label', { hasText: 'X (left to right) travel' }).locator('input[type=number]').fill('300');
await p.locator('.settings-body label', { hasText: 'Y (front to back) travel' }).locator('input[type=number]').fill('200');
// a machine that homes at the front left and the top: positions run from 0 up in X and Y
await p.getByLabel('X home').selectOption('min'); await p.getByLabel('Y home').selectOption('min');
await p.getByRole('button', { name: 'Save', exact: true }).click();
await p.waitForTimeout(500);
await p.getByRole('button', { name: /⚙ Settings/ }).click();
await p.getByRole('button', { name: 'Machine', exact: true }).click(); await p.waitForTimeout(500);
[tx, ty] = await target();
ok(near(tx, 150, 80) && near(ty, 100, 80), `a typed-in 300 by 200 machine that homes front left is framed instead (${tx.toFixed(1)}, ${ty.toFixed(1)})`);
ok(p.errors.length === 0, 'no page errors');
await b.close();
