import { describe, expect, it } from 'vitest';
import { emptyDoc } from '../src/core/types';
import { execute, CommandError } from '../src/core/commands';
import { fitRing } from '../src/core/fit';
import type { Pt } from '../src/core/types';

const OPT = { tolerance: 0.1, cornerAngle: 40 };
// a repeatable wobble, not Math.random
const wobble = (i: number) => Math.sin(i * 12.9898) * 0.5 + Math.sin(i * 78.233) * 0.5;

describe('fitRing', () => {
  it('smooths a wobbly circle and stays within the tolerance of the true circle', () => {
    const pts: Pt[] = [];
    for (let i = 0; i < 400; i++) { const a = (i / 400) * Math.PI * 2, r = 30 + wobble(i) * 0.04; pts.push([r * Math.cos(a), r * Math.sin(a)]); }
    const out = fitRing(pts, true, OPT);
    expect(out.length).toBeGreaterThan(8);
    for (const p of out) expect(Math.abs(Math.hypot(p[0], p[1]) - 30)).toBeLessThan(0.15);
    // and it is smoother than it was: the sum of the turns is much smaller
    const turns = (r: Pt[]) => r.reduce((s, p, i) => { const a = r[(i + r.length - 1) % r.length], b = r[(i + 1) % r.length]; return s + Math.abs(Math.atan2((p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0]), (p[0] - a[0]) * (b[0] - p[0]) + (p[1] - a[1]) * (b[1] - p[1]))); }, 0);
    expect(turns(out)).toBeLessThan(turns(pts) / 2);
  });
  it('keeps the corners of a square made of many points, and straight sides stay straight', () => {
    const pts: Pt[] = [];
    for (let i = 0; i < 100; i++) pts.push([i, 0]);
    for (let i = 0; i < 100; i++) pts.push([100, i]);
    for (let i = 0; i < 100; i++) pts.push([100 - i, 100]);
    for (let i = 0; i < 100; i++) pts.push([0, 100 - i]);
    const out = fitRing(pts, true, OPT);
    expect(out.length).toBeLessThan(40);
    for (const c of [[0, 0], [100, 0], [100, 100], [0, 100]]) expect(out.some((p) => Math.hypot(p[0] - c[0], p[1] - c[1]) < 1e-6)).toBe(true);
    for (const p of out) {
      const onEdge = Math.abs(p[0]) < 1e-6 || Math.abs(p[0] - 100) < 1e-6 || Math.abs(p[1]) < 1e-6 || Math.abs(p[1] - 100) < 1e-6;
      expect(onEdge).toBe(true);
    }
  });
  it('an open wavy line keeps both ends exactly and follows the wave', () => {
    const pts: Pt[] = [];
    for (let i = 0; i <= 300; i++) pts.push([i / 5, 5 * Math.sin(i / 20) + wobble(i) * 0.03]);
    const out = fitRing(pts, false, OPT);
    expect(out[0]).toEqual(pts[0]);
    expect(out[out.length - 1]).toEqual(pts[pts.length - 1]);
    for (const p of out) expect(Math.abs(p[1] - 5 * Math.sin(p[0] * 5 / 20))).toBeLessThan(0.2);
    expect(out.length).toBeLessThan(pts.length);
  });
  it('too few points are left as they are', () => {
    const tri: Pt[] = [[0, 0], [10, 0], [5, 8]];
    expect(fitRing(tri, true, OPT)).toEqual(tri);
  });
});

describe('fit_curves', () => {
  it('works on the picked paths and reports the point counts', () => {
    const pts: number[][] = [];
    for (let i = 0; i < 400; i++) { const a = (i / 400) * Math.PI * 2; pts.push([30 * Math.cos(a) + wobble(i) * 0.03, 30 * Math.sin(a)]); }
    let d = execute(emptyDoc(), 'add_path', { points: pts, closed: true, layer: 'Layer 1' }).doc;
    const before = (d.shapes[0] as any).rings[0].length;
    const r = execute(d, 'fit_curves', { ids: [d.shapes[0].id], tolerance: 0.1 });
    const after = (r.doc.shapes[0] as any).rings[0].length;
    expect(after).toBeLessThan(before);
    expect(r.message).toContain(`${before} points to ${after}`);
  });
  it('refuses circles only, a zero tolerance, and a bad corner angle', () => {
    let d = execute(emptyDoc(), 'add_circle', { cx: 0, cy: 0, r: 5, layer: 'Layer 1' }).doc;
    expect(() => execute(d, 'fit_curves', { ids: [d.shapes[0].id] })).toThrow(CommandError);
    d = execute(emptyDoc(), 'add_rect', { x: 0, y: 0, w: 5, h: 5, layer: 'Layer 1' }).doc;
    expect(() => execute(d, 'fit_curves', { ids: [d.shapes[0].id], tolerance: 0 })).toThrow(CommandError);
    expect(() => execute(d, 'fit_curves', { ids: [d.shapes[0].id], corner: 200 })).toThrow(CommandError);
  });
});

describe('fit_curves speed', () => {
  it('a traced outline of 60,000 points takes about a second', () => {
    const pts: Pt[] = [];
    for (let i = 0; i < 60000; i++) { const a = (i / 60000) * Math.PI * 2; pts.push([100 * Math.cos(a) + wobble(i) * 0.01, 60 * Math.sin(a) + 5 * Math.sin(a * 7)]); }
    const t = Date.now();
    const out = fitRing(pts, true, OPT);
    expect(Date.now() - t).toBeLessThan(4000);
    expect(out.length).toBeLessThan(5000);
  });
});
