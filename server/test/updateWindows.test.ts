import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WindowsUpdater, parseChecksum, trustedDownload, zipName, RESTART_CODE, type WindowsOptions } from '../src/updateWindows.js';
import { UPDATE_JOB_BLOCK, UPDATE_LOCK } from '../src/updateApply.js';
import type { UpdateRelease } from '../../shared/updates.js';

// Update now for the Windows package, against a local server that stands in for GitHub's release downloads and real zip files.
// (On Windows the zip is unpacked by tar.exe; here by unzip.)

const rel = (version: string): UpdateRelease => ({ version, tag: 'v' + version, prerelease: false, name: '', notes: '', publishedAt: '' });
let tmp: string, home: string, data: string, srv: http.Server, port: number;
let files: Map<string, Buffer | { status: number; headers?: Record<string, string> }>;
let exits: number[], blocks: (string | null)[], locks: (string | null)[], busyNow: string | null;

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

/** A release zip like the build makes it: DemonX/versions/<version>/app/... (plus things outside versions that are never used) */
function makeZip(version: string, mutate: (root: string) => void = () => {}): Buffer {
  const root = fs.mkdtempSync(path.join(tmp, 'zip-'));
  const app = path.join(root, 'DemonX', 'versions', version, 'app');
  fs.mkdirSync(path.join(app, 'web'), { recursive: true });
  fs.mkdirSync(path.join(app, 'node_modules', 'ws'), { recursive: true });
  fs.writeFileSync(path.join(app, 'server.mjs'), '// server');
  fs.writeFileSync(path.join(app, 'web', 'index.html'), '<html>');
  fs.writeFileSync(path.join(app, 'node_modules', 'ws', 'index.js'), '//');
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'demonx', version }));
  fs.writeFileSync(path.join(root, 'DemonX', 'Start DemonX.bat'), 'never installed by an update');
  mutate(root);
  const zip = path.join(root, 'out.zip');
  // Windows has no zip program, but its own tar (the one the updater unpacks with) writes zips too
  if (process.platform === 'win32') execFileSync('tar', ['-a', '-c', '-f', zip, '-C', root, 'DemonX']);
  else execFileSync('zip', ['-q', '-r', '-y', zip, 'DemonX'], { cwd: root });
  return fs.readFileSync(zip);
}
function publish(version: string, zip = makeZip(version), sum: string | null = `${sha(zip)}  ${zipName(version)}\n`) {
  files.set(`/v${version}/${zipName(version)}`, zip);
  if (sum !== null) files.set(`/v${version}/${zipName(version)}.sha256`, Buffer.from(sum));
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'demonx-winupd-'));
  home = path.join(tmp, 'DemonX'); data = path.join(home, 'data');
  fs.mkdirSync(path.join(home, 'versions', '1.0.0', 'app'), { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(home, 'current.txt'), '1.0.0');
  files = new Map(); exits = []; blocks = []; locks = []; busyNow = null;
  srv = http.createServer((req, res) => {
    const f = files.get(req.url ?? '');
    if (!f) { res.writeHead(404).end('no'); return; }
    if (Buffer.isBuffer(f)) { res.writeHead(200, { 'content-length': f.length }).end(f); return; }
    res.writeHead(f.status, f.headers).end();
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  port = (srv.address() as { port: number }).port;
});
afterEach(async () => { await new Promise<void>((r) => srv.close(() => r())); fs.rmSync(tmp, { recursive: true, force: true }); });

function make(over: Partial<WindowsOptions> = {}, offered: UpdateRelease | null = rel('1.1.0')) {
  return new WindowsUpdater({
    home, dataDir: data, current: '1.0.0', launcher: true, platform: 'win32', allowed: () => true, offered: () => offered, busy: () => busyNow,
    log: () => {}, jobBlock: (r) => blocks.push(r), lock: (r) => locks.push(r), downloadBase: `http://127.0.0.1:${port}`, trust: (u) => u.hostname === '127.0.0.1',
    exit: (c) => exits.push(c), restartDelayMs: 5, pollMs: 5, waitMs: 150, confirmAfterMs: 60_000, ...over,
  });
}
const text = (f: string) => fs.readFileSync(path.join(home, f), 'utf8').trim();
const exists = (f: string) => fs.existsSync(path.join(home, f));
const waitExit = async () => { for (let i = 0; i < 200 && !exits.length; i++) await new Promise((r) => setTimeout(r, 10)); };
const unchanged = () => { expect(text('current.txt')).toBe('1.0.0'); expect(exists('previous.txt')).toBe(false); expect(exists('data/update-pending.json')).toBe(false); expect(exits).toEqual([]); expect(exists('data/update')).toBe(false); };

describe('Update now on Windows: the install', () => {
  it('downloads, checks, unpacks beside the running version, switches current.txt, and asks the launcher to restart (exit 75)', async () => {
    publish('1.1.0');
    const a = make();
    expect(await a.apply('1.1.0')).toBe('');
    await waitExit();
    expect(a.view().state).toBe('done');
    expect(exits).toEqual([RESTART_CODE]);
    expect(exists('versions/1.1.0/app/server.mjs')).toBe(true);
    expect(exists('versions/1.1.0/app/node_modules/ws/index.js')).toBe(true);
    expect(exists('versions/1.0.0')).toBe(true);                                  // the running version is untouched
    expect(exists('Start DemonX.bat')).toBe(false);                               // only the version folder is taken from the zip
    expect(text('current.txt')).toBe('1.1.0');
    expect(text('previous.txt')).toBe('1.0.0');
    expect(JSON.parse(text('data/update-pending.json'))).toMatchObject({ version: '1.1.0', previous: '1.0.0' });
    expect(JSON.parse(text('data/update-applied.json'))).toEqual({ from: '1.0.0', to: '1.1.0' });
    expect(exists('data/update')).toBe(false);                                    // the download and the unpacked copy are gone
    expect(blocks).toEqual([UPDATE_JOB_BLOCK]);                                   // held until DemonX exits
    expect(locks).toEqual([UPDATE_LOCK]);
  });

  it('the next process says what happened, once, and confirms the update only for its own version', () => {
    fs.writeFileSync(path.join(data, 'update-applied.json'), JSON.stringify({ from: '1.0.0', to: '1.1.0' }));
    fs.writeFileSync(path.join(data, 'update-pending.json'), JSON.stringify({ version: '1.1.0', previous: '1.0.0' }));
    const b = make({ current: '1.1.0' });
    expect(b.view().state).toBe('done');
    expect(b.view().message).toBe('Updated from 1.0.0 to 1.1.0.');
    expect(exists('data/update-applied.json')).toBe(false);
    b.confirmStarted();
    expect(exists('data/update-pending.json')).toBe(false);
    // a pending mark for a different version is not this process's to confirm
    fs.writeFileSync(path.join(data, 'update-pending.json'), JSON.stringify({ version: '9.9.9', previous: '1.1.0' }));
    b.confirmStarted();
    expect(exists('data/update-pending.json')).toBe(true);
    expect(make({ current: '1.1.0' }).view().state).toBe('idle');                  // and only once
  });

  it('says so when the launcher had to put the old version back, once', () => {
    fs.writeFileSync(path.join(data, 'update-failed.json'), JSON.stringify({ version: '1.1.0', previous: '1.0.0', why: 'it stopped with exit code 1 soon after it started' }));
    const a = make();
    expect(a.view().state).toBe('failed');
    expect(a.view().message).toBe('1.1.0 was installed but it stopped with exit code 1 soon after it started, so version 1.0.0 is running again. Nothing of yours was changed.');
    expect(exists('data/update-failed.json')).toBe(false);
    expect(make().view().state).toBe('idle');
  });

  it('replaces a half-finished earlier try at the same version', async () => {
    publish('1.1.0');
    fs.mkdirSync(path.join(home, 'versions', '1.1.0', 'app'), { recursive: true });
    fs.writeFileSync(path.join(home, 'versions', '1.1.0', 'app', 'leftover.txt'), 'old try');
    await make().apply('1.1.0');
    await waitExit();
    expect(exists('versions/1.1.0/app/leftover.txt')).toBe(false);
    expect(exists('versions/1.1.0/app/server.mjs')).toBe(true);
  });
});

describe('Update now on Windows: when it must not go ahead', () => {
  it('refuses when it is not the Windows package, not started by the launcher, turned off, or not the release on offer', async () => {
    publish('1.1.0');
    expect(await make({ platform: 'linux' }).apply('1.1.0')).toMatch(/Windows package/);
    expect(await make({ launcher: false }).apply('1.1.0')).toMatch(/Start DemonX\.bat/);
    expect(await make({ allowed: () => false }).apply('1.1.0')).toMatch(/turned off/);
    expect(await make().apply('9.9.9')).toMatch(/not the release on offer/);
    expect(await make({}, null).apply('1.1.0')).toMatch(/no newer release/);
    expect(await make({}, { ...rel('1.1.0'), tag: 'v1.1.0/../../x' }).apply('1.1.0')).toMatch(/not the release on offer/);
    expect(blocks).toEqual([]);
    unchanged();
  });

  it('says whether it can be used, and why not', () => {
    expect(make().view()).toMatchObject({ available: true, reason: '' });
    expect(make({ allowed: () => false }).view()).toMatchObject({ available: false, reason: expect.stringMatching(/turned off/) });
  });

  it('refuses while the machine is busy and changes nothing', async () => {
    publish('1.1.0');
    busyNow = 'a job is running';
    const a = make();
    expect(await a.apply('1.1.0')).toMatch(/Not now: a job is running/);
    expect(a.view().state).toBe('idle');
    expect(blocks).toEqual([]);
    unchanged();
  });

  it('refuses a second press while the first is running', async () => {
    publish('1.1.0');
    const a = make();
    const first = a.apply('1.1.0');
    expect(await a.apply('1.1.0')).toBe('An update is already running.');
    await first;
    await waitExit();
    expect(exits).toEqual([RESTART_CODE]);
  });
});

describe('Update now on Windows: a bad download changes nothing', () => {
  const failed = async (a: WindowsUpdater, step: RegExp, msg: RegExp) => {
    await a.apply('1.1.0');
    expect(a.view().state).toBe('failed');
    expect(a.view().step).toMatch(step);
    expect(a.view().message).toMatch(msg);
    expect(blocks).toEqual([UPDATE_JOB_BLOCK, null]);   // the job block is given back
    expect(locks).toEqual([]);
    unchanged();
    expect(exists('versions/1.1.0')).toBe(false);
  };

  it('no checksum published with the release: not installed', async () => {
    publish('1.1.0', undefined, null);
    await failed(make(), /checksum/, /no published checksum/);
  });

  it('a checksum that does not match the download', async () => {
    publish('1.1.0', undefined, `${'0'.repeat(64)}  ${zipName('1.1.0')}\n`);
    await failed(make(), /Checking the download/, /does not match the checksum/);
  });

  it('a checksum file that is not for this zip, or not a checksum at all', async () => {
    const zip = makeZip('1.1.0');
    publish('1.1.0', zip, `${sha(zip)}  some-other-file.zip\n`);
    await failed(make(), /checksum/, /does not give a SHA-256/);
  });

  it('a download that is larger than allowed', async () => {
    publish('1.1.0');
    await failed(make({ maxZipBytes: 100 }), /Downloading/, /larger than allowed/);
  });

  it('a release with no zip (404)', async () => {
    const zip = makeZip('1.1.0');
    files.set(`/v1.1.0/${zipName('1.1.0')}.sha256`, Buffer.from(`${sha(zip)}  ${zipName('1.1.0')}\n`));
    await failed(make(), /Downloading/, /no such file/);
  });

  it('GitHub sending the download to an address that is not trusted', async () => {
    const zip = makeZip('1.1.0');
    files.set(`/v1.1.0/${zipName('1.1.0')}.sha256`, Buffer.from(`${sha(zip)}  ${zipName('1.1.0')}\n`));
    files.set(`/v1.1.0/${zipName('1.1.0')}`, { status: 302, headers: { location: `http://localhost:${port}/elsewhere` } });
    await failed(make(), /Downloading/, /not allowed/);
  });

  it('a zip that cannot be unpacked', async () => {
    const junk = Buffer.from('this is not a zip');
    publish('1.1.0', junk, `${sha(junk)}  ${zipName('1.1.0')}\n`);
    await failed(make(), /Unpacking/, /could not unpack/);
  });

  it('a zip whose version is not the one on offer', async () => {
    const zip = makeZip('1.1.0', (root) => fs.writeFileSync(path.join(root, 'DemonX', 'versions', '1.1.0', 'app', 'package.json'), JSON.stringify({ version: '1.0.5' })));
    publish('1.1.0', zip);
    await failed(make(), /Checking the new version/, /says 1\.1\.0 but the download is 1\.0\.5/);
  });

  it('a zip with a file missing, or that holds a link', async () => {
    publish('1.1.0', makeZip('1.1.0', (root) => fs.rmSync(path.join(root, 'DemonX', 'versions', '1.1.0', 'app', 'server.mjs'))));
    await failed(make(), /Checking the new version/, /does not contain app\/server\.mjs/);
    if (process.platform === 'win32') return;   // making a link needs a privilege there
    blocks.length = 0;
    publish('1.1.0', makeZip('1.1.0', (root) => fs.symlinkSync('/etc', path.join(root, 'DemonX', 'versions', '1.1.0', 'app', 'link'))));
    await failed(make(), /Checking the new version/, /contains a link/);
  });

  it('the machine staying busy until the wait is over: installed, not switched, lock never taken', async () => {
    publish('1.1.0');
    const a = make({ busy: () => (exists('versions/1.1.0/app/server.mjs') ? 'a job is running' : null) });   // a job starts during the download
    await a.apply('1.1.0');
    expect(a.view().state).toBe('failed');
    expect(a.view().message).toMatch(/was not idle \(a job is running\).*Press Update now again/);
    expect(locks).toEqual([]);
    expect(text('current.txt')).toBe('1.0.0');
    expect(exits).toEqual([]);
    expect(blocks).toEqual([UPDATE_JOB_BLOCK, null]);
  });
});

describe('the updater and the launcher agree (the real launcher reads what the updater wrote)', () => {
  const LAUNCHER = path.resolve(__dirname, '../../scripts/windows/launcher.mjs');
  const launch = () => spawnSync(process.execPath, [path.join(home, 'launcher.mjs'), 'cnc'], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, DEMONX_DATA: '', DEMONX_WEB: '', DESIGN_WEB: '' } });
  beforeEach(() => {
    fs.copyFileSync(LAUNCHER, path.join(home, 'launcher.mjs'));
    fs.writeFileSync(path.join(home, 'versions', '1.0.0', 'app', 'server.mjs'), 'process.exit(0);');
  });

  it('a new version that starts: the launcher runs it and the next updater process says it updated', async () => {
    publish('1.1.0', makeZip('1.1.0', (root) => fs.writeFileSync(path.join(root, 'DemonX', 'versions', '1.1.0', 'app', 'server.mjs'), 'process.exit(0);')));
    await make().apply('1.1.0');
    await waitExit();
    expect(launch().status).toBe(0);
    expect(text('current.txt')).toBe('1.1.0');
    const next = make({ current: '1.1.0' });
    expect(next.view().message).toBe('Updated from 1.0.0 to 1.1.0.');
    next.confirmStarted();
    expect(exists('data/update-pending.json')).toBe(false);
  });

  it('a new version that crashes at once: the launcher puts the old one back and the next updater process says so', async () => {
    publish('1.1.0', makeZip('1.1.0', (root) => fs.writeFileSync(path.join(root, 'DemonX', 'versions', '1.1.0', 'app', 'server.mjs'), 'process.exit(1);')));
    await make().apply('1.1.0');
    await waitExit();
    const r = launch();
    expect(r.status).toBe(0);                      // the old version ran and ended normally
    expect(r.stdout).toMatch(/Going back to 1\.0\.0/);
    expect(text('current.txt')).toBe('1.0.0');
    expect(exists('data/update-pending.json')).toBe(false);
    const after = make({ current: '1.0.0' });
    expect(after.view().state).toBe('failed');
    expect(after.view().message).toMatch(/1\.1\.0 was installed but it stopped with exit code 1.*version 1\.0\.0 is running again/);
  });
});

describe('helpers', () => {
  it('only trusts the DemonX release downloads on GitHub, over https', () => {
    for (const ok of ['https://github.com/pricklyguy/DemonX/releases/download/v1.0.0/x.zip', 'https://objects.githubusercontent.com/a', 'https://release-assets.githubusercontent.com/a']) expect(trustedDownload(new URL(ok)), ok).toBe(true);
    for (const bad of ['http://github.com/x', 'https://evil.example/github.com', 'https://github.com.evil.example/x', 'https://notgithubusercontent.com/x', 'file:///etc/passwd', 'ftp://github.com/x']) expect(trustedDownload(new URL(bad)), bad).toBe(false);
  });

  it('reads sha256sum output', () => {
    const h = 'a'.repeat(64);
    expect(parseChecksum(`${h}  f.zip\n`, 'f.zip')).toBe(h);
    expect(parseChecksum(`${h.toUpperCase()} *f.zip\r\n`, 'f.zip')).toBe(h);
    expect(parseChecksum(`${h}  other.zip\n`, 'f.zip')).toBeNull();
    expect(parseChecksum('not a checksum', 'f.zip')).toBeNull();
    expect(parseChecksum(`${'a'.repeat(63)}  f.zip`, 'f.zip')).toBeNull();
  });
});
