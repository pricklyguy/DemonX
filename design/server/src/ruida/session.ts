// The Ruida backend: talks UDP to the controller the way LightBurn does, as seen in the captures.
//
// NOT TRIED ON A REAL MACHINE. It is tested against the simulator in this folder, which is built from recordings.
// Rules this file keeps (the browser is never trusted for safety):
//   - only targets the server was configured with can be opened (or the built-in simulator); never an address from the browser
//   - a job is parsed and checked here (limits, work area from where the head actually is, power, speed) before it is sent
//   - the job is written by our own writer, never taken as bytes from the browser
//   - while a job runs: no jogging, framing, loading or disconnecting; Stop always works and is sent three times
//   - a job upload is never retried half way: on any problem the upload is abandoned and a stop is sent
//   - if the controller stops answering while a job runs, stop is sent
//   - jogs and frames always set the laser's power to 0 first (as LightBurn does) and only use rapid moves
import { EventEmitter } from 'node:events';
import dgram from 'node:dgram';
import type { ConnectionInfo, JobInfo, LogLine, MachineStatus, PortInfo } from '../../../../shared/protocol.js';
import { fingerprint } from '../../../src/core/hash.js';
import type { LaserInfo, LaserState, LoadedJob } from '../protocol.js';
import type { LaserBackend, LaserCapabilities, Result } from '../laserBackend.js';
import { ACK, DEFAULT_KEY, MAX_DATAGRAM, buildDatagram, dec35, encSpeed, enc35, scramble, toUm, unscramble } from './codec.js';
import { parsePlan, planBox, reach, reachText, type Box, type RuidaPlan } from './plan.js';
import { checkPlan, type JobLimits } from './validate.js';
import { writeJobStream } from './write.js';
import { RuidaSimServer } from './udp.js';
import { controllerProblem, type RuidaConfig } from './config.js';
import fs from 'node:fs';
import path from 'node:path';

export const RUIDA_SIMULATOR = 'ruida-sim';
const RUIDA_PREFIX = 'ruida:';

const ok = (message: string): Result => ({ ok: true, message });
const no = (message: string, code?: string): Result => ({ ok: false, message, code });

const MAX_JOG = 100; // mm in one jog
const MAX_RAPID_SPEED = 100; // mm/s for jogs and frames: what LightBurn used
const STATUS = '0400', POS_X = '0421', POS_Y = '0431', POS_Z = '0441', CARD = '057e', BED_X = '0026', BED_Y = '0036';
const BIT_RUNNING = 0x1, BIT_PAUSED = 0x2, BIT_MOVING = 0x01000000;

export interface RuidaSessionOptions {
  config: RuidaConfig;
  /** Is rotary switched on for this laser? Rotary jobs are refused until the way the controller wants them is known (see core/rotary.ts) */
  rotaryOn?: (target: string) => boolean;
  /** where controllers added in the panel are remembered (a small JSON file on this computer, never in the project) */
  storeFile?: string;
  /** speed of the simulated controller (1 is real time) */
  simSpeed?: number;
  /** UDP port the controller listens on; 50200 on the real thing */
  controllerPort?: number;
  /** our own UDP port. The controller always answers port 40200, so that is the default; tests use 0 with the simulator. */
  localPort?: number;
  /** how often the controller is asked for its state, ms */
  pollMs?: number;
  /** how long to wait for one answer, ms */
  replyMs?: number;
}

type Phase = 'none' | 'loaded' | 'starting' | 'running' | 'paused' | 'done' | 'error';

interface Waiter { kind: 'ack' | 'read'; addr?: string; resolve: (v: { ok: boolean; value?: number }) => void; timer: NodeJS.Timeout }

/** Events: 'state' (LaserState), 'log' (LogLine) */
export class RuidaSession extends EventEmitter implements LaserBackend {
  readonly kind = 'ruida' as const;
  readonly capabilities: LaserCapabilities;

  private cfg: RuidaConfig;
  private fixed: Set<string>;
  private opts: RuidaSessionOptions;
  private sock: dgram.Socket | null = null;
  private sim: RuidaSimServer | null = null;
  private host = '';
  private port = 50200;
  private target = '';
  private connected = false;
  private waiters: Waiter[] = [];
  private poller?: NodeJS.Timeout;
  /** One conversation with the controller at a time, so replies cannot be mixed up. Stop never waits for it. */
  private locked = false;
  private silent = 0; // polls in a row without an answer

  private word = 0; // the status word
  private head = { x: 0, y: 0 }; // machine coordinates, Y toward the front
  /** Z in micrometres as the controller reports it, and what it read when this program first looked (Z is shown as the change since then) */
  private z: number | null = null;
  private zZero: number | null = null;
  /** while the head is homing or auto focusing the controller may not answer (LightBurn stopped asking too): no 'lost contact' until this time */
  private settleUntil = 0;
  private settleKind: 'home' | 'focus' = 'home';
  private settleStarted = 0;
  private settleLastZ: number | null = null;
  private bedW: number;
  private bedH: number;
  private cardId = '';

  private phase: Phase = 'none';
  private jobError: string | undefined;
  private startedAt = 0;
  private endedAt = 0;
  private sawRunning = false;
  /** set by Stop: an upload in progress must not carry on */
  private abort = false;
  private loaded: (LoadedJob & { stream: Buffer; plan: RuidaPlan; box: Box }) | null = null;
  private logBuf: LogLine[] = [];

  constructor(opts: RuidaSessionOptions) {
    super();
    this.opts = opts;
    // controllers named in the environment, then the ones added in the panel
    this.fixed = new Set(Object.keys(opts.config.controllers));
    this.cfg = { ...opts.config, controllers: { ...this.readStore(opts.storeFile), ...opts.config.controllers } };
    this.bedW = this.cfg.bedW;
    this.bedH = this.cfg.bedH;
    this.capabilities = { jobFormat: 'ruida-plan', home: this.cfg.home === true, z: this.cfg.z === true, setOrigin: false, pause: this.cfg.pause, needsLaserModeCheck: false };
  }

  // ---------- state ----------
  private log(kind: LogLine['kind'], text: string) {
    const l: LogLine = { t: Date.now(), kind, text };
    this.logBuf.push(l);
    if (this.logBuf.length > 300) this.logBuf.shift();
    this.emit('log', l);
  }
  recentLog(n: number): LogLine[] { return this.logBuf.slice(-n); }

  private machineState(): MachineStatus['state'] {
    if (!this.connected) return 'Disconnected';
    if (Date.now() < this.settleUntil) return this.settleKind === 'home' ? 'Home' : 'Run';
    if (this.silent >= 3) return 'Alarm';
    if (this.phase === 'paused' || (this.word & BIT_RUNNING && this.word & BIT_PAUSED)) return 'Hold';
    if (this.phase === 'running' || this.phase === 'starting' || this.word & (BIT_RUNNING | BIT_MOVING)) return 'Run';
    return 'Idle';
  }

  state(): LaserState {
    const v = { x: 0, y: 0, z: 0 };
    // shown the way LightBurn shows it: from the rear-left corner, X to the right, Y toward the front
    const w = { x: this.head.x, y: this.head.y, z: this.z !== null && this.zZero !== null ? Math.round(this.z - this.zZero) / 1000 : 0 };
    const status: MachineStatus = {
      state: this.machineState(), mpos: w, wpos: w, wco: v, feed: 0, spindle: 0, ov: { feed: 100, rapid: 100, spindle: 100 }, pins: '', accessories: '',
    };
    const connection: ConnectionInfo = { connected: this.connected, target: this.target, firmware: this.connected ? `Ruida controller${this.cardId ? ' ' + this.cardId : ''}` : undefined };
    const jobState = this.phase === 'starting' ? 'running' : this.phase;
    const job: JobInfo = {
      state: jobState,
      name: this.loaded?.name ?? '',
      totalLines: 0, sentLines: 0, doneLines: 0, // the controller does not report progress
      startedAt: this.startedAt || undefined,
      elapsedMs: this.startedAt ? (this.phase === 'running' || this.phase === 'starting' || this.phase === 'paused' ? Date.now() : this.endedAt || Date.now()) - this.startedAt : 0,
      error: this.jobError,
    };
    const laser: LaserInfo = { mode: 'on', sMax: null, checkedAt: Date.now(), note: 'Ruida: power is set per layer in the job.' };
    const loaded = this.loaded ? { name: this.loaded.name, hash: this.loaded.hash, lines: this.loaded.lines, maxS: this.loaded.maxS } : null;
    return { kind: 'ruida', capabilities: this.capabilities, workArea: { width: this.bedW, height: this.bedH }, connection, status, job, laser, loaded };
  }
  private push() { this.emit('state', this.state()); }

  // ---------- the wire ----------
  private onMessage = (msg: Buffer, rinfo: dgram.RemoteInfo) => {
    if (rinfo.address !== this.host) return; // only the controller we opened
    const b = unscramble(msg, DEFAULT_KEY);
    if (b.length === 1) {
      const w = this.waiters.findIndex((x) => x.kind === 'ack');
      if (w >= 0) { const x = this.waiters.splice(w, 1)[0]; clearTimeout(x.timer); x.resolve({ ok: b[0] === ACK }); if (b[0] !== ACK) this.log('err', `The controller answered ${b[0].toString(16)} instead of OK`); }
      return;
    }
    if (b.length === 9 && b[0] === 0xda && b[1] === 0x01) {
      const addr = b.subarray(2, 4).toString('hex');
      const w = this.waiters.findIndex((x) => x.kind === 'read' && x.addr === addr);
      if (w >= 0) { const x = this.waiters.splice(w, 1)[0]; clearTimeout(x.timer); x.resolve({ ok: true, value: dec35(b, 4) }); }
    }
  };

  private expect(kind: Waiter['kind'], addr?: string): Promise<{ ok: boolean; value?: number }> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const i = this.waiters.findIndex((x) => x.timer === timer);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve({ ok: false });
      }, this.opts.replyMs ?? 1000);
      this.waiters.push({ kind, addr, resolve, timer });
    });
  }

  private rawSend(cmd: Uint8Array) {
    if (!this.sock) return;
    this.sock.send(buildDatagram(cmd), this.port, this.host);
  }

  /** One command, waits for the controller's OK */
  private async send(cmd: Uint8Array): Promise<boolean> {
    if (!this.sock) return false;
    const p = this.expect('ack');
    this.rawSend(cmd);
    return (await p).ok;
  }

  private async read(addr: string): Promise<number | null> {
    if (!this.sock) return null;
    const a = this.expect('ack');
    const r = this.expect('read', addr);
    this.rawSend(Buffer.from([0xda, 0x00, parseInt(addr.slice(0, 2), 16), parseInt(addr.slice(2), 16)]));
    const [ack, val] = await Promise.all([a, r]);
    return ack.ok && val.ok ? val.value ?? null : null;
  }

  private async sendAll(cmds: number[][]): Promise<boolean> {
    for (const c of cmds) if (!(await this.send(Buffer.from(c)))) return false;
    return true;
  }

  private async acquire(ms = 3000): Promise<boolean> {
    const end = Date.now() + ms;
    while (this.locked) { if (Date.now() > end) return false; await new Promise((r) => setTimeout(r, 5)); }
    this.locked = true;
    return true;
  }
  private release() { this.locked = false; }

  // ---------- the controllers this computer knows ----------
  private readStore(file?: string): Record<string, string> {
    if (!file) return {};
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      const out: Record<string, string> = {};
      if (raw && typeof raw === 'object') for (const [n, h] of Object.entries(raw)) if (typeof h === 'string' && !controllerProblem(n, h)) out[n] = h;
      return out;
    } catch { return {}; }
  }

  private writeStore() {
    const file = this.opts.storeFile;
    if (!file) return;
    const saved = Object.fromEntries(Object.entries(this.cfg.controllers).filter(([n]) => !this.fixed.has(n)));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(saved, null, 2));
  }

  addController(name: string, host: string): Result {
    if (!this.cfg.enabled) return no('Ruida support is switched off (start the server with DESIGN_RUIDA=1).');
    name = name.trim(); host = host.trim();
    const why = controllerProblem(name, host);
    if (why) return no(why);
    if (this.fixed.has(name)) return no(`"${name}" is set by the server's settings and cannot be changed here.`);
    this.cfg.controllers[name] = host;
    try { this.writeStore(); } catch (e) { return no(`Added for now, but it could not be saved: ${(e as Error).message}`); }
    return ok(`Added ${name}. Pick it in the list and press Connect.`);
  }

  removeController(name: string): Result {
    if (this.fixed.has(name)) return no(`"${name}" is set by the server's settings and cannot be removed here.`);
    if (!Object.hasOwn(this.cfg.controllers, name)) return no('No such controller');
    if (this.connected && this.target === RUIDA_PREFIX + name) return no('Disconnect first.');
    delete this.cfg.controllers[name];
    try { this.writeStore(); } catch (e) { return no(`Removed for now, but the saved list could not be updated: ${(e as Error).message}`); }
    return ok(`Removed ${name}.`);
  }

  // ---------- connection ----------
  async ports(): Promise<PortInfo[]> {
    if (!this.cfg.enabled) return [];
    return [
      { path: RUIDA_SIMULATOR, description: 'Simulated Ruida laser (no machine)' },
      ...Object.entries(this.cfg.controllers).map(([n, h]) => ({ path: RUIDA_PREFIX + n, description: `Ruida controller at ${h} (not tried on hardware)` })),
    ];
  }

  async connect(target: string): Promise<Result> {
    if (!this.cfg.enabled) return no('Ruida support is switched off (DESIGN_RUIDA=1 turns it on).');
    if (this.connected) return no('Already connected. Disconnect first.');
    let host: string, port = this.opts.controllerPort ?? 50200, local = this.opts.localPort ?? 40200;
    if (target === RUIDA_SIMULATOR) {
      this.sim = new RuidaSimServer(this.opts.simSpeed ?? 1, { bedW: this.cfg.bedW, bedH: this.cfg.bedH });
      port = await this.sim.listen(0);
      host = '127.0.0.1'; local = this.opts.localPort ?? 0;
    } else if (target.startsWith(RUIDA_PREFIX) && Object.hasOwn(this.cfg.controllers, target.slice(RUIDA_PREFIX.length))) {
      host = this.cfg.controllers[target.slice(RUIDA_PREFIX.length)];
    } else return no(`${target} is not a Ruida controller this server was set up with`);

    const sock = dgram.createSocket('udp4');
    try {
      await new Promise<void>((res, rej) => { sock.once('error', rej); sock.bind(local, () => res()); });
    } catch (e) {
      sock.close();
      await this.sim?.close(); this.sim = null;
      return no((e as NodeJS.ErrnoException).code === 'EADDRINUSE'
        ? `Port ${local} is in use. The Ruida controller always answers port 40200; close LightBurn (or any other program using it) and try again.`
        : `Could not open port ${local}: ${(e as Error).message}`);
    }
    sock.on('message', this.onMessage);
    sock.on('error', (e) => this.log('err', `UDP error: ${e.message}`));
    this.sock = sock; this.host = host; this.port = port; this.target = target;

    const card = await this.read(CARD);
    if (card === null) {
      await this.teardown();
      return no(`The controller${target === RUIDA_SIMULATOR ? '' : ' at ' + host} did not answer. Check the address (the one LightBurn shows), that this computer is on the same network, that the cable is in, and that no other program is connected to it.`);
    }
    this.cardId = '0x' + card.toString(16);
    this.connected = true;
    this.silent = 0; this.phase = 'none'; this.loaded = null; this.jobError = undefined;
    const [bx, by] = [await this.read(BED_X), await this.read(BED_Y)];
    if (bx && by) {
      this.bedW = Math.min(this.cfg.bedW, bx / 1000); this.bedH = Math.min(this.cfg.bedH, by / 1000);
      if (Math.abs(bx / 1000 - this.cfg.bedW) > 1 || Math.abs(by / 1000 - this.cfg.bedH) > 1) this.log('sys', `The controller reports a bed of ${bx / 1000} x ${by / 1000} mm; the configured size is ${this.cfg.bedW} x ${this.cfg.bedH} mm. The smaller is used.`);
    }
    await this.pollOnce();
    this.poller = setInterval(() => void this.pollOnce(), this.opts.pollMs ?? 250);
    this.log('sys', `Connected to ${target}. Not tried on a real machine: watch the first runs at low power.`);
    this.push();
    return ok(`Connected to ${target}`);
  }

  private async teardown() {
    clearInterval(this.poller);
    for (const w of this.waiters.splice(0)) { clearTimeout(w.timer); w.resolve({ ok: false }); }
    if (this.sock) { this.sock.removeAllListeners(); try { this.sock.close(); } catch { /* already closed */ } this.sock = null; }
    await this.sim?.close(); this.sim = null;
    this.connected = false;
  }

  private jobActive() { return this.phase === 'starting' || this.phase === 'running' || this.phase === 'paused'; }

  async disconnect(): Promise<Result> {
    if (this.jobActive()) return no('A job is running. Stop it first (Stop also switches the laser off).');
    await this.teardown();
    this.phase = 'none'; this.loaded = null;
    this.push();
    return ok('Disconnected');
  }

  async close() {
    if (this.connected && this.jobActive()) await this.stopNow('closing');
    await this.teardown();
  }

  // ---------- watching the controller ----------
  private async pollOnce() {
    if (this.locked || !this.sock) return;
    this.locked = true;
    try {
      const w = await this.read(STATUS);
      if (w === null) {
        if (Date.now() < this.settleUntil) return; // homing: no answer is normal
        this.silent++;
        if (this.silent === 3) {
          this.log('err', 'The controller stopped answering.');
          if (this.jobActive()) { this.jobError = 'Lost contact with the controller; stop was sent.'; this.phase = 'error'; void this.stopNow('lost contact'); }
          this.push();
        }
        return;
      }
      const recovered = this.silent >= 3;
      this.silent = 0;
      const [x, y] = [await this.read(POS_X), await this.read(POS_Y)];
      const zRaw = this.cfg.z ? await this.read(POS_Z) : null;
      if (zRaw !== null) { this.z = zRaw; if (this.zZero === null) this.zZero = zRaw; }
      const moved = x !== null && y !== null && (x / 1000 !== this.head.x || y / 1000 !== this.head.y);
      if (x !== null && y !== null) this.head = { x: x / 1000, y: y / 1000 };
      // homing is over once the head is at the origin and the controller says it is not moving; auto focus once Z has stopped changing
      if (Date.now() < this.settleUntil) {
        if (this.settleKind === 'home' && x !== null && y !== null && Math.abs(x) < 500 && Math.abs(y) < 500 && !(w & BIT_MOVING)) { this.settleUntil = 0; this.log('sys', 'Homing finished.'); }
        else if (this.settleKind === 'focus' && zRaw !== null && Date.now() - this.settleStarted > 2000 && !(w & BIT_MOVING) && zRaw === this.settleLastZ) { this.settleUntil = 0; this.log('sys', 'Auto focus finished.'); }
        if (zRaw !== null) this.settleLastZ = zRaw;
      }
      const before = this.word;
      this.word = w;
      this.followJob();
      if (recovered) this.log('sys', 'The controller is answering again.');
      if (before !== w || moved || recovered || zRaw !== null || this.phase !== 'none') this.push();
    } finally { this.release(); }
  }

  private followJob() {
    const running = (this.word & BIT_RUNNING) !== 0;
    if (this.phase === 'starting') {
      if (running) { this.sawRunning = true; this.phase = 'running'; }
      else if (Date.now() - this.startedAt > 2500) {
        // a very short job can be over before the first look; the word then says "ended" (bit 9)
        this.phase = 'done'; this.endedAt = Date.now();
        this.log('sys', 'The job was sent. The controller never reported it running; a very short job may already be done.');
      }
    }
    if (this.phase === 'running' || this.phase === 'paused') {
      if (running) this.phase = (this.word & BIT_PAUSED) ? 'paused' : 'running';
      else { this.phase = 'done'; this.endedAt = Date.now(); this.log('sys', 'Job finished.'); }
    }
  }

  /** A refusal the owner should be able to find again: it goes in the log as well as back to the panel */
  private refuse(message: string, code?: string): Result {
    this.log('err', message);
    return no(message, code);
  }

  // ---------- checks shared by moves ----------
  private idleCheck(): Result | null {
    if (!this.connected) return no('Not connected');
    if (Date.now() < this.settleUntil) return no(this.settleKind === 'home' ? 'The laser is homing' : 'The laser is auto focusing');
    if (this.silent >= 3) return no('The controller is not answering');
    if (this.jobActive()) return no('A job is running');
    if (this.word & (BIT_RUNNING | BIT_MOVING)) return no('The controller is busy (a move or a job is in progress)');
    return null;
  }

  /** Read the position and status right now, so decisions use what the machine says, not the last poll */
  private async fresh(): Promise<{ x: number; y: number; word: number } | null> {
    const [w, x, y] = [await this.read(STATUS), await this.read(POS_X), await this.read(POS_Y)];
    if (w === null || x === null || y === null) return null;
    this.word = w; this.head = { x: x / 1000, y: y / 1000 };
    return { x: x / 1000, y: y / 1000, word: w };
  }

  private inBed(x: number, y: number) { return x >= 0 && y >= 0 && x <= this.bedW && y <= this.bedH; }

  private moveSequence(speedMmS: number, x: number, y: number): number[][] {
    // what LightBurn sends for a jog: speed, minimum power 0 on both lasers, then an absolute rapid move
    return [
      [0xc9, 0x02, ...encSpeed(speedMmS)],
      [0xc6, 0x01, 0x00, 0x00],
      [0xc6, 0x21, 0x00, 0x00],
      [0xd9, 0x10, 0x00, ...enc35(toUm(x)), ...enc35(toUm(y))],
    ];
  }

  // ---------- moving, laser off ----------
  async jog(dx: number, dy: number, feed: number): Promise<Result> {
    const bad = this.idleCheck();
    if (bad) return bad;
    if (![dx, dy, feed].every(Number.isFinite)) return this.refuse('Bad jog');
    if (!dx && !dy) return this.refuse('Nothing to move');
    if (Math.abs(dx) > MAX_JOG || Math.abs(dy) > MAX_JOG) return this.refuse(`One jog is at most ${MAX_JOG} mm`);
    if (!(feed >= 1 && feed <= 10000)) return this.refuse('Jog speed must be 1 to 10000 mm/min');
    if (!(await this.acquire())) return this.refuse('Busy talking to the controller; try again');
    try {
    const here = await this.fresh();
    if (!here) return this.refuse('The controller did not answer');
    if (here.word & (BIT_RUNNING | BIT_MOVING)) return this.refuse('The controller is busy');
    // the drawing's Y points up (toward the back of the machine); the controller's Y grows toward the front
    const tx = here.x + dx, ty = here.y - dy;
    if (!this.inBed(tx, ty)) return this.refuse(`That jog would leave the work area (the head is ${here.x.toFixed(1)} mm from the left and ${here.y.toFixed(1)} mm from the rear edge; the work area is ${this.bedW} x ${this.bedH} mm).`);
    const speed = Math.min(MAX_RAPID_SPEED, Math.max(1, feed / 60));
    if (!(await this.sendAll(this.moveSequence(speed, tx, ty)))) return this.refuse('The controller did not accept the move');
    this.log('tx', `Jog to X ${tx.toFixed(2)} Y ${ty.toFixed(2)} mm (laser off)`);
    return ok('Jog sent');
    } finally { this.release(); }
  }

  /** Move the head to a place saved earlier: the same checks and the same commands as a jog, but to an absolute position */
  async moveTo(x: number, y: number, feed: number): Promise<Result> {
    const bad = this.idleCheck();
    if (bad) return bad;
    if (![x, y, feed].every(Number.isFinite)) return this.refuse('Bad position');
    if (!(feed >= 1 && feed <= 10000)) return this.refuse('Speed must be 1 to 10000 mm/min');
    if (!this.inBed(x, y)) return this.refuse(`That position is outside the work area (${this.bedW} x ${this.bedH} mm)`);
    if (!(await this.acquire())) return this.refuse('Busy talking to the controller; try again');
    try {
      const here = await this.fresh();
      if (!here) return this.refuse('The controller did not answer');
      if (here.word & (BIT_RUNNING | BIT_MOVING)) return this.refuse('The controller is busy');
      const speed = Math.min(MAX_RAPID_SPEED, Math.max(1, feed / 60));
      if (!(await this.sendAll(this.moveSequence(speed, x, y)))) return this.refuse('The controller did not accept the move');
      this.log('tx', `Move to X ${x.toFixed(2)} Y ${y.toFixed(2)} mm (laser off)`);
      return ok('Moving to the saved position');
    } finally { this.release(); }
  }

  /**
   * Auto focus: the controller's own routine, started the way LightBurn's button does it, with the single command `D8 2E` and
   * nothing before it. The capture ends right there, so what the controller does (how far Z moves, how long it takes, what the
   * status word says) is NOT known. The driver waits up to 60 s, does not call silence lost contact, and ends the wait once Z has
   * stopped changing. Off unless DESIGN_RUIDA_Z=1.
   */
  async autoFocus(): Promise<Result> {
    if (!this.cfg.z) return no('Auto focus is switched off for Ruida: it has been seen from LightBurn but not tried from here (DESIGN_RUIDA_Z=1 turns it on, with the Z moves).', 'z-off');
    const bad = this.idleCheck();
    if (bad) return bad;
    if (!(await this.acquire())) return this.refuse('Busy talking to the controller; try again');
    try {
      const here = await this.fresh();
      if (!here) return this.refuse('The controller did not answer');
      if (here.word & (BIT_RUNNING | BIT_MOVING)) return this.refuse('The controller is busy');
      if (!(await this.send(Buffer.from([0xd8, 0x2e])))) return this.refuse('The controller did not accept Auto focus');
      this.settleUntil = Date.now() + 60_000; this.settleKind = 'focus'; this.settleStarted = Date.now(); this.settleLastZ = this.z;
      this.log('tx', 'Auto focus (the controller does it; Z changes by itself)');
      this.push();
      return ok('Auto focus started');
    } finally { this.release(); }
  }

  setOrigin(): Result { return no('A Ruida job starts where the head is when you press Start, so there is no work zero to set. Move the head to where the job should begin.', 'unsupported'); }
  goOrigin(): Result { return no('There is no work zero on a Ruida job; jobs start from the head position.', 'unsupported'); }
  /**
   * Home, exactly as LightBurn sent it on the owner's machine: the speed and zero power words every move starts with, then one
   * datagram `D0 29 89 89` followed by a rapid move to 0, 0. The controller then runs its homing (it took about 11 s and did not
   * answer reads while it ran) and the head ends at 0, 0. Off unless DESIGN_RUIDA_HOME=1: it has not been run from here.
   */
  async home(): Promise<Result> {
    if (!this.cfg.home) return no('Home is switched off for Ruida: it has been seen from LightBurn but not tried from here (DESIGN_RUIDA_HOME=1 turns it on).', 'home-off');
    const bad = this.idleCheck();
    if (bad) return bad;
    if (!(await this.acquire())) return this.refuse('Busy talking to the controller; try again');
    try {
      const here = await this.fresh();
      if (!here) return this.refuse('The controller did not answer');
      if (here.word & (BIT_RUNNING | BIT_MOVING)) return this.refuse('The controller is busy');
      const seq: number[][] = [
        [0xc9, 0x02, ...encSpeed(800 / 60)],
        [0xc6, 0x01, 0, 0], [0xc6, 0x21, 0, 0],
        [0xd0, 0x29, 0x89, 0x89, 0xd9, 0x10, 0x00, ...enc35(0), ...enc35(0)],
      ];
      if (!(await this.sendAll(seq))) return this.refuse('The controller did not accept Home');
      this.settleUntil = Date.now() + 60_000; this.settleKind = 'home'; this.settleStarted = Date.now();
      this.log('tx', 'Home (laser off)');
      this.push();
      return ok('Homing');
    } finally { this.release(); }
  }

  /**
   * Move Z by dz mm with the laser off: the speed and zero power words, then `D9 02` with the new height in micrometres
   * (absolute: LightBurn adds the step to the height it read). Seen in 1 mm steps at 250 mm/min. Off unless DESIGN_RUIDA_Z=1.
   * The controller's own limits for Z are not known here, so one step is at most 10 mm; which way is up is for the owner to confirm.
   */
  async jogZ(dz: number, feed: number): Promise<Result> {
    if (!this.cfg.z) return no('Z moves are switched off for Ruida: they have been seen from LightBurn but not tried from here (DESIGN_RUIDA_Z=1 turns them on).', 'z-off');
    const bad = this.idleCheck();
    if (bad) return bad;
    if (![dz, feed].every(Number.isFinite) || !dz) return this.refuse('Bad Z move');
    if (Math.abs(dz) > 10) return this.refuse('One Z step is at most 10 mm');
    if (!(feed >= 1 && feed <= 600)) return this.refuse('Z speed must be 1 to 600 mm/min');
    if (!(await this.acquire())) return this.refuse('Busy talking to the controller; try again');
    try {
      const word = await this.read(STATUS);
      const z = await this.read(POS_Z);
      if (word === null || z === null) return this.refuse('The controller did not answer');
      if (word & (BIT_RUNNING | BIT_MOVING)) return this.refuse('The controller is busy');
      const target = z + Math.round(dz * 1000);
      const seq: number[][] = [
        [0xc9, 0x02, ...encSpeed(feed / 60)],
        [0xc6, 0x01, 0, 0], [0xc6, 0x21, 0, 0],
        [0xd9, 0x02, 0x00, ...enc35(target)],
      ];
      if (!(await this.sendAll(seq))) return this.refuse('The controller did not accept the Z move');
      this.log('tx', `Z ${dz > 0 ? '+' : ''}${dz} mm (laser off)`);
      return ok('Moving Z');
    } finally { this.release(); }
  }

  unlock(): Result { return no('Nothing to unlock on a Ruida controller.', 'unsupported'); }
  async checkLaser(): Promise<LaserInfo> { return this.state().laser; }
  async enableLaserMode(): Promise<Result> { return no('Not applicable to a Ruida controller.', 'unsupported'); }

  // ---------- the job ----------
  loadJob(name: string, content: string): Result {
    if (!this.connected) return no('Not connected');
    if (this.jobActive()) return no('A job is running');
    let plan: RuidaPlan;
    try { plan = parsePlan(content); } catch (e) { return no(`The job was not accepted. ${(e as Error).message}`, 'invalid-job'); }
    const limits = this.limits();
    const check = checkPlan(plan, limits);
    if (!check.ok) return no(`The job was not accepted. ${check.error}`, 'invalid-job');
    let stream: Buffer;
    try { stream = writeJobStream(plan); } catch (e) { return no(`The job could not be written. ${(e as Error).message}`, 'invalid-job'); }
    const safe = name.replace(/[^\w .-]/g, '_').slice(0, 60) || 'laser-job';
    this.loaded = { name: safe, hash: fingerprint(content), lines: check.points, maxS: check.maxPower, stream, plan, box: planBox(plan)! };
    this.phase = 'loaded'; this.jobError = undefined;
    this.push();
    return ok(`Job ready: ${check.points} points, ${plan.layers.length} layer(s). Nothing is sent to the controller until you press Start.`);
  }

  private limits(head?: { x: number; y: number }): JobLimits {
    return { bedW: this.bedW, bedH: this.bedH, head, maxSpeed: this.cfg.maxSpeed, maxPower: this.cfg.maxPower, maxPoints: 2_000_000 };
  }

  async frame(feed: number, shape: 'box' | 'circle' = 'box', origin?: { x: number; y: number }): Promise<Result> {
    const bad = this.idleCheck();
    if (bad) return bad;
    if (this.opts.rotaryOn?.(this.target)) return this.refuse('Rotary is switched on for this laser. Rotary jobs are not sent yet: how the controller wants them (the Y axis, the rotary switch) has to be confirmed from a LightBurn capture first. Switch rotary off to run a flat job.', 'rotary-unverified');
    if (!this.loaded) return this.refuse('Send the job first: the frame is the outline of its moves');
    if (!(feed >= 1 && feed <= 10000)) return this.refuse('Frame speed must be 1 to 10000 mm/min');
    if (!(await this.acquire())) return this.refuse('Busy talking to the controller; try again');
    try {
    const here = await this.fresh();
    if (!here) return this.refuse('The controller did not answer');
    if (here.word & (BIT_RUNNING | BIT_MOVING)) return this.refuse('The controller is busy');
    const b = this.loaded.box;
    // from the head (Current position), or from a start point on the machine (Absolute coordinates, User origin: LightBurn sends the
    // same moves with the box placed there; the head first goes to the box's corner and, in the end, back to where it was)
    const base = origin ?? { x: here.x, y: here.y };
    const c = (x: number, y: number): [number, number] => [base.x + x, base.y + y];
    // in the order LightBurn sends the four corners: down the left side first, then across, up and back
    // and back to where the head started, so the job still starts from the place the owner chose (LightBurn's own frame
    // was only seen on a job whose box began at the head, so what it does otherwise is not known)
    let pts = [c(b.minX, b.maxY), c(b.maxX, b.maxY), c(b.maxX, b.minY), c(b.minX, b.minY), [here.x, here.y] as [number, number]];
    if (origin) pts = [c(b.minX, b.minY), ...pts.slice(0, 4), [here.x, here.y]];
    let swept = b; // what the frame sweeps over, checked against the bed
    if (shape === 'circle') {
      // a circle round the job, through its four corners; it starts at the point nearest the head and ends back at the head
      const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2, r = Math.hypot(b.maxX - b.minX, b.maxY - b.minY) / 2;
      swept = { minX: cx - r, maxX: cx + r, minY: cy - r, maxY: cy + r };
      const a0 = Math.atan2(-cy, -cx); // from the circle's centre toward the head (the head is the job's zero)
      const N = 48;
      pts = [...Array.from({ length: N + 1 }, (_, i) => c(cx + r * Math.cos(a0 + (i / N) * 2 * Math.PI), cy + r * Math.sin(a0 + (i / N) * 2 * Math.PI))), [here.x, here.y] as [number, number]];
    }
    const over = reachText(reach(swept, base, this.bedW, this.bedH));
    if (over) return this.refuse(`From ${origin ? 'the start point' : 'where the head is now'} (${base.x.toFixed(1)} mm from the left, ${base.y.toFixed(1)} mm from the rear edge) the frame would run ${over}. ${origin ? 'Change the start point (the nine-dot picker or the origin) so the job fits.' : "Move the head, or change the job's start point (the nine-dot picker) so the job extends the other way."}`);
    const speed = Math.min(MAX_RAPID_SPEED, Math.max(1, feed / 60));
    const seq: number[][] = [
      [0xc9, 0x02, ...encSpeed(0)],
      [0xc6, 0x01, 0, 0], [0xc6, 0x02, 0, 0], [0xc6, 0x21, 0, 0], [0xc6, 0x22, 0, 0], // laser power 0 before anything moves
      [0xc9, 0x02, ...encSpeed(speed)],
      ...pts.map(([x, y]) => [0xd9, 0x10, 0x00, ...enc35(toUm(x)), ...enc35(toUm(y))]),
      [0xc9, 0x02, ...encSpeed(0)],
    ];
    if (!(await this.sendAll(seq))) return this.refuse('The controller did not accept the frame');
    this.log('tx', `Frame${shape === 'circle' ? ' (circle)' : ''} (laser off): ${(b.maxX - b.minX).toFixed(1)} x ${(b.maxY - b.minY).toFixed(1)} mm from ${origin ? `X ${origin.x.toFixed(1)} Y ${origin.y.toFixed(1)}` : 'the head'}`);
    return ok('Framing');
    } finally { this.release(); }
  }

  async start(hash: string): Promise<Result> {
    const bad = this.idleCheck();
    if (bad) return bad;
    if (this.opts.rotaryOn?.(this.target)) return this.refuse('Rotary is switched on for this laser. Rotary jobs are not sent yet: how the controller wants them (the Y axis, the rotary switch) has to be confirmed from a LightBurn capture first. Switch rotary off to run a flat job.', 'rotary-unverified');
    const job = this.loaded;
    if (!job) return this.refuse('Send the job to the laser first', 'no-job');
    if (job.hash !== hash) return this.refuse('The job on the machine is not the one on screen. Send it again.', 'stale-job');
    if (!(await this.acquire())) return this.refuse('Busy talking to the controller; try again');
    try {
    const here = await this.fresh();
    if (!here) return this.refuse('The controller did not answer', 'no-answer');
    if (here.word & (BIT_RUNNING | BIT_MOVING)) return this.refuse('The controller is busy', 'not-idle');
    // the work area, from where the head really is now
    const check = checkPlan(job.plan, this.limits({ x: here.x, y: here.y }));
    if (!check.ok) return this.refuse(check.error!, 'out-of-bed');
    this.abort = false;
    this.phase = 'starting'; this.startedAt = Date.now(); this.endedAt = 0; this.sawRunning = false; this.jobError = undefined;
    this.push();
    try {
      const parts: Buffer[] = [];
      for (let i = 0; i < job.stream.length; i += 1000) parts.push(buildDatagram(job.stream.subarray(i, i + 1000)));
      this.log('tx', `Sending the job: ${job.stream.length} bytes in ${parts.length} datagram(s)`);
      for (const [i, dg] of parts.entries()) {
        if (this.abort) throw new Error('stopped while sending');
        if (dg.length > MAX_DATAGRAM) throw new Error('datagram too long');
        const p = this.expect('ack');
        this.sock?.send(dg, this.port, this.host);
        // no retry: a repeated datagram would put the same bytes into the job twice
        if (!(await p).ok) throw new Error(`the controller did not accept part ${i + 1} of ${parts.length}`);
      }
    } catch (e) {
      this.phase = 'error'; this.jobError = `Sending the job failed: ${(e as Error).message}. Stop was sent.`;
      this.log('err', this.jobError);
      await this.stopNow('upload failed');
      this.push();
      return this.refuse(this.jobError, 'upload-failed');
    }
    this.push();
    return ok('Job sent and started');
    } finally { this.release(); }
  }

  async pause(): Promise<Result> {
    if (!this.capabilities.pause) return no('Pause is switched off for Ruida: it is not yet proven that the laser stays off while paused (DESIGN_RUIDA_PAUSE=1 turns it on). Use Stop.', 'pause-off');
    if (this.phase !== 'running') return no('No job is running');
    if (!(await this.send(Buffer.from([0xd8, 0x02])))) return no('The controller did not accept Pause');
    return ok('Paused');
  }

  async resume(): Promise<Result> {
    if (!this.capabilities.pause) return no('Pause is switched off for Ruida.', 'pause-off');
    if (this.phase !== 'paused') return no('The job is not paused');
    if (!(await this.send(Buffer.from([0xd8, 0x03])))) return no('The controller did not accept Resume');
    return ok('Resumed');
  }

  /** Stop, sent three times so one lost datagram cannot leave the job running. Never waits behind other traffic. */
  private async stopNow(why: string): Promise<void> {
    this.abort = true;
    this.log('tx', `Stop (${why})`);
    for (let i = 0; i < 3; i++) {
      this.rawSend(Buffer.from([0xd8, 0x01]));
      await new Promise((r) => setTimeout(r, 40));
    }
  }

  async stop(): Promise<Result> {
    if (!this.connected) return no('Not connected');
    // the job is over as far as we are concerned the moment Stop is asked for, so a poll that sees it end meanwhile is not "done"
    if (this.jobActive()) { this.phase = this.loaded ? 'loaded' : 'none'; this.endedAt = Date.now(); }
    await this.stopNow('requested');
    // The controller takes the head back to where the job started and says "running" until it gets there (about 2 s in the
    // first real test), so wait for that rather than for an instant answer.
    let stopped = false;
    if (await this.acquire(10000)) {
      try {
        for (let i = 0; i < 80 && !stopped; i++) {
          const w = await this.read(STATUS);
          if (w !== null) { this.word = w; stopped = (w & BIT_RUNNING) === 0; }
          if (!stopped) await new Promise((r) => setTimeout(r, 100));
        }
      } finally { this.release(); }
    }
    this.push();
    return stopped
      ? ok('Stopped. The laser is off. The controller takes the head back to where the job started.')
      : no('Stop was sent, but the controller still reports a job running after 8 seconds. Use the emergency stop on the machine.', 'stop-unconfirmed');
  }

  async reset(): Promise<Result> { return this.stop(); }
}
