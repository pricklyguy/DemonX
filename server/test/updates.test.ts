import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanVersion, compareVersionStrings, defaultUpdateSettings, parseReleases, parseVersion, pickUpdate, plainText, followsTestReleases, type UpdateRelease, type UpdateSettings } from '../../shared/updates.js';
import { UpdateChecker, releasePageUrl } from '../src/updates.js';
import { applyUpdate, defaultConfig, ConfigError } from '../src/config.js';

const rel = (version: string, extra: Partial<UpdateRelease> = {}): UpdateRelease => ({ version, tag: 'v' + version, prerelease: version.includes('-'), name: '', notes: '', publishedAt: '', ...extra });
const cmp = (a: string, b: string) => Math.sign(compareVersionStrings(a, b)!);
const settings = (s: Partial<UpdateSettings> = {}): UpdateSettings => ({ ...defaultUpdateSettings(), ...s });

describe('version comparison', () => {
  it('orders numbers numerically, not as text', () => {
    expect(cmp('2.0.0-test.9', '2.0.0-test.10')).toBe(-1);
    expect(cmp('2.0.0-test.10', '2.0.0-test.9')).toBe(1);
    expect(cmp('1.9.0', '1.10.0')).toBe(-1);
    expect(cmp('v2.0.0', '2.0.0')).toBe(0);
  });
  it('puts a test release before the release it leads to, and after the one before', () => {
    expect(cmp('2.0.0-test.3', '2.0.0')).toBe(-1);
    expect(cmp('2.0.0', '2.0.0-test.3')).toBe(1);
    expect(cmp('1.9.9', '2.0.0-test.1')).toBe(-1);
    expect(cmp('2.0.0-test.1', '2.0.0-test.1')).toBe(0);
    expect(cmp('2.0.0-alpha', '2.0.0-test.1')).toBe(-1);       // words compare as text
    expect(cmp('2.0.0-test', '2.0.0-test.1')).toBe(-1);        // fewer parts is older
    expect(cmp('2.0.0-1', '2.0.0-test')).toBe(-1);             // numbers sort before words
  });
  it('ignores build metadata', () => {
    expect(cmp('2.0.0+abc', '2.0.0+def')).toBe(0);
    expect(cleanVersion('v2.0.0-test.3+x')).toBe('2.0.0-test.3');
  });
  it('rejects what is not a version', () => {
    for (const s of ['', 'latest', '2.0', '2.0.0.1', '01.2.3', 'v2.0.0-', '2.0.0-test..1', '2.0.0 (abc)', '<script>', '99999999999999999999.0.0', 5, null, undefined, 'x'.repeat(100)]) {
      expect(parseVersion(s)).toBeNull();
    }
    expect(compareVersionStrings('2.0.0', 'nope')).toBeNull();
  });
});

describe('which release applies', () => {
  const list = [rel('2.0.0-test.10'), rel('2.0.0-test.9'), rel('2.0.0-test.3'), rel('1.5.0')];

  it('follows test releases while running one, and picks the newest by version, not by list order', () => {
    const p = pickUpdate(list, '2.0.0-test.3', settings());
    expect(p.latest?.version).toBe('2.0.0-test.10');
    expect(p.newer).toBe(true);
    expect(pickUpdate([...list].reverse(), '2.0.0-test.3', settings()).latest?.version).toBe('2.0.0-test.10');
  });
  it('is up to date when nothing is newer', () => {
    const p = pickUpdate(list, '2.0.0-test.10', settings());
    expect(p.latest?.version).toBe('2.0.0-test.10');
    expect(p.newer).toBe(false);
    expect(pickUpdate(list, '3.0.0', settings()).newer).toBe(false);
  });
  it('offers a stable release to a test install once it exists', () => {
    expect(pickUpdate([...list, rel('2.0.0')], '2.0.0-test.10', settings()).latest?.version).toBe('2.0.0');
  });
  it('a stable install ignores test releases unless it asked for them', () => {
    const l = [...list, rel('1.6.0')];
    expect(pickUpdate(l, '1.5.0', settings()).latest?.version).toBe('1.6.0');
    expect(pickUpdate(l, '1.5.0', settings({ channel: 'test' })).latest?.version).toBe('2.0.0-test.10');
    expect(pickUpdate(l, '1.5.0', settings({ channel: 'stable' })).latest?.version).toBe('1.6.0');
    expect(pickUpdate(list, '1.5.0', settings()).newer).toBe(false);   // only test releases are newer
  });
  it('a test install can choose stable only', () => {
    const p = pickUpdate(list, '2.0.0-test.3', settings({ channel: 'stable' }));
    expect(p.latest?.version).toBe('1.5.0');
    expect(p.newer).toBe(false);
    expect(followsTestReleases('auto', '2.0.0-test.3')).toBe(true);
    expect(followsTestReleases('auto', '2.0.0')).toBe(false);
    expect(followsTestReleases('auto', 'unknown')).toBe(false);
  });
  it('a release GitHub marks as a pre-release is treated as one even with a plain version', () => {
    const l = [rel('1.6.0', { prerelease: true }), rel('1.5.0')];
    expect(pickUpdate(l, '1.5.0', settings()).newer).toBe(false);
    expect(pickUpdate(l, '1.5.0', settings({ channel: 'test' })).latest?.version).toBe('1.6.0');
  });
  it('a skipped version is still returned, marked skipped, and a newer one is not', () => {
    const p = pickUpdate(list, '2.0.0-test.3', settings({ skipped: '2.0.0-test.10' }));
    expect(p).toMatchObject({ newer: true, skipped: true });
    expect(p.latest?.version).toBe('2.0.0-test.10');
    expect(pickUpdate([rel('2.0.0-test.11'), ...list], '2.0.0-test.3', settings({ skipped: '2.0.0-test.10' })).skipped).toBe(false);
    expect(pickUpdate(list, '2.0.0-test.3', settings({ skipped: 'v2.0.0-test.10' })).skipped).toBe(true);
  });
  it('says nothing when the check is turned off', () => {
    expect(pickUpdate(list, '2.0.0-test.3', settings({ check: false }))).toEqual({ latest: null, newer: false, skipped: false });
  });
  it('says nothing for no releases or an unknown running version', () => {
    expect(pickUpdate([], '2.0.0', settings()).latest).toBeNull();
    expect(pickUpdate(list, 'unknown', settings()).latest).toBeNull();
  });
});

describe('what GitHub answers', () => {
  it('keeps real releases and drops drafts and odd tags', () => {
    const r = parseReleases([
      { tag_name: 'v2.0.0-test.3', name: 'Test 3', body: 'Notes', prerelease: true, published_at: '2026-01-02T03:04:05Z', html_url: 'https://evil.example/x' },
      { tag_name: 'v2.0.0', draft: true },
      { tag_name: 'nightly' }, { tag_name: 'v2.0' }, { tag_name: '2.0.0' }, { tag_name: 'v2.0.0 ; rm -rf /' }, { tag_name: 5 }, null, 'text', [],
      { tag_name: 'v1.0.0+build5', body: 'x' },
    ])!;
    expect(r.map((x) => x.tag)).toEqual(['v2.0.0-test.3']);
    expect(r[0]).toMatchObject({ version: '2.0.0-test.3', prerelease: true, name: 'Test 3', notes: 'Notes', publishedAt: '2026-01-02T03:04:05.000Z' });
    expect(JSON.stringify(r)).not.toContain('evil');
  });
  it('gives null for an answer that is not a list, so the caller keeps its last one', () => {
    for (const a of [null, undefined, 5, 'x', {}, { message: 'API rate limit exceeded' }]) expect(parseReleases(a)).toBeNull();
    expect(parseReleases([])).toEqual([]);
  });
  it('keeps notes as plain text, limited in length', () => {
    expect(plainText('a\u0000b‮c\r\nd', 100)).toBe('abc\nd');
    expect(plainText('<img src=x onerror=alert(1)>', 100)).toBe('<img src=x onerror=alert(1)>');   // kept as text: the page shows it as text
    expect(plainText('x'.repeat(50), 10)).toBe('x'.repeat(10) + '…');
    expect(plainText({ not: 'text' }, 10)).toBe('');
    expect(parseReleases([{ tag_name: 'v1.0.0', body: 'y'.repeat(100_000) }])![0].notes.length).toBeLessThan(6100);
  });
  it('builds the release page from the tag, on GitHub', () => {
    expect(releasePageUrl('v2.0.0-test.4')).toBe('https://github.com/pricklyguy/DemonX/releases/tag/v2.0.0-test.4');
  });
});

describe('UpdateChecker', () => {
  const answer = (body: unknown, init: ResponseInit = {}) => () => Promise.resolve(new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200, ...init }));
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'demonx-upd-'));
  const make = (fetch: ConstructorParameters<typeof UpdateChecker>[0]['fetch'], extra: Partial<ConstructorParameters<typeof UpdateChecker>[0]> = {}) =>
    new UpdateChecker({ current: '2.0.0-test.3', settings: () => settings(), install: 'git', fetch, ...extra });
  const good = [{ tag_name: 'v2.0.0-test.4', prerelease: true, body: 'What is new' }, { tag_name: 'v2.0.0-test.3', prerelease: true }];

  it('finds a newer release and reports it', async () => {
    let asked = '';
    const u = make((url, init) => { asked = url; expect(init.headers['user-agent']).toContain('DemonX/2.0.0-test.3'); return answer(good)(); });
    const seen: boolean[] = [];
    u.on('update', (v) => seen.push(v.checking));
    await u.check();
    const v = u.view();
    expect(asked).toContain('api.github.com/repos/pricklyguy/DemonX/releases');
    expect(v).toMatchObject({ current: '2.0.0-test.3', enabled: true, checking: false, error: '', newer: true, skipped: false, install: 'git' });
    expect(v.latest?.version).toBe('2.0.0-test.4');
    expect(v.url).toBe('https://github.com/pricklyguy/DemonX/releases/tag/v2.0.0-test.4');
    expect(v.checkedAt).toBeGreaterThan(0);
    expect(seen).toEqual([true, false]);
  });

  it('keeps the last answer through every kind of failure', async () => {
    let next: () => Promise<Response> = answer(good);
    const u = make(() => next());
    await u.check();
    const before = u.view().latest;
    const failures: [string, () => Promise<Response>, RegExp][] = [
      ['no network', () => Promise.reject(new TypeError('fetch failed')), /Could not reach GitHub/],
      ['timeout', () => Promise.reject(Object.assign(new Error('x'), { name: 'AbortError' })), /did not answer in time/],
      ['server error', answer('oops', { status: 500 }), /500/],
      ['rate limit', answer({ message: 'API rate limit exceeded' }, { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600) } }), /limiting requests/],
      ['too many requests', answer('', { status: 429 }), /limiting requests/],
      ['not json', answer('<html>'), /not a release list/],
      ['not a list', answer({ message: 'hi' }), /not a release list/],
      ['null', answer('null'), /not a release list/],
      ['not found', answer('', { status: 404 }), /no release list/],
    ];
    for (const [name, f, msg] of failures) {
      next = f;
      await expect(u.check(), name).resolves.toBeUndefined();     // never throws
      expect(u.view().error, name).toMatch(msg);
      expect(u.view().latest, name).toEqual(before);
      expect(u.view().checking).toBe(false);
    }
    next = answer(good);
    await u.check();
    expect(u.view().error).toBe('');
  });

  it('refuses an answer that is too large', async () => {
    const u = make(answer('[' + '0,'.repeat(1_500_000) + '0]'));
    await u.check();
    expect(u.view().error).toMatch(/too large/);
    expect(u.view().latest).toBeNull();
  });

  it('survives a restart, and a failed check after a restart does not clear it', async () => {
    const dir = tmp();
    await make(answer(good), { dataDir: dir }).check();
    expect(fs.existsSync(path.join(dir, 'update.json'))).toBe(true);
    const again = make(() => Promise.reject(new TypeError('fetch failed')), { dataDir: dir });
    expect(again.view().latest?.version).toBe('2.0.0-test.4');
    expect(again.view().newer).toBe(true);
    await again.check();
    expect(again.view().latest?.version).toBe('2.0.0-test.4');
    expect(again.view().error).toMatch(/Could not reach/);
    expect(make(answer(good), { dataDir: dir }).view().error).toMatch(/Could not reach/);   // the reason is remembered too
  });

  it('reads a damaged or hand-edited file safely', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'update.json'), '{ not json');
    expect(make(answer(good), { dataDir: dir }).view().latest).toBeNull();
    fs.writeFileSync(path.join(dir, 'update.json'), JSON.stringify({ checkedAt: 'x', releases: [{ tag_name: 'v9.9.9' }, { version: '9.9.9', tag: 'v9.9.9' }, { tag_name: 'v3.0.0', body: '\u0000bad' }] }));
    const v = make(answer(good), { dataDir: dir }).view();
    expect(v.latest?.version).toBe('9.9.9');
    expect(v.checkedAt).toBe(0);
  });

  it('does not ask while two checks overlap', async () => {
    let calls = 0;
    const u = make(() => { calls++; return answer(good)(); });
    await Promise.all([u.check(), u.check()]);
    expect(calls).toBe(1);
  });

  it('follows the settings at the time of asking: skip, channel and off', async () => {
    let s = settings();
    const u = make(answer(good), { settings: () => s });
    await u.check();
    s = settings({ skipped: '2.0.0-test.4' });
    expect(u.view()).toMatchObject({ newer: true, skipped: true });
    s = settings({ channel: 'stable' });
    expect(u.view()).toMatchObject({ newer: false, latest: null });
    s = settings({ check: false });
    expect(u.view()).toMatchObject({ enabled: false, newer: false, latest: null });
  });

  it('asks again only when it is due: a day after a good answer, an hour after a failure, never when off', async () => {
    let t = 1_000_000_000_000;
    let calls = 0, fail = false;
    let s = settings();
    const u = make(() => { calls++; return fail ? Promise.reject(new TypeError('fetch failed')) : answer(good)(); }, { now: () => t, settings: () => s });
    const due = async () => { u.settingsChanged(); await new Promise((r) => setTimeout(r, 5)); };
    await due(); expect(calls).toBe(1);
    t += 3_600_000; await due(); expect(calls).toBe(1);                  // an hour after a good answer: not yet
    t += 24 * 3_600_000; fail = true; await due(); expect(calls).toBe(2); // a day: yes (and it fails)
    t += 30 * 60_000; await due(); expect(calls).toBe(2);                // 30 minutes after a failure: wait
    t += 31 * 60_000; await due(); expect(calls).toBe(3);                // an hour after a failure: try again
    s = settings({ check: false }); t += 48 * 3_600_000; await due(); expect(calls).toBe(3);
  });

  it('does nothing when asked to check while turned off', async () => {
    let calls = 0;
    const u = make(() => { calls++; return answer(good)(); }, { settings: () => settings({ check: false }) });
    await u.check();
    expect(calls).toBe(0);
  });

  it('a plain 403 is not mistaken for a rate limit, and only a change is announced', async () => {
    const u = make(answer('', { status: 403 }));
    const sent: unknown[] = [];
    u.on('update', (v) => sent.push(v));
    await u.check();
    expect(u.view().error).toBe('GitHub answered 403');
    const n = sent.length;
    u.settingsChanged(); u.settingsChanged();
    expect(sent.length).toBe(n);            // another setting changed: the update view did not
  });

  it('waits out a rate limit', async () => {
    let t = 1_000_000_000_000, calls = 0;
    const u = make(() => { calls++; return answer('', { status: 429, headers: { 'retry-after': String(5 * 3600) } })(); }, { now: () => t });
    await u.check(); expect(calls).toBe(1);
    t += 2 * 3_600_000; u.settingsChanged(); await new Promise((r) => setTimeout(r, 5)); expect(calls).toBe(1);
    t += 4 * 3_600_000; u.settingsChanged(); await new Promise((r) => setTimeout(r, 5)); expect(calls).toBe(2);
  });
});

describe('update settings', () => {
  it('start on, automatic, nothing skipped', () => {
    expect(defaultConfig().updates).toEqual({ check: true, channel: 'auto', skipped: '', apply: false });
  });
  it('accept valid changes and clean the skipped version', () => {
    const c = applyUpdate(defaultConfig(), { updates: { check: false, channel: 'stable', skipped: ' v2.0.0-test.4 ' } });
    expect(c.updates).toEqual({ check: false, channel: 'stable', skipped: '2.0.0-test.4', apply: false });
    expect(applyUpdate(c, { updates: { skipped: '' } }).updates.skipped).toBe('');
    expect(applyUpdate(c, { updates: { check: true } }).updates).toMatchObject({ check: true, channel: 'stable' });
  });
  it('refuse anything else', () => {
    for (const u of [{ channel: 'nightly' }, { skipped: 'latest' }, { skipped: '2.0' }, { skipped: 5 }, { skipped: 'x'.repeat(500) }]) {
      expect(() => applyUpdate(defaultConfig(), { updates: u as never })).toThrow(ConfigError);
    }
  });
});
