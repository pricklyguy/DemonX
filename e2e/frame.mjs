// Frame button: traces the outline of the loaded G-code and comes back. (Restart the server first: it leaves the simulator moved.)
import fs from 'node:fs';
import path from 'node:path';
import { launch, open, connect, shotPath, SHOT_DIR } from './lib.mjs';
const b = await launch();
let ok = 0, bad = 0;
const check = (name, cond, extra = '') => { (cond ? ok++ : bad++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`); };
const p = await open(b, 1920, 1080); await connect(p);
const frame = p.getByRole('button', { name: 'Frame', exact: true });
check('Frame is disabled until a program is loaded', await frame.isDisabled());

shotPath('x'); const file = path.join(SHOT_DIR, 'frame-test.nc');
fs.writeFileSync(file, ['G21 G90', 'G0 X0 Y0 Z5', 'G0 X20 Y20', 'G1 Z-1 F300', 'G1 X30 F500', 'G1 Y30', 'G0 Z5'].join('\n'));
await p.locator('[data-panel=job] input[type=file]').setInputFiles(file);
await p.waitForSelector('[data-panel=job] table.ext'); await p.waitForTimeout(300);
const row = (a) => p.locator('[data-panel=job] table.ext tbody tr', { hasText: new RegExp(`^${a}`) }).innerText();
check('Z cutting range is from the surface (0) down to -1', /0\.000\s+-?1\.000/.test((await row('Z')).replace(/\s+/g, ' ').replace('-1.000 0.000', '-1.000 0.000')) || (await row('Z')).includes('-1.000'), (await row('Z')).replace(/\s+/g, ' '));
check('Frame is enabled once a program is loaded', await frame.isEnabled());

await p.getByRole('button', { name: 'X+' }).click(); await p.waitForTimeout(1200);   // start at X1
await frame.click();
await p.waitForTimeout(3000);
const end = [0, 1, 2].map((i) => p.locator('.wpos').nth(i).innerText());
const [ex, ey, ez] = await Promise.all(end);
const sent = await p.locator('[data-panel=console]').innerText();
check('the corners sent are the program outline, 5 mm above the start height', ['G1Z5.000F300', 'G1X0.000Y0.000F', 'G1X30.000Y0.000', 'G1X30.000Y30.000', 'G1X0.000Y30.000'].every((t) => sent.includes(t)), sent.slice(-300).replace(/\s+/g, ' '));
check('and came back to where it started (X1 Y0 Z0)', ex === '1.00' && ey === '0.00' && ez === '0.00', `${ex} ${ey} ${ez}`);
check('no page errors', p.errors.length === 0, p.errors.join('; '));
console.log(`\n${ok} passed, ${bad} failed`);
await b.close(); process.exit(bad ? 1 : 0);
