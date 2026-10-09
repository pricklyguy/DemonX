import { URL_BASE, launch, open, connect, report, overlaps, shotPath } from './lib.mjs';
const b = await launch();
let ok = 0, bad = 0;
const check = (name, cond, extra = '') => { (cond ? ok++ : bad++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`); };
const rect = async (p, id) => (await report(p)).find((r) => r.id === id);
const drag = async (p, from, dx, dy) => { await p.mouse.move(from.x, from.y); await p.mouse.down(); await p.mouse.move(from.x + dx / 3, from.y + dy / 3, { steps: 4 }); await p.mouse.move(from.x + dx, from.y + dy, { steps: 8 }); await p.mouse.up(); await p.waitForTimeout(500); };
const handleOf = async (p, id) => { const r = await p.locator(`[data-panel=${id}] h2`).boundingBox(); return { x: r.x + r.width / 2 - 40, y: r.y + r.height / 2 }; };
const menu = async (p) => {   // Settings, Layout page
  if (!(await p.locator('.settings').count())) await p.getByRole('button', { name: /Settings/ }).click();
  await p.locator('.settings').getByRole('button', { name: 'Layout', exact: true }).click(); await p.waitForTimeout(150);
};

// ---------- 1920x1080 desktop ----------
let p = await open(b, 1920, 1080); await connect(p);
const initial = await report(p);
const N = initial.length; // however many panels there are, all of them show in the default layout

// drag Autolevel's title bar to the middle column, under the console
let before = await rect(p, 'autolevel');
await drag(p, await handleOf(p, 'autolevel'), -480, 380);
let after = await rect(p, 'autolevel'); let all = await report(p);
check('dragging a panel by its title moves it', Math.abs(after.x - before.x) > 200, `${before.x},${before.y} -> ${after.x},${after.y}`);
check('...and it snaps: nothing overlaps, nothing past the edge', overlaps(all).length === 0 && all.every((r) => r.x + r.w <= 1920), overlaps(all).join(',') || 'clean');
await p.reload(); await p.waitForSelector('.panel'); await p.waitForTimeout(400);
const afterReload = await rect(p, 'autolevel');
check('the moved layout is remembered after a reload (saved in this browser)', afterReload.x === after.x && afterReload.y === after.y);

// resize the console from its corner
const con = await rect(p, 'console'); const vizBefore = await rect(p, 'visualizer');
await drag(p, { x: con.x + con.w - 8, y: con.y + con.h - 8 }, 0, 120);
const con2 = await rect(p, 'console');
check('resizing from the corner handle makes the panel taller', con2.h > con.h + 80, `${con.h} -> ${con2.h}px`);
// visualizer fills its panel when resized
const vz = await rect(p, 'visualizer');
await drag(p, { x: vz.x + vz.w - 8, y: vz.y + vz.h - 8 }, 0, 100);
const sizes = await p.evaluate(() => { const c = document.querySelector('.viz-canvas'), cv = c.querySelector('canvas'); return { box: [c.clientWidth, c.clientHeight], canvas: [cv.clientWidth, cv.clientHeight] }; });
check('the 3D view fills its panel after a resize (canvas matches its container)', sizes.box[0] === sizes.canvas[0] && sizes.box[1] === sizes.canvas[1] && sizes.box[1] > 250, JSON.stringify(sizes));

// collapse by the arrow, and by double-click; expansion restores the height
let pos = await rect(p, 'position'); const jogBefore = await rect(p, 'jog');
await p.locator('[data-panel=position] .chev').click(); await p.waitForTimeout(500);
let posC = await rect(p, 'position'); const jogC = await rect(p, 'jog');
check('the collapse arrow shrinks a panel to its title bar', posC.h < 60 && posC.h < pos.h / 4, `${pos.h} -> ${posC.h}px`);
check('...and the panel below moves up to close the gap', jogC.y < jogBefore.y - 100, `${jogBefore.y} -> ${jogC.y}`);
check('...and the collapsed panel can not be resized (its handle is hidden)', (await p.locator('[data-panel=position]').locator('xpath=..').locator('.react-resizable-handle:visible').count()) === 0);
await p.locator('[data-panel=position] .chev').click(); await p.waitForTimeout(500);
check('expanding restores the previous height', (await rect(p, 'position')).h === pos.h);
await p.locator('[data-panel=job] h2 span').dblclick(); await p.waitForTimeout(400);
check('double-clicking a title also collapses it', (await rect(p, 'job')).h < 60);
await p.locator('[data-panel=job] .chev').click(); await p.waitForTimeout(400);

// hide / show through the Layout menu, saved
await menu(p); await p.locator('.menu-pop label', { hasText: 'Probe' }).locator('input').uncheck(); await p.waitForTimeout(400);
check('hiding a panel from the Panels menu removes it', (await p.locator('[data-panel=probe]').count()) === 0);
await p.reload(); await p.waitForSelector('.panel');
check('...and it stays hidden after a reload', (await p.locator('[data-panel=probe]').count()) === 0);
await menu(p); await p.locator('.menu-pop label', { hasText: 'Probe' }).locator('input').check(); await p.waitForTimeout(400);
check('showing it again brings it back', (await p.locator('[data-panel=probe]').count()) === 1);
await p.keyboard.press('Escape');

// presets
await menu(p); await p.locator('.menu-item', { hasText: 'Run' }).click(); await p.waitForTimeout(600); await p.keyboard.press('Escape');
all = await report(p); const ids = all.map((r) => r.id).sort();
check('Run preset: probe, jog and autolevel are hidden', !ids.includes('probe') && !ids.includes('jog') && !ids.includes('autolevel') && ids.includes('visualizer') && ids.includes('job') && ids.includes('position'), ids.join(','));
check('Run preset: no overlaps, nothing needs scrolling', overlaps(all).length === 0 && all.every((r) => r.overflow <= 2), all.filter((r) => r.overflow > 2).map((r) => r.id).join(',') || 'clean');
const runViz = all.find((r) => r.id === 'visualizer');
await p.screenshot({ path: shotPath('dock-run.png'), fullPage: true });
await menu(p); await p.locator('.menu-item', { hasText: 'Setup' }).click(); await p.waitForTimeout(600); await p.keyboard.press('Escape');
all = await report(p);
check('Setup preset: jog, probe, autolevel and job are shown', ['jog', 'probe', 'autolevel', 'job'].every((id) => all.some((r) => r.id === id)));
check('Setup preset: no overlaps, nothing needs scrolling', overlaps(all).length === 0 && all.every((r) => r.overflow <= 2), all.filter((r) => r.overflow > 2).map((r) => r.id).join(',') || 'clean');
check('Run gives the visualizer more room than Setup', runViz.w * runViz.h > (all.find((r) => r.id === 'visualizer').w * all.find((r) => r.id === 'visualizer').h));
await p.screenshot({ path: shotPath('dock-setup.png'), fullPage: true });

// lock
await menu(p); await p.locator('.menu-pop label', { hasText: 'Lock layout' }).locator('input').check(); await p.keyboard.press('Escape'); await p.waitForTimeout(300);
before = await rect(p, 'jog'); await drag(p, await handleOf(p, 'jog'), 400, 200); after = await rect(p, 'jog');
check('a locked layout ignores drags', before.x === after.x && before.y === after.y);
check('...and hides the resize handles', (await p.locator('.react-resizable-handle:visible').count()) === 0);
await p.reload(); await p.waitForSelector('.panel');
check('...and the lock is remembered', (await p.locator('.dock.locked').count()) === 1);
await menu(p); await p.locator('.menu-pop label', { hasText: 'Lock layout' }).locator('input').uncheck(); await p.keyboard.press('Escape');

// reset
await menu(p); await p.getByRole('button', { name: 'Reset layout' }).click(); await p.waitForTimeout(600); await p.keyboard.press('Escape');
const reset = await report(p);
check('Reset layout returns to the default arrangement', reset.length === N && initial.every((i) => { const r = reset.find((x) => x.id === i.id); return r && r.x === i.x && r.y === i.y && r.w === i.w && r.h === i.h; }));

// touch drag (finger), through the browser's touch events
const ctx = await b.newContext({ viewport: { width: 1920, height: 1080 }, hasTouch: true });
const tp = await ctx.newPage(); await tp.goto(`${URL_BASE}`); await tp.waitForSelector('.panel'); await tp.waitForTimeout(500);
const cdp = await ctx.newCDPSession(tp);
const hb = await tp.locator('[data-panel=job] h2').boundingBox(); const tb = await rect(tp, 'job');
const pt = (x, y) => [{ x, y, id: 1 }];
const sx = hb.x + hb.width / 2 - 40, sy = hb.y + hb.height / 2;
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(sx, sy) });
for (let k = 1; k <= 12; k++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(sx - k * 40, sy + k * 8) });
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await tp.waitForTimeout(500);
const ta = await rect(tp, 'job');
check('a finger can drag a panel by its title (touch events)', Math.abs(ta.x - tb.x) > 100, `${tb.x},${tb.y} -> ${ta.x},${ta.y}`);
const scrollBefore = await tp.evaluate(() => scrollY);
check('the page did not navigate away or reload during the swipe', tp.url() === `${URL_BASE}/` && (await tp.locator('.panel').count()) === N);
check('touch-action is off on the title bar so the page does not scroll instead', (await tp.locator('[data-panel=job] h2').evaluate((e) => getComputedStyle(e).touchAction)) === 'none');
await ctx.close();

// a damaged saved layout must not break the page
const ctx2 = await b.newContext({ viewport: { width: 1920, height: 1080 } });
await ctx2.addInitScript(() => localStorage.setItem('demonx.layout.v1', '{"items":"nonsense","hidden":[7],"collapsed":{"job":"x"}}'));
const dp = await ctx2.newPage(); await dp.goto(`${URL_BASE}`); await dp.waitForSelector('.panel');
check('a damaged saved layout falls back to the default instead of breaking the page', (await dp.locator('.panel').count()) === N);
await ctx2.close();
check('no page errors on the desktop pages', p.errors.length === 0, p.errors.join('|'));

// ---------- phone ----------
const ph = await open(b, 390, 844, { hasTouch: true, isMobile: true }); await connect(ph);
const stacked = await ph.evaluate(() => ({ stack: !!document.querySelector('.stack'), dock: !!document.querySelector('.dock'), sw: document.documentElement.scrollWidth, n: document.querySelectorAll('.panel').length }));
check('on a phone-width screen panels stack in one column (no grid)', stacked.stack && !stacked.dock && stacked.n === N);
check('...with no sideways scrolling', stacked.sw <= 390, `scrollWidth ${stacked.sw}`);
const order = await ph.evaluate(() => [...document.querySelectorAll('.panel')].map((e) => e.dataset.panel));
check('...in reading order, connection first', order[0] === 'connection', order.join(','));
await ph.locator('[data-panel=position] .chev').click(); await ph.waitForTimeout(200);
check('...collapse still works', (await ph.locator('[data-panel=position] .body').count()) === 0);
await menu(ph); await ph.locator('.menu-pop label', { hasText: 'Console' }).locator('input').uncheck(); await ph.waitForTimeout(200);
check('...and the Panels menu still hides panels', (await ph.locator('[data-panel=console]').count()) === 0);
await ph.keyboard.press('Escape'); await ph.mouse.click(5, 400);
const vh = await ph.locator('.viz-canvas').boundingBox();
check('...the 3D view has a usable height (60% of the screen)', vh.height > 400, `${Math.round(vh.height)}px`);
await ph.screenshot({ path: shotPath('dock-phone.png'), fullPage: false });
check('no page errors on the phone page', ph.errors.length === 0, ph.errors.join('|'));

console.log(`\n${ok} passed, ${bad} failed`);
await b.close();
