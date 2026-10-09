// Settings drawer: pages, which browser/machine they belong to, and that HOLD/RESET stay reachable (fresh DEMONX_DATA)
import { launch, open, connect } from './lib.mjs';
const b = await launch();
let ok = 0, bad = 0;
const check = (name, cond, extra = '') => { (cond ? ok++ : bad++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`); };
const p = await open(b, 1920, 1080); await connect(p);
const drawer = p.locator('.settings');
check('Settings is closed at first', await drawer.count() === 0);
await p.getByRole('button', { name: /Settings/ }).click();
check('it opens on the Layout page', (await drawer.innerText()).includes('Save as My layout'));
const nav = await drawer.locator('nav').innerText();
check('pages are grouped as This browser (Layout, Units, Appearance) and This machine (Camera, Home Assistant, Spindle)',
  /This browser[\s\S]*Layout[\s\S]*Units[\s\S]*Appearance[\s\S]*This machine[\s\S]*Camera[\s\S]*Home Assistant[\s\S]*Spindle/i.test(nav), nav.replace(/\s+/g, ' '));
const hold = await p.getByRole('button', { name: 'RESET', exact: true }).boundingBox(), box = await drawer.boundingBox();
check('the drawer sits below the header: HOLD / RESUME / RESET stay clickable', box.y >= hold.y + hold.height - 1, `reset y ${hold.y}+${hold.height}, drawer y ${box.y}`);
await p.getByRole('button', { name: 'RESET', exact: true }).click();   // would be blocked if the drawer covered it
check('...and RESET really clicks while Settings is open', true);

await drawer.getByRole('button', { name: 'Units', exact: true }).click();
await drawer.getByLabel(/Inches/).check(); await p.waitForTimeout(300);
check('Units page switches to inches (the header button follows)', (await p.locator('.header').getByRole('button', { name: /^(mm|inch)$/ }).innerText()) === 'inch');
await drawer.getByLabel(/Millimetres/).check();
await drawer.getByRole('button', { name: 'Appearance', exact: true }).click();
await drawer.getByLabel('Light', { exact: true }).check(); await p.waitForTimeout(200);
check('Appearance page switches to the light theme', (await p.evaluate(() => document.documentElement.dataset.theme)) === 'light');
await drawer.getByLabel('Dark', { exact: true }).check();

// colours: accent presets, custom colours, readability warnings, per-theme, saved, reset
const cssVar = (n) => p.evaluate((v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim(), n);
await drawer.getByRole('button', { name: 'Appearance', exact: true }).click();
check('built-in dark accent to start', (await cssVar('--accent')) === '#6aa84f');
await drawer.getByRole('button', { name: 'Blue' }).click();
check('the Blue accent applies to the whole page, with readable button text', (await cssVar('--accent')) === '#4f8fe0' && (await cssVar('--accent-text')) === '#0e0e0e', `${await cssVar('--accent')} ${await cssVar('--accent-text')}`);
check('the chosen swatch is marked', (await drawer.getByRole('button', { name: 'Blue' }).getAttribute('aria-pressed')) === 'true');
await drawer.getByLabel('Light', { exact: true }).check(); await p.waitForTimeout(200);
check('the light theme keeps its own colours (still the built-in green)', (await cssVar('--accent')) === '#3f7d2c', await cssVar('--accent'));
await drawer.getByRole('button', { name: 'Orange' }).click();
check('...and gets its own orange, tuned for light', (await cssVar('--accent')) === '#b85d14', await cssVar('--accent'));
await drawer.getByLabel('Dark', { exact: true }).check(); await p.waitForTimeout(200);
check('back in dark the blue is still there', (await cssVar('--accent')) === '#4f8fe0', await cssVar('--accent'));
await p.reload(); await p.waitForSelector('.panel'); await p.waitForTimeout(500);
check('the colours are kept for this browser after a reload', (await cssVar('--accent')) === '#4f8fe0');

await p.getByRole('button', { name: /Settings/ }).click();
await drawer.getByRole('button', { name: 'Appearance', exact: true }).click();
await drawer.getByText('Choose each colour').click();
await drawer.getByLabel('Text', { exact: true }).fill('#1e1d17');       // the panel colour: unreadable
await p.waitForTimeout(200);
check('text the same as the panel is flagged as hard to read', /text is hard to read/.test(await drawer.innerText()));
await drawer.getByLabel('Text', { exact: true }).fill('#ffffff');
await drawer.getByLabel('Panels', { exact: true }).fill('#102030');
await p.waitForTimeout(200);
check('a custom panel colour brings matching in-between colours', (await cssVar('--panel')) === '#102030' && /^#[0-9a-f]{6}$/.test(await cssVar('--panel2')) && (await cssVar('--panel2')) !== '#27261e', `${await cssVar('--panel')} ${await cssVar('--panel2')}`);
check('and the warning is gone', !/hard to read/.test(await drawer.innerText()));
await drawer.getByRole('button', { name: 'Reset to the built-in colours' }).click(); await p.waitForTimeout(200);
check('Reset puts the built-in dark colours back', (await cssVar('--accent')) === '#6aa84f' && (await cssVar('--panel')) === '#1e1d17', `${await cssVar('--accent')} ${await cssVar('--panel')}`);
await drawer.getByRole('button', { name: 'Home Assistant', exact: true }).click();
check('Home Assistant page has address, token and certificate fields', await drawer.getByPlaceholder('http://homeassistant.local:8123').count() === 1 && await drawer.locator('input[type=password]').count() === 1);
await drawer.getByPlaceholder('http://homeassistant.local:8123').fill('not a url');
await drawer.getByRole('button', { name: 'Save', exact: true }).click(); await p.waitForTimeout(500);
check('a bad address is refused with the reason, and stays on the page', /not a valid address|must start with/.test(await drawer.innerText()), (await drawer.innerText()).slice(-120).replace(/\s+/g, ' '));
await drawer.getByRole('button', { name: 'Camera', exact: true }).click();
await drawer.locator('select').selectOption('ha');
check('Camera with Home Assistant not set up points to the Home Assistant page', /Home Assistant is not set up yet/.test(await drawer.innerText()));
await drawer.getByRole('button', { name: 'Set up Home Assistant' }).click();
check('...and the button goes there', (await drawer.innerText()).includes('Access token'));
await drawer.getByRole('button', { name: 'Close settings' }).click();
check('the ✕ closes it', await drawer.count() === 0);

// narrow screen: full width, still reachable
const ph = await open(b, 420, 900, { isMobile: true, hasTouch: true });
await ph.getByRole('button', { name: /Settings/ }).click();
const pb = await ph.locator('.settings').boundingBox();
check('on a phone the drawer fills the width', pb.width >= 410, JSON.stringify(pb));
check('no page errors', p.errors.length === 0 && ph.errors.length === 0, [...p.errors, ...ph.errors].join('; '));
console.log(`\n${ok} passed, ${bad} failed`);
await b.close(); process.exit(bad ? 1 : 0);
