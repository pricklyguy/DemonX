// The server decides what may be sent to the laser. For Ruida that means: a job that reads back as exactly what LightBurn's
// jobs look like (parse.ts is strict), and whose numbers are inside the machine's limits.
import { toUm } from './codec.js';
import { planBox, reach, reachText, type RuidaPlan } from './plan.js';
import type { ParsedJob } from './parse.js';

export interface JobLimits {
  /** machine work area in mm */
  bedW: number;
  bedH: number;
  /** where the head is now (job space starts there). When unknown only the size of the job is checked. */
  head?: { x: number; y: number };
  /** mm/s */
  maxSpeed: number;
  /** percent: the highest power any layer may ask for */
  maxPower: number;
  maxPoints: number;
}

export const DEFAULT_LIMITS: JobLimits = { bedW: 1000, bedH: 600, maxSpeed: 600, maxPower: 100, maxPoints: 2_000_000 };

export interface JobCheck { ok: boolean; error?: string; points: number; maxPower: number; maxSpeed: number }

export function checkPlan(plan: RuidaPlan, limits: JobLimits = DEFAULT_LIMITS): JobCheck {
  const bad = (error: string): JobCheck => ({ ok: false, error, points: 0, maxPower: 0, maxSpeed: 0 });
  if (!plan.layers.length) return bad('The job has no layers');
  let points = 0, maxPower = 0, maxSpeed = 0;
  for (const [i, l] of plan.layers.entries()) {
    const n = i + 1;
    if (!(l.speed > 0 && l.speed <= limits.maxSpeed)) return bad(`Layer ${n}: speed must be above 0 and at most ${limits.maxSpeed} mm/s`);
    if (l.maxPower > limits.maxPower) return bad(`Layer ${n}: power ${Math.round(l.maxPower * 10) / 10} % is above the limit of ${limits.maxPower} % this server was started with${limits.maxPower < 100 ? ' (DESIGN_RUIDA_MAX_POWER)' : ''}.`);
    if (!(l.minPower >= 0 && l.minPower <= l.maxPower)) return bad(`Layer ${n}: power must be 0 or more, with the minimum not above the maximum`);
    if (l.points.length < 2) return bad(`Layer ${n}: nothing to draw`);
    if (l.points[0].burn) return bad(`Layer ${n}: must start with a move`);
    for (const p of l.points) if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return bad(`Layer ${n}: a point is not a number`);
    points += l.points.length;
    maxPower = Math.max(maxPower, l.maxPower);
    maxSpeed = Math.max(maxSpeed, l.speed);
  }
  if (points > limits.maxPoints) return bad(`The job has ${points} points; the limit is ${limits.maxPoints}`);
  const b = planBox(plan)!;
  if (limits.head) {
    const over = reachText(reach(b, limits.head, limits.bedW, limits.bedH));
    if (over) return bad(`From where the head is now (${limits.head.x.toFixed(1)} mm from the left, ${limits.head.y.toFixed(1)} mm from the rear edge) the job would run ${over}. Move the head, or change the job's start point (the nine-dot picker) so the job extends the other way.`);
  } else if (b.maxX - b.minX > limits.bedW || b.maxY - b.minY > limits.bedH) {
    return bad(`The job is ${(b.maxX - b.minX).toFixed(1)} x ${(b.maxY - b.minY).toFixed(1)} mm, bigger than the ${limits.bedW} x ${limits.bedH} mm work area`);
  }
  return { ok: true, points, maxPower, maxSpeed };
}

/** A job read from bytes: its sum was checked while reading; here its header must agree with its path and the numbers must be allowed. */
export function checkJob(job: ParsedJob, limits: JobLimits = DEFAULT_LIMITS): JobCheck {
  const c = checkPlan(job.plan, limits);
  if (!c.ok) return c;
  const b = planBox(job.plan)!;
  const r = (v: number) => Math.round(toUm(v) / 10) * 10;
  if (job.box.minX !== r(b.minX) || job.box.minY !== r(b.minY) || job.box.maxX !== r(b.maxX) || job.box.maxY !== r(b.maxY)) {
    return { ...c, ok: false, error: 'The job\'s box in its header does not match its path' };
  }
  return c;
}
