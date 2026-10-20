import type { Doc, PathShape, Pt, Shape } from './types';
import { shapeBounds } from './geom';

/**
 * Checking the vectors before they are cut. Everything here only looks; `fixIssues` (in commands.ts, as `validate_fix`) changes what is safe to change.
 * Millimetres, Y up.
 */
export type IssueCode = 'open' | 'almost-closed' | 'tiny' | 'degenerate' | 'self-cross' | 'cross' | 'duplicate';

export interface Issue {
  code: IssueCode;
  /** error: a cut or fill will go wrong; warn: probably not what was meant */
  severity: 'error' | 'warn';
  ids: number[];
  message: string;
  /** True when the Fix button will put it right on its own */
  fixable: boolean;
}

export interface ValidateOptions {
  /** Ends of an open line closer than this (mm) are "almost closed" */
  gap?: number;
  /** Points closer than this (mm) to the one before are one point too many */
  tiny?: number;
}

export const DEFAULTS = { gap: 0.1, tiny: 0.005 };
type Seg = [number, number, number, number];

const segsOf = (ring: Pt[], closed: boolean): Seg[] => {
  const out: Seg[] = [];
  for (let i = 0; i + 1 < ring.length; i++) out.push([ring[i][0], ring[i][1], ring[i + 1][0], ring[i + 1][1]]);
  if (closed && ring.length > 2) out.push([ring[ring.length - 1][0], ring[ring.length - 1][1], ring[0][0], ring[0][1]]);
  return out;
};

/** Do two segments cross each other in the middle of both? (Meeting at an end, or lying along each other, is not a crossing.) */
function properCross(a: Seg, b: Seg): boolean {
  const rx = a[2] - a[0], ry = a[3] - a[1], sx = b[2] - b[0], sy = b[3] - b[1];
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12) return false;
  const t = ((b[0] - a[0]) * sy - (b[1] - a[1]) * sx) / den;
  const u = ((b[0] - a[0]) * ry - (b[1] - a[1]) * rx) / den;
  const e = 1e-7;
  return t > e && t < 1 - e && u > e && u < 1 - e;
}

/** Sort and sweep: the segments of one list against each other (`other` null) or against a second list. Stops after `limit` crossings. */
function countCrossings(segs: Seg[], other: Seg[] | null, skipNeighbours: boolean, limit: number): number {
  const items = (list: Seg[], tag: number) => list.map((s, i) => ({ s, i, tag, x0: Math.min(s[0], s[2]), x1: Math.max(s[0], s[2]), y0: Math.min(s[1], s[3]), y1: Math.max(s[1], s[3]) }));
  const all = [...items(segs, 0), ...(other ? items(other, 1) : [])].sort((p, q) => p.x0 - q.x0);
  const n0 = segs.length;
  let found = 0;
  for (let a = 0; a < all.length; a++) {
    const p = all[a];
    for (let b = a + 1; b < all.length && all[b].x0 <= p.x1; b++) {
      const q = all[b];
      if (other ? p.tag === q.tag : false) continue;
      if (q.y0 > p.y1 || q.y1 < p.y0) continue;
      if (skipNeighbours && !other) {
        const d = Math.abs(p.i - q.i);
        if (d <= 1 || d === n0 - 1) continue;   // neighbours share a point by design (a closed ring's last meets its first)
      }
      if (properCross(p.s, q.s)) { found++; if (found >= limit) return found; }
    }
  }
  return found;
}

const keyOf = (s: Shape): string => {
  const r = (v: number) => Math.round(v * 1000) / 1000;
  if (s.kind === 'circle') return `c|${r(s.cx)},${r(s.cy)},${r(s.r)}`;
  const rings = s.rings.map((ring) => ring.map((p) => `${r(p[0])},${r(p[1])}`));
  // the same outline starting elsewhere or running the other way is the same outline
  const norm = rings.map((ring) => {
    const fwd = s.closed ? rotateToMin(ring) : ring;
    const back = s.closed ? rotateToMin([...ring].reverse()) : [...ring].reverse();
    const a = fwd.join(';'), b = back.join(';');
    return a < b ? a : b;
  }).sort();
  return `p${s.closed ? 'c' : 'o'}|${norm.join('|')}`;
};
function rotateToMin(ring: string[]): string[] {
  if (!ring.length) return ring;
  let m = 0;
  for (let i = 1; i < ring.length; i++) if (ring[i] < ring[m]) m = i;
  return [...ring.slice(m), ...ring.slice(0, m)];
}

const ringArea = (r: Pt[]): number => { let a = 0; for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; a += p[0] * q[1] - q[0] * p[1]; } return Math.abs(a / 2); };

const MAX_PAIR_SHAPES = 600;   // shape-against-shape crossings are only looked for among this many shapes (the picked ones, or a small drawing)

/** What is wrong with these shapes (all of the design's when `ids` is not given). */
export function validate(doc: Doc, ids?: number[], opts: ValidateOptions = {}): Issue[] {
  const { gap, tiny } = { ...DEFAULTS, ...opts };
  const set = ids ? new Set(ids) : null;
  const shapes = doc.shapes.filter((s) => (!set || set.has(s.id)) && doc.layers.find((l) => l.name === s.layer)?.visible !== false);
  const issues: Issue[] = [];
  const add = (code: IssueCode, severity: Issue['severity'], list: number[], message: (n: number) => string, fixable: boolean) => {
    if (list.length) issues.push({ code, severity, ids: list, message: message(list.length), fixable });
  };
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

  const open: number[] = [], almost: number[] = [], tinyIds: number[] = [], degenerate: number[] = [], selfX: number[] = [];
  for (const s of shapes) {
    if (s.kind === 'circle') { if (!(s.r > 1e-6)) degenerate.push(s.id); continue; }
    const rings = s.rings;
    // points that sit on top of the one before
    const hasTiny = rings.some((r) => r.some((p, i) => i > 0 && Math.hypot(p[0] - r[i - 1][0], p[1] - r[i - 1][1]) < tiny));
    if (hasTiny) tinyIds.push(s.id);
    const distinct = (r: Pt[]) => r.filter((p, i) => i === 0 || Math.hypot(p[0] - r[i - 1][0], p[1] - r[i - 1][1]) >= tiny).length;
    // a ring that crosses itself
    let crossed = false;
    for (const r of rings) {
      if (r.length > 3 && countCrossings(segsOf(r, s.closed), null, true, 1) > 0) { crossed = true; break; }
    }
    if (s.closed ? rings.every((r) => distinct(r) < 3 || (!crossed && ringArea(r) < 1e-6)) : rings.every((r) => distinct(r) < 2)) { degenerate.push(s.id); continue; }
    if (!s.closed) {
      const r = rings[0];
      const ends = rings.length === 1 && r.length >= 3 ? Math.hypot(r[0][0] - r[r.length - 1][0], r[0][1] - r[r.length - 1][1]) : Infinity;
      if (ends <= gap) almost.push(s.id); else open.push(s.id);
    }
    if (crossed) selfX.push(s.id);
  }
  add('degenerate', 'error', degenerate, (n) => `${plural(n, 'shape')} too small to cut (no area, or a single point)`, true);
  add('almost-closed', 'error', almost, (n) => `${plural(n, 'open line')} whose ends nearly meet (within ${gap} mm): close them`, true);
  add('open', 'warn', open, (n) => `${plural(n, 'open line')}: a pocket, fill or V-carve needs a closed shape`, false);
  add('self-cross', 'error', selfX, (n) => `${plural(n, 'shape')} that cross themselves (a figure 8 or a loop): the inside is unclear`, false);
  add('tiny', 'warn', tinyIds, (n) => `${plural(n, 'shape')} with points sitting on top of each other (a stray dot every cut would stop at)`, true);

  // the same outline twice cuts twice
  const seen = new Map<string, number>();
  const dup: number[] = [];
  for (const s of shapes) {
    if (degenerate.includes(s.id)) continue;
    const k = `${s.layer}|${keyOf(s)}`;
    if (seen.has(k)) dup.push(s.id); else seen.set(k, s.id);
  }
  add('duplicate', 'warn', dup, (n) => `${plural(n, 'shape')} drawn on top of another identical one (it would be cut twice)`, true);

  // outlines of different shapes that cross: a cut across another, or a pocket with an edge through another
  const closedOnes = shapes.filter((s) => s.kind === 'path' && !degenerate.includes(s.id) && !dup.includes(s.id));
  if (closedOnes.length >= 2 && closedOnes.length <= MAX_PAIR_SHAPES) {
    const boxes = closedOnes.map((s) => shapeBounds(s)!);
    const bad = new Set<number>();
    let checked = 0;
    for (let i = 0; i < closedOnes.length && checked < 40000; i++) {
      for (let j = i + 1; j < closedOnes.length; j++) {
        const a = boxes[i], b = boxes[j];
        if (a.maxX < b.minX || b.maxX < a.minX || a.maxY < b.minY || b.maxY < a.minY) continue;
        checked++;
        const A = closedOnes[i] as PathShape, B = closedOnes[j] as PathShape;
        const sa = A.rings.flatMap((r) => segsOf(r, A.closed)), sb = B.rings.flatMap((r) => segsOf(r, B.closed));
        if (countCrossings(sa, sb, false, 1) > 0) { bad.add(A.id); bad.add(B.id); }
      }
    }
    add('cross', 'warn', [...bad], (n) => `${plural(n, 'shape')} whose outline crosses another shape's outline (union them, or move one, if that was not meant)`, false);
  }
  return issues;
}

/** For the Check card: a short line for the whole result. */
export function summary(issues: Issue[]): string {
  if (!issues.length) return 'No problems found.';
  const errors = issues.filter((i) => i.severity === 'error').length;
  return `${issues.length} kind${issues.length === 1 ? '' : 's'} of problem${errors ? `, ${errors} that will spoil a cut` : ''}.`;
}

