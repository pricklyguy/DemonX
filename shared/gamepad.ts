// Gamepad control: what the sticks and buttons mean, and when they are allowed to move the machine. Pure, so it is tested
// without a browser (server/test/gamepad.test.ts); web/src/gamepad.ts reads the real pad and sends what this decides.
//
// Layout (a standard "Xbox style" pad):
//   left stick      X and Y, speed follows how far it is pushed
//   right stick     Z (up is Z+), same
//   LB / RB         slower / faster (steps of 10% of the jog feed)
//   Start           arm: nothing moves until this is pressed with both sticks centred
//   B               stop: stops the jog, feed hold, and disarms
//   Back            disarm
//
// Safety rules (the server adds its own: see server/src/jogHold.ts):
//   - off unless turned on in Settings, in this browser only
//   - nothing moves until armed, and arming needs both sticks centred
//   - it disarms itself when the page loses focus, the pad disconnects, the connection drops, a job starts or the machine alarms
//   - speed is capped by the jog feeds you set in the Jog panel times the speed setting (default 50%)

export const DEADZONE = 0.25;
export const BTN = { B: 1, LB: 4, RB: 5, BACK: 8, START: 9 } as const;
export const SPEED_MIN = 10, SPEED_MAX = 100, SPEED_STEP = 10, SPEED_DEFAULT = 50;

export interface PadInput {
  /** A pad is connected and the settings turned it on */
  active: boolean;
  /** This page is in front and has focus */
  focused: boolean;
  /** The machine may be jogged now (connected, signed in, no job, no alarm) */
  allowed: boolean;
  axes: number[];
  /** Which buttons are down */
  buttons: boolean[];
}
export interface PadSettings { speed: number; xyFeed: number; zFeed: number }
export type PadAction =
  | { type: 'hold'; x: number; y: number; z: number }
  | { type: 'release' }
  | { type: 'stop' }                 // B: release, feed hold
  | { type: 'speed'; speed: number };

/** Dead zone for one stick (both axes together, so diagonals are not clipped), then eased so small pushes are gentle */
export function stick(x: number, y: number): { x: number; y: number } {
  const m = Math.hypot(x, y);
  if (!Number.isFinite(m) || m < DEADZONE) return { x: 0, y: 0 };
  const scaled = Math.min(1, (m - DEADZONE) / (1 - DEADZONE));
  const eased = scaled * scaled;           // gentle near the middle
  return { x: (x / m) * eased, y: (y / m) * eased };
}

/** The speeds (mm/min per axis) the sticks ask for */
export function speeds(axes: number[], s: PadSettings): { x: number; y: number; z: number } {
  const scale = Math.max(SPEED_MIN, Math.min(SPEED_MAX, s.speed)) / 100;
  const l = stick(axes[0] ?? 0, axes[1] ?? 0), r = stick(axes[2] ?? 0, axes[3] ?? 0);
  const round = (n: number) => Math.round(n * 10) / 10 || 0;
  return { x: round(l.x * s.xyFeed * scale), y: round(-l.y * s.xyFeed * scale), z: round(-r.y * s.zFeed * scale) };
}

const centred = (axes: number[]) => stick(axes[0] ?? 0, axes[1] ?? 0).x === 0 && stick(axes[0] ?? 0, axes[1] ?? 0).y === 0
  && stick(axes[2] ?? 0, axes[3] ?? 0).x === 0 && stick(axes[2] ?? 0, axes[3] ?? 0).y === 0;

/** Remembers whether the pad is armed and which buttons were down, and decides what to send on each look at the pad (about 10 a second) */
export class PadSession {
  armed = false;
  private prev: boolean[] = [];
  private moving = false;

  /** What to send now (possibly nothing, possibly several things) */
  update(i: PadInput, s: PadSettings): PadAction[] {
    const out: PadAction[] = [];
    const down = (n: number) => !!i.buttons[n];
    const before = this.prev;
    const pressed = (n: number) => down(n) && !before[n];
    this.prev = [...i.buttons];

    if (!i.active || !i.focused) { this.disarmAndRelease(out); return out; }
    if (pressed(BTN.B)) { this.armed = false; this.moving = false; out.push({ type: 'stop' }); return out; }
    if (pressed(BTN.BACK)) this.armed = false;
    if (!i.allowed) { this.disarmAndRelease(out); return out; }
    if (pressed(BTN.LB)) out.push({ type: 'speed', speed: Math.max(SPEED_MIN, s.speed - SPEED_STEP) });
    if (pressed(BTN.RB)) out.push({ type: 'speed', speed: Math.min(SPEED_MAX, s.speed + SPEED_STEP) });
    if (!this.armed) {
      if (pressed(BTN.START) && centred(i.axes)) this.armed = true;
      this.release(out);
      return out;
    }
    const v = speeds(i.axes, s);
    if (v.x === 0 && v.y === 0 && v.z === 0) this.release(out);
    else { this.moving = true; out.push({ type: 'hold', ...v }); }
    return out;
  }

  /** Anything that takes the pad away (blur, unplug, offline): stop now */
  lost(): PadAction[] { const out: PadAction[] = []; this.disarmAndRelease(out); return out; }

  private release(out: PadAction[]) { if (this.moving) { this.moving = false; out.push({ type: 'release' }); } }
  private disarmAndRelease(out: PadAction[]) { this.armed = false; this.release(out); }
}
