// How long a laser job takes and what it looks like: one list of moves for both controllers, so the preview, the time and the
// optimizer all use the same numbers. The time is an estimate: a feed run takes length / speed plus a ramp up and down, a rapid
// move follows a trapezoid (accelerate, cruise, brake). It has not been compared with a real machine's clock yet.
import type { RuidaPlan } from '../../server/src/ruida/plan';
import type { Move } from './laser';

/**
 * How the head moves. The defaults are for one machine (an OMTech Pronto 45 with a Ruida controller), taken from its settings
 * and checked against two timed fills: the real time is the cut time plus about 0.122 s for each
 * scan line, which is what the numbers below give. Other machines need their own numbers.
 */
export interface MotionModel {
  /** mm/s the head travels at between cuts (the controller's idle speed) */
  rapid: number;
  /** mm/s^2 for those moves */
  rapidAccel: number;
  /** mm/s^2 while burning, after the controller's acceleration factor (X engraving acceleration 8000 x 80 %) */
  feedAccel: number;
  /** mm/s the head can start or stop at without a ramp (X start speed) */
  startSpeed: number;
  /** mm/s for the small step from one scan line to the next */
  shiftSpeed: number;
}
export const PRONTO_MODEL: MotionModel = { rapid: 300, rapidAccel: 2000, feedAccel: 6400, startSpeed: 20, shiftSpeed: 100 };
/** A move this short that follows a feed is a step to the next scan line, not a rapid */
const STEP_MM = 2;

export interface Estimate {
  cutMm: number;
  rapidMm: number;
  cutSeconds: number;
  rapidSeconds: number;
  totalSeconds: number;
  /** seconds elapsed at the end of each move (same length as the moves), for the preview's play-back */
  at: Float64Array;
}

const rapidTime = (d: number, v: number, a: number): number => (d <= 0 ? 0 : d >= (v * v) / a ? d / v + v / a : 2 * Math.sqrt(d / a));

export function estimateMoves(moves: Move[], model: Partial<MotionModel> = {}): Estimate {
  const m = { ...PRONTO_MODEL, ...model };
  const at = new Float64Array(moves.length);
  let cutMm = 0, rapidMm = 0, cutSeconds = 0, rapidSeconds = 0;
  let runSpeed = 0; // speed of the feed run in progress, 0 when none
  let t = 0;
  moves.forEach((mv, i) => {
    const d = Math.hypot(mv.x1 - mv.x0, mv.y1 - mv.y0);
    if (mv.speed && mv.speed > 0) {
      // a new run (after a rapid, or at another speed) pays once for speeding up and slowing down
      if (runSpeed !== mv.speed) { const ramp = (2 * Math.max(0, mv.speed - m.startSpeed)) / m.feedAccel; cutSeconds += ramp; t += ramp; runSpeed = mv.speed; }
      const dt = d / mv.speed;
      cutSeconds += dt; t += dt;
      if (mv.burn) cutMm += d;
    } else {
      const dt = runSpeed > 0 && d <= STEP_MM ? d / m.shiftSpeed : rapidTime(d, m.rapid, m.rapidAccel);
      runSpeed = 0;
      rapidMm += d; rapidSeconds += dt; t += dt;
    }
    at[i] = t;
  });
  return { cutMm, rapidMm, cutSeconds, rapidSeconds, totalSeconds: cutSeconds + rapidSeconds, at };
}

/**
 * The plan as moves in drawing orientation (Y up, so it matches the design). A fill line's overscan run-in and run-out are feed
 * moves at the layer's speed (the head does not stop to turn round); every other unburned move is a rapid. `overscan` is the
 * longest run-in or run-out (mm), so a long flat travel across a gap is never mistaken for one.
 */
export function planToMoves(plan: RuidaPlan, overscan = 0): Move[] {
  const out: Move[] = [];
  let px = 0, py = 0;
  plan.layers.forEach((l, li) => {
    const layer = `Layer ${li + 1}`;
    l.points.forEach((p, i) => {
      const x1 = p.x, y1 = -p.y;
      if (i === 0 && !p.burn) { out.push({ x0: px, y0: py, x1, y1, burn: false, layer }); px = x1; py = y1; return; }
      let speed: number | undefined;
      if (p.burn) speed = l.speed;
      else if (l.mode === 'fill') {
        // an unburned move along the scan line, right before or right after a burn, is the overscan
        const prev = l.points[i - 1], next = l.points[i + 1];
        const flat = (a: { y: number }, b: { y: number }) => Math.abs(a.y - b.y) < 1e-6;
        const short = Math.hypot(p.x - (prev?.x ?? p.x), p.y - (prev?.y ?? p.y)) <= overscan + 1e-6;
        if (prev && short && flat(prev, p) && (prev.burn || (next?.burn && flat(p, next)))) speed = l.speed;
      }
      // in a fill layer, a flat unburned move right after a feed is the head crossing a gap inside one scan line: it does not
      // stop, it carries on at the scan speed with the laser off (timed on a Pronto 45: 78 mm gaps cost 78 / 415 s each)
      if (!speed && !p.burn && l.mode === 'fill' && i > 0 && Math.abs(y1 - py) < 1e-6 && out.length > 0 && out[out.length - 1].speed !== undefined && out[out.length - 1].layer === layer) speed = l.speed;
      out.push({ x0: px, y0: py, x1, y1, burn: p.burn, layer, ...(speed ? { speed } : {}) });
      px = x1; py = y1;
    });
  });
  return out;
}

/** "2:49:26", "52:33" or "0:45", the way LightBurn writes it */
export function clock(seconds: number): string {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(r)}` : `${m}:${two(r)}`;
}
