// The "tool is outside this view" warning must not change the size of the 3D view: when it was a line of text under the view,
// showing it shrank the view, which put the tool back in view, which hid it, which grew the view again, and so on (a flicker).
// Start a fresh server first (simulator): see README.md. Leaves the simulator moved 400 mm: restart the server before other checks.
import { launch, open, connect } from './lib.mjs';
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) process.exitCode = 1; };
const b = await launch();
const p = await open(b, 1300, 900);
await connect(p);
await p.evaluate(() => { window.__w = []; new MutationObserver(() => window.__w.push(!!document.querySelector('.viz-warn'))).observe(document.body, { childList: true, subtree: true }); });
const box = p.locator('input[placeholder*="Send command"]');
await box.fill('G91 G0 X-400'); await box.press('Enter');
await p.waitForSelector('.viz-warn', { timeout: 15000 });
const sizes = new Set();
for (let i = 0; i < 12; i++) { sizes.add(await p.locator('.viz-canvas').evaluate((e) => `${e.clientWidth}x${e.clientHeight}`)); await p.waitForTimeout(250); }
const changes = await p.evaluate(() => window.__w.reduce((n, v, i, a) => n + (i && v !== a[i - 1] ? 1 : 0), 0));
ok(sizes.size === 1, `the 3D view keeps one size while the warning is up (${[...sizes].join(', ')})`);
ok(changes === 1, `the warning appeared once and stayed (${changes} change)`);
ok(await p.locator('.viz-warn').count() === 1, 'the warning is still showing after 3 seconds');
await p.locator('.viz-warn').getByRole('button', { name: 'Fit all' }).click(); await p.waitForTimeout(500);
ok(await p.locator('.viz-warn').count() === 0, 'Fit all brings the tool into view and clears the warning');
ok(p.errors.length === 0, 'no page errors');
await b.close();
