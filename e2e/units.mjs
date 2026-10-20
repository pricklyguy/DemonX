// mm / inch toggle: values are shown and typed in the chosen unit, but stay millimetres underneath.
import { launch, open, connect } from './lib.mjs';
const b = await launch();
let ok = 0, bad = 0;
const check = (name, cond, extra = '') => { (cond ? ok++ : bad++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`); };
const p = await open(b, 1920, 1080); await connect(p);
const wpos = () => p.locator('.wpos').first().innerText();
const xyStep = () => p.locator('[data-panel=jog] select[aria-label="XY step"]');
const zStep = () => p.locator('[data-panel=jog] select[aria-label="Z step"]');
const shown = (loc) => loc.evaluate((el) => el.options[el.selectedIndex].text);
const toggle = () => p.locator('.header').getByRole('button', { name: /^(mm|inch)$/ });

await xyStep().selectOption({ label: '5 mm' });
await p.getByRole('button', { name: 'X+' }).click(); await p.waitForTimeout(1200);
check('starts in mm: X is 5.00', (await wpos()) === '5.00', await wpos());
check('the toggle says mm', (await toggle().innerText()) === 'mm');

await toggle().click(); await p.waitForTimeout(300);
check('inch: X 5 mm shows as 0.197', (await wpos()) === '0.197', await wpos());
check('the 5 mm step became 0.2 in (nearest in the list)', (await shown(xyStep())) === '0.25 in', await shown(xyStep()));
const steps = await xyStep().locator('option').allInnerTexts();
check('inch XY steps run 0.001 in to 20 in', steps[0] === '0.001 in' && steps.at(-1) === '20 in' && steps.includes('4 in'), steps.join(' | '));
const zsteps = await zStep().locator('option').allInnerTexts();
check('inch Z steps stop at 0.5 in (the 20 mm cap)', zsteps.at(-1) === '0.5 in', zsteps.join(' | '));
check('feed is shown in inches', /in\/min/.test(await p.locator('[data-panel=jog]').innerText()));
await xyStep().selectOption({ label: '0.5 in' });
await p.getByRole('button', { name: 'X+' }).click(); await p.waitForTimeout(1200);
check('a 0.5 in step moves 12.7 mm (X now 17.7 mm = 0.697 in)', (await wpos()) === '0.697', await wpos());

// the - and + buttons walk the list; a big step converts to the nearest one in the other unit
await p.getByRole('button', { name: 'Larger step' }).first().click();
check('+ moves to the next step (1 in)', (await shown(xyStep())) === '1 in', await shown(xyStep()));
await xyStep().selectOption({ label: '4 in' });
await toggle().click(); await p.waitForTimeout(300);
check('4 in becomes 100 mm', (await shown(xyStep())) === '100 mm', await shown(xyStep()));
await p.getByRole('button', { name: 'X+' }).click(); await p.waitForTimeout(1500);
check('a 100 mm step really moves 100 mm (X 17.7 + 100)', (await wpos()) === '117.70', await wpos());
await p.getByRole('button', { name: 'Smaller step' }).first().click();
check('- moves to the previous step (50 mm)', (await shown(xyStep())) === '50 mm', await shown(xyStep()));
await toggle().click(); await p.waitForTimeout(300);

// typing in inches is stored in mm
const feedBox = p.locator('[data-panel=jog] input[type=number]').first();
await feedBox.fill('100');
check('100 in/min is saved as 2540 mm/min', (await p.evaluate(() => localStorage.getItem('jogFeedXY'))) === '2540');
await feedBox.fill(''); await feedBox.pressSequentially('12.5');   // typed key by key, like a person
check('typing 12.5 key by key gives 12.5 in/min (317.5 mm/min)', (await feedBox.inputValue()) === '12.5' && (await p.evaluate(() => localStorage.getItem('jogFeedXY'))) === '317.5', await feedBox.inputValue());

// probe settings: endmill 6.35 mm is a quarter inch
await p.locator('[data-panel=probe] summary').click();
const endmill = p.locator('[data-panel=probe] .pform label', { hasText: 'Endmill' }).locator('input');
check('endmill 6.35 mm shows as 0.25 in', Number(await endmill.inputValue()) === 0.25, await endmill.inputValue());
await endmill.fill('0.125');
check('typing 0.125 in saves 3.175 mm', JSON.parse(await p.evaluate(() => localStorage.getItem('probeForm'))).endmill === 3.175);

// the choice is kept by this browser, and back to mm everything returns
await p.reload(); await p.waitForSelector('.panel'); await p.waitForTimeout(800);
check('inch is remembered after a reload', (await toggle().innerText()) === 'inch');
await toggle().click(); await p.waitForTimeout(300);
check('back to mm: X is 117.70', (await wpos()) === '117.70', await wpos());
await p.locator('[data-panel=probe] summary').click().catch(() => {});
check('no page errors', p.errors.length === 0, p.errors.join('; '));
console.log(`\n${ok} passed, ${bad} failed`);
await b.close(); process.exit(bad ? 1 : 0);
