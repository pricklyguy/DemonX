import { describe, expect, it } from 'vitest';
import { emptyDoc as baseDoc } from '../src/core/types';
/** The old two-layer starting document: Layer 1 (cut) and Engrave */
const emptyDoc = () => { const d = baseDoc(); return { ...d, layers: [...d.layers, { ...d.layers[0], name: 'Engrave', mode: 'engrave' as const, speed: 100, power: 20, minPower: 20, color: '#2bb5c9' }] }; };
import type { Doc, PathShape, Pt } from '../src/core/types';
import { execute, CommandError } from '../src/core/commands';
import { parseProject, serializeProject } from '../src/core/project';
import { shapeBounds } from '../src/core/geom';

const rect = (d: Doc, x: number, y: number, w = 10, h = 10) => execute(d, 'add_rect', { x, y, w, h, layer: 'Layer 1' }).doc;
const line = (d: Doc, pts: number[][]) => execute(d, 'add_path', { points: pts, closed: false, layer: 'Layer 1' }).doc;
const ids = (d: Doc) => d.shapes.map((s) => s.id);
const ring = (d: Doc, i = 0) => (d.shapes[i] as PathShape).rings[0];

describe('group', () => {
  it('ties shapes together, and ungroup frees them', () => {
    let d = rect(rect(emptyDoc(), 0, 0), 30, 0);
    const g = execute(d, 'group', { ids: ids(d) });
    expect(g.doc.shapes[0].group).toBeDefined();
    expect(g.doc.shapes[0].group).toBe(g.doc.shapes[1].group);
    const u = execute(g.doc, 'ungroup', { ids: [1] });
    expect(u.doc.shapes.every((s) => s.group === undefined)).toBe(true);
    expect(u.ids).toHaveLength(2);
    expect(() => execute(d, 'group', { ids: [1] })).toThrow(/at least two/);
    expect(() => execute(d, 'ungroup', { ids: [1] })).toThrow(/grouped/);
  });
  it('duplicates and array copies are groups of their own', () => {
    let d = rect(rect(emptyDoc(), 0, 0), 30, 0);
    d = execute(d, 'group', { ids: ids(d) }).doc;
    const dup = execute(d, 'duplicate', { ids: [1, 2] }).doc;
    const groups = new Set(dup.shapes.map((s) => s.group));
    expect(groups.size).toBe(2);
    expect(dup.shapes[2].group).toBe(dup.shapes[3].group);
    expect(dup.shapes[2].group).not.toBe(dup.shapes[0].group);
    const arr = execute(d, 'array', { ids: [1, 2], kind: 'grid', cols: 3, rows: 1, dx: 100, dy: 0 }).doc;
    expect(new Set(arr.shapes.map((s) => s.group)).size).toBe(3);
  });
  it('survives saving and opening, and bad groups are refused', () => {
    let d = rect(rect(emptyDoc(), 0, 0), 30, 0);
    d = execute(d, 'group', { ids: ids(d) }).doc;
    const back = parseProject(serializeProject(d));
    expect(back.shapes[0].group).toBe(d.shapes[0].group);
    expect(back.nextId).toBeGreaterThan(d.shapes[0].group!);
    const bad = JSON.parse(serializeProject(d));
    bad.doc.shapes[0].group = -3;
    expect(() => parseProject(JSON.stringify(bad))).toThrow(/group/);
  });
  it('paste keeps the relation between pasted shapes', () => {
    let d = rect(rect(emptyDoc(), 0, 0), 30, 0);
    d = execute(d, 'group', { ids: ids(d) }).doc;
    const p = execute(d, 'paste', { shapes: JSON.parse(JSON.stringify(d.shapes)), dx: 5, dy: 5 }).doc;
    expect(p.shapes[2].group).toBe(p.shapes[3].group);
    expect(p.shapes[2].group).not.toBe(p.shapes[0].group);
  });
});

describe('join', () => {
  const two = () => line(line(emptyDoc(), [[0, 0], [10, 0]]), [[14, 0], [20, 5]]);
  it('joins with a straight line, whichever way the lines were drawn', () => {
    const r = execute(two(), 'join', { ids: [1, 2] });
    expect(r.doc.shapes).toHaveLength(1);
    expect(ring(r.doc)).toEqual([[0, 0], [10, 0], [14, 0], [20, 5]]);
    expect((r.doc.shapes[0] as PathShape).closed).toBe(false);
    const flipped = line(line(emptyDoc(), [[10, 0], [0, 0]]), [[20, 5], [14, 0]]);
    const f = execute(flipped, 'join', { ids: [1, 2] });
    const pts = ring(f.doc);
    expect(pts).toHaveLength(4);
    expect(new Set(pts.map((p) => p.join()))).toEqual(new Set(['0,0', '10,0', '14,0', '20,5']));
    expect(pts[1].join() === '10,0' ? pts[2].join() : pts[1].join()).toBe('14,0');
  });
  it('joins at the nearest ends', () => {
    const d = line(line(emptyDoc(), [[0, 0], [10, 0]]), [[12, 0], [30, 0]]);
    expect(ring(execute(d, 'join', { ids: [1, 2] }).doc)).toEqual([[0, 0], [10, 0], [12, 0], [30, 0]]);
  });
  it('move end points puts both ends at their middle', () => {
    const r = execute(two(), 'join', { ids: [1, 2], mode: 'move' });
    expect(ring(r.doc)).toEqual([[0, 0], [12, 0], [20, 5]]);
  });
  it('smooth curve leaves and arrives along the lines', () => {
    const d = line(line(emptyDoc(), [[0, 0], [10, 0]]), [[20, 10], [20, 20]]);
    const r = ring(execute(d, 'join', { ids: [1, 2], mode: 'curve' }).doc);
    expect(r.length).toBeGreaterThan(6);
    expect(r[0]).toEqual([0, 0]);
    expect(r.at(-1)).toEqual([20, 20]);
    const a = r.findIndex((p) => p[0] === 10 && p[1] === 0);
    expect(r[a + 1][1]).toBeLessThan(1);          // starts off along +X
    expect(r[a + 1][0]).toBeGreaterThan(10);
    const b = r.findIndex((p) => p[0] === 20 && p[1] === 10);
    expect(r[b - 1][1]).toBeLessThan(10);         // arrives heading +Y
    expect(Math.abs(r[b - 1][0] - 20)).toBeLessThan(2.5);
  });
  it('joins several lines into a chain', () => {
    const d = line(line(line(emptyDoc(), [[0, 0], [10, 0]]), [[30, 0], [40, 0]]), [[11, 0], [20, 0]]);
    const r = ring(execute(d, 'join', { ids: [1, 2, 3] }).doc);
    expect(r).toHaveLength(6);
    expect(r[0][0] === 0 || r[0][0] === 40).toBe(true);
  });
  it('a single line is closed by its own ends', () => {
    const d = line(emptyDoc(), [[0, 0], [10, 0], [10, 10]]);
    const r = execute(d, 'join', { ids: [1] }).doc.shapes[0] as PathShape;
    expect(r.closed).toBe(true);
    expect(r.rings[0]).toHaveLength(3);
    const c = execute(d, 'join', { ids: [1], mode: 'curve' }).doc.shapes[0] as PathShape;
    expect(c.closed).toBe(true);
    expect(c.rings[0].length).toBeGreaterThan(5);
  });
  it('refuses outlines, circles and bad modes', () => {
    const d = rect(line(emptyDoc(), [[0, 0], [5, 0]]), 20, 20);
    expect(() => execute(d, 'join', { ids: [1, 2] })).toThrow(/open lines/);
    const c = execute(line(emptyDoc(), [[0, 0], [5, 0]]), 'add_circle', { cx: 9, cy: 9, r: 2, layer: 'Layer 1' }).doc;
    expect(() => execute(c, 'join', { ids: [1, 2] })).toThrow(/Circles/);
    expect(() => execute(two(), 'join', { ids: [1, 2], mode: 'zigzag' })).toThrow(CommandError);
  });
});

describe('layers for selected shapes', () => {
  it('copy_to_layer leaves the originals, selects the copies, and can make the layer', () => {
    const d = rect(emptyDoc(), 0, 0);
    const r = execute(d, 'copy_to_layer', { ids: [1], layer: 'Engrave' });
    expect(r.doc.shapes).toHaveLength(2);
    expect(r.doc.shapes[0].layer).toBe('Layer 1');
    expect(r.doc.shapes[1].layer).toBe('Engrave');
    expect(r.ids).toEqual([r.doc.shapes[1].id]);
    expect(() => execute(d, 'copy_to_layer', { ids: [1], layer: 'Nope' })).toThrow(/no layer/);
    const n = execute(d, 'copy_to_layer', { ids: [1], layer: 'Pocket', create: true });
    expect(n.doc.layers.some((l) => l.name === 'Pocket')).toBe(true);
  });
  it('set_layer moves, and can create the layer', () => {
    const d = rect(emptyDoc(), 0, 0);
    const r = execute(d, 'set_layer', { ids: [1], layer: 'Pocket', create: true });
    expect(r.doc.shapes[0].layer).toBe('Pocket');
    expect(r.doc.layers.some((l) => l.name === 'Pocket')).toBe(true);
  });
});
