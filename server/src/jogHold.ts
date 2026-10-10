// Hold-to-jog: the machine moves only while a browser keeps saying so.
//
// The browser (a gamepad, later the keyboard) sends the speed it wants on each axis about ten times a second. The server turns
// that into short jog moves (a quarter of a second of travel each) and never queues more than about a third of a second ahead,
// so even a lost "stop" leaves very little to run out. It stops the machine at once (a GRBL jog cancel) when
//   - the browser says it let go,
//   - nothing has been heard for 0.4 s (a frozen page, a dropped network, a closed laptop),
//   - the browser that was holding disconnects,
//   - the machine alarms, a job starts, or the controller is locked,
//   - the direction changes sharply or the speed drops a lot (it stops first, then follows the new direction),
// and it ends any one hold after 30 s or 20 mm of Z, so the person has to let go and push again.
// Only one browser can hold at a time.

export const BEAT_TIMEOUT_MS = 400;
export const SEGMENT_MS = 250;
const QUEUE_AHEAD_MS = 150;       // send the next segment when less than this is still queued
const HOLDOFF_MS = 150;           // after a stop for a direction change, wait for the machine to settle
export const MAX_HOLD_MS = 30_000;
export const MAX_XY_SPEED = 6000; // mm/min, resultant
export const MAX_Z_SPEED = 600;   // mm/min
export const MAX_Z_TRAVEL = 20;   // mm per hold, like a single Z jog

export interface JogCtl {
  /** Why jogging is not allowed now, or null */
  blocked(): string | null;
  segment(line: string): void;
  /** Jog cancel: stops at once with a controlled slow-down */
  cancel(): void;
  log(kind: 'sys' | 'err', text: string): void;
}

type V = { x: number; y: number; z: number };
const mag = (v: V) => Math.hypot(v.x, v.y, v.z);
const num = (n: number) => String(Math.round(n * 1000) / 1000);

export class JogHold {
  private owner: unknown = null;
  private startedAt = 0;
  private lastBeat = 0;
  private busyUntil = 0;
  private holdOffUntil = 0;
  private last: V | null = null;
  private zTravel = 0;
  /** After a stop that was not the person's doing, that browser must let go (send zero) before it can jog again */
  private mustRelease: unknown = null;

  constructor(private ctl: JogCtl) {}

  get holding(): boolean { return this.owner !== null; }

  /** The browser's wish: speeds in mm/min per axis (negative is the other way). Zero everywhere means let go. */
  hold(owner: unknown, v: V, now = Date.now()) {
    if (this.owner !== null && this.owner !== owner) return;               // someone else is jogging
    const ok = [v.x, v.y, v.z].every(Number.isFinite);
    if (!ok || mag(v) === 0) { if (this.mustRelease === owner) this.mustRelease = null; return this.release(owner); }
    if (this.owner === null) {
      if (this.mustRelease === owner) return;                               // it has not let go since the last stop
      const why = this.ctl.blocked();
      if (why) return this.ctl.log('err', `Cannot jog: ${why}`);
      this.owner = owner; this.startedAt = now; this.zTravel = 0; this.last = null; this.busyUntil = now; this.holdOffUntil = 0;
    }
    this.lastBeat = now;
    if (now - this.startedAt > MAX_HOLD_MS) return this.stop('Jog stopped after 30 seconds. Let go and push again to keep moving');
    // limits: the same ones however the speed was asked for
    let { x, y, z } = v;
    const xy = Math.hypot(x, y);
    if (xy > MAX_XY_SPEED) { x *= MAX_XY_SPEED / xy; y *= MAX_XY_SPEED / xy; }
    z = Math.max(-MAX_Z_SPEED, Math.min(MAX_Z_SPEED, z));
    if (this.zTravel >= MAX_Z_TRAVEL) z = 0;
    const want: V = { x, y, z };
    if (mag(want) === 0) return;
    if (now < this.holdOffUntil) return;
    if (this.last && this.changedALot(this.last, want)) {
      this.ctl.cancel();
      this.last = null; this.busyUntil = now; this.holdOffUntil = now + HOLDOFF_MS;
      return;
    }
    if (this.busyUntil - now > QUEUE_AHEAD_MS) return;                     // enough is queued already
    this.send(want, now);
  }

  /** The browser let go */
  release(owner: unknown) {
    if (this.owner !== owner) return;
    this.owner = null; this.last = null;
    this.ctl.cancel();
  }

  /** The browser went away */
  drop(owner: unknown) { if (this.mustRelease === owner) this.mustRelease = null; this.release(owner); }

  /** Somebody pressed the jog stop button: whoever was holding must let go and push again */
  abort() { if (this.owner !== null) { this.mustRelease = this.owner; this.owner = null; this.last = null; } }

  /** Run about every 100 ms: the watchdog */
  tick(now = Date.now()) {
    if (this.owner === null) return;
    if (now - this.lastBeat > BEAT_TIMEOUT_MS) { this.stop('Jog stopped: lost contact with the browser that was jogging'); return; }
    const why = this.ctl.blocked();
    if (why) this.stop(`Jog stopped: ${why}`);
  }

  private stop(message: string) {
    this.ctl.cancel();
    this.ctl.log('sys', message);
    this.mustRelease = this.owner;
    this.owner = null; this.last = null;
  }

  private changedALot(a: V, b: V): boolean {
    const ma = mag(a), mb = mag(b);
    const cos = (a.x * b.x + a.y * b.y + a.z * b.z) / (ma * mb);
    return cos < 0.9 || mb < 0.6 * ma;
  }

  private send(v: V, now: number) {
    const k = SEGMENT_MS / 60000;
    const dx = v.x * k, dy = v.y * k, dz = v.z * k;
    this.zTravel += Math.abs(dz);
    const parts = `${dx ? `X${num(dx)}` : ''}${dy ? `Y${num(dy)}` : ''}${dz ? `Z${num(dz)}` : ''}`;
    this.ctl.segment(`$J=G21G91${parts}F${Math.max(1, Math.round(mag(v)))}`);
    this.last = v;
    this.busyUntil = Math.max(this.busyUntil, now) + SEGMENT_MS;
  }
}
