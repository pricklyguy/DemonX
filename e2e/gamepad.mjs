// Gamepad: off until turned on, needs arming, moves only while pushed, stops when the page loses focus, and the server stops a
// jog by itself when the browser goes silent. A fake pad replaces the browser's gamepad list. Start a fresh server first (see README.md).
import { createRequire } from 'node:module';
import { launch, open, connect, URL_BASE } from './lib.mjs';
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) process.exitCode = 1; };
const b = await launch();
const ctx = await b.newContext({ viewport: { width: 1300, height: 900 } });
await ctx.addInitScript(() => {
  window.__pad = { connected: true, id: 'Fake pad (standard)', axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) };
  navigator.getGamepads = () => [window.__pad];
  localStorage.setItem('gamepad', JSON.stringify({ enabled: true, speed: 100 }));
});
const p = await ctx.newPage(); const errors = []; p.on('pageerror', (e) => errors.push(e.message));
await p.goto(URL_BASE); await p.waitForSelector('.panel'); await p.waitForTimeout(500);
await connect(p);
const x = async () => Number(await p.locator('.wpos').first().innerText());
const stick = (ax) => p.evaluate((a) => { window.__pad.axes = a; }, ax);
const press = async (n) => { await p.evaluate((i) => { window.__pad.buttons[i].pressed = true; }, n); await p.waitForTimeout(250); await p.evaluate((i) => { window.__pad.buttons[i].pressed = false; }, n); await p.waitForTimeout(250); };
const badge = () => p.locator('.padbadge').innerText().catch(() => '');

ok(/press Start/.test(await badge()), `a pad is seen but not armed (${await badge()})`);
const x0 = await x();
await stick([1, 0, 0, 0]); await p.waitForTimeout(1500);
ok(Math.abs(await x() - x0) < 0.01, 'a pushed stick does nothing before arming');
await stick([0, 0, 0, 0]);

await stick([1, 0, 0, 0]); await press(9);
ok(!/armed/.test(await badge()) || /press Start/.test(await badge()), 'Start with a stick pushed does not arm');
await stick([0, 0, 0, 0]); await press(9);
ok(/armed/.test(await badge()), 'Start with the sticks centred arms it');

const a = await x();
await stick([1, 0, 0, 0]); await p.waitForTimeout(1500);
const moved = await x();
ok(moved > a + 1, `pushing the left stick moves X (${a} to ${moved})`);
await stick([0, 0, 0, 0]); await p.waitForTimeout(800);
const stopped = await x(); await p.waitForTimeout(800);
ok(Math.abs(await x() - stopped) < 0.01, `letting go stops it (X stays at ${stopped})`);

// the page losing focus stops and disarms
await stick([-1, 0, 0, 0]); await p.waitForTimeout(800);
await p.evaluate(() => window.dispatchEvent(new Event('blur')));
await p.waitForTimeout(800);
const afterBlur = await x(); await p.waitForTimeout(800);
ok(Math.abs(await x() - afterBlur) < 0.01, 'losing focus stops the machine even with the stick still pushed');
ok(!/armed/.test(await badge()) || /press Start/.test(await badge()), 'and disarms it');
await stick([0, 0, 0, 0]);

// B stops and disarms
await press(9); await stick([1, 0, 0, 0]); await p.waitForTimeout(600);
await press(1);
ok(/press Start/.test(await badge()), 'B disarms');
await stick([0, 0, 0, 0]);

// the server's own watchdog: a browser that holds once and goes silent does not leave the machine moving
const WebSocket = createRequire(import.meta.url)(createRequire('/home/user/demonx/server/package.json').resolve('ws'));
const ws = new WebSocket(URL_BASE.replace('http', 'ws') + '/ws');
await new Promise((r) => ws.on('open', r));
const before = await x();
ws.send(JSON.stringify({ type: 'jogHold', x: 3000, y: 0, z: 0 }));
await p.waitForTimeout(2500);
const mid = await x(); await p.waitForTimeout(1500);
ok(mid > before && mid < before + 40, `one hold and then silence moves only a short way (${before} to ${mid})`);
ok(Math.abs(await x() - mid) < 0.01, 'and the machine is not still moving after the silence');
ws.close();
ok(errors.length === 0, 'no page errors');
await b.close();
