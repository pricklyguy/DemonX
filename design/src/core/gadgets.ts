/**
 * Helpers for the workflow tools carried over from the VCarve gadgets (pixel-prop layouts and the like).
 * Everything here is plain geometry on millimetres; the commands that use it live in commands.ts.
 */
import type { Bounds } from './geom';
import { shapeBounds, shapeRings } from './geom';
import type { Pt, Shape } from './types';

/** The point a shape is held by: a circle's centre, otherwise the middle of its box. */
export function anchorOf(s: Shape): Pt {
  if (s.kind === 'circle') return [s.cx, s.cy];
  const b = shapeBounds(s)!;
  return [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];
}

/** A template's anchor: the first circle in it if there is one (the "pixel"), else the middle of the whole template. */
export function templateAnchor(shapes: Shape[]): Pt {
  const c = shapes.find((s) => s.kind === 'circle');
  if (c) return anchorOf(c);
  let b: Bounds | null = null;
  for (const s of shapes) {
    const sb = shapeBounds(s)!;
    b = b ? { minX: Math.min(b.minX, sb.minX), minY: Math.min(b.minY, sb.minY), maxX: Math.max(b.maxX, sb.maxX), maxY: Math.max(b.maxY, sb.maxY) } : sb;
  }
  return [(b!.minX + b!.maxX) / 2, (b!.minY + b!.maxY) / 2];
}

// ---- guide curves -------------------------------------------------------------------------------------------

export interface Guide { pts: Pt[]; cum: number[]; length: number }

/** The guide as one polyline with the distance along it at every vertex. A closed outline is walked once round. */
export function buildGuide(s: Shape): Guide | null {
  const ring = shapeRings(s)[0];
  if (!ring || ring.length < 2) return null;
  const pts = ring.map((p) => [p[0], p[1]] as Pt);
  const closed = s.kind === 'circle' || s.closed;
  if (closed) pts.push([pts[0][0], pts[0][1]]);
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const length = cum[cum.length - 1];
  return length > 1e-9 ? { pts, cum, length } : null;
}

/** Where along the guide is the point nearest to p? */
export function nearestOnGuide(g: Guide, p: Pt): number {
  let best = Infinity, bestS = 0;
  for (let i = 1; i < g.pts.length; i++) {
    const [ax, ay] = g.pts[i - 1], [bx, by] = g.pts[i];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 < 1e-18 ? 0 : Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / len2));
    const d = Math.hypot(ax + t * dx - p[0], ay + t * dy - p[1]);
    if (d < best - 1e-12) { best = d; bestS = g.cum[i - 1] + t * Math.sqrt(len2); }
  }
  return bestS;
}

export function pointOnGuide(g: Guide, s: number): Pt {
  const d = Math.max(0, Math.min(g.length, s));
  let i = 1;
  while (i < g.cum.length - 1 && g.cum[i] < d) i++;
  const seg = g.cum[i] - g.cum[i - 1];
  const t = seg < 1e-12 ? 0 : (d - g.cum[i - 1]) / seg;
  return [g.pts[i - 1][0] + t * (g.pts[i][0] - g.pts[i - 1][0]), g.pts[i - 1][1] + t * (g.pts[i][1] - g.pts[i - 1][1])];
}

// ---- matching shapes ----------------------------------------------------------------------------------------

const SAMPLES = 128;

interface Signature { kind: 'circle' | 'closed' | 'open'; r?: number; rings: number; profile: number[]; perimeter: number; area: number; centre: Pt }

function resample(ring: Pt[], closed: boolean): Pt[] {
  const pts = ring.map((p) => [p[0], p[1]] as Pt);
  if (closed) pts.push([pts[0][0], pts[0][1]]);
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = cum[cum.length - 1];
  const n = closed ? SAMPLES : SAMPLES + 1;
  const out: Pt[] = [];
  let j = 1;
  for (let k = 0; k < n; k++) {
    const d = (total * k) / (closed ? SAMPLES : SAMPLES);
    while (j < cum.length - 1 && cum[j] < d) j++;
    const seg = cum[j] - cum[j - 1];
    const t = seg < 1e-12 ? 0 : (d - cum[j - 1]) / seg;
    out.push([pts[j - 1][0] + t * (pts[j][0] - pts[j - 1][0]), pts[j - 1][1] + t * (pts[j][1] - pts[j - 1][1])]);
  }
  return out;
}

function ringArea(r: Pt[]): number {
  let a = 0;
  for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; a += p[0] * q[1] - q[0] * p[1]; }
  return Math.abs(a) / 2;
}

/** Position, turning and where the outline starts do not matter; size does. */
function signature(s: Shape): Signature {
  if (s.kind === 'circle') return { kind: 'circle', r: s.r, rings: 1, profile: [], perimeter: 2 * Math.PI * s.r, area: Math.PI * s.r * s.r, centre: [s.cx, s.cy] };
  const rings = s.rings;
  const first = rings[0];
  const closed = s.closed;
  const pts = resample(first, closed);
  const cx = pts.reduce((n, p) => n + p[0], 0) / pts.length;
  const cy = pts.reduce((n, p) => n + p[1], 0) / pts.length;
  const profile = pts.map((p) => Math.hypot(p[0] - cx, p[1] - cy));
  let perimeter = 0;
  for (const r of rings) for (let i = 1; i < r.length + (closed ? 1 : 0); i++) { const a = r[i - 1], b = r[i % r.length]; perimeter += Math.hypot(b[0] - a[0], b[1] - a[1]); }
  const area = closed ? rings.reduce((n, r, i) => n + (i === 0 ? 1 : -1) * ringArea(r), 0) : 0;
  return { kind: closed ? 'closed' : 'open', rings: rings.length, profile, perimeter, area: Math.abs(area), centre: [cx, cy] };
}

function profilesMatch(a: number[], b: number[], cyclic: boolean, tol: number): boolean {
  const n = a.length;
  const shifts = cyclic ? n : 1;
  for (const rev of [false, true]) {
    for (let sh = 0; sh < shifts; sh++) {
      let ok = true;
      for (let i = 0; i < n && ok; i++) {
        const j = rev ? (cyclic ? (((sh - i) % n) + n) % n : n - 1 - i) : (i + sh) % n;
        if (Math.abs(a[i] - b[j]) > tol) ok = false;
      }
      if (ok) return true;
    }
  }
  return false;
}

export interface MatchResult { matches: number[]; overlapping: number[] }

/** Which of `candidates` are the same shape as `reference` (same size, however placed, turned or started). */
export function findMatches(reference: Shape, candidates: Shape[]): MatchResult {
  const ref = signature(reference);
  const matches: number[] = [];
  const seen: Pt[] = [];
  const overlapping: number[] = [];
  const near = (a: number, b: number, rel: number, abs: number) => Math.abs(a - b) <= Math.max(abs, rel * Math.max(a, b));
  for (const c of candidates) {
    const sig = signature(c);
    if (sig.kind !== ref.kind || sig.rings !== ref.rings) continue;
    if (!near(sig.perimeter, ref.perimeter, 0.01, 0.02) || !near(sig.area, ref.area, 0.015, 0.02)) continue;
    if (sig.kind === 'circle' && !near(sig.r!, ref.r!, 0.005, 0.01)) continue;
    if (sig.kind !== 'circle') {
      const tol = (ref.perimeter / SAMPLES) * 0.6 + 0.03;
      if (!profilesMatch(ref.profile, sig.profile, sig.kind === 'closed', tol)) continue;
    }
    matches.push(c.id);
    if (seen.some((p) => Math.hypot(p[0] - sig.centre[0], p[1] - sig.centre[1]) < 0.01)) overlapping.push(c.id);
    seen.push(sig.centre);
  }
  return { matches, overlapping };
}

// ---- digits -------------------------------------------------------------------------------------------------

// seven-segment strokes on a unit square, as in the VCarve gadget
const SEG: Record<string, [number, number, number, number]> = {
  a: [0, 1, 1, 1], b: [1, 1, 1, 0.5], c: [1, 0.5, 1, 0], d: [0, 0, 1, 0], e: [0, 0, 0, 0.5], f: [0, 0.5, 0, 1], g: [0, 0.5, 1, 0.5],
};
const DIGITS: Record<string, string> = { '0': 'abcdef', '1': 'bc', '2': 'abged', '3': 'abgcd', '4': 'fgbc', '5': 'afgcd', '6': 'afgecd', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg' };

/** The number as a set of line strokes, centred on (cx, cy). Each stroke is a two-point ring. */
export function numberStrokes(n: number, cx: number, cy: number, height: number): Pt[][] {
  const text = String(Math.trunc(Math.abs(n)));
  const w = height * 0.6, gap = height * 0.15;
  const total = text.length * w + (text.length - 1) * gap;
  const x0 = cx - total / 2, y0 = cy - height / 2;
  const out: Pt[][] = [];
  [...text].forEach((ch, i) => {
    const ox = x0 + i * (w + gap);
    for (const name of DIGITS[ch] ?? '') {
      const [x1, y1, x2, y2] = SEG[name];
      out.push([[ox + x1 * w, y0 + y1 * height], [ox + x2 * w, y0 + y2 * height]]);
    }
  });
  return out;
}
