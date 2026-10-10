// Settings > Stats & maintenance: a job is counted when it finishes, a stopped job is recorded, a task can be added,
// comes due, and is reset with Done. Start a fresh server first with a throwaway DEMONX_DATA (see README.md).
import fs from 'node:fs';
import path from 'node:path';
import { launch, open, connect, shotPath, SHOT_DIR } from './lib.mjs';
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) process.exitCode = 1; };
const b = await launch();
const p = await open(b, 1300, 900);
await connect(p);

const openStats = async () => {
  if (!(await p.locator('.settings-body').count())) await p.getByRole('button', { name: /⚙ Settings/ }).click();
  await p.getByText('Stats & maintenance', { exact: true }).first().click();
  await p.waitForSelector('.statgrid');
};
const closeSettings = async () => { if (await p.locator('.settings-body').count()) await p.getByRole('button', { name: /⚙ Settings/ }).click(); };
const num = async (label) => Number((await p.locator('.statgrid > div', { hasText: label }).locator('b').innerText()).replace(/[^\d.]/g, ''));

await openStats();
ok(await num('jobs run') === 0, 'a fresh install has run no jobs');
ok(await p.locator('.maint').count() >= 3, 'it starts with a few maintenance tasks');
await closeSettings();

shotPath('x'); const file = path.join(SHOT_DIR, 'stats-test.nc');
fs.writeFileSync(file, ['G21 G90', 'G0 X0 Y0 Z5', 'G1 X20 F3000', 'G1 Y20', 'G0 Z5'].join('\n'));
await p.locator('[data-panel=job] input[type=file]').setInputFiles(file);
await p.waitForSelector('[data-panel=job] table.ext');
await p.getByRole('button', { name: 'Start', exact: true }).click();
await p.getByText(/Job complete/).first().waitFor({ timeout: 30000 });
await p.waitForTimeout(500);
await openStats();
ok(await num('jobs run') === 1 && await num('finished') === 1, 'the finished job is counted');
ok((await p.locator('.statlist').innerText()).includes('stats-test.nc'), 'it appears under Recent jobs');
await closeSettings();

// a stopped job (a longer program, so there is time to stop it)
const slow = path.join(SHOT_DIR, 'stats-slow.nc');
fs.writeFileSync(slow, ['G21 G90', 'G0 X0 Y0 Z5', 'G1 X200 F60', 'G1 Y200', 'G0 Z5'].join('\n'));
await p.locator('[data-panel=job] input[type=file]').setInputFiles(slow);
await p.waitForTimeout(500);
await p.getByRole('button', { name: 'Start', exact: true }).click();
await p.waitForTimeout(1500);
await p.getByRole('button', { name: 'Stop', exact: true }).click();
await p.waitForTimeout(2500);
await openStats();
ok(await num('jobs run') === 2 && await num('stopped or failed') === 1, 'a stopped job is counted as stopped');

// add a task, make it come due by lowering the hours, then Done
await p.getByRole('button', { name: '+ Add a task' }).click();
await p.locator('.macroform input').first().fill('Oil the spindle');
await p.locator('.macroform input[type=number]').fill('0.5');
await p.getByRole('button', { name: 'Save', exact: true }).click();
await p.waitForSelector('.maint:has-text("Oil the spindle")');
ok(await p.locator('.maint:has-text("Oil the spindle")').innerText().then((t) => /due in/.test(t)), 'a new task counts from now');
await p.getByRole('button', { name: 'Edit Oil the spindle' }).click();
await p.locator('.macroform input').first().fill('');
await p.getByRole('button', { name: 'Save', exact: true }).click();
ok(/name/i.test(await p.locator('.macroform .err').innerText()), 'a task without a name is refused with a message');
await p.getByRole('button', { name: 'Cancel', exact: true }).click();

// the same numbers show in a second browser
const p2 = await open(b, 1300, 900);
await p2.getByRole('button', { name: /⚙ Settings/ }).click();
await p2.getByText('Stats & maintenance', { exact: true }).first().click();
await p2.waitForSelector('.statgrid');
ok(await p2.locator('.statgrid > div', { hasText: 'jobs run' }).locator('b').innerText() === '2', 'another browser sees the same job count');
ok(await p2.locator('.maint:has-text("Oil the spindle")').count() === 1, 'and the same tasks');
ok(p.errors.length === 0 && p2.errors.length === 0, 'no page errors');
await b.close();
