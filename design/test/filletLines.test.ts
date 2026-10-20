import { describe, expect, it } from 'vitest';
import { emptyDoc } from '../src/core/types';
import { execute, CommandError } from '../src/core/commands';

const line = (d: any, pts: number[][]) => execute(d, 'add_path', { points: pts, closed: false, layer: 'Layer 1' }).doc;
const ids = (d: any) => d.shapes.map((s: any) => s.id);
const near = (p: number[], x: number, y: number, tol = 0.02) => Math.hypot(p[0] - x, p[1] - y) < tol;

describe('fillet_lines: one step from two separate lines to one rounded corner', () => {
  it('two lines that stop short are extended, joined and rounded', () => {
    let d = line(emptyDoc(), [[0, 0], [8, 0]]);
    d = line(d, [[10, 10], [10, 2]]);
    const r = execute(d, 'fillet_lines', { ids: ids(d), ends: ['end', 'end'], radius: 2 });
    expect(r.doc.shapes).toHaveLength(1);
    const ring = (r.doc.shapes[0] as any).rings[0];
    expect(near(ring[0], 0, 0)).toBe(true);
    expect(near(ring[ring.length - 1], 10, 10)).toBe(true);
    // the corner is at (10, 0); the arc is centred on (8, 2) with radius 2, so its middle is 2 away from that
    const mid = ring.reduce((best: number[], p: number[]) => (Math.hypot(p[0] - 10, p[1]) < Math.hypot(best[0] - 10, best[1]) ? p : best), ring[0]);
    expect(Math.hypot(mid[0] - 8, mid[1] - 2)).toBeCloseTo(2, 2);
    expect(ring.some((p: number[]) => near(p, 10, 0, 1e-6))).toBe(false);   // the sharp corner is gone
    expect((r.doc.shapes[0] as any).closed).toBe(false);
  });
  it('lines that cross a little way past the corner are cut back to it', () => {
    let d = line(emptyDoc(), [[0, 0], [12, 0]]);
    d = line(d, [[10, 10], [10, -2]]);
    const r = execute(d, 'fillet_lines', { ids: ids(d), ends: ['end', 'end'], radius: 2 });
    const ring = (r.doc.shapes[0] as any).rings[0];
    expect(ring.every((p: number[]) => p[0] <= 10 + 1e-6 && p[1] >= -1e-6)).toBe(true);   // nothing sticks out past the corner
    expect(near(ring[ring.length - 1], 10, 10)).toBe(true);
  });
  it('works from the start of a line, and a style other than round', () => {
    let d = line(emptyDoc(), [[8, 0], [0, 0]]);   // its start (8, 0) is the end that should meet
    d = line(d, [[10, 2], [10, 10]]);
    const r = execute(d, 'fillet_lines', { ids: ids(d), ends: ['start', 'start'], radius: 2, style: 'chamfer' });
    const ring = (r.doc.shapes[0] as any).rings[0];
    expect(ring.length).toBe(4);   // 0,0 -> chamfer start -> chamfer end -> 10,10
    expect(near(ring[0], 0, 0) || near(ring[0], 10, 10)).toBe(true);
  });
  it('is refused for parallel lines, for two shapes that are not both open lines, and for crossings further back than the last segment', () => {
    let par = line(line(emptyDoc(), [[0, 0], [5, 0]]), [[0, 5], [5, 5]]);
    expect(() => execute(par, 'fillet_lines', { ids: ids(par), ends: ['end', 'end'], radius: 1 })).toThrow(/side by side/);
    let rect = line(execute(emptyDoc(), 'add_rect', { x: 0, y: 0, w: 5, h: 5, layer: 'Layer 1' }).doc, [[0, 0], [5, 0]]);
    expect(() => execute(rect, 'fillet_lines', { ids: ids(rect), ends: ['end', 'end'], radius: 1 })).toThrow(CommandError);
    let far = line(line(emptyDoc(), [[0, 0], [20, 0], [22, 0]]), [[10, 10], [10, 5]]);
    expect(() => execute(far, 'fillet_lines', { ids: ids(far), ends: ['end', 'end'], radius: 1 })).toThrow(CommandError);
    expect(() => execute(par, 'fillet_lines', { ids: ids(par), ends: ['end'], radius: 1 })).toThrow(/ends/);
  });
});

describe('fillet of a closed outline that repeats its first point', () => {
  it('rounds the corner where it starts and ends, from either index', () => {
    const d = execute(emptyDoc(), 'add_path', { points: [[0, 0], [40, 0], [40, 30], [0, 30], [0, 0]], closed: true, layer: 'Layer 1' }).doc;
    const id = d.shapes[0].id;
    for (const i of [0, 4]) {
      const r = execute(d, 'fillet', { ids: [id], radius: 3, style: 'round', nodes: [{ ring: 0, i }] });
      const ring = (r.doc.shapes[0] as any).rings[0];
      expect(ring.some((p: number[]) => near(p, 0, 0, 1e-9))).toBe(false);          // the sharp corner is gone
      expect(ring.some((p: number[]) => near(p, 40, 0, 1e-9))).toBe(true);          // the others stay
      expect(ring.length).toBeGreaterThan(5);
    }
  });
  it('rounding every corner of it works too', () => {
    const d = execute(emptyDoc(), 'add_path', { points: [[0, 0], [40, 0], [40, 30], [0, 30], [0, 0]], closed: true, layer: 'Layer 1' }).doc;
    const r = execute(d, 'fillet', { ids: [d.shapes[0].id], radius: 3 });
    expect(r.message).toMatch(/4 corners/);
  });
});
