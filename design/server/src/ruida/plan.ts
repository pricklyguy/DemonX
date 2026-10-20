// A job as the Design Laser panel means it, before it becomes Ruida bytes. Coordinates are millimetres in job space:
// (0, 0) is the reference point, which LightBurn's "Current Position" mode (and our writer) sets to where the head stands
// when the job starts. X grows to the right and Y toward the front of the machine.

/** Only the two layer kinds that have been seen on the wire: a line follow (cut / score / line-engrave) and a fill (engrave). */
export type RuidaMode = 'line' | 'fill';

export interface RuidaPoint {
  x: number;
  y: number;
  /** Laser on while travelling TO this point. The first point of a layer is always a move (burn false). */
  burn: boolean;
}

export interface RuidaLayer {
  /** The layer colour as the controller stores it (LightBurn writes BGR: red is 0x0000ff). Shown on the controller panel only. */
  colorRaw: number;
  mode: RuidaMode;
  /** mm/s */
  speed: number;
  /** percent, 0..100 */
  minPower: number;
  maxPower: number;
  /** Air assist (high-pressure) for this layer; the controller drives its air outputs from this flag */
  air: boolean;
  points: RuidaPoint[];
}

export interface RuidaPlan {
  layers: RuidaLayer[];
  /** Value of the job's `DA 01 06 20` footer, kept when a captured job is read so it can be written back identically */
  lengthField?: number;
}

export interface Box { minX: number; minY: number; maxX: number; maxY: number }

export function layerBox(l: RuidaLayer): Box | null {
  if (!l.points.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of l.points) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  return { minX, minY, maxX, maxY };
}

export function planBox(plan: RuidaPlan): Box | null {
  let b: Box | null = null;
  for (const l of plan.layers) {
    const lb = layerBox(l);
    if (!lb) continue;
    b = b ? { minX: Math.min(b.minX, lb.minX), minY: Math.min(b.minY, lb.minY), maxX: Math.max(b.maxX, lb.maxX), maxY: Math.max(b.maxY, lb.maxY) } : lb;
  }
  return b;
}

/** How far a job reaches past each edge of the work area from where the head is, in mm (0 when inside). Y grows toward the front. */
export interface Reach { left: number; right: number; rear: number; front: number }
export function reach(box: Box, head: { x: number; y: number }, bedW: number, bedH: number): Reach {
  const r = (v: number) => Math.max(0, Math.round(v * 10) / 10);
  return { left: r(-(box.minX + head.x)), right: r(box.maxX + head.x - bedW), rear: r(-(box.minY + head.y)), front: r(box.maxY + head.y - bedH) };
}
export function reachText(r: Reach): string {
  const parts = [
    r.rear > 0 && `${r.rear} mm past the rear edge`, r.front > 0 && `${r.front} mm past the front edge`,
    r.left > 0 && `${r.left} mm past the left edge`, r.right > 0 && `${r.right} mm past the right edge`,
  ].filter(Boolean);
  return parts.join(', ');
}

/** Length of the laser-on travel in mm */
export function burnLength(plan: RuidaPlan): number {
  let len = 0;
  for (const l of plan.layers) for (let i = 1; i < l.points.length; i++) if (l.points[i].burn) len += Math.hypot(l.points[i].x - l.points[i - 1].x, l.points[i].y - l.points[i - 1].y);
  return len;
}

// ---------- the wire format between the Design panel and the server ----------
// Compact on purpose (a fill can have a million points): {"v":1,"layers":[{"color":n,"mode":"line","speed":n,"min":n,"max":n,"air":false,"pts":[[x,y,1],...]}]}

export function serializePlan(plan: RuidaPlan): string {
  return JSON.stringify({
    v: 1,
    layers: plan.layers.map((l) => ({ color: l.colorRaw, mode: l.mode, speed: l.speed, min: l.minPower, max: l.maxPower, air: l.air, pts: l.points.map((p) => [p.x, p.y, p.burn ? 1 : 0]) })),
  });
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Reads the text the panel sent. Strict: anything unexpected is refused, nothing is guessed. Throws an Error with a plain message. */
export function parsePlan(text: string, maxPoints = 2_000_000): RuidaPlan {
  let raw: any;
  try { raw = JSON.parse(text); } catch { throw new Error('The job is not valid JSON'); }
  if (!raw || raw.v !== 1 || !Array.isArray(raw.layers)) throw new Error('This is not a Ruida job plan (version 1)');
  if (raw.layers.length < 1 || raw.layers.length > 100) throw new Error('A job needs 1 to 100 layers');
  let total = 0;
  const layers: RuidaLayer[] = raw.layers.map((l: any, i: number) => {
    const n = i + 1;
    if (!l || typeof l !== 'object') throw new Error(`Layer ${n} is not an object`);
    if (l.mode !== 'line' && l.mode !== 'fill') throw new Error(`Layer ${n}: mode must be line or fill`);
    if (!Number.isInteger(l.color) || l.color < 0 || l.color > 0xffffff) throw new Error(`Layer ${n}: bad colour`);
    for (const k of ['speed', 'min', 'max']) if (!isNum(l[k])) throw new Error(`Layer ${n}: ${k} is not a number`);
    if (typeof l.air !== 'boolean') throw new Error(`Layer ${n}: air must be true or false`);
    if (!Array.isArray(l.pts)) throw new Error(`Layer ${n}: no points`);
    total += l.pts.length;
    if (total > maxPoints) throw new Error(`The job has more than ${maxPoints} points`);
    const points: RuidaPoint[] = l.pts.map((p: any) => {
      if (!Array.isArray(p) || p.length !== 3 || !isNum(p[0]) || !isNum(p[1]) || (p[2] !== 0 && p[2] !== 1)) throw new Error(`Layer ${n}: a point is malformed`);
      return { x: p[0], y: p[1], burn: p[2] === 1 };
    });
    return { colorRaw: l.color, mode: l.mode, speed: l.speed, minPower: l.min, maxPower: l.max, air: l.air, points };
  });
  return { layers };
}
