import { EventEmitter } from 'node:events';
import type {
  ConnectionInfo, HeightMap, JobInfo, LevelSummary, LogKind, LogLine, MachineStatus, ClientMessage, PcbConfig, SpindleCommand, SpindleConfig, Vec3,
} from '../../shared/protocol.js';
import { SPINDLE_COMMANDS, defaultPcb, defaultSpindle, emptyJob, emptyStatus } from '../../shared/protocol.js';
import { GRBL_ALARMS, GRBL_ERRORS, cleanGcode, parseStatus } from './parser.js';
import type { Transport } from './transport.js';
import { GcodeError, levelProgram } from './gcode.js';
import { analyzeProgram } from '../../shared/toolpath.js';
import { compileMacro } from './macros.js';

/** GRBL serial RX buffer is 128 bytes; keep one spare. FluidNC behaves the same. */
const RX_BUFFER = 127;
const POLL_MS = 200;
/** Largest single Z jog accepted from any client (protects the wasteboard). */
export const MAX_Z_JOG = 20;

export interface AckResult { ok: boolean; error?: string }
/**
 * Is this file already levelled? The header comment DemonX writes is the reliable
 * sign (it survives renaming); a ".leveled." file name catches older exports.
 */
export function detectLeveled(name: string, lines: string[]): { source: 'header' | 'filename'; info?: string } | undefined {
  for (const l of lines.slice(0, 40)) {
    const m = /^\s*\(\s*DemonX autolevel v\d+:?\s*(.*?)\s*\)\s*$/i.exec(l);
    if (m) return { source: 'header', info: m[1] || undefined };
  }
  if (/\.leveled\./i.test(name)) return { source: 'filename' };
  return undefined;
}

interface Pending { len: number; job: boolean; resolve?: (r: AckResult) => void }
interface Queued { line: string; resolve?: (r: AckResult) => void; quiet?: boolean }
export interface ProbeHit { pos: Vec3; success: boolean }

const OVERRIDE_BYTES: Record<string, Record<string, number>> = {
  feed: { reset: 0x90, plus10: 0x91, minus10: 0x92, plus1: 0x93, minus1: 0x94 },
  rapid: { reset: 0x95, half: 0x96, quarter: 0x97 },
  spindle: { reset: 0x99, plus10: 0x9a, minus10: 0x9b, plus1: 0x9c, minus1: 0x9d },
};

/**
 * Owns the single connection to the machine. Everything that reaches the
 * controller goes through here so all browser clients share one consistent
 * state. Uses GRBL character-counting streaming for jobs.
 *
 * Events: 'status', 'job', 'connection', 'log', 'prb' (ProbeHit), 'alarm' (code), 'reset'
 */
export class GrblController extends EventEmitter {
  status: MachineStatus = emptyStatus();
  job: JobInfo = emptyJob();
  connection: ConnectionInfo = { connected: false, target: '' };
  readonly logBuffer: LogLine[] = [];

  private transport?: Transport;
  private rx = '';
  private poll?: NodeJS.Timeout;
  private pending: Pending[] = [];
  private used = 0;
  private manualQueue: Queued[] = [];
  /** When set, client commands that could move the machine are refused (e.g. mid-probe). */
  lock?: string;
  private jobLines: string[] = [];
  /** The program as loaded from file, kept so autolevel can be applied or undone */
  private jobSource?: { name: string; content: string; alreadyLeveled: boolean };
  /** Comment line(s) written at the top of a levelled program when it is downloaded */
  private levelHeader: string[] = [];
  /** Supplies the current height map (set by the server) */
  heightMap?: () => HeightMap | null;
  private jobIndex = 0;
  private stopping = false;
  /** While a settings command runs, every reply line other than status goes here instead of the console log */
  private capture?: string[];

  // ---------- connection ----------
  async connect(transport: Transport, target: string) {
    if (this.transport) await this.disconnect();
    this.transport = transport;
    transport.on('data', (d: string) => this.onData(d));
    transport.on('error', (e: Error) => this.log('err', `Connection error: ${e.message}`));
    transport.on('close', () => this.onClosed());
    await transport.open();
    this.connection = { connected: true, target, homeReminder: true };
    this.status = { ...emptyStatus(), state: 'Idle' };
    this.emit('connection', this.connection);
    this.emit('status', this.status);
    this.log('sys', `Connected to ${target}`);
    this.poll = setInterval(() => this.transport?.write('?'), POLL_MS);
    // Most boards print a banner when the port opens, which names the firmware. One that does not (the board was not reset by
    // opening the port) is asked instead, a moment later.
    clearTimeout(this.firmwareTimer);
    this.firmwareTimer = setTimeout(() => void this.askFirmware(), this.firmwareAskMs);
  }

  private firmwareTimer?: NodeJS.Timeout;
  firmwareAskMs = 2500;

  /** Ask the controller for its version ($I) when no banner has named it yet */
  async askFirmware() {
    if (!this.connection.connected || this.connection.firmware || this.job.state === 'running' || this.job.state === 'paused') return;
    const r = await this.runCommand('$I', 5000);
    const ver = r.lines.map((l) => /^\[VER:(.*?):?\]$/.exec(l.trim())?.[1]).find(Boolean);
    if (!ver || !this.connection.connected || this.connection.firmware) return;
    this.connection = { ...this.connection, firmware: ver };
    this.emit('connection', this.connection);
  }

  async disconnect() {
    const t = this.transport;
    if (!t) return;
    this.transport = undefined;
    await t.close().catch(() => {});
    this.onClosed(true);
  }

  private onClosed(manual = false) {
    clearTimeout(this.firmwareTimer);
    if (this.poll) clearInterval(this.poll);
    this.poll = undefined;
    this.transport = undefined;
    this.abortQueued('Connection lost');
    this.rx = '';
    if (this.job.state === 'running' || this.job.state === 'paused') {
      this.failJob('Connection lost during job');
    }
    if (this.connection.connected) this.log(manual ? 'sys' : 'err', 'Disconnected');
    this.connection = { connected: false, target: this.connection.target };
    this.status = emptyStatus();
    this.emit('connection', this.connection);
    this.emit('status', this.status);
  }

  // ---------- incoming ----------
  private onData(chunk: string) {
    this.rx += chunk;
    let i: number;
    while ((i = this.rx.indexOf('\n')) >= 0) {
      const raw = this.rx.slice(0, i).replace(/\s+$/, '');
      const line = raw.trim();
      this.rx = this.rx.slice(i + 1);
      if (line) this.onLine(line, raw);
      else if (this.capture) this.capture.push('');   // blank lines matter in a file being shown
    }
  }

  private onLine(line: string, raw = line) {
    if (this.capture && !line.startsWith('<') && line !== 'ok' && !/^Grbl |^\[MSG:.*FluidNC/i.test(line)) {   // ([VER: is the answer to $I here, not a reboot banner)
      this.capture.push(raw);   // (indentation kept: a config file is YAML) (an error: line is also handled below, so the command is still acknowledged)
      if (!line.startsWith('error:') && !line.startsWith('ALARM:')) return;
    }
    if (line.startsWith('<')) {
      const s = parseStatus(line, this.status);
      if (s) {
        this.status = s;
        this.emit('status', s);
        this.checkJobDone();
      }
      return;
    }
    if (line === 'ok') {
      this.log('rx', line);
      this.ack(false);
    } else if (line.startsWith('error:')) {
      const code = Number(line.slice(6));
      this.log('err', `${line}${GRBL_ERRORS[code] ? ` (${GRBL_ERRORS[code]})` : ''}`);
      this.ack(true);
    } else if (line.startsWith('ALARM:')) {
      const code = Number(line.slice(6));
      this.log('err', `${line}${GRBL_ALARMS[code] ? ` (${GRBL_ALARMS[code]})` : ''}`);
      if (this.job.state === 'running' || this.job.state === 'paused') this.failJob(`Alarm: ${line}`);
      this.emit('alarm', code);
    } else if (line.startsWith('[PRB:')) {
      this.log('rx', line);
      const m = /^\[PRB:([^:\]]*):(\d)\]$/.exec(line);
      if (m) {
        const [x = 0, y = 0, z = 0] = m[1].split(',').map(Number);
        this.emit('prb', { pos: { x, y, z }, success: m[2] === '1' } satisfies ProbeHit);
      }
    } else if (/^Grbl |^\[MSG:.*FluidNC|^\[VER:/i.test(line)) {
      // banner after (re)boot/reset: controller RX buffer is empty again
      this.abortPending('Controller reset');
      this.emit('reset');
      this.connection = { ...this.connection, firmware: line };
      this.emit('connection', this.connection);
      this.log('rx', line);
      this.pump();
    } else {
      this.log('rx', line);
    }
  }

  private ack(isError: boolean) {
    const p = this.pending.shift();
    if (!p) return;
    this.used -= p.len;
    p.resolve?.({ ok: !isError, error: isError ? 'controller error' : undefined });
    if (p.job) {
      this.job = { ...this.job, doneLines: this.job.doneLines + 1 };
      if (isError) {
        this.failJob(`Error on line ${this.job.doneLines}: ${this.jobLines[this.job.doneLines - 1]}`);
        return;
      }
      this.emitJob();
      // Completion is judged only from a status report that arrives after the
      // last ok; an Idle report from before it may predate the queued motion.
    }
    this.pump();
  }

  // ---------- sending ----------
  /** Queue a single line (goes ahead of job lines). */
  sendLine(line: string) {
    if (!this.connection.connected) return this.log('err', 'Not connected');
    const l = line.trim();
    if (!l) return;
    if (this.lock) return this.log('err', `Blocked: ${this.lock}`);
    if (l.startsWith('$J=') === false && (this.job.state === 'running' || this.job.state === 'paused')) {
      return this.log('err', 'Job in progress: command blocked');
    }
    if (/^\$H/i.test(l) && this.pcbConfig().enabled) return this.log('err', 'PCB mode is on: turn it off to home the machine');
    // Homing or unlocking, by the buttons or typed in the console, ends the reminder to do so
    if (/^\$[HX]$/i.test(l) && this.connection.homeReminder) {
      this.connection = { ...this.connection, homeReminder: false };
      this.emit('connection', this.connection);
    }
    this.manualQueue.push({ line: l });
    this.pump();
  }

  /** Why a held jog may not run right now, or null when it may (see jogHold.ts) */
  jogHoldBlocked(): string | null {
    if (!this.connection.connected) return 'Not connected';
    if (this.lock) return this.lock;
    if (this.job.state === 'running' || this.job.state === 'paused') return 'A job is running';
    if (this.status.state === 'Alarm' || this.status.state.startsWith('Door') || this.status.state === 'Home' || this.status.state === 'Check') return `The machine is in ${this.status.state}`;
    return null;
  }

  /** One short jog segment of a held jog: not shown in the console, which would fill with them */
  jogHoldSegment(line: string) {
    if (this.jogHoldBlocked()) return;
    this.manualQueue.push({ line, quiet: true });
    this.pump();
  }

  /**
   * Internal send for server-driven sequences (probing). Bypasses the client
   * lock. Resolves when the controller acknowledges the line; never rejects.
   */
  sendInternal(line: string): Promise<AckResult> {
    if (!this.connection.connected) return Promise.resolve({ ok: false, error: 'Not connected' });
    return new Promise((resolve) => {
      this.manualQueue.push({ line, resolve });
      this.pump();
    });
  }

  /** The spindle settings in force (the browser's choice of buttons is not trusted: the server decides what may be sent) */
  spindleConfig: () => SpindleConfig = defaultSpindle;
  /** The PCB mode setup in force (set by the server) */
  pcbConfig: () => PcbConfig = defaultPcb;

  /**
   * Send one line and collect everything the controller prints in reply until it answers ok or error.
   * For reading settings and config files. Bypasses the client lock like sendInternal; one at a time.
   */
  async runCommand(line: string, timeoutMs = 20_000): Promise<{ ok: boolean; lines: string[]; error?: string }> {
    if (!this.connection.connected) return { ok: false, lines: [], error: 'Not connected' };
    if (this.capture) return { ok: false, lines: [], error: 'Another settings command is still running' };
    const lines: string[] = [];
    this.capture = lines;
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<{ ok: false; error: string }>((resolve) => { timer = setTimeout(() => resolve({ ok: false, error: 'The controller did not answer in time' }), timeoutMs); });
      const ack = await Promise.race([this.sendInternal(line), timeout]);
      const err = lines.find((l) => l.startsWith('error:'));
      return { ok: ack.ok, lines: lines.filter((l) => !l.startsWith('error:')), error: ack.ok ? undefined : (err ?? ack.error) };
    } finally {
      clearTimeout(timer);
      this.capture = undefined;
    }
  }

  /** Resolve when the machine reports Idle; reject on alarm, disconnect or timeout. */
  waitIdle(timeoutMs = 180_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const done = (err?: Error) => {
        clearTimeout(timer);
        this.off('status', onStatus); this.off('connection', onConn);
        err ? reject(err) : resolve();
      };
      const onStatus = (s: MachineStatus) => {
        if (s.state === 'Idle') done();
        else if (s.state === 'Alarm') done(new Error('Machine in alarm'));
      };
      const onConn = (c: ConnectionInfo) => { if (!c.connected) done(new Error('Disconnected')); };
      const timer = setTimeout(() => done(new Error('Timed out waiting for machine to stop')), timeoutMs);
      this.on('status', onStatus); this.on('connection', onConn);
    });
  }

  /** Drop everything queued or in flight, settling any awaiting callers as failed. */
  private abortQueued(reason: string) {
    const q = this.manualQueue; this.manualQueue = [];
    q.forEach((e) => e.resolve?.({ ok: false, error: reason }));
    this.abortPending(reason);
  }

  private abortPending(reason: string) {
    const p = this.pending; this.pending = []; this.used = 0;
    p.forEach((e) => e.resolve?.({ ok: false, error: reason }));
  }

  realtime(byte: string | number) {
    if (!this.transport) return;
    this.transport.write(typeof byte === 'number' ? Buffer.from([byte]) : byte);
  }

  private pump() {
    if (!this.transport) return;
    for (;;) {
      let line: string | undefined;
      let isJob = false;
      let resolve: Queued['resolve'];
      let quiet = false;
      if (this.manualQueue.length) {
        line = this.manualQueue[0].line;
        resolve = this.manualQueue[0].resolve;
        quiet = !!this.manualQueue[0].quiet;
      } else if (this.job.state === 'running' && this.jobIndex < this.jobLines.length) {
        line = this.jobLines[this.jobIndex];
        isJob = true;
      }
      if (line === undefined) return;
      const len = line.length + 1;
      if (this.used + len > RX_BUFFER) return;
      if (isJob) { this.jobIndex++; this.job = { ...this.job, sentLines: this.jobIndex }; } else this.manualQueue.shift();
      this.pending.push({ len, job: isJob, resolve });
      this.used += len;
      this.transport.write(line + '\n');
      if (!quiet) this.log('tx', line);
      if (isJob) this.emitJob();
    }
  }

  // ---------- commands from clients ----------
  handle(msg: ClientMessage) {
    if (this.lock && !['hold', 'reset', 'jogCancel', 'override'].includes(msg.type)) {
      return this.log('err', `Blocked: ${this.lock}`);
    }
    switch (msg.type) {
      case 'send': return this.sendLine(msg.line);
      case 'jog': {
        if (this.job.state === 'running') return this.log('err', 'Cannot jog during a job');
        const dz = msg.dz ? Math.max(-MAX_Z_JOG, Math.min(MAX_Z_JOG, msg.dz)) : 0;
        if (msg.dz && dz !== msg.dz) this.log('sys', `Z jog limited to ${MAX_Z_JOG} mm`);
        const parts = [
          msg.dx ? `X${msg.dx}` : '', msg.dy ? `Y${msg.dy}` : '', dz ? `Z${dz}` : '',
        ].join('');
        if (!parts) return;
        return this.sendLine(`$J=G21G91${parts}F${msg.feed}`);
      }
      case 'jogCancel': return this.realtime(0x85);
      case 'home':
        if (this.pcbConfig().enabled) return this.log('err', 'PCB mode is on: turn it off to home the machine');
        return this.sendLine('$H');
      case 'unlock': return this.sendLine('$X');
      case 'goto': {
        if (!(msg.feed > 0 && msg.feed <= 10000)) return this.log('err', 'Invalid feed for go-to move');
        if (msg.target === 'z0') return this.sendLine(`G21G90G1Z0F${msg.feed}`);
        // Never drag the tool across the work below the surface
        if (this.status.wpos.z < -0.001) {
          return this.log('err', 'Raise Z to Z0 or above before going to XY0 (the tool is below the work surface)');
        }
        return this.sendLine(`G21G90G1X0Y0F${msg.feed}`);
      }
      case 'frame': return this.frame(msg.feed, msg.zFeed);
      case 'pcbHome': return void this.pcbHome();
      case 'spindle': return this.spindleCommand(msg.command, msg.rpm);
      case 'zero': {
        const axes = msg.axes.map((a) => `${a}0`).join('');
        return axes ? this.sendLine(`G10L20P0${axes}`) : undefined;
      }
      case 'reset': return this.softReset();
      case 'hold': return this.hold();
      case 'resume': return this.resume();
      case 'override': {
        const b = OVERRIDE_BYTES[msg.kind]?.[msg.action];
        return b !== undefined ? this.realtime(b) : undefined;
      }
      case 'jobLoad': return this.loadJob(msg.name, msg.content);
      case 'jobLevel': return this.levelJob(this.heightMap?.() ?? null);
      case 'jobRevert': return this.revertJob();
      case 'jobStart': return this.startJob();
      case 'jobPause': return this.hold();
      case 'jobResume': return this.resume();
      case 'jobStop': return this.stopJob();
    }
  }

  /**
   * Trace the bounding box of the loaded program (every move in it, rapids included) a few mm above the
   * current height, to check by eye that it fits the stock and the machine, then come back to where
   * the tool started. Refused unless the machine is idle and the tool is at or above the work surface.
   */
  private frame(feed: number, zFeed: number) {
    const LIFT = 5; // mm
    if (!(feed > 0 && feed <= 10000) || !(zFeed > 0 && zFeed <= 3000)) return this.log('err', 'Invalid feed for the frame move');
    if (this.job.state === 'running' || this.job.state === 'paused') return this.log('err', 'Cannot frame during a job');
    if (this.status.state !== 'Idle') return this.log('err', `Frame needs the machine Idle (it is ${this.status.state})`);
    const b = this.job.extents?.all;
    if (!b || this.job.state === 'none') return this.log('err', 'Load a G-code file first: the frame is the outline of its moves');
    const { x, y, z } = this.status.wpos;
    if (z < -0.001) return this.log('err', 'Raise Z to Z0 or above before framing (the tool is below the work surface)');
    const f = (n: number) => n.toFixed(3);
    const top = f(z + LIFT);
    this.log('sys', `Frame: X ${f(b.minX)} to ${f(b.maxX)}, Y ${f(b.minY)} to ${f(b.maxY)} at Z ${top}`);
    for (const l of [
      'G21G90', `G1Z${top}F${zFeed}`,
      `G1X${f(b.minX)}Y${f(b.minY)}F${feed}`, `G1X${f(b.maxX)}Y${f(b.minY)}`, `G1X${f(b.maxX)}Y${f(b.maxY)}`,
      `G1X${f(b.minX)}Y${f(b.maxY)}`, `G1X${f(b.minX)}Y${f(b.minY)}`,
      `G1X${f(x)}Y${f(y)}`, `G1Z${f(z)}F${zFeed}`,   // back to the start, and only then down
    ]) this.sendLine(l);
  }

  /**
   * Run a macro: its lines in order, waiting for the machine to stop at each %wait and at the end.
   * Client commands are locked out while it runs (hold and reset still work), like a probe cycle.
   */
  async runMacro(name: string, content: string): Promise<void> {
    if (!this.connection.connected) return this.log('err', 'Not connected');
    if (this.lock) return this.log('err', `Blocked: ${this.lock}`);
    if (this.job.state === 'running' || this.job.state === 'paused') return this.log('err', 'Cannot run a macro during a job');
    if (this.status.state !== 'Idle') return this.log('err', `A macro needs the machine Idle (it is ${this.status.state})`);
    let steps;
    try { steps = compileMacro(content, this.job.state === 'none' ? undefined : this.job.extents?.all); }
    catch (e) { return this.log('err', `Macro "${name}" not run: ${(e as Error).message}`); }
    this.lock = `The macro "${name}" is running`;
    let reset = false;
    const onReset = () => { reset = true; };
    this.on('reset', onReset);
    this.log('sys', `Macro "${name}" started`);
    try {
      for (const step of steps) {
        if (reset) throw new Error('Machine was reset');
        if (step.kind === 'wait') { await this.waitIdle(); continue; }
        const ack = await this.sendInternal(step.text);
        if (!ack.ok) throw new Error(`${step.text}: ${ack.error ?? 'rejected'}`);
      }
      await this.waitIdle();
      if (reset) throw new Error('Machine was reset');
      this.log('sys', `Macro "${name}" finished`);
    } catch (e) {
      this.log('err', `Macro "${name}" stopped: ${(e as Error).message}`);
    } finally {
      this.off('reset', onReset);
      this.lock = undefined;
    }
  }

  /** Leaving PCB mode (or a restart) ends "PCB Home done": the work zero may have been moved */
  clearPcbHomed() {
    if (!this.connection.pcbHomed && !this.connection.pcbZSet) return;
    this.connection = { ...this.connection, pcbHomed: false, pcbZSet: false };
    this.emit('connection', this.connection);
  }

  /** The PCB Z probe set Z0 on the board (true), or another probe replaced that Z0 (false) */
  setPcbZ(done: boolean) {
    if (!!this.connection.pcbZSet === done) return;
    this.connection = { ...this.connection, pcbZSet: done };
    this.emit('connection', this.connection);
  }

  /**
   * PCB Home: go to the fixture and make that work X0 Y0. The fixture and the safe height are MACHINE coordinates, so they
   * are the same every time once the machine is homed. The tool is only ever raised to the safe height, never lowered to it
   * (it might already be higher, and lowering toward a board is the wrong direction to be wrong in).
   */
  private async pcbHome(): Promise<void> {
    const cfg = this.pcbConfig();
    if (!this.connection.connected) return this.log('err', 'Not connected');
    if (!cfg.enabled || !cfg.configured) return this.log('err', 'PCB mode is off');
    if (this.job.state === 'running' || this.job.state === 'paused') return this.log('err', 'Cannot do PCB Home during a job');
    if (this.status.state !== 'Idle') return this.log('err', `PCB Home needs the machine Idle (it is ${this.status.state})`);
    if (this.connection.homeReminder) return this.log('err', 'Home the machine first (the fixture position is in machine coordinates). Turn PCB mode off, press Home, then turn it back on.');
    if (this.lock) return this.log('err', `Blocked: ${this.lock}`);
    const f = (n: number) => n.toFixed(3);
    this.lock = 'PCB Home is running';
    let reset = false;
    const onReset = () => { reset = true; };
    this.on('reset', onReset);
    try {
      const send = async (line: string) => {
        if (reset) throw new Error('Machine was reset');
        const ack = await this.sendInternal(line);
        if (!ack.ok) throw new Error(`${line}: ${ack.error ?? 'rejected'}`);
      };
      this.log('sys', `PCB Home: machine X ${f(cfg.x)} Y ${f(cfg.y)}, safe Z ${f(cfg.safeZ)}`);
      await send('G21G90G54');
      if (this.status.mpos.z < cfg.safeZ - 0.001) await send(`G53G0Z${f(cfg.safeZ)}`);   // up to the safe height, never down
      await send(`G53G0X${f(cfg.x)}Y${f(cfg.y)}`);
      await this.waitIdle();
      if (reset) throw new Error('Machine was reset');
      await send('G10L20P1X0Y0');                    // here is the board's X0 Y0
      this.connection = { ...this.connection, pcbHomed: true };
      this.emit('connection', this.connection);
      this.log('sys', 'PCB Home done: work X0 Y0 is at the fixture');
    } catch (e) {
      this.log('err', `PCB Home stopped: ${(e as Error).message}`);
    } finally {
      this.off('reset', onReset);
      this.lock = undefined;
    }
  }

  private spindleCommand(command: SpindleCommand, rpm?: number) {
    const cfg = this.spindleConfig();
    if (!(SPINDLE_COMMANDS as readonly string[]).includes(command) || !cfg.commands.includes(command)) {
      return this.log('err', `${command} is not enabled in the spindle setup`);
    }
    // Starting the spindle is the dangerous one: only from a healthy, idle machine, and only to a speed the setup allows
    if (command === 'M3' || command === 'M4') {
      if (!(typeof rpm === 'number' && Number.isFinite(rpm) && rpm >= 1 && rpm <= cfg.maxRpm)) {
        return this.log('err', `Spindle speed must be from 1 to ${cfg.maxRpm} RPM`);
      }
      if (this.status.state === 'Alarm') return this.log('err', 'The machine is in alarm: clear it before starting the spindle');
      return this.sendLine(`${command} S${Math.round(rpm)}`);
    }
    return this.sendLine(command);
  }

  private hold() {
    this.realtime('!');
    if (this.job.state === 'running') { this.job = { ...this.job, state: 'paused' }; this.emitJob(); }
  }

  private resume() {
    this.realtime('~');
    if (this.job.state === 'paused') { this.job = { ...this.job, state: 'running' }; this.emitJob(); this.pump(); }
  }

  softReset() {
    this.realtime(0x18);
    this.abortQueued('Machine reset');
    this.emit('reset');
    if (this.job.state === 'running' || this.job.state === 'paused') this.failJob('Machine reset during job');
  }

  // ---------- job ----------
  loadJob(name: string, content: string) {
    if (this.job.state === 'running' || this.job.state === 'paused') {
      return this.log('err', 'Cannot load a file while a job is running');
    }
    const rawLines = content.split(/\r?\n/);
    const already = detectLeveled(name, rawLines);
    this.jobSource = { name, content, alreadyLeveled: !!already };
    this.levelHeader = [];
    this.jobLines = rawLines.map(cleanGcode).filter(Boolean);
    this.jobIndex = 0;
    let bounds;
    try { bounds = levelProgram(content.split(/\r?\n/), null).bounds; } catch { /* unsupported for autolevel; still runnable */ }
    this.job = { ...emptyJob(), state: 'loaded', name, totalLines: this.jobLines.length, bounds, extents: analyzeProgram(this.jobLines, { path: false }).extents, alreadyLeveled: already };
    this.log('sys', `Loaded ${name}: ${this.jobLines.length} lines`);
    this.emitJob();
  }

  /** Replace the loaded program with a copy that has the height map applied. */
  levelJob(map: HeightMap | null) {
    if (this.job.state === 'running' || this.job.state === 'paused') return this.log('err', 'Cannot change the program while a job is running');
    if (this.lock) return this.log('err', `Blocked: ${this.lock}`);
    if (!this.jobSource) return this.log('err', 'Load a G-code file first');
    if (this.jobSource.alreadyLeveled) {
      // Levelling twice would add the surface correction to Z a second time
      const why = 'This file is already autolevelled. Load the original (unlevelled) program to level it again, or run this one as it is.';
      this.job = { ...this.job, levelError: why };
      this.emitJob();
      return this.log('err', `Autolevel not applied. ${why}`);
    }
    if (!map) return this.log('err', 'No height map: run an autolevel scan or load a saved one');
    if (this.job.levelError) { this.job = { ...this.job, levelError: undefined }; }
    const { name, content } = this.jobSource;
    const src = content.split(/\r?\n/);
    let result;
    try {
      result = levelProgram(src, map);
    } catch (e) {
      if (e instanceof GcodeError) {
        this.job = { ...this.job, levelError: e.message };
        this.emitJob();
        return this.log('err', `Autolevel not applied. ${e.message}`);
      }
      throw e;
    }
    const wco = this.status.wco;
    const zeroChanged = !!map.wco && (Math.abs(map.wco.x - wco.x) > 0.05 || Math.abs(map.wco.y - wco.y) > 0.05 || Math.abs(map.wco.z - wco.z) > 0.05);
    const warnings: string[] = [];
    if (result.stats.outside) warnings.push(`${result.stats.outside} cutting points lie outside the scanned area and use the nearest edge height`);
    if (result.stats.uncorrected) warnings.push(`${result.stats.uncorrected} Z move(s) before the first XY position were left as written`);
    if (zeroChanged) warnings.push('Work zero has moved since the scan. If you did not re-zero on the same surface point, rescan');
    const lines = result.lines.map(cleanGcode).filter(Boolean);
    const summary: LevelSummary = {
      cols: map.cols, rows: map.rows, linesBefore: this.jobLines.length, linesAfter: lines.length,
      minDelta: result.stats.minDelta, maxDelta: result.stats.maxDelta, outside: result.stats.outside,
      zeroChanged, scannedAt: map.scannedAt, warnings,
    };
    const dot = name.lastIndexOf('.');
    const leveledName = dot > 0 ? `${name.slice(0, dot)}.leveled${name.slice(dot)}` : `${name}.leveled.nc`;
    this.levelHeader = [
      `(DemonX autolevel v1: ${map.cols}x${map.rows} points, scanned ${new Date(map.scannedAt).toISOString()}, Z corrected ${summary.minDelta.toFixed(3)} to ${summary.maxDelta.toFixed(3)} mm, from ${name.replace(/[()]/g, '')})`,
    ];
    this.jobLines = lines;
    this.jobIndex = 0;
    this.job = { ...emptyJob(), state: 'loaded', name: leveledName, totalLines: lines.length, bounds: result.bounds, leveled: summary, extents: analyzeProgram(lines, { path: false }).extents };
    this.log('sys', `Autolevel applied to ${name}: ${summary.linesBefore} to ${summary.linesAfter} lines, Z corrected by ${summary.minDelta.toFixed(3)} to ${summary.maxDelta.toFixed(3)} mm`);
    for (const w of warnings) this.log('err', `Autolevel: ${w}`);
    this.emitJob();
  }

  /** Go back to the program exactly as loaded from file. */
  revertJob() {
    if (!this.jobSource) return this.log('err', 'Load a G-code file first');
    this.loadJob(this.jobSource.name, this.jobSource.content);
  }

  /** The program that will be streamed (cleaned lines), for download. */
  jobText(): string { return [...this.levelHeader, ...this.jobLines].join('\n') + '\n'; }

  startJob() {
    if (!this.connection.connected) return this.log('err', 'Not connected');
    if (this.job.state !== 'loaded' && this.job.state !== 'done' && this.job.state !== 'error') {
      return this.log('err', 'No job loaded');
    }
    if (this.status.state !== 'Idle') return this.log('err', `Machine is ${this.status.state}, not Idle`);
    this.jobIndex = 0;
    this.job = { ...this.job, state: 'running', sentLines: 0, doneLines: 0, startedAt: Date.now(), elapsedMs: 0, error: undefined };
    this.log('sys', `Job started: ${this.job.name}`);
    this.emitJob();
    this.pump();
  }

  /** Feed hold, wait for the machine to stop, then soft reset (spindle off). */
  async stopJob() {
    if (this.stopping) return;
    if (this.job.state !== 'running' && this.job.state !== 'paused') return;
    this.stopping = true;
    try {
      this.realtime('!');
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline && !this.status.state.startsWith('Hold') && this.status.state !== 'Idle') {
        await new Promise((r) => setTimeout(r, 50));
      }
      this.realtime(0x18);
      this.abortQueued('Job stopped');
      this.job = { ...this.job, state: 'loaded', sentLines: 0, doneLines: 0, error: undefined };
      this.jobIndex = 0;
      this.log('sys', 'Job stopped. Machine reset: re-check position before restarting.');
      this.emitJob();
    } finally {
      this.stopping = false;
    }
  }

  private failJob(reason: string) {
    this.job = { ...this.job, state: 'error', error: reason };
    this.log('err', reason);
    this.emitJob();
  }

  private checkJobDone() {
    const j = this.job;
    if (j.state === 'running' && j.doneLines >= j.totalLines && this.status.state === 'Idle') {
      this.job = { ...j, state: 'done', elapsedMs: Date.now() - (j.startedAt ?? Date.now()) };
      this.log('sys', `Job complete in ${(this.job.elapsedMs / 1000).toFixed(1)}s`);
      this.emitJob();
    }
  }

  private emitJob() {
    if (this.job.state === 'running' && this.job.startedAt) {
      this.job = { ...this.job, elapsedMs: Date.now() - this.job.startedAt };
    }
    this.emit('job', this.job);
  }

  // ---------- log ----------
  log(kind: LogKind, text: string) {
    const entry = { t: Date.now(), kind, text };
    this.logBuffer.push(entry);
    if (this.logBuffer.length > 300) this.logBuffer.shift();
    this.emit('log', entry);
  }
}
