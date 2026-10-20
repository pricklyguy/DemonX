import { describe, expect, it } from 'vitest';
import { emptyDoc } from '../src/core/types';
import type { Doc } from '../src/core/types';
import { execute } from '../src/core/commands';
import { findSnap, segmentIntersection, selectionCenter, shapeSnapPoints } from '../src/core/snap';

const run = (doc: Doc, id: string, args: any) => execute(doc, id, args);
const rectDoc = () => run(emptyDoc(), 'add_rect', { x: 10, y: 10, w: 40, h: 30, layer: 'Layer 1' });
const snap = (doc: Doc, p: [number, number], r = 2, extra: any = {}) => findSnap(doc.shapes, p, r, { layers: doc.layers, ...extra });

describe('object snap', () => {
  it('snaps to the corners of a rectangle, with the marker kind', () => {
    const { doc } = rectDoc();
    expect(snap(doc, [10.5, 9.6])).toEqual({ pt: [10, 10], kind: 'endpoint' });
    expect(snap(doc, [49.2, 40.7])).toEqual({ pt: [50, 40], kind: 'endpoint' });
    expect(snap(doc, [10, 40.9])).toEqual({ pt: [10, 40], kind: 'endpoint' });
  });

  it('does nothing when the cursor is farther than the radius', () => {
    const { doc } = rectDoc();
    expect(snap(doc, [14, 14], 2)).toBeNull();
    expect(snap(doc, [14, 14], 6)?.kind).toBeDefined();
  });

  it('snaps to the middle of each side and to the centre of the shape', () => {
    const { doc } = rectDoc();
    expect(snap(doc, [30.3, 10.4])).toEqual({ pt: [30, 10], kind: 'midpoint' });
    expect(snap(doc, [50.4, 24.6])).toEqual({ pt: [50, 25], kind: 'midpoint' });
    expect(snap(doc, [30.4, 25.4])).toEqual({ pt: [30, 25], kind: 'center' });
  });

  it('snaps to a circle centre and its four quadrant points', () => {
    const { doc } = run(emptyDoc(), 'add_circle', { cx: 20, cy: 20, r: 5, layer: 'Layer 1' });
    expect(snap(doc, [20.5, 19.6])).toEqual({ pt: [20, 20], kind: 'center' });
    expect(snap(doc, [25.3, 20.2])).toEqual({ pt: [25, 20], kind: 'endpoint' });
    expect(snap(doc, [15, 20.4])?.pt).toEqual([15, 20]);
  });

  it('snaps to the ends of an open line but not to every point along a curve', () => {
    const line = run(emptyDoc(), 'add_path', { points: [[0, 0], [10, 0], [10, 10]], closed: false, layer: 'Layer 1' });
    expect(snap(line.doc, [10.2, 0.3])).toEqual({ pt: [10, 0], kind: 'endpoint' }); // a corner of the line
    expect(snap(line.doc, [0.3, 0.2])).toEqual({ pt: [0, 0], kind: 'endpoint' });
    // an offset circle is a many-sided path: its vertices are not corners
    const c = run(emptyDoc(), 'add_circle', { cx: 0, cy: 0, r: 10, layer: 'Layer 1' });
    const grown = run(c.doc, 'offset', { ids: [c.ids![0]], distance: 3, keep: false });
    const pts = shapeSnapPoints(grown.doc.shapes[0]);
    expect(pts.filter((p) => p.kind === 'endpoint').length).toBe(0);
    expect(pts.filter((p) => p.kind === 'center').length).toBe(1);
  });

  it('finds where two shapes cross', () => {
    let d = run(emptyDoc(), 'add_path', { points: [[0, 0], [20, 20]], closed: false, layer: 'Layer 1' }).doc;
    d = run(d, 'add_path', { points: [[0, 12], [24, 0]], closed: false, layer: 'Layer 1' }).doc;
    expect(snap(d, [8.4, 7.7])).toEqual({ pt: [8, 8], kind: 'intersection' });
    // where a crossing coincides with a middle, the middle is what is offered
    let e = run(emptyDoc(), 'add_path', { points: [[0, 0], [20, 20]], closed: false, layer: 'Layer 1' }).doc;
    e = run(e, 'add_path', { points: [[0, 20], [20, 0]], closed: false, layer: 'Layer 1' }).doc;
    expect(snap(e, [10.4, 9.7])).toEqual({ pt: [10, 10], kind: 'midpoint' });
    expect(segmentIntersection([0, 0], [10, 0], [5, -5], [5, 5])).toEqual([5, 0]);
    expect(segmentIntersection([0, 0], [10, 0], [0, 1], [10, 1])).toBeNull(); // parallel
    expect(segmentIntersection([0, 0], [4, 0], [5, -5], [5, 5])).toBeNull(); // would cross only beyond the end
  });

  it('prefers the closest, and an end over a centre when they are equally close', () => {
    let d = run(emptyDoc(), 'add_rect', { x: 0, y: 0, w: 4, h: 4, layer: 'Layer 1' }).doc;
    expect(snap(d, [1.9, 2.1], 3)?.kind).toBe('center');
    d = run(emptyDoc(), 'add_rect', { x: 0, y: 0, w: 2, h: 2, layer: 'Layer 1' }).doc;
    // cursor in the middle of a tiny square: the centre is exactly under it
    expect(snap(d, [1, 1], 3)).toEqual({ pt: [1, 1], kind: 'center' });
  });

  it('ignores hidden layers, the shapes being moved, and kinds that are switched off', () => {
    const { doc } = rectDoc();
    const hidden = run(doc, 'layer_set', { name: 'Layer 1', visible: false }).doc;
    expect(snap(hidden, [10.2, 10.2])).toBeNull();
    expect(snap(doc, [10.2, 10.2], 2, { exclude: new Set([doc.shapes[0].id]) })).toBeNull();
    expect(snap(doc, [10.2, 10.2], 2, { kinds: { endpoint: false } })?.kind).not.toBe('endpoint');
  });

  it('the centre of the selection is a snap point, also for several shapes together', () => {
    let d = run(emptyDoc(), 'add_rect', { x: 0, y: 0, w: 10, h: 10, layer: 'Layer 1' });
    const a = d.ids![0];
    d = run(d.doc, 'add_circle', { cx: 30, cy: 5, r: 5, layer: 'Layer 1' }) as any;
    const b = (d as any).ids[0];
    const doc = (d as any).doc as Doc;
    expect(selectionCenter(doc.shapes)).toEqual([17.5, 5]);
    expect(findSnap(doc.shapes, [17.4, 5.3], 1, { layers: doc.layers, selection: [a, b] })).toEqual({ pt: [17.5, 5], kind: 'center' });
    expect(findSnap(doc.shapes, [17.4, 5.3], 1, { layers: doc.layers })).toBeNull(); // not selected: nothing there
    expect(findSnap(doc.shapes, [17.4, 5.3], 1, { layers: doc.layers, selection: [a, b], exclude: new Set([a, b]) })).toBeNull(); // being moved
  });
});
