import type { Pt, Shape } from './types';

/** Max distance between a true circle and its straight-line approximation, in mm. */
export const FLATTEN_TOLERANCE = 0.01;

export function circleSegments(r: number, tol = FLATTEN_TOLERANCE): number {
  if (r <= tol) return 8;
  const n = Math.ceil(Math.PI / Math.acos(1 - tol / r));
  // a multiple of 4 puts a point at each of left, right, top and bottom, so the polygon is exactly as wide as the circle
  return Math.min(720, Math.max(16, Math.ceil(n / 4) * 4));
}

export function circleRing(cx: number, cy: number, r: number, tol = FLATTEN_TOLERANCE): Pt[] {
  const n = circleSegments(r, tol);
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return out;
}

/** An arc from a0 to a1 (radians, counter-clockwise when a1 > a0), flattened. Includes both ends. */
export function arcPoints(cx: number, cy: number, r: number, a0: number, a1: number, tol = FLATTEN_TOLERANCE): Pt[] {
  let sweep = a1 - a0;
  const step = (Math.PI * 2) / circleSegments(r, tol);
  const n = Math.max(1, Math.ceil(Math.abs(sweep) / step));
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + (sweep * i) / n;
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return out;
}

export function shapeRings(s: Shape): Pt[][] {
  return s.kind === 'circle' ? [circleRing(s.cx, s.cy, s.r)] : s.rings;
}

export function shapeClosed(s: Shape): boolean {
  return s.kind === 'circle' ? true : s.closed;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function shapeBounds(s: Shape): Bounds | null {
  if (s.kind === 'circle') return { minX: s.cx - s.r, minY: s.cy - s.r, maxX: s.cx + s.r, maxY: s.cy + s.r };
  return pointsBounds(s.rings.flat());
}

export function pointsBounds(pts: Pt[]): Bounds | null {
  if (!pts.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

export function unionBounds(list: (Bounds | null)[]): Bounds | null {
  let out: Bounds | null = null;
  for (const b of list) {
    if (!b) continue;
    out = out ? { minX: Math.min(out.minX, b.minX), minY: Math.min(out.minY, b.minY), maxX: Math.max(out.maxX, b.maxX), maxY: Math.max(out.maxY, b.maxY) } : { ...b };
  }
  return out;
}

/** Signed area: positive for counter-clockwise rings. */
export function ringArea(r: Pt[]): number {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]);
  return a / 2;
}

/** Area of the filled shape (even-odd over its rings). 0 for open paths. */
export function shapeArea(s: Shape): number {
  if (s.kind === 'circle') return Math.PI * s.r * s.r;
  if (!s.closed) return 0;
  // Holes are nested rings; with the usual clean output the sum of signed areas is right only when orientations
  // are consistent, so classify by nesting depth instead.
  let total = 0;
  for (const ring of s.rings) {
    const depth = s.rings.reduce((d, other) => (other !== ring && pointInRing(ring[0], other) ? d + 1 : d), 0);
    total += (depth % 2 === 0 ? 1 : -1) * Math.abs(ringArea(ring));
  }
  return total;
}

export function pointInRing(p: Pt, ring: Pt[]): boolean {
  let inside = false;
  const [x, y] = p;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Distance from p to the outline of the shape (not its inside). */
export function distToShapeOutline(p: Pt, s: Shape): number {
  if (s.kind === 'circle') return Math.abs(Math.hypot(p[0] - s.cx, p[1] - s.cy) - s.r);
  let best = Infinity;
  for (const ring of s.rings) {
    const n = s.closed ? ring.length : ring.length - 1;
    for (let i = 0; i < n; i++) best = Math.min(best, distToSegment(p, ring[i], ring[(i + 1) % ring.length]));
    if (ring.length === 1) best = Math.min(best, Math.hypot(p[0] - ring[0][0], p[1] - ring[0][1]));
  }
  return best;
}

export function pointInShape(p: Pt, s: Shape): boolean {
  if (s.kind === 'circle') return Math.hypot(p[0] - s.cx, p[1] - s.cy) <= s.r;
  if (!s.closed) return false;
  let inside = false;
  for (const ring of s.rings) if (pointInRing(p, ring)) inside = !inside;
  return inside;
}

export function translateShape<T extends Shape>(s: T, dx: number, dy: number): T {
  if (s.kind === 'circle') return { ...s, cx: s.cx + dx, cy: s.cy + dy };
  return { ...s, rings: s.rings.map((r) => r.map(([x, y]) => [x + dx, y + dy] as Pt)) };
}

// ---- transforms ---------------------------------------------------------------------------------------------

/** [a, b, c, d, e, f]: x' = a x + c y + e,  y' = b x + d y + f */
export type Matrix = [number, number, number, number, number, number];

export const scaleAbout = (sx: number, sy: number, [px, py]: Pt): Matrix => [sx, 0, 0, sy, px - sx * px, py - sy * py];

export function rotateAbout(deg: number, [px, py]: Pt): Matrix {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  return [c, s, -s, c, px - c * px + s * py, py - s * px - c * py];
}

const apply = (m: Matrix, [x, y]: Pt): Pt => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/**
 * Move, scale, rotate or mirror a shape. A circle stays a circle when the change keeps it round (any rotation, an even
 * scale, a mirror); an uneven stretch turns it into an ellipse, which is stored as a many-sided closed path.
 */
export function transformShape(s: Shape, m: Matrix): Shape {
  if (s.kind === 'circle') {
    const sx = Math.hypot(m[0], m[1]);
    const sy = Math.hypot(m[2], m[3]);
    const orthogonal = Math.abs(m[0] * m[2] + m[1] * m[3]) <= 1e-9 * sx * sy;
    if (orthogonal && Math.abs(sx - sy) <= 1e-9 * Math.max(sx, sy)) {
      const [cx, cy] = apply(m, [s.cx, s.cy]);
      return { ...s, cx, cy, r: s.r * sx };
    }
    return { id: s.id, kind: 'path', layer: s.layer, closed: true, rings: [circleRing(s.cx, s.cy, s.r).map((p) => apply(m, p))] };
  }
  return { ...s, rings: s.rings.map((ring) => ring.map((p) => apply(m, p))) };
}

export type Anchor = 'tl' | 'tc' | 'tr' | 'ml' | 'c' | 'mr' | 'bl' | 'bc' | 'br';

/** A point on a bounding box. Top means larger Y, because Y points up. */
export function anchorPoint(b: Bounds, a: Anchor): Pt {
  const x = a.endsWith('l') ? b.minX : a.endsWith('r') ? b.maxX : (b.minX + b.maxX) / 2;
  const y = a.startsWith('t') ? b.maxY : a.startsWith('b') ? b.minY : (b.minY + b.maxY) / 2;
  return [x, y];
}

/** The lower-left corner (the drawing's Y points up) of a w x h rectangle whose `anchor` point is at (px, py) */
export function rectOrigin(r: { w: number; h: number; anchor: Anchor }, px: number, py: number): Pt {
  const fx = r.anchor.endsWith('l') ? 0 : r.anchor.endsWith('r') ? 1 : 0.5;
  const fy = r.anchor.startsWith('b') ? 0 : r.anchor.startsWith('t') ? 1 : 0.5;
  return [Math.round((px - fx * r.w) * 1000) / 1000, Math.round((py - fy * r.h) * 1000) / 1000];
}

/** Flip across a vertical ("horizontal" flip) or horizontal line through the point. */
export function mirrorMatrix(axis: 'horizontal' | 'vertical', [px, py]: Pt): Matrix {
  return axis === 'horizontal' ? [-1, 0, 0, 1, 2 * px, 0] : [1, 0, 0, -1, 0, 2 * py];
}

/** The smallest convex polygon round the points, anticlockwise (Y up). Fewer than three distinct points give what there is. */
export function convexHull(points: Pt[]): Pt[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]).filter((p, i, all) => !i || p[0] !== all[i - 1][0] || p[1] !== all[i - 1][1]);
  if (pts.length < 3) return pts;
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const build = (list: Pt[]) => {
    const out: Pt[] = [];
    for (const p of list) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...build(pts), ...build([...pts].reverse())];
}
