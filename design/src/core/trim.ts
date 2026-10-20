// Trim: cut a line or outline at every place other shapes cross it, and remove the piece between two crossings.
// Hover shows the piece that would go; a click removes it. What is left of the shape is kept as open lines whose ends
// are exactly on the crossings. (Like Trim in AutoCAD or Trim Vectors in VCarve.)
import type { Layer, Pt, Shape } from './types';
import { circleRing, shapeClosed, shapeRings } from './geom';

export interface TrimPlan {
  shapeId: number;
  ringIndex: number;
  /** The piece that will be removed */
  remove: Pt[];
  /** What remains of the trimmed outline, as open lines */
  keep: Pt[][];
  /** Where the outline is crossed, along the whole outline */
  cuts: Pt[];
}

export type TrimResult = { ok: true; plan: TrimPlan } | { ok: false; reason: string };

const EPS = 1e-9;
const lerp = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function projectOnSegment(p: Pt, a: Pt, b: Pt): { t: number; d: number } {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
  return { t, d: Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy)) };
}

/** Where segment a-b (parameter t, 0 to 1) meets segment c-d. Touching at an end counts. Parallel segments never cross. */
function crossing(a: Pt, b: Pt, c: Pt, d: Pt): { t: number } | null {
  const rx = b[0] - a[0], ry = b[1] - a[1], sx = d[0] - c[0], sy = d[1] - c[1];
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / den;
  const u = ((c[0] - a[0]) * ry - (c[1] - a[1]) * rx) / den;
  const tol = 1e-9;
  if (t < -tol || t > 1 + tol || u < -tol || u > 1 + tol) return null;
  return { t: Math.max(0, Math.min(1, t)) };
}

const ringOf = (s: Shape, i: number): Pt[] => (s.kind === 'circle' ? circleRing(s.cx, s.cy, s.r) : s.rings[i]);

/** The point at position `s` along an outline: whole numbers are the vertices, the fraction runs along the next side. */
function pointAt(ring: Pt[], closed: boolean, s: number): Pt {
  const n = ring.length;
  const i = Math.floor(s + EPS);
  const t = s - i;
  if (!closed && i >= n - 1) return ring[n - 1];
  return t < EPS ? ring[((i % n) + n) % n] : lerp(ring[((i % n) + n) % n], ring[(i + 1) % n], t);
}

/** The outline from position s0 to s1 (going on round the corner of a closed outline when s1 is before s0) */
function slice(ring: Pt[], closed: boolean, s0: number, s1: number): Pt[] {
  const n = ring.length;
  const end = closed && s1 <= s0 + EPS ? s1 + n : s1;
  const out: Pt[] = [pointAt(ring, closed, s0)];
  for (let k = Math.floor(s0 + EPS) + 1; k < end - EPS; k++) out.push(ring[k % n]);
  out.push(pointAt(ring, closed, end));
  return out.filter((p, i) => i === 0 || dist(p, out[i - 1]) > 1e-9);
}

/** The part of the nearest line or outline between the two crossings around the cursor, or why there is none. */
export function planTrim(shapes: Shape[], layers: Layer[], cursor: Pt, tol: number): TrimResult {
  const visible = new Set(layers.filter((l) => l.visible).map((l) => l.name));
  const list = shapes.filter((s) => visible.has(s.layer));

  // the nearest side of any outline
  let best: { s: Shape; ri: number; seg: number; t: number; d: number } | null = null;
  for (const s of list) {
    const closed = shapeClosed(s);
    const count = s.kind === 'circle' ? 1 : s.rings.length;
    for (let ri = 0; ri < count; ri++) {
      const ring = ringOf(s, ri);
      const n = closed ? ring.length : ring.length - 1;
      for (let i = 0; i < n; i++) {
        const { t, d } = projectOnSegment(cursor, ring[i], ring[(i + 1) % ring.length]);
        if (d <= tol && (!best || d < best.d)) best = { s, ri, seg: i, t, d };
      }
    }
  }
  if (!best) return { ok: false, reason: 'Nothing under the cursor' };

  const closed = shapeClosed(best.s);
  const ring = ringOf(best.s, best.ri);
  const n = ring.length;
  const segs = closed ? n : n - 1;

  // every crossing along this outline with every other outline
  const cuts: { pos: number; pt: Pt }[] = [];
  for (const o of list) {
    const oClosed = shapeClosed(o);
    const oc = o.kind === 'circle' ? 1 : o.rings.length;
    for (let rj = 0; rj < oc; rj++) {
      if (o === best.s && rj === best.ri) continue;
      const other = ringOf(o, rj);
      const m = oClosed ? other.length : other.length - 1;
      for (let i = 0; i < segs; i++) {
        const a = ring[i], b = ring[(i + 1) % n];
        for (let j = 0; j < m; j++) {
          const x = crossing(a, b, other[j], other[(j + 1) % other.length]);
          if (x) cuts.push({ pos: i + x.t, pt: lerp(a, b, x.t) });
        }
      }
    }
  }
  cuts.sort((p, q) => p.pos - q.pos);
  const uniq: typeof cuts = [];
  for (const c of cuts) {
    const last = uniq[uniq.length - 1];
    if (last && (Math.abs(c.pos - last.pos) < 1e-7 || dist(c.pt, last.pt) < 1e-7)) continue;
    uniq.push(c);
  }
  // on a closed outline the first and last crossing may be the same point (at the start vertex)
  if (closed && uniq.length > 1 && dist(uniq[0].pt, uniq[uniq.length - 1].pt) < 1e-7) uniq.pop();

  const s0 = best.seg + best.t;
  const base = { shapeId: best.s.id, ringIndex: best.ri, cuts: uniq.map((c) => c.pt) };

  if (!closed) {
    if (!uniq.length) return { ok: false, reason: 'This line does not cross anything, so there is nothing to trim it against' };
    const bounds = [0, ...uniq.map((c) => c.pos), segs];
    const pieces: Pt[][] = [];
    let hit = -1;
    for (let k = 0; k + 1 < bounds.length; k++) {
      const piece = slice(ring, false, bounds[k], bounds[k + 1]);
      if (piece.length >= 2) { if (s0 >= bounds[k] - EPS && s0 <= bounds[k + 1] + EPS && hit < 0) hit = pieces.length; pieces.push(piece); }
    }
    if (hit < 0) return { ok: false, reason: 'Nothing under the cursor' };
    return { ok: true, plan: { ...base, remove: pieces[hit], keep: pieces.filter((_, i) => i !== hit) } };
  }

  if (uniq.length < 2) return { ok: false, reason: uniq.length ? 'This outline is crossed only once; trimming needs two crossings to cut a piece out' : 'This outline does not cross anything, so there is nothing to trim it against' };
  const pos = uniq.map((c) => c.pos);
  const pieces: { piece: Pt[]; from: number; to: number }[] = [];
  for (let k = 0; k < pos.length; k++) {
    const from = pos[k], to = pos[(k + 1) % pos.length];
    const piece = slice(ring, true, from, to);
    if (piece.length >= 2) pieces.push({ piece, from, to });
  }
  const inside = (q: { from: number; to: number }) => (q.to > q.from ? s0 >= q.from - EPS && s0 <= q.to + EPS : s0 >= q.from - EPS || s0 <= q.to + EPS);
  const hit = pieces.findIndex(inside);
  if (hit < 0) return { ok: false, reason: 'Nothing under the cursor' };
  return { ok: true, plan: { ...base, remove: pieces[hit].piece, keep: pieces.filter((_, i) => i !== hit).map((q) => q.piece) } };
}
