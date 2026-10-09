import { launch, open, connect, report, shotPath } from './lib.mjs';
const b = await launch();
let ok = 0, bad = 0;
const check = (name, cond, extra = '') => { (cond ? ok++ : bad++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`); };
const drag = async (p, from, dx, dy) => { await p.mouse.move(from.x, from.y); await p.mouse.down(); await p.mouse.move(from.x + dx / 3, from.y + dy / 3, { steps: 4 }); await p.mouse.move(from.x + dx, from.y + dy, { steps: 8 }); await p.mouse.up(); await p.waitForTimeout(500); };
const handleOf = async (p, id) => { const r = await p.locator(`[data-panel=${id}] h2`).boundingBox(); return { x: r.x + r.width / 2 - 40, y: r.y + r.height / 2 }; };
const menu = async (p) => {   // Settings, Layout page
  if (!(await p.locator('.settings').count())) await p.getByRole('button', { name: /Settings/ }).click();
  await p.locator('.settings').getByRole('button', { name: 'Layout', exact: true }).click(); await p.waitForTimeout(150);
};
const snap = async (p) => JSON.stringify((await report(p)).map((r) => [r.id, r.x, r.y, r.w, r.h]).sort());

const p = await open(b, 1920, 1080); await connect(p);

// ---- 1. the jog step list ----
const xyStep = p.locator('[data-panel=jog] select[aria-label="XY step"]');
const steps = await xyStep.locator('option').allInnerTexts();
check('XY step list runs 0.01 mm to 500 mm', steps[0] === '0.01 mm' && steps.at(-1) === '500 mm' && steps.includes('100 mm'), steps.join(' | '));
await xyStep.selectOption({ label: '5 mm' });
await p.getByRole('button', { name: 'X+' }).click(); await p.waitForTimeout(1200);
check('the 5 step jogs 5 mm', (await p.locator('.wpos').first().innerText()) === '5.00', await p.locator('.wpos').first().innerText());

// ---- 2. visualizer toolbar rows ----
const rows = await p.evaluate(() => {
  const y = (el) => { const r = el.getBoundingClientRect(); return Math.round(r.y + r.height / 2); };
  const views = [...document.querySelectorAll('.viz-views button')].map((e) => ({ t: e.textContent, y: y(e) }));
  const opts = [...document.querySelectorAll('.viz-opts label')].map((e) => ({ t: e.textContent.trim().slice(0, 12), y: y(e) }));
  return { views, opts };
});
const spread = (a) => Math.max(...a.map((v) => v.y)) - Math.min(...a.map((v) => v.y));
const vy = { size: spread(rows.views) < 8 ? 1 : 2 }, oy = { size: spread(rows.opts) < 8 ? 1 : 2 };
check('all six view buttons are on one row', rows.views.length === 6 && vy.size === 1, rows.views.map((v) => v.t).join(' '));
check('Z stretch and the four toggles are together on one row', rows.opts.length === 5 && oy.size === 1, rows.opts.map((o) => o.t).join(' | '));
check('...and that row is under the view buttons', Math.min(...rows.opts.map((o) => o.y)) > Math.max(...rows.views.map((v) => v.y)) + 10);
await p.locator('[data-panel=visualizer]').screenshot({ path: shotPath('viz-rows.png') });

// ---- 3. your layout, a preset, and the way back ----
await drag(p, await handleOf(p, 'jog'), 480, 300);                 // move a panel
await menu(p); await p.locator('.menu-pop label', { hasText: 'Probe' }).locator('input').uncheck(); await p.waitForTimeout(300);
await p.locator('.menu-pop label', { hasText: 'Lock layout' }).locator('input').check(); await p.keyboard.press('Escape'); await p.waitForTimeout(300);
const mine = await snap(p);
check('setup: arranged by hand, one panel hidden, layout locked', (await p.locator('[data-panel=probe]').count()) === 0 && (await p.locator('.dock.locked').count()) === 1);

await menu(p);
check('before any preset click there is nothing to undo', (await p.getByRole('button', { name: /Undo last preset/ }).count()) === 0);
await p.locator('.menu-item', { hasText: 'Run' }).click(); await p.waitForTimeout(500);
check('clicking the Run preset replaces the layout', (await snap(p)) !== mine);
check('...and an "Undo last preset" button appears', (await p.getByRole('button', { name: /Undo last preset/ }).count()) === 1);
await p.screenshot({ path: shotPath('layout-menu.png'), clip: { x: 1300, y: 0, width: 620, height: 520 } });
await p.getByRole('button', { name: /Undo last preset/ }).click(); await p.waitForTimeout(600);
check('Undo returns to exactly the layout you had (positions, sizes, hidden panels)', (await snap(p)) === mine);
check('...and the lock is still on', (await p.locator('.dock.locked').count()) === 1);
check('...and Undo is spent', (await p.getByRole('button', { name: /Undo last preset/ }).count()) === 0);

// several preset clicks in a row, then back
await p.locator('.menu-item', { hasText: 'Run' }).click(); await p.waitForTimeout(300);
await p.locator('.menu-item', { hasText: 'Setup' }).click(); await p.waitForTimeout(300);
await p.locator('.menu-item', { hasText: 'All panels' }).click(); await p.waitForTimeout(300);
await p.getByRole('button', { name: /Undo last preset/ }).click(); await p.waitForTimeout(600);
check('after several preset clicks, Undo still returns to your own layout', (await snap(p)) === mine);

// Save as My layout is a durable slot
await p.getByRole('button', { name: 'Save as My layout' }).click(); await p.waitForTimeout(300);
check('after saving, a "My layout" entry exists and is highlighted', (await p.locator('.menu-item.on', { hasText: 'My layout' }).count()) === 1);
await p.locator('.menu-item', { hasText: 'Setup' }).click(); await p.waitForTimeout(300);
await p.locator('.menu-item', { hasText: 'Run' }).click(); await p.waitForTimeout(300);
await p.locator('.menu-item', { hasText: 'My layout' }).click(); await p.waitForTimeout(600);
check('My layout comes back after any number of presets', (await snap(p)) === mine);
await p.keyboard.press('Escape');
await p.reload(); await p.waitForSelector('.panel'); await p.waitForTimeout(500);
check('My layout survives a reload, still locked', (await snap(p)) === mine && (await p.locator('.dock.locked').count()) === 1);
await menu(p); await p.locator('.menu-item', { hasText: 'All panels' }).click(); await p.waitForTimeout(400);
await p.locator('.menu-item', { hasText: 'My layout' }).click(); await p.waitForTimeout(500);
check('...and is still available from the menu after a reload', (await snap(p)) === mine);
check('no page errors', p.errors.length === 0, p.errors.join('|'));
console.log(`\n${ok} passed, ${bad} failed`);
await b.close();
