// Update notice (Update now is covered by server/test/updateApply.test.ts, which uses real git): the header badge, the notes (shown as text), Update, Skip (shared by every browser, refused for a viewer),
// and Settings > Updates (Check now, channel, turning the check off, a failed check keeping the last answer).
// Needs a FRESH data folder, seeded so the channel is "test releases and stable" (a stable DemonX version would otherwise follow
// stable releases only, and the badge checks below would see the fake's 8.0.0), and a fake GitHub: this script serves one on
// port 8125 and the DemonX server must be started to use it:
//   rm -rf /tmp/demonx-e2e-upd && mkdir -p /tmp/demonx-e2e-upd && echo '{"updates":{"channel":"test"}}' > /tmp/demonx-e2e-upd/config.json
//   SIM_SPEED=30 DEMONX_DATA=/tmp/demonx-e2e-upd DEMONX_UPDATE_URL=http://127.0.0.1:8125/releases PORT=8080 npm start
// The fake's releases are far newer than whatever version package.json says.
import http from 'node:http';
import { createRequire } from 'node:module';
import { launch, open, URL_BASE } from './lib.mjs';

const require = createRequire(import.meta.url);
const WebSocket = (() => { try { return require('ws'); } catch { return require('../server/node_modules/ws'); } })();
let ok = 0, bad = 0;
const check = (name, cond, extra = '') => { (cond ? ok++ : bad++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`); if (!cond) process.exitCode = 1; };

// ---- a fake GitHub releases list ----
const HOSTILE = 'Notes with <b>bold</b> and <img src=x onerror="window.__pwned=1"> kept as text\nSecond line';
const releases = [
  { tag_name: 'v9.0.0-test.9', prerelease: true, name: 'Nine', body: 'older test', published_at: '2026-01-01T00:00:00Z' },
  { tag_name: 'v9.0.0-test.10', prerelease: true, name: 'Ten', body: HOSTILE, published_at: '2026-02-01T00:00:00Z', html_url: 'https://evil.example/phish' },
  { tag_name: 'v8.0.0', prerelease: false, name: 'Eight', body: 'stable notes', published_at: '2025-12-01T00:00:00Z' },
  { tag_name: 'v1.0.0', prerelease: false, name: 'One', body: '', published_at: '2025-01-01T00:00:00Z' },
  { tag_name: 'nightly', prerelease: true, body: 'not a version' },
];
let mode = 'ok', asked = 0;
const fake = http.createServer((req, res) => {
  asked++;
  if (mode === 'down') return res.writeHead(503).end('down');
  if (mode === 'junk') return res.writeHead(200, { 'content-type': 'application/json' }).end('{"message":"hello"}');
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(releases));
});
await new Promise((r) => fake.listen(8125, '127.0.0.1', r));

const b = await launch();
const p = await open(b, 1300, 900);
p.context().route('https://github.com/**', (r) => r.fulfill({ body: 'release page' }));

const badge = p.locator('.updatebadge');
const openUpdates = async () => {
  if (!(await p.locator('.settings-body').count())) await p.getByRole('button', { name: /⚙ Settings/ }).click();
  await p.locator('.settings-nav').getByText('Updates', { exact: true }).click();
  await p.waitForSelector('.statgrid');
};
// The server's own first check may have run before this fake was up (it then keeps quiet and tries again later): ask now
await openUpdates();
await p.getByRole('button', { name: 'Check now' }).click();
await badge.waitFor({ timeout: 20000 });
await p.getByRole('button', { name: /⚙ Settings/ }).click();    // close Settings again
check('a newer version shows a badge in the header', /9\.0\.0-test\.10/.test(await badge.innerText()), await badge.innerText());

// ---- the dialog ----
await badge.click();
const dlg = p.locator('.updatedlg');
const notes = dlg.locator('.relnotes');
check('the notes are shown', (await notes.innerText()).includes('Second line'));
check('notes are plain text: markup is shown as it is, not run', (await notes.innerText()).includes('<b>bold</b>') && (await notes.locator('b, img').count()) === 0 && !(await p.evaluate(() => window.__pwned)));
const href = await dlg.getByRole('link', { name: 'Release page' }).getAttribute('href');
check('the release page link is built from the tag, not taken from GitHub', href === 'https://github.com/pricklyguy/DemonX/releases/tag/v9.0.0-test.10', href);
check('the link opens a new tab without access to DemonX', (await dlg.getByRole('link', { name: 'Release page' }).getAttribute('rel')).includes('noopener'));
const [popup] = await Promise.all([p.context().waitForEvent('page'), dlg.getByRole('link', { name: 'Release page' }).click()]);
check('Release page opens the release', popup.url() === href, popup.url());
await popup.close();
check('there is no separate Update button that only opens a page', (await dlg.getByRole('link', { name: 'Update', exact: true }).count()) === 0 && (await dlg.getByRole('button', { name: 'Update', exact: true }).count()) === 0);
check('the dialog says what to do by hand, without a click', /To update by hand:.*update\.sh/.test(await dlg.locator('[role=note]').innerText()), await dlg.locator('[role=note]').innerText());
check('and says why Update now is not available', /Update now is not available:.*PM2/.test(await dlg.innerText()), await dlg.innerText());
check('Update now is not offered here (this server is not run by PM2, and it is off)', (await dlg.getByRole('button', { name: 'Update now' }).count()) === 0);
await p.keyboard.press('Escape');
check('Escape closes the dialog', (await p.locator('.updatedlg').count()) === 0);

const stat = (label) => p.locator('.statgrid > div', { hasText: label }).locator('b').innerText();
await openUpdates();
check('Settings shows the current and the newest version', (await stat('newest version')) === '9.0.0-test.10' && (await stat('your version')).length > 0);
check('Settings says the check is the only thing sent to the internet', /only thing DemonX sends to the internet/.test(await p.locator('.settings-body').innerText()));
check('it shows when it last checked', !/never/.test(await stat('last checked')));

// Update now: off until turned on, and even then only where PM2 can restart DemonX (not here)
const allow = p.getByLabel('Allow Update now on this page');
check('Update now is off by default', (await allow.count()) === 1 && !(await allow.isChecked()));
await allow.click();
for (let i = 0; i < 50 && !(await allow.isChecked()); i++) await p.waitForTimeout(100);
await p.waitForTimeout(300);   // the server's answer has arrived
check('turned on, it still says it needs PM2 and gives no button', (await allow.isChecked()) && /Right now:.*PM2/.test(await p.locator('.settings-body').innerText()) && (await p.getByRole('button', { name: 'Update now' }).count()) === 0);
await allow.click();
for (let i = 0; i < 50 && (await allow.isChecked()); i++) await p.waitForTimeout(100);
check('and it can be turned off again', !(await allow.isChecked()));

// Automatic follows test releases for a test install; stable only gives the stable one
await p.getByLabel('Stable releases only').click();
await p.waitForFunction(() => document.querySelector('.statgrid')?.innerText.includes('8.0.0'));
check('stable only: the newest is the stable release', (await stat('newest version')) === '8.0.0');
await p.getByLabel('Test releases and stable').click();
await p.waitForFunction(() => document.querySelector('.statgrid')?.innerText.includes('9.0.0-test.10'));
check('test releases: -test.10 is newer than -test.9', (await stat('newest version')) === '9.0.0-test.10');

// ---- skip ----
await p.getByRole('button', { name: 'Skip this version' }).click();
await p.waitForFunction(() => !document.querySelector('.updatebadge'));
check('Skip removes the badge', (await badge.count()) === 0);
check('a skipped version still shows in Settings', /you skipped it/.test(await p.locator('[role=status]').innerText()) && (await stat('newest version')) === '9.0.0-test.10');
check('its notes are still there', (await p.locator('.settings-body .relnotes').innerText()).includes('Second line'));
const p2 = await open(b, 1000, 800);
check('another browser agrees: no badge', (await p2.locator('.updatebadge').count()) === 0);
await p2.close();
await p.reload(); await p.waitForSelector('.panel'); await p.waitForTimeout(500);
check('and so does a reload', (await p.locator('.updatebadge').count()) === 0);

// a newer release brings the badge back
releases.unshift({ tag_name: 'v9.0.0-test.11', prerelease: true, name: 'Eleven', body: 'newest', published_at: '2026-03-01T00:00:00Z' });
await openUpdates();
await p.getByRole('button', { name: 'Check now' }).click();
await badge.waitFor({ timeout: 10000 });
check('a release newer than the skipped one shows the badge again', /9\.0\.0-test\.11/.test(await badge.innerText()));

// ---- a failed check keeps the answer, quietly ----
const consoleBefore = await p.evaluate(() => document.querySelector('[data-panel=console]')?.innerText.length ?? 0);
for (const m of ['down', 'junk']) {
  mode = m; await p.getByRole('button', { name: 'Check now' }).click();
  await p.waitForFunction(() => /last try failed/.test(document.querySelector('.settings-body')?.innerText ?? ''));
  check(`a failed check (${m}) says why and keeps the newest version`, (await stat('newest version')) === '9.0.0-test.11' && (await badge.count()) === 1);
}
const consoleAfter = await p.evaluate(() => document.querySelector('[data-panel=console]')?.innerText.length ?? 0);
check('a failed check does not write to the Console', consoleAfter === consoleBefore);
mode = 'ok'; const a0 = asked; await p.getByRole('button', { name: 'Check now' }).click();
while (asked === a0) await p.waitForTimeout(50);
await p.waitForFunction(() => !/last try failed/.test(document.querySelector('.settings-body')?.innerText ?? ''));
await p.waitForTimeout(400);   // the answer has been read and shown
check('the next good check clears the message', !/last try failed/.test(await p.locator('.settings-body').innerText()));

// ---- turning the check off ----
const before = asked;
await p.getByLabel('Look for new versions on GitHub').click();
await p.waitForFunction(() => !document.querySelector('.updatebadge'));
check('turned off: no badge', (await badge.count()) === 0);
check('turned off: Check now is disabled and the page says so', await p.getByRole('button', { name: 'Check now' }).isDisabled() && /turned off/.test(await p.locator('[role=status]').innerText()));
check('turned off: nothing is asked of GitHub', asked === before, `asked ${asked}, before ${before}`);
await p.getByLabel('Look for new versions on GitHub').click();
await badge.waitFor({ timeout: 10000 });
check('turned back on: the badge returns', true);

// ---- a viewer (reaches DemonX through a proxy header, so no PIN yet means watch only) ----
const viewer = await new Promise((resolve) => {
  const ws = new WebSocket(URL_BASE.replace(/^http/, 'ws') + '/ws', { headers: { 'x-forwarded-for': '203.0.113.9' } });
  const got = { snapshot: null, denied: 0, config: 0 };
  ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    if (m.type === 'snapshot') {
      got.snapshot = m.data;
      for (const msg of [{ type: 'updateSkip', version: '9.0.0-test.11' }, { type: 'updateCheck' }, { type: 'updateApply', version: '9.0.0-test.11' }, { type: 'configSet', update: { updates: { check: false } } }]) ws.send(JSON.stringify(msg));
      setTimeout(() => { ws.close(); resolve(got); }, 1500);
    }
    if (m.type === 'denied') got.denied++;
    if (m.type === 'config') got.config++;
  });
});
check('a viewer is told about the update', viewer.snapshot?.update?.newer === true && viewer.snapshot.auth.operator === false);
check('a viewer cannot skip, check, update or change the settings', viewer.denied === 4 && viewer.config === 0);
await p.waitForTimeout(300);
check('and nothing changed', (await badge.count()) === 1);

// GET /api/busy: what scripts/update.sh asks before it restarts DemonX. This computer only, read only.
const busyUrl = `${new URL(p.url()).origin}/api/busy`;
const busyRes = await fetch(busyUrl);
const busyJson = await busyRes.json().catch(() => null);
check('/api/busy answers this computer: idle, with a reason that is empty', busyRes.status === 200 && busyJson?.busy === false && busyJson?.reason === '', JSON.stringify(busyJson));
check('/api/busy refuses a request that came through a proxy', (await fetch(busyUrl, { headers: { 'x-forwarded-for': '192.168.1.50' } })).status === 403);
check('/api/busy is read only', (await fetch(busyUrl, { method: 'POST' })).status === 405);

check('no page errors', p.errors.length === 0, p.errors.join('; '));
console.log(`${ok} passed, ${bad} failed`);
await b.close(); fake.close();
