import { describe, expect, it } from 'vitest';
import { chainPaths, importDxf } from '../src/core/dxf';
import { emptyDoc } from '../src/core/types';
import { buildLaserJob } from '../src/core/laser';
import { buildRuidaPlan } from '../src/core/ruidaPlan';
import { execute } from '../src/core/commands';
import type { Pt } from '../src/core/types';

const dxf = (entities: string[], blocks: string[] = []) =>
  ['0', 'SECTION', '2', 'BLOCKS', ...blocks, '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES', ...entities, '0', 'ENDSEC', '0', 'EOF'].join('\n');

const spline = (layer: string, degree: number, knots: number[], cps: [number, number][], flag = 8) => [
  '0', 'SPLINE', '8', layer, '70', String(flag), '71', String(degree), '72', String(knots.length), '73', String(cps.length), '74', '0',
  ...knots.flatMap((k) => ['40', String(k)]), ...cps.flatMap(([x, y]) => ['10', String(x), '20', String(y), '30', '0']),
];

describe('DXF: more kinds of drawing', () => {
  it('reads a spline as a smooth line between its end points (the letters of outlined text are often splines)', () => {
    // a cubic Bezier from (0,0) to (30,0) bulging up to y = 15 in the middle: 4 control points, clamped knots
    const r = importDxf(dxf(spline('Text', 3, [0, 0, 0, 0, 1, 1, 1, 1], [[0, 0], [0, 20], [30, 20], [30, 0]], 8)));
    expect(r.warnings).toEqual([]);
    expect(r.shapes).toHaveLength(1);
    const pts = (r.shapes[0] as any).rings[0] as Pt[];
    expect(pts[0][0]).toBeCloseTo(0, 6); expect(pts[0][1]).toBeCloseTo(0, 6);
    expect(pts[pts.length - 1][0]).toBeCloseTo(30, 6); expect(pts[pts.length - 1][1]).toBeCloseTo(0, 6);
    const top = Math.max(...pts.map((p) => p[1]));
    expect(top).toBeGreaterThan(14.9); expect(top).toBeLessThan(15.1);   // a cubic Bezier peaks at 0.75 of the control height
    expect(pts.length).toBeGreaterThan(10);
  });

  it('closes a spline that comes back to its start, so a letter becomes a closed shape', () => {
    // a degree 1 "spline" round a square
    const r = importDxf(dxf(spline('Text', 1, [0, 0, 1, 2, 3, 4, 4], [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]], 9)));
    expect(r.shapes).toHaveLength(1);
    expect((r.shapes[0] as any).closed).toBe(true);
  });

  it('reads an ellipse, full and partial', () => {
    const full = importDxf(dxf(['0', 'ELLIPSE', '8', 'L', '10', '50', '20', '40', '30', '0', '11', '20', '21', '0', '31', '0', '40', '0.5', '41', '0', '42', String(Math.PI * 2)]));
    expect(full.shapes).toHaveLength(1);
    const ring = (full.shapes[0] as any).rings[0] as Pt[];
    const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(40, 0);   // major axis 20 each side
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(20, 0);   // ratio 0.5
    expect((full.shapes[0] as any).closed).toBe(true);
    const half = importDxf(dxf(['0', 'ELLIPSE', '8', 'L', '10', '0', '20', '0', '30', '0', '11', '10', '21', '0', '31', '0', '40', '0.5', '41', '0', '42', String(Math.PI)]));
    expect((half.shapes[0] as any).closed).toBe(false);
  });

  it('places a block where it was inserted, scaled and turned', () => {
    const block = ['0', 'BLOCK', '8', '0', '2', 'LOGO', '10', '0', '20', '0', '30', '0',
      '0', 'LWPOLYLINE', '8', '0', '90', '4', '70', '1', '10', '0', '20', '0', '10', '10', '20', '0', '10', '10', '20', '5', '10', '0', '20', '5',
      '0', 'ENDBLK'];
    const insert = ['0', 'INSERT', '8', 'Art', '2', 'LOGO', '10', '100', '20', '50', '30', '0', '41', '2', '42', '2', '43', '1', '50', '90'];
    const r = importDxf(dxf(insert, block));
    expect(r.warnings).toEqual([]);
    expect(r.shapes).toHaveLength(1);
    const ring = (r.shapes[0] as any).rings[0] as Pt[];
    // 10 x 5, doubled to 20 x 10, turned 90 degrees to 10 x 20, at (100, 50)
    const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(10, 6);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(20, 6);
    expect(Math.min(...ys)).toBeCloseTo(50, 6);
    expect(Math.max(...xs)).toBeCloseTo(100, 6);
    expect((r.shapes[0] as any).layer).toBe('Art');
  });

  it('says what to do about text it cannot draw', () => {
    const r = importDxf(dxf(['0', 'TEXT', '8', '0', '10', '0', '20', '0', '30', '0', '40', '5', '1', 'Hello', '0', 'LINE', '8', '0', '10', '0', '20', '0', '11', '5', '21', '0']));
    expect(r.warnings.join(' ')).toMatch(/TEXT.*curves/);
  });
});

describe('DXF: big drawings', () => {
  it('joins a long outline made of thousands of little lines, in any order, quickly', () => {
    const n = 20000;
    const pts: Pt[] = Array.from({ length: n }, (_, i) => [Math.cos((i / n) * Math.PI * 2) * 100, Math.sin((i / n) * Math.PI * 2) * 100]);
    const pieces: Pt[][] = pts.map((p, i) => [p, pts[(i + 1) % n]]);
    // shuffle, and turn a third of them round
    let seed = 5; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    pieces.sort(() => rnd() - 0.5);
    pieces.forEach((pc, i) => { if (i % 3 === 0) pc.reverse(); });
    const t = Date.now();
    const { closed, open } = chainPaths(pieces);
    expect(Date.now() - t).toBeLessThan(3000);
    expect(open).toHaveLength(0);
    expect(closed).toHaveLength(1);
    expect(closed[0]).toHaveLength(n);
  });

  it('builds the job for thousands of small pieces (a QR code, outlined text) without grinding to a halt', () => {
    const n = 6000, cols = 80;
    const L: string[] = [];
    for (let i = 0; i < n; i++) {
      const x = (i % cols) * 3, y = Math.floor(i / cols) * 3;
      L.push('0', 'LWPOLYLINE', '8', 'Art', '90', '4', '70', '1');
      for (const [dx, dy] of [[0, 0], [2, 0], [2, 2], [0, 2]]) L.push('10', String(x + dx), '20', String(y + dy));
    }
    const r = importDxf(dxf(L));
    let d = emptyDoc();
    d = execute(d, 'layer_set', { name: 'Art', mode: 'engrave', speed: 400, power: 20, interval: 0.25 }).doc;
    d = { ...d, shapes: r.shapes.map((s, i) => ({ ...s, id: i + 1 } as never)), nextId: n + 2 };
    const t = Date.now();
    buildLaserJob(d);
    buildRuidaPlan(d);
    expect(Date.now() - t).toBeLessThan(15000);
  });
});

import { simplifyPath } from '../src/core/dxf';
import { fillSpans } from '../src/core/fill';

describe('big drawings, part 2', () => {
  it('importing the same file twice does not stack a second copy', () => {
    const text = dxf(['0', 'LWPOLYLINE', '8', 'A', '90', '4', '70', '1', '10', '0', '20', '0', '10', '5', '20', '0', '10', '5', '20', '5', '10', '0', '20', '5', '0', 'CIRCLE', '8', 'A', '10', '20', '20', '20', '30', '0', '40', '3']);
    let d = execute(emptyDoc(), 'import_dxf', { text }).doc;
    expect(d.shapes).toHaveLength(2);
    const again = execute(d, 'import_dxf', { text });
    expect(again.doc.shapes).toHaveLength(2);
    expect(again.message).toMatch(/2 shapes already in the drawing/);
  });

  it('adds a drawing the page has already read elsewhere (the worker) exactly like the text', () => {
    const text = dxf(['0', 'CIRCLE', '8', 'A', '10', '20', '20', '20', '30', '0', '40', '3']);
    const a = execute(emptyDoc(), 'import_dxf', { text });
    const b = execute(emptyDoc(), 'import_dxf', { parsed: importDxf(text) });
    expect(b.doc.shapes).toEqual(a.doc.shapes);
    expect(b.message).toBe(a.message);
  });

  it('drops the thousands of near-identical points of a traced outline, and keeps its shape to within two micrometres', () => {
    const n = 5000;
    const ring: Pt[] = Array.from({ length: n }, (_, i) => [Math.cos((i / n) * Math.PI * 2) * 40, Math.sin((i / n) * Math.PI * 2) * 25]);
    const slim = simplifyPath(ring, true);
    expect(slim.length).toBeLessThan(n / 4);
    expect(slim.length).toBeGreaterThan(20);
    // every original point is within 2 um of the simplified outline
    const near = (p: Pt) => { let best = Infinity; for (let i = 0; i < slim.length; i++) { const a = slim[i], b = slim[(i + 1) % slim.length]; const dx = b[0] - a[0], dy = b[1] - a[1]; const l2 = dx * dx + dy * dy; const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0; best = Math.min(best, Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)); } return best; };
    for (let i = 0; i < n; i += 37) expect(near(ring[i])).toBeLessThan(0.0021);
    // short outlines are left alone
    const square: Pt[] = [[0, 0], [1, 0], [1, 1], [0, 1]];
    expect(simplifyPath(square, true)).toBe(square);
  });

  it('finds the same fill spans as the plain way of crossing every ring with every line', () => {
    const ring: Pt[] = [[0, 0], [30, 5], [25, 40], [12, 22], [5, 38]];
    const hole: Pt[] = [[10, 10], [18, 12], [14, 20]];
    const interval = 0.7;
    const fast = fillSpans([ring, hole], interval);
    // the plain way
    const slow: { y: number; spans: [number, number][] }[] = [];
    for (let k = 0; ; k++) {
      const y = 0 + (k + 0.5) * interval;
      if (y > 40) break;
      const xs: number[] = [];
      for (const r of [ring, hole]) for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, yi] = r[i], [xj, yj] = r[j]; if (yi > y !== yj > y) xs.push(xi + ((y - yi) / (yj - yi)) * (xj - xi)); }
      xs.sort((p, q) => p - q);
      const spans: [number, number][] = [];
      for (let i = 0; i + 1 < xs.length; i += 2) if (xs[i + 1] - xs[i] > 1e-6) spans.push([xs[i], xs[i + 1]]);
      if (spans.length) slow.push({ y, spans });
    }
    expect(fast).toHaveLength(slow.length);
    fast.forEach((l, i) => { expect(l.y).toBeCloseTo(slow[i].y, 9); expect(l.spans).toEqual(slow[i].spans); });
  });
});

describe('duplicates', () => {
  it('removes shapes drawn exactly on top of each other, keeps the first, and says so when there are none', () => {
    let d = execute(emptyDoc(), 'add_rect', { x: 0, y: 0, w: 20, h: 10, layer: 'Layer 1' }).doc;
    d = execute(d, 'add_rect', { x: 0, y: 0, w: 20, h: 10, layer: 'Layer 1' }).doc;
    d = execute(d, 'layer_set', { name: 'Other' }).doc;
    d = execute(d, 'add_rect', { x: 0, y: 0, w: 20, h: 10, layer: 'Other' }).doc;      // same place, another layer: a different shape
    d = execute(d, 'add_rect', { x: 5, y: 5, w: 20, h: 10, layer: 'Layer 1' }).doc;
    const r = execute(d, 'remove_duplicates', {});
    expect(r.doc.shapes).toHaveLength(3);
    expect(r.doc.shapes[0].id).toBe(d.shapes[0].id);
    expect(r.message).toMatch(/Removed 1 duplicate/);
    expect(execute(r.doc, 'remove_duplicates', {}).message).toMatch(/No duplicate/);
  });
});
