import { describe, expect, it } from 'vitest';
import { emptyDoc } from '../src/core/types';
import type { Doc } from '../src/core/types';
import { execute, parseLine, CommandError } from '../src/core/commands';
import { exportDxf, importDxf, chainPaths } from '../src/core/dxf';
import { exportSvg } from '../src/core/svg';
import { shapeArea, shapeBounds } from '../src/core/geom';

const run = (doc: Doc, id: string, args: any) => execute(doc, id, args);

function withShapes(): { doc: Doc; rect: number; circle: number } {
  let doc = emptyDoc();
  const a = run(doc, 'add_rect', { x: 0, y: 0, w: 10, h: 10 });
  const b = run(a.doc, 'add_circle', { cx: 10, cy: 5, r: 5 });
  return { doc: b.doc, rect: a.ids![0], circle: b.ids![0] };
}

describe('commands', () => {
  it('adds shapes with growing ids and reports them', () => {
    const { doc, rect, circle } = withShapes();
    expect(doc.shapes.map((s) => s.id)).toEqual([rect, circle]);
    expect(shapeArea(doc.shapes[0])).toBeCloseTo(100, 6);
    expect(shapeArea(doc.shapes[1])).toBeCloseTo(Math.PI * 25, 6);
  });

  it('rejects bad input with a readable message and leaves the document alone', () => {
    const doc = emptyDoc();
    expect(() => run(doc, 'add_rect', { x: 0, y: 0, w: 0, h: 5 })).toThrow(CommandError);
    expect(() => run(doc, 'add_circle', { cx: 0, cy: 0, r: -1 })).toThrow(/greater than 0/);
    expect(() => run(doc, 'add_rect', { x: 'a', y: 0, w: 1, h: 1 })).toThrow(/"x" must be a number/);
    expect(() => run(doc, 'nope', {})).toThrow(/Unknown command/);
    expect(() => run(doc, 'move', { ids: [], dx: 1, dy: 1 })).toThrow(/Select at least one/);
    expect(() => run(doc, 'move', { ids: [99], dx: 1, dy: 1 })).toThrow(/no shape 99/);
    expect(doc.shapes).toHaveLength(0);
  });

  it('moves and deletes', () => {
    const { doc, rect } = withShapes();
    const moved = run(doc, 'move', { ids: [rect], dx: 5, dy: -2 }).doc;
    expect(shapeBounds(moved.shapes[0])).toEqual({ minX: 5, minY: -2, maxX: 15, maxY: 8 });
    expect(shapeBounds(doc.shapes[0])!.minX).toBe(0); // the old document is untouched (undo relies on this)
    expect(run(moved, 'delete', { ids: [rect] }).doc.shapes).toHaveLength(1);
  });

  it('union of overlapping shapes has the right area', () => {
    const { doc, rect, circle } = withShapes();
    const r = run(doc, 'boolean', { op: 'union', ids: [rect, circle] });
    expect(r.doc.shapes).toHaveLength(1);
    // rect 100 + circle 78.54 - overlap (half the circle lies inside the rect, x<=10)
    expect(shapeArea(r.doc.shapes[0])).toBeCloseTo(100 + Math.PI * 25 - (Math.PI * 25) / 2, 0);
  });

  it('subtract keeps the first shape minus the rest, and makes a real hole', () => {
    let doc = emptyDoc();
    const big = run(doc, 'add_rect', { x: 0, y: 0, w: 20, h: 20 });
    const hole = run(big.doc, 'add_circle', { cx: 10, cy: 10, r: 4 });
    const r = run(hole.doc, 'boolean', { op: 'difference', ids: [big.ids![0], hole.ids![0]] });
    const s = r.doc.shapes[0];
    expect(s.kind === 'path' && s.rings.length).toBe(2);
    expect(shapeArea(s)).toBeCloseTo(400 - Math.PI * 16, 0) // the circle is a 45-sided polygon, 0.01 mm from true;
  });

  it('subtract honours the order of the ids', () => {
    const { doc, rect, circle } = withShapes();
    const a = run(doc, 'boolean', { op: 'difference', ids: [rect, circle] }).doc.shapes[0];
    const b = run(doc, 'boolean', { op: 'difference', ids: [circle, rect] }).doc.shapes[0];
    expect(shapeArea(a)).toBeCloseTo(100 - (Math.PI * 25) / 2, 0);
    expect(shapeArea(b)).toBeCloseTo((Math.PI * 25) / 2, 0);
  });

  it('intersection of shapes that do not touch is an error, not an empty shape', () => {
    let doc = emptyDoc();
    const a = run(doc, 'add_rect', { x: 0, y: 0, w: 5, h: 5 });
    const b = run(a.doc, 'add_rect', { x: 50, y: 50, w: 5, h: 5 });
    expect(() => run(b.doc, 'boolean', { op: 'intersection', ids: [a.ids![0], b.ids![0]] })).toThrow(/do not overlap/);
  });

  it('boolean refuses open lines and says so', () => {
    let doc = emptyDoc();
    const a = run(doc, 'add_rect', { x: 0, y: 0, w: 5, h: 5 });
    const l = run(a.doc, 'add_path', { points: [[0, 0], [9, 9]], closed: false });
    expect(() => run(l.doc, 'boolean', { op: 'union', ids: [a.ids![0], l.ids![0]] })).toThrow(/at least two closed/);
  });

  it('offsets a square outward and inward by the expected area', () => {
    let doc = emptyDoc();
    const a = run(doc, 'add_rect', { x: 0, y: 0, w: 10, h: 10 });
    const id = a.ids![0];
    const out = run(a.doc, 'offset', { ids: [id], distance: 2 });
    // round corners: 100 + 4*(10*2) + pi*2^2
    expect(shapeArea(out.doc.shapes[1])).toBeCloseTo(100 + 80 + Math.PI * 4, 0) // arcs are flattened, so a hair under;
    const mitre = run(a.doc, 'offset', { ids: [id], distance: 2, join: 'miter' });
    expect(shapeArea(mitre.doc.shapes[1])).toBeCloseTo(14 * 14, 2);
    const inn = run(a.doc, 'offset', { ids: [id], distance: -2 });
    expect(shapeArea(inn.doc.shapes[1])).toBeCloseTo(36, 2);
    expect(() => run(a.doc, 'offset', { ids: [id], distance: -6 })).toThrow(/Nothing is left/);
    expect(run(a.doc, 'offset', { ids: [id], distance: 1, keep: false }).doc.shapes).toHaveLength(1);
  });

  it('offsets a ring shape: the hole shrinks when the outside grows', () => {
    let doc = emptyDoc();
    const big = run(doc, 'add_rect', { x: 0, y: 0, w: 30, h: 30 });
    const hole = run(big.doc, 'add_circle', { cx: 15, cy: 15, r: 5 });
    const ring = run(hole.doc, 'boolean', { op: 'difference', ids: [big.ids![0], hole.ids![0]] });
    const grown = run(ring.doc, 'offset', { ids: [ring.ids![0]], distance: 1, join: 'miter' });
    // outer 32x32; growing the outside shrinks the hole (radius 5 becomes 4)
    expect(shapeArea(grown.doc.shapes[1])).toBeCloseTo(32 * 32 - Math.PI * 16, 0);
  });

  it('offsets an open line into a closed outline', () => {
    let doc = emptyDoc();
    const l = run(doc, 'add_path', { points: [[0, 0], [10, 0]], closed: false });
    const o = run(l.doc, 'offset', { ids: [l.ids![0]], distance: 1 });
    const s = o.doc.shapes[1];
    expect(s.kind === 'path' && s.closed).toBe(true);
    expect(shapeArea(s)).toBeCloseTo(10 * 2 + Math.PI, 1); // a stadium
    expect(() => run(l.doc, 'offset', { ids: [l.ids![0]], distance: -1 })).toThrow(/outwards/);
  });

  it('layers: create, change, validate', () => {
    const doc = emptyDoc();
    const added = run(doc, 'layer_set', { name: 'Score', mode: 'score', speed: 300, power: 8 }).doc;
    expect(added.layers.find((l) => l.name === 'Score')).toMatchObject({ mode: 'score', speed: 300, power: 8, passes: 1 });
    expect(() => run(doc, 'layer_set', { name: 'X', power: 150 })).toThrow(/0 to 100/);
    expect(() => run(doc, 'layer_set', { name: 'X', color: 'red' })).toThrow(/#rrggbb/);
    expect(() => run(doc, 'add_rect', { x: 0, y: 0, w: 1, h: 1, layer: 'Missing' })).toThrow(/no layer/);
    const a = run(added, 'add_rect', { x: 0, y: 0, w: 1, h: 1 });
    expect(run(a.doc, 'set_layer', { ids: a.ids, layer: 'Score' }).doc.shapes[0].layer).toBe('Score');
  });
});

describe('console input', () => {
  it('understands typed and JSON forms', () => {
    expect(parseLine('rect 0 0 50 30', [])).toEqual({ id: 'add_rect', args: { x: 0, y: 0, w: 50, h: 30 } });
    expect(parseLine('offset 2.5', [3, 4])).toEqual({ id: 'offset', args: { ids: [3, 4], distance: 2.5 } });
    expect(parseLine('union', [1, 2])).toEqual({ id: 'boolean', args: { op: 'union', ids: [1, 2] } });
    expect(parseLine('{"cmd":"add_circle","args":{"cx":1,"cy":2,"r":3}}', [])).toEqual({ id: 'add_circle', args: { cx: 1, cy: 2, r: 3 } });
    expect(() => parseLine('rect 1 2', [])).toThrow(/Usage: rect/);
    expect(() => parseLine('{oops', [])).toThrow(/not valid JSON/);
  });
});

describe('chaining loose lines', () => {
  const sq = [
    [[0, 0], [10, 0]],
    [[10, 10], [10, 0]], // reversed on purpose
    [[10, 10], [0, 10]],
    [[0, 10], [0, 0]],
  ] as [number, number][][];

  it('joins four lines (some backwards) into one closed loop', () => {
    const { closed, open } = chainPaths(sq);
    expect(open).toHaveLength(0);
    expect(closed).toHaveLength(1);
    expect(closed[0]).toHaveLength(4);
  });

  it('joins across a small gap but not a big one', () => {
    const gap = [[[0, 0], [10, 0]], [[10.005, 0], [10, 10]]] as [number, number][][];
    expect(chainPaths(gap).open).toHaveLength(1);
    const far = [[[0, 0], [10, 0]], [[10.5, 0], [10, 10]]] as [number, number][][];
    expect(chainPaths(far).open).toHaveLength(2);
  });

  it('leaves a lone open line open', () => {
    const r = chainPaths([[[0, 0], [5, 5]]]);
    expect(r.closed).toHaveLength(0);
    expect(r.open).toHaveLength(1);
  });
});

describe('DXF', () => {
  function sample(): Doc {
    let doc = run(emptyDoc(), 'layer_set', { name: 'Pocket', color: '#2bb5c9' }).doc;
    doc = run(doc, 'add_rect', { x: 0, y: 0, w: 40, h: 20 }).doc;
    doc = run(doc, 'add_circle', { cx: 20, cy: 10, r: 6, layer: 'Pocket' }).doc;
    doc = run(doc, 'add_path', { points: [[0, 30], [10, 35], [20, 30]], closed: false, layer: 'Pocket' }).doc;
    const ring = run(doc, 'add_rect', { x: 50, y: 0, w: 20, h: 20 });
    const hole = run(ring.doc, 'add_circle', { cx: 60, cy: 10, r: 4 });
    return run(hole.doc, 'boolean', { op: 'difference', ids: [ring.ids![0], hole.ids![0]] }).doc;
  }

  it('round trips layers, circles, closed shapes, holes and open lines', () => {
    const doc = sample();
    const text = exportDxf(doc);
    expect(text).toContain('AC1009');
    expect(text.split('\r\n')).toContain('POLYLINE');
    const back = importDxf(text);
    expect(back.warnings).toEqual([]);
    expect(back.layers.map((l) => l.name).sort()).toEqual(['0', 'Layer 1', 'Pocket'].filter((n) => back.layers.some((l) => l.name === n)).sort());
    const circles = back.shapes.filter((s) => s.kind === 'circle');
    expect(circles).toHaveLength(1);
    expect(circles[0]).toMatchObject({ cx: 20, cy: 10, r: 6, layer: 'Pocket' });
    const paths = back.shapes.filter((s) => s.kind === 'path') as any[];
    expect(paths.filter((p) => p.closed)).toHaveLength(3); // the rectangle, plus the two rings of the shape with a hole
    const open = paths.filter((p) => !p.closed);
    expect(open).toHaveLength(1);
    expect(open[0].rings[0]).toEqual([[0, 30], [10, 35], [20, 30]]);
  });

  it('writes a file other programs can read: every group is code/value pairs and ends with EOF', () => {
    const lines = exportDxf(sample()).split('\r\n');
    expect(lines.at(-1)).toBe('');
    expect(lines.at(-2)).toBe('EOF');
    for (let i = 0; i < lines.length - 1; i += 2) expect(lines[i]).toMatch(/^\s*\d+$/);
  });

  it('makes layer names safe', () => {
    const doc = run(emptyDoc(), 'layer_set', { name: 'a/b:c' }).doc;
    const withShape = run(doc, 'add_rect', { x: 0, y: 0, w: 1, h: 1, layer: 'a/b:c' }).doc;
    const text = exportDxf(withShape);
    expect(text).toContain('a_b_c');
    expect(text).not.toContain('a/b:c');
  });

  it('imports LWPOLYLINE with bulges as arcs, closed', () => {
    // a 10x10 square with the right side bulged into a half circle (bulge 1 = 180 degrees)
    const dxf = ['0', 'SECTION', '2', 'ENTITIES', '0', 'LWPOLYLINE', '8', 'A', '90', '4', '70', '1',
      '10', '0', '20', '0', '10', '10', '20', '0', '42', '1', '10', '10', '20', '10', '10', '0', '20', '10',
      '0', 'ENDSEC', '0', 'EOF'].join('\n');
    const r = importDxf(dxf);
    expect(r.shapes).toHaveLength(1);
    const s = { ...r.shapes[0], id: 1 } as any;
    expect(s.closed).toBe(true);
    expect(shapeArea(s)).toBeCloseTo(100 + (Math.PI * 25) / 2, 0);
  });

  it('imports loose LINEs and ARCs into a closed shape (a rounded slot)', () => {
    const E = (...kv: (string | number)[]) => kv.map(String);
    const dxf = [
      '0', 'SECTION', '2', 'ENTITIES',
      ...E(0, 'LINE', 8, 'S', 10, 0, 20, 0, 11, 20, 21, 0),
      ...E(0, 'ARC', 8, 'S', 10, 20, 20, 5, 40, 5, 50, -90, 51, 90),
      ...E(0, 'LINE', 8, 'S', 10, 20, 20, 10, 11, 0, 21, 10),
      ...E(0, 'ARC', 8, 'S', 10, 0, 20, 5, 40, 5, 50, 90, 51, 270),
      '0', 'ENDSEC', '0', 'EOF',
    ].join('\n');
    const r = importDxf(dxf);
    expect(r.shapes).toHaveLength(1);
    const s = { ...r.shapes[0], id: 1 } as any;
    expect(s.closed).toBe(true);
    expect(shapeArea(s)).toBeCloseTo(20 * 10 + Math.PI * 25, 0);
  });

  it('says what it could not import', () => {
    const dxf = ['0', 'SECTION', '2', 'ENTITIES', '0', 'TEXT', '8', '0', '10', '0', '20', '0', '40', '2', '1', 'hi', '0', 'ENDSEC', '0', 'EOF'].join('\n');
    expect(importDxf(dxf).warnings.join(' ')).toMatch(/^1 TEXT object not imported: .*curves/);
  });

  it('refuses garbage with a plain message', () => {
    expect(() => importDxf('this is not a dxf')).toThrow(/DXF/);
  });
});

describe('SVG', () => {
  it('is in millimetres, keeps layer settings, and writes holes even-odd', () => {
    let doc = run(emptyDoc(), 'add_rect', { x: 0, y: 0, w: 20, h: 10 }).doc;
    doc = run(doc, 'add_circle', { cx: 10, cy: 5, r: 2 }).doc;
    const svg = exportSvg(doc);
    expect(svg).toContain('width="22mm"');
    expect(svg).toContain('height="12mm"');
    expect(svg).toContain('data-mode="cut"');
    expect(svg).toContain('<circle cx="10" cy="5" r="2"/>');
    expect(svg).toContain('fill-rule="evenodd"');
  });
});

describe('editing a shape: size, position, rotate, flip', () => {
  const circle = () => {
    const a = run(emptyDoc(), 'add_circle', { cx: 20, cy: 10, r: 5 });
    return { doc: a.doc, id: a.ids![0] };
  };

  it('makes a circle bigger by its width and it stays a true circle', () => {
    const { doc, id } = circle();
    const r = run(doc, 'set_bounds', { ids: [id], width: 14, lock: true });
    const s = r.doc.shapes[0];
    expect(s).toMatchObject({ kind: 'circle', cx: 20, cy: 10, r: 7 }); // grows about its centre
  });

  it('keeps the corner you anchor to', () => {
    const a = run(emptyDoc(), 'add_rect', { x: 0, y: 0, w: 10, h: 10 });
    const r = run(a.doc, 'set_bounds', { ids: a.ids, width: 30, height: 20, anchor: 'bl' });
    expect(shapeBounds(r.doc.shapes[0])).toEqual({ minX: 0, minY: 0, maxX: 30, maxY: 20 });
    const tr = run(a.doc, 'set_bounds', { ids: a.ids, width: 30, height: 20, anchor: 'tr' });
    expect(shapeBounds(tr.doc.shapes[0])).toEqual({ minX: -20, minY: -10, maxX: 10, maxY: 10 });
  });

  it('lock keeps the proportions when only one side is given', () => {
    const a = run(emptyDoc(), 'add_rect', { x: 0, y: 0, w: 20, h: 10 });
    const locked = run(a.doc, 'set_bounds', { ids: a.ids, height: 20, lock: true });
    expect(shapeBounds(locked.doc.shapes[0])).toEqual({ minX: -10, minY: -5, maxX: 30, maxY: 15 }); // twice as big, about its middle
    const free = run(a.doc, 'set_bounds', { ids: a.ids, height: 20 });
    const b = shapeBounds(free.doc.shapes[0])!;
    expect(b.maxX - b.minX).toBe(20);
    expect(b.maxY - b.minY).toBe(20);
  });

  it('places the anchor point at x, y', () => {
    const a = run(emptyDoc(), 'add_rect', { x: 0, y: 0, w: 10, h: 10 });
    const centre = run(a.doc, 'set_bounds', { ids: a.ids, x: 100, y: 50 });
    expect(shapeBounds(centre.doc.shapes[0])).toEqual({ minX: 95, minY: 45, maxX: 105, maxY: 55 });
    const corner = run(a.doc, 'set_bounds', { ids: a.ids, x: 0, y: 0, anchor: 'tr' });
    expect(shapeBounds(corner.doc.shapes[0])).toEqual({ minX: -10, minY: -10, maxX: 0, maxY: 0 });
  });

  it('an uneven stretch turns a circle into an ellipse path; scaling by one factor does not', () => {
    const { doc, id } = circle();
    const even = run(doc, 'scale', { ids: [id], sx: 2 }).doc.shapes[0];
    expect(even).toMatchObject({ kind: 'circle', r: 10 });
    const stretched = run(doc, 'set_bounds', { ids: [id], width: 20 }).doc.shapes[0];
    expect(stretched.kind).toBe('path');
    const b = shapeBounds(stretched)!;
    expect(b.maxX - b.minX).toBeCloseTo(20, 2);
    expect(b.maxY - b.minY).toBeCloseTo(10, 2);
    expect(shapeArea(stretched)).toBeCloseTo(Math.PI * 10 * 5, 0);
  });

  it('rotates a group about its middle; a quarter turn swaps width and height', () => {
    const a = run(emptyDoc(), 'add_rect', { x: 0, y: 0, w: 20, h: 10 });
    const r = run(a.doc, 'rotate', { ids: a.ids, angle: 90 });
    const b = shapeBounds(r.doc.shapes[0])!;
    expect(b.maxX - b.minX).toBeCloseTo(10, 9);
    expect(b.maxY - b.minY).toBeCloseTo(20, 9);
    expect((b.minX + b.maxX) / 2).toBeCloseTo(10, 9); // still centred where it was
    expect((b.minY + b.maxY) / 2).toBeCloseTo(5, 9);
  });

  it('rotating a circle about a point far away moves its centre and keeps its size', () => {
    const { doc, id } = circle();
    const r = run(doc, 'rotate', { ids: [id], angle: 90, about: [0, 0] }).doc.shapes[0];
    expect(r.kind === 'circle' && r.cx).toBeCloseTo(-10, 9);
    expect(r.kind === 'circle' && r.cy).toBeCloseTo(20, 9);
    expect(r.kind === 'circle' && r.r).toBeCloseTo(5, 9);
  });

  it('mirrors left to right and top to bottom', () => {
    const a = run(emptyDoc(), 'add_path', { points: [[0, 0], [10, 0], [0, 6]] });
    const h = run(a.doc, 'mirror', { ids: a.ids, axis: 'horizontal' }).doc.shapes[0] as any;
    expect(h.rings[0]).toEqual([[10, 0], [0, 0], [10, 6]]);
    const v = run(a.doc, 'mirror', { ids: a.ids, axis: 'vertical' }).doc.shapes[0] as any;
    expect(v.rings[0]).toEqual([[0, 6], [10, 6], [0, 0]]);
  });

  it('refuses nonsense and leaves the drawing alone', () => {
    const { doc, id } = circle();
    expect(() => run(doc, 'set_bounds', { ids: [id], width: 0 })).toThrow(/greater than 0/);
    expect(() => run(doc, 'set_bounds', { ids: [id], width: -3 })).toThrow(/greater than 0/);
    expect(() => run(doc, 'set_bounds', { ids: [id], anchor: 'zz' })).toThrow(/anchor/);
    expect(() => run(doc, 'scale', { ids: [id], sx: 0 })).toThrow(/cannot be 0/);
    expect(() => run(doc, 'rotate', { ids: [id], angle: 'x' })).toThrow(/number/);
    expect(() => run(doc, 'mirror', { ids: [id], axis: 'up' })).toThrow(/axis/);
    const line = run(emptyDoc(), 'add_path', { points: [[0, 0], [10, 0]], closed: false });
    expect(() => run(line.doc, 'set_bounds', { ids: line.ids, height: 5 })).toThrow(/no height/);
  });
});
