// Macros panel (restart the server with a fresh DEMONX_DATA first: it saves macros and moves the simulator)
import { launch, open, connect } from './lib.mjs';
const b = await launch();
let ok = 0, bad = 0;
const check = (name, cond, extra = '') => { (cond ? ok++ : bad++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`); };
const p = await open(b, 1920, 1080); await connect(p);
const panel = p.locator('[data-panel=macros]');
const wpos = (i) => p.locator('.wpos').nth(i).innerText();

check('Move to Back is there from the start', (await panel.innerText()).includes('Move to Back'));
await panel.getByRole('button', { name: '▶ Move to Back' }).click();
await p.waitForTimeout(2500);
check('running it moves to X0 Y90', (await wpos(0)) === '0.00' && (await wpos(1)) === '90.00', `${await wpos(0)} ${await wpos(1)}`);

// a probing line is refused, with the reason
await panel.getByRole('button', { name: '+ New macro' }).click();
await panel.locator('input').fill('Bad probe');
await panel.locator('textarea').fill('G91\nG38.2 Z-25 F75');
await panel.getByRole('button', { name: 'Save' }).click(); await p.waitForTimeout(500);
check('a G38 macro is refused with the Probe panel pointer', (await panel.innerText()).includes('Use the Probe panel'));
check('and the editor stays open so nothing is lost', await panel.locator('textarea').count() === 1);

// a good one is saved, listed, and removable
await panel.locator('input').fill('Park');
await panel.locator('textarea').fill('G90\nG0 X10 Y10');
await panel.getByRole('button', { name: 'Save' }).click(); await p.waitForTimeout(500);
check('a valid macro is saved and listed', (await panel.innerText()).includes('Park') && await panel.locator('textarea').count() === 0);
await p.reload(); await p.waitForSelector('.panel'); await p.waitForTimeout(800);
check('it is still there after a reload (kept on the server)', (await p.locator('[data-panel=macros]').innerText()).includes('Park'));
await p.locator('[data-panel=macros]').getByRole('button', { name: 'Edit Park' }).click();
p.once('dialog', (d) => d.accept());
await p.locator('[data-panel=macros]').getByRole('button', { name: 'Delete' }).click(); await p.waitForTimeout(500);
check('and can be deleted', !(await p.locator('[data-panel=macros]').innerText()).includes('Park'));
check('no page errors', p.errors.length === 0, p.errors.join('; '));
console.log(`\n${ok} passed, ${bad} failed`);
await b.close(); process.exit(bad ? 1 : 0);
