import { describe, expect, it } from 'vitest';
import { emptyDoc } from '../src/core/types';
import type { Doc, PathShape } from '../src/core/types';
import { execute, CommandError } from '../src/core/commands';
import { planTrim } from '../src/core/trim';
import { shapeBounds } from '../src/core/geom';
import { buildLaserJob } from '../src/core/laser';

const run = (doc: Doc, id: string, args: any) => execute(doc, id, args);
const line = (doc: Doc, pts: [number, number][], closed = false) => run(doc, 'add_path', { points: pts, closed, layer: 'Layer 1' });
const pathLen = (pts: [number, number][]) => pts.slice(1).reduce((n, p, i) => n + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0);

/** Two lines crossing like a plus sign at (10, 0) */
function plus(): Doc {
  let d = line(emptyDoc(), [[0, 0], [20, 0]]).doc;
  d = line(d, [[10, -5], [10, 5]]).doc;
  return d;
}

describe('trim', () => {
  it('cuts away the part of a line between a crossing and its end, and keeps the rest exactly up to the crossing', () => {
    const r = run(plus(), 'trim', { x: 15, y: 0 });
    const lines = r.doc.shapes as PathShape[];
    expect(lines).toHaveLength(2); // the vertical line, and what is left of the horizontal one
    const left = lines.find((s) => shapeBounds(s)!.maxY === 0)!;
    expect(left.rings[0]).toEqual([[0, 0], [10, 0]]);
    expect(left.closed).toBe(false);
    expect(r.message).toBe('Trimmed away 10 mm, 1 piece left');
    expect(r.ids).toEqual([left.id]);
  });

  it('removes a piece from the middle of a line crossed twice and keeps both ends', () => {
    let d = line(emptyDoc(), [[0, 0], [30, 0]]).doc;
    d = line(d, [[10, -5], [10, 5]]).doc;
    d = line(d, [[20, -5], [20, 5]]).doc;
    const r = run(d, 'trim', { x: 15, y: 0.1 });
    const pieces = (r.doc.shapes as PathShape[]).filter((s) => shapeBounds(s)!.minY === 0 && shapeBounds(s)!.maxY === 0).map((s) => s.rings[0]);
    expect(pieces).toHaveLength(2);
    expect(pieces).toContainEqual([[0, 0], [10, 0]]);
    expect(pieces).toContainEqual([[20, 0], [30, 0]]);
  });

  it('trims a circle where a line crosses it: the half you click goes, the other half stays as an open arc', () => {
    let d = run(emptyDoc(), 'add_circle', { cx: 0, cy: 0, r: 5, layer: 'Layer 1' }).doc;
    d = line(d, [[-8, 0], [8, 0]]).doc;
    const r = run(d, 'trim', { x: 0, y: 5 }); // the top of the circle
    const arc = (r.doc.shapes as PathShape[]).find((s) => s.rings[0].length > 10)!;
    const b = shapeBounds(arc)!;
    expect(arc.closed).toBe(false);
    expect(b.maxY).toBeCloseTo(0, 6);
    expect(b.minY).toBeCloseTo(-5, 2);
    expect(arc.rings[0][0][1]).toBeCloseTo(0, 6); // starts and ends on the line
    expect(arc.rings[0].at(-1)![1]).toBeCloseTo(0, 6);
    expect(pathLen(arc.rings[0])).toBeCloseTo(Math.PI * 5, 1);
    expect(r.doc.shapes.some((s) => s.kind === 'circle')).toBe(false); // the circle itself is gone
  });

  it('trims a rectangle crossed by two lines that end inside it: the piece between them goes, the rest is one open outline', () => {
    let d = run(emptyDoc(), 'add_rect', { x: 0, y: 0, w: 20, h: 10, layer: 'Layer 1' }).doc;
    d = line(d, [[5, -3], [5, 5]]).doc;
    d = line(d, [[15, -3], [15, 5]]).doc;
    const r = run(d, 'trim', { x: 10, y: 0 }); // the bottom side between the two lines
    const pieces = (r.doc.shapes as PathShape[]).filter((s) => !s.closed && s.rings[0].length > 2);
    expect(pieces).toHaveLength(1);
    const pts = pieces[0].rings[0];
    expect(pts[0]).toEqual([15, 0]);
    expect(pts.at(-1)).toEqual([5, 0]);
    expect(pathLen(pts)).toBeCloseTo(60 - 10, 6); // the whole outline except the bottom piece
  });

  it('lines that cross the top as well leave several pieces', () => {
    let d = run(emptyDoc(), 'add_rect', { x: 0, y: 0, w: 20, h: 10, layer: 'Layer 1' }).doc;
    d = line(d, [[5, -3], [5, 13]]).doc;
    d = line(d, [[15, -3], [15, 13]]).doc;
    const r = run(d, 'trim', { x: 10, y: 0 });
    expect(r.ids).toHaveLength(3); // right side, middle of the top, left side
  });

  it('keeps the other outlines of a shape with a hole when one outline is trimmed', () => {
    let d = run(emptyDoc(), 'add_rect', { x: 0, y: 0, w: 40, h: 40, layer: 'Layer 1' });
    const big = d.ids![0];
    const hole = run(d.doc, 'add_circle', { cx: 20, cy: 20, r: 5, layer: 'Layer 1' });
    const part = run(hole.doc, 'boolean', { op: 'difference', ids: [big, hole.ids![0]] });
    let doc = line(part.doc, [[20, 10], [20, 30]]).doc; // through the hole
    const r = run(doc, 'trim', { x: 22.5, y: 24.33, tol: 0.3 }); // the upper part of the hole's outline (away from the line)
    const compound = (r.doc.shapes as PathShape[]).find((s) => s.closed)!;
    expect(compound.rings).toHaveLength(1); // the outer boundary remains, closed
    expect(shapeBounds(compound)).toEqual({ minX: 0, minY: 0, maxX: 40, maxY: 40 });
    expect((r.doc.shapes as PathShape[]).some((s) => !s.closed && s.rings[0].length > 10)).toBe(true); // the rest of the hole's outline
  });

  it('refuses when there is nothing to cut against, or the click is on nothing', () => {
    const lone = line(emptyDoc(), [[0, 0], [10, 0]]).doc;
    expect(() => run(lone, 'trim', { x: 5, y: 0 })).toThrow(/does not cross anything/);
    expect(() => run(plus(), 'trim', { x: 15, y: 20 })).toThrow(/Nothing under the cursor/);
    let sq = run(emptyDoc(), 'add_rect', { x: 0, y: 0, w: 10, h: 10, layer: 'Layer 1' }).doc;
    expect(() => run(sq, 'trim', { x: 5, y: 0 })).toThrow(/does not cross anything/);
    sq = line(sq, [[5, -5], [5, 0]]).doc; // ends on the side: one crossing only
    expect(() => run(sq, 'trim', { x: 8, y: 0 })).toThrow(/crossed only once/);
    expect(() => run(plus(), 'trim', { x: 'a', y: 0 })).toThrow(CommandError);
  });

  it('only visible layers cut and can be cut', () => {
    let d = plus();
    d = run(d, 'layer_set', { name: 'Engrave' }).doc;
    d = run(d, 'set_layer', { ids: [d.shapes[1].id], layer: 'Engrave' }).doc; // the vertical line
    const hidden = run(d, 'layer_set', { name: 'Engrave', visible: false }).doc;
    expect(() => run(hidden, 'trim', { x: 15, y: 0 })).toThrow(/does not cross anything/); // the hidden line does not count as an edge
    expect(planTrim(d.shapes, d.layers, [15, 0], 0.5).ok).toBe(true);
  });

  it('a line that just touches another at its end still counts as crossed (a T)', () => {
    let d = line(emptyDoc(), [[0, 0], [20, 0]]).doc;
    d = line(d, [[10, 0], [10, 8]]).doc; // starts on the first line
    const r = run(d, 'trim', { x: 4, y: 0 });
    const left = (r.doc.shapes as PathShape[]).find((s) => shapeBounds(s)!.maxY === 0)!;
    expect(left.rings[0]).toEqual([[10, 0], [20, 0]]);
  });

  it('trimming can be undone by keeping the old document, and the result cuts as laser lines', () => {
    const d = plus();
    const r = run(d, 'trim', { x: 15, y: 0 });
    expect(d.shapes).toHaveLength(2);
    expect(d.shapes[0]).toMatchObject({ rings: [[[0, 0], [20, 0]]] }); // the original is untouched
    const burn = buildLaserJob(r.doc).stats.burnLength;
    expect(burn).toBeCloseTo(10 + 10, 6); // the left half and the vertical line
  });

  it('plans the same piece the command removes, with the crossings listed', () => {
    const d = plus();
    const plan = planTrim(d.shapes, d.layers, [15, 0], 0.5);
    expect(plan.ok && plan.plan.remove).toEqual([[10, 0], [20, 0]]);
    expect(plan.ok && plan.plan.cuts).toEqual([[10, 0]]);
  });
});
