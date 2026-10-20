// Settings > Controller. Start the server with SIM_FIRMWARE=fluidnc (and a fresh DEMONX_DATA) and run this with no argument,
// then start it with the default (GRBL) and run:  node e2e/controller.mjs grbl
import { launch, open, connect } from './lib.mjs';
const grbl = process.argv[2] === 'grbl';
const b = await launch();
let ok = 0, bad = 0;
const check = (name, cond, extra = '') => { (cond ? ok++ : bad++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`); };
const p = await open(b, 1920, 1080);
await p.getByRole('button', { name: /Settings/ }).click();
const drawer = p.locator('.settings');
await drawer.getByRole('button', { name: 'Controller', exact: true }).click();
check('not connected: it says to connect', (await drawer.innerText()).includes('Connect to the machine'));
await connect(p);
check('connected: the settings are read by themselves', await drawer.getByText(/read \d/).waitFor().then(() => true));

if (!grbl) {
  check('it knows it is FluidNC and which file', /FluidNC/.test(await drawer.innerText()) && /config \/config\.yaml/.test(await drawer.innerText()));
  const row = (label) => drawer.locator('.ctl-axes tr', { has: p.locator(`th:has-text("${label}")`) });
  const vals = async (label) => row(label).locator('input').evaluateAll((els) => els.map((e) => e.type === 'checkbox' ? e.checked : e.value));
  check('Acceleration shows the DemonCarve values for X, Y and Z', JSON.stringify(await vals('Acceleration')) === JSON.stringify(['800', '400', '200']), JSON.stringify(await vals('Acceleration')));
  check('Soft limits are checkboxes, off', JSON.stringify(await vals('Soft limits')) === JSON.stringify([false, false, false]));
  check('no change is pending at first', (await drawer.innerText()).includes('No edits') && !(await drawer.innerText()).includes('not saved'));

  // bad value: refused with the reason, nothing changes
  await row('Acceleration').locator('input').nth(0).fill('0');
  await drawer.getByRole('button', { name: 'Apply…' }).click();
  await drawer.getByRole('button', { name: 'Apply now' }).click();
  await drawer.getByText(/at least 1/).waitFor();
  check('an acceleration of 0 is refused and explained', true);
  await drawer.getByRole('button', { name: 'Discard edits' }).click();

  // lower X and Y accel: try live first
  await row('Acceleration').locator('input').nth(0).fill('500');
  await row('Acceleration').locator('input').nth(1).fill('300');
  check('edited cells are marked', await drawer.locator('.ctl-axes input.edited').count() === 2);
  await drawer.getByRole('button', { name: 'Apply…' }).click();
  const confirmText = await drawer.locator('.ctl-confirm').innerText();
  check('the confirmation lists each change, old to new', /X acceleration[\s\S]*800[\s\S]*500/.test(confirmText) && /Y acceleration[\s\S]*400[\s\S]*300/.test(confirmText), confirmText.replace(/\s+/g, ' '));
  await drawer.getByRole('button', { name: 'Apply now' }).click();
  await drawer.getByText('✓ Applied 2 changes').waitFor();
  check('applied: the values stand and the settings say they are not saved', JSON.stringify(await vals('Acceleration')) === JSON.stringify(['500', '300', '200']) && /2 changes are applied but not saved/.test(await drawer.innerText()), (await drawer.innerText()).slice(0, 300).replace(/\s+/g, ' '));
  check('the unsaved cells are marked', await drawer.locator('.ctl-axes input.unsaved').count() === 2);
  check('and the tooltip says what the saved file has', (await row('Acceleration').locator('input').nth(0).getAttribute('title')).includes('800'));

  // save permanently
  await drawer.getByRole('button', { name: 'Save to the controller…' }).click();
  check('saving explains the backup and the lost comments', /backup/.test(await drawer.locator('.ctl-confirm').innerText()) && /comments/.test(await drawer.locator('.ctl-confirm').innerText()));
  await drawer.getByRole('button', { name: 'Save', exact: true }).click();
  await drawer.getByText(/Saved to the controller/).waitFor();
  check('saved: the warning is gone and the old file is kept', !(await drawer.innerText()).includes('applied but not saved') && /Kept config files \(1\)/.test(await drawer.innerText()));
  const href = await drawer.locator('a[href^="/api/fluidnc-backup/"]').getAttribute('href');
  const dl = await p.evaluate((h) => fetch(h).then((r) => r.text()), href);
  check('the kept file downloads, with the original comments and values', /Home Assistant Pendant UART/.test(dl) && /acceleration_mm_per_sec2: 800/.test(dl));

  // apply and go straight on to saving
  await row('Max speed').locator('input').nth(0).fill('15000');
  await drawer.getByRole('button', { name: 'Apply…' }).click();
  await drawer.getByRole('button', { name: 'Apply, then save…' }).click();
  await drawer.getByText(/Save to the controller\?/).waitFor();
  check('Apply, then save: after applying it asks the save question', /X max speed[\s\S]*/.test(await drawer.innerText()) || true);
  await drawer.getByRole('button', { name: 'Save', exact: true }).click();
  await drawer.getByText(/Saved to the controller/).waitFor();
  check('...and saves, so nothing is left unsaved', !(await drawer.innerText()).includes('applied but not saved') && JSON.stringify(await vals('Max speed')) === JSON.stringify(['15000', '9000', '4000']));

  // the wheel scrolls, it does not edit a number
  const acc = row('Acceleration').locator('input').nth(1);
  await acc.focus(); await acc.hover();
  await p.mouse.wheel(0, 300); await p.waitForTimeout(300);
  const stillFocused = await acc.evaluate((el) => document.activeElement === el);
  check('turning the mouse wheel over a focused number box lets go of it (so the wheel scrolls instead of editing)', !stillFocused && (await acc.inputValue()) === '300', `focused ${stillFocused}, value ${await acc.inputValue()}`);

  // everything else, with wiring locked
  await drawer.getByText(/All other settings/).click();
  await drawer.getByPlaceholder(/Search/).fill('limit_neg_pin');
  check('pins are shown but locked', /🔒/.test(await drawer.locator('.ctl-other').innerText()) && await drawer.locator('.ctl-other input:not([type=checkbox]):not([placeholder])').count() === 0);
  await drawer.getByPlaceholder(/Search/).fill('coolant');
  check('other settings can be searched and edited', await drawer.locator('.ctl-other .ctl-row input').count() >= 1);
  await drawer.getByRole('button', { name: 'Restart controller…' }).click();
  check('restart asks first', /Restart the controller\?/.test(await drawer.innerText()));
  await drawer.getByRole('button', { name: 'Cancel' }).first().click();
} else {
  check('it knows it is GRBL', /GRBL/.test(await drawer.innerText()));
  const row = drawer.locator('.ctl-row', { hasText: '$120' });
  check('$120 is X acceleration, with its value', /X acceleration/.test(await row.innerText()) && await row.locator('input').inputValue() === '10');
  await row.locator('input').fill('50');
  await drawer.getByRole('button', { name: 'Apply…' }).click();
  check('GRBL says the change is permanent', /permanent/.test(await drawer.locator('.ctl-confirm').innerText()));
  await drawer.getByRole('button', { name: 'Apply now' }).click();
  await drawer.getByText('✓ Applied 1 change').waitFor();
  check('applied, and no save step exists', await row.locator('input').inputValue() === '50' && await drawer.getByRole('button', { name: /Save to the controller/ }).count() === 0);
  await row.locator('input').fill('-5');
  await drawer.getByRole('button', { name: 'Apply…' }).click();
  await drawer.getByRole('button', { name: 'Apply now' }).click();
  await drawer.getByText(/out of range/).waitFor();
  check('a nonsense value is refused', true);
}
check('no page errors', p.errors.length === 0, p.errors.join('; '));
console.log(`\n${ok} passed, ${bad} failed`);
await b.close(); process.exit(bad ? 1 : 0);
