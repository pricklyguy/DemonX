import { describe, expect, it } from 'vitest';
import { emptyDoc } from '../src/core/types';
import type { Doc, PathShape, Pt } from '../src/core/types';
import { execute, CommandError } from '../src/core/commands';
import { shapeBounds } from '../src/core/geom';

const area = (r: Pt[]) => { let a = 0; for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; a += p[0] * q[1] - q[0] * p[1]; } return Math.abs(a) / 2; };
const rect = (w = 40, h = 30, extra: any = {}) => execute(emptyDoc(), 'add_rect', { x: 0, y: 0, w, h, layer: 'Layer 1', ...extra }).doc;
const path = (d: Doc, i = 0) => d.shapes[i] as PathShape;
const line = (pts: number[][], closed = false) => execute(emptyDoc(), 'add_path', { points: pts, closed, layer: 'Layer 1' }).doc;

describe('corner styles', () => {
  it('round: the outside corners lose (4 - π) r² in total and the box is unchanged', () => {
    const d = execute(rect(), 'fillet', { ids: [1], radius: 5 });
    const s = path(d.doc);
    expect(area(s.rings[0])).toBeCloseTo(1200 - (4 - Math.PI) * 25, 0);
    const b = shapeBounds(s)!;
    expect([b.minX, b.minY, b.maxX, b.maxY]).toEqual([0, 0, 40, 30]);
    expect(s.rings[0].some((p) => p[0] === 0 && p[1] === 0)).toBe(false);
    expect(d.message).toContain('4 corners');
  });
  it('round: the curve stays within 0.01 mm of the true circle', () => {
    const s = path(execute(rect(), 'fillet', { ids: [1], radius: 8 }).doc);
    const near = s.rings[0].filter((p) => p[0] < 8.001 && p[1] < 8.001 && !(p[0] === 0 || p[1] === 0 && false));
    for (const p of near) {
      if (p[0] === 8 || p[1] === 8) continue;
      expect(Math.abs(Math.hypot(p[0] - 8, p[1] - 8) - 8)).toBeLessThan(0.011);
    }
  });
  it('cove: a quarter disc is scooped out of each corner', () => {
    const s = path(execute(rect(), 'fillet', { ids: [1], radius: 5, style: 'cove' }).doc);
    expect(area(s.rings[0])).toBeCloseTo(1200 - Math.PI * 25, 0);
    const b = shapeBounds(s)!;
    expect([b.minX, b.minY, b.maxX, b.maxY]).toEqual([0, 0, 40, 30]);
    // the corner itself is no longer part of the outline
    expect(s.rings[0].every((p) => Math.hypot(p[0], p[1]) >= 4.99)).toBe(true);
  });
  it('chamfer: a straight cut across each corner', () => {
    const s = path(execute(rect(), 'fillet', { ids: [1], radius: 5, style: 'chamfer' }).doc);
    expect(s.rings[0]).toHaveLength(8);
    expect(area(s.rings[0])).toBeCloseTo(1200 - 4 * 12.5, 6);
  });
  it('a radius that is too big is limited to half the short side and says so', () => {
    const r = execute(rect(20, 10), 'fillet', { ids: [1], radius: 50 });
    expect(r.message).toContain('limited');
    const b = shapeBounds(path(r.doc))!;
    expect([b.maxX, b.maxY]).toEqual([20, 10]);
    expect(area(path(r.doc).rings[0])).toBeCloseTo(200 - (4 - Math.PI) * 25, 0);
  });
  it('can work on chosen corners only', () => {
    const r = execute(rect(), 'fillet', { ids: [1], radius: 5, nodes: [{ ring: 0, i: 2 }] });
    expect(area(path(r.doc).rings[0])).toBeCloseTo(1200 - (4 - Math.PI) * 25 / 4, 1);
    expect(path(r.doc).rings[0].some((p) => p[0] === 0 && p[1] === 0)).toBe(true);
  });
  it('leaves the ends of an open line alone', () => {
    const d = line([[0, 0], [20, 0], [20, 20]]);
    const r = path(execute(d, 'fillet', { ids: [1], radius: 5 }).doc);
    expect(r.rings[0][0]).toEqual([0, 0]);
    expect(r.rings[0].at(-1)).toEqual([20, 20]);
    expect(r.rings[0].length).toBeGreaterThan(3);
    expect(r.closed).toBe(false);
  });
  it('add_rect takes a radius and a style', () => {
    const d = rect(40, 30, { radius: 5 });
    expect(area(path(d).rings[0])).toBeCloseTo(1200 - (4 - Math.PI) * 25, 0);
    expect(area(path(rect(40, 30, { radius: 5, style: 'cove' })).rings[0])).toBeCloseTo(1200 - Math.PI * 25, 0);
    expect(() => rect(40, 30, { radius: 5, style: 'wavy' })).toThrow(CommandError);
    expect(() => rect(40, 30, { radius: -2 })).toThrow(CommandError);
  });
  it('rounds a reflex corner too (an L shape)', () => {
    const d = execute(emptyDoc(), 'add_path', { points: [[0, 0], [30, 0], [30, 10], [10, 10], [10, 30], [0, 30]], layer: 'Layer 1' }).doc;
    const r = path(execute(d, 'fillet', { ids: [1], radius: 3 }).doc);
    expect(r.rings[0].length).toBeGreaterThan(6);
    expect(area(r.rings[0])).toBeLessThan(area(path(d).rings[0]) + 3); // the inside corner fills in a little, the outer ones lose more
  });
  it('says so when there is nothing to round, and refuses circles', () => {
    expect(() => execute(line([[0, 0], [10, 0]]), 'fillet', { ids: [1], radius: 2 })).toThrow(/no corner/);
    const c = execute(emptyDoc(), 'add_circle', { cx: 0, cy: 0, r: 5, layer: 'Layer 1' }).doc;
    expect(() => execute(c, 'fillet', { ids: [1], radius: 2 })).toThrow(/to_path/);
  });
});

describe('node editing', () => {
  it('moves picked nodes', () => {
    const r = path(execute(rect(), 'nodes_move', { id: 1, nodes: [{ ring: 0, i: 2 }], dx: 5, dy: -3 }).doc);
    expect(r.rings[0][2]).toEqual([45, 27]);
    expect(r.rings[0][0]).toEqual([0, 0]);
  });
  it('inserts a node on a segment, and in the middle of picked pairs', () => {
    const one = execute(rect(), 'node_insert', { id: 1, ring: 0, after: 0, x: 10, y: 0 });
    expect(path(one.doc).rings[0]).toHaveLength(5);
    expect(path(one.doc).rings[0][1]).toEqual([10, 0]);
    expect((one.data as any).added).toEqual([{ ring: 0, i: 1 }]);
    const wrap = path(execute(rect(), 'node_insert', { id: 1, ring: 0, after: 3 }).doc).rings[0];
    expect(wrap).toHaveLength(5);
    expect(wrap[4]).toEqual([0, 15]);
    const mids = execute(rect(), 'node_insert', { id: 1, nodes: [{ ring: 0, i: 0 }, { ring: 0, i: 1 }, { ring: 0, i: 2 }] });
    expect(path(mids.doc).rings[0]).toHaveLength(6);
    expect((mids.data as any).added).toHaveLength(2);
    expect(() => execute(rect(), 'node_insert', { id: 1, nodes: [{ ring: 0, i: 0 }, { ring: 0, i: 2 }] })).toThrow(/next to each other/);
    expect(() => execute(line([[0, 0], [5, 0]]), 'node_insert', { id: 1, ring: 0, after: 1 })).toThrow(/last node/);
  });
  it('deletes nodes but keeps the minimum', () => {
    const r = path(execute(rect(), 'nodes_delete', { id: 1, nodes: [{ ring: 0, i: 1 }] }).doc);
    expect(r.rings[0]).toHaveLength(3);
    expect(() => execute(execute(rect(), 'nodes_delete', { id: 1, nodes: [{ ring: 0, i: 1 }] }).doc, 'nodes_delete', { id: 1, nodes: [{ ring: 0, i: 0 }] })).toThrow(/too few/);
    expect(() => execute(rect(), 'nodes_delete', { id: 1, nodes: [{ ring: 0, i: 9 }] })).toThrow(/does not exist/);
  });
  it('breaks a closed outline open at a node, and a line in two', () => {
    const open = execute(rect(), 'node_break', { id: 1, i: 2 });
    const o = path(open.doc);
    expect(o.closed).toBe(false);
    expect(o.rings[0]).toHaveLength(5);
    expect(o.rings[0][0]).toEqual([40, 30]);
    expect(o.rings[0][4]).toEqual([40, 30]);
    const split = execute(line([[0, 0], [10, 0], [20, 5], [30, 0]]), 'node_break', { id: 1, i: 2 });
    expect(split.doc.shapes).toHaveLength(2);
    expect(split.ids).toHaveLength(2);
    expect((split.doc.shapes[0] as PathShape).rings[0]).toEqual([[0, 0], [10, 0], [20, 5]]);
    expect((split.doc.shapes[1] as PathShape).rings[0]).toEqual([[20, 5], [30, 0]]);
    expect(() => execute(line([[0, 0], [10, 0], [20, 5]]), 'node_break', { id: 1, i: 0 })).toThrow(/middle/);
  });
  it('closes and opens a path', () => {
    const closed = path(execute(line([[0, 0], [10, 0], [10, 10]]), 'path_close', { id: 1 }).doc);
    expect(closed.closed).toBe(true);
    const duplicateEnd = path(execute(line([[0, 0], [10, 0], [10, 10], [0, 0]]), 'path_close', { id: 1 }).doc);
    expect(duplicateEnd.rings[0]).toHaveLength(3);
    expect(path(execute(rect(), 'path_close', { id: 1, closed: false }).doc).closed).toBe(false);
    expect(() => execute(line([[0, 0], [10, 0]]), 'path_close', { id: 1 })).toThrow(/three points/);
  });
  it('turns a circle into a path with about the same area', () => {
    const c = execute(emptyDoc(), 'add_circle', { cx: 5, cy: 5, r: 10, layer: 'Layer 1' }).doc;
    const r = execute(c, 'to_path', { ids: [1] });
    expect(r.doc.shapes[0].kind).toBe('path');
    expect(r.doc.shapes[0].id).toBe(1);
    expect(area(path(r.doc).rings[0])).toBeCloseTo(Math.PI * 100, -1);
    expect(() => execute(rect(), 'to_path', { ids: [1] })).toThrow(/circle/);
  });
  it('refuses circles for node commands', () => {
    const c = execute(emptyDoc(), 'add_circle', { cx: 0, cy: 0, r: 5, layer: 'Layer 1' }).doc;
    expect(() => execute(c, 'nodes_move', { id: 1, nodes: [{ ring: 0, i: 0 }], dx: 1, dy: 1 })).toThrow(/to_path/);
  });
});
