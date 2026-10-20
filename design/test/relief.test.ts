import { describe, expect, it } from 'vitest';
import { cellsToBase64, parseStl, rasterizeStl, reliefCells, reliefHeightAt, reliefHeightMm, type Relief } from '../src/core/relief';
import { emptyDoc } from '../src/core/types';
import { execute } from '../src/core/commands';
import { parseProject, serializeProject } from '../src/core/project';

type V = [number, number, number];
type Tri = [V, V, V];
/** A square pyramid: base 20 x 20 at z = 0 from the corner (0,0), apex 10 high over the middle, so the slope is 1 */
const pyramid = (): Tri[] => {
  const a: V = [0, 0, 0], b: V = [20, 0, 0], c: V = [20, 20, 0], d: V = [0, 20, 0], t: V = [10, 10, 10];
  return [[a, b, t], [b, c, t], [c, d, t], [d, a, t], [a, c, b], [a, d, c]];
};
const binary = (tris: Tri[]): ArrayBuffer => {
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, tris.length, true);
  tris.forEach((t, i) => t.flat().forEach((v, k) => dv.setFloat32(84 + i * 50 + 12 + k * 4, v, true)));
  return buf;
};
const ascii = (tris: Tri[]): ArrayBuffer => new TextEncoder().encode('solid p\n' + tris.map((t) => `facet normal 0 0 1\n outer loop\n${t.map((v) => `  vertex ${v.join(' ')}`).join('\n')}\n endloop\nendfacet`).join('\n') + '\nendsolid p\n').buffer as ArrayBuffer;
const toRelief = (r: ReturnType<typeof rasterizeStl>): Relief => ({ id: 1, name: 'x', w: r.w, h: r.h, data: cellsToBase64(r.cells), x: 0, y: 0, width: r.width, depth: r.depth, visible: true });

describe('STL import', () => {
  it('reads binary and text files to the same triangles', () => {
    const b = parseStl(binary(pyramid())), a = parseStl(ascii(pyramid()));
    expect(b.count).toBe(6);
    expect(Array.from(a.tris)).toEqual(Array.from(b.tris));
  });
  it('refuses files that are not STL, or have no triangles, with a plain message', () => {
    expect(() => parseStl(new ArrayBuffer(10))).toThrow(/too short/);
    expect(() => parseStl(new TextEncoder().encode('hello this is not an stl file at all, it just goes on for a good while so it is long enough to look at'.padEnd(200, '.')).buffer as ArrayBuffer)).toThrow(/not an STL/);
    expect(() => parseStl(new TextEncoder().encode('solid empty\nendsolid empty'.padEnd(120, ' ')).buffer as ArrayBuffer)).toThrow(/no triangles/);
    const bad = binary(pyramid());
    new DataView(bad).setFloat32(84 + 12, NaN, true);
    expect(() => parseStl(bad)).toThrow(/damaged triangle/);
  });
});

describe('rasterising an STL into a relief', () => {
  it('a pyramid gives its heights: the slope is 1, the middle is the top, the corners are the bottom', () => {
    const r = rasterizeStl(parseStl(binary(pyramid())), { up: '+z', unitMm: 1, maxSide: 100 });
    expect([r.width, r.height, r.depth]).toEqual([20, 20, 10]);
    expect([r.w, r.h]).toEqual([100, 100]);
    const rel = toRelief(r);
    const cells = reliefCells(rel);
    // y runs up the page; the grid starts at the lower left corner (0, 0)
    for (const [x, y, want] of [[10, 10, 10], [5, 10, 5], [10, 2, 2], [2.5, 10, 2.5], [15, 15, 5]] as const) expect(reliefHeightAt(rel, cells, x, y)!).toBeCloseTo(want, 0);
    expect(reliefHeightAt(rel, cells, 0.1, 0.1)!).toBeLessThan(0.3);
    expect(reliefHeightAt(rel, cells, 50, 50)).toBeNull();
  });
  it('inches scale it, and turning a side up gives the same shape', () => {
    const inch = rasterizeStl(parseStl(binary(pyramid())), { up: '+z', unitMm: 25.4, maxSide: 50 });
    expect([inch.width, inch.depth]).toEqual([508, 254]);
    // the pyramid lying on its side (apex towards +y): x, z and y swapped, then turned back up
    const side = pyramid().map((t) => t.map(([x, y, z]) => [x, z, y] as V) as Tri);   // y up now, z is the depth. Mirror: use +y and compare heights
    const r = rasterizeStl(parseStl(binary(side)), { up: '+y', unitMm: 1, maxSide: 100 });
    expect(r.depth).toBeCloseTo(10);
    expect(r.cells[Math.floor(r.h / 2) * r.w + Math.floor(r.w / 2)]).toBeGreaterThan(64000);
    expect(r.cells[0]).toBeLessThan(3000);
  });
  it('a model upside down is cut from its flat side when -z is chosen', () => {
    const flip = pyramid().map((t) => t.map(([x, y, z]) => [x, y, -z] as V) as Tri);
    const r = rasterizeStl(parseStl(binary(flip)), { up: '-z', unitMm: 1, maxSide: 60 });
    expect(r.cells[Math.floor(r.h / 2) * r.w + Math.floor(r.w / 2)]).toBeGreaterThan(64000);
  });
  it('nothing seen from above (a flat wall) is refused', () => {
    const wall: Tri[] = [[[0, 0, 0], [10, 0, 0], [10, 0, 10]], [[0, 0, 0], [10, 0, 10], [0, 0, 10]]];
    expect(() => rasterizeStl(parseStl(binary(wall)), { up: '+z', unitMm: 1, maxSide: 50 })).toThrow(/no width or no length/);
  });
});

describe('3D shapes in a job', () => {
  const rel = () => toRelief(rasterizeStl(parseStl(binary(pyramid())), { up: '+z', unitMm: 1, maxSide: 40 }));
  const job = () => execute(emptyDoc(), 'new_project', { kind: 'cnc', width: 300, height: 200, thickness: 25 }).doc;
  const add = (d: any) => { const r = rel(); return execute(d, 'relief_add', { name: 'Pyramid', w: r.w, h: r.h, data: r.data, x: 40, y: 30, width: 20, depth: 10 }).doc; };
  it('adds, keeps through a save, changes and removes a 3D shape', () => {
    let d = add(job());
    expect(d.reliefs).toHaveLength(1);
    expect(d.reliefs![0]).toMatchObject({ id: 1, name: 'Pyramid', w: 40, h: 40, x: 40, y: 30, width: 20, depth: 10, visible: true });
    const again = parseProject(serializeProject(d));
    expect(again.reliefs![0]).toEqual(d.reliefs![0]);
    d = execute(d, 'relief_update', { id: 1, width: 40, depth: 6, x: 0 }).doc;
    expect(d.reliefs![0]).toMatchObject({ width: 40, depth: 6, x: 0 });
    expect(reliefHeightMm(d.reliefs![0])).toBe(40);   // scaled evenly: the grid is square
    d = add(d);
    expect(d.reliefs!.map((r) => r.id)).toEqual([1, 2]);
    d = execute(d, 'relief_delete', { id: 1 }).doc;
    expect(d.reliefs!.map((r) => r.id)).toEqual([2]);
    d = execute(d, 'relief_delete', { id: 2 }).doc;
    expect(d.reliefs).toBeUndefined();
    expect(serializeProject(d)).not.toContain('reliefs');
  });
  it('refuses damaged data, a canvas, and too many', () => {
    const r = rel();
    expect(() => execute(job(), 'relief_add', { w: r.w, h: r.h + 1, data: r.data, x: 0, y: 0, width: 20, depth: 10 })).toThrow(/does not match/);
    expect(() => execute(job(), 'relief_add', { w: r.w, h: r.h, data: r.data, x: 0, y: 0, width: 20, depth: 0 })).toThrow(/depth/);
    const canvas = execute(job(), 'workspace_set', { kind: 'canvas' }).doc;
    expect(() => add(canvas)).toThrow(/canvas/);
    let d = job();
    for (let i = 0; i < 8; i++) d = add(d);
    expect(() => add(d)).toThrow(/8 3D shapes/);
    const j = JSON.parse(serializeProject(add(job())));
    j.doc.reliefs[0].data = 'AAAA';
    expect(() => parseProject(JSON.stringify(j))).toThrow(/3D shape 1/);
  });
});

describe('the shaded picture of a relief', () => {
  it('is even on a flat top, and lighter on a slope that faces the light than on one that faces away', async () => {
    const { reliefShade } = await import('../src/core/relief');
    const flat = toRelief({ w: 8, h: 8, cells: new Uint16Array(64).fill(30000), width: 8, height: 8, depth: 5 });
    const px = reliefShade(flat, reliefCells(flat), [200, 160, 100]);
    expect(new Set(Array.from({ length: 64 }, (_, i) => px[i * 4])).size).toBe(1);
    // a ramp rising to the right (east): its slope faces west, towards the light that comes from the upper left
    const up = new Uint16Array(8 * 8); for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) up[j * 8 + i] = i * 8000;
    const east = toRelief({ w: 8, h: 8, cells: up, width: 8, height: 8, depth: 8 });
    const west = toRelief({ w: 8, h: 8, cells: up.map((_, n) => up[(n >> 3) * 8 + 7 - (n & 7)]), width: 8, height: 8, depth: 8 });
    const a = reliefShade(east, reliefCells(east), [200, 160, 100])[(3 * 8 + 4) * 4], b = reliefShade(west, reliefCells(west), [200, 160, 100])[(3 * 8 + 4) * 4];
    expect(a).toBeGreaterThan(b);
  });
});
