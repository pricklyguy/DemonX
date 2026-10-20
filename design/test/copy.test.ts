import { describe, expect, it } from 'vitest';
import { emptyDoc } from '../src/core/types';
import type { Doc, Shape } from '../src/core/types';
import { execute, CommandError } from '../src/core/commands';
import { shapeBounds } from '../src/core/geom';

const bb = (s: Shape) => shapeBounds(s)!;
const rect = (d: Doc, x: number, y: number, w: number, h: number) => execute(d, 'add_rect', { x, y, w, h, layer: 'Layer 1' }).doc;
const one = () => rect(emptyDoc(), 0, 0, 10, 5);

describe('duplicate', () => {
  it('copies next to the original with a new id and selects the copy', () => {
    const d = one();
    const r = execute(d, 'duplicate', { ids: [d.shapes[0].id] });
    expect(r.doc.shapes).toHaveLength(2);
    expect(r.ids).toEqual([r.doc.shapes[1].id]);
    expect(r.doc.shapes[1].id).not.toBe(d.shapes[0].id);
    expect(bb(r.doc.shapes[1]).minX).toBe(5);
    expect(bb(r.doc.shapes[1]).minY).toBe(-5);
    expect(bb(r.doc.shapes[0]).minX).toBe(0);
  });
  it('takes an offset', () => {
    const d = one();
    const r = execute(d, 'duplicate', { ids: [d.shapes[0].id], dx: 20, dy: 0 });
    expect(bb(r.doc.shapes[1]).minX).toBe(20);
  });
});

describe('paste', () => {
  it('adds copies of shapes, keeping the layer and adding it if missing', () => {
    let src = emptyDoc();
    src = execute(src, 'layer_set', { name: 'Layer 1', color: '#ff0000' }).doc;
    const circ = execute(src, 'add_circle', { cx: 5, cy: 5, r: 2, layer: 'Layer 1' }).doc.shapes[0];
    const target = emptyDoc();
    const r = execute(target, 'paste', { shapes: [circ], dx: 3, dy: 1 });
    expect(r.doc.shapes).toHaveLength(1);
    const c: any = r.doc.shapes[0];
    expect(c.cx).toBe(8);
    expect(c.cy).toBe(6);
    expect(r.doc.layers.some((l) => l.name === c.layer)).toBe(true);
    const odd = execute(target, 'paste', { shapes: [{ ...circ, layer: 'Brand new' }] });
    expect(odd.doc.layers.some((l) => l.name === 'Brand new')).toBe(true);
  });
  it('refuses nonsense', () => {
    expect(() => execute(emptyDoc(), 'paste', { shapes: [] })).toThrow(CommandError);
    expect(() => execute(emptyDoc(), 'paste', { shapes: [{ kind: 'path', rings: [[[0, 'x']]] }] })).toThrow(/not valid/);
    expect(() => execute(emptyDoc(), 'paste', { shapes: [{ kind: 'circle', cx: 0, cy: 0, r: -1 }] })).toThrow(/not valid/);
  });
});

describe('array', () => {
  it('grid: cols x rows with the original in place', () => {
    const d = one();
    const r = execute(d, 'array', { ids: [d.shapes[0].id], kind: 'grid', cols: 3, rows: 2, dx: 15, dy: 10 });
    expect(r.doc.shapes).toHaveLength(6);
    const xs = r.doc.shapes.map((s) => bb(s).minX).sort((a, b) => a - b);
    expect(xs).toEqual([0, 0, 15, 15, 30, 30]);
    const ys = r.doc.shapes.map((s) => bb(s).minY).sort((a, b) => a - b);
    expect(ys).toEqual([0, 0, 0, 10, 10, 10]);
    expect(bb(r.doc.shapes[0]).minX).toBe(0);
  });
  it('grid with negative spacing goes left and down', () => {
    const d = one();
    const r = execute(d, 'array', { ids: [d.shapes[0].id], kind: 'grid', cols: 2, rows: 1, dx: -20, dy: 0 });
    expect(bb(r.doc.shapes[1]).minX).toBe(-20);
  });
  it('grid refuses zero spacing, one place, fractions and huge counts', () => {
    const d = one(); const ids = [d.shapes[0].id];
    expect(() => execute(d, 'array', { ids, kind: 'grid', cols: 3, rows: 1, dx: 0, dy: 0 })).toThrow(/on top/);
    expect(() => execute(d, 'array', { ids, kind: 'grid', cols: 1, rows: 1, dx: 5, dy: 5 })).toThrow(/two places/);
    expect(() => execute(d, 'array', { ids, kind: 'grid', cols: 2.5, rows: 1, dx: 5, dy: 5 })).toThrow(/whole number/);
    expect(() => execute(d, 'array', { ids, kind: 'grid', cols: 100, rows: 100, dx: 5, dy: 5 })).toThrow(/limit/);
  });
  it('circular: shapes spread around a full circle and turn with it', () => {
    let d = emptyDoc();
    d = rect(d, 10, -1, 4, 2); // centre (12, 0)
    const r = execute(d, 'array', { ids: [d.shapes[0].id], kind: 'circular', count: 4, cx: 0, cy: 0 });
    expect(r.doc.shapes).toHaveLength(4);
    const cs = r.doc.shapes.map((s) => { const b = bb(s); const r6 = (v: number) => (Math.round(v * 1e6) / 1e6) + 0;
      return [r6((b.minX + b.maxX) / 2) || 0, r6((b.minY + b.maxY) / 2) || 0]; });
    expect(cs).toContainEqual([12, 0]);
    expect(cs).toContainEqual([0, 12]);
    expect(cs).toContainEqual([-12, 0]);
    expect(cs).toContainEqual([0, -12]);
    const turned = bb(r.doc.shapes[1]);
    expect(turned.maxX - turned.minX).toBeCloseTo(2); // the 4 x 2 bar stands up
  });
  it('circular without turning keeps the orientation; a part circle ends at the far angle', () => {
    let d = rect(emptyDoc(), 10, -1, 4, 2);
    const r = execute(d, 'array', { ids: [d.shapes[0].id], kind: 'circular', count: 3, angle: 180, cx: 0, cy: 0, rotate: false });
    const b = bb(r.doc.shapes[2]);
    expect(b.maxX - b.minX).toBeCloseTo(4);
    expect((b.minX + b.maxX) / 2).toBeCloseTo(-12);
    const last = bb(r.doc.shapes[1]);
    expect((last.minX + last.maxX) / 2).toBeCloseTo(0);
    expect((last.minY + last.maxY) / 2).toBeCloseTo(12);
  });
  it('circles stay circles', () => {
    const d = execute(emptyDoc(), 'add_circle', { cx: 10, cy: 0, r: 1, layer: 'Layer 1' }).doc;
    const r = execute(d, 'array', { ids: [d.shapes[0].id], kind: 'circular', count: 6, cx: 0, cy: 0 });
    expect(r.doc.shapes.every((s) => s.kind === 'circle')).toBe(true);
  });
  it('refuses an unknown kind', () => {
    const d = one();
    expect(() => execute(d, 'array', { ids: [d.shapes[0].id], kind: 'spiral' })).toThrow(CommandError);
  });
});
