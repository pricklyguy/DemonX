// Hold-to-jog from the Jog panel (mouse and touch) and from the keyboard shortcuts. Start a fresh server first with SIM_SPEED=1 (see README.md).
import { launch, open, connect, URL_BASE } from './lib.mjs';
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) process.exitCode = 1; };
const b = await launch();
const ctx = await b.newContext({ viewport: { width: 1300, height: 900 } });
await ctx.addInitScript(() => { try { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('jogStep', '1'); localStorage.setItem('jogFeedXY', '3000'); sessionStorage.setItem('seeded', '1'); } } catch {} });
const p = await ctx.newPage(); const errors = []; p.on('pageerror', (e) => errors.push(e.message));
await p.goto(URL_BASE); await p.waitForSelector('.panel'); await p.waitForTimeout(500);
await connect(p);
const x = async () => Number(await p.locator('.wpos').first().innerText());
const settle = async () => { let a = await x(); await p.waitForTimeout(700); let c = await x(); return [a, c]; };
const btn = (n) => p.locator('.panel[data-panel="jog"] .btn.jog', { hasText: n }).first();

// --- Jog panel with the mouse
let x0 = await x();
await btn('X+').click(); await p.waitForTimeout(800);
const tapped = await x();
ok(Math.abs(tapped - x0 - 1) < 0.05, `a click is one 1 mm step (${x0} to ${tapped})`);
const box = await btn('X+').boundingBox();
await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await p.mouse.down(); await p.waitForTimeout(1600);
const mid = await x();
ok(mid > tapped + 5, `holding the button keeps moving (${tapped} to ${mid})`);
await p.mouse.up(); await p.waitForTimeout(900);
const stopAt = await x(); await p.waitForTimeout(700);
ok(Math.abs(await x() - stopAt) < 0.01, `letting go stops it (X stays at ${stopAt})`);
ok(stopAt - mid < 15, `and it stops promptly (${(stopAt - mid).toFixed(1)} mm after letting go)`);

// sliding off the button while held still stops on release
await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await p.mouse.down(); await p.waitForTimeout(700);
await p.mouse.move(box.x + 400, box.y + 300); await p.waitForTimeout(300); await p.mouse.up(); await p.waitForTimeout(900);
const [s1, s2] = await settle();
ok(Math.abs(s2 - s1) < 0.01, 'sliding off the button and letting go still stops the machine');

// --- touch (a fake touch pointer)
const t0 = await x();
await btn('X−').dispatchEvent('pointerdown', { pointerType: 'touch', pointerId: 7, isPrimary: true, button: 0 });
await p.waitForTimeout(1400);
const tMid = await x();
await btn('X−').dispatchEvent('pointerup', { pointerType: 'touch', pointerId: 7, isPrimary: true, button: 0 });
await p.waitForTimeout(900);
ok(tMid < t0 - 5, `holding with a finger moves continuously (${t0} to ${tMid})`);
const [u1, u2] = await settle();
ok(Math.abs(u2 - u1) < 0.01, 'and lifting the finger stops it');
await btn('X−').dispatchEvent('pointerdown', { pointerType: 'touch', pointerId: 8, isPrimary: true, button: 0 });
await p.waitForTimeout(700);
await btn('X−').dispatchEvent('pointercancel', { pointerType: 'touch', pointerId: 8, isPrimary: true });
await p.waitForTimeout(900);
const [c1, c2] = await settle();
ok(Math.abs(c2 - c1) < 0.01, 'a cancelled touch stops the machine');

// --- keyboard: off by default
let k0 = await x();
await p.keyboard.down('ArrowRight'); await p.waitForTimeout(1200); await p.keyboard.up('ArrowRight'); await p.waitForTimeout(700);
ok(Math.abs(await x() - k0) < 0.01, 'the arrow keys do nothing until shortcuts are turned on');

await p.getByRole('button', { name: /⚙ Settings/ }).click();
await p.getByText('Keyboard', { exact: true }).first().click();
await p.getByLabel(/Use keyboard shortcuts/).check();
await p.getByRole('button', { name: /⚙ Settings/ }).click();   // close
await p.waitForTimeout(300);

k0 = await x();
await p.keyboard.down('ArrowRight'); await p.waitForTimeout(1500);
const kMid = await x();
await p.keyboard.up('ArrowRight'); await p.waitForTimeout(900);
ok(kMid > k0 + 5, `holding the right arrow moves X+ (${k0} to ${kMid})`);
const [v1, v2] = await settle();
ok(Math.abs(v2 - v1) < 0.01, 'letting go of the key stops it');

k0 = await x();
await p.keyboard.press('ArrowRight'); await p.waitForTimeout(800);
ok(Math.abs(await x() - k0 - 1) < 0.05, 'a tap on the key is one step');

// typing in a box never jogs
const box2 = p.locator('input[placeholder*="Send command"]');
await box2.click(); k0 = await x();
await box2.press('ArrowRight'); await p.keyboard.down('ArrowRight'); await p.waitForTimeout(800); await p.keyboard.up('ArrowRight');
ok(Math.abs(await x() - k0) < 0.01, 'arrow keys do not jog while typing in a box');
await p.locator('body').click({ position: { x: 5, y: 5 } });

// losing focus stops a held key
await p.keyboard.down('ArrowRight'); await p.waitForTimeout(700);
await p.evaluate(() => window.dispatchEvent(new Event('blur')));
await p.waitForTimeout(900);
const [w1, w2] = await settle();
ok(Math.abs(w2 - w1) < 0.01, 'the page losing focus stops the machine even with the key still down');
await p.keyboard.up('ArrowRight');

// choose a different key
await p.getByRole('button', { name: /⚙ Settings/ }).click();
await p.getByText('Keyboard', { exact: true }).first().click();
await p.locator('.keytable tr', { hasText: 'Jog X+' }).getByRole('button', { name: 'Change' }).click();
await p.keyboard.press('KeyD');
ok(await p.locator('.keytable tr', { hasText: 'Jog X+' }).locator('kbd').innerText() === 'D', 'a new key can be picked for an action');
await p.locator('.keytable tr', { hasText: 'Jog X−' }).getByRole('button', { name: 'Change' }).click();
await p.keyboard.press('KeyD');
ok(await p.locator('.keytable tr', { hasText: 'Jog X+' }).locator('kbd').innerText() === 'none', 'picking a key another action has takes it from that one');
await p.getByRole('button', { name: 'Back to the default keys' }).click();
await p.getByRole('button', { name: /⚙ Settings/ }).click();
await p.waitForTimeout(300);

// feed hold key
await p.keyboard.press('Space'); await p.waitForTimeout(500);
ok((await p.locator('[data-panel=console]').innerText()).length > 0, 'the feed hold key does not break the page');
ok(errors.length === 0, 'no page errors');
await b.close();
