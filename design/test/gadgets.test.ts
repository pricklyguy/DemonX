import { describe, expect, it } from 'vitest';
import { emptyDoc } from '../src/core/types';
import type { Doc, Shape } from '../src/core/types';
import { execute, CommandError } from '../src/core/commands';
import { shapeBounds } from '../src/core/geom';

const bb = (s: Shape) => shapeBounds(s)!;
const mid = (s: Shape) => { const b = bb(s); return [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2]; };
const circle = (d: Doc, cx: number, cy: number, r = 2, layer = 'Layer 1') => execute(d, 'add_circle', { cx, cy, r, layer }).doc;
const rect = (d: Doc, x: number, y: number, w: number, h: number) => execute(d, 'add_rect', { x, y, w, h, layer: 'Layer 1' }).doc;
const line = (d: Doc, pts: number[][]) => execute(d, 'add_path', { points: pts, closed: false, layer: 'Layer 1' }).doc;
const ids = (d: Doc) => d.shapes.map((s) => s.id);

describe('rotate_each', () => {
  it('turns each shape about its own centre', () => {
    let d = rect(emptyDoc(), 0, 0, 10, 2);
    d = rect(d, 50, 50, 10, 2);
    const r = execute(d, 'rotate_each', { ids: ids(d), angle: 90 }).doc;
    for (let i = 0; i < 2; i++) {
      expect(mid(r.shapes[i])[0]).toBeCloseTo(mid(d.shapes[i])[0]);
      expect(mid(r.shapes[i])[1]).toBeCloseTo(mid(d.shapes[i])[1]);
      expect(bb(r.shapes[i]).maxY - bb(r.shapes[i]).minY).toBeCloseTo(10);
    }
  });
});

describe('marker_copy', () => {
  it('copies onto a new layer, shifted the opposite way, leaving the original', () => {
    let d = line(emptyDoc(), [[0, 0], [10, 0]]);
    const r = execute(d, 'marker_copy', { ids: ids(d), x: 12, y: -3 });
    expect(r.doc.shapes).toHaveLength(2);
    const c = r.doc.shapes[1];
    expect(c.layer).toBe('Sharpie Path');
    expect(bb(c).minX).toBe(-12);
    expect(bb(c).minY).toBe(3);
    expect(bb(r.doc.shapes[0]).minX).toBe(0);
    expect(r.doc.layers.some((l) => l.name === 'Sharpie Path')).toBe(true);
  });
  it('refuses a zero offset', () => {
    const d = rect(emptyDoc(), 0, 0, 1, 1);
    expect(() => execute(d, 'marker_copy', { ids: ids(d), x: 0, y: 0 })).toThrow(/nothing to shift/);
  });
});

describe('replace_with', () => {
  function setup() {
    let d = circle(emptyDoc(), 100, 100, 3);           // the pixel inside the template
    d = rect(d, 103, 99, 4, 2);                        // a notch beside it
    const tpl = ids(d);
    d = circle(d, 0, 0, 1);
    d = circle(d, 20, 5, 1);
    return { d, tpl, targets: [d.shapes[2].id, d.shapes[3].id] };
  }
  it('centres the template circle on each target and drops the originals', () => {
    const { d, tpl, targets } = setup();
    const r = execute(d, 'replace_with', { targets, template: tpl }).doc;
    expect(r.shapes).toHaveLength(4);
    const circles = r.shapes.filter((s) => s.kind === 'circle') as any[];
    expect(circles.map((c) => [c.cx, c.cy]).sort((p, q) => p[0] - q[0])).toEqual([[0, 0], [20, 5]]);
    const notch = r.shapes.filter((s) => s.kind === 'path').sort((p, q) => bb(p).minX - bb(q).minX);
    expect(bb(notch[0]).minX).toBe(3);
    expect(bb(notch[1]).minX).toBe(23);
  });
  it('can keep the template and back up the originals on a hidden layer', () => {
    const { d, tpl, targets } = setup();
    const r = execute(d, 'replace_with', { targets, template: tpl, keep_template: true, backup: true }).doc;
    expect(r.shapes).toHaveLength(2 + 4 + 2);
    const back = r.layers.find((l) => l.name === 'Replaced (backup)')!;
    expect(back.output).toBe(false);
    expect(r.shapes.filter((s) => s.layer === back.name)).toHaveLength(2);
  });
  it('refuses a template that is also a target', () => {
    const { d, tpl } = setup();
    expect(() => execute(d, 'replace_with', { targets: tpl, template: tpl })).toThrow(/cannot also/);
  });
});

describe('nudge_to_guide', () => {
  it('lands each centre on the nearest point of the guide', () => {
    let d = circle(emptyDoc(), 5, 3, 1);
    d = circle(d, 20, -4, 1);
    d = line(d, [[0, 0], [30, 0]]);
    const r = execute(d, 'nudge_to_guide', { ids: ids(d), guide: d.shapes[2].id }).doc;
    expect((r.shapes[0] as any).cy).toBeCloseTo(0);
    expect((r.shapes[0] as any).cx).toBeCloseTo(5);
    expect((r.shapes[1] as any).cy).toBeCloseTo(0);
    expect((r.shapes[1] as any).cx).toBeCloseTo(20);
    expect(r.shapes[2]).toEqual(d.shapes[2]);
  });
  it('spaces them evenly between the outer two', () => {
    let d = circle(emptyDoc(), 0, 2, 1);
    d = circle(d, 3, 2, 1);
    d = circle(d, 4, 2, 1);
    d = circle(d, 30, 2, 1);
    d = line(d, [[0, 0], [30, 0]]);
    const r = execute(d, 'nudge_to_guide', { ids: ids(d), guide: d.shapes[4].id, distribute: true }).doc;
    expect(r.shapes.slice(0, 4).map((s: any) => Math.round(s.cx * 1e6) / 1e6)).toEqual([0, 10, 20, 30]);
  });
  it('follows a bend', () => {
    let d = circle(emptyDoc(), 12, 5, 1);
    d = line(d, [[0, 0], [10, 0], [10, 10]]);
    const r = execute(d, 'nudge_to_guide', { ids: ids(d), guide: d.shapes[1].id }).doc;
    expect((r.shapes[0] as any).cx).toBeCloseTo(10);
    expect((r.shapes[0] as any).cy).toBeCloseTo(5);
  });
  it('needs a guide', () => {
    const d = circle(emptyDoc(), 0, 0, 1);
    expect(() => execute(d, 'nudge_to_guide', { ids: ids(d) })).toThrow(/guide/);
  });
});

describe('count_matching', () => {
  it('finds the same shape however it was moved, turned or started', () => {
    let d = execute(emptyDoc(), 'add_path', { points: [[0, 0], [20, 0], [20, 5], [8, 5], [8, 12], [0, 12]], layer: 'Layer 1' }).doc; // an L
    const lShape = d.shapes[0] as any;
    const turned = execute(d, 'rotate', { ids: [lShape.id], angle: 90, cx: 0, cy: 0 }).doc;
    d = { ...d, shapes: [...d.shapes], nextId: d.nextId };
    let doc = d;
    doc = execute(doc, 'paste', { shapes: [turned.shapes[0]], dx: 50, dy: 0 }).doc;
    const start = lShape.rings[0];
    doc = execute(doc, 'paste', { shapes: [{ ...lShape, rings: [[...start.slice(2), ...start.slice(0, 2)].reverse()] }], dx: 0, dy: 60 }).doc;
    doc = rect(doc, 0, 100, 20, 12);
    doc = circle(doc, 70, 70, 4);
    const r = execute(doc, 'count_matching', { ids: ids(doc), reference: lShape.id });
    expect((r.data as any).count).toBe(3);
    expect(r.ids).toHaveLength(3);
  });
  it('matches circles by size and reports ones lying on top of each other', () => {
    let d = circle(emptyDoc(), 0, 0, 3);
    d = circle(d, 10, 0, 3);
    d = circle(d, 10, 0, 3);
    d = circle(d, 20, 0, 3.5);
    const r = execute(d, 'count_matching', { ids: ids(d) });
    expect((r.data as any).count).toBe(1); // the last one picked is the reference, and nothing else is 3.5 mm
    const same = execute(d, 'count_matching', { ids: ids(d), reference: d.shapes[0].id });
    expect((same.data as any).count).toBe(3);
    expect((same.data as any).overlapping).toHaveLength(1);
  });
  it('does not call a different rectangle a match', () => {
    let d = rect(emptyDoc(), 0, 0, 20, 10);
    d = rect(d, 30, 0, 10, 20);   // same shape turned
    d = rect(d, 60, 0, 22, 10);
    const r = execute(d, 'count_matching', { ids: ids(d), reference: d.shapes[0].id });
    expect((r.data as any).ids).toEqual([d.shapes[0].id, d.shapes[1].id]);
  });
});

describe('auto_number', () => {
  it('stamps numbers in order, with wiring and nodes', () => {
    let d = circle(emptyDoc(), 0, 0, 2);
    d = circle(d, 20, 0, 2);
    d = circle(d, 40, 0, 2);
    const r = execute(d, 'auto_number', { ids: [d.shapes[2].id, d.shapes[0].id, d.shapes[1].id], start: 8, height: 4 });
    expect((r.data as any).next).toBe(11);
    expect((r.data as any).last).toEqual([20, 0]);
    const nums = r.doc.shapes.filter((s) => s.layer === 'Pixel Numbers');
    expect(nums).toHaveLength(3);
    // the first stamped number belongs to the circle at x=40 and is the digit 8 (all seven strokes)
    expect((nums[0] as any).rings).toHaveLength(7);
    expect(mid(nums[0])[0]).toBeCloseTo(40);
    // 10 has two digits: one 1 (2 strokes) and one 0 (6 strokes)
    expect((nums[2] as any).rings).toHaveLength(8);
    const wire = r.doc.shapes.find((s) => s.layer === 'Pixel Wiring') as any;
    expect(wire.rings[0]).toEqual([[40, 0], [0, 0], [20, 0]]);
    expect(wire.closed).toBe(false);
    expect(r.doc.shapes.filter((s) => s.layer === 'Pixel Nodes')).toHaveLength(3);
  });
  it('can carry on from a previous run and skip the extras', () => {
    let d = circle(emptyDoc(), 0, 0, 2);
    const r = execute(d, 'auto_number', { ids: ids(d), join_from: [-10, 0], nodes: false });
    const wire = r.doc.shapes.find((s) => s.layer === 'Pixel Wiring') as any;
    expect(wire.rings[0]).toEqual([[-10, 0], [0, 0]]);
    expect(r.doc.shapes.some((s) => s.layer === 'Pixel Nodes')).toBe(false);
    const none = execute(d, 'auto_number', { ids: ids(d), wiring: false, nodes: false });
    expect(none.doc.shapes).toHaveLength(2);
  });
  it('refuses bad numbers', () => {
    const d = circle(emptyDoc(), 0, 0, 2);
    expect(() => execute(d, 'auto_number', { ids: ids(d), start: 1.5 })).toThrow(CommandError);
    expect(() => execute(d, 'auto_number', { ids: ids(d), join_from: [1] })).toThrow(/join_from/);
  });
});
