import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UpdateApplier, UPDATE_LOCK, UPDATE_JOB_BLOCK, restartWithPm2, killRunning, gitSshCommand, spindleBusy, SPINDLE_MEMORY_MS, defaultRun, GITHUB_ORIGIN, type ApplyOptions, type Run } from '../src/updateApply.js';
import { adoptStaged, stampStaged, swapBack, swapIn } from '../src/screen.js';
import { applyUpdate, defaultConfig } from '../src/config.js';
import { UpdateChecker } from '../src/updates.js';
import { defaultUpdateSettings } from '../../shared/updates.js';
import type { UpdateRelease } from '../../shared/updates.js';

// Update now, tried against real git: a local "origin" with release tags, a checkout that is on v1.0.0, and a fake npm and PM2.

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const rel = (version: string): UpdateRelease => ({ version, tag: 'v' + version, prerelease: false, name: '', notes: '', publishedAt: '' });

let tmp: string, repo: string, data: string, remote: string;
let locks: (string | null)[];
let blocks: (string | null)[];
let designCalls: string[], pm2Calls: string[], designFail: string | null, pm2Fail: boolean, events: string[];
let npmCalls: string[], npmFail: string | null, restarts: string[], restartError: string, busyNow: string | null;

function setup() {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'demonx-apply-'));
  remote = path.join(tmp, 'remote.git');
  const seed = path.join(tmp, 'seed');
  repo = path.join(tmp, 'install');
  data = path.join(tmp, 'data');
  fs.mkdirSync(data);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['init', '-q', '-b', 'main', seed]);
  const commit = (version: string, tag: string, file = version) => {
    fs.writeFileSync(path.join(seed, 'package.json'), JSON.stringify({ name: 'demonx', version }));
    fs.writeFileSync(path.join(seed, 'package-lock.json'), `{"lock":"${file}"}`);
    git(seed, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'add', '-A');
    git(seed, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', tag);
    git(seed, 'tag', tag);
  };
  commit('1.0.0', 'v1.0.0');
  commit('1.1.0', 'v1.1.0');
  commit('1.1.9', 'v1.2.0');            // a tag whose package.json does not match its name
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-q', 'origin', 'main', '--tags');
  git(tmp, 'clone', '-q', '--branch', 'v1.0.0', remote, repo);
  git(repo, 'checkout', '-q', '-B', 'main', 'v1.0.0');   // a checkout on a branch, like the install guides make
  writeScreen(path.join(repo, 'design', 'dist'), 'old design');   // DemonX Design beside it, as on a computer that has both
  writeScreen(path.join(repo, 'web', 'dist'), 'old 1.0.0');   // the screen the running server serves (not tracked by git, like the real one)
}

function writeScreen(dir: string, text: string) { fs.mkdirSync(path.join(dir, 'assets'), { recursive: true }); fs.writeFileSync(path.join(dir, 'index.html'), text); fs.writeFileSync(path.join(dir, 'assets', 'app.js'), text); }
const served = () => fs.readFileSync(path.join(repo, 'web', 'dist', 'index.html'), 'utf8');
const fakeRun: Run = async (cmd, args, o) => {
  if (cmd === 'pm2') { pm2Calls.push(args.join(' ')); events.push('pm2 ' + args.join(' ')); return pm2Fail ? { code: 1, out: 'pm2 broke' } : { code: 0, out: '' }; }
  if (cmd === 'npm' && o.cwd === path.join(repo, 'design')) {
    const call = args.join(' ');
    designCalls.push(call);
    if (designFail && call.startsWith(designFail)) { if (call.startsWith('run build')) writeScreen(path.join(o.cwd, 'dist-next'), 'half-built'); return { code: 1, out: 'npm ERR! design broke' }; }
    if (call.startsWith('run build')) { fs.rmSync(path.join(o.cwd, 'dist-next'), { recursive: true, force: true }); writeScreen(path.join(o.cwd, 'dist-next'), 'new design'); }
    return { code: 0, out: '' };
  }
  if (cmd === 'npm') {
    const call = args.join(' ');
    npmCalls.push(call + ' @' + git(o.cwd, 'rev-parse', '--short', 'HEAD'));
    if (npmFail && call === npmFail) { npmFail = null; if (call === 'run build:staging') writeScreen(path.join(o.cwd, 'web', 'dist-next'), 'half-built'); return { code: 1, out: 'npm ERR! it broke\nsecond line' }; }
    // like vite with --outDir dist-next: the new screen is written into the staging folder, and only there
    if (call === 'run build:staging') { const d = path.join(o.cwd, 'web', 'dist-next'); fs.rmSync(d, { recursive: true, force: true }); writeScreen(d, 'new ' + JSON.parse(git(o.cwd, 'show', 'HEAD:package.json')).version); }
    return { code: 0, out: '' };
  }
  return defaultRun(cmd, args, o);
};

function make(over: Partial<ApplyOptions> = {}, offered: UpdateRelease | null = rel('1.1.0')) {
  return new UpdateApplier({
    repoDir: repo, install: 'git', managed: true, processName: 'demonx', current: '1.0.0', allowed: () => true, offered: () => offered,
    busy: () => busyNow, log: () => {}, lock: (r) => locks.push(r), jobBlock: (r) => blocks.push(r), dataDir: data, run: fakeRun, originPattern: /./, pollMs: 5, waitMs: 2000,
    restart: async (n) => { restarts.push(n); return restartError; }, ...over,
  });
}
const head = () => git(repo, 'rev-parse', 'HEAD');

beforeEach(() => { designCalls = []; pm2Calls = []; designFail = null; pm2Fail = false; events = []; blocks = []; locks = []; npmCalls = []; npmFail = null; restarts = []; restartError = ''; busyNow = null; setup(); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const detached = () => { try { git(repo, 'symbolic-ref', '-q', 'HEAD'); return false; } catch { return true; } };
const tagCommit = (t: string) => git(repo, 'rev-parse', `${t}^{commit}`);

describe('Update now: the install', () => {
  it('switches to the release tag, installs, builds, then restarts once', async () => {
    const a = make();
    const before = head();
    await a.apply('1.1.0');
    const v = a.view();
    expect(v.state).toBe('done');
    expect(detached()).toBe(true);
    expect(head()).toBe(tagCommit('v1.1.0'));
    expect(head()).not.toBe(before);
    expect(npmCalls).toEqual([`install @${head().slice(0, 7)}`, `run build:staging @${head().slice(0, 7)}`]);
    expect(restarts).toEqual(['demonx']);
  });

  it('remembers what it did for the new process, once', async () => {
    await make().apply('1.1.0');
    expect(JSON.parse(fs.readFileSync(path.join(data, 'update-applied.json'), 'utf8'))).toEqual({ from: '1.0.0', to: '1.1.0' });   // "from" is read before the folder changes
    const lines: string[] = [];
    const b = make({ current: '1.1.0', log: (_k, t) => lines.push(t) });
    expect(b.view().state).toBe('done');
    expect(b.view().message).toBe('Updated from 1.0.0 to 1.1.0.');
    expect(lines).toEqual(['Updated from 1.0.0 to 1.1.0.']);
    expect(fs.existsSync(path.join(data, 'update-applied.json'))).toBe(false);
    expect(make({ current: '1.1.0' }).view().state).toBe('idle');   // and only once
  });

  it('does not claim an update when DemonX is running something else (the owner went back by hand)', async () => {
    await make().apply('1.1.0');
    const b = make({ current: '1.0.0' });
    expect(b.view().state).toBe('idle');
    expect(b.view().message).toBe('');
  });

  it('is not bothered by package-lock.json, which npm rewrites on every install', async () => {
    fs.writeFileSync(path.join(repo, 'package-lock.json'), '{"lock":"rewritten by npm on a Pi"}');
    const a = make();
    await a.apply('1.1.0');
    expect(a.view().state).toBe('done');
    expect(head()).toBe(tagCommit('v1.1.0'));
  });
});

describe('Update now: when it must not go ahead', () => {
  it('stops before touching anything when the folder has changes of its own', async () => {
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'demonx', version: '1.0.0', mine: true }));
    const before = head(), a = make();
    await a.apply('1.1.0');
    expect(a.view().state).toBe('failed');
    expect(a.view().message).toMatch(/changes of its own/);
    expect(head()).toBe(before);
    expect(JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).mine).toBe(true);
    expect(npmCalls).toEqual([]);
    expect(restarts).toEqual([]);
  });

  it('refuses an origin that is not the DemonX repository on GitHub', async () => {
    const a = make({ originPattern: GITHUB_ORIGIN });   // the test origin is a local path
    const before = head();
    await a.apply('1.1.0');
    expect(a.view().message).toMatch(/origin is not the DemonX repository/);
    expect(head()).toBe(before);
    expect(npmCalls).toEqual([]);
  });

  it('the origin pattern accepts the real addresses and nothing that merely contains them', () => {
    for (const ok of ['https://github.com/pricklyguy/DemonX.git', 'https://github.com/pricklyguy/DemonX', 'git@github.com:pricklyguy/DemonX.git', 'https://user@github.com/pricklyguy/demonx.git']) expect(GITHUB_ORIGIN.test(ok)).toBe(true);
    for (const bad of ['https://evil.example/github.com/pricklyguy/DemonX.git', 'https://github.com.evil.example/pricklyguy/DemonX', 'https://github.com/someone/DemonX.git', 'https://github.com/pricklyguy/DemonX.git.evil', 'https://github.com/pricklyguy/DemonX-fork']) expect(GITHUB_ORIGIN.test(bad)).toBe(false);
  });

  it('refuses a release whose package.json does not say the version it claims', async () => {
    const before = head(), a = make({}, rel('1.2.0'));
    await a.apply('1.2.0');
    expect(a.view().state).toBe('failed');
    expect(a.view().message).toMatch(/says 1\.1\.9/);
    expect(head()).toBe(before);
    expect(npmCalls).toEqual([]);
  });

  it('only installs the release that is on offer, whatever the browser asks for', async () => {
    const before = head(), a = make();
    const answers = [await a.apply('1.2.0'), await a.apply('v1.1.0'), await a.apply('1.1.0; rm -rf /')];
    for (const r of answers) expect(r).toMatch(/not the release on offer/);
    expect(a.view().state).toBe('idle');   // a refusal is for the browser that asked; it does not rewrite what every browser sees
    expect(head()).toBe(before);
    expect(npmCalls).toEqual([]);
  });

  it('does not start while the machine is busy', async () => {
    busyNow = 'a job is running';
    const before = head(), a = make();
    expect(await a.apply('1.1.0')).toMatch(/Not now: a job is running/);
    expect(a.view().state).toBe('idle');
    expect(head()).toBe(before);
    expect(npmCalls).toEqual([]);
  });

  it('says why it is not available', () => {
    expect(make({ allowed: () => false }).view()).toMatchObject({ available: false, reason: expect.stringMatching(/turned off/) });
    expect(make({ managed: false }).view()).toMatchObject({ available: false, reason: expect.stringMatching(/PM2/) });
    expect(make({ platform: 'win32' }).view()).toMatchObject({ available: false, reason: expect.stringMatching(/Windows/) });
    expect(make({ install: 'windows' }).view()).toMatchObject({ available: false, reason: expect.stringMatching(/git/) });
    expect(make({}, null).view()).toMatchObject({ available: false, reason: expect.stringMatching(/no newer release/) });
    expect(make().view()).toMatchObject({ available: true, reason: '' });
  });

  it('does nothing when it is turned off, even if asked', async () => {
    const before = head(), a = make({ allowed: () => false });
    expect(await a.apply('1.1.0')).toMatch(/turned off/);
    expect(a.view().state).toBe('idle');
    expect(head()).toBe(before);
    expect(npmCalls).toEqual([]);
    expect(restarts).toEqual([]);
  });

  it('does not install again, or lose its explanation, once the release is installed and only the restart is left', async () => {
    let first = true;
    const a = make({ waitMs: 20, busy: () => { if (first) { first = false; return null; } return 'a job is running'; } });
    await a.apply('1.1.0');
    const explanation = a.view().message;
    expect(explanation).toMatch(/installed, but the machine was not idle/);
    const calls = npmCalls.length, tip = head();
    busyNow = null;
    expect(a.view()).toMatchObject({ available: false, reason: expect.stringMatching(/already installed.*pm2 restart demonx/) });
    expect(await a.apply('1.1.0')).toMatch(/already installed/);
    expect(npmCalls.length).toBe(calls);                  // nothing was fetched, checked out or built again
    expect(head()).toBe(tip);
    expect(a.view().message).toBe(explanation);           // and a second press did not replace what every browser is told
  });

  it('says the version it was running before, not the one the folder holds now', async () => {
    await make({ current: '0.9.0' }).apply('1.1.0');
    expect(JSON.parse(fs.readFileSync(path.join(data, 'update-applied.json'), 'utf8'))).toEqual({ from: '0.9.0', to: '1.1.0' });
  });
});

describe('Update now: when something goes wrong half way', () => {
  it('puts the previous version back when the build fails, and does not restart', async () => {
    npmFail = 'run build:staging';
    const before = head(), a = make();
    await a.apply('1.1.0');
    const v = a.view();
    expect(v.state).toBe('failed');
    expect(v.step).toBe('Building the screen');
    expect(v.message).toMatch(/npm ERR! it broke/);
    expect(v.message).toMatch(/previous version was put back/);
    expect(head()).toBe(before);
    expect(detached()).toBe(false);                       // back on its branch
    expect(git(repo, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect(npmCalls.map((c) => c.split(' @')[0])).toEqual(['install', 'run build:staging', 'install']);   // the old packages come back; the old screen was never touched, so it is not rebuilt
    expect(restarts).toEqual([]);
    expect(fs.existsSync(path.join(data, 'update-applied.json'))).toBe(false);
  });

  it('puts it back when npm install fails too', async () => {
    npmFail = 'install';
    const before = head(), a = make();
    await a.apply('1.1.0');
    expect(a.view().step).toBe('Installing packages');
    expect(head()).toBe(before);
    expect(restarts).toEqual([]);
  });

  it('can be tried again after a failure', async () => {
    npmFail = 'run build:staging';
    const a = make();
    await a.apply('1.1.0');
    expect(a.view().state).toBe('failed');
    expect(a.view().available).toBe(true);
    npmFail = null;
    await a.apply('1.1.0');
    expect(a.view().state).toBe('done');
    expect(head()).toBe(tagCommit('v1.1.0'));
  });

  it('says so, and keeps the install, when PM2 cannot be asked to restart', async () => {
    restartError = 'pm2 was not found';
    const a = make();
    await a.apply('1.1.0');
    expect(a.view().state).toBe('failed');
    expect(a.view().message).toMatch(/installed, but DemonX could not ask PM2.*pm2 restart demonx/);
    expect(fs.existsSync(path.join(data, 'update-applied.json'))).toBe(true);   // so a restart by hand still says it updated
  });
});

describe('Update now: no job, probe, macro or frame can start while it installs', () => {
  it('blocks them before the first step, while npm runs, and until DemonX restarts', async () => {
    const duringNpm: (string | null | undefined)[] = [];
    const run: Run = async (cmd, args, o) => { if (cmd === 'npm') duringNpm.push(blocks.at(-1)); return fakeRun(cmd, args, o); };
    await make({ run }).apply('1.1.0');
    expect(duringNpm).toEqual([UPDATE_JOB_BLOCK, UPDATE_JOB_BLOCK]);
    expect(blocks).toEqual([UPDATE_JOB_BLOCK]);            // set once and never released: the next process starts unblocked
  });

  it('is not set when the update is refused', async () => {
    busyNow = 'a job is running';
    await make().apply('1.1.0');
    await make({ allowed: () => false }).apply('1.1.0');
    await make().apply('9.9.9');
    expect(blocks).toEqual([]);
  });

  it('is released when a step fails, when the restart is left to the owner, and when PM2 refuses', async () => {
    npmFail = 'run build:staging';
    await make().apply('1.1.0');
    expect(blocks).toEqual([UPDATE_JOB_BLOCK, null]);
    blocks = [];
    let first = true;
    await make({ waitMs: 20, busy: () => { if (first) { first = false; return null; } return 'a job is running'; } }).apply('1.1.0');
    expect(blocks).toEqual([UPDATE_JOB_BLOCK, null]);
    blocks = []; restartError = 'pm2 was not found';
    await make().apply('1.1.0');
    expect(blocks).toEqual([UPDATE_JOB_BLOCK, null]);
  });
});

describe('Update now: nothing can start in the moments before the restart', () => {
  it('takes the controller lock only after the install, and keeps it through the restart', async () => {
    const heldDuring: (string | null | undefined)[] = [];
    const run: Run = async (cmd, args, o) => { if (cmd === 'npm') heldDuring.push(locks.at(-1)); return fakeRun(cmd, args, o); };
    const seen: string[] = [];
    const a = make({ run, restart: async () => { seen.push(`lock at restart: ${locks.at(-1)}`); return ''; } });
    await a.apply('1.1.0');
    expect(heldDuring).toEqual([undefined, undefined]);       // the controls are free while npm runs
    expect(locks).toEqual([UPDATE_LOCK]);                      // taken once, never released: the next process starts unlocked
    expect(seen).toEqual([`lock at restart: ${UPDATE_LOCK}`]);
  });

  it('is not taken when the update does not start', async () => {
    busyNow = 'a job is running';
    await make().apply('1.1.0');
    await make({ allowed: () => false }).apply('1.1.0');
    expect(locks).toEqual([]);
  });

  it('is never taken when a step of the install fails', async () => {
    npmFail = 'run build:staging';
    await make().apply('1.1.0');
    expect(locks).toEqual([]);
  });

  it('is taken in the same breath as the final idle check', async () => {
    const order: string[] = [];
    const a = make({ busy: () => { order.push('busy'); return null; }, lock: (r) => order.push(r ? 'lock' : 'unlock'), restart: async () => { order.push('restart'); return ''; } });
    await a.apply('1.1.0');
    expect(order).toEqual(['busy', 'busy', 'lock', 'restart']);   // the check before starting, the final check, then the lock
  });

  it('is given back when PM2 refuses', async () => {
    restartError = 'pm2 was not found';
    await make().apply('1.1.0');
    expect(locks).toEqual([UPDATE_LOCK, null]);
  });

  it('is given back, and the owner told, when PM2 never restarts DemonX', async () => {
    const a = make({ restartGraceMs: 30 });
    await a.apply('1.1.0');
    expect(a.view().state).toBe('done');
    await new Promise((r) => setTimeout(r, 120));
    expect(a.view().state).toBe('failed');
    expect(a.view().message).toMatch(/still running the old version a minute after PM2.*pm2 restart demonx/);
    expect(locks).toEqual([UPDATE_LOCK, null]);
  });

  it('remembers the update for the next start even when the restart is left to the owner', async () => {
    let first = true;
    const a = make({ waitMs: 20, busy: () => { if (first) { first = false; return null; } return 'a job is running'; } });
    await a.apply('1.1.0');
    expect(a.view().state).toBe('failed');
    expect(JSON.parse(fs.readFileSync(path.join(data, 'update-applied.json'), 'utf8'))).toEqual({ from: '1.0.0', to: '1.1.0' });
    expect(make({ current: '1.1.0' }).view().message).toBe('Updated from 1.0.0 to 1.1.0.');
  });
});

describe('Update now: the restart waits for an idle machine', () => {
  it('does not restart while a job runs, and does when it is over', async () => {
    let polls = 0;
    const a = make({ busy: () => {
      // the first call is the check before starting; then the job starts and runs for three looks
      polls++;
      return polls === 1 ? null : polls <= 5 ? 'a job is running' : null;
    } });
    const p = a.apply('1.1.0');
    for (let i = 0; i < 300 && a.view().state !== 'waiting'; i++) await new Promise((r) => setTimeout(r, 10));
    expect(a.view().state).toBe('waiting');
    expect(restarts).toEqual([]);
    await p;
    expect(restarts).toEqual(['demonx']);
    expect(a.view().state).toBe('done');
  });

  it('leaves the restart to the owner when the machine stays busy', async () => {
    let first = true;
    const a = make({ waitMs: 40, busy: () => { if (first) { first = false; return null; } return 'a job is running'; } });
    await a.apply('1.1.0');
    expect(a.view().state).toBe('failed');
    expect(a.view().message).toMatch(/installed, but the machine was not idle \(a job is running\).*pm2 restart demonx/);
    expect(locks).toEqual([]);   // never locked: a job that started during the install is not interrupted, and an alarm stays clearable
    expect(restarts).toEqual([]);
  });

  it('ignores a second press while one is running', async () => {
    const a = make();
    const [first, second] = await Promise.all([a.apply('1.1.0'), a.apply('1.1.0')]);
    expect(first).toBe('');
    expect(second).toMatch(/already running/);
    expect(npmCalls.filter((c) => c.startsWith('install')).length).toBe(1);
    expect(restarts).toEqual(['demonx']);
  });
});

describe('Update now: the setting', () => {
  it('is off until the owner turns it on, and only true turns it on', () => {
    expect(defaultConfig().updates.apply).toBe(false);
    expect(applyUpdate(defaultConfig(), { updates: { apply: true } }).updates.apply).toBe(true);
    expect(applyUpdate(defaultConfig(), { updates: { apply: 'yes' as unknown as boolean } }).updates.apply).toBe(false);
    expect(applyUpdate(applyUpdate(defaultConfig(), { updates: { apply: true } }), { updates: { channel: 'stable' } }).updates.apply).toBe(true);
  });
});

describe('asking PM2 to restart', () => {
  const withFakePm2 = async (script: string, fn: () => Promise<void>) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demonx-pm2-'));
    fs.writeFileSync(path.join(dir, 'pm2'), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    const old = process.env.PATH;
    process.env.PATH = dir + path.delimiter + old;
    try { await fn(); } finally { process.env.PATH = old; fs.rmSync(dir, { recursive: true, force: true }); }
  };
  it.skipIf(process.platform === 'win32')('reports a pm2 that fails straight away, instead of calling it a restart', async () => {
    await withFakePm2('echo "[PM2][ERROR] Process or Namespace demonx not found" >&2; exit 1', async () => {
      expect(await restartWithPm2('demonx', 800)).toMatch(/failed \(exit code 1\)/);
    });
  });
  it.skipIf(process.platform === 'win32')('accepts a pm2 that is still working, or that finishes well', async () => {
    await withFakePm2('sleep 3', async () => { expect(await restartWithPm2('demonx', 200)).toBe(''); });
    await withFakePm2('exit 0', async () => { expect(await restartWithPm2('demonx', 400)).toBe(''); });
  });
  it('says so when pm2 is not installed, and refuses a name that is not a plain name', async () => {
    const old = process.env.PATH;
    process.env.PATH = os.tmpdir() + path.delimiter + '/nonexistent-dir';
    try { expect(await restartWithPm2('demonx', 300)).toMatch(/not found/); } finally { process.env.PATH = old; }
    expect(await restartWithPm2('--version; rm -rf /')).toMatch(/not usable/);
    expect(await restartWithPm2('-h')).toMatch(/not usable/);
  });
});

describe('Update now wired to the update check, as index.ts does it', () => {
  // the browsers' view of the update includes Update now, and Update now asks the check what is on offer: this must not loop
  const wired = async (current = '1.0.0') => {
    const settings = { ...defaultUpdateSettings(), apply: true, channel: 'stable' as const };
    const body = JSON.stringify([{ tag_name: 'v1.1.0', prerelease: false, name: 'x', body: 'notes', published_at: '2026-01-01T00:00:00Z' }]);
    let applier!: UpdateApplier;
    const checker: UpdateChecker = new UpdateChecker({
      current, settings: () => settings, install: 'git', dataDir: data, url: 'http://example.invalid/releases', now: () => Date.now(),
      fetch: async () => new Response(body, { status: 200 }), apply: () => applier.view(),
    });
    applier = new UpdateApplier({
      repoDir: repo, install: 'git', managed: true, processName: 'demonx', current, allowed: () => settings.apply, offered: () => checker.offered(),
      busy: () => null, log: () => {}, lock: () => {}, jobBlock: () => {}, run: fakeRun, originPattern: /./, restart: async () => '',
    });
    await checker.check();
    return { checker, applier };
  };
  it('builds the view with Update now usable (git, PM2, turned on) without endless recursion', async () => {
    const { checker } = await wired();
    const v = checker.view();
    expect(v.newer).toBe(true);
    expect(v.apply).toMatchObject({ available: true, reason: '' });
    checker.settingsChanged();   // what ticking the box does
  });
  it('offers nothing when the check is off or the release is not newer', async () => {
    const { checker } = await wired('1.1.0');
    expect(checker.offered()).toBeNull();
    expect(checker.view().apply.available).toBe(false);
  });
  it('installs through the wired check', async () => {
    const { checker, applier } = await wired();
    await applier.apply('1.1.0');
    expect(applier.view().state).toBe('done');
    expect(checker.view().apply.state).toBe('done');
  });
});

describe('running commands', () => {
  it('returns the exit code and the output', async () => {
    expect(await defaultRun('sh', ['-c', 'echo out; echo err >&2; exit 3'], { cwd: tmp, timeoutMs: 5000 })).toMatchObject({ code: 3, out: expect.stringContaining('out') });
    expect((await defaultRun('sh', ['-c', 'echo fine'], { cwd: tmp, timeoutMs: 5000 })).code).toBe(0);
    expect((await defaultRun('definitely-not-a-program', [], { cwd: tmp, timeoutMs: 5000 })).code).not.toBe(0);
  });
  it.skipIf(process.platform === 'win32')('stops what a command started too when it times out, so nothing keeps writing under a rollback', async () => {
    // a grandchild that writes to a file every 100 ms: if the timeout only stopped the shell, the file would keep growing.
    // (Watching the writes, not the process id: a stopped process can linger as a zombie, and ids can be reused on a busy machine.)
    const beat = path.join(tmp, 'beat.txt');
    const t0 = Date.now();
    const r = await defaultRun('sh', ['-c', `(while :; do echo x >> "${beat}"; sleep 0.1; done) & wait`], { cwd: tmp, timeoutMs: 600 });
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/longer than the time allowed/);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(fs.existsSync(beat), 'the grandchild never started, so the test proves nothing').toBe(true);
    // a write that was already on its way when the group was stopped can still land: let it settle, then watch for 1.5 s
    await new Promise((x) => setTimeout(x, 800));
    const size = fs.statSync(beat).size;
    await new Promise((x) => setTimeout(x, 1500));
    expect(fs.statSync(beat).size, 'the command kept writing after the timeout').toBe(size);
  });
});

describe('Update now: the marker means the folder may be half-changed', () => {
  it('is not there while it only looks (status, origin, fetch, check), and is there from the switch on', async () => {
    const marker = path.join(data, 'update-running.json');
    const seen: Record<string, boolean> = {};
    const run: Run = async (cmd, args, o) => {
      const key = cmd === 'git' ? args.slice(0, 2).join(' ') : cmd;
      if (!(key in seen)) seen[key] = fs.existsSync(marker);
      return fakeRun(cmd, args, o);
    };
    await make({ run }).apply('1.1.0');
    expect(seen['status --porcelain']).toBe(false);
    expect(seen['fetch --no-tags']).toBe(false);
    expect(seen['show refs/tags/v1.1.0:package.json']).toBe(false);
    expect(seen['checkout --detach']).toBe(true);
    expect(seen.npm).toBe(true);
  });
});

describe('Update now: when git refuses to switch', () => {
  it('says nothing was changed, and does not rebuild or switch itself off', async () => {
    const run: Run = async (cmd, args, o) => (cmd === 'git' && args.includes('--detach') && args.includes('refs/tags/v1.1.0') ? { code: 1, out: 'error: untracked working tree files would be overwritten', stdout: '' } : fakeRun(cmd, args, o));
    const before = head(), a = make({ run });
    await a.apply('1.1.0');
    expect(a.view().state).toBe('failed');
    expect(a.view().message).toMatch(/untracked working tree files.*Nothing was changed/);
    expect(head()).toBe(before);
    expect(npmCalls).toEqual([]);                          // no pointless install and rebuild
    expect(fs.existsSync(path.join(data, 'update-running.json'))).toBe(false);
    expect(a.view().available).toBe(true);                 // not marked broken
  });
});

describe('Update now: the marker is only there while the folder is changing', () => {
  it('is gone once the install is complete, before the wait for an idle machine', async () => {
    const marker = path.join(data, 'update-running.json');
    const atCheck: boolean[] = [];
    let n = 0;
    await make({ busy: () => { n++; atCheck.push(fs.existsSync(marker)); return null; } }).apply('1.1.0');
    expect(atCheck).toEqual([false, false]);   // the check before starting (before the marker is written) and the final one
    // and a restart during the wait is a clean start
    git(repo, 'checkout', '-q', 'main');
    let first = true;
    const a = make({ waitMs: 20, busy: () => { if (first) { first = false; return null; } return 'a job is running'; } });
    await a.apply('1.1.0');
    expect(a.view().state).toBe('failed');
    expect(make({ current: '1.1.0' }).view().reason).not.toMatch(/cut short/);
    expect(n).toBeGreaterThan(0);
  });
});

describe('Update now: when the folder cannot be put back', () => {
  it('keeps the marker, and stays off until the owner has looked, so a second try cannot "restore" the wrong version', async () => {
    const run: Run = async (cmd, args, o) => (cmd === 'npm' && args[0] === 'install' ? { code: 1, out: 'npm ERR! no network' } : fakeRun(cmd, args, o));   // the install fails, and so does the one in the rollback
    const marker = path.join(data, 'update-running.json');
    const a = make({ run });
    await a.apply('1.1.0');
    expect(a.view().state).toBe('failed');
    expect(fs.existsSync(marker)).toBe(true);
    expect(a.view()).toMatchObject({ available: false, reason: expect.stringMatching(/cut short/) });   // in this process
    expect(make().view()).toMatchObject({ available: false, reason: expect.stringMatching(/cut short/) });   // and after a restart
    expect(await a.apply('1.1.0')).toMatch(/cut short/);
  });
});

describe('Update now: when it is cut short or goes wrong in an unexpected way', () => {
  it('puts the previous version back when something unexpected throws after the folder changed', async () => {
    let thrown = false;
    const run: Run = async (cmd, args, o) => {
      if (cmd === 'npm' && args[0] === 'install' && !thrown) { thrown = true; throw new Error('boom'); }
      return fakeRun(cmd, args, o);
    };
    const before = head(), a = make({ run });
    await a.apply('1.1.0');
    expect(a.view().state).toBe('failed');
    expect(a.view().message).toMatch(/boom.*previous version was put back/);
    expect(head()).toBe(before);
    expect(restarts).toEqual([]);
    expect(blocks.at(-1)).toBeNull();
  });

  it('leaves a marker while it installs and removes it when it fails or is ready to restart', async () => {
    const marker = path.join(data, 'update-running.json');
    const seen: boolean[] = [];
    const run: Run = async (cmd, args, o) => { if (cmd === 'npm') seen.push(fs.existsSync(marker)); return fakeRun(cmd, args, o); };
    await make({ run }).apply('1.1.0');
    expect(seen).toEqual([true, true]);
    expect(fs.existsSync(marker)).toBe(false);
    git(repo, 'checkout', '-q', 'main');
    npmFail = 'run build:staging';
    await make().apply('1.1.0');
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('refuses to start again when an earlier update was cut short, until the owner has looked', async () => {
    const marker = path.join(data, 'update-running.json');
    fs.writeFileSync(marker, '{}');
    const lines: string[] = [];
    const a = make({ log: (_k, t) => lines.push(t) });
    expect(a.view()).toMatchObject({ available: false, reason: expect.stringMatching(/cut short.*update-running\.json/) });
    expect(await a.apply('1.1.0')).toMatch(/cut short/);
    expect(npmCalls).toEqual([]);
    expect(lines.join(' ')).toMatch(/cut short/);
    fs.rmSync(marker);
    expect(make().view().available).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('stops running commands when DemonX itself stops', async () => {
    const pidFile = path.join(tmp, 'orphan.pid');
    const p = defaultRun('sh', ['-c', `sleep 30 & echo $! > "${pidFile}"; wait`], { cwd: tmp, timeoutMs: 60_000 });
    for (let i = 0; i < 40 && !fs.existsSync(pidFile); i++) await new Promise((x) => setTimeout(x, 25));
    killRunning();
    const r = await p;
    expect(r.code).not.toBe(0);
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    let alive = true;
    for (let i = 0; i < 30 && alive; i++) {
      await new Promise((x) => setTimeout(x, 50));
      try { process.kill(pid, 0); alive = !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { alive = false; }
    }
    expect(alive).toBe(false);
  });
});

describe('is the spindle or coolant on?', () => {
  const off = { spindle: 0, accessories: '' };
  it('is not, when nothing has been seen on', () => {
    expect(spindleBusy(off, 0, 1_000_000)).toBeNull();
  });
  it('is, when the speed is above zero or an accessory flag is set', () => {
    expect(spindleBusy({ spindle: 12000, accessories: '' }, 0, 1)).toMatch(/spindle or coolant is on/);
    expect(spindleBusy({ spindle: 0, accessories: 'S' }, 0, 1)).toMatch(/spindle or coolant is on/);
    expect(spindleBusy({ spindle: 0, accessories: 'FM' }, 0, 1)).toMatch(/spindle or coolant is on/);
  });
  it('is, for half a minute after it was last seen on, because the accessory flags come only every 10th to 20th report', () => {
    const t = 1_000_000;
    expect(spindleBusy(off, t - 1000, t)).toMatch(/was a moment ago/);
    expect(spindleBusy(off, t - SPINDLE_MEMORY_MS + 1, t)).not.toBeNull();
    expect(spindleBusy(off, t - SPINDLE_MEMORY_MS, t)).toBeNull();
  });
});

describe('what git says on stderr is not data', () => {
  it('keeps stdout apart from the messages, so a warning cannot look like a changed file', async () => {
    const r = await defaultRun('sh', ['-c', 'echo "warning: something git advises" >&2; echo clean'], { cwd: tmp, timeoutMs: 5000 });
    expect(r.stdout).toBe('clean');
    expect(r.out).toMatch(/warning/);
  });
  it('the update still goes ahead when git writes a warning on stderr for every command', async () => {
    const run: Run = async (cmd, args, o) => {
      const r = await fakeRun(cmd, args, o);
      return cmd === 'git' ? { ...r, out: `warning: unsafe directory hint\n${r.out}`, stdout: r.stdout ?? r.out } : r;
    };
    const a = make({ run });
    await a.apply('1.1.0');
    expect(a.view().state).toBe('done');
    expect(head()).toBe(tagCommit('v1.1.0'));
  });
});

describe('how git is told never to ask for a passphrase', () => {
  it('adds BatchMode to the owner\'s own ssh command (the key chosen in core.sshCommand) instead of replacing it', () => {
    expect(gitSshCommand(undefined, '')).toBe('ssh -o BatchMode=yes');
    expect(gitSshCommand(undefined, 'ssh -i ~/.ssh/demonx_deploy')).toBe('ssh -i ~/.ssh/demonx_deploy -o BatchMode=yes');
    expect(gitSshCommand('ssh -i /k -o BatchMode=yes', 'ssh -i other')).toBe('ssh -i /k -o BatchMode=yes');   // the variable is the owner's explicit choice
  });
});

describe('Update now: the screen is built aside and swapped in at the restart', () => {
  it('writes nothing under web/dist until the swap, and swaps it in when the lock is taken, before the restart', async () => {
    const seen: string[] = [];
    let a: UpdateApplier;
    const run: Run = async (cmd, args, o) => { const r = await fakeRun(cmd, args, o); if (cmd === 'npm') seen.push(`${args.join(' ')}: served=${served()}`); return r; };
    a = make({
      run,
      lock: (r) => { locks.push(r); if (r) seen.push(`lock: served=${served()}`); },
      restart: async (n) => { seen.push(`restart: served=${served()}`); restarts.push(n); return ''; },
    });
    await a.apply('1.1.0');
    expect(a.view().state).toBe('done');
    // the old screen is served through the install and the build, and the new one from the lock on
    expect(seen).toEqual(['install: served=old 1.0.0', 'run build:staging: served=old 1.0.0', 'lock: served=old 1.0.0', 'restart: served=new 1.1.0']);
    expect(fs.existsSync(path.join(repo, 'web', 'dist-next'))).toBe(false);
    expect(fs.readFileSync(path.join(repo, 'web', 'dist-prev', 'index.html'), 'utf8')).toBe('old 1.0.0');
    expect(fs.existsSync(path.join(repo, 'web', 'dist', 'assets', 'app.js'))).toBe(true);
  });

  it('leaves web/dist exactly as it was when the build fails, and removes the half-built screen', async () => {
    const before = fs.readdirSync(path.join(repo, 'web', 'dist'), { recursive: true }).sort().join(',');
    npmFail = 'run build:staging';
    const a = make();
    await a.apply('1.1.0');
    expect(a.view().state).toBe('failed');
    expect(served()).toBe('old 1.0.0');
    expect(fs.readdirSync(path.join(repo, 'web', 'dist'), { recursive: true }).sort().join(',')).toBe(before);
    expect(fs.existsSync(path.join(repo, 'web', 'dist-next'))).toBe(false);
    expect(fs.existsSync(path.join(repo, 'web', 'dist-prev'))).toBe(false);
  });

  it('leaves web/dist alone when npm install fails or the machine is not idle for the restart', async () => {
    npmFail = 'install';
    await make().apply('1.1.0');
    expect(served()).toBe('old 1.0.0');
    expect(fs.existsSync(path.join(repo, 'web', 'dist-next'))).toBe(false);
    npmCalls = [];
    const b = make({ waitMs: 30, pollMs: 5, busy: () => (npmCalls.length >= 2 ? 'a job is running' : null) });   // a job starts during the install
    await b.apply('1.1.0');
    expect(b.view().state).toBe('failed');
    expect(served()).toBe('old 1.0.0');                                                      // never swapped: no lock was taken
    expect(fs.readFileSync(path.join(repo, 'web', 'dist-next', 'index.html'), 'utf8')).toBe('new 1.1.0');   // staged for a restart by hand
    expect(locks).toEqual([]);
  });

  it('puts the old screen back when PM2 cannot restart DemonX', async () => {
    restartError = 'pm2 was not found';
    const a = make();
    await a.apply('1.1.0');
    expect(a.view().state).toBe('failed');
    expect(served()).toBe('old 1.0.0');
    expect(fs.readFileSync(path.join(repo, 'web', 'dist-next', 'index.html'), 'utf8')).toBe('new 1.1.0');   // still staged for the manual restart
    expect(locks).toEqual([UPDATE_LOCK, null]);
  });

  it('puts the old screen back when DemonX is still running after the restart was asked', async () => {
    const a = make({ restartGraceMs: 20 });
    await a.apply('1.1.0');
    expect(served()).toBe('new 1.1.0');
    await new Promise((r) => setTimeout(r, 120));
    expect(a.view().state).toBe('failed');
    expect(served()).toBe('old 1.0.0');
  });

  it('does not restart when the swap itself cannot be done', async () => {
    const a = make({ run: async (c, args, o) => { const r = await fakeRun(c, args, o); if (args[0] === 'run') fs.rmSync(path.join(repo, 'web', 'dist-next', 'index.html')); return r; } });
    await a.apply('1.1.0');
    expect(a.view().state).toBe('failed');
    expect(a.view().message).toMatch(/new screen was not built/);
    expect(restarts).toEqual([]);
    expect(served()).toBe('old 1.0.0');
    expect(locks).toEqual([UPDATE_LOCK, null]);
  });
});

describe('the staged screen at start', () => {
  const web = () => path.join(repo, 'web', 'dist');
  const stage = (version: string, text = 'new') => { writeScreen(web() + '-next', text); stampStaged(web(), version); };

  it('becomes the served screen when it was built for this version (DemonX restarted by hand later)', () => {
    stage('1.1.0');
    expect(adoptStaged(web(), '1.1.0')).toMatch(/Now serving the screen built for 1.1.0/);
    expect(served()).toBe('new');
    expect(fs.existsSync(web() + '-next')).toBe(false);
    expect(adoptStaged(web(), '1.1.0')).toBe('');   // and only once
  });

  it('is deleted, not served, when it belongs to another version or has no stamp', () => {
    stage('1.1.0');
    expect(adoptStaged(web(), '1.0.0')).toMatch(/left-over/);
    expect(served()).toBe('old 1.0.0');
    expect(fs.existsSync(web() + '-next')).toBe(false);
    writeScreen(web() + '-next', 'unstamped');
    adoptStaged(web(), '1.1.0');
    expect(served()).toBe('old 1.0.0');
    expect(fs.existsSync(web() + '-next')).toBe(false);
  });

  it('works on a folder that has no served screen yet', () => {
    fs.rmSync(web(), { recursive: true });
    stage('1.1.0');
    adoptStaged(web(), '1.1.0');
    expect(served()).toBe('new');
  });

  it('swapBack puts both folders back as they were', () => {
    stage('1.1.0', 'new');
    expect(swapIn(web())).toBe('');
    expect(served()).toBe('new');
    expect(swapBack(web())).toBe('');
    expect(served()).toBe('old 1.0.0');
    expect(fs.readFileSync(path.join(web() + '-next', 'index.html'), 'utf8')).toBe('new');
    expect(swapBack(web())).toMatch(/no previous screen/);
  });
});

describe('Update now with DemonX Design', () => {
  let present: boolean, designBusy: string | null;
  beforeEach(() => { present = true; designBusy = null; });
  const designDist = () => fs.readFileSync(path.join(repo, 'design', 'dist', 'index.html'), 'utf8');
  const withDesign = (over: Partial<ApplyOptions> = {}) => make({
    design: { dir: path.join(repo, 'design'), name: 'demonx-design', present: async () => present, busy: async () => designBusy },
    restart: async (n) => { events.push('restart ' + n); restarts.push(n); return restartError; }, ...over,
  });

  it('builds Design aside, swaps its screen in and restarts it before DemonX', async () => {
    const a = withDesign();
    await a.apply('1.1.0');
    expect(a.view().state).toBe('done');
    expect(designCalls).toEqual(['ci --no-audit --no-fund', 'run build -- --outDir dist-next']);
    expect(designDist()).toBe('new design');
    expect(fs.readFileSync(path.join(repo, 'design', 'dist-prev', 'index.html'), 'utf8')).toBe('old design');
    expect(events).toEqual(['pm2 restart demonx-design', 'restart demonx']);   // Design first: restarting DemonX ends this process
    expect(head()).toBe(tagCommit('v1.1.0'));
  });

  it('does nothing about Design where it is not installed', async () => {
    present = false;
    const a = withDesign();
    await a.apply('1.1.0');
    expect(a.view().state).toBe('done');
    expect(designCalls).toEqual([]);
    expect(pm2Calls).toEqual([]);
    expect(designDist()).toBe('old design');
  });

  it('does not touch Design when no design option is given at all', async () => {
    await make().apply('1.1.0');
    expect(designCalls).toEqual([]);
    expect(pm2Calls).toEqual([]);
  });

  it('refuses before changing anything when Design is busy', async () => {
    designBusy = 'DemonX Design is busy: a laser job is running';
    const before = head(), a = withDesign();
    const refused = await a.apply('1.1.0');
    expect(refused).toMatch(/Not now: DemonX Design is busy: a laser job is running/);
    expect(a.view().state).toBe('idle');            // a refusal goes back to the one browser that asked
    expect(head()).toBe(before);
    expect(npmCalls).toEqual([]);
    expect(designCalls).toEqual([]);
    expect(blocks).toEqual([]);
    expect(locks).toEqual([]);
  });

  it('refuses when Design cannot say whether it is busy', async () => {
    designBusy = 'DemonX Design is too old to say whether a laser job is running. Restart it once';
    const a = withDesign();
    expect(await a.apply('1.1.0')).toMatch(/too old to say/);
    expect(npmCalls).toEqual([]);
  });

  it('refuses a second press while the first is still asking Design', async () => {
    let release: () => void = () => {};
    const slow = new Promise<void>((r) => { release = r; });
    const a = withDesign({ design: { dir: path.join(repo, 'design'), name: 'demonx-design', present: async () => true, busy: async () => { await slow; return null; } } });
    const first = a.apply('1.1.0');
    expect(await a.apply('1.1.0')).toBe('An update is already running.');
    release();
    await first;
    expect(a.view().state).toBe('done');
    expect(npmCalls.filter((c) => c.startsWith('install')).length).toBe(1);
  });

  it('does not restart anything when Design becomes busy during the install, and says so', async () => {
    let asked = 0;
    const a = withDesign({ waitMs: 40, pollMs: 5, design: { dir: path.join(repo, 'design'), name: 'demonx-design', present: async () => true, busy: async () => (++asked > 1 ? 'DemonX Design is busy: a laser job is running' : null) } });
    await a.apply('1.1.0');
    expect(a.view().state).toBe('failed');
    expect(a.view().message).toMatch(/was not idle \(DemonX Design is busy: a laser job is running\)/);
    expect(a.view().message).toMatch(/Design was built but not restarted/);
    expect(restarts).toEqual([]);
    expect(pm2Calls).toEqual([]);
    expect(designDist()).toBe('old design');          // never swapped
    expect(served()).toBe('old 1.0.0');
    expect(locks).toEqual([]);
  });

  it('only warns when Design fails to install, and DemonX still updates and restarts', async () => {
    designFail = 'ci';
    const a = withDesign();
    await a.apply('1.1.0');
    expect(a.view().state).toBe('done');
    expect(restarts).toEqual(['demonx']);
    expect(pm2Calls).toEqual([]);
    expect(designDist()).toBe('old design');
    expect(a.view().message).toMatch(/DemonX Design was not updated \(npm ci failed: npm ERR! design broke\)\. It keeps running as it was/);
    expect(head()).toBe(tagCommit('v1.1.0'));         // DemonX itself was not rolled back
    expect(JSON.parse(fs.readFileSync(path.join(data, 'update-applied.json'), 'utf8')).note).toMatch(/DemonX Design was not updated/);
    expect(make({ current: '1.1.0' }).view().message).toMatch(/^Updated from 1\.0\.0 to 1\.1\.0\. DemonX Design was not updated/);   // and the new process says it
  });

  it('only warns when Design fails to build, leaves its screen alone and removes the half-built one', async () => {
    designFail = 'run build';
    const a = withDesign();
    await a.apply('1.1.0');
    expect(a.view().state).toBe('done');
    expect(restarts).toEqual(['demonx']);
    expect(pm2Calls).toEqual([]);
    expect(designDist()).toBe('old design');
    expect(fs.existsSync(path.join(repo, 'design', 'dist-next'))).toBe(false);
    expect(a.view().message).toMatch(/its build failed/);
  });

  it('puts the old Design screen back when PM2 cannot restart Design, and still restarts DemonX', async () => {
    pm2Fail = true;
    const a = withDesign();
    await a.apply('1.1.0');
    expect(a.view().state).toBe('done');
    expect(restarts).toEqual(['demonx']);
    expect(designDist()).toBe('old design');
    expect(a.view().message).toMatch(/DemonX Design could not be restarted \(pm2 broke\)\. It keeps running as it was/);
  });

  it('says Design was already restarted when DemonX itself cannot be restarted', async () => {
    restartError = 'pm2 was not found';
    const a = withDesign();
    await a.apply('1.1.0');
    expect(a.view().state).toBe('failed');
    expect(a.view().message).toMatch(/DemonX Design was already updated and restarted/);
    expect(served()).toBe('old 1.0.0');
    expect(designDist()).toBe('new design');
  });

  it('never installs or builds Design when DemonX itself fails to install', async () => {
    npmFail = 'install';
    const a = withDesign();
    await a.apply('1.1.0');
    expect(a.view().state).toBe('failed');
    expect(designCalls).toEqual([]);
    expect(pm2Calls).toEqual([]);
    expect(designDist()).toBe('old design');
  });
});
