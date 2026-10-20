// PCB mode (restart the server with a fresh DEMONX_DATA first: the setup is saved and the simulator moves)
import { launch, open, connect } from './lib.mjs';
const b = await launch();
let ok = 0, bad = 0;
const check = (name, cond, extra = '') => { (cond ? ok++ : bad++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`); };
const p = await open(b, 1920, 1080); await connect(p);
const drawer = p.locator('.settings');
const header = p.locator('.header');
const pcb = () => p.locator('[data-panel=pcb]');
const wpos = (i) => p.locator('[data-panel=position] .wpos').nth(i).innerText();
const mpos = (i) => p.locator('[data-panel=position] .mpos').nth(i).innerText();
const send = async (line) => { await p.getByPlaceholder(/Send command/).fill(line); await p.keyboard.press('Enter'); };

check('the panel invites you to set up the fixture first', (await pcb().innerText()).includes('Set up the fixture'));
await header.getByRole('button', { name: '▣ PCB', exact: true }).click();
check('the header button opens the PCB page of Settings when nothing is set up', (await drawer.innerText()).includes('Capture X and Y'));

// home normally, move somewhere, capture it as the fixture
await drawer.getByRole('button', { name: 'Close settings' }).click();
await p.locator('[data-panel=position]').getByRole('button', { name: 'Home', exact: true }).click(); await p.waitForTimeout(500);
await send('G90 G0 X30 Y20 Z-5'); await p.waitForTimeout(2500);
check('the tool is at machine X30 Y20 Z-5', (await mpos(0)) === '30.00' && (await mpos(1)) === '20.00' && (await mpos(2)) === '-5.00', `${await mpos(0)} ${await mpos(1)} ${await mpos(2)}`);
await header.getByRole('button', { name: '▣ PCB', exact: true }).click();
await drawer.getByRole('button', { name: /Capture X and Y/ }).click();
await drawer.getByRole('button', { name: /Capture Z/ }).click(); await p.waitForTimeout(300);
const vals = await drawer.locator('input[type=number]').evaluateAll((els) => els.map((e) => e.value));
check('Capture fills in the fixture X, Y and the safe Z from the tool', JSON.stringify(vals) === JSON.stringify(['30', '20', '-5']), JSON.stringify(vals));
await drawer.locator('input[type=number]').nth(0).fill('100');
await drawer.locator('input[type=number]').nth(1).fill('50');
await drawer.locator('input[type=number]').nth(2).fill('-10');
await drawer.getByRole('button', { name: 'Save', exact: true }).click();
await drawer.getByText('✓ Saved').waitFor();
check('saved: the setup is on the machine', /Saved on the machine/.test(await drawer.innerText()));
await drawer.getByRole('button', { name: 'Close settings' }).click();

// the mode
check('now the header button turns the mode on', await header.getByRole('button', { name: '▣ PCB', exact: true }).count() === 1);
await header.getByRole('button', { name: '▣ PCB', exact: true }).click();
await header.getByRole('button', { name: /PCB MODE ON/ }).waitFor();
check('PCB mode is on: the header says so and the panel shows the workflow', (await pcb().innerText()).includes('PCB MODE IS ON') && (await pcb().innerText()).includes('PCB Home'));
check('the normal Home button is off', await p.locator('[data-panel=position]').getByRole('button', { name: 'Home', exact: true }).isDisabled());
await send('$H'); await p.waitForTimeout(400);
check('typing $H in the console is refused with the reason', (await p.locator('[data-panel=console]').innerText()).includes('PCB mode is on: turn it off to home the machine'));

// PCB Home
await pcb().getByRole('button', { name: /PCB Home/ }).click();
await p.waitForFunction(() => document.querySelector('[data-panel=pcb]')?.innerText.includes('✓'), null, { timeout: 15000 });
await p.waitForTimeout(800);
check('PCB Home: the tool is at machine X100 Y50 and work X0 Y0 is there', (await mpos(0)) === '100.00' && (await mpos(1)) === '50.00' && (await wpos(0)) === '0.00' && (await wpos(1)) === '0.00', `m ${await mpos(0)},${await mpos(1)} w ${await wpos(0)},${await wpos(1)}`);
check('...and the first step is ticked', /✓\s*Work X0 Y0 at the fixture/.test(await pcb().innerText()), (await pcb().innerText()).replace(/\s+/g, ' ').slice(0, 200));
check('the Z was already above the safe height (-10), so it was not lowered', (await mpos(2)) === '-5.00', await mpos(2));

// leaving the mode
await header.getByRole('button', { name: /PCB MODE ON/ }).click();
await header.getByRole('button', { name: '▣ PCB', exact: true }).waitFor();
check('turning it off enables Home again and clears the tick', await p.locator('[data-panel=position]').getByRole('button', { name: 'Home', exact: true }).isEnabled() && !(await pcb().innerText()).includes('✓'));
check('no page errors', p.errors.length === 0, p.errors.join('; '));
console.log(`\n${ok} passed, ${bad} failed`);
await b.close(); process.exit(bad ? 1 : 0);
