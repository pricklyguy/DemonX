import { describe, expect, it } from 'vitest';
import { emptyDoc } from '../src/core/types';
import { execute, CommandError } from '../src/core/commands';

const line = (d: any, pts: number[][]) => execute(d, 'add_path', { points: pts, closed: false, layer: 'Layer 1' }).doc;
const ids = (d: any) => d.shapes.map((s: any) => s.id);
const ring = (d: any, i: number) => d.shapes[i].rings[0];

describe('extend', () => {
  it('two lines that stop short of each other are extended to the corner', () => {
    let d = line(emptyDoc(), [[0, 0], [8, 0]]);
    d = line(d, [[10, 10], [10, 2]]);
    const r = execute(d, 'extend', { ids: ids(d) });
    expect(ring(r.doc, 0)[1]).toEqual([10, 0]);
    expect(ring(r.doc, 1)[1]).toEqual([10, 0]);
    expect(r.message).toMatch(/meet at 10, 0/);
  });
  it('works from the start of a line as well, and keeps the other points', () => {
    let d = line(emptyDoc(), [[8, 0], [0, 0], [0, 5]]);   // its start (8, 0) points to the right
    d = line(d, [[20, -5], [20, 5]]);
    const r = execute(d, 'extend', { ids: ids(d) });
    expect(ring(r.doc, 0)).toEqual([[20, 0], [0, 0], [0, 5]]);
    expect(ring(r.doc, 1)).toEqual([[20, -5], [20, 5]]);   // it crosses the other's span, so only one line moves
  });
  it('a line is extended to meet the middle of another (a T), which stays as it is', () => {
    let d = line(emptyDoc(), [[0, 0], [8, 0]]);
    d = line(d, [[10, -5], [10, 5]]);
    const r = execute(d, 'extend', { ids: ids(d) });
    expect(ring(r.doc, 0)[1]).toEqual([10, 0]);
    expect(ring(r.doc, 1)).toEqual([[10, -5], [10, 5]]);
  });
  it('uses the ends that need the least extending', () => {
    let d = line(emptyDoc(), [[0, 0], [4, 0]]);
    d = line(d, [[6, 100], [6, 3]]);
    const r = execute(d, 'extend', { ids: ids(d) });
    expect(ring(r.doc, 0)[1]).toEqual([6, 0]);
    expect(ring(r.doc, 1)[1]).toEqual([6, 0]);
    expect(ring(r.doc, 1)[0]).toEqual([6, 100]);
  });
  it('refuses lines that run side by side, already cross, or the wrong things', () => {
    let par = line(line(emptyDoc(), [[0, 0], [5, 0]]), [[0, 5], [5, 5]]);
    expect(() => execute(par, 'extend', { ids: ids(par) })).toThrow(CommandError);
    let cross = line(line(emptyDoc(), [[0, 0], [10, 0]]), [[5, -5], [5, 5]]);
    expect(() => execute(cross, 'extend', { ids: ids(cross) })).toThrow(/already cross/);
    let one = line(emptyDoc(), [[0, 0], [5, 0]]);
    expect(() => execute(one, 'extend', { ids: ids(one) })).toThrow(/exactly two/);
    let closed = execute(line(emptyDoc(), [[0, 0], [5, 0]]), 'add_rect', { x: 0, y: 0, w: 5, h: 5, layer: 'Layer 1' }).doc;
    expect(() => execute(closed, 'extend', { ids: ids(closed) })).toThrow(CommandError);
  });
});
