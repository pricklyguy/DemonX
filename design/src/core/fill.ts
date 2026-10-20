// How the fill lines of an engrave layer are laid out and ordered. LightBurn has three modes the user picks by hand
// (fill all shapes at once, fill groups together, fill shapes individually) and the best one depends on the design. Here
// they are three ways to cut the layer into pieces, plus "auto": try them, and also cut a piece in two where the scan lines
// would otherwise cross a wide empty gap (a border around a design is the usual case), and keep whatever the time estimate
// says is quickest. Everything is millimetres in drawing coordinates, no screen, no controller.
import type { Pt, Shape } from './types';
import { pointInShape, shapeBounds, shapeClosed, shapeRings, unionBounds, type Bounds } from './geom';
import { unionRings } from './clip';
import { estimateMoves, type MotionModel } from './jobEstimate';
import type { Move } from './laser';

export type FillMode = 'all' | 'groups' | 'individual' | 'auto';
export interface FillLine { y: number; spans: [number, number][] }
/** One step of the head. travel = rapid; feed with burn false = run-in / run-out past the line's end (overscan) */
export interface FillOp { x: number; y: number; feed: boolean; burn: boolean }

export const FILL_MODE_NAMES: Record<FillMode, string> = {
  all: 'All shapes at once',
  groups: 'Groups together',
  individual: 'Shapes individually',
  auto: 'Fastest (checks the others)',
};

/** Horizontal fill lines through closed rings: for each line, the [x0, x1] spans that are inside (even-odd). */
export function fillSpans(rings: Pt[][], interval: number): FillLine[] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rings) for (const p of r) { if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0]; if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1]; }
  if (!(maxY >= minY)) return [];
  let count = 0;
  while (minY + (count + 0.5) * interval <= maxY) count++;
  // each edge adds its crossing to the lines it spans, so the work follows the size of the drawing, not (lines x edges)
  const crossings: number[][] = new Array(count);
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if (yi === yj) continue;
      const lo = yi < yj ? yi : yj, hi = yi < yj ? yj : yi;
      const k0 = Math.max(0, Math.floor((lo - minY) / interval - 0.5) - 1), k1 = Math.min(count - 1, Math.ceil((hi - minY) / interval - 0.5) + 1);
      for (let k = k0; k <= k1; k++) {
        const y = minY + (k + 0.5) * interval;
        // half-open so a vertex exactly on the line is counted once
        if (yi > y !== yj > y) (crossings[k] ??= []).push(xi + ((y - yi) / (yj - yi)) * (xj - xi));
      }
    }
  }
  const lines: FillLine[] = [];
  for (let k = 0; k < count; k++) {
    const xs = crossings[k];
    if (!xs) continue;
    xs.sort((p, q) => p - q);
    const spans: [number, number][] = [];
    for (let i = 0; i + 1 < xs.length; i += 2) if (xs[i + 1] - xs[i] > 1e-6) spans.push([xs[i], xs[i + 1]]);
    if (spans.length) lines.push({ y: minY + (k + 0.5) * interval, spans });
  }
  return lines;
}

/**
 * The head's steps for a list of regions, each a list of fill lines. Back and forth along the lines (the way the controller
 * scans); a region starts from whichever end of it is nearest the head, so one region ends where the next begins.
 */
export function fillOps(regions: FillLine[][], over: number, start: Pt | null = null): FillOp[] {
  const ops: FillOp[] = [];
  let cx = start?.[0] ?? NaN, cy = start?.[1] ?? NaN;
  const push = (x: number, y: number, feed: boolean, burn: boolean) => {
    if (!feed && x === cx && y === cy) return;
    ops.push({ x, y, feed, burn }); cx = x; cy = y;
  };
  for (const region of regions) {
    if (!region.length) continue;
    const first = region[0], last = region[region.length - 1];
    // start at the bottom or the top, whichever is nearer to the head
    const up = Number.isNaN(cy) || Math.abs(first.y - cy) <= Math.abs(last.y - cy);
    const lines = up ? region : [...region].reverse();
    const startLeft = Number.isNaN(cx) || Math.abs(lines[0].spans[0][0] - cx) <= Math.abs(lines[0].spans[lines[0].spans.length - 1][1] - cx);
    lines.forEach((ln, idx) => {
      const forward = (idx % 2 === 0) === startLeft;
      const spans = forward ? ln.spans : [...ln.spans].reverse();
      // one sweep along the whole line, like LightBurn: the head crosses the gaps between spans with the laser off at the scan
      // speed and overscans only at the two ends (a stop and a run-up at every small piece would be far slower)
      const dir = forward ? 1 : -1;
      const startX = forward ? spans[0][0] : spans[0][1];
      if (over > 0) { push(startX - dir * over, ln.y, false, false); push(startX, ln.y, true, false); } else push(startX, ln.y, false, false);
      let endX = startX;
      spans.forEach(([a, b], k) => {
        const [from, to] = forward ? [a, b] : [b, a];
        if (k > 0) push(from, ln.y, true, false);
        push(to, ln.y, true, true);
        endX = to;
      });
      if (over > 0) push(endX + dir * over, ln.y, true, false);
    });
  }
  return ops;
}

/** The ops as moves, so the time estimate (and the preview) can price them */
export function opsToMoves(ops: FillOp[], speed: number, start: Pt | null, layer = ''): Move[] {
  const out: Move[] = [];
  let px = start?.[0] ?? ops[0]?.x ?? 0, py = start?.[1] ?? ops[0]?.y ?? 0;
  let prevFeed = false;
  for (const o of ops) {
    // a flat unburned move right after a feed is the head crossing a gap in the same scan line: it carries on at the scan speed
    const across = !o.feed && prevFeed && Math.abs(o.y - py) < 1e-6;
    out.push({ x0: px, y0: py, x1: o.x, y1: o.y, burn: o.burn, layer, ...(o.feed || across ? { speed } : {}) });
    prevFeed = o.feed;
    px = o.x; py = o.y;
  }
  return out;
}

const clip = (lines: FillLine[], lo: number, hi: number): FillLine[] => {
  const out: FillLine[] = [];
  for (const ln of lines) {
    const spans = ln.spans.map(([a, b]) => [Math.max(a, lo), Math.min(b, hi)] as [number, number]).filter(([a, b]) => b - a > 1e-6);
    if (spans.length) out.push({ y: ln.y, spans });
  }
  return out;
};

/** Places where cutting a region in two could save time: the x positions that most scan lines would cross an empty gap at */
function cutCandidates(lines: FillLine[], minGap: number): number[] {
  const bins = new Map<number, number>();
  const BIN = 0.5;
  let lo = Infinity, hi = -Infinity;
  for (const ln of lines) for (const [a, b] of ln.spans) { lo = Math.min(lo, a); hi = Math.max(hi, b); }
  if (!(hi > lo)) return [];
  for (const ln of lines) {
    for (let i = 0; i + 1 < ln.spans.length; i++) {
      const g0 = ln.spans[i][1], g1 = ln.spans[i + 1][0];
      if (g1 - g0 < minGap) continue;
      for (let k = Math.ceil(g0 / BIN); k * BIN <= g1; k++) bins.set(k, (bins.get(k) ?? 0) + 1);
    }
  }
  if (!bins.size) return [];
  const ks = [...bins.keys()].sort((p, q) => p - q);
  let max = 0;
  for (const v of bins.values()) if (v > max) max = v;
  // runs of neighbouring bins that are nearly as busy as the busiest; each run is one candidate, cut through its middle
  const runs: { k0: number; k1: number; score: number }[] = [];
  for (const k of ks) {
    if ((bins.get(k) ?? 0) < 0.5 * max) continue;
    const r = runs[runs.length - 1];
    if (r && k - r.k1 <= 1) { r.k1 = k; r.score += bins.get(k)!; } else runs.push({ k0: k, k1: k, score: bins.get(k)! });
  }
  return runs.sort((p, q) => q.score - p.score).slice(0, 4).map((r) => ((r.k0 + r.k1) / 2) * BIN);
}

export interface FillPlan {
  ops: FillOp[];
  /** One line saying what was chosen, when it is more than the plain mode; '' otherwise */
  note: string;
  /** Estimated seconds of the chosen layout, and of filling everything at once (for the note) */
  seconds: number;
  baselineSeconds: number;
}

export interface FillSettings { interval: number; overscan: number; speed: number; mode: FillMode }

const SPAN_LIMIT = 60_000; // auto stops looking when the fill is bigger than this many spans: it would take too long

/** The shapes of an engrave layer cut into the pieces each mode fills together */
function pieces(shapes: Shape[], mode: Exclude<FillMode, 'auto'>): Shape[][] {
  if (mode === 'all' || shapes.length < 2) return [shapes];
  if (mode === 'individual') return shapes.map((s) => [s]);
  const byGroup = new Map<number, Shape[]>();
  const out: Shape[][] = [];
  for (const s of shapes) {
    if (s.group === undefined) { out.push([s]); continue; }
    const g = byGroup.get(s.group);
    if (g) g.push(s); else { const n = [s]; byGroup.set(s.group, n); out.push(n); }
  }
  return out;
}

/**
 * Shapes at the same level that overlap are merged (so the overlap is not burnt twice); the rest are left as they are. Thousands of
 * separate letters or pixels never reach the (slow) merge, only the few clusters that really touch.
 */
function mergeOverlapping(group: Shape[]): Pt[][] {
  const n = group.length;
  const box = group.map((s) => shapeBounds(s)!);
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const byX = Array.from({ length: n }, (_, i) => i).sort((a, b) => box[a].minX - box[b].minX);
  for (let a = 0; a < n; a++) {
    const i = byX[a];
    for (let b = a + 1; b < n && box[byX[b]].minX <= box[i].maxX; b++) {
      const j = byX[b];
      if (box[j].minY <= box[i].maxY && box[j].maxY >= box[i].minY) parent[find(i)] = find(j);
    }
  }
  const comps = new Map<number, Shape[]>();
  group.forEach((s, i) => { const r = find(i); comps.set(r, [...(comps.get(r) ?? []), s]); });
  return [...comps.values()].flatMap((c) => (c.length === 1 ? shapeRings(c[0]).filter((r) => r.length >= 3) : unionRings(c)));
}

/**
 * The rings of the shapes filled together. A shape that lies completely inside another one is a hole in it (as in LightBurn), so a
 * frame drawn as two squares fills only the band between them, and a shape inside that hole fills again. Shapes at the same level
 * that overlap are merged, so the overlap is not burnt twice.
 */
function ringsOf(shapes: Shape[]): Pt[][] {
  const closed = shapes.filter(shapeClosed);
  if (closed.length < 2) return closed.flatMap((s) => shapeRings(s).filter((r) => r.length >= 3));
  const info = closed.map((s) => {
    const bb = shapeBounds(s)!;
    return { s, bb };
  });
  const inside = (a: { s: Shape; bb: Bounds }, b: { s: Shape; bb: Bounds }): boolean => {
    // the boxes first: a shape cannot be inside one whose box does not hold its own
    if (a.bb.minX < b.bb.minX || a.bb.maxX > b.bb.maxX || a.bb.minY < b.bb.minY || a.bb.maxY > b.bb.maxY) return false;
    // every sampled point of `a` is inside `b`
    const pts = shapeRings(a.s).flat();
    const step = Math.max(1, Math.floor(pts.length / 40));
    for (let i = 0; i < pts.length; i += step) if (!pointInShape(pts[i], b.s)) return false;
    return pointInShape(pts[pts.length - 1], b.s);
  };
  const levels = new Map<number, Shape[]>();
  for (const a of info) {
    let depth = 0;
    for (const b of info) if (b !== a && inside(a, b)) depth++;
    levels.set(depth, [...(levels.get(depth) ?? []), a.s]);
  }
  return [...levels.values()].flatMap(mergeOverlapping);
}

const regionsOf = (parts: Shape[][], interval: number): FillLine[][] => parts.map((p) => fillSpans(ringsOf(p), interval)).filter((r) => r.length);

/**
 * Lays out the fill of `shapes` (closed ones; open lines have no inside). With a fixed mode that is all it does. With 'auto' it
 * prices the three modes, each also with cuts through wide gaps, and returns the quickest (a different layout only when it is
 * at least 2 % faster than filling everything at once).
 */
export function planFill(shapes: Shape[], set: FillSettings, start: Pt | null = null, model: Partial<MotionModel> = {}): FillPlan {
  const price = (regions: FillLine[][]): { ops: FillOp[]; seconds: number } => {
    const ops = fillOps(regions, set.overscan, start);
    return { ops, seconds: estimateMoves(opsToMoves(ops, set.speed, start), model).totalSeconds };
  };
  const closed = shapes.filter(shapeClosed);
  if (set.mode !== 'auto') {
    const r = price(regionsOf(pieces(closed, set.mode), set.interval));
    return { ops: r.ops, note: '', seconds: r.seconds, baselineSeconds: r.seconds };
  }

  const baseRegions = regionsOf(pieces(closed, 'all'), set.interval);
  const base = price(baseRegions);
  const spanCount = baseRegions.reduce((n, r) => n + r.reduce((m, l) => m + l.spans.length, 0), 0);
  if (!baseRegions.length || spanCount > SPAN_LIMIT) return { ops: base.ops, note: spanCount > SPAN_LIMIT ? 'Fill is too large to look for a faster layout; filled all at once.' : '', seconds: base.seconds, baselineSeconds: base.seconds };

  const minGap = Math.max(3, 4 * set.overscan);
  const tried: { label: string; regions: FillLine[][] }[] = [{ label: 'all shapes at once', regions: baseRegions }];
  for (const mode of ['groups', 'individual'] as const) {
    const parts = pieces(closed, mode);
    if (parts.length > 1 && parts.length <= 60 && parts.length !== pieces(closed, 'all').length) tried.push({ label: mode === 'groups' ? 'groups together' : 'shapes individually', regions: regionsOf(parts, set.interval) });
  }

  let best = { label: 'all shapes at once', regions: baseRegions, ...base, cuts: 0 };
  for (const t of tried) {
    let regions = t.regions;
    let cur = price(regions);
    let cuts = 0;
    // greedy: take the single cut that saves the most, until no cut saves at least 1 %
    for (let round = 0; round < 4; round++) {
      let pick: { regions: FillLine[][]; seconds: number; ops: FillOp[] } | null = null;
      regions.forEach((r, ri) => {
        for (const c of cutCandidates(r, minGap)) {
          const left = clip(r, -Infinity, c), right = clip(r, c, Infinity);
          if (!left.length || !right.length) continue;
          const next = [...regions.slice(0, ri), left, right, ...regions.slice(ri + 1)];
          const p = price(next);
          if (p.seconds < (pick?.seconds ?? cur.seconds * 0.99)) pick = { regions: next, seconds: p.seconds, ops: p.ops };
        }
      });
      if (!pick) break;
      regions = (pick as { regions: FillLine[][] }).regions; cur = pick; cuts++;
    }
    if (cur.seconds < best.seconds) best = { label: t.label, regions, ops: cur.ops, seconds: cur.seconds, cuts };
  }
  if (best.seconds > base.seconds * 0.98) return { ops: base.ops, note: '', seconds: base.seconds, baselineSeconds: base.seconds };
  const how = [best.label !== 'all shapes at once' ? best.label : '', best.cuts ? `cut through ${best.cuts} wide gap${best.cuts > 1 ? 's' : ''}` : ''].filter(Boolean).join(', ');
  return { ops: best.ops, note: `Fill: ${how}. ${mm(base.seconds)} → ${mm(best.seconds)}.`, seconds: best.seconds, baselineSeconds: base.seconds };
}

const mm = (s: number): string => { const r = Math.round(s); const h = Math.floor(r / 3600), m = Math.floor((r % 3600) / 60), x = r % 60; return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`; };
