// The laser's connection, owned by the server (a browser tab cannot own it: closing the tab must not leave a job
// half-run with nobody able to stop it, and a stale tab must not get past the rules here).
// It reuses DemonX's GRBL controller for streaming, feed hold, reset and status, and adds what a laser needs:
// laser mode must be on before a job starts, only laser G-code is accepted, jogging is XY only, framing keeps the
// laser off.
import { EventEmitter } from 'node:events';
import { GrblController } from '../../../server/src/controller.js';
import { SerialTransport, listSerialPorts } from '../../../server/src/transport.js';
import { SimulatorTransport } from '../../../server/src/simulator.js';
import type { PortInfo } from '../../../shared/protocol.js';
import { fingerprint } from '../../src/core/hash.js';
import { validateLaserGcode } from './validate.js';
import { SIMULATOR, type LaserInfo, type LaserState, type LoadedJob } from './protocol.js';
import type { LaserBackend, LaserCapabilities } from './laserBackend.js';

export interface Result { ok: boolean; message: string; code?: string }
const ok = (message: string): Result => ({ ok: true, message });
const no = (message: string, code?: string): Result => ({ ok: false, message, code });

const MAX_JOG = 100; // mm in one jog command
const MAX_JOG_FEED = 10000; // mm/min
const MAX_FRAME_FEED = 10000;

export interface SessionOptions {
  /** Speed of the simulated machine (1 is real time) */
  simSpeed?: number;
  /** Test hook: the serial ports to accept (default: what the computer reports) */
  listPorts?: () => Promise<PortInfo[]>;
  /**
   * The only serial ports that may be offered or opened. When this is set, every other port the computer reports is hidden, so a
   * machine that has a CNC (or anything else) on a USB port can never be picked as a laser by mistake. Not set: all of them
   * (tests); the server sets it from DESIGN_SERIAL_PORTS and an empty list means no USB lasers at all.
   */
  allowedPorts?: string[];
}

/** Events: 'state' (LaserState), 'log' (LogLine) */
export class LaserSession extends EventEmitter implements LaserBackend {
  readonly kind = 'grbl' as const;
  readonly capabilities: LaserCapabilities = { jobFormat: 'gcode', home: true, setOrigin: true, pause: true, needsLaserModeCheck: true };
  readonly controller = new GrblController();
  laser: LaserInfo = { mode: 'unknown', sMax: null, checkedAt: null };
  loaded: LoadedJob | null = null;
  private opts: SessionOptions;
  private checking?: Promise<LaserInfo>;
  private checkTimer?: NodeJS.Timeout;

  constructor(opts: SessionOptions = {}) {
    super();
    this.opts = opts;
    this.controller.firmwareAskMs = 600;
    const push = () => this.emit('state', this.state());
    this.controller.on('status', push);
    this.controller.on('job', push);
    this.controller.on('connection', push);
    this.controller.on('log', (l) => this.emit('log', l));
    // A reset (or reconnect) can change the controller's settings: look again once it has started
    this.controller.on('reset', () => this.scheduleCheck(800));
  }

  state(): LaserState {
    return { kind: 'grbl', capabilities: this.capabilities, connection: this.controller.connection, status: this.controller.status, job: this.controller.job, laser: this.laser, loaded: this.loaded };
  }

  recentLog(n: number) { return this.controller.logBuffer.slice(-n); }

  async ports(): Promise<PortInfo[]> {
    const all = await (this.opts.listPorts ?? listSerialPorts)().catch(() => [] as PortInfo[]);
    const allowed = this.opts.allowedPorts;
    const real = allowed ? all.filter((p) => allowed.includes(p.path)) : all;
    return [{ path: SIMULATOR, description: 'Simulated laser (no machine)' }, ...real];
  }

  // ---------- connection ----------
  async connect(target: string): Promise<Result> {
    if (this.controller.connection.connected) return no('Already connected. Disconnect first.');
    try {
      if (target === SIMULATOR) {
        await this.controller.connect(new SimulatorTransport(this.opts.simSpeed ?? 1), 'simulator');
      } else {
        // Only a port the computer itself reports may be opened: the browser does not get to name any path it likes
        const known = (await this.ports()).some((p) => p.path === target && p.path !== SIMULATOR);
        if (!known) return no(`${target} is not a serial port on this computer`);
        await this.controller.connect(new SerialTransport(target, 115200), target);
      }
    } catch (e) {
      return no(`Could not open ${target}: ${(e as Error).message}`);
    }
    this.laser = { mode: 'unknown', sMax: null, checkedAt: null };
    this.loaded = null;
    this.scheduleCheck(900);
    return ok(`Connected to ${target}`);
  }

  async disconnect(): Promise<Result> {
    if (this.controller.job.state === 'running' || this.controller.job.state === 'paused') {
      return no('A job is running. Stop it first (Stop also switches the laser off).');
    }
    clearTimeout(this.checkTimer);
    await this.controller.disconnect();
    this.laser = { mode: 'unknown', sMax: null, checkedAt: null };
    this.emit('state', this.state());
    return ok('Disconnected');
  }

  // ---------- laser mode ----------
  private scheduleCheck(ms: number) {
    clearTimeout(this.checkTimer);
    this.checkTimer = setTimeout(() => void this.checkLaser(), ms);
  }

  /** Read $32 (laser mode) and $30 (the value for full power) from the controller. */
  checkLaser(): Promise<LaserInfo> {
    if (this.checking) return this.checking;
    this.checking = (async () => {
      const c = this.controller;
      if (!c.connection.connected) return this.laser;
      if (c.job.state === 'running' || c.job.state === 'paused') return this.laser;
      const r = await c.runCommand('$$', 5000);
      const get = (n: number) => {
        const m = r.lines.map((l) => new RegExp(`^\\$${n}=([-\\d.]+)`).exec(l.trim())).find(Boolean);
        return m ? Number(m[1]) : null;
      };
      const mode32 = get(32);
      const sMax = get(30);
      this.laser = mode32 === null
        ? { mode: 'unknown', sMax, checkedAt: Date.now(), note: 'The controller did not report its settings ($$), so laser mode could not be checked. Confirm it yourself.' }
        : { mode: mode32 === 1 ? 'on' : 'off', sMax, checkedAt: Date.now(), note: mode32 === 1 ? undefined : 'Laser mode is off ($32=0). With it off, M4 keeps the laser on even while the head is still.' };
      this.emit('state', this.state());
      return this.laser;
    })().finally(() => { this.checking = undefined; });
    return this.checking;
  }

  async enableLaserMode(): Promise<Result> {
    const c = this.controller;
    if (!c.connection.connected) return no('Not connected');
    if (c.job.state === 'running' || c.job.state === 'paused') return no('A job is running');
    if (c.status.state !== 'Idle') return no(`The machine is ${c.status.state}, not Idle`);
    const a = await c.sendInternal('$32=1');
    if (!a.ok) return no('The controller refused $32=1. Change it in its own settings.');
    const info = await this.checkLaser();
    return info.mode === 'on' ? ok('Laser mode is on ($32=1)') : no('Laser mode is still not on. Check the controller.');
  }

  // ---------- moving (laser off) ----------
  private idleOrJog(): Result | null {
    const c = this.controller;
    if (!c.connection.connected) return no('Not connected');
    if (c.job.state === 'running' || c.job.state === 'paused') return no('A job is running');
    return null;
  }

  jog(dx: number, dy: number, feed: number): Result {
    const bad = this.idleOrJog();
    if (bad) return bad;
    if (![dx, dy, feed].every(Number.isFinite)) return no('Bad jog');
    if (!dx && !dy) return no('Nothing to move');
    if (Math.abs(dx) > MAX_JOG || Math.abs(dy) > MAX_JOG) return no(`One jog is at most ${MAX_JOG} mm`);
    if (!(feed >= 1 && feed <= MAX_JOG_FEED)) return no('Jog speed must be 1 to 10000 mm/min');
    const f = (v: number) => String(Math.round(v * 1000) / 1000);
    // $J jogs never fire the laser
    this.controller.sendLine(`$J=G21G91${dx ? `X${f(dx)}` : ''}${dy ? `Y${f(dy)}` : ''}F${f(feed)}`);
    return ok('Jog sent');
  }

  jogZ(): Result { return no('Z moves work with a Ruida laser for now.', 'unsupported'); }

  moveTo(): Result { return no('Saved positions work with a Ruida laser for now.', 'unsupported'); }

  setOrigin(): Result {
    const bad = this.idleOrJog();
    if (bad) return bad;
    if (this.controller.status.state !== 'Idle') return no(`The machine is ${this.controller.status.state}, not Idle`);
    this.controller.sendLine('G10L20P0X0Y0');
    return ok('Work zero set here (X and Y)');
  }

  goOrigin(feed: number): Result {
    const bad = this.idleOrJog();
    if (bad) return bad;
    if (this.controller.status.state !== 'Idle') return no(`The machine is ${this.controller.status.state}, not Idle`);
    if (!(feed >= 1 && feed <= MAX_FRAME_FEED)) return no('Speed must be 1 to 10000 mm/min');
    this.controller.sendLine('M5');
    this.controller.sendLine(`G21G90G1X0Y0F${Math.round(feed)}`);
    return ok('Going to work zero');
  }

  home(): Result {
    const bad = this.idleOrJog();
    if (bad) return bad;
    this.controller.sendLine('$H');
    return ok('Homing');
  }

  unlock(): Result {
    if (!this.controller.connection.connected) return no('Not connected');
    this.controller.sendLine('$X');
    return ok('Unlock sent');
  }

  /** Soft reset. Always allowed: it also switches the laser off. */
  reset(): Result {
    if (!this.controller.connection.connected) return no('Not connected');
    this.controller.softReset();
    return ok('Reset sent');
  }

  // ---------- the job ----------
  loadJob(name: string, content: string): Result {
    const c = this.controller;
    if (!c.connection.connected) return no('Not connected');
    if (c.job.state === 'running' || c.job.state === 'paused') return no('A job is running');
    const check = validateLaserGcode(content, this.laser.sMax);
    if (!check.ok) return no(`The job was not sent. ${check.error}`, 'invalid-job');
    const safe = name.replace(/[^\w .-]/g, '_').slice(0, 60) || 'laser-job';
    c.loadJob(safe, content);
    this.loaded = { name: safe, hash: fingerprint(content), lines: check.lines, maxS: check.maxS };
    this.emit('state', this.state());
    return ok(`Job sent: ${check.lines} lines`);
  }

  /** Trace the outline of the loaded job with the laser off, then come back to where the head was. */
  autoFocus(): Result { return no('Auto focus works with a Ruida laser for now.', 'unsupported'); }

  frame(feed: number, shape?: 'box' | 'circle', origin?: { x: number; y: number }): Result {
    if (origin) return no('Framing from an origin works with a Ruida laser for now.', 'unsupported');
    if (shape === 'circle') return no('A circular frame works with a Ruida laser for now.', 'unsupported');
    const c = this.controller;
    if (!c.connection.connected) return no('Not connected');
    if (c.job.state === 'running' || c.job.state === 'paused') return no('A job is running');
    if (c.status.state !== 'Idle') return no(`Framing needs the machine Idle (it is ${c.status.state})`);
    if (!(feed >= 1 && feed <= MAX_FRAME_FEED)) return no('Frame speed must be 1 to 10000 mm/min');
    const b = c.job.extents?.all;
    if (!this.loaded || !b) return no('Send the job first: the frame is the outline of its moves');
    const { x, y } = c.status.wpos;
    const f = (n: number) => n.toFixed(3);
    const F = Math.round(feed);
    for (const l of [
      'M5', 'G21G90',
      `G1X${f(b.minX)}Y${f(b.minY)}F${F}`, `G1X${f(b.maxX)}Y${f(b.minY)}`, `G1X${f(b.maxX)}Y${f(b.maxY)}`, `G1X${f(b.minX)}Y${f(b.maxY)}`, `G1X${f(b.minX)}Y${f(b.minY)}`,
      `G1X${f(x)}Y${f(y)}`,
    ]) c.sendLine(l);
    c.log('sys', `Frame (laser off): X ${f(b.minX)} to ${f(b.maxX)}, Y ${f(b.minY)} to ${f(b.maxY)}`);
    return ok('Framing');
  }

  /**
   * Start the job on the machine. Refused unless the controller is Idle, the job on the machine is exactly the one the
   * browser means (`hash`), laser mode is on (checked again now), and the job's power fits the controller's maximum.
   */
  async start(hash: string, acknowledgeUnverified = false): Promise<Result> {
    const c = this.controller;
    if (!c.connection.connected) return no('Not connected');
    if (!this.loaded) return no('Send the job to the laser first', 'no-job');
    if (this.loaded.hash !== hash) return no('The job on the machine is not the one on screen. Send it again.', 'stale-job');
    if (c.job.state === 'running' || c.job.state === 'paused') return no('A job is already running');
    if (c.status.state !== 'Idle') return no(`The machine is ${c.status.state}, not Idle`, 'not-idle');
    const laser = await this.checkLaser();
    if (laser.mode === 'off') return no('Laser mode is off ($32=0). Turn it on first, otherwise the laser stays lit while the head is still.', 'laser-mode-off');
    if (laser.mode === 'unknown' && !acknowledgeUnverified) return no('Laser mode could not be checked. Confirm that it is on in the controller, then start again.', 'laser-mode-unverified');
    if (laser.sMax !== null && this.loaded.maxS > laser.sMax) return no(`The job uses S up to ${this.loaded.maxS} but the controller's maximum is ${laser.sMax} ($30). Make the machine's S max match and send the job again.`, 'smax');
    c.startJob();
    return ok('Job started');
  }

  pause(): Result {
    if (this.controller.job.state !== 'running') return no('No job is running');
    this.controller.handle({ type: 'hold' });
    return ok('Paused (feed hold)');
  }

  resume(): Result {
    if (!this.controller.connection.connected) return no('Not connected');
    this.controller.handle({ type: 'resume' });
    return ok('Resumed');
  }

  /** Feed hold, then soft reset: the laser is off and the job is dropped. */
  async stop(): Promise<Result> {
    const c = this.controller;
    if (!c.connection.connected) return no('Not connected');
    if (c.job.state === 'running' || c.job.state === 'paused') await c.stopJob();
    else c.softReset();
    return ok('Stopped. The laser is off.');
  }

  async close() {
    clearTimeout(this.checkTimer);
    await this.controller.disconnect().catch(() => {});
  }
}
