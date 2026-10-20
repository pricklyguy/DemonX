import { EventEmitter } from 'node:events';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { removeStaged, stampStaged, swapBack, swapIn } from './screen.js';
import { emptyApplyView, type UpdateApplyView, type UpdateInfo, type UpdateRelease } from '../../shared/updates.js';

// Update now: put the release the update check offered on this computer and restart DemonX. It only exists for a git
// install that PM2 runs (so DemonX can come back by itself), only when the owner turned it on, and only from a signed-in
// browser. What it does, in order, stopping at the first thing that goes wrong:
//   1. the machine must be idle (no job, probe, move, macro, spindle or coolant), then a job block is set: the server refuses to start a
//      job, probe, macro, PCB Home or frame until DemonX restarts or the update fails (jogging, the console, unlock and the stops stay free)
//   2. the DemonX folder must have no changes of its own, and its origin must be the DemonX repository on GitHub
//   3. fetch that one tag (the tag comes from the release list after it was checked to be v<semver>, never from the browser)
//   4. the package.json in the tag must say the version the release says
//   5. switch to the tag, npm install, then build the screen into a staging folder (web/dist-next): the screen the running server
//      serves (web/dist) is not touched until the swap in step 6
//   6. wait (briefly) until the machine is idle again (only the console can have changed that), take the controller lock so nothing
//      at all can start and swap the staged screen in by renaming, then ask PM2 to restart DemonX (and swap back if that fails)
// If a step after the switch fails the previous version is put back (its screen was never touched) and DemonX keeps running as it was. Nothing here moves the machine.

/** `out` is stdout and stderr together (for messages); `stdout` is stdout alone, which is what gets parsed (a warning git prints on stderr must not look like data) */
export type Run = (cmd: string, args: string[], o: { cwd: string; timeoutMs: number }) => Promise<{ code: number; out: string; stdout?: string }>;
const data = (r: { out: string; stdout?: string }) => r.stdout ?? r.out;

/**
 * What GIT_SSH_COMMAND should be so git never waits for a passphrase or a host-key question: the owner's own choice (the
 * variable, or core.sshCommand which picks a key) with BatchMode added, or plain ssh with BatchMode.
 */
export function gitSshCommand(fromEnv: string | undefined, configured: string): string {
  if (fromEnv) return fromEnv;
  return `${configured.trim() || 'ssh'} -o BatchMode=yes`;
}
const sshConfigured = new Map<string, string>();
function configuredSsh(cwd: string): string {
  let v = sshConfigured.get(cwd);
  if (v === undefined) {
    try { v = execFileSync('git', ['config', '--get', 'core.sshCommand'], { cwd, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { v = ''; }
    sshConfigured.set(cwd, v);
  }
  return v;
}

/** Commands that are running now (their process group ids): stopped if DemonX itself stops, so nothing keeps writing into the folder behind a restarted DemonX */
const running = new Set<number>();
let exitHookSet = false;
export function killRunning() {
  for (const pid of running) { try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ } }
  running.clear();
}

export const defaultRun: Run = (cmd, args, o) => new Promise((resolve) => {
  if (!exitHookSet && process.platform !== 'win32') { exitHookSet = true; process.on('exit', killRunning); }
  // git must never wait for a password or a host-key question nobody can answer: fail at once with its own message
  const env = cmd === 'git' ? { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: gitSshCommand(process.env.GIT_SSH_COMMAND, configuredSsh(o.cwd)) } : process.env;
  const posix = process.platform !== 'win32';
  let out = '', so = '', done = false;
  const finish = (code: number, extra = '') => { if (done) return; done = true; clearTimeout(timer); if (child.pid) running.delete(child.pid); resolve({ code, out: `${out}${extra}`.trim(), stdout: so.trim() }); };
  // its own process group, so a timeout can stop npm AND what npm started (vite, node-gyp), not leave them writing under a rollback
  const child = spawn(cmd, args, { cwd: o.cwd, env, windowsHide: true, detached: posix, stdio: ['ignore', 'pipe', 'pipe'] });
  if (posix && child.pid) running.add(child.pid);
  const add = (b: Buffer) => { out += b.toString(); if (out.length > 200_000) out = out.slice(-100_000); };
  child.stdout.on('data', (b: Buffer) => { add(b); so += b.toString(); if (so.length > 200_000) so = so.slice(-100_000); });
  child.stderr.on('data', add);
  const timer = setTimeout(() => {
    try { if (posix && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* already gone */ }
    finish(124, '\n(stopped: it took longer than the time allowed)');
  }, o.timeoutMs);
  child.once('error', (e) => finish(1, `\n${e.message}`));
  child.once('close', (code) => finish(code ?? 1));
});

export const GITHUB_ORIGIN = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)pricklyguy\/DemonX(?:\.git)?\/?$/i;
const TAG = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const PM2_NAME = /^[A-Za-z0-9][\w.-]{0,63}$/;
const MINUTE = 60_000;
/** Held from the start of an update until DemonX restarts (or the update fails): a job, probe, macro, PCB Home or frame cannot be started; jogging, the console and the stops still work */
export const UPDATE_JOB_BLOCK = 'DemonX is installing an update: no job, probe, macro or frame can start until it has restarted';
/** The controller lock held from the final idle check until DemonX restarts (or the restart fails): no job, probe, jog, held jog or macro can start in the moments PM2 needs */
export const UPDATE_LOCK = 'DemonX is about to restart for an update';

export interface ApplyOptions {
  repoDir: string;
  install: UpdateInfo['install'];
  /** DemonX is run by PM2 (so it can be restarted from outside) */
  managed: boolean;
  processName: string;
  /** The version DemonX is running now (not what the folder holds: after an install that is the new one) */
  current: string;
  /** The owner turned Update now on */
  allowed: () => boolean;
  /** The release the update check is offering (newer than the running one), or null */
  offered: () => UpdateRelease | null;
  /** Why the machine must not be restarted right now (a job, a probe, a move, a held jog); null when it is idle */
  busy: () => string | null;
  log: (kind: 'info' | 'error', text: string) => void;
  /** Hold (a reason) or release (null) the block on starting jobs, probes, macros, PCB Home and frames while the update installs */
  jobBlock: (reason: string | null) => void;
  /** Hold (a reason) or release (null) the controller lock that keeps new jobs, probes, jogs and macros from starting */
  lock: (reason: string | null) => void;
  /** How long after asking PM2 to restart DemonX it may keep running before the lock is given back and the owner is told */
  restartGraceMs?: number;
  dataDir?: string;
  /** The folder the running server serves the screen from (default web/dist in the repository); the new screen is built beside it */
  webRoot?: string;
  run?: Run;
  /** Tests pretend to be on another system */
  platform?: NodeJS.Platform;
  /** Tests point origin at a local repository */
  originPattern?: RegExp;
  pollMs?: number;
  /** How long to wait for the machine to be idle after the install before giving the controls back and leaving the restart to the owner */
  waitMs?: number;
  /** Starts the restart; resolves to an error text, or '' when PM2 took the request */
  restart?: (name: string) => Promise<string>;
  /**
   * DemonX Design, updated together with DemonX where it is installed (run by PM2 as `name`). Never touched where it is not
   * installed, never while it is busy, and a problem with it never stops DemonX from updating: it only becomes a warning.
   */
  design?: {
    dir: string;
    name: string;
    /** Is Design set up under PM2 here? */
    present: () => Promise<boolean>;
    /** Why Design must not be restarted now (busy, or cannot say); null when it is idle or not running */
    busy: () => Promise<string | null>;
  };
}

/**
 * Is the spindle or coolant possibly on? The controller says so in two places and neither is enough alone: the spindle speed
 * (FS) comes with every report but some firmware keeps the programmed speed after M5, and the accessory flags (A) come only with
 * the override report, every 10 to 20 reports, so most reports say nothing. Either one counts, and so does having seen either
 * within the last half minute (longer than the gap between two override reports).
 */
export const SPINDLE_MEMORY_MS = 30_000;
export const spindleSeenOn = (s: { spindle: number; accessories: string }) => s.spindle > 0 || !!s.accessories;
export function spindleBusy(s: { spindle: number; accessories: string }, lastSeenOn: number, now: number): string | null {
  if (spindleSeenOn(s) || (lastSeenOn > 0 && now - lastSeenOn < SPINDLE_MEMORY_MS)) return 'the spindle or coolant is on, or was a moment ago (a controller that keeps reporting a spindle speed after M5 needs S0)';
  return null;
}

/** The last lines of a command's output, enough to see what went wrong */
const tail = (out: string, n = 4) => out.split('\n').map((l) => l.trim()).filter(Boolean).slice(-n).join(' | ').slice(0, 400);

export class UpdateApplier extends EventEmitter {
  private v: UpdateApplyView = emptyApplyView();
  private active = false;
  private locked = false;
  /** A release that is installed in the folder while the running process is still the old one (waiting for a restart) */
  private installed = '';
  /** Puts the previous version back; set once the folder starts to change, cleared when the install is complete */
  private rollback: (() => Promise<boolean>) | null = null;
  /** An earlier update was cut short (DemonX stopped while it installed): the folder may be half-changed */
  private interrupted = false;
  private readonly run: Run;
  private readonly webRoot: string;
  /** apply() is between its first check and setting `active` (it asks Design, which takes a moment) */
  private checking = false;
  /** DemonX Design is installed here and is updated along with DemonX in this update */
  private designWanted = false;
  /** DemonX Design was restarted in this update (so a later problem with DemonX itself says so) */
  private designRestarted = false;

  constructor(private readonly o: ApplyOptions) {
    super();
    this.run = o.run ?? defaultRun;
    this.webRoot = o.webRoot ?? path.join(o.repoDir, 'web', 'dist');
    if (o.dataDir) {
      this.interrupted = fs.existsSync(path.join(o.dataDir, 'update-running.json'));
      if (this.interrupted) o.log('error', 'An earlier update was cut short: DemonX stopped while it was installing. Check the DemonX folder, then delete data/update-running.json.');
    }
    // the result of an update that restarted DemonX: say so once, here, in the new process
    if (o.dataDir) {
      const f = path.join(o.dataDir, 'update-applied.json');
      try {
        const j = JSON.parse(fs.readFileSync(f, 'utf8')) as { from?: unknown; to?: unknown; note?: unknown };
        if (typeof j.from === 'string' && typeof j.to === 'string' && j.to === o.current) {   // not if the owner went back by hand and restarted
          const note = typeof j.note === 'string' && j.note ? ` ${j.note.slice(0, 400)}` : '';
          this.v = { ...emptyApplyView(), state: 'done', target: j.to.slice(0, 64), message: `Updated from ${j.from.slice(0, 64)} to ${j.to.slice(0, 64)}.${note}` };
          o.log('info', this.v.message);
        }
        fs.rmSync(f, { force: true });
      } catch { /* none */ }
    }
  }

  /** What browsers are told. Whether the machine is busy is not in it: that is checked when Update now is pressed. */
  view(): UpdateApplyView {
    const base = { ...this.v };
    if (this.active) return { ...base, available: false, reason: '' };
    const reason = this.why();
    return { ...base, available: reason === '', reason };
  }

  private why(): string {
    if (this.o.install !== 'git') return 'This install was not set up with git.';
    if (this.interrupted) return 'An earlier update was cut short (DemonX stopped while it was installing), so the DemonX folder may be half-changed. Look at it (git status, then bash scripts/update.sh), then delete data/update-running.json.';
    if ((this.o.platform ?? process.platform) === 'win32') return 'Update now does not work from a git folder on Windows (npm and pm2 are .cmd files there). The Windows package updates itself: download its zip from the release page the first time.';
    if (!this.o.managed) return 'DemonX is not run by PM2, so it cannot restart itself. Run bash scripts/update.sh once to set that up.';
    if (!this.o.allowed()) return 'Update now is turned off. Turn it on in Settings > Updates.';
    const offered = this.o.offered();
    if (!offered) return 'There is no newer release to install.';
    if (offered.version === this.installed) return `${offered.version} is already installed, but DemonX is still running the old version. Restart it: pm2 restart ${this.o.processName}`;
    return '';
  }

  private marker(on: boolean) {
    if (!this.o.dataDir) return;
    const f = path.join(this.o.dataDir, 'update-running.json');
    try { if (on) fs.writeFileSync(f, JSON.stringify({ at: Date.now() })); else fs.rmSync(f, { force: true }); } catch { /* the update still runs; only the protection against an interrupted one is lost */ }
  }

  private set(p: Partial<UpdateApplyView>) { this.v = { ...this.v, ...p }; this.emit('change'); }
  /** `broken`: the folder could not be put back, so the marker stays and Update now stays off until the owner has looked */
  private fail(step: string, message: string, broken = false) {
    this.active = false;
    if (broken) this.interrupted = true; else this.marker(false);
    this.o.jobBlock(null);
    if (this.locked) { this.locked = false; this.o.lock(null); }
    this.o.log('error', `Update failed (${step}): ${message}`);
    this.set({ state: 'failed', step, message });
  }

  /**
   * Install the offered release. Never throws; the outcome is in view(). A refusal (turned off, not the release on offer, the
   * machine busy) is returned as text for the browser that asked and leaves the shared state alone; '' when it ran or was ignored.
   */
  async apply(version: string): Promise<string> {
    if (this.active || this.checking) return 'An update is already running.';
    this.checking = true;
    let target: UpdateRelease | null;
    try {
      target = this.o.offered();
      const reason = this.why();
      if (reason) return this.refuse(reason);
      if (!target || target.version !== version || !TAG.test(target.tag) || target.tag !== 'v' + target.version) return this.refuse('That is not the release on offer. Check again.');
      // DemonX Design (if it is installed here) must be idle too. It is asked first because that takes a moment: the check of this
      // machine and the line that sets the job block below run in one go, with nothing awaited between them.
      this.designWanted = false;
      this.designRestarted = false;
      if (this.o.design && await this.o.design.present().catch(() => false)) {
        const d = await this.o.design.busy().catch((e: Error) => `DemonX Design could not be asked (${e.message})`);
        if (d) return this.refuse(`Not now: ${d}. Try again when it is idle.`);
        this.designWanted = true;
      }
      const reasonNow = this.why();   // a setting can change while Design is asked
      if (reasonNow) return this.refuse(reasonNow);
      const busy = this.o.busy();
      if (busy) return this.refuse(`Not now: ${busy}. Try again when the machine is idle.`);
      this.active = true;
      this.o.jobBlock(UPDATE_JOB_BLOCK);   // the idle check above and this line run in one go: nothing long-running can start from here on
    } finally { this.checking = false; }
    this.set({ state: 'running', step: 'Starting', message: '', target: target.version });
    this.o.log('info', `Updating to ${target.version}…`);
    try { await this.go(target); } catch (e) {
      const why = (e as Error).message.slice(0, 300);
      const back = this.rollback;
      if (back) {
        this.set({ step: 'Putting the previous version back' });
        const ok = await back().catch(() => false);
        this.fail('Unexpected error', `${why}. ${ok ? 'The previous version was put back and DemonX was not restarted.' : 'Putting the previous version back failed: the folder needs a look (git status, then bash scripts/update.sh).'}`, !ok);
      } else this.fail('Unexpected error', why);
    }
    this.rollback = null;
    return '';
  }

  /** A refusal goes back to the browser that asked (and is not written to the Console every browser shares) */
  private refuse(message: string): string { return message; }

  private git(args: string[], timeoutMs = 2 * MINUTE) { return this.run('git', args, { cwd: this.o.repoDir, timeoutMs }); }
  private npm(args: string[]) { return this.run('npm', args, { cwd: this.o.repoDir, timeoutMs: 20 * MINUTE }); }

  private async go(rel: UpdateRelease) {
    const { tag } = rel, ref = `refs/tags/${tag}`;

    this.set({ step: 'Checking the DemonX folder' });
    const st = await this.git(['status', '--porcelain', '--untracked-files=no']);
    if (st.code !== 0) return this.fail('Checking the DemonX folder', `git did not answer: ${tail(st.out)}`);
    // npm rewrites package-lock.json on every install (update.sh puts it back too); anything else is the owner's own change
    const own = data(st).split('\n').filter((l) => l.trim() && !/^[MADRCUT?!]{1,2}\s+package-lock\.json$/.test(l.trim()));   // "XY path" (the run helper trims the first line, so the space before X may be gone)
    if (own.length) return this.fail('Checking the DemonX folder', `the folder has changes of its own (${own.length} file${own.length === 1 ? '' : 's'}); nothing was changed. Look at git status.`);
    const origin = await this.git(['remote', 'get-url', 'origin']);
    if (origin.code !== 0 || !(this.o.originPattern ?? GITHUB_ORIGIN).test(data(origin).trim())) return this.fail('Checking the DemonX folder', 'its origin is not the DemonX repository on GitHub, so the release cannot be trusted to come from there; nothing was changed.');
    const head = await this.git(['rev-parse', 'HEAD']);
    if (head.code !== 0 || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(data(head).trim())) return this.fail('Checking the DemonX folder', 'could not read the current version from git');
    const prev = data(head).trim(), from = this.o.current;
    const br = await this.git(['symbolic-ref', '-q', '--short', 'HEAD']);
    const prevBranch = br.code === 0 && /^[\w./-]+$/.test(data(br).trim()) ? data(br).trim() : '';

    this.set({ step: `Fetching ${tag}` });
    const f = await this.git(['fetch', '--no-tags', 'origin', `+${ref}:${ref}`]);
    if (f.code !== 0) return this.fail(`Fetching ${tag}`, `${tail(f.out) || 'git fetch failed'}. Nothing was changed.`);

    this.set({ step: `Checking ${tag}` });
    const pj = await this.git(['show', `${ref}:package.json`]);
    let ver = '';
    try { ver = String(JSON.parse(data(pj)).version ?? ''); } catch { /* not readable */ }
    if (pj.code !== 0 || ver !== rel.version) return this.fail(`Checking ${tag}`, `the release says ${rel.version} but its package.json says ${ver || 'nothing readable'}; nothing was changed.`);

    // from here on the folder changes; any failure puts the previous version back
    const back = async () => {
      await this.git(['checkout', '--', 'package-lock.json']);
      const r = prevBranch ? await this.git(['checkout', prevBranch]) : await this.git(['checkout', '--detach', prev]);
      if (r.code !== 0) return false;
      const cur = await this.git(['rev-parse', 'HEAD']);
      if (data(cur).trim() !== prev) return false;
      // the served screen (web/dist) was never touched, so it already is the old version's: only its packages need putting back
      try { removeStaged(this.webRoot); } catch { /* a left-over staged screen is removed at the next start */ }
      const i = await this.npm(['install']);
      return i.code === 0;
    };
    this.rollback = back;
    this.marker(true);   // from here the folder can be half-changed: if DemonX is stopped meanwhile, the next start knows
    const failChanged = async (step: string, out: string) => {
      this.set({ step: 'Putting the previous version back' });
      const ok = await back();
      this.fail(step, `${tail(out) || 'it failed'}. ${ok ? 'The previous version was put back and DemonX was not restarted.' : 'Putting the previous version back also failed: DemonX is still running as it was, but its folder needs a look (git status, then bash scripts/update.sh).'}`, !ok);
    };

    this.set({ step: `Switching to ${tag}` });
    await this.git(['checkout', '--', 'package-lock.json']);
    const co = await this.git(['checkout', '--detach', ref]);
    if (co.code !== 0) {
      // git refuses before it writes anything, so if HEAD is where it was nothing changed and there is nothing to put back
      const now = await this.git(['rev-parse', 'HEAD']);
      if (now.code === 0 && data(now).trim() === prev) return this.fail(`Switching to ${tag}`, `${tail(co.out) || 'git could not switch'}. Nothing was changed.`);
      return failChanged(`Switching to ${tag}`, co.out);
    }
    this.set({ step: 'Installing packages (npm install), this can take several minutes' });
    const ins = await this.npm(['install']);
    if (ins.code !== 0) return failChanged('Installing packages', ins.out);
    this.set({ step: 'Building the new screen aside (npm run build:staging)' });
    try { removeStaged(this.webRoot); } catch { /* vite empties the folder anyway */ }
    const bld = await this.npm(['run', 'build:staging']);
    if (bld.code !== 0) return failChanged('Building the screen', bld.out);
    try { stampStaged(this.webRoot, rel.version); } catch (e) { return failChanged('Building the screen', `the new screen could not be marked as built (${(e as Error).message})`); }

    this.installed = rel.version;
    this.rollback = null;   // complete: nothing to put back any more
    this.marker(false);     // and nothing is installing: a restart from now on (even by hand) is a clean one
    // installed. Tell the next start about it whatever happens next (a manual restart later should still say it updated)
    const remember = (note: string) => {
      if (!this.o.dataDir) return;
      try { fs.writeFileSync(path.join(this.o.dataDir, 'update-applied.json'), JSON.stringify({ from, to: rel.version, ...(note ? { note } : {}) })); } catch { /* only the message after the restart is lost */ }
    };
    remember('');
    // DemonX Design (only where it is installed) gets its new screen built aside too. DemonX is already installed, so a problem here
    // is a warning: it never rolls DemonX back and never stops it from restarting.
    let designReady = false, designNote = '';
    if (this.designWanted && this.o.design) {
      designNote = await this.buildDesign();
      designReady = !designNote;
      if (designNote) this.o.log('error', designNote);
    }
    // The running copy still has the old code, so restart only when the machine is idle. During the install only the long-running
    // things were refused (jobBlock), so an alarm or a hold stayed clearable for as long as it took; the full lock is taken only now, in the same breath as the final
    // idle check, and held until DemonX restarts, so nothing can start in the moments PM2 needs. Short wait: a job started
    // meanwhile is not waited for, the owner restarts DemonX when it is done.
    this.set({ state: 'waiting', step: 'Installed. Restarting DemonX when the machine is idle', message: '' });
    this.o.log('info', `Update to ${rel.version} installed. DemonX restarts when the machine is idle.`);
    const poll = this.o.pollMs ?? 2000, until = Date.now() + (this.o.waitMs ?? 2 * MINUTE);
    for (;;) {
      // Design is asked first (it takes a moment); the check of this machine, the lock and the swap then follow without any waiting
      const designWhy = designReady && this.o.design ? await this.o.design.busy().catch((e: Error) => `DemonX Design could not be asked (${e.message})`) : null;
      const why = designWhy ?? this.o.busy();
      if (!why) { this.locked = true; this.o.lock(UPDATE_LOCK); break; }   // the swap below is in the same step as this final idle check
      if (Date.now() > until) return this.fail('Restarting', `${rel.version} is installed, but the machine was not idle (${why}), so DemonX was not restarted. When it is idle, restart DemonX: pm2 restart ${this.o.processName}. Until then the old screen and the old server keep running together; they are replaced by the new ones at the restart.${designReady ? ' DemonX Design was built but not restarted; it keeps running as it was.' : ''}${designNote ? ` ${designNote}` : ''}`);
      await new Promise((r) => setTimeout(r, poll));
    }
    this.set({ step: 'Restarting DemonX' });
    const swapErr = swapIn(this.webRoot);
    if (swapErr) return this.fail('Restarting', `${rel.version} is installed, but ${swapErr}, so DemonX was not restarted. Restart it when you are ready: pm2 restart ${this.o.processName}`);
    // Design before DemonX: restarting DemonX ends this process. Design's own problems are only warnings.
    if (designReady) {
      const w = await this.restartDesign();
      if (w) { designNote = w; this.o.log('error', w); }
    }
    remember(designNote);
    const err = await (this.o.restart ?? restartWithPm2)(this.o.processName);
    if (err) {
      const back = swapBack(this.webRoot);   // the old server keeps the screen it started with
      return this.fail('Restarting', `${rel.version} is installed, but DemonX could not ask PM2 to restart (${err}). Restart it yourself: pm2 restart ${this.o.processName}${back ? ` (${back})` : ''}${this.designRestarted ? ' DemonX Design was already updated and restarted.' : ''}`);
    }
    // stays active and locked: PM2 stops this process shortly, and the next one reports "Updated". If it does not, say so.
    setTimeout(() => {
      const back = swapBack(this.webRoot);
      this.fail('Restarting', `${rel.version} is installed, but DemonX is still running the old version a minute after PM2 was asked to restart it. It may still be starting: reload this page. If it does not come back, run: pm2 restart ${this.o.processName}${back ? ` (${back})` : ''}${this.designRestarted ? ' DemonX Design was already updated and restarted.' : ''}`);
    }, this.o.restartGraceMs ?? MINUTE).unref();
    this.set({ state: 'done', step: '', message: `Updated to ${rel.version}. DemonX is restarting; this page reconnects by itself.${designNote ? ` ${designNote}` : ''}`, target: rel.version });
  }

  /** Install Design's packages and build its screen into design/dist-next, leaving the screen it serves (design/dist) alone. '' when ready, else the warning. */
  private async buildDesign(): Promise<string> {
    const d = this.o.design!, web = path.join(d.dir, 'dist');
    const keep = 'It keeps running as it was.';
    this.set({ step: 'Updating DemonX Design: installing its packages (npm ci)' });
    const ci = await this.run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: d.dir, timeoutMs: 20 * MINUTE });
    if (ci.code !== 0) return `DemonX Design was not updated (npm ci failed: ${tail(ci.out) || 'no output'}). ${keep}`;
    try { removeStaged(web); } catch { /* vite empties it */ }
    this.set({ step: 'Updating DemonX Design: building its screen aside' });
    const b = await this.run('npm', ['run', 'build', '--', '--outDir', 'dist-next'], { cwd: d.dir, timeoutMs: 20 * MINUTE });
    if (b.code !== 0) { try { removeStaged(web); } catch { /* left over */ } return `DemonX Design was not updated (its build failed: ${tail(b.out) || 'no output'}). ${keep}`; }
    return '';
  }

  /** Swap Design's new screen in and restart it. '' when done, else the warning (and its old screen is back). */
  private async restartDesign(): Promise<string> {
    const d = this.o.design!, web = path.join(d.dir, 'dist');
    if (!PM2_NAME.test(d.name)) return 'DemonX Design was not restarted (its PM2 name is not usable).';
    this.set({ step: 'Restarting DemonX Design' });
    const e = swapIn(web);
    if (e) return `DemonX Design was not restarted: ${e}. It keeps running as it was.`;
    const r = await this.run('pm2', ['restart', d.name], { cwd: this.o.repoDir, timeoutMs: MINUTE });
    if (r.code !== 0) {
      const back = swapBack(web);   // the running Design keeps the screen it started with
      return `DemonX Design could not be restarted (${tail(r.out) || 'pm2 failed'}). It keeps running as it was${back ? ` (${back})` : ''}.`;
    }
    this.designRestarted = true;
    return '';
  }
}

/** Ask PM2 to restart this app. It outlives this process (PM2 stops this one as part of the restart). */
export function restartWithPm2(name: string, graceMs = 5000): Promise<string> {
  if (!PM2_NAME.test(name)) return Promise.resolve('the PM2 name is not usable');
  return new Promise((resolve) => {
    const p = spawn('pm2', ['restart', name], { detached: true, stdio: 'ignore', windowsHide: true });
    p.once('error', (e) => resolve((e as NodeJS.ErrnoException).code === 'ENOENT' ? 'pm2 was not found' : e.message));
    // a wrong name, or a PM2 daemon owned by another user, fails within a moment; a good restart usually takes this process down first
    p.once('exit', (code) => { if (code) resolve(`pm2 restart ${name} failed (exit code ${code})`); });
    setTimeout(() => { p.unref(); resolve(''); }, graceMs).unref();
  });
}
