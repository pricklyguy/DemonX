import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { emptyApplyView, type UpdateApplyView, type UpdateRelease } from '../../shared/updates.js';
import { UPDATE_JOB_BLOCK, UPDATE_LOCK } from './updateApply.js';

// Update now for the Windows package. It never replaces a file that is in use: it downloads the release's Windows zip, checks it
// against the checksum file published with it, unpacks it, and puts the new version beside the running one in
// <DemonX folder>\versions\<version>. Then it changes current.txt, writes data\update-pending.json and exits with code 75.
// scripts\windows\launcher.mjs (run by "Start DemonX.bat") starts whatever current.txt names, and puts the old version back if the
// new one stops before DemonX has confirmed it (see confirmStarted). In order, stopping at the first thing that goes wrong:
//   1. the machine must be idle (no job, probe, move, held jog or macro; spindle and coolant off), then a job block is set
//   2. the zip and its .sha256 are fetched from the DemonX repository's release for that tag (the address is built here from the tag
//      the release list gave, which was checked to be v<semver>; it is never taken from the browser or from GitHub's answer)
//   3. the zip must match the checksum; it is unpacked; the version inside must be the one on offer and its files must be there
//   4. the unpacked version is moved into versions\ (nothing running is touched)
//   5. wait (briefly) until the machine is idle again, take the controller lock, change current.txt, exit with 75
// Nothing before step 5 changes what runs: a failure only deletes what was downloaded. The checksum guards against a damaged or
// truncated download; it comes from the same release, so it cannot protect against a release that was itself replaced.

const TAG = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const MINUTE = 60_000;
export const RESTART_CODE = 75;
export const RELEASE_DOWNLOADS = 'https://github.com/pricklyguy/DemonX/releases/download';
export const zipName = (version: string) => `DemonX-${version}-windows-x64.zip`;

/** Only the DemonX repository's releases on GitHub (and the hosts GitHub hands release files to), over https */
export function trustedDownload(u: URL): boolean {
  return u.protocol === 'https:' && (u.hostname === 'github.com' || u.hostname.endsWith('.githubusercontent.com'));
}

/** `<sha256>  <file name>` as sha256sum writes it; the name must be the zip's own */
export function parseChecksum(text: string, file: string): string | null {
  const m = /^([0-9a-fA-F]{64})[ \t]+\*?([^\r\n]+?)[ \t]*(?:\r?\n|$)/.exec(text.trim() + '\n');
  return m && m[2] === file ? m[1].toLowerCase() : null;
}

/** Unpack a zip. Windows 10 and 11 have tar.exe, which reads zip files (the build uses it too); elsewhere (tests, development) unzip. */
export function extractZip(zip: string, dest: string): Promise<void> {
  const win = process.platform === 'win32';
  const cmd = win ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'unzip';
  const args = win ? ['-xf', zip, '-C', dest] : ['-q', '-o', zip, '-d', dest];
  return new Promise((resolve, reject) => {
    let err = '';
    const p = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    p.stderr.on('data', (b: Buffer) => { err += b.toString(); if (err.length > 2000) err = err.slice(-2000); });
    p.once('error', (e) => reject(new Error(`could not run ${path.basename(cmd)}: ${e.message}`)));
    p.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} could not unpack it (exit code ${code}) ${err.trim().split('\n').slice(-2).join(' | ')}`))));
  });
}

export interface WindowsOptions {
  /** The DemonX folder: it holds versions\, current.txt and previous.txt */
  home: string;
  dataDir: string;
  /** The version running now */
  current: string;
  /** Started by launcher.mjs (it sets DEMONX_LAUNCHER=1): without it nothing would start DemonX again after the update */
  launcher: boolean;
  allowed: () => boolean;
  offered: () => UpdateRelease | null;
  /** Why the machine must not be restarted right now; null when it is idle */
  busy: () => string | null;
  log: (kind: 'info' | 'error', text: string) => void;
  jobBlock: (reason: string | null) => void;
  lock: (reason: string | null) => void;
  /** Tests pretend to be on Windows or not */
  platform?: NodeJS.Platform;
  /** Where release files are downloaded from (tests point it at a local server) */
  downloadBase?: string;
  trust?: (u: URL) => boolean;
  extract?: (zip: string, dest: string) => Promise<void>;
  /** Ends this process (the launcher then starts the new version) */
  exit?: (code: number) => void;
  maxZipBytes?: number;
  pollMs?: number;
  waitMs?: number;
  /** How long after the page is told, before DemonX exits */
  restartDelayMs?: number;
  /** How long DemonX must have been running before it confirms the update (see confirmStarted) */
  confirmAfterMs?: number;
}

// (a file edited in Notepad may start with a byte order mark)
const read = (f: string) => { try { return fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '').trim(); } catch { return ''; } };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** A virus scanner can hold files it has just seen for a moment on Windows: rename and delete are tried again for a few seconds */
async function renameRetry(from: string, to: string) {
  for (let i = 0; ; i++) {
    try { fs.renameSync(from, to); return; } catch (e) {
      if (i >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e;
      await sleep(500);
    }
  }
}
function writeAtomic(file: string, text: string) {
  const t = `${file}.tmp`;
  fs.writeFileSync(t, text);
  for (let i = 0; ; i++) {
    try { fs.renameSync(t, file); return; } catch (e) {
      if (i >= 10 || !['EPERM', 'EBUSY', 'EACCES'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    }
  }
}

export class WindowsUpdater extends EventEmitter {
  private v: UpdateApplyView = emptyApplyView();
  private active = false;
  private locked = false;
  private readonly staging: string;

  constructor(private readonly o: WindowsOptions) {
    super();
    this.staging = path.join(o.dataDir, 'update');
    // what became of the last update, said once, here, in the new process
    const failedFile = path.join(o.dataDir, 'update-failed.json'), appliedFile = path.join(o.dataDir, 'update-applied.json');
    try {
      const j = JSON.parse(fs.readFileSync(failedFile, 'utf8')) as { version?: unknown; previous?: unknown; why?: unknown };
      if (typeof j.version === 'string' && typeof j.previous === 'string') {
        const why = typeof j.why === 'string' ? j.why.slice(0, 200) : 'it did not start';
        this.v = { ...emptyApplyView(), state: 'failed', step: 'Starting the new version', target: j.version.slice(0, 64), message: `${j.version.slice(0, 64)} was installed but ${why}, so version ${j.previous.slice(0, 64)} is running again. Nothing of yours was changed.` };
        o.log('error', this.v.message);
      }
      fs.rmSync(failedFile, { force: true });
    } catch { /* none */ }
    try {
      const j = JSON.parse(fs.readFileSync(appliedFile, 'utf8')) as { from?: unknown; to?: unknown };
      if (typeof j.from === 'string' && typeof j.to === 'string' && j.to === o.current) {   // not if the owner went back by hand
        this.v = { ...emptyApplyView(), state: 'done', target: j.to.slice(0, 64), message: `Updated from ${j.from.slice(0, 64)} to ${j.to.slice(0, 64)}.` };
        o.log('info', this.v.message);
      }
      fs.rmSync(appliedFile, { force: true });
    } catch { /* none */ }
    // clean up after an update that was cut short
    try { fs.rmSync(this.staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* in use: tried again next time */ }
    const t = setTimeout(() => this.confirmStarted(), o.confirmAfterMs ?? 30_000);
    t.unref();
  }

  /**
   * The new version has been running long enough to count as working: remove the mark that would make the launcher go back. If it
   * stops before this, the launcher puts the previous version back (see scripts/windows/launcher.mjs).
   */
  confirmStarted() {
    const f = path.join(this.o.dataDir, 'update-pending.json');
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8')) as { version?: unknown };
      if (j.version === this.o.current) fs.rmSync(f, { force: true });
    } catch { /* none */ }
  }

  view(): UpdateApplyView {
    const base = { ...this.v };
    if (this.active) return { ...base, available: false, reason: '' };
    const reason = this.why();
    return { ...base, available: reason === '', reason };
  }

  private why(): string {
    if ((this.o.platform ?? process.platform) !== 'win32') return 'This updater is for the Windows package.';
    if (!this.o.launcher) return 'DemonX was not started with "Start DemonX.bat", which is what starts it again after an update. Close it and start it that way.';
    if (!this.o.allowed()) return 'Update now is turned off. Turn it on in Settings > Updates.';
    if (!this.o.offered()) return 'There is no newer release to install.';
    return '';
  }

  private set(p: Partial<UpdateApplyView>) { this.v = { ...this.v, ...p }; this.emit('change'); }
  private fail(step: string, message: string) {
    this.active = false;
    this.o.jobBlock(null);
    if (this.locked) { this.locked = false; this.o.lock(null); }
    this.cleanup();
    this.o.log('error', `Update failed (${step}): ${message}`);
    this.set({ state: 'failed', step, message });
  }
  private cleanup() { try { fs.rmSync(this.staging, { recursive: true, force: true }); } catch { /* removed at the next start */ } }

  /** Install the offered release. Never throws; the outcome is in view(). A refusal is returned as text for the browser that asked. */
  async apply(version: string): Promise<string> {
    if (this.active) return 'An update is already running.';
    const target = this.o.offered();
    const reason = this.why();
    if (reason) return reason;
    if (!target || target.version !== version || !TAG.test(target.tag) || target.tag !== 'v' + target.version || !VERSION.test(target.version)) return 'That is not the release on offer. Check again.';
    const busy = this.o.busy();
    if (busy) return `Not now: ${busy}. Try again when the machine is idle.`;
    this.active = true;
    this.o.jobBlock(UPDATE_JOB_BLOCK);   // the idle check above and this line run in one go
    this.set({ state: 'running', step: 'Starting', message: '', target: target.version });
    this.o.log('info', `Updating to ${target.version}...`);
    try { await this.go(target); } catch (e) { this.fail('Unexpected error', (e as Error).message.slice(0, 300)); }
    return '';
  }

  private async go(rel: UpdateRelease) {
    const base = this.o.downloadBase ?? RELEASE_DOWNLOADS;
    const asset = zipName(rel.version);
    const zipUrl = `${base}/${rel.tag}/${asset}`;
    const trust = this.o.trust ?? trustedDownload;
    fs.mkdirSync(this.staging, { recursive: true });

    this.set({ step: 'Fetching the checksum' });
    let sumText: string;
    try { sumText = await this.text(`${zipUrl}.sha256`, 4096, trust); } catch (e) {
      return this.fail('Fetching the checksum', `${(e as Error).message}. This release has no published checksum, so it is not installed. Nothing was changed.`);
    }
    const want = parseChecksum(sumText, asset);
    if (!want) return this.fail('Fetching the checksum', `the checksum file does not give a SHA-256 for ${asset}; nothing was changed.`);

    const zipFile = path.join(this.staging, asset);
    let got: string;
    try { got = await this.download(zipUrl, `${zipFile}.part`, trust, (pct, mb) => this.set({ step: `Downloading ${rel.version}${mb ? ` (${mb} MB)` : ''}${pct >= 0 ? `: ${pct}%` : ''}` })); } catch (e) {
      return this.fail('Downloading', `${(e as Error).message}. Nothing was changed.`);
    }
    if (got !== want) return this.fail('Checking the download', 'it does not match the checksum published with the release (damaged or incomplete download); it was deleted and nothing was changed.');
    fs.renameSync(`${zipFile}.part`, zipFile);

    this.set({ step: 'Unpacking' });
    const out = path.join(this.staging, 'unpacked');
    fs.mkdirSync(out, { recursive: true });
    try { await (this.o.extract ?? extractZip)(zipFile, out); } catch (e) { return this.fail('Unpacking', `${(e as Error).message}. Nothing was changed.`); }
    fs.rmSync(zipFile, { force: true });

    this.set({ step: 'Checking the new version' });
    const src = path.join(out, 'DemonX', 'versions', rel.version);
    const bad = this.checkTree(src, rel.version);
    if (bad) return this.fail('Checking the new version', `${bad}; it was not installed and nothing was changed.`);

    // beside the running version, in one move (same drive): the running one is not touched
    const versions = path.join(this.o.home, 'versions');
    const dest = path.join(versions, rel.version);
    try {
      fs.mkdirSync(versions, { recursive: true });
      fs.rmSync(dest, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      await renameRetry(src, dest);
    } catch (e) { return this.fail('Installing', `${(e as Error).message}. Nothing was changed.`); }
    this.cleanup();

    // The running copy keeps running until the machine is idle. During the download only long-running things were refused (jobBlock);
    // the full lock is taken only now, in the same breath as the final idle check, and held until DemonX exits.
    this.set({ state: 'waiting', step: 'Installed. Restarting DemonX when the machine is idle', message: '' });
    this.o.log('info', `Update to ${rel.version} installed. DemonX restarts when the machine is idle.`);
    const poll = this.o.pollMs ?? 2000, until = Date.now() + (this.o.waitMs ?? 2 * MINUTE);
    for (;;) {
      const why = this.o.busy();
      if (!why) { this.locked = true; this.o.lock(UPDATE_LOCK); break; }
      if (Date.now() > until) return this.fail('Restarting', `${rel.version} is installed, but the machine was not idle (${why}), so DemonX was not restarted. Press Update now again when it is idle.`);
      await new Promise((r) => setTimeout(r, poll));
    }

    this.set({ step: 'Switching to the new version' });
    const err = this.switchTo(rel.version);
    if (err) return this.fail('Switching', `${err}. The version you had is still the one that runs.`);
    this.set({ state: 'done', step: '', message: `Updated to ${rel.version}. DemonX is restarting; this page reconnects by itself. If you use DemonX Design, it keeps running the old version until you close its window and start it again.`, target: rel.version });
    this.o.log('info', `Switching to ${rel.version}: DemonX restarts now.`);
    // a moment, so the page has been told; the launcher then starts the version current.txt names
    setTimeout(() => (this.o.exit ?? ((c) => process.exit(c)))(RESTART_CODE), this.o.restartDelayMs ?? 1500).unref?.();
  }

  /** Everything the launcher needs for the new version, or a reason it is not usable */
  private checkTree(dir: string, version: string): string {
    const need = ['app/server.mjs', 'app/package.json', 'app/web/index.html'];
    for (const f of need) if (!fs.existsSync(path.join(dir, f))) return `the download does not contain ${f}`;
    if (!fs.existsSync(path.join(dir, 'app', 'node_modules'))) return 'the download does not contain its packages (app/node_modules)';
    let ver = '';
    try { ver = String(JSON.parse(fs.readFileSync(path.join(dir, 'app', 'package.json'), 'utf8')).version ?? ''); } catch { /* unreadable */ }
    if (ver !== version) return `the release says ${version} but the download is ${ver || 'a version that cannot be read'}`;
    // nothing that leads outside the folder
    const walk = (d: string): string => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isSymbolicLink()) return `the download contains a link (${path.relative(dir, p)})`;
        if (e.isDirectory()) { const r = walk(p); if (r) return r; }
      }
      return '';
    };
    return walk(dir);
  }

  /** previous.txt, the pending mark, the "updated" note, then current.txt last (the one change that matters). '' when done, else why not. */
  private switchTo(version: string): string {
    const home = this.o.home, data = this.o.dataDir;
    const currentFile = path.join(home, 'current.txt');
    const running = VERSION.test(read(currentFile)) ? read(currentFile) : this.o.current;
    const written: string[] = [];
    try {
      fs.mkdirSync(data, { recursive: true });
      writeAtomic(path.join(home, 'previous.txt'), running);
      writeAtomic(path.join(data, 'update-pending.json'), JSON.stringify({ version, previous: running, at: Date.now() })); written.push('update-pending.json');
      writeAtomic(path.join(data, 'update-applied.json'), JSON.stringify({ from: this.o.current, to: version })); written.push('update-applied.json');
      writeAtomic(currentFile, version);
      return '';
    } catch (e) {
      for (const f of written) { try { fs.rmSync(path.join(data, f), { force: true }); } catch { /* ignore */ } }
      return (e as Error).message;
    }
  }

  private async open(url: string, trust: (u: URL) => boolean, timeoutMs: number): Promise<Response> {
    if (!trust(new URL(url))) throw new Error('that address is not allowed');
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'DemonX-updater' } });
    if (!trust(new URL(res.url || url))) { await res.body?.cancel(); throw new Error('GitHub sent the download to an address that is not allowed'); }
    if (!res.ok) { await res.body?.cancel(); throw new Error(res.status === 404 ? 'GitHub has no such file for this release' : `GitHub answered ${res.status}`); }
    return res;
  }

  private async text(url: string, max: number, trust: (u: URL) => boolean): Promise<string> {
    const res = await this.open(url, trust, MINUTE);
    const b = Buffer.from(await res.arrayBuffer());
    if (b.length > max) throw new Error('the checksum file is too large');
    return b.toString('utf8');
  }

  /** Download to a file, counting and hashing as it goes; resolves to the SHA-256. The file is deleted when anything goes wrong. */
  private async download(url: string, file: string, trust: (u: URL) => boolean, progress: (pct: number, mb: string) => void): Promise<string> {
    const max = this.o.maxZipBytes ?? 400 * 1024 * 1024;
    const res = await this.open(url, trust, 30 * MINUTE);
    const total = Number(res.headers.get('content-length') ?? 0);
    if (total > max) { await res.body?.cancel(); throw new Error('the download is larger than allowed'); }
    if (!res.body) throw new Error('GitHub sent nothing');
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(file);
    const done = new Promise<void>((resolve, reject) => { out.once('error', reject); out.once('close', resolve); });
    let n = 0, last = 0;
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) break;
        n += value.length;
        if (n > max) throw new Error('the download is larger than allowed');
        hash.update(value);
        if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()));
        if (Date.now() - last > 500) { last = Date.now(); progress(total ? Math.min(99, Math.floor((n / total) * 100)) : -1, total ? (total / 1048576).toFixed(0) : ''); }
      }
      out.end();
      await done;
      return hash.digest('hex');
    } catch (e) {
      out.destroy();
      try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
      throw e;
    }
  }
}
