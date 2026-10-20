// DXF in and out. Out is R12 ASCII (POLYLINE/VERTEX and CIRCLE): the oldest and most widely read flavour, so
// VCarve, LightBurn, Fusion and CAD tools all open it. In reads LINE, ARC, CIRCLE, ELLIPSE, SPLINE, LWPOLYLINE, POLYLINE and
// blocks (INSERT), flattens arcs, curves and bulges, and joins loose lines that meet end to end into closed shapes.
import DxfParser from 'dxf-parser';
import type { Doc, Layer, NewShape, Pt } from './types';
import { newLayer } from './types';
import { arcPoints, shapeClosed, shapeRings } from './geom';

export interface ImportResult {
  layers: Layer[];
  shapes: NewShape[];
  warnings: string[];
}

const JOIN_TOLERANCE = 0.01; // mm; endpoints closer than this are the same point

function bulgeSegment(p0: Pt, p1: Pt, bulge: number): Pt[] {
  // returns the points after p0 up to and including p1
  const theta = 4 * Math.atan(bulge);
  const dx = p1[0] - p0[0];
  const dy = p1[1] - p0[1];
  const chord = Math.hypot(dx, dy);
  if (!chord || !theta) return [p1];
  const r = chord / (2 * Math.sin(Math.abs(theta) / 2));
  const sign = bulge > 0 ? 1 : -1;
  const h = r * Math.cos(Math.abs(theta) / 2);
  const cx = (p0[0] + p1[0]) / 2 + sign * (-dy / chord) * h;
  const cy = (p0[1] + p1[1]) / 2 + sign * (dx / chord) * h;
  const a0 = Math.atan2(p0[1] - cy, p0[0] - cx);
  return arcPoints(cx, cy, r, a0, a0 + theta).slice(1);
}

function polylinePoints(vertices: { x: number; y: number; bulge?: number }[], closed: boolean): Pt[] {
  const pts: Pt[] = [];
  const n = vertices.length;
  for (let i = 0; i < n; i++) {
    const v = vertices[i];
    const p: Pt = [v.x, v.y];
    if (i === 0) pts.push(p);
    const next = i + 1 < n ? vertices[i + 1] : closed ? vertices[0] : null;
    if (!next) continue;
    const q: Pt = [next.x, next.y];
    if (v.bulge) pts.push(...bulgeSegment(p, q, v.bulge));
    else pts.push(q);
  }
  if (closed && pts.length > 1) {
    const f = pts[0];
    const l = pts[pts.length - 1];
    if (Math.hypot(f[0] - l[0], f[1] - l[1]) < 1e-9) pts.pop();
  }
  return pts;
}

/** Drop points that lie within `tol` of the line through their neighbours (Douglas-Peucker). Traced logos and outlined text come with
 * thousands of points a few micrometres apart; this keeps the shape to well under the width of a laser beam. */
export function simplifyPath(pts: Pt[], closed: boolean, tol = SIMPLIFY_TOLERANCE): Pt[] {
  if (pts.length < 40) return pts;
  // a closed loop is cut at its two farthest-apart-ish points so both halves are simplified as open lines
  const work = closed ? [...pts, pts[0]] : pts;
  const keep = new Uint8Array(work.length);
  keep[0] = keep[work.length - 1] = 1;
  if (closed) { // also keep the point farthest from the start, so a loop is never collapsed to a line
    let far = 0, fd = -1;
    for (let i = 1; i < pts.length; i++) { const d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]); if (d > fd) { fd = d; far = i; } }
    keep[far] = 1;
  }
  const stack: [number, number][] = [];
  const marks = [...keep.keys()].filter((i) => keep[i]);
  for (let m = 0; m + 1 < marks.length; m++) stack.push([marks[m], marks[m + 1]]);
  while (stack.length) {
    const [a, b] = stack.pop()!;
    if (b - a < 2) continue;
    const [ax, ay] = work[a], [bx, by] = work[b];
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let best = -1, bd = tol;
    for (let i = a + 1; i < b; i++) {
      const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((work[i][0] - ax) * dx + (work[i][1] - ay) * dy) / l2));
      const d = Math.hypot(work[i][0] - (ax + t * dx), work[i][1] - (ay + t * dy));
      if (d > bd) { bd = d; best = i; }
    }
    if (best >= 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  const out = work.filter((_, i) => keep[i]);
  if (closed) out.pop();
  return out.length >= (closed ? 3 : 2) ? out : pts;
}
const SIMPLIFY_TOLERANCE = 0.002; // mm

/** Join open pieces that meet end to end. Returns closed loops and the open chains that are left. */
export function chainPaths(pieces: Pt[][], tol = JOIN_TOLERANCE): { closed: Pt[][]; open: Pt[][] } {
  const cell = (v: number) => Math.round(v / (tol * 2));
  const key = (p: Pt) => `${cell(p[0])},${cell(p[1])}`;
  const near = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= tol;

  // index of piece ends by grid cell
  const index = new Map<string, { piece: number; end: 0 | 1 }[]>();
  const used = new Array(pieces.length).fill(false);
  pieces.forEach((pc, i) => {
    if (pc.length < 2) return;
    for (const end of [0, 1] as const) {
      const p = end === 0 ? pc[0] : pc[pc.length - 1];
      const k = key(p);
      if (!index.has(k)) index.set(k, []);
      index.get(k)!.push({ piece: i, end });
    }
  });

  const findNeighbour = (p: Pt): { piece: number; end: 0 | 1 } | null => {
    const cx = cell(p[0]);
    const cy = cell(p[1]);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const c of index.get(`${cx + dx},${cy + dy}`) ?? []) {
          if (used[c.piece]) continue;
          const pc = pieces[c.piece];
          if (near(p, c.end === 0 ? pc[0] : pc[pc.length - 1])) return c;
        }
      }
    }
    return null;
  };

  const closed: Pt[][] = [];
  const open: Pt[][] = [];
  for (let i = 0; i < pieces.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    if (pieces[i].length < 2) continue;
    // the chain is `left` (reversed, growing at the head) followed by `right` (growing at the tail): adding a piece never copies
    // what is there already, so a long outline made of thousands of little lines stays quick
    const right: Pt[] = pieces[i].slice();
    const left: Pt[] = [];
    const first = () => (left.length ? left[left.length - 1] : right[0]);
    const last = () => right[right.length - 1];
    const size = () => left.length + right.length;
    for (const side of ['tail', 'head'] as const) {
      for (;;) {
        const tip = side === 'tail' ? last() : first();
        const hit = findNeighbour(tip);
        if (!hit) break;
        used[hit.piece] = true;
        const add = pieces[hit.piece];
        if (side === 'tail') {
          // continue from the tip: the piece's far end last
          if (hit.end === 0) for (let k = 1; k < add.length; k++) right.push(add[k]);
          else for (let k = add.length - 2; k >= 0; k--) right.push(add[k]);
        } else if (hit.end === 1) for (let k = add.length - 2; k >= 0; k--) left.push(add[k]);
        else for (let k = 1; k < add.length; k++) left.push(add[k]);
        if (size() > 2 && near(first(), last())) break;
      }
    }
    const chain = left.length ? [...left.reverse(), ...right] : right;
    if (chain.length > 2 && near(chain[0], chain[chain.length - 1])) {
      chain.pop();
      if (chain.length >= 3) closed.push(chain);
    } else {
      open.push(chain);
    }
  }
  return { closed, open };
}

/** An ellipse (or part of one) as points */
function ellipsePoints(e: any): Pt[] | null {
  const c = e.center, m = e.majorAxisEndPoint;
  if (!c || !m || !(e.axisRatio > 0)) return null;
  const mx = m.x, my = m.y, ratio = e.axisRatio;
  const t0 = e.startAngle ?? 0;
  let t1 = e.endAngle ?? Math.PI * 2;
  while (t1 <= t0) t1 += Math.PI * 2;
  const n = Math.max(24, Math.ceil(((t1 - t0) / (Math.PI * 2)) * 96));
  const pts: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = t0 + ((t1 - t0) * i) / n;
    pts.push([c.x + Math.cos(t) * mx - Math.sin(t) * ratio * my, c.y + Math.cos(t) * my + Math.sin(t) * ratio * mx]);
  }
  return pts;
}

/** A spline (NURBS without weights, or through its fit points) as points: De Boor's evaluation, enough points to look smooth */
function splinePoints(e: any): Pt[] | null {
  const cps: { x: number; y: number }[] = e.controlPoints ?? [];
  const degree = Math.max(1, Math.min(e.degreeOfSplineCurve ?? 3, 5));
  if (cps.length < 2) {
    const fit: { x: number; y: number }[] = e.fitPoints ?? [];
    return fit.length >= 2 ? fit.map((p) => [p.x, p.y] as Pt) : null;
  }
  const n = cps.length;
  let knots: number[] = e.knotValues ?? [];
  if (knots.length !== n + degree + 1) {
    // no usable knots: a clamped uniform set (the curve starts and ends at the first and last point)
    knots = [];
    for (let i = 0; i < n + degree + 1; i++) knots.push(i <= degree ? 0 : i >= n ? n - degree : i - degree);
  }
  const lo = knots[degree], hi = knots[n];
  if (!(hi > lo)) return cps.map((p) => [p.x, p.y] as Pt);
  const samples = Math.min(600, Math.max(12, (n - degree) * 12));
  const pts: Pt[] = [];
  for (let s = 0; s <= samples; s++) {
    const u = s === samples ? hi : lo + ((hi - lo) * s) / samples;
    // the span holding u
    let k = degree;
    while (k < n - 1 && u >= knots[k + 1]) k++;
    const d = cps.slice(k - degree, k + 1).map((p) => [p.x, p.y] as Pt);
    for (let r = 1; r <= degree; r++) {
      for (let j = degree; j >= r; j--) {
        const i = j + k - degree;
        const den = knots[i + degree - r + 1] - knots[i];
        const a = den === 0 ? 0 : (u - knots[i]) / den;
        d[j] = [(1 - a) * d[j - 1][0] + a * d[j][0], (1 - a) * d[j - 1][1] + a * d[j][1]];
      }
    }
    pts.push(d[degree]);
  }
  return pts;
}

const hex = (n: number) => '#' + (n & 0xffffff).toString(16).padStart(6, '0');

export function importDxf(text: string): ImportResult {
  const warnings: string[] = [];
  let dxf: any;
  try {
    dxf = new DxfParser().parseSync(text);
  } catch (e) {
    throw new Error('Could not read this DXF: ' + (e as Error).message);
  }
  if (!dxf) throw new Error('Could not read this DXF');

  const layers = new Map<string, Layer>();
  const ensureLayer = (name: string) => {
    if (!layers.has(name)) {
      const info = dxf.tables?.layer?.layers?.[name];
      const l = newLayer(name, layers.size);
      if (info && typeof info.color === 'number' && info.color !== 0xffffff) l.color = hex(info.color);
      layers.set(name, l);
    }
    return name;
  };

  const pieces = new Map<string, Pt[][]>(); // open pieces per layer, to be chained
  const out: NewShape[] = [];
  const skipped = new Map<string, number>();

  type Tf = (p: Pt) => Pt;
  const identity: Tf = (p) => p;
  const addPiece = (layer: string, pts: Pt[]) => (pieces.get(layer) ?? pieces.set(layer, []).get(layer)!).push(pts);

  const walk = (entities: any[], tf: Tf, depth: number, inheritLayer?: string) => {
    for (const e of entities) {
      const layer = ensureLayer(inheritLayer && (!e.layer || e.layer === '0') ? inheritLayer : e.layer || '0');
      switch (e.type) {
        case 'LINE': {
          const [a, b] = e.vertices;
          addPiece(layer, [tf([a.x, a.y]), tf([b.x, b.y])]);
          break;
        }
        case 'ARC': {
          let a1 = e.endAngle;
          while (a1 <= e.startAngle) a1 += Math.PI * 2;
          addPiece(layer, arcPoints(e.center.x, e.center.y, e.radius, e.startAngle, a1).map(tf));
          break;
        }
        case 'CIRCLE':
          if (tf === identity) out.push({ kind: 'circle', layer, cx: e.center.x, cy: e.center.y, r: e.radius });
          else out.push({ kind: 'path', layer, rings: [arcPoints(e.center.x, e.center.y, e.radius, 0, Math.PI * 2).slice(0, -1).map(tf)], closed: true });
          break;
        case 'ELLIPSE': {
          const pts = ellipsePoints(e);
          if (!pts) { skipped.set('ELLIPSE', (skipped.get('ELLIPSE') ?? 0) + 1); break; }
          const full = Math.abs(((e.endAngle ?? Math.PI * 2) - (e.startAngle ?? 0)) % (Math.PI * 2)) < 1e-9 || (e.endAngle ?? 0) - (e.startAngle ?? 0) >= Math.PI * 2 - 1e-9;
          if (full) out.push({ kind: 'path', layer, rings: [pts.slice(0, -1).map(tf)], closed: true });
          else addPiece(layer, pts.map(tf));
          break;
        }
        case 'SPLINE': {
          const pts = splinePoints(e);
          if (!pts) { skipped.set('SPLINE', (skipped.get('SPLINE') ?? 0) + 1); break; }
          const m = pts.map(tf);
          const closedSpline = !!(e.closed || ((e.flag ?? 0) & 1)) || (m.length > 3 && Math.hypot(m[0][0] - m[m.length - 1][0], m[0][1] - m[m.length - 1][1]) < 1e-6);
          if (closedSpline && m.length > 3) { if (Math.hypot(m[0][0] - m[m.length - 1][0], m[0][1] - m[m.length - 1][1]) < 1e-6) m.pop(); out.push({ kind: 'path', layer, rings: [m], closed: true }); }
          else addPiece(layer, m);
          break;
        }
        case 'LWPOLYLINE':
        case 'POLYLINE': {
          if (!e.vertices || e.vertices.length < 2) break;
          const closedFlag = !!e.shape;
          const pts = polylinePoints(e.vertices, closedFlag).map(tf);
          if (closedFlag && pts.length >= 3) out.push({ kind: 'path', layer, rings: [simplifyPath(pts, true)], closed: true });
          else addPiece(layer, pts);
          break;
        }
        case 'INSERT': {
          // a block placed in the drawing: its parts, moved, scaled and turned to where it was put (a few levels deep)
          const block = dxf.blocks?.[e.name];
          if (!block?.entities || depth >= 4) { skipped.set('INSERT', (skipped.get('INSERT') ?? 0) + 1); break; }
          const sx = e.xScale ?? 1, sy = e.yScale ?? 1, rot = ((e.rotation ?? 0) * Math.PI) / 180;
          const c = Math.cos(rot), sn = Math.sin(rot);
          const bx = block.position?.x ?? 0, by = block.position?.y ?? 0;
          const px = e.position?.x ?? 0, py = e.position?.y ?? 0;
          const place: Tf = (p) => { const x = (p[0] - bx) * sx, y = (p[1] - by) * sy; return tf([px + x * c - y * sn, py + x * sn + y * c]); };
          walk(block.entities, place, depth + 1, layer);
          break;
        }
        default:
          skipped.set(e.type, (skipped.get(e.type) ?? 0) + 1);
      }
    }
  };
  walk(dxf.entities ?? [], identity, 0);

  for (const [layer, list] of pieces) {
    const { closed, open } = chainPaths(list);
    for (const ring of closed) out.push({ kind: 'path', layer, rings: [simplifyPath(ring, true)], closed: true });
    for (const line of open) out.push({ kind: 'path', layer, rings: [simplifyPath(line, false)], closed: false });
  }
  for (const [type, n] of skipped) {
    const what = `${n} ${type} object${n > 1 ? 's' : ''}`;
    warnings.push(type === 'TEXT' || type === 'MTEXT' ? `${what} not imported: text in a DXF needs the font, so turn it into curves (outlines) in the program that made the file, or retype it here with the Text tool` : `${what} not imported (not supported yet)`);
  }
  return { layers: [...layers.values()], shapes: out, warnings };
}

// ---- export -------------------------------------------------------------------------------------------------

const ACI: [number, [number, number, number]][] = [
  [1, [255, 0, 0]], [2, [255, 255, 0]], [3, [0, 255, 0]], [4, [0, 255, 255]], [5, [0, 0, 255]], [6, [255, 0, 255]], [7, [255, 255, 255]],
  [8, [128, 128, 128]], [9, [192, 192, 192]],
];

function nearestAci(color: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(color);
  if (!m) return 7;
  const n = parseInt(m[1], 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  let best = 7, bestD = Infinity;
  for (const [idx, rgb] of ACI) {
    const d = (rgb[0] - c[0]) ** 2 + (rgb[1] - c[1]) ** 2 + (rgb[2] - c[2]) ** 2;
    if (d < bestD) { bestD = d; best = idx; }
  }
  return best;
}

const num = (v: number) => (Math.abs(v) < 1e-9 ? '0' : String(Math.round(v * 1e5) / 1e5));
const safeLayer = (name: string) => name.replace(/[<>/\\":;?*|=`,]/g, '_').trim() || '0';

export function exportDxf(doc: Doc): string {
  const L: string[] = [];
  const g = (code: number, value: string | number) => L.push(String(code), String(value));

  g(0, 'SECTION'); g(2, 'HEADER');
  g(9, '$ACADVER'); g(1, 'AC1009');
  g(9, '$INSUNITS'); g(70, 4); // millimetres
  g(0, 'ENDSEC');

  g(0, 'SECTION'); g(2, 'TABLES');
  g(0, 'TABLE'); g(2, 'LTYPE'); g(70, 1);
  g(0, 'LTYPE'); g(2, 'CONTINUOUS'); g(70, 0); g(3, 'Solid line'); g(72, 65); g(73, 0); g(40, 0);
  g(0, 'ENDTAB');
  g(0, 'TABLE'); g(2, 'LAYER'); g(70, doc.layers.length + 1);
  const layerNames = new Map<string, string>();
  const used = new Set<string>(['0']);
  g(0, 'LAYER'); g(2, '0'); g(70, 0); g(62, 7); g(6, 'CONTINUOUS');
  for (const l of doc.layers) {
    let name = safeLayer(l.name);
    while (used.has(name)) name += '_';
    used.add(name);
    layerNames.set(l.name, name);
    g(0, 'LAYER'); g(2, name); g(70, 0); g(62, nearestAci(l.color)); g(6, 'CONTINUOUS');
  }
  g(0, 'ENDTAB');
  g(0, 'ENDSEC');

  g(0, 'SECTION'); g(2, 'ENTITIES');
  for (const s of doc.shapes) {
    const layer = layerNames.get(s.layer) ?? '0';
    if (s.kind === 'circle') {
      g(0, 'CIRCLE'); g(8, layer); g(10, num(s.cx)); g(20, num(s.cy)); g(30, 0); g(40, num(s.r));
      continue;
    }
    for (const ring of shapeRings(s)) {
      if (ring.length < 2) continue;
      g(0, 'POLYLINE'); g(8, layer); g(66, 1); g(10, 0); g(20, 0); g(30, 0); g(70, shapeClosed(s) ? 1 : 0);
      for (const [x, y] of ring) { g(0, 'VERTEX'); g(8, layer); g(10, num(x)); g(20, num(y)); g(30, 0); }
      g(0, 'SEQEND'); g(8, layer);
    }
  }
  g(0, 'ENDSEC');
  g(0, 'EOF');
  return L.join('\r\n') + '\r\n';
}

