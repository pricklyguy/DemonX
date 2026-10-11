// Hold-to-jog from the browser side: every way of asking for movement (the Jog panel buttons, the keyboard, the gamepad) adds a
// "source" to one bus, which adds them up and repeats the result to the server about ten times a second for as long as any source
// is held. When the last source lets go (or anything cancels), it tells the server at once. The server has its own stops: see
// server/src/jogHold.ts. Plain code with injected timers, so it is tested without a browser (server/test/holdjog.test.ts).

import type { ClientMessage } from './protocol';

export interface Vec { x: number; y: number; z: number }
export const BEAT_MS = 100;
/** Held shorter than this is a tap: one step. Held longer: moves for as long as it is held. */
export const TAP_MS = 250;

const zero = (v: Vec) => v.x === 0 && v.y === 0 && v.z === 0;
const same = (a: Vec | null, b: Vec) => !!a && a.x === b.x && a.y === b.y && a.z === b.z;

export class HoldBus {
  sender: (m: ClientMessage) => void = () => {};
  private sources = new Map<string, Vec>();
  private timer?: ReturnType<typeof setInterval>;
  private last: Vec | null = null;

  get active(): boolean { return this.sources.size > 0; }

  /** Set (or with null, remove) what one source wants, in mm/min per axis */
  set(id: string, v: Vec | null) {
    if (!v || zero(v)) this.sources.delete(id); else this.sources.set(id, v);
    this.push(false);
  }

  /** Let go of everything: the page lost focus, the pad went away, and so on */
  releaseAll() { this.sources.clear(); this.push(false); }

  private sum(): Vec {
    let x = 0, y = 0, z = 0, maxXY = 0;
    for (const v of this.sources.values()) { x += v.x; y += v.y; z += v.z; maxXY = Math.max(maxXY, Math.hypot(v.x, v.y)); }
    const xy = Math.hypot(x, y);
    if (xy > maxXY && xy > 0) { x *= maxXY / xy; y *= maxXY / xy; }   // two keys for a diagonal move at the feed, not faster
    const r = (n: number) => Math.round(n * 10) / 10 || 0;
    return { x: r(x), y: r(y), z: r(z) };
  }

  private push(beat: boolean) {
    const v = this.sum();
    if (zero(v)) {
      if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
      if (this.last) { this.last = null; this.sender({ type: 'jogRelease' }); }
      return;
    }
    if (!this.timer) this.timer = setInterval(() => this.push(true), BEAT_MS);
    if (beat || !same(this.last, v)) { this.last = v; this.sender({ type: 'jogHold', ...v }); }
  }
}

export interface GestureOptions {
  /** A tap: one step in this direction (-1, 0 or 1 per axis) */
  tap: (dir: Vec) => void;
  /** The speeds to hold at, mm/min */
  speeds: () => { xy: number; z: number };
}

/** Tap or hold, for anything with a press and a release */
export class Gesture {
  private downs = new Map<string, { dir: Vec; holding: boolean; timer: ReturnType<typeof setTimeout> }>();
  constructor(private bus: HoldBus, private o: GestureOptions) {}

  down(id: string, dir: Vec) {
    if (this.downs.has(id)) return;                                        // key repeat, a second finger
    const d = { dir, holding: false, timer: setTimeout(() => { d.holding = true; this.bus.set(id, this.speedOf(dir)); }, TAP_MS) };
    this.downs.set(id, d);
  }

  up(id: string) {
    const d = this.downs.get(id);
    if (!d) return;
    clearTimeout(d.timer); this.downs.delete(id);
    if (d.holding) this.bus.set(id, null); else this.o.tap(d.dir);
  }

  /** Stop one press without a tap (its pointer was cancelled) */
  cancel(id: string) {
    const d = this.downs.get(id);
    if (!d) return;
    clearTimeout(d.timer); this.downs.delete(id); this.bus.set(id, null);
  }

  /** Stop without a tap (the pointer was cancelled, the page lost focus) */
  cancelAll() {
    for (const [id, d] of this.downs) { clearTimeout(d.timer); this.bus.set(id, null); }
    this.downs.clear();
  }

  private speedOf(dir: Vec): Vec {
    const { xy, z } = this.o.speeds();
    const m = Math.hypot(dir.x, dir.y) || 1;
    return { x: (dir.x / m) * xy, y: (dir.y / m) * xy, z: dir.z * z };
  }
}
