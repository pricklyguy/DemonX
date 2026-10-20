import type { PathShape, Pt } from './types';

/**
 * Fit smooth curves to lines made of many small segments (a traced picture, a hand-drawn or imported outline): the points are split at
 * the real corners, each run between corners is fitted with cubic Béziers that stay within `tolerance` of the original points (the
 * Schneider method), and the result is flattened again to a line at a fine tolerance. Sharp corners stay sharp. Millimetres.
 */
export interface FitOptions {
  /** How far (mm) the new curve may stray from the old points */
  tolerance: number;
  /** A turn sharper than this many degrees between neighbouring segments is a corner, kept as it is */
  cornerAngle: number;
  /** How far along the line (mm) the corner test looks; default 4 times the tolerance, at least 0.2 mm */
  window?: number;
  /** How far (mm) the flattened line may stray from the fitted curve; default 0.01 or a fifth of the tolerance */
  flat?: number;
}

type Bez = [Pt, Pt, Pt, Pt];

const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];
const add = (a: Pt, b: Pt): Pt => [a[0] + b[0], a[1] + b[1]];
const mul = (a: Pt, k: number): Pt => [a[0] * k, a[1] * k];
const dot = (a: Pt, b: Pt) => a[0] * b[0] + a[1] * b[1];
const len = (a: Pt) => Math.hypot(a[0], a[1]);
const unit = (a: Pt): Pt => { const l = len(a); return l < 1e-12 ? [0, 0] : [a[0] / l, a[1] / l]; };

function bezAt(b: Bez, t: number): Pt {
  const u = 1 - t;
  return [u * u * u * b[0][0] + 3 * u * u * t * b[1][0] + 3 * u * t * t * b[2][0] + t * t * t * b[3][0], u * u * u * b[0][1] + 3 * u * u * t * b[1][1] + 3 * u * t * t * b[2][1] + t * t * t * b[3][1]];
}
function bezD1(b: Bez, t: number): Pt {
  const u = 1 - t;
  return [3 * u * u * (b[1][0] - b[0][0]) + 6 * u * t * (b[2][0] - b[1][0]) + 3 * t * t * (b[3][0] - b[2][0]), 3 * u * u * (b[1][1] - b[0][1]) + 6 * u * t * (b[2][1] - b[1][1]) + 3 * t * t * (b[3][1] - b[2][1])];
}
function bezD2(b: Bez, t: number): Pt {
  const u = 1 - t;
  return [6 * u * (b[2][0] - 2 * b[1][0] + b[0][0]) + 6 * t * (b[3][0] - 2 * b[2][0] + b[1][0]), 6 * u * (b[2][1] - 2 * b[1][1] + b[0][1]) + 6 * t * (b[3][1] - 2 * b[2][1] + b[1][1])];
}

function chordParams(pts: Pt[]): number[] {
  const u = [0];
  for (let i = 1; i < pts.length; i++) u.push(u[i - 1] + len(sub(pts[i], pts[i - 1])));
  const total = u[u.length - 1] || 1;
  return u.map((v) => v / total);
}

function generate(pts: Pt[], u: number[], t1: Pt, t2: Pt): Bez {
  const n = pts.length;
  const first = pts[0], last = pts[n - 1];
  let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
  for (let i = 0; i < n; i++) {
    const t = u[i], s = 1 - t;
    const b1 = 3 * t * s * s, b2 = 3 * t * t * s, b0 = s * s * s, b3 = t * t * t;
    const a1 = mul(t1, b1), a2 = mul(t2, b2);
    c00 += dot(a1, a1); c01 += dot(a1, a2); c11 += dot(a2, a2);
    const tmp = sub(pts[i], add(mul(first, b0 + b1), mul(last, b2 + b3)));
    x0 += dot(a1, tmp); x1 += dot(a2, tmp);
  }
  const det = c00 * c11 - c01 * c01;
  const seg = len(sub(last, first));
  let al = Math.abs(det) > 1e-12 ? (x0 * c11 - x1 * c01) / det : 0;
  let ar = Math.abs(det) > 1e-12 ? (c00 * x1 - c01 * x0) / det : 0;
  const eps = 1e-6 * seg;
  if (al < eps || ar < eps) al = ar = seg / 3;   // the fit went wrong way: fall back on a third of the chord
  return [first, add(first, mul(t1, al)), add(last, mul(t2, ar)), last];
}

function reparam(b: Bez, pts: Pt[], u: number[]): number[] {
  return u.map((t, i) => {
    const d = sub(bezAt(b, t), pts[i]);
    const d1 = bezD1(b, t), d2 = bezD2(b, t);
    const num = dot(d, d1), den = dot(d1, d1) + dot(d, d2);
    return Math.abs(den) < 1e-12 ? t : Math.min(1, Math.max(0, t - num / den));
  });
}

function maxError(pts: Pt[], b: Bez, u: number[]): { err: number; at: number } {
  let err = 0, at = Math.floor(pts.length / 2);
  for (let i = 1; i < pts.length - 1; i++) {
    const d = len(sub(bezAt(b, u[i]), pts[i]));
    if (d >= err) { err = d; at = i; }
  }
  return { err, at };
}

function fitCubic(pts: Pt[], t1: Pt, t2: Pt, tol: number, out: Bez[], depth = 0): void {
  const n = pts.length;
  if (n === 2) {
    const d = len(sub(pts[1], pts[0])) / 3;
    out.push([pts[0], add(pts[0], mul(t1, d)), add(pts[1], mul(t2, d)), pts[1]]);
    return;
  }
  let u = chordParams(pts);
  let b = generate(pts, u, t1, t2);
  let { err, at } = maxError(pts, b, u);
  if (err < tol) { out.push(b); return; }
  if (err < tol * 4) {
    for (let k = 0; k < 4; k++) {
      u = reparam(b, pts, u);
      b = generate(pts, u, t1, t2);
      ({ err, at } = maxError(pts, b, u));
      if (err < tol) { out.push(b); return; }
    }
  }
  if (depth > 40 || n < 4) { out.push(b); return; }
  // split where it is worst, with one tangent through that point so the two halves join smoothly
  const mid = unit(sub(pts[at - 1], pts[at + 1]));
  fitCubic(pts.slice(0, at + 1), t1, mid, tol, out, depth + 1);
  fitCubic(pts.slice(at), mul(mid, -1), t2, tol, out, depth + 1);
}

/** A Bézier as a line, subdivided until it is within `flat` mm of its chord. */
function flatten(b: Bez, flat: number, out: Pt[]): void {
  const bis = (c: Bez, depth: number) => {
    const d = Math.max(distToChord(c[1], c[0], c[3]), distToChord(c[2], c[0], c[3]));
    if (d <= flat || depth > 14) { out.push(c[3]); return; }
    const m01 = mul(add(c[0], c[1]), 0.5), m12 = mul(add(c[1], c[2]), 0.5), m23 = mul(add(c[2], c[3]), 0.5);
    const a = mul(add(m01, m12), 0.5), b2 = mul(add(m12, m23), 0.5), m = mul(add(a, b2), 0.5);
    bis([c[0], m01, a, m], depth + 1);
    bis([m, b2, m23, c[3]], depth + 1);
  };
  bis(b, 0);
}
function distToChord(p: Pt, a: Pt, b: Pt): number {
  const ab = sub(b, a), l = len(ab);
  if (l < 1e-12) return len(sub(p, a));
  return Math.abs(ab[0] * (p[1] - a[1]) - ab[1] * (p[0] - a[0])) / l;
}

/** Fit one run of points (first and last stay exactly where they are). */
function fitRun(run: Pt[], tol: number, flat: number): Pt[] {
  if (run.length < 3) return run;
  const t1 = unit(sub(run[Math.min(2, run.length - 1)], run[0]));
  const t2 = unit(sub(run[Math.max(run.length - 3, 0)], run[run.length - 1]));
  const beziers: Bez[] = [];
  fitCubic(run, t1, t2, tol, beziers);
  const out: Pt[] = [run[0]];
  for (const b of beziers) flatten(b, flat, out);
  return out;
}

/**
 * The indices of the sharp corners of a ring: where the line arriving from `w` mm back and the line leaving towards a point `w` mm on
 * turn by more than `angle` degrees. Looking a little way along (not at the next point) keeps the noise of a traced line from making
 * a corner of every point; of a run of candidates only the sharpest is kept.
 */
function corners(r: Pt[], closed: boolean, angle: number, w: number): number[] {
  const n = r.length;
  const cum = [0];
  for (let i = 1; i < n; i++) cum.push(cum[i - 1] + len(sub(r[i], r[i - 1])));
  const total = cum[n - 1] + (closed ? len(sub(r[0], r[n - 1])) : 0);
  const at = (i: number, dist: number): Pt => {
    // the point `dist` mm along from vertex i (negative: back), by walking whole vertices
    let j = i, acc = 0;
    const dir = dist < 0 ? -1 : 1;
    while (acc < Math.abs(dist)) {
      const k = j + dir;
      if (k < 0 || k >= n) { if (!closed) break; }
      const kk = (k + n) % n;
      acc += len(sub(r[kk], r[j]));
      j = kk;
      if (kk === i) break;
    }
    return r[j];
  };
  const cand: { i: number; turn: number }[] = [];
  const lim = (angle * Math.PI) / 180;
  for (let i = closed ? 0 : 1; i < (closed ? n : n - 1); i++) {
    if (!closed && (cum[i] < w * 0.5 || total - cum[i] < w * 0.5)) { /* near an end: use what there is */ }
    const p = at(i, -w), q = at(i, w);
    const a = sub(r[i], p), b = sub(q, r[i]);
    if (len(a) < 1e-9 || len(b) < 1e-9) continue;
    const turn = Math.acos(Math.max(-1, Math.min(1, dot(unit(a), unit(b)))));
    if (turn > lim) cand.push({ i, turn });
  }
  // of neighbouring candidates (within w along the line) keep the sharpest
  const out: number[] = [];
  let k = 0;
  while (k < cand.length) {
    let best = cand[k], j = k + 1;
    while (j < cand.length && cum[cand[j].i] - cum[cand[j - 1].i] <= w) { if (cand[j].turn > best.turn) best = cand[j]; j++; }
    out.push(best.i);
    k = j;
  }
  return out;
}

/** Fit curves to one ring. Returns the new points (a closed ring has no repeated first point). */
export function fitRing(r: Pt[], closed: boolean, o: FitOptions): Pt[] {
  // points that sit on top of each other make a direction out of nothing
  const pts = r.filter((p, i) => i === 0 || len(sub(p, r[i - 1])) > 1e-9);
  if (closed && pts.length > 1 && len(sub(pts[0], pts[pts.length - 1])) <= 1e-9) pts.pop();
  if (pts.length < 4) return pts;
  const flat = o.flat ?? Math.min(0.01, o.tolerance / 5);
  const cs = corners(pts, closed, o.cornerAngle, o.window ?? Math.max(o.tolerance * 4, 0.2));
  if (!closed) {
    const cuts = [0, ...cs, pts.length - 1];
    const out: Pt[] = [pts[0]];
    for (let k = 0; k + 1 < cuts.length; k++) out.push(...fitRun(pts.slice(cuts[k], cuts[k + 1] + 1), o.tolerance, flat).slice(1));
    return out;
  }
  // a closed ring: start at a corner if it has one, else at two opposite points so each half is an open run
  let ring = pts, cuts: number[];
  if (cs.length) {
    ring = [...pts.slice(cs[0]), ...pts.slice(0, cs[0])];
    cuts = cs.map((c) => (c - cs[0] + pts.length) % pts.length).sort((a, b) => a - b);
  } else cuts = [0, Math.floor(pts.length / 2)];
  ring = [...ring, ring[0]];
  cuts = [...cuts, ring.length - 1];
  const out: Pt[] = [];
  for (let k = 0; k + 1 < cuts.length; k++) {
    const piece = fitRun(ring.slice(cuts[k], cuts[k + 1] + 1), o.tolerance, flat);
    out.push(...(k === 0 ? piece : piece.slice(1)));
  }
  out.pop();   // the last point is the first again
  return out;
}

export function fitShape(s: PathShape, o: FitOptions): PathShape {
  return { ...s, rings: s.rings.map((r) => fitRing(r, s.closed, o)) };
}
