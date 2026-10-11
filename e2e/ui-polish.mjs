// Port dropdown, Comfortable/Compact size setting, and the jog number fields not stretching across the panel.
// Start a fresh server first (simulator): see README.md.
import { launch, open, connect } from './lib.mjs';
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) process.exitCode = 1; };
const b = await launch();
const p = await open(b, 1300, 900);

const sel = p.locator('select[aria-label="Serial port"]');
const opts = await sel.locator('option').allInnerTexts();
ok(opts.some((t) => /Simulator/.test(t)), `the port list offers the simulator (${opts.join(' | ')})`);
ok(await p.locator('input[list=ports]').count() === 0, 'the port box is a dropdown, not a type-to-filter box');
ok(await p.getByRole('button', { name: 'Connect', exact: true }).isDisabled(), 'Connect waits until a port is chosen');
await sel.selectOption('__other');
ok(await p.locator('input[aria-label="Port name"]').count() === 1, 'Other shows a box to type a port name');
await sel.selectOption('simulator');
ok(await p.locator('input[aria-label="Port name"]').count() === 0, 'choosing a listed port hides the box');
await p.getByRole('button', { name: 'Connect', exact: true }).click();
await p.waitForSelector('text=Connected to');
await p.getByRole('button', { name: 'Disconnect' }).click();
await p.waitForSelector('select[aria-label="Serial port"]');
ok(await p.locator('select[aria-label="Serial port"]').inputValue() === 'simulator', 'after disconnecting, the simulator is still listed and chosen (no deleting text to get the list back)');
await connect(p);

const feed = p.locator('.panel[data-panel="jog"] input[type=number]').first();
const w1 = await feed.evaluate((e) => e.getBoundingClientRect().width);
ok(w1 > 40 && w1 < 140, `the jog feed field is sized for a few digits (${Math.round(w1)} px)`);
await p.evaluate(() => { document.querySelector('.panel[data-panel="jog"]').style.width = '700px'; });
const ws = await p.locator('.panel[data-panel="jog"] .steprow select').evaluateAll((l) => l.map((e) => e.getBoundingClientRect().width));
ok(ws.length === 2 && ws.every((w) => w < 140), `the XY and Z step boxes stay narrow in a wide panel (${ws.map(Math.round).join(', ')} px)`);
await p.evaluate(() => { document.querySelector('.panel[data-panel="jog"]').style.width = ''; });
const jogH1 = await p.locator('.btn.jog').first().evaluate((e) => e.getBoundingClientRect().height);

await p.getByRole('button', { name: '⚙ Settings' }).click();
await p.getByText('Appearance', { exact: true }).first().click();
await p.getByLabel(/Compact/).check();
ok(await p.evaluate(() => document.documentElement.dataset.density) === 'compact', 'Compact is applied');
const jogH2 = await p.locator('.btn.jog').first().evaluate((e) => e.getBoundingClientRect().height);
ok(jogH2 < jogH1, `compact makes the jog buttons smaller (${jogH1} to ${jogH2} px)`);
await p.reload(); await p.waitForSelector('.panel');
ok(await p.evaluate(() => document.documentElement.dataset.density) === 'compact', 'Compact is remembered after a reload');
await p.evaluate(() => localStorage.removeItem('density'));
ok(p.errors.length === 0, 'no page errors');
await b.close();
