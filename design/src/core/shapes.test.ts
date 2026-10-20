import { describe, expect, it } from 'vitest';
import { buildShape, fromDrag, shapeValid, DEFAULT_SHAPES } from './shapes';

describe('buildShape', () => {
  it('a hexagon has six corners at its radius, the first one up', () => {
    const { pts, closed } = buildShape({ kind: 'polygon', sides: 6, r: 10 }, 5, 5);
    expect(closed).toBe(true);
    expect(pts).toHaveLength(6);
    expect(pts[0][0]).toBeCloseTo(5); expect(pts[0][1]).toBeCloseTo(15);
    for (const p of pts) expect(Math.hypot(p[0] - 5, p[1] - 5)).toBeCloseTo(10);
  });
  it('a star alternates outer and inner corners', () => {
    const { pts } = buildShape({ kind: 'star', points: 5, r: 10, inner: 0.4 }, 0, 0);
    expect(pts).toHaveLength(10);
    pts.forEach((p, i) => expect(Math.hypot(p[0], p[1])).toBeCloseTo(i % 2 ? 4 : 10));
  });
  it('an ellipse spans its width and height', () => {
    const { pts } = buildShape({ kind: 'ellipse', w: 40, h: 20 }, 0, 0);
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    expect(Math.max(...xs)).toBeCloseTo(20); expect(Math.min(...xs)).toBeCloseTo(-20);
    expect(Math.max(...ys)).toBeCloseTo(10, 1); expect(Math.min(...ys)).toBeCloseTo(-10, 1);
  });
  it('an arc is open, starts and ends at its angles, and wraps past 360', () => {
    const a = buildShape({ kind: 'arc', r: 10, start: 0, end: 90 }, 0, 0);
    expect(a.closed).toBe(false);
    expect(a.pts[0][0]).toBeCloseTo(10); expect(a.pts[0][1]).toBeCloseTo(0);
    const last = a.pts[a.pts.length - 1];
    expect(last[0]).toBeCloseTo(0); expect(last[1]).toBeCloseTo(10);
    const w = buildShape({ kind: 'arc', r: 10, start: 270, end: 90 }, 0, 0); // through 0°: a half circle
    expect(w.pts[Math.floor(w.pts.length / 2)][0]).toBeGreaterThan(9.9);
  });
});

describe('fromDrag and shapeValid', () => {
  it('an ellipse drag is the box; the others use the distance from the centre', () => {
    const e = fromDrag(DEFAULT_SHAPES.ellipse, [0, 0], [30, 10]);
    expect(e).toMatchObject({ cx: 15, cy: 5, spec: { w: 30, h: 10 } });
    expect(fromDrag(DEFAULT_SHAPES.polygon, [1, 1], [4, 5])).toMatchObject({ cx: 1, cy: 1, spec: { r: 5 } });
  });
  it('refuses empty sizes and a star with no points between its corners', () => {
    expect(shapeValid({ kind: 'star', points: 5, r: 10, inner: 1 })).toBe(false);
    expect(shapeValid({ kind: 'ellipse', w: 0, h: 5 })).toBe(false);
    expect(shapeValid(DEFAULT_SHAPES.arc)).toBe(true);
  });
});
