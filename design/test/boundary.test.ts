import { describe, expect, it } from 'vitest';
import { emptyDoc } from '../src/core/types';
import type { Doc } from '../src/core/types';
import { execute, CommandError } from '../src/core/commands';
import { shapeBounds, convexHull } from '../src/core/geom';

const rect = (d: Doc, x: number, y: number, w: number, h: number) => execute(d, 'add_rect', { x, y, w, h, layer: 'Layer 1' }).doc;
const ids = (d: Doc) => d.shapes.map((s) => s.id);
const area = (r: number[][]) => { let a = 0; for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; a += p[0] * q[1] - q[0] * p[1]; } return Math.abs(a / 2); };

describe('convexHull', () => {
  it('drops inside points and keeps the corners', () => {
    const h = convexHull([[0, 0], [10, 0], [10, 10], [0, 10], [5, 5], [5, 0]]);
    expect(h).toHaveLength(4);
    expect(area(h)).toBeCloseTo(100);
  });
  it('gives back what there is for fewer than three points', () => {
    expect(convexHull([[1, 1], [1, 1]])).toEqual([[1, 1]]);
  });
});

describe('boundary', () => {
  it('"each" draws an outline round every shape, grown by the gap', () => {
    let d = rect(rect(emptyDoc(), 0, 0, 10, 10), 50, 0, 20, 10);
    const r = execute(d, 'boundary', { ids: ids(d), mode: 'each', distance: 2, join: 'miter' });
    expect(r.doc.shapes).toHaveLength(4);
    const b = shapeBounds(r.doc.shapes[2])!;
    expect(b.minX).toBeCloseTo(-2); expect(b.maxX).toBeCloseTo(12);
    expect(r.ids).toHaveLength(2);
  });
  it('"all" joins shapes that overlap into one outline and keeps separate ones apart', () => {
    let d = rect(rect(rect(emptyDoc(), 0, 0, 10, 10), 5, 5, 10, 10), 100, 0, 10, 10);
    const r = execute(d, 'boundary', { ids: ids(d), mode: 'all' });
    expect(r.ids).toHaveLength(2);
    const areas = r.ids!.map((id) => area((r.doc.shapes.find((s) => s.id === id) as any).rings[0])).sort((p, q) => p - q);
    expect(areas[0]).toBeCloseTo(100);            // the lone square
    expect(areas[1]).toBeCloseTo(175);            // two overlapping 10 x 10 squares: 100 + 100 - 25
  });
  it('"all" ignores the holes of a shape', () => {
    let d = rect(rect(emptyDoc(), 0, 0, 40, 40), 10, 10, 10, 10);
    d = execute(d, 'boolean', { op: 'difference', ids: ids(d) }).doc;
    const r = execute(d, 'boundary', { ids: ids(d), mode: 'all' });
    expect(r.ids).toHaveLength(1);
    expect((r.doc.shapes.find((s) => s.id === r.ids![0]) as any).rings).toHaveLength(1);
  });
  it('"hull" is one convex outline round everything', () => {
    let d = rect(rect(emptyDoc(), 0, 0, 10, 10), 100, 100, 10, 10);
    const r = execute(d, 'boundary', { ids: ids(d), mode: 'hull' });
    expect(r.ids).toHaveLength(1);
    const b = shapeBounds(r.doc.shapes.find((s) => s.id === r.ids![0])!)!;
    expect(b.minX).toBeCloseTo(0); expect(b.maxX).toBeCloseTo(110); expect(b.maxY).toBeCloseTo(110);
  });
  it('an open line is enclosed by its convex outline; a straight one cannot be', () => {
    let d = execute(emptyDoc(), 'add_path', { points: [[0, 0], [10, 0], [10, 10]], closed: false, layer: 'Layer 1' }).doc;
    const r = execute(d, 'boundary', { ids: ids(d), mode: 'each' });
    expect(area((r.doc.shapes[1] as any).rings[0])).toBeCloseTo(50);
    const line = execute(emptyDoc(), 'add_path', { points: [[0, 0], [10, 0]], closed: false, layer: 'Layer 1' }).doc;
    expect(() => execute(line, 'boundary', { ids: ids(line), mode: 'hull' })).toThrow(CommandError);
  });
  it('keep false replaces the shapes, and bad arguments are refused', () => {
    let d = rect(emptyDoc(), 0, 0, 10, 10);
    const r = execute(d, 'boundary', { ids: ids(d), distance: 1, keep: false });
    expect(r.doc.shapes).toHaveLength(1);
    expect(shapeBounds(r.doc.shapes[0])!.minX).toBeCloseTo(-1);
    expect(() => execute(d, 'boundary', { ids: ids(d), distance: -1 })).toThrow(CommandError);
    expect(() => execute(d, 'boundary', { ids: ids(d), mode: 'nope' })).toThrow(CommandError);
  });
});
