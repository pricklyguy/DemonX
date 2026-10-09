import http from 'node:http';
import fs from 'node:fs';
import { launch, open, shotPath } from './lib.mjs';
const fixture = (name) => fs.readFileSync(new URL(`../server/test/fixtures/${name}`, import.meta.url));
const FA = fixture('frame-a.jpg'), FB = fixture('frame-b.jpg');
const TOKEN = 'HA-TOKEN-SECRET-XYZ', NVR_PW = 'nvr-PASSWORD-SECRET';
const log = { ha: [], nvr: [] }; let n = 0, haUp = true;
const ha = http.createServer((req, res) => {
  log.ha.push(req.url);
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return res.writeHead(401).end();
  if (req.url === '/api/states') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify([
    { entity_id: 'light.shop', attributes: {} },
    { entity_id: 'camera.workshop_cnc_b', attributes: { friendly_name: 'Workshop CNC B' } },
    { entity_id: 'camera.workshop_cnc_a', attributes: { friendly_name: 'Workshop CNC A' } }]));
  if (req.url.startsWith('/api/camera_proxy/')) { res.writeHead(200, { 'content-type': 'image/jpeg' }); return res.end(n++ % 2 ? FB : FA); }
  res.writeHead(404).end();
});
const nvr = http.createServer((req, res) => {
  log.nvr.push(req.url); const u = new URL(req.url, 'http://x');
  if (u.searchParams.get('password') !== NVR_PW) return res.writeHead(401).end();
  res.writeHead(200, { 'content-type': 'image/jpeg' }); res.end(FA);
});
await new Promise((r) => ha.listen(8123, '127.0.0.1', r)); await new Promise((r) => nvr.listen(8124, '127.0.0.1', r));

let ok = 0, bad = 0;
const check = (name, cond, extra = '') => { (cond ? ok++ : bad++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`); };
const b = await launch();
const p = await open(b, 1920, 1080);
const wsFrames = []; p.on('websocket', (ws) => ws.on('framereceived', (f) => wsFrames.push(String(f.payload))));
await p.reload(); await p.waitForSelector('.panel'); await p.waitForTimeout(600);

const cam = p.locator('[data-panel=camera]');
check('the Camera panel is in the layout and says nothing is set up', (await cam.count()) === 1 && /not set up|No camera is set up/i.test(await cam.innerText()));

// ---- Home Assistant lives in Settings; a wrong token first ----
const drawer = p.locator('.settings');
const settings = async (page) => { if (!(await drawer.count())) await p.getByRole('button', { name: /Settings/ }).click(); await drawer.getByRole('button', { name: page, exact: true }).click(); };
await settings('Home Assistant');
await drawer.getByPlaceholder('http://homeassistant.local:8123').fill('http://127.0.0.1:8123');
await drawer.locator('input[type=password]').fill('wrong-token');
await drawer.getByRole('button', { name: 'Test connection' }).click();
await drawer.locator('.warn-line').first().waitFor();
check('a wrong token is explained when testing the connection', /wrong user name or password/.test(await drawer.locator('.warn-line').first().innerText()));
await drawer.locator('input[type=password]').fill(TOKEN);
await drawer.getByRole('button', { name: 'Test connection' }).click();
await drawer.getByText(/Connected: 2 cameras found/).waitFor();
check('a good token says how many cameras were found', true);
await drawer.getByRole('button', { name: 'Save', exact: true }).click();
await drawer.getByText('✓ Saved').waitFor();
check('the Home Assistant details save, and the token is not shown again', (await drawer.locator('input[type=password]').inputValue()) === '' && /saved/.test(await drawer.innerText()));

// ---- the Camera page: pick the camera, test, save ----
await cam.getByRole('button', { name: /Setup/ }).click();      // the panel's gear opens Settings on the Camera page
check('the Camera panel gear opens Settings on the Camera page', await drawer.locator('select').count() === 1 && /Camera type/.test(await drawer.innerText()));
await drawer.locator('select').selectOption('ha');
await drawer.getByRole('button', { name: 'Load list' }).click();
await drawer.getByText(/2 cameras found/).waitFor();
const opts = await drawer.locator('datalist option').evaluateAll((o) => o.map((x) => `${x.value} | ${x.textContent}`));
check('the list shows only camera entities, with their names', opts.length === 2 && opts[0].includes('Workshop CNC A') && !opts.join().includes('light.'), opts.join(' ; '));
await drawer.getByPlaceholder('camera.workshop_cnc').fill('camera.workshop_cnc_a');
await drawer.getByRole('button', { name: 'Test', exact: true }).click();
await drawer.locator('.camtest img').waitFor();
check('Test shows a real picture before anything is saved', /Picture received/.test(await drawer.locator('.camtest').innerText()) && (await drawer.locator('.camtest img').evaluate((i) => i.naturalWidth)) > 0);
check('...and the camera was not saved yet (config still says no camera)', !wsFrames.some((f) => f.includes('"type":"config"') && f.includes('"source":"ha"')));
await drawer.screenshot({ path: shotPath('cam-setup.png') });
await drawer.getByRole('button', { name: 'Save', exact: true }).click();
await drawer.getByText('✓ Saved').waitFor();
await drawer.getByRole('button', { name: 'Close settings' }).click();
await cam.getByText(/^Stopped/).waitFor();
check('Save keeps Settings open, and the camera is ready to start', (await cam.getByRole('button', { name: /Start camera/ }).isEnabled()));

// ---- watch ----
await cam.getByRole('button', { name: /Start camera/ }).click();
await cam.getByText(/Streaming/).waitFor({ timeout: 8000 });
await p.waitForTimeout(1500);
const img = await cam.locator('.cam-view img').evaluate((i) => ({ w: i.naturalWidth, h: i.naturalHeight, shown: i.getBoundingClientRect().width }));
check('the picture appears and is drawn in the panel', img.w === 160 && img.h === 120 && img.shown > 100, JSON.stringify(img));
check('status shows the rate and viewers', /Streaming · [\d.]+ fps · 1 viewer\b/.test(await cam.innerText()), (await cam.innerText()).match(/Streaming[^\n]*/)?.[0]);
await cam.screenshot({ path: shotPath('cam-stream.png') });

// ---- a second browser (a phone) ----
const phone = await open(b, 420, 900, { isMobile: true, hasTouch: true });
const pc = phone.locator('[data-panel=camera]');
await pc.waitFor();
check('a remote browser sees the setup and that someone else is watching', /1 watching elsewhere/.test(await pc.innerText()) && (await pc.locator('.cam-view img').count()) === 0);
await pc.getByRole('button', { name: /Start camera/ }).click();
await pc.getByText(/2 viewers/).waitFor({ timeout: 8000 });
check('...and can start its own view; the server now has 2 viewers', true);
const before = log.ha.length; await p.waitForTimeout(1000); const rate = log.ha.length - before;
check('two viewers share one pull from Home Assistant', rate <= 8, `${rate} requests in 1 s at 5 fps`);
await cam.getByRole('button', { name: /Stop/ }).click();
await pc.getByText(/1 viewer\b/).waitFor({ timeout: 6000 });
check('stopping one browser leaves the other watching', (await pc.locator('.cam-view img').count()) === 1);
await pc.getByRole('button', { name: /Stop/ }).click();
await p.waitForTimeout(8000);
const idle0 = log.ha.length; await p.waitForTimeout(1200);
check('when nobody watches, DemonX stops asking Home Assistant', log.ha.length === idle0 && /Stopped/.test(await cam.innerText()));

// ---- secrets never reach a browser ----
const all = wsFrames.join('\n');
check('the access token never appeared in anything sent to the browser', !all.includes(TOKEN) && !all.includes('wrong-token'));
check('...the browser is only told a token is saved', /"hasToken":true/.test(all));
const saved = JSON.parse(fs.readFileSync(`${(process.env.DEMONX_DATA ?? process.env.DATA)}/config.json`, 'utf8'));
check('the token is kept on the server, in a file only its owner can read', saved.homeAssistant.token === TOKEN && (fs.statSync(`${(process.env.DEMONX_DATA ?? process.env.DATA)}/config.json`).mode & 0o777) === 0o600);

// ---- survives a reload; reacts to the camera going away ----
await p.reload(); await p.waitForSelector('[data-panel=camera]'); await p.waitForTimeout(600);
check('the setup is remembered after a reload', await p.locator('[data-panel=camera]').getByRole('button', { name: /Start camera/ }).isEnabled());
await p.locator('[data-panel=camera]').getByRole('button', { name: /Start camera/ }).click();
await p.locator('[data-panel=camera]').getByText(/Streaming/).waitFor({ timeout: 8000 });
ha.closeAllConnections(); await new Promise((r) => ha.close(r));
await p.locator('[data-panel=camera] .warn-line').first().waitFor({ timeout: 8000 });
check('if the camera source goes away the panel says why', /Connection refused/.test(await p.locator('[data-panel=camera] .warn-line').first().innerText()), await p.locator('[data-panel=camera] .warn-line').first().innerText());
await p.locator('[data-panel=camera]').getByRole('button', { name: /Stop/ }).click();

// ---- Reolink ----
const c2 = drawer;
await p.locator('[data-panel=camera]').getByRole('button', { name: /Setup/ }).click();
await drawer.waitFor();
await c2.locator('select').first().selectOption('reolink');
await c2.getByPlaceholder('10.20.30.98').fill('127.0.0.1:8124');
await c2.locator('input[type=number]').first().fill('2');
await c2.locator('select').nth(2).selectOption('http');              // connection: http (the fake has no certificate)
await c2.locator('input:not([type]), input[type=text]').nth(1).fill('admin');
await c2.locator('input[type=password]').fill('wrong');
await c2.getByRole('button', { name: 'Test', exact: true }).click();
await c2.locator('.camtest .warn-line').waitFor();
check('Reolink: a wrong password is explained', /wrong user name or password/.test(await c2.locator('.camtest').innerText()));
await c2.locator('input[type=password]').fill(NVR_PW);
await c2.getByRole('button', { name: 'Test', exact: true }).click();
await c2.locator('.camtest .ok-line').waitFor();
const q = new URL(log.nvr[log.nvr.length - 1], 'http://x').searchParams;
check('Reolink: the right channel (2 in the app is 1 for the camera) and login are used', q.get('cmd') === 'Snap' && q.get('channel') === '1' && q.get('user') === 'admin' && q.get('password') === NVR_PW);
await c2.getByRole('button', { name: 'Save', exact: true }).click();
await c2.getByText('✓ Saved').waitFor();
await p.waitForTimeout(300);
check('the NVR password never reached the browser either', !wsFrames.join('\n').includes(NVR_PW));

// ---- layout: the panel behaves like the others ----
await settings('Layout');
check('the Camera panel is in the Layout settings', (await p.locator('.menu-pop label', { hasText: 'Camera' }).count()) === 1);
await p.keyboard.press('Escape');
check('no page errors', p.errors.length === 0 && phone.errors.length === 0, [...p.errors, ...phone.errors].join('|'));
console.log(`\n${ok} passed, ${bad} failed`);
await b.close(); nvr.close();
