// Turns the layers that have Output on into a GRBL laser job: G-code, a list of moves for the on-screen preview, and
// numbers (time, length, warnings). Pure functions, no screen.
//
//   cut / score  follow the outlines. Inner shapes (holes) go first so a cut-out part does not move before it is finished.
//   engrave      fills closed shapes with lines `interval` mm apart, back and forth, running `overscan` mm past each line.
//
// The laser is switched with M4 (GRBL laser mode, $32=1): power follows speed and nothing fires on a G0 rapid.
import type { Doc, Layer, Pt, Shape } from './types';
import { workRect } from './types';
import { anchorPoint, pointInRing, shapeBounds, shapeClosed, shapeRings, unionBounds, type Anchor, type Bounds } from './geom';
import { planFill, type FillPlan } from './fill';

export interface LaserOptions {
  /** Only these shapes (LightBurn's "Cut selected graphics only"). */
  onlyIds?: number[];
  /** Which point of the job sits at the machine's work zero. Default bottom-left. Only used for startFrom "user". */
  anchor?: Anchor;
  /**
   * user:     work zero is a point of the job (you put the head there before you start). Default.
   * absolute: the drawing's 0,0 is the machine's 0,0, so where you placed the shapes in the work area is where they burn.
   *           Only right after homing, with the machine's origin at the bottom-left of its work area.
   */
  startFrom?: 'user' | 'absolute';
  /** How the cuts of line layers are ordered (the cut optimizer). */
  order?: OrderOptions;
}

export interface Move {
  x0: number; y0: number; x1: number; y1: number;
  /** True when the laser is on for this move. */
  burn: boolean;
  layer: string;
  /** A colour of its own (the CNC preview); the layer's colour is used when absent */
  color?: string;
  /** mm/s the head travels at while this move is a feed (burning, or the run-up / run-out of a fill line); absent for a rapid move. */
  speed?: number;
}

export interface LaserStats {
  burnLength: number;
  travelLength: number;
  seconds: number;
  /** The job's box in drawing coordinates (before the origin shift). */
  bounds: Bounds | null;
  layers: number;
  warnings: string[];
  /** Things the program chose for the user (such as a faster fill layout), shown without the warning sign */
  info?: string[];
}

export interface LaserJob {
  gcode: string;
  moves: Move[];
  stats: LaserStats;
  empty: boolean;
}

export function formatTime(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

const fmt = (v: number): string => {
  const r = Math.round(v * 1000) / 1000;
  return String(Object.is(r, -0) ? 0 : r);
};

export interface Contour {
  pts: Pt[];
  closed: boolean;
  /** How many other closed contours this one sits inside. Deeper means "inner", which is cut first. */
  depth: number;
}

export function contoursOf(shapes: Shape[]): Contour[] {
  const all: { pts: Pt[]; closed: boolean }[] = [];
  for (const s of shapes) {
    for (const ring of shapeRings(s)) if (ring.length >= 2) all.push({ pts: ring, closed: shapeClosed(s) });
  }
  const closed = all.filter((c) => c.closed).map((c) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of c.pts) { if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0]; if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1]; }
    return { c, minX, minY, maxX, maxY };
  });
  // how many closed contours each one sits inside; the box test first, so thousands of small pieces (a QR code, outlined text)
  // are not each tested against the outline of every other piece
  return all.map((c) => {
    if (!c.closed) return { ...c, depth: -1 };
    const [x, y] = c.pts[0];
    let depth = 0;
    for (const o of closed) {
      if (o.c === c || x < o.minX || x > o.maxX || y < o.minY || y > o.maxY) continue;
      if (pointInRing(c.pts[0], o.c.pts)) depth++;
    }
    return { ...c, depth };
  });
}

const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export interface OrderOptions {
  /** Inner shapes (holes) before the shapes around them, so a cut-out part does not move before it is finished. Default on. */
  innerFirst?: boolean;
  /** Pick the order, start points and directions that keep the head's empty travel short. Off keeps the drawing order. Default on. */
  reduceTravel?: boolean;
}

/** How far the head travels with the laser off to cut these contours in this order, from `from`. */
export function travelLength(list: Contour[], from: Pt): number {
  let pos = from, len = 0;
  for (const c of list) { len += dist(pos, c.pts[0]); pos = c.closed ? c.pts[0] : c.pts[c.pts.length - 1]; }
  return len;
}

/** One contour as the head would cut it from a chosen start (closed: any vertex, either way round; open: either end). */
const startAt = (c: Contour, idx: number, reverse: boolean): Contour => {
  let pts: Pt[];
  if (c.closed) { pts = [...c.pts.slice(idx), ...c.pts.slice(0, idx)]; if (reverse) pts = [pts[0], ...pts.slice(1).reverse()]; }
  else pts = reverse ? [...c.pts].reverse() : c.pts;
  return { ...c, pts };
};
const exitOf = (c: Contour): Pt => (c.closed ? c.pts[0] : c.pts[c.pts.length - 1]);

/** The nearest contour next: closed loops start at their nearest point, open lines at their nearer end. */
function nearestFirst(pool: Contour[], from: Pt): Contour[] {
  const rest = [...pool], out: Contour[] = [];
  let pos = from;
  while (rest.length) {
    let best = 0, bestD = Infinity;
    rest.forEach((c, i) => {
      let d: number;
      if (c.closed) {
        // a loop with thousands of points is judged by a sample of them; its exact nearest point is found once it is chosen
        d = Infinity;
        const step = Math.max(1, Math.floor(c.pts.length / 48));
        for (let k = 0; k < c.pts.length; k += step) { const e = dist(pos, c.pts[k]); if (e < d) d = e; }
      } else d = Math.min(dist(pos, c.pts[0]), dist(pos, c.pts[c.pts.length - 1]));
      if (d < bestD) { bestD = d; best = i; }
    });
    const c = rest.splice(best, 1)[0];
    let next: Contour;
    if (c.closed) {
      let k0 = 0, d0 = Infinity;
      c.pts.forEach((p, k) => { const d = dist(pos, p); if (d < d0) { d0 = d; k0 = k; } });
      next = startAt(c, k0, false);
    } else next = dist(pos, c.pts[0]) <= dist(pos, c.pts[c.pts.length - 1]) ? c : startAt(c, 0, true);
    out.push(next); pos = exitOf(next);
  }
  return out;
}

/**
 * Improves an order by local search: 2-opt (reverse a stretch of the order, which also turns its open lines round) and, for each
 * closed loop, re-picking the start vertex that is shortest between the contour before and the one after. Never makes it longer.
 * Each trial is worked out from the four points it touches, so hundreds of contours cost next to nothing.
 */
function improve(list: Contour[], from: Pt): Contour[] {
  const n = list.length;
  if (n < 2) return list;
  let order = list.map((_, i) => i);
  const flipped = new Array<boolean>(n).fill(false);
  const entry = (i: number): Pt => { const c = list[i]; return flipped[i] ? c.pts[c.pts.length - 1] : c.pts[0]; };
  const exit = (i: number): Pt => { const c = list[i]; return c.closed ? c.pts[0] : flipped[i] ? c.pts[0] : c.pts[c.pts.length - 1]; };
  for (let pass = 0; pass < 20; pass++) {
    let changed = false;
    for (let i = 0; i < n - 1; i++) {
      for (let j = i + 1; j < n; j++) {
        const before = i === 0 ? from : exit(order[i - 1]);
        const oldCost = dist(before, entry(order[i])) + (j + 1 < n ? dist(exit(order[j]), entry(order[j + 1])) : 0);
        // reversing order[i..j] and turning its open lines round: the lines inside keep their joins, only the two ends change
        const newCost = dist(before, exit(order[j])) + (j + 1 < n ? dist(entry(order[i]), entry(order[j + 1])) : 0);
        if (newCost < oldCost - 1e-9) {
          order = [...order.slice(0, i), ...order.slice(i, j + 1).reverse(), ...order.slice(j + 1)];
          for (let k = i; k <= j; k++) if (!list[order[k]].closed) flipped[order[k]] = !flipped[order[k]];
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  let cur = order.map((i) => (flipped[i] ? startAt(list[i], 0, true) : list[i]));
  // each closed loop starts where it is shortest between its neighbours (twice round, as moving one start moves its neighbours' best)
  for (let round = 0; round < 2; round++) {
    cur = cur.map((c, i) => {
      if (!c.closed || c.pts.length < 3) return c;
      const prev = i === 0 ? from : exitOf(cur[i - 1]);
      const next = i + 1 < cur.length ? cur[i + 1].pts[0] : null;
      let bestK = 0, bestD = Infinity;
      c.pts.forEach((p, k) => { const d = dist(prev, p) + (next ? dist(p, next) : 0); if (d < bestD - 1e-9) { bestD = d; bestK = k; } });
      return bestK === 0 ? c : startAt(c, bestK, false);
    });
  }
  return cur;
}

/** Inner contours first, then outward (unless switched off); within a depth, a short route between them. */
export function orderContours(list: Contour[], from: Pt, opt: OrderOptions = {}): Contour[] {
  const innerFirst = opt.innerFirst !== false;
  const groups = innerFirst
    ? [...new Set(list.map((c) => c.depth))].sort((a, b) => b - a).map((d) => list.filter((c) => c.depth === d))
    : [list];
  const out: Contour[] = [];
  let pos = from;
  for (const pool of groups) {
    const ordered = opt.reduceTravel === false ? pool : improve(nearestFirst(pool, pos), pos);
    for (const c of ordered) out.push(c);
    if (ordered.length) pos = exitOf(ordered[ordered.length - 1]);
  }
  return out;
}

/** The contours of a line layer in cutting order, and a note when the order saves a real amount of empty travel. */
export function orderLayer(shapes: Shape[], from: Pt, opt: OrderOptions = {}): { list: Contour[]; note: string } {
  const all = contoursOf(shapes);
  const list = orderContours(all, from, opt);
  if (opt.reduceTravel === false) return { list, note: '' };
  const plain = travelLength(orderContours(all, from, { ...opt, reduceTravel: false }), from);
  const now = travelLength(list, from);
  const note = plain - now >= 20 && now < plain * 0.9 ? `Cut order: empty travel ${Math.round(plain)} mm → ${Math.round(now)} mm.` : '';
  return { list, note };
}

export { fillSpans } from './fill';

/**
 * The box the job's start point (work zero, or where the head sits) is measured from: EVERY shape in the design, or every
 * selected shape, whatever its layer's Output switch says. Turning Output off for a layer must not move the start point, so
 * a design cut in several runs, one layer at a time, still lines up between the runs (LightBurn does the same).
 */
export function jobOriginBounds(doc: Doc, onlyIds?: number[]): Bounds | null {
  const only = onlyIds ? new Set(onlyIds) : null;
  return unionBounds(doc.shapes.filter((s) => !only || only.has(s.id)).map(shapeBounds));
}

/** Where the job starts, in drawing coordinates, for the marker on the drawing and for the job itself */
export function jobOrigin(doc: Doc, opts: { onlyIds?: number[]; anchor?: Anchor } = {}): Pt | null {
  const b = jobOriginBounds(doc, opts.onlyIds);
  return b ? anchorPoint(b, opts.anchor ?? 'bl') : null;
}

/** Why a canvas (a design with no machine) makes no laser job: it has to be made a laser job first (on the Laser tab). */
export const CANVAS_NOTE = 'This design is a canvas, not set up for a machine. Make it a laser job (Laser tab, Job) to cut or engrave it.';

export function buildLaserJob(doc: Doc, opts: LaserOptions = {}): LaserJob {
  // a canvas has no machine: nothing is made for one until the design is made a laser job (the drawing is kept as it is)
  if (doc.workspace.kind === 'canvas') return { gcode: '', moves: [], stats: { burnLength: 0, travelLength: 0, seconds: 0, bounds: null, layers: 0, warnings: [CANVAS_NOTE] }, empty: true };
  const warnings: string[] = [];
  const info: string[] = [];
  const fillPlans = new Map<string, FillPlan>();
  const only = opts.onlyIds ? new Set(opts.onlyIds) : null;
  const jobLayers: { layer: Layer; shapes: Shape[] }[] = [];
  for (const layer of doc.layers) {
    if (!layer.output || layer.mode === 'tool') continue;
    const shapes = doc.shapes.filter((s) => s.layer === layer.name && (!only || only.has(s.id)));
    if (shapes.length) jobLayers.push({ layer, shapes });
  }

  const bounds = unionBounds(jobLayers.flatMap((j) => j.shapes.map(shapeBounds)));
  const empty = !bounds;
  if (empty) {
    warnings.push(only ? 'None of the selected shapes are on a layer with Output on.' : 'No layer with Output on has any shapes.');
    return { gcode: '', moves: [], stats: { burnLength: 0, travelLength: 0, seconds: 0, bounds: null, layers: 0, warnings }, empty: true };
  }

  const m = doc.machine;
  const absolute = opts.startFrom === 'absolute';
  const origin: Pt = absolute ? [0, 0] : (jobOrigin(doc, { onlyIds: opts.onlyIds, anchor: opts.anchor }) ?? anchorPoint(bounds, opts.anchor ?? 'bl'));
  const w = bounds.maxX - bounds.minX;
  const h = bounds.maxY - bounds.minY;
  const area = doc.workspace.kind === 'laser' ? workRect(doc.workspace)! : { minX: 0, minY: 0, maxX: m.width, maxY: m.height };
  if (absolute) {
    const eps = 1e-6;
    if (bounds.minX < area.minX - eps || bounds.minY < area.minY - eps || bounds.maxX > area.maxX + eps || bounds.maxY > area.maxY + eps) {
      warnings.push(`The job reaches X ${fmt(bounds.minX)} to ${fmt(bounds.maxX)}, Y ${fmt(bounds.minY)} to ${fmt(bounds.maxY)} mm, outside the machine area (0 to ${fmt(area.maxX)} by 0 to ${fmt(area.maxY)} mm).`);
    }
  } else if (w > m.width + 1e-6 || h > m.height + 1e-6) {
    warnings.push(`The job is ${fmt(w)} × ${fmt(h)} mm but the machine area is ${fmt(m.width)} × ${fmt(m.height)} mm.`);
  }

  const lines: string[] = [];
  const moves: Move[] = [];
  let x = origin[0], y = origin[1];
  let lastS: number | null = null;
  let lastF: number | null = null;
  let burnLength = 0, travelLength = 0, seconds = 0;

  const X = (v: number) => fmt(v - origin[0]);
  const Y = (v: number) => fmt(v - origin[1]);

  const travel = (tx: number, ty: number, layer: string) => {
    if (Math.abs(tx - x) < 1e-9 && Math.abs(ty - y) < 1e-9) return;
    lines.push(`G0 X${X(tx)} Y${Y(ty)}`);
    const d = Math.hypot(tx - x, ty - y);
    travelLength += d; seconds += d / m.rapid;
    moves.push({ x0: x, y0: y, x1: tx, y1: ty, burn: false, layer });
    x = tx; y = ty;
  };
  /** A feed move. power is the S value; 0 means the laser is off (used for the run-up and run-out of a fill line). */
  const feed = (tx: number, ty: number, s: number, speed: number, layer: string) => {
    let word = `G1 X${X(tx)} Y${Y(ty)}`;
    if (s !== lastS) { word += ` S${s}`; lastS = s; }
    const f = Math.round(speed * 60 * 100) / 100;
    if (f !== lastF) { word += ` F${fmt(f)}`; lastF = f; }
    lines.push(word);
    const d = Math.hypot(tx - x, ty - y);
    seconds += d / speed;
    if (s > 0) burnLength += d; else travelLength += d;
    moves.push({ x0: x, y0: y, x1: tx, y1: ty, burn: s > 0, layer, speed });
    x = tx; y = ty;
  };

  lines.push('; DemonX Design laser job');
  lines.push(`; Machine: ${m.name} (${fmt(m.width)} x ${fmt(m.height)} mm), S max ${m.sMax}`);
  lines.push(absolute
    ? `; Absolute coordinates: the drawing's 0,0 is the machine's 0,0. Home the machine first. Job size ${fmt(w)} x ${fmt(h)} mm.`
    : `; Work zero is the ${anchorName(opts.anchor ?? 'bl')} of the design (all its shapes, whether or not their layer has Output on). Job size ${fmt(w)} x ${fmt(h)} mm.`);
  lines.push('; Needs GRBL laser mode ($32=1): M4 keeps power in step with speed and nothing fires on rapid moves.');
  lines.push('; Check focus, eye protection and ventilation, and watch the first run.');
  lines.push('G21', 'G90', 'M5');
  lines.push('M4 S0');
  lastS = 0;

  for (const { layer, shapes } of jobLayers) {
    const s = Math.round((layer.power / 100) * m.sMax);
    lines.push(`; Layer ${layer.name}: ${layer.mode}, ${layer.speed} mm/s, ${layer.power}%, ${layer.passes} pass${layer.passes > 1 ? 'es' : ''}${layer.air ? ', air' : ''}`);
    if (layer.minPower < layer.power) warnings.push(`Layer ${layer.name} has a minimum power of ${layer.minPower}%: G-code (GRBL) ignores it and uses the maximum, ${layer.power}%.`);
    if (s === 0) warnings.push(`Layer ${layer.name} has 0% power, so it will not burn anything.`);
    if (layer.air) lines.push('M8');

    for (let pass = 0; pass < layer.passes; pass++) {
      if (layer.passes > 1) lines.push(`; pass ${pass + 1} of ${layer.passes}`);
      if (layer.mode === 'engrave') {
        const closed = shapes.filter(shapeClosed);
        if (closed.length < shapes.length && pass === 0) warnings.push(`Layer ${layer.name} is set to engrave, so its open lines are skipped (a line has no inside to fill).`);
        const fp = fillPlans.get(layer.name) ?? (fillPlans.set(layer.name, planFill(closed, { interval: layer.interval, overscan: layer.overscan, speed: layer.speed, mode: layer.fillMode }, [x, y], { rapid: m.rapid })), fillPlans.get(layer.name)!);
        if (fp.note && pass === 0) info.push(`${layer.name}: ${fp.note}`);
        for (const o of fp.ops) {
          if (!o.feed) travel(o.x, o.y, layer.name); else feed(o.x, o.y, o.burn ? s : 0, layer.speed, layer.name);
        }
      } else {
        const ordered = orderLayer(shapes, [x, y], opts.order);
        if (ordered.note && pass === 0) info.push(`${layer.name}: ${ordered.note}`);
        for (const c of ordered.list) {
          travel(c.pts[0][0], c.pts[0][1], layer.name);
          for (let i = 1; i < c.pts.length; i++) feed(c.pts[i][0], c.pts[i][1], s, layer.speed, layer.name);
          if (c.closed) feed(c.pts[0][0], c.pts[0][1], s, layer.speed, layer.name);
        }
      }
    }
    if (layer.air) lines.push('M9');
  }

  // the first move is the approach from wherever the head starts, not part of the job's own reach
  const reach = unionBounds(moves.slice(moves.length && !moves[0].burn ? 1 : 0).flatMap((mv) => [{ minX: Math.min(mv.x0, mv.x1), maxX: Math.max(mv.x0, mv.x1), minY: Math.min(mv.y0, mv.y1), maxY: Math.max(mv.y0, mv.y1) }]));
  if (reach) {
    const out = Math.max(bounds.minX - reach.minX, reach.maxX - bounds.maxX, bounds.minY - reach.minY, reach.maxY - bounds.maxY);
    if (out > 1e-6) warnings.push(`The head runs up to ${fmt(out)} mm outside the job at the ends of the fill lines (overscan). Leave that much room around the job.`);
  }

  lines.push('M5');
  lines.push('G0 X0 Y0');
  lines.push('M2');

  return { gcode: lines.join('\n') + '\n', moves, stats: { burnLength, travelLength, seconds, bounds, layers: jobLayers.length, warnings, info }, empty: false };
}

const ANCHOR_NAMES: Record<Anchor, string> = { tl: 'top-left', tc: 'top-middle', tr: 'top-right', ml: 'left-middle', c: 'centre', mr: 'right-middle', bl: 'bottom-left', bc: 'bottom-middle', br: 'bottom-right' };
export const anchorName = (a: Anchor) => ANCHOR_NAMES[a];
