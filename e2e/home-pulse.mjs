import { launch, open, connect } from './lib.mjs';
const b = await launch();
const a = await open(b, 1400, 900); const c = await open(b, 1400, 900);   // two browsers, like the Mini PC and your phone
const info = (p) => p.locator('.btn.home').evaluate((e) => ({ pulsing: e.classList.contains('pulse'), anim: getComputedStyle(e).animationName }));
console.log('before connecting          ', JSON.stringify(await info(a)));
await connect(a); await c.waitForTimeout(500);
console.log('after connecting, browser A', JSON.stringify(await info(a)));
console.log('after connecting, browser B', JSON.stringify(await info(c)));
await a.getByRole('button', { name: 'Zero XY' }).click(); await a.waitForTimeout(300);
console.log('after Zero XY (not home)    ', JSON.stringify(await info(a)));
await c.locator('.btn.home').click(); await c.waitForTimeout(600);
console.log('B presses Home -> A         ', JSON.stringify(await info(a)));
console.log('B presses Home -> B         ', JSON.stringify(await info(c)));
await b.close();
