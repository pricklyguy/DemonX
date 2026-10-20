/** Editing the points of a path, and rounding or cutting its corners. Millimetres, Y up, plain geometry. */
import type { PathShape, Pt } from './types';

export interface NodeRef { ring: number; i: number }
export type CornerStyle = 'round' | 'cove' | 'chamfer';
export const CORNER_STYLES: CornerStyle[] = ['round', 'cove', 'chamfer'];

export class NodeError extends Error {}

const minPoints = (s: PathShape) => (s.closed ? 3 : 2);

function checkRefs(s: PathShape, nodes: NodeRef[]): NodeRef[] {
  if (!nodes.length) throw new NodeError('Pick at least one node first');
  for (const n of nodes) {
    if (!Number.isInteger(n.ring) || !Number.isInteger(n.i) || !s.rings[n.ring] || n.i < 0 || n.i >= s.rings[n.ring].length) throw new NodeError('That node does not exist');
  }
  return nodes;
}

export function moveNodes(s: PathShape, nodes: NodeRef[], dx: number, dy: number): PathShape {
  checkRefs(s, nodes);
  const key = new Set(nodes.map((n) => `${n.ring}:${n.i}`));
  return { ...s, rings: s.rings.map((r, ri) => r.map((p, i) => (key.has(`${ri}:${i}`) ? ([p[0] + dx, p[1] + dy] as Pt) : p))) };
}

/** A new node on the segment that starts at node `after` (on a closed path the last node's segment runs back to the first). */
export function insertNode(s: PathShape, ring: number, after: number, at?: Pt): { shape: PathShape; index: number } {
  const r = s.rings[ring];
  if (!r || after < 0 || after >= r.length) throw new NodeError('That segment does not exist');
  if (!s.closed && after === r.length - 1) throw new NodeError('An open path has no segment after its last node');
  const a = r[after], b = r[(after + 1) % r.length];
  const p: Pt = at ?? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const next = r.slice();
  next.splice(after + 1, 0, p);
  return { shape: { ...s, rings: s.rings.map((x, i) => (i === ring ? next : x)) }, index: after + 1 };
}

/** The middle of every segment whose two ends are both picked. Returns the new shape and where the new nodes landed. */
export function insertMidpoints(s: PathShape, nodes: NodeRef[]): { shape: PathShape; added: NodeRef[] } {
  checkRefs(s, nodes);
  const picked = new Set(nodes.map((n) => `${n.ring}:${n.i}`));
  const rings: Pt[][] = [];
  const added: NodeRef[] = [];
  s.rings.forEach((r, ri) => {
    const out: Pt[] = [];
    r.forEach((p, i) => {
      out.push(p);
      const last = i === r.length - 1;
      if ((last && !s.closed) || !picked.has(`${ri}:${i}`)) return;
      const j = (i + 1) % r.length;
      if (!picked.has(`${ri}:${j}`)) return;
      if (r.length === 2 && i === 1) return; // a two-point line has one segment, not two
      const q = r[j];
      added.push({ ring: ri, i: out.length });
      out.push([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]);
    });
    rings.push(out);
  });
  if (!added.length) throw new NodeError('Pick two nodes next to each other to put a node between them');
  // positions were recorded as they were laid out, so nothing to shift
  return { shape: { ...s, rings }, added };
}

export function deleteNodes(s: PathShape, nodes: NodeRef[]): PathShape {
  checkRefs(s, nodes);
  const gone = new Set(nodes.map((n) => `${n.ring}:${n.i}`));
  const rings = s.rings.map((r, ri) => r.filter((_, i) => !gone.has(`${ri}:${i}`)));
  if (rings.some((r) => r.length < minPoints(s))) throw new NodeError(`That leaves too few points (a ${s.closed ? 'closed shape needs 3' : 'line needs 2'}). Delete the shape instead.`);
  return { ...s, rings };
}

/** Cut a path open at a node. A closed outline becomes an open line that starts and ends there; an open line becomes two. */
export function breakAt(s: PathShape, ring: number, i: number): PathShape[] {
  if (s.rings.length !== 1) throw new NodeError('Only a path made of a single outline can be broken open');
  const r = s.rings[0];
  if (ring !== 0 || i < 0 || i >= r.length) throw new NodeError('That node does not exist');
  if (s.closed) {
    const rot = [...r.slice(i), ...r.slice(0, i), r[i]];
    return [{ ...s, closed: false, rings: [rot] }];
  }
  if (i === 0 || i === r.length - 1) throw new NodeError('Pick a node in the middle of the line to split it');
  return [{ ...s, rings: [r.slice(0, i + 1)] }, { ...s, rings: [r.slice(i)] }];
}

export function setClosed(s: PathShape, closed: boolean): PathShape {
  if (s.closed === closed) return s;
  if (s.rings.length !== 1) throw new NodeError('Only a path made of a single outline can be closed or opened');
  let r = s.rings[0];
  if (closed) {
    if (r.length > 3 && Math.hypot(r[0][0] - r[r.length - 1][0], r[0][1] - r[r.length - 1][1]) < 1e-9) r = r.slice(0, -1);
    if (r.length < 3) throw new NodeError('A closed shape needs at least three points');
  }
  return { ...s, closed, rings: [r] };
}

// ---- corners ------------------------------------------------------------------------------------------------

const ARC_TOL = 0.01;

export interface FilletResult { shape: PathShape; corners: number; capped: number }

/**
 * Round (arc tangent to both sides), cove (a quarter-circle-style scoop centred on the corner, the "inside" corner that
 * lets a square part drop into a round-cornered pocket) or chamfer the corners of a path. Without `only`, every corner
 * is treated. The size is limited to half of each side so neighbouring corners never collide; `capped` counts the
 * corners that were limited.
 */
export function filletPath(s: PathShape, radius: number, style: CornerStyle, only?: NodeRef[]): FilletResult {
  if (!(radius > 0) || !Number.isFinite(radius)) throw new NodeError('The radius must be greater than 0');
  const want = only ? new Set(only.map((n) => `${n.ring}:${n.i}`)) : null;
  let corners = 0, capped = 0;
  const rings = s.rings.map((r0, ri) => {
    // a closed outline that repeats its first point at the end (imported from a drawing file, or joined from lines) has that corner once
    const dup = s.closed && r0.length > 3 && Math.hypot(r0[0][0] - r0[r0.length - 1][0], r0[0][1] - r0[r0.length - 1][1]) < 1e-9;
    const r = dup ? r0.slice(0, -1) : r0;
    const n = r.length;
    const out: Pt[] = [];
    for (let i = 0; i < n; i++) {
      const V = r[i];
      const inner = s.closed || (i > 0 && i < n - 1);
      const asked = !want || want.has(`${ri}:${i}`) || (dup && i === 0 && want.has(`${ri}:${r0.length - 1}`));
      if (!inner || !asked || n < 3) { out.push(V); continue; }
      const P = r[(i - 1 + n) % n], N = r[(i + 1) % n];
      const l1 = Math.hypot(P[0] - V[0], P[1] - V[1]), l2 = Math.hypot(N[0] - V[0], N[1] - V[1]);
      if (l1 < 1e-9 || l2 < 1e-9) { out.push(V); continue; }
      const u1: Pt = [(P[0] - V[0]) / l1, (P[1] - V[1]) / l1], u2: Pt = [(N[0] - V[0]) / l2, (N[1] - V[1]) / l2];
      const cos = Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1]));
      const theta = Math.acos(cos); // the angle between the two sides at the corner
      if (theta < 1e-3 || theta > Math.PI - 1e-3) { out.push(V); continue; } // a straight run or a spike: nothing to round
      const room = Math.min(l1, l2) / 2;
      let t = style === 'round' ? radius / Math.tan(theta / 2) : radius; // how far along each side the curve starts
      if (t > room) { t = room; capped++; }
      corners++;
      const A: Pt = [V[0] + u1[0] * t, V[1] + u1[1] * t], B: Pt = [V[0] + u2[0] * t, V[1] + u2[1] * t];
      if (style === 'chamfer') { out.push(A, B); continue; }
      let cx: number, cy: number, rad: number;
      if (style === 'round') {
        rad = t * Math.tan(theta / 2);
        const bis: Pt = [u1[0] + u2[0], u1[1] + u2[1]];
        const bl = Math.hypot(bis[0], bis[1]);
        const d = rad / Math.sin(theta / 2);
        cx = V[0] + (bis[0] / bl) * d; cy = V[1] + (bis[1] / bl) * d;
      } else { cx = V[0]; cy = V[1]; rad = t; }
      const a0 = Math.atan2(A[1] - cy, A[0] - cx);
      let da = Math.atan2(B[1] - cy, B[0] - cx) - a0;
      while (da > Math.PI) da -= 2 * Math.PI;
      while (da < -Math.PI) da += 2 * Math.PI;
      const step = 2 * Math.acos(Math.max(0, 1 - ARC_TOL / rad));
      const seg = Math.max(2, Math.ceil(Math.abs(da) / Math.max(step, 0.01)));
      for (let k = 0; k <= seg; k++) {
        const a = a0 + (da * k) / seg;
        out.push(k === 0 ? A : k === seg ? B : [cx + rad * Math.cos(a), cy + rad * Math.sin(a)]);
      }
    }
    return out;
  });
  if (!corners) throw new NodeError('There is no corner to ' + (style === 'round' ? 'round' : style === 'cove' ? 'scoop' : 'chamfer'));
  return { shape: { ...s, rings }, corners, capped };
}

// ---- joining open lines ---------------------------------------------------------------------------------------

export type JoinMode = 'line' | 'curve' | 'move';
export const JOIN_MODES: JoinMode[] = ['line', 'curve', 'move'];

const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** A smooth cubic curve from a to b that leaves a along `ta` and arrives at b along `tb` (unit directions), as short lines. */
function smoothBetween(a: Pt, ta: Pt, b: Pt, tb: Pt): Pt[] {
  const d = dist(a, b);
  const k = d / 3;
  const c1: Pt = [a[0] + ta[0] * k, a[1] + ta[1] * k], c2: Pt = [b[0] - tb[0] * k, b[1] - tb[1] * k];
  const n = Math.max(4, Math.min(60, Math.ceil(d / 0.3)));
  const out: Pt[] = [];
  for (let i = 1; i < n; i++) {
    const t = i / n, u = 1 - t;
    out.push([u * u * u * a[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * b[0], u * u * u * a[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * b[1]]);
  }
  return out;
}

const unit = (from: Pt, to: Pt): Pt => {
  const l = dist(from, to);
  return l < 1e-12 ? [1, 0] : [(to[0] - from[0]) / l, (to[1] - from[1]) / l];
};

/** What goes between end `a` (arriving along ta) and start `b` (leaving along tb). Both end points are included by the caller. */
function bridge(a: Pt, ta: Pt, b: Pt, tb: Pt, mode: JoinMode): { a: Pt; between: Pt[]; b: Pt } {
  if (mode === 'move') { const m: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; return { a: m, between: [], b: m }; }
  if (mode === 'curve' && dist(a, b) > 1e-9) return { a, between: smoothBetween(a, ta, b, tb), b };
  return { a, between: [], b };
}

/**
 * Join open lines into one. With several lines the two nearest ends are joined first, and so on until one is left.
 * With a single line its own two ends are joined, which closes it. "line" joins with a straight segment, "curve" with a
 * smooth one that follows the direction of both lines, "move" moves both end points to their middle.
 */
export function joinPaths(shapes: PathShape[], mode: JoinMode): PathShape {
  if (!shapes.length) throw new NodeError('Pick the lines to join');
  for (const s of shapes) if (s.closed || s.rings.length !== 1) throw new NodeError('Only open lines can be joined (an outline is already closed)');
  let pool = shapes.map((s) => s.rings[0].map((p) => [p[0], p[1]] as Pt));
  const first = shapes[0];

  if (pool.length === 1) {
    const r = pool[0];
    if (r.length < 3) throw new NodeError('A closed shape needs at least three points');
    const n = r.length;
    const br = bridge(r[n - 1], unit(r[n - 2], r[n - 1]), r[0], unit(r[0], r[1]), mode);
    const ring = [br.b, ...r.slice(1, -1), br.a, ...br.between];
    if (mode !== 'move') { const plain = [...r]; if (dist(r[0], r[n - 1]) < 1e-9) plain.pop(); return { ...first, closed: true, rings: [mode === 'curve' ? [...r, ...br.between] : plain] }; }
    return { ...first, closed: true, rings: [ring] };
  }

  while (pool.length > 1) {
    let best = { d: Infinity, i: 0, j: 1, ei: 0, ej: 0 };
    for (let i = 0; i < pool.length; i++) for (let j = i + 1; j < pool.length; j++) for (const ei of [0, 1]) for (const ej of [0, 1]) {
      const d = dist(ei ? pool[i][pool[i].length - 1] : pool[i][0], ej ? pool[j][pool[j].length - 1] : pool[j][0]);
      if (d < best.d - 1e-12) best = { d, i, j, ei, ej };
    }
    // orient so the first line arrives at the join and the second leaves it
    const A = best.ei ? pool[best.i] : [...pool[best.i]].reverse();
    const B = best.ej ? [...pool[best.j]].reverse() : pool[best.j];
    const n = A.length;
    const br = bridge(A[n - 1], unit(A[n - 2], A[n - 1]), B[0], unit(B[0], B[1]), mode);
    const merged = [...A.slice(0, -1), br.a, ...br.between, ...(mode === 'move' ? [] : [br.b]), ...B.slice(1)];
    const dedup = mode === 'move' ? merged : merged.filter((p, k) => k === 0 || dist(p, merged[k - 1]) > 1e-9);
    pool = pool.filter((_, k) => k !== best.i && k !== best.j);
    pool.push(dedup);
  }
  return { ...first, rings: [pool[0]], closed: false };
}

/**
 * Extend two open lines, each along the way its last segment points, until they meet. The two ends that need the least extending are
 * used. Lines that already cross, run side by side, or point away from each other cannot be extended to meet.
 */
export function extendToMeet(a: PathShape, b: PathShape): { a: PathShape; b: PathShape; point: Pt } {
  for (const s of [a, b]) {
    if (s.closed) throw new NodeError('Only open lines can be extended; a closed shape has no ends');
    if (s.rings.length !== 1 || s.rings[0].length < 2) throw new NodeError('Each line must be a single open line');
  }
  // an end: where it is, which way it points (away from the line), and which end it is
  const ends = (s: PathShape) => {
    const r = s.rings[0];
    const dir = (from: number, to: number): Pt | null => {
      // the last segment that has some length
      const step = to > from ? 1 : -1;
      for (let i = to; i !== from; i -= step) {
        const dx = r[i][0] - r[i - step][0], dy = r[i][1] - r[i - step][1], l = Math.hypot(dx, dy);
        if (l > 1e-9) return [dx / l, dy / l];
      }
      return null;
    };
    const out: { at: Pt; d: Pt; end: 'start' | 'end' }[] = [];
    const de = dir(0, r.length - 1), ds = dir(r.length - 1, 0);
    if (de) out.push({ at: r[r.length - 1], d: de, end: 'end' });
    if (ds) out.push({ at: r[0], d: ds, end: 'start' });
    return out;
  };
  type End = ReturnType<typeof ends>[number];
  let best: { ea?: End; eb?: End; p: Pt; cost: number } | null = null;
  const EPS = 1e-6, MAX = 10000;
  // both lines extended until they meet
  for (const ea of ends(a)) {
    for (const eb of ends(b)) {
      const cr = ea.d[0] * eb.d[1] - ea.d[1] * eb.d[0];
      if (Math.abs(cr) < 1e-9) continue; // side by side
      const wx = eb.at[0] - ea.at[0], wy = eb.at[1] - ea.at[1];
      const t1 = (wx * eb.d[1] - wy * eb.d[0]) / cr;
      const t2 = (wx * ea.d[1] - wy * ea.d[0]) / cr;
      if (t1 < -EPS || t2 < -EPS || t1 > MAX || t2 > MAX) continue; // needs trimming, not extending
      const cost = t1 + t2;
      if (!best || cost < best.cost) best = { ea, eb, p: [ea.at[0] + ea.d[0] * t1, ea.at[1] + ea.d[1] * t1], cost };
    }
  }
  // or one line extended until it reaches the other (a T), which then stays as it is
  const reach = (from: PathShape, to: PathShape, who: 'a' | 'b') => {
    const r = to.rings[0];
    for (const e of ends(from)) {
      for (let i = 1; i < r.length; i++) {
        const sx = r[i][0] - r[i - 1][0], sy = r[i][1] - r[i - 1][1];
        const cr = e.d[0] * sy - e.d[1] * sx;
        if (Math.abs(cr) < 1e-9) continue;
        const wx = r[i - 1][0] - e.at[0], wy = r[i - 1][1] - e.at[1];
        const t = (wx * sy - wy * sx) / cr;
        const u = (wx * e.d[1] - wy * e.d[0]) / cr;
        if (t < -EPS || t > MAX || u < -EPS || u > 1 + EPS) continue;
        if (!best || t < best.cost) best = { ...(who === 'a' ? { ea: e } : { eb: e }), p: [e.at[0] + e.d[0] * t, e.at[1] + e.d[1] * t], cost: t };
      }
    }
  };
  reach(a, b, 'a');
  reach(b, a, 'b');
  if (!best) throw new NodeError('These lines do not meet when extended: they run side by side, point away from each other, or already cross (use Trim to cut back a crossing)');
  const move = (s: PathShape, end: 'start' | 'end', p: Pt): PathShape => {
    const r = s.rings[0].map((q): Pt => [q[0], q[1]]);
    r[end === 'end' ? r.length - 1 : 0] = [p[0], p[1]];
    return { ...s, rings: [r] };
  };
  return { a: best.ea ? move(a, best.ea.end, best.p) : a, b: best.eb ? move(b, best.eb.end, best.p) : b, point: best.p };
}

/**
 * Round the corner where two separate open lines meet, in one step: the chosen end of each is pulled along its last segment to where the two
 * lines cross (extended, or cut back when they already cross inside that last segment), the two are joined at that point and the corner is
 * rounded (or scooped, or chamfered). Returns the one new line.
 */
export function filletLines(a: PathShape, endA: 'start' | 'end', b: PathShape, endB: 'start' | 'end', radius: number, style: CornerStyle): { shape: PathShape; capped: number } {
  for (const s of [a, b]) {
    if (s.closed || s.rings.length !== 1 || s.rings[0].length < 2) throw new NodeError('Both must be single open lines');
  }
  // lay each line out so the chosen end is the last point
  const ordered = (s: PathShape, end: 'start' | 'end'): Pt[] => (end === 'end' ? s.rings[0].map((p): Pt => [p[0], p[1]]) : [...s.rings[0]].reverse().map((p): Pt => [p[0], p[1]]));
  const ra = ordered(a, endA), rb = ordered(b, endB);
  const last = (r: Pt[]) => {
    // the last segment that has some length: its end point index and direction
    for (let i = r.length - 1; i > 0; i--) {
      const l = dist(r[i - 1], r[i]);
      if (l > 1e-9) return { i, d: [(r[i][0] - r[i - 1][0]) / l, (r[i][1] - r[i - 1][1]) / l] as Pt, len: l };
    }
    throw new NodeError('A line has no length');
  };
  const la = last(ra), lb = last(rb);
  const cr = la.d[0] * lb.d[1] - la.d[1] * lb.d[0];
  if (Math.abs(cr) < 1e-9) throw new NodeError('These lines run side by side, so they never meet');
  const pa = ra[la.i], pb = rb[lb.i];
  const wx = pb[0] - pa[0], wy = pb[1] - pa[1];
  const ta = (wx * lb.d[1] - wy * lb.d[0]) / cr;     // from the end of A to the meeting point, along A (negative: back along A)
  const tb = (wx * la.d[1] - wy * la.d[0]) / cr;
  if (ta > 10000 || tb > 10000) throw new NodeError('They meet too far away');
  if (-ta > la.len + 1e-9 || -tb > lb.len + 1e-9) throw new NodeError('They cross further back than the last segment of a line; use Trim first');
  const P: Pt = [pa[0] + la.d[0] * ta, pa[1] + la.d[1] * ta];
  // the line up to the meeting point (a cut-back may land on the segment's start: drop the doubled point)
  const upTo = (r: Pt[], idx: number): Pt[] => {
    const out = r.slice(0, idx);
    if (!out.length || dist(out[out.length - 1], P) > 1e-9) out.push(P);
    return out;
  };
  const A = upTo(ra, la.i), B = upTo(rb, lb.i);
  if (A.length < 2 || B.length < 2) throw new NodeError('Nothing is left of a line after cutting it back to the corner');
  const merged: PathShape = { ...a, rings: [[...A, ...[...B].reverse().slice(1)]], closed: false };
  const f = filletPath(merged, radius, style, [{ ring: 0, i: A.length - 1 }]);
  return { shape: f.shape, capped: f.capped };
}
