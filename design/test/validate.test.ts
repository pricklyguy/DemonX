import { describe, expect, it } from 'vitest';
import { emptyDoc } from '../src/core/types';
import { execute, CommandError } from '../src/core/commands';
import { validate, summary } from '../src/core/validate';

const path = (d: any, pts: number[][], closed: boolean) => execute(d, 'add_path', { points: pts, closed, layer: 'Layer 1' }).doc;
const rect = (d: any, x: number, y: number, w: number, h: number) => execute(d, 'add_rect', { x, y, w, h, layer: 'Layer 1' }).doc;
const codes = (d: any, ids?: number[]) => validate(d, ids).map((i) => i.code).sort();

describe('validate', () => {
  it('a clean drawing has no problems', () => {
    const d = rect(rect(emptyDoc(), 0, 0, 20, 20), 5, 5, 5, 5);   // a square inside a square: nested, not crossing
    expect(validate(d)).toEqual([]);
    expect(summary([])).toBe('No problems found.');
  });
  it('finds an open line, and one whose ends nearly meet', () => {
    let d = path(emptyDoc(), [[0, 0], [10, 0], [10, 10]], false);
    expect(codes(d)).toEqual(['open']);
    d = path(emptyDoc(), [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0.05]], false);
    expect(codes(d)).toEqual(['almost-closed']);
  });
  it('finds a shape that crosses itself (a figure 8), and not an ordinary square', () => {
    const eight = path(emptyDoc(), [[0, 0], [10, 10], [10, 0], [0, 10]], true);
    expect(codes(eight)).toEqual(['self-cross']);
    expect(codes(rect(emptyDoc(), 0, 0, 10, 10))).toEqual([]);
  });
  it('finds outlines of two shapes that cross each other, but not ones that nest, touch or sit apart', () => {
    expect(codes(rect(rect(emptyDoc(), 0, 0, 10, 10), 5, 5, 10, 10))).toEqual(['cross']);
    expect(codes(rect(rect(emptyDoc(), 0, 0, 10, 10), 10, 0, 10, 10))).toEqual([]);     // side by side, sharing an edge
    expect(codes(rect(rect(emptyDoc(), 0, 0, 10, 10), 30, 30, 5, 5))).toEqual([]);
  });
  it('finds a shape drawn twice, even started from another corner or run the other way', () => {
    let d = rect(emptyDoc(), 0, 0, 10, 10);
    d = path(d, [[10, 10], [10, 0], [0, 0], [0, 10]], true);   // the same square, other start and direction
    const i = validate(d).find((x) => x.code === 'duplicate')!;
    expect(i.ids).toHaveLength(1);
  });
  it('finds points sitting on top of each other and shapes too small to cut', () => {
    let d = path(emptyDoc(), [[0, 0], [10, 0], [10, 0.001], [10, 10], [0, 10]], true);
    expect(codes(d)).toEqual(['tiny']);
    d = path(emptyDoc(), [[0, 0], [0.001, 0], [0, 0.001]], true);
    expect(codes(emptyDoc() && d)).toContain('degenerate');
  });
  it('only looks at the picked shapes when it is given some', () => {
    let d = rect(emptyDoc(), 0, 0, 10, 10);
    d = path(d, [[50, 50], [60, 60]], false);
    expect(codes(d)).toEqual(['open']);
    expect(codes(d, [d.shapes[0].id])).toEqual([]);
  });
  it('is quick on a big shape', () => {
    const pts: number[][] = [];
    for (let i = 0; i < 20000; i++) { const a = (i / 20000) * Math.PI * 2; pts.push([100 + 50 * Math.cos(a), 100 + 50 * Math.sin(a)]); }
    const d = path(emptyDoc(), pts, true);
    const t = Date.now();
    expect(codes(d)).toEqual([]);
    expect(Date.now() - t).toBeLessThan(2000);
  });
});

describe('validate_fix', () => {
  it('closes nearly closed lines, cleans points, and deletes duplicates and specks', () => {
    let d = path(emptyDoc(), [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0.05]], false);
    d = path(d, [[20, 0], [30, 0], [30, 0.001], [30, 10], [20, 10]], true);
    d = rect(rect(d, 50, 50, 5, 5), 50, 50, 5, 5);
    d = path(d, [[80, 80], [80.001, 80], [80, 80.001]], true);
    const r = execute(d, 'validate_fix', {});
    expect(r.message).toMatch(/closed 1 line/i);
    expect((r.doc.shapes[0] as any).rings[0]).toHaveLength(4);
    expect(r.doc.shapes).toHaveLength(3);
    expect(validate(r.doc)).toEqual([]);
    expect((r.doc.shapes[0] as any).closed).toBe(true);
  });
  it('leaves open lines and crossings alone, and says so when there is nothing to do', () => {
    const d = rect(rect(emptyDoc(), 0, 0, 10, 10), 5, 5, 10, 10);
    expect(() => execute(d, 'validate_fix', {})).toThrow(CommandError);
    const o = path(emptyDoc(), [[0, 0], [10, 0], [10, 10]], false);
    expect(() => execute(o, 'validate_fix', {})).toThrow(/automatically/);
  });
});
