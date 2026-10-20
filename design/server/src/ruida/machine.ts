// A simulated Ruida controller, built only from recorded traffic of the owner's machine (firmware RDLC-V1.54.08).
// It is for testing the driver and the Design Laser panel without a machine. It is NOT a model of the real controller:
// where the captures say nothing the simulator does the safe, obvious thing and says so in `ASSUMED` below.
//
// handleDatagram() takes one UDP datagram as the controller would receive it and returns the datagrams it would send back.
// advance() moves simulated time forward; the UDP wrapper (udp.ts) calls it from a timer, tests call it directly.
import { ACK, NAK, DEFAULT_KEY, commandLength, dec35, dec35s, parseDatagram, scramble, enc35, toUm } from './codec.js';
import { MEMORY, MEM_BED_X, MEM_BED_Y, MEM_STATUS, MEM_X, MEM_Y, MEM_Z } from './memory.js';
import { parseJobStream } from './parse.js';
import type { RuidaPlan } from './plan.js';

/**
 * Things the captures do not show, so the simulator decides them. A driver must never rely on any of these being true
 * of the real machine until they have been measured on it:
 *  - a datagram with a bad checksum is answered with NAK (CF); the real reply was never seen
 *  - pause switches the laser off; stop switches the laser off at once (seen: the head then goes back to the job's start)
 *  - a job (or rapid move) that would leave the bed is refused instead of driving into a limit
 *  - a job starts running when its last byte (D7) has arrived, after its file sum checked out
 *  - jog moves are ignored while a job runs; a move is made at the speed set (C9 02) when it arrived, and refused at speed 0
 *  - the status word: the values below were seen, bit meanings are inferred (see STATUS)
 *  - travel moves inside a job run at RAPID_SPEED; burning runs at the layer speed with the layer's max power
 */
export const ASSUMED = ['nak-on-bad-checksum', 'pause-laser-off', 'stop-laser-off', 'refuse-out-of-bed', 'start-at-eof', 'ignore-rapid-while-running', 'rapid-speed', 'autofocus-moves-z', 'speed-zero-is-default'] as const;

/**
 * Status words (address 0400) seen in the captures. Bit meanings are inferred from when the words appeared, not documented:
 *   0x00000001 a job is running            (set in every running word, clear before and after)
 *   0x00000002 paused                      (set in the paused words 0x10403 / 0x410403)
 *   0x00000004 set while a line layer ran (0x10405) and clear while a fill layer ran (0x10401): meaning unknown
 *   0x00000200 a job has finished or been stopped (0x10600 persists after the job until the next one starts)
 *   0x00010400 present from the first job on, until power-off (probably "a job is loaded")
 *   0x01020000 the head is moving with no job (a frame or a jog)
 *   0x00400000 / 0x00800000 seen briefly after pause and after resume; 0x00500000 once, about 12 s after a stop in the second capture
 *   After Stop the word stays 'running' (0x10401) for about 2 s while the head goes back to the job's start, then 0x10600.
 *   After a job ends by itself the head also goes back to the start, with 0x10405 for about a second (so 0x4 may mean "returning"), then 0x10600
 */
export const STATUS = {
  idle: 0x0,
  moving: 0x01020000,
  runningLine: 0x10405,
  runningFill: 0x10401,
  paused: 0x10403,
  finished: 0x10600,
  stopped: 0x510600,
} as const;
const RAPID_SPEED = 300; // mm/s
const DEFAULT_RAPID = 100; // mm/s when the speed word says 0 (the real value is not known)
const HOME_SPEED = 20; // mm/s: the real home took about 11 s (it seeks the limits, so this is only a stand-in)
const RETURN_SPEED = 150; // mm/s: the head came back 277 mm in under 2.5 s in the first real test

export interface Output { laserOn: boolean; /** percent */ power: number; air: boolean }
export interface SimEvent {
  t: number;
  kind: 'home' | 'focus' | 'z-move' | 'job-start' | 'job-end' | 'job-rejected' | 'pause' | 'resume' | 'stop' | 'rapid' | 'rapid-refused' | 'laser' | 'unknown-command' | 'bad-checksum' | 'busy';
  detail?: string;
  x?: number; y?: number; laserOn?: boolean; power?: number; air?: boolean;
}

export interface MachineOptions {
  bedW?: number; // mm
  bedH?: number;
  /** where the head starts, mm from the machine's rear-left corner */
  start?: { x: number; y: number };
  key?: number;
}

interface Seg { mode: 'line' | 'fill'; x0: number; y0: number; x1: number; y1: number; speed: number; burn: boolean; power: number; air: boolean; len: number }

export class RuidaMachine {
  readonly bedW: number;
  readonly bedH: number;
  readonly key: number;
  readonly events: SimEvent[] = [];
  /** 'returning': after Stop the head goes back to where the job started, and the status word still says running */
  state: 'idle' | 'running' | 'paused' | 'returning' = 'idle';
  head: { x: number; y: number };
  out: Output = { laserOn: false, power: 0, air: false };
  time = 0;
  /** every command the controller understood, in order, as unscrambled bytes (for tests) */
  readonly received: Buffer[] = [];

  private carry: Buffer = Buffer.alloc(0);
  private file: Buffer[] | null = null;
  private liveSpeed = 100; // mm/s from the last C9 02
  /** Z in micrometres (the owner's controller reads 3,000,000 at rest) and where it is going */
  z = 3_000_000;
  private zTarget: number | null = null;
  /** rapid moves still to make (a frame sends four in a row) */
  private rapids: { x: number; y: number; speed: number }[] = [];
  private segs: Seg[] = [];
  private segIdx = 0;
  private segPos = 0; // mm into the current segment
  private jobPlan: RuidaPlan | null = null;
  private jobOrigin = { x: 0, y: 0 };
  private lastRunning: number = STATUS.runningLine;
  /** the word shown while the head goes back to the job's start: 0x10405 after a normal end (seen in the sixth capture), the running word after Stop */
  private returnWord: number = STATUS.runningLine;
  private runsDone = 0;
  /** after a job ends the status word keeps saying so until the next job starts */
  private after: 'none' | 'finished' | 'stopped' = 'none';

  constructor(opts: MachineOptions = {}) {
    this.bedW = opts.bedW ?? 1000;
    this.bedH = opts.bedH ?? 600;
    this.head = { ...(opts.start ?? { x: 152.14, y: 14.511 }) };
    this.key = opts.key ?? DEFAULT_KEY;
  }

  get jobsFinished() { return this.runsDone; }
  get plan() { return this.jobPlan; }

  private log(e: Omit<SimEvent, 't'>) { this.events.push({ t: this.time, ...e }); }

  private status(): number {
    if (this.state === 'paused') return STATUS.paused;
    if (this.state === 'returning') return this.returnWord;
    if (this.state === 'running') return (this.lastRunning = this.segs[this.segIdx]?.mode === 'fill' ? STATUS.runningFill : STATUS.runningLine);
    if (this.rapids.length) return STATUS.moving;
    return this.after === 'stopped' ? STATUS.stopped : this.after === 'finished' ? STATUS.finished : STATUS.idle;
  }

  /** One datagram in; the datagrams sent back out (an ACK first, then one reply per read) */
  handleDatagram(dg: Uint8Array): Buffer[] {
    const p = parseDatagram(dg, this.key);
    if (!p.ok) {
      this.log({ kind: 'bad-checksum' });
      return [scramble(Buffer.from([NAK]), this.key)];
    }
    const replies: Buffer[] = [scramble(Buffer.from([ACK]), this.key)];
    this.carry = Buffer.concat([this.carry, p.data]);
    for (;;) {
      if (!this.carry.length) break;
      // Home, as LightBurn sends it: D0 29 89 89 (the two 0x89 bytes are part of it, which no other command does)
      const n = this.carry[0] === 0xd0 && this.carry[1] === 0x29 ? (this.carry.length >= 4 ? 4 : 0) : commandLength(this.carry, 0);
      if (n === null) {
        this.log({ kind: 'unknown-command', detail: this.carry.subarray(0, 4).toString('hex') });
        // skip to the next command byte
        let i = 1;
        while (i < this.carry.length && this.carry[i] < 0x80) i++;
        this.carry = this.carry.subarray(i);
        continue;
      }
      if (n === 0 || this.carry.length < n) break; // the command continues in the next datagram
      const cmd = this.carry.subarray(0, n);
      this.carry = this.carry.subarray(n);
      const r = this.execute(Buffer.from(cmd));
      if (r) replies.push(r);
    }
    return replies;
  }

  private value(addr: string): number {
    if (addr === MEM_STATUS) return this.status();
    if (addr === MEM_X || addr === '0424') return toUm(this.head.x);
    if (addr === MEM_Y || addr === '0434') return toUm(this.head.y);
    if (addr === MEM_BED_X) return toUm(this.bedW);
    if (addr === MEM_BED_Y) return toUm(this.bedH);
    if (addr === MEM_Z) return Math.round(this.z);
    return MEMORY[addr] ?? 0;
  }

  /** Home: the head goes to the machine's origin (seen: the position reads 0, 0 afterwards, and the move takes about 11 s) */
  private homeNow() {
    if (this.state !== 'idle') { this.log({ kind: 'busy', detail: 'home ignored while a job is active' }); return; }
    this.rapids = [{ x: 0, y: 0, speed: HOME_SPEED }];
    this.log({ kind: 'home' });
  }

  /** Auto focus (D8 2E): what the real controller does was not captured (LightBurn sent it and the capture ends); the stand-in moves Z down 1 mm */
  private focusNow() {
    if (this.state !== 'idle') { this.log({ kind: 'busy', detail: 'focus ignored while a job is active' }); return; }
    this.zTarget = this.z - 1000;
    this.log({ kind: 'focus' });
  }

  /** Z: an absolute move in micrometres at the live speed */
  private zMove(um: number) {
    if (this.state !== 'idle') { this.log({ kind: 'busy', detail: 'z move ignored while a job is active' }); return; }
    this.zTarget = um;
    this.log({ kind: 'z-move', detail: `z ${(um / 1000).toFixed(3)} mm` });
  }

  private execute(c: Buffer): Buffer | null {
    this.received.push(c);
    const op = c[0], sub = c[1];
    // a job file: from D8 12 up to D7, collected whole and checked before anything runs
    if (op === 0xd8 && sub === 0x12) { this.file = [c]; return null; }
    if (this.file) {
      this.file.push(c);
      if (op === 0xd7) {
        const bytes = Buffer.concat(this.file);
        this.file = null;
        this.startFile(bytes);
      }
      return null;
    }
    switch (op) {
      case 0xda:
        if (sub === 0x00) {
          const addr = c.subarray(2, 4).toString('hex');
          return scramble(Buffer.from([0xda, 0x01, c[2], c[3], ...enc35(this.value(addr))]), this.key);
        }
        return null;
      case 0xd8:
        if (sub === 0x01) this.stop();
        else if (sub === 0x02) this.pause();
        else if (sub === 0x03) this.resume();
        else if (sub === 0x2e) this.focusNow();
        return null;
      case 0xc9: if (sub === 0x02) this.liveSpeed = dec35(c, 2) / 1000; return null;
      case 0xc6: return null; // live power settings: nothing fires without a job
      case 0xd0:
        if (sub === 0x29) this.homeNow();
        return null;
      case 0xd9:
        if (sub === 0x10) this.rapidMove(dec35s(c, 3) / 1000, dec35s(c, 8) / 1000);
        else if (sub === 0x02) this.zMove(dec35s(c, 3));
        return null;
      default: return null;
    }
  }

  private inBed(x: number, y: number) { return x >= 0 && y >= 0 && x <= this.bedW && y <= this.bedH; }

  private rapidMove(x: number, y: number) {
    if (this.state !== 'idle') { this.log({ kind: 'busy', detail: 'rapid move ignored while a job is active' }); return; }
    if (!this.inBed(x, y)) { this.log({ kind: 'rapid-refused', x, y }); return; }
    // LightBurn sends speed 0 before some moves (the way to the frame's first corner, the way back): taken as the controller's own rapid speed
    this.rapids.push({ x, y, speed: this.liveSpeed > 0 ? this.liveSpeed : DEFAULT_RAPID });
    this.log({ kind: 'rapid', x, y });
  }

  private startFile(bytes: Buffer) {
    if (this.state !== 'idle') { this.log({ kind: 'busy', detail: 'job refused: another job is active' }); return; }
    let plan: RuidaPlan;
    try { plan = parseJobStream(bytes).plan; } catch (e) { this.log({ kind: 'job-rejected', detail: (e as Error).message }); return; }
    // job space is relative to where the head stands now (D8 12: reference point = current position)
    const ox = this.head.x, oy = this.head.y;
    const segs: Seg[] = [];
    let cx = this.head.x, cy = this.head.y;
    for (const l of plan.layers) {
      for (const p of l.points) {
        const x = ox + p.x, y = oy + p.y;
        if (!this.inBed(x, y)) { this.log({ kind: 'job-rejected', detail: `a point at ${x.toFixed(1)}, ${y.toFixed(1)} mm is outside the bed` }); return; }
        const len = Math.hypot(x - cx, y - cy);
        segs.push({ mode: l.mode, x0: cx, y0: cy, x1: x, y1: y, speed: p.burn ? l.speed : RAPID_SPEED, burn: p.burn, power: l.maxPower, air: l.air, len });
        cx = x; cy = y;
      }
    }
    this.segs = segs; this.segIdx = 0; this.segPos = 0; this.jobPlan = plan; this.rapids = []; this.jobOrigin = { x: ox, y: oy };
    this.state = 'running';
    this.after = 'none';
    this.log({ kind: 'job-start', detail: `${plan.layers.length} layer(s)` });
  }

  private setOut(o: Output, why?: string) {
    if (o.laserOn === this.out.laserOn && o.power === this.out.power && o.air === this.out.air) return;
    this.out = o;
    this.log({ kind: 'laser', laserOn: o.laserOn, power: o.power, air: o.air, x: this.head.x, y: this.head.y, detail: why });
  }

  pause() {
    if (this.state !== 'running') return;
    this.state = 'paused';
    this.setOut({ laserOn: false, power: 0, air: this.out.air }, 'pause');
    this.log({ kind: 'pause' });
  }

  resume() {
    if (this.state !== 'paused') return;
    this.state = 'running';
    this.log({ kind: 'resume' });
  }

  stop() {
    this.rapids = [];
    if (this.state === 'idle' || this.state === 'returning') return;
    this.status(); // remember which running word was showing
    this.returnWord = this.lastRunning;
    this.segs = []; this.segIdx = 0;
    this.setOut({ laserOn: false, power: 0, air: false }, 'stop');
    this.log({ kind: 'stop' });
    // seen on the real controller: after Stop the head goes back to where the job started, and "running" stays until it is there
    this.state = 'returning';
    this.rapids = [{ x: this.jobOrigin.x, y: this.jobOrigin.y, speed: RETURN_SPEED }];
  }

  /** Move simulated time forward by `dt` seconds */
  advance(dt: number) {
    let left = dt;
    this.time += dt;
    while (this.rapids.length && (this.state === 'idle' || this.state === 'returning') && left > 0) {
      const to = this.rapids[0];
      const d = Math.hypot(to.x - this.head.x, to.y - this.head.y);
      const step = to.speed * left;
      if (step >= d) { left -= d / to.speed; this.head = { x: to.x, y: to.y }; this.rapids.shift(); }
      else { this.head.x += ((to.x - this.head.x) / d) * step; this.head.y += ((to.y - this.head.y) / d) * step; left = 0; }
    }
    if (this.zTarget !== null) {
      const dz = this.zTarget - this.z, stepUm = this.liveSpeed * 1000 * dt;
      if (Math.abs(dz) <= stepUm) { this.z = this.zTarget; this.zTarget = null; } else this.z += Math.sign(dz) * stepUm;
    }
    if (this.state === 'returning' && !this.rapids.length) { this.state = 'idle'; this.after = 'finished'; }
    while (this.state === 'running' && left > 0) {
      const s = this.segs[this.segIdx];
      if (!s) { this.finish(); break; }
      this.setOut(s.burn ? { laserOn: true, power: s.power, air: s.air } : { laserOn: false, power: 0, air: s.air });
      const remain = s.len - this.segPos;
      const can = s.speed * left;
      if (can >= remain) {
        left -= s.speed > 0 ? remain / s.speed : left;
        this.head = { x: s.x1, y: s.y1 };
        this.segIdx++; this.segPos = 0;
      } else {
        this.segPos += can; left = 0;
        const f = s.len ? this.segPos / s.len : 1;
        this.head = { x: s.x0 + (s.x1 - s.x0) * f, y: s.y0 + (s.y1 - s.y0) * f };
      }
      if (this.segIdx >= this.segs.length) { this.finish(); break; }
    }
  }

  private finish() {
    this.segs = [];
    this.setOut({ laserOn: false, power: 0, air: false }, 'end');
    this.runsDone++;
    this.log({ kind: 'job-end' });
    // seen on the real controller: when a job ends by itself the head goes back to where the job started, with status 0x10405 on the way
    this.state = 'returning';
    this.returnWord = STATUS.runningLine;
    this.rapids = [{ x: this.jobOrigin.x, y: this.jobOrigin.y, speed: RETURN_SPEED }];
  }

  /** Run simulated time forward until the machine is idle again (or `maxSeconds` pass) */
  runToEnd(maxSeconds = 3600, step = 0.05) {
    for (let t = 0; t < maxSeconds && (this.state !== 'idle' || this.rapids.length); t += step) this.advance(step);
  }
}
