// Spindle panel (restart the server with a fresh DEMONX_DATA first: the setup is saved)
import { launch, open, connect } from './lib.mjs';
const b = await launch();
let ok = 0, bad = 0;
const check = (name, cond, extra = '') => { (cond ? ok++ : bad++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`); };
const p = await open(b, 1920, 1080);
const panel = () => p.locator('[data-panel=spindle]');
const text = async () => (await panel().innerText()).replace(/\s+/g, ' ');
check('before connecting it says so', (await text()).includes('Not connected'));
await connect(p);
check('connected and idle: 0 RPM, spindle off', (await text()).includes('0 RPM') && (await text()).includes('Spindle off'), await text());
check('default buttons are only Spindle on (M3) and Off (M5)', (await panel().locator('.row.wrap button').allInnerTexts()).join('|') === 'Spindle on (M3)|Off (M5)', (await panel().locator('.row.wrap button').allInnerTexts()).join('|'));
const speeds = await panel().locator('select option').allInnerTexts();
check('speed list is 1k, 5k, 10k, 18k, 24k', speeds.join(',') === '1,000 RPM,5,000 RPM,10,000 RPM,18,000 RPM,24,000 RPM', speeds.join(','));

await panel().getByRole('button', { name: 'Spindle on (M3)' }).click(); await p.waitForTimeout(1200);
check('M3 starts at the chosen 10,000 RPM and the status says clockwise', (await text()).includes('10,000 RPM') && (await text()).includes('Spindle on, clockwise'), await text());
await panel().getByRole('button', { name: 'Faster' }).click(); await p.waitForTimeout(300);
check('+ picks 18,000 and offers to apply it to the running spindle', await panel().getByRole('button', { name: /Apply 18,000/ }).count() === 1);
check('...but the spindle is still at 10,000 until applied', (await panel().locator('.spindle-rpm').innerText()).includes('10,000'));
await panel().getByRole('button', { name: /Apply 18,000/ }).click(); await p.waitForTimeout(1200);
check('Apply changes the running speed', (await panel().locator('.spindle-rpm').innerText()).includes('18,000'), await panel().locator('.spindle-rpm').innerText());
check('and the Apply button goes away', await panel().getByRole('button', { name: /Apply/ }).count() === 0);

// choose which commands the panel offers: the vacuum on M7 / off on M9
const drawer = p.locator('.settings');
await panel().getByRole('button', { name: '⚙ Setup' }).click();
check('the panel gear opens Settings on the Spindle page', (await drawer.innerText()).includes('Highest RPM'));
await drawer.locator('label.chk', { hasText: 'M7' }).locator('input').check();
await drawer.locator('label.chk', { hasText: 'M9' }).locator('input').check();
await drawer.getByRole('button', { name: 'Save' }).click(); await p.waitForTimeout(600);
check('saving shows a Saved note and stays open', (await drawer.innerText()).includes('✓ Saved'));
await drawer.getByRole('button', { name: 'Close settings' }).click();
const btns = (await panel().locator('.row.wrap button').allInnerTexts()).join('|');
check('M7 and M9 buttons appear, in order, after saving', btns === 'Spindle on (M3)|Off (M5)|Mist / vacuum on (M7)|Coolant off (M9)', btns);
await panel().getByRole('button', { name: /Mist \/ vacuum on/ }).click(); await p.waitForTimeout(1000);
check('vacuum on shows in the status', (await text()).includes('mist / vacuum on'), await text());
await panel().getByRole('button', { name: 'Off (M5)' }).click(); await p.waitForTimeout(1000);
check('Off stops the spindle (RPM 0) and the status keeps showing the vacuum', (await text()).includes('0 RPM') && (await text()).includes('Spindle off · mist / vacuum on'), await text());
await panel().getByRole('button', { name: 'Coolant off (M9)' }).click(); await p.waitForTimeout(1000);
check('M9 turns the vacuum off', !(await text()).includes('mist'), await text());

// a bad setup is refused and says why
await panel().getByRole('button', { name: '⚙ Setup' }).click();
await drawer.getByLabel('Highest RPM').fill('12000');
await drawer.getByRole('button', { name: 'Save' }).click(); await p.waitForTimeout(500);
check('speeds above the highest RPM are refused', (await drawer.innerText()).includes('above the highest speed'), await drawer.innerText());
await p.keyboard.press('Escape');
check('Escape closes Settings', await drawer.count() === 0);

await p.reload(); await p.waitForSelector('.panel'); await p.waitForTimeout(800);
check('the buttons and the speed survive a reload', (await panel().locator('.row.wrap button').allInnerTexts()).length === 4 && (await panel().locator('select').evaluate((e) => e.options[e.selectedIndex].text)) === '18,000 RPM');
check('no page errors', p.errors.length === 0, p.errors.join('; '));
console.log(`\n${ok} passed, ${bad} failed`);
await b.close(); process.exit(bad ? 1 : 0);
