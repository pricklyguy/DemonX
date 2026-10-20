import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// scripts/windows/launcher.mjs, run as the real program against a throwaway install whose versions are small fake servers.
// (On Windows it is started by Start DemonX.bat with the node.exe in the DemonX folder; here it is the Node running the tests.)

const LAUNCHER = path.resolve(__dirname, '../../scripts/windows/launcher.mjs');
let home: string;
const w = (...p: string[]) => path.join(home, ...p);
const text = (f: string) => fs.readFileSync(w(f), 'utf8').trim();
const exists = (f: string) => fs.existsSync(w(f));

/** A fake version: its servers log that they ran, then do what plan-<version>.json says (write files, then exit with a code) */
function version(v: string, entries = ['server.mjs', 'design-server.mjs', 'set-pin.mjs']) {
  const dir = w('versions', v, 'app');
  fs.mkdirSync(path.join(dir, 'web'), { recursive: true });
  for (const e of entries) {
    fs.writeFileSync(path.join(dir, e), `
      import fs from 'node:fs'; import path from 'node:path';
      const home = process.env.DEMONX_HOME;
      fs.appendFileSync(path.join(home, 'ran.log'), ${JSON.stringify(v + ' ' + e)} + ' web=' + path.relative(home, process.env.DEMONX_WEB) + ' launcher=' + process.env.DEMONX_LAUNCHER + ' args=' + process.argv.slice(2).join(',') + '\\n');
      const planFile = path.join(home, 'plan-${v}-' + ${JSON.stringify(e)} + '.json');
      const plan = fs.existsSync(planFile) ? JSON.parse(fs.readFileSync(planFile, 'utf8')) : {};
      fs.rmSync(planFile, { force: true });   // a plan is used once
      for (const [f, t] of Object.entries(plan.write ?? {})) { fs.mkdirSync(path.dirname(path.join(home, f)), { recursive: true }); fs.writeFileSync(path.join(home, f), t); }
      process.exit(plan.exit ?? 0);
    `);
  }
}
const plan = (v: string, entry: string, p: { write?: Record<string, string>; exit?: number }) => fs.writeFileSync(w(`plan-${v}-${entry}.json`), JSON.stringify(p));
const run = (mode: string, ...args: string[]) => spawnSync(process.execPath, [w('launcher.mjs'), mode, ...args], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, DEMONX_DATA: '', DEMONX_WEB: '', DESIGN_WEB: '' } });
const ran = () => (exists('ran.log') ? text('ran.log').split('\n').map((l) => l.replace(/\\/g, '/')) : []);   // (Windows writes backslashes)
const switchTo = (to: string, from: string) => ({ 'current.txt': to, 'previous.txt': from, 'data/update-pending.json': JSON.stringify({ version: to, previous: from, at: 1 }) });

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'demonx-launcher-'));
  fs.copyFileSync(LAUNCHER, w('launcher.mjs'));
  fs.mkdirSync(w('data'));
  fs.writeFileSync(w('current.txt'), '1.0.0');
  version('1.0.0');
});
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

describe('starting the version current.txt names', () => {
  it('runs that version with its own screen folder, and ends with the exit code of the server', () => {
    plan('1.0.0', 'server.mjs', { exit: 3 });
    const r = run('cnc');
    expect(r.status).toBe(3);
    expect(ran()).toEqual(['1.0.0 server.mjs web=versions/1.0.0/app/web launcher=1 args=']);
  });

  it('passes the arguments on (Set PIN --show)', () => {
    const r = run('set-pin', '--show');
    expect(r.status).toBe(0);
    expect(ran()).toEqual(['1.0.0 set-pin.mjs web=versions/1.0.0/app/web launcher=1 args=--show']);
  });

  it('runs Design once from the same version and never starts it again', () => {
    plan('1.0.0', 'design-server.mjs', { exit: 75 });
    const r = run('design');
    expect(r.status).toBe(75);
    expect(ran()).toEqual(['1.0.0 design-server.mjs web=versions/1.0.0/app/web launcher=1 args=']);
  });

  it('says so when current.txt is missing or names nothing usable', () => {
    fs.rmSync(w('current.txt'));
    expect(run('cnc').status).toBe(2);
    fs.writeFileSync(w('current.txt'), '..\\evil');
    const r = run('cnc');
    expect(r.status).toBe(2);
    expect(r.stdout).toMatch(/does not name a version/);
    expect(ran()).toEqual([]);
  });

  it('accepts a current.txt that Notepad saved with a byte order mark', () => {
    fs.writeFileSync(w('current.txt'), '\uFEFF1.0.0\r\n');
    expect(run('cnc').status).toBe(0);
    expect(ran()).toHaveLength(1);
  });

  it('refuses an unknown mode', () => {
    expect(run('rm-rf').status).toBe(2);
  });
});

describe('an update: current.txt changes and DemonX exits with 75', () => {
  it('starts the new version, without the launcher itself having to change', () => {
    version('1.1.0');
    plan('1.0.0', 'server.mjs', { write: { 'current.txt': '1.1.0', 'previous.txt': '1.0.0' }, exit: 75 });
    const r = run('cnc');
    expect(r.status).toBe(0);
    expect(ran().map((l) => l.split(' ')[0])).toEqual(['1.0.0', '1.1.0']);
    expect(text('current.txt')).toBe('1.1.0');
  });

  it('goes back to the working version when the new one stops before it was confirmed, and says why', () => {
    version('1.1.0');
    plan('1.0.0', 'server.mjs', { write: switchTo('1.1.0', '1.0.0'), exit: 75 });
    plan('1.1.0', 'server.mjs', { exit: 1 });
    const r = run('cnc');
    expect(r.status).toBe(0);
    expect(ran().map((l) => l.split(' ')[0])).toEqual(['1.0.0', '1.1.0', '1.0.0']);   // the old one ran again
    expect(text('current.txt')).toBe('1.0.0');
    expect(exists('data/update-pending.json')).toBe(false);
    const failed = JSON.parse(text('data/update-failed.json'));
    expect(failed).toMatchObject({ version: '1.1.0', previous: '1.0.0' });
    expect(failed.why).toMatch(/exit code 1/);
  });

  it('does not go back when the owner closes it normally (exit code 0)', () => {
    version('1.1.0');
    plan('1.0.0', 'server.mjs', { write: switchTo('1.1.0', '1.0.0'), exit: 75 });
    plan('1.1.0', 'server.mjs', { exit: 0 });
    expect(run('cnc').status).toBe(0);
    expect(text('current.txt')).toBe('1.1.0');
    expect(exists('data/update-failed.json')).toBe(false);
  });

  it('does not go back once the update was confirmed (the pending mark is gone), even if it crashes later', () => {
    version('1.1.0');
    plan('1.0.0', 'server.mjs', { write: { 'current.txt': '1.1.0', 'previous.txt': '1.0.0' }, exit: 75 });
    plan('1.1.0', 'server.mjs', { exit: 1 });   // no pending file: it was confirmed
    expect(run('cnc').status).toBe(1);
    expect(ran().map((l) => l.split(' ')[0])).toEqual(['1.0.0', '1.1.0']);
    expect(text('current.txt')).toBe('1.1.0');
  });

  it('goes back when the new version is not complete (its server file is missing)', () => {
    version('1.1.0', ['design-server.mjs']);   // no server.mjs
    plan('1.0.0', 'server.mjs', { write: switchTo('1.1.0', '1.0.0'), exit: 75 });
    const r = run('cnc');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/not complete/);
    expect(text('current.txt')).toBe('1.0.0');
    expect(ran().map((l) => l.split(' ')[0])).toEqual(['1.0.0', '1.0.0']);
    expect(JSON.parse(text('data/update-failed.json')).why).toMatch(/not complete/);
  });

  it('stops with a message, and loops forever on nothing, when there is no version to go back to', () => {
    fs.writeFileSync(w('current.txt'), '9.9.9');
    const r = run('cnc');
    expect(r.status).toBe(2);
    expect(r.stdout).toMatch(/9\.9\.9 is not complete/);
  });
});

describe('tidying up', () => {
  it('removes the app folder the old layout left behind, but never a folder that is not one', () => {
    fs.mkdirSync(w('app'));
    fs.writeFileSync(w('app', 'server.mjs'), '// 2.0.0');
    run('cnc');
    expect(exists('app')).toBe(false);
    fs.mkdirSync(w('app'));
    fs.writeFileSync(w('app', 'notes.txt'), 'mine');
    run('cnc');
    expect(exists('app/notes.txt')).toBe(true);
  });

  it('keeps the running version, the one before it and the newest few; removes the rest and half-unpacked folders', () => {
    const old = ['0.1.0', '0.2.0', '0.3.0', '0.4.0'];
    for (const v of old) { version(v); const t = new Date(Date.now() - 1000 * 3600 * (10 - old.indexOf(v))); fs.utimesSync(w('versions', v), t, t); }
    fs.mkdirSync(w('versions', '1.2.0.partial'));
    fs.writeFileSync(w('previous.txt'), '0.1.0');   // the oldest one is the previous one: kept
    run('cnc');
    const left = fs.readdirSync(w('versions')).sort();
    expect(left).toContain('1.0.0');
    expect(left).toContain('0.1.0');
    expect(left).not.toContain('1.2.0.partial');
    expect(left.length).toBeLessThanOrEqual(4);
    expect(left).not.toContain('0.2.0');
  });
});
