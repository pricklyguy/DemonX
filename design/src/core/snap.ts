// Object snap: the points on existing shapes that the cursor jumps to while drawing or moving, with a marker so you
// can see what you are about to click: a square for an end or corner, a circle for a centre, a triangle for a middle,
// an X where two shapes cross.
import type { Layer, Pt, Shape } from './types';
import { shapeBounds, shapeClosed, shapeRings, unionBounds, type Bounds } from './geom';

export type SnapKind = 'endpoint' | 'center' | 'midpoint' | 'intersection';

export interface SnapHit { pt: Pt; kind: SnapKind }

export const SNAP_LABEL: Record<SnapKind, string> = { endpoint: 'Endpoint', center: 'Center', midpoint: 'Midpoint', intersection: 'Intersection' };

const RANK: Record<SnapKind, number> = { endpoint: 0, center: 1, midpoint: 2, intersection: 3 };
/** A drawn polygon has few points; a flattened circle or arc has dozens that are not corners */
const FEW_POINTS = 12;
const SHARP_DEG = 20;

const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const near = (b: Bounds, p: Pt, r: number) => p[0] >= b.minX - r && p[0] <= b.maxX + r && p[1] >= b.minY - r && p[1] <= b.maxY + r;

/** Is this vertex a real corner (not just one of many points along a curve)? */
function isCorner(prev: Pt, p: Pt, next: Pt): boolean {
  const a1 = Math.atan2(p[1] - prev[1], p[0] - prev[0]);
  const a2 = Math.atan2(next[1] - p[1], next[0] - p[0]);
  let d = Math.abs(a2 - a1);
  if (d > Math.PI) d = 2 * Math.PI - d;
  return (d * 180) / Math.PI >= SHARP_DEG;
}

/** The snap points of one shape: ends and corners, middles of the sides of a simple shape, and the centre. */
export function shapeSnapPoints(s: Shape): SnapHit[] {
  const out: SnapHit[] = [];
  if (s.kind === 'circle') return [{ pt: [s.cx, s.cy], kind: 'center' }, ...[0, 90, 180, 270].map((d) => ({ pt: [s.cx + s.r * Math.cos((d * Math.PI) / 180), s.cy + s.r * Math.sin((d * Math.PI) / 180)] as Pt, kind: 'endpoint' as const }))];
  const closed = shapeClosed(s);
  for (const ring of s.rings) {
    const n = ring.length;
    const simple = n <= FEW_POINTS;
    for (let i = 0; i < n; i++) {
      const p = ring[i];
      const open = !closed;
      const isEnd = open && (i === 0 || i === n - 1);
      const corner = simple || isEnd || (n >= 3 && isCorner(ring[(i + n - 1) % n], p, ring[(i + 1) % n]));
      if (corner) out.push({ pt: p, kind: 'endpoint' });
      if (simple) {
        const j = i + 1 < n ? i + 1 : closed ? 0 : -1;
        if (j >= 0) out.push({ pt: [(p[0] + ring[j][0]) / 2, (p[1] + ring[j][1]) / 2], kind: 'midpoint' });
      }
    }
  }
  const b = shapeBounds(s);
  if (b && closed) out.push({ pt: [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2], kind: 'center' });
  return out;
}

/** The centre of the box around these shapes: the point to align by. */
export function selectionCenter(shapes: Shape[]): Pt | null {
  const b = unionBounds(shapes.map(shapeBounds));
  return b ? [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2] : null;
}

function segmentsNear(s: Shape, window: Bounds): [Pt, Pt][] {
  const out: [Pt, Pt][] = [];
  const closed = shapeClosed(s);
  const rings = shapeRings(s);
  for (const ring of rings) {
    const n = closed ? ring.length : ring.length - 1;
    for (let i = 0; i < n; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      if (Math.max(a[0], b[0]) < window.minX || Math.min(a[0], b[0]) > window.maxX || Math.max(a[1], b[1]) < window.minY || Math.min(a[1], b[1]) > window.maxY) continue;
      out.push([a, b]);
    }
  }
  return out;
}

export function segmentIntersection(a: Pt, b: Pt, c: Pt, d: Pt): Pt | null {
  const r: Pt = [b[0] - a[0], b[1] - a[1]];
  const s: Pt = [d[0] - c[0], d[1] - c[1]];
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-12) return null; // parallel
  const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den;
  const u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den;
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
  return [a[0] + t * r[0], a[1] + t * r[1]];
}

export interface SnapOptions {
  layers: Layer[];
  /** Shapes that must not attract the cursor (the ones being moved) */
  exclude?: Set<number>;
  /** Only these shapes count (used to find the point of the moved shapes that the cursor is holding) */
  only?: Set<number>;
  /** The selected shapes: their joint centre is a snap point too (unless excluded) */
  selection?: number[];
  kinds?: Partial<Record<SnapKind, boolean>>;
}

/**
 * The nearest snap point within `radius` (mm) of the cursor, or null. Closest wins; at the same distance an end or
 * corner beats a centre, a centre beats a middle, a middle beats a crossing.
 */
export function findSnap(shapes: Shape[], cursor: Pt, radius: number, opts: SnapOptions): SnapHit | null {
  const visible = new Set(opts.layers.filter((l) => l.visible).map((l) => l.name));
  const want = (k: SnapKind) => opts.kinds?.[k] !== false;
  const candidates = shapes.filter((s) => {
    if (!visible.has(s.layer) || opts.exclude?.has(s.id) || (opts.only && !opts.only.has(s.id))) return false;
    const b = shapeBounds(s);
    return !!b && near(b, cursor, radius);
  });
  const hits: SnapHit[] = [];
  for (const s of candidates) for (const h of shapeSnapPoints(s)) if (want(h.kind) && dist(h.pt, cursor) <= radius) hits.push(h);

  if (opts.selection && opts.selection.length > 0 && want('center')) {
    const picked = shapes.filter((s) => opts.selection!.includes(s.id) && !opts.exclude?.has(s.id));
    const c = picked.length ? selectionCenter(picked) : null;
    if (c && dist(c, cursor) <= radius) hits.push({ pt: c, kind: 'center' });
  }

  if (want('intersection') && candidates.length > 1) {
    const win: Bounds = { minX: cursor[0] - radius, maxX: cursor[0] + radius, minY: cursor[1] - radius, maxY: cursor[1] + radius };
    const segs = candidates.map((s) => segmentsNear(s, win));
    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        for (const [a, b] of segs[i]) for (const [c, d] of segs[j]) {
          const p = segmentIntersection(a, b, c, d);
          if (p && dist(p, cursor) <= radius) hits.push({ pt: p, kind: 'intersection' });
        }
      }
    }
  }

  let best: SnapHit | null = null;
  let bestD = Infinity;
  for (const h of hits) {
    const d = dist(h.pt, cursor);
    if (d < bestD - 1e-9 || (Math.abs(d - bestD) <= 1e-9 && best && RANK[h.kind] < RANK[best.kind])) { best = h; bestD = d; }
  }
  return best;
}

