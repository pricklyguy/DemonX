import { describe, expect, it } from 'vitest';
import { emptyDoc } from '../src/core/types';
import type { Doc } from '../src/core/types';
import { execute, CommandError } from '../src/core/commands';
import { shapeBounds as sbn } from '../src/core/geom';
import type { Shape } from '../src/core/types';
const shapeBounds = (s: Shape) => sbn(s)!;

const rect = (d: Doc, x: number, y: number, w: number, h: number) => execute(d, 'add_rect', { x, y, w, h, layer: 'Layer 1' }).doc;
const box = (d: Doc, i: number) => shapeBounds(d.shapes[i]);
const ids = (d: Doc) => d.shapes.map((s) => s.id);

function three(): Doc {
  let d = emptyDoc();
  d = rect(d, 0, 0, 10, 10);
  d = rect(d, 20, 5, 30, 10);
  d = rect(d, 100, -4, 20, 6);
  return d;
}

describe('align', () => {
  it('lines shapes up on the left edge of the selection', () => {
    const d = execute(three(), 'align', { ids: ids(three()), edge: 'left' }).doc;
    expect(d.shapes.map((s) => shapeBounds(s).minX)).toEqual([0, 0, 0]);
  });
  it('right edge, top, bottom and centres', () => {
    const base = three();
    const run = (edge: string) => execute(base, 'align', { ids: ids(base), edge }).doc;
    expect(run('right').shapes.map((s) => shapeBounds(s).maxX)).toEqual([120, 120, 120]);
    expect(run('top').shapes.map((s) => shapeBounds(s).maxY)).toEqual([15, 15, 15]);
    expect(run('bottom').shapes.map((s) => shapeBounds(s).minY)).toEqual([-4, -4, -4]);
    const hc = run('hcenter').shapes.map((s) => { const b = shapeBounds(s); return (b.minX + b.maxX) / 2; });
    expect(hc.every((v) => Math.abs(v - 60) < 1e-9)).toBe(true);
    const vc = run('vcenter').shapes.map((s) => { const b = shapeBounds(s); return (b.minY + b.maxY) / 2; });
    expect(vc.every((v) => Math.abs(v - 5.5) < 1e-9)).toBe(true);
  });
  it('keeps sizes unchanged', () => {
    const base = three();
    const d = execute(base, 'align', { ids: ids(base), edge: 'top' }).doc;
    base.shapes.forEach((s, i) => {
      const a = shapeBounds(s), b = shapeBounds(d.shapes[i]);
      expect(b.maxX - b.minX).toBeCloseTo(a.maxX - a.minX);
    });
  });
  it('a single shape aligns to the work area', () => {
    let d = execute(emptyDoc(), 'workspace_set', { kind: 'laser', width: 300, height: 200 }).doc;
    d = rect(d, 50, 50, 20, 10);
    const r = execute(d, 'align', { ids: ids(d), edge: 'right' }).doc;
    expect(shapeBounds(r.shapes[0]).maxX).toBeCloseTo(300);
    const c = execute(d, 'align', { ids: ids(d), edge: 'vcenter' }).doc;
    expect(shapeBounds(c.shapes[0]).minY).toBeCloseTo(95);
  });
  it('refuses with a clear message', () => {
    const d = rect(emptyDoc(), 0, 0, 5, 5);
    expect(() => execute(d, 'align', { ids: ids(d), edge: 'left', to: 'selection' })).toThrow(CommandError);
    expect(() => execute(d, 'align', { ids: ids(d), edge: 'left', to: 'work' })).toThrow(/no work area/);
    expect(() => execute(three(), 'align', { ids: ids(three()), edge: 'middle' })).toThrow(/edge/);
  });
});

describe('distribute', () => {
  it('equalises the gaps and leaves the outer two alone', () => {
    const base = three();
    const d = execute(base, 'distribute', { ids: ids(base), axis: 'x' }).doc;
    const [a, b, c] = [box(d, 0), box(d, 1), box(d, 2)];
    expect(a.minX).toBe(0);
    expect(c.minX).toBe(100);
    expect(b.minX - a.maxX).toBeCloseTo(c.minX - b.maxX);
    expect(b.minX - a.maxX).toBeCloseTo((100 - 10 - 30) / 2);
  });
  it('spaces centres evenly', () => {
    const base = three();
    const d = execute(base, 'distribute', { ids: ids(base), axis: 'x', mode: 'centers' }).doc;
    const m = [0, 1, 2].map((i) => (box(d, i).minX + box(d, i).maxX) / 2);
    expect(m[1] - m[0]).toBeCloseTo(m[2] - m[1]);
    expect(m[0]).toBeCloseTo(5);
    expect(m[2]).toBeCloseTo(110);
  });
  it('works vertically and does not depend on selection order', () => {
    const base = three();
    const d = execute(base, 'distribute', { ids: [3, 1, 2].map((_, i) => base.shapes[[2, 0, 1][i]].id), axis: 'y' }).doc;
    const bs = d.shapes.map((s) => shapeBounds(s)).sort((p, q) => p.minY - q.minY);
    expect(bs[1].minY - bs[0].maxY).toBeCloseTo(bs[2].minY - bs[1].maxY);
  });
  it('needs three shapes', () => {
    const d = rect(rect(emptyDoc(), 0, 0, 5, 5), 20, 0, 5, 5);
    expect(() => execute(d, 'distribute', { ids: ids(d), axis: 'x' })).toThrow(/three/);
  });
});

describe('align and space: a group is one object', () => {
  // two rectangles grouped (a 10 x 10 at 0,0 and a 10 x 10 at 40,0: one 50 wide object), a loose one at 100,20, and one at 200,40
  function withGroup(): Doc {
    let d = emptyDoc();
    d = rect(d, 0, 0, 10, 10);
    d = rect(d, 40, 0, 10, 10);
    d = execute(d, 'group', { ids: [d.shapes[0].id, d.shapes[1].id] }).doc;
    d = rect(d, 100, 20, 10, 10);
    d = rect(d, 200, 40, 10, 10);
    return d;
  }
  it('aligning to the left edge moves the group together, not its members to one place', () => {
    const d0 = withGroup();
    const d = execute(d0, 'align', { ids: ids(d0), edge: 'left' }).doc;
    expect(d.shapes.map((s) => shapeBounds(s).minX)).toEqual([0, 40, 0, 0]);
  });
  it('centring uses the middle of the whole group', () => {
    const d0 = withGroup();
    const d = execute(d0, 'align', { ids: ids(d0), edge: 'hcenter', to: 'first' }).doc;
    // the group (0..50) is first and stays: centre 25
    expect(d.shapes.map((s) => shapeBounds(s).minX + 5)).toEqual([5, 45, 25, 25]);
  });
  it('picking one member still moves the whole group', () => {
    const d0 = withGroup();
    const d = execute(d0, 'align', { ids: [d0.shapes[0].id, d0.shapes[3].id], edge: 'right' }).doc;
    // the group's right edge is 50, the loose one's 210: the group goes to 210, both its members with it
    expect(d.shapes.map((s) => shapeBounds(s).maxX)).toEqual([170, 210, 110, 210]);
  });
  it('even spacing treats the group as one box', () => {
    const d0 = withGroup();
    const d = execute(d0, 'distribute', { ids: ids(d0), axis: 'x' }).doc;
    // boxes: group 0..50, 100..110, 200..210 -> the middle one moves to leave 
    expect(shapeBounds(d.shapes[2]).minX).toBe(120);
    expect(shapeBounds(d.shapes[0]).minX).toBe(0);
    expect(shapeBounds(d.shapes[1]).minX).toBe(40);
  });
});

describe('align to the first object, both centres, a fixed gap', () => {
  it('"first" keeps the first object where it is', () => {
    const base = three();
    const d = execute(base, 'align', { ids: ids(base), edge: 'left', to: 'first' }).doc;
    expect(d.shapes.map((s) => shapeBounds(s).minX)).toEqual([0, 0, 0]);
    const e = execute(base, 'align', { ids: [...ids(base)].reverse(), edge: 'left', to: 'first' }).doc;
    expect(e.shapes.map((s) => shapeBounds(s).minX)).toEqual([100, 100, 100]);
  });
  it('"center" puts both centres on the target, here the work area', () => {
    let d = execute(emptyDoc(), 'workspace_set', { kind: 'laser', width: 300, height: 200 }).doc;
    d = execute(d, 'add_rect', { x: 3, y: 4, w: 10, h: 20, layer: 'Layer 1' }).doc;
    const d2 = execute(d, 'align', { ids: ids(d), edge: 'center', to: 'work' }).doc;
    const b = shapeBounds(d2.shapes[0]);
    expect((b.minX + b.maxX) / 2).toBeCloseTo(150, 5);
    expect((b.minY + b.maxY) / 2).toBeCloseTo(100, 5);
  });
  it('a fixed gap lines shapes up with that space between them, the first staying put (two are enough)', () => {
    const base = three();
    const d = execute(base, 'distribute', { ids: ids(base), axis: 'x', gap: 5 }).doc;
    expect(d.shapes.map((s) => shapeBounds(s).minX)).toEqual([0, 15, 50]);
    const two = execute(base, 'distribute', { ids: [base.shapes[0].id, base.shapes[2].id], axis: 'x', gap: 2 }).doc;
    expect(shapeBounds(two.shapes[2]).minX).toBe(12);
    expect(() => execute(base, 'distribute', { ids: [base.shapes[0].id], axis: 'x', gap: 2 })).toThrow(CommandError);
  });
});
