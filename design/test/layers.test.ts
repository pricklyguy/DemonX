import { describe, expect, it } from 'vitest';
import { emptyDoc } from '../src/core/types';
import type { Doc } from '../src/core/types';
import { execute } from '../src/core/commands';
import { buildLaserJob, jobOrigin } from '../src/core/laser';
import { buildRuidaPlan } from '../src/core/ruidaPlan';

const run = (doc: Doc, id: string, args: any) => execute(doc, id, args).doc;
const fails = (doc: Doc, id: string, args: any) => { try { execute(doc, id, args); } catch (e) { return (e as Error).message; } return null; };

/** a square on Layer 1 and a circle on a second layer, so each can be switched off alone */
function twoLayers(): Doc {
  let d = run(emptyDoc(), 'add_rect', { x: 10, y: 10, w: 20, h: 20, layer: 'Layer 1' });
  d = run(d, 'layer_set', { name: 'Cut', mode: 'cut', speed: 20, power: 30 });
  d = run(d, 'add_circle', { cx: 80, cy: 60, r: 10, layer: 'Cut' });
  return d;
}
const names = (d: Doc) => d.layers.map((l) => l.name);

describe('the start point does not move when a layer is switched off', () => {
  it('measured from every shape in the design, whatever Output says', () => {
    const both = twoLayers();
    const off = run(both, 'layer_set', { name: 'Layer 1', output: false });
    expect(jobOrigin(off, { anchor: 'tl' })).toEqual(jobOrigin(both, { anchor: 'tl' }));
    expect(jobOrigin(both, { anchor: 'bl' })).toEqual([10, 10]);
    expect(jobOrigin(off, { anchor: 'tr' })).toEqual([90, 70]);
  });
  it('so the second run of a two-run job lines up with the first (Ruida plan)', () => {
    const both = twoLayers();
    const first = buildRuidaPlan(both, { anchor: 'tl' }).plan; // both layers: the square is layer 0, the circle layer 1
    const onlyCircle = buildRuidaPlan(run(both, 'layer_set', { name: 'Layer 1', output: false }), { anchor: 'tl' }).plan;
    expect(onlyCircle.layers).toHaveLength(1);
    expect(onlyCircle.layers[0].points).toEqual(first.layers[1].points); // the circle is in exactly the same place relative to the head
  });
  it('and for GRBL: the same G-code for the circle, with or without the square', () => {
    const both = twoLayers();
    const gOff = buildLaserJob(run(both, 'layer_set', { name: 'Layer 1', output: false }), { anchor: 'bl' }).gcode;
    const gBoth = buildLaserJob(both, { anchor: 'bl' }).gcode;
    const circleLines = (g: string) => g.split('\n').filter((l) => /^G[01] X/.test(l));
    // every circle move in the single-layer job appears, unchanged, in the two-layer job
    for (const l of circleLines(gOff).slice(1)) expect(gBoth).toContain(l.replace(/ F[\d.]+/, ''));
  });
  it('selecting shapes measures from the selected shapes', () => {
    const d = twoLayers();
    const circle = d.shapes.find((s) => s.kind === 'circle')!;
    expect(jobOrigin(d, { onlyIds: [circle.id], anchor: 'bl' })).toEqual([70, 50]);
  });
});

describe('layer commands: rename, delete, reorder', () => {
  it('rename keeps the shapes on the layer and refuses a name that is taken or empty', () => {
    const d = run(twoLayers(), 'layer_rename', { name: 'Cut', to: 'Score box' });
    expect(names(d)).toEqual(['Layer 1', 'Score box']);
    expect(d.shapes.filter((s) => s.layer === 'Score box')).toHaveLength(1);
    expect(d.shapes.some((s) => s.layer === 'Cut')).toBe(false);
    expect(fails(d, 'layer_rename', { name: 'Score box', to: 'Layer 1' })).toMatch(/already a layer/);
    expect(fails(d, 'layer_rename', { name: 'Score box', to: '  ' })).toMatch(/empty/);
    expect(fails(d, 'layer_rename', { name: 'Nope', to: 'X' })).toMatch(/no layer/);
  });
  it('delete: an empty layer goes at once; a layer with shapes needs to say where they go', () => {
    let d = run(twoLayers(), 'layer_set', { name: 'Empty' });
    d = run(d, 'layer_delete', { name: 'Empty' });
    expect(names(d)).toEqual(['Layer 1', 'Cut']);
    expect(fails(d, 'layer_delete', { name: 'Cut' })).toMatch(/say where they go/);
    const moved = run(d, 'layer_delete', { name: 'Cut', moveTo: 'Layer 1' });
    expect(names(moved)).toEqual(['Layer 1']);
    expect(moved.shapes).toHaveLength(2);
    expect(moved.shapes.every((s) => s.layer === 'Layer 1')).toBe(true);
    const gone = run(d, 'layer_delete', { name: 'Cut', deleteShapes: true });
    expect(gone.shapes).toHaveLength(1);
    expect(fails(moved, 'layer_delete', { name: 'Layer 1' })).toMatch(/at least one layer/);
    expect(fails(d, 'layer_delete', { name: 'Cut', moveTo: 'Cut' })).toMatch(/another existing layer/);
  });
  it('move changes the order the layers burn in, and does nothing past the ends', () => {
    let d = run(twoLayers(), 'layer_set', { name: 'Third' });
    d = run(d, 'layer_move', { name: 'Third', direction: 'up' });
    expect(names(d)).toEqual(['Layer 1', 'Third', 'Cut']);
    d = run(d, 'layer_move', { name: 'Cut', direction: 'top' });
    expect(names(d)).toEqual(['Cut', 'Layer 1', 'Third']);
    d = run(d, 'layer_move', { name: 'Cut', direction: 'up' });
    expect(names(d)).toEqual(['Cut', 'Layer 1', 'Third']);
    d = run(d, 'layer_move', { name: 'Cut', direction: 'bottom' });
    expect(names(d)).toEqual(['Layer 1', 'Third', 'Cut']);
    expect(fails(d, 'layer_move', { name: 'Cut', direction: 'sideways' })).toMatch(/direction/);
  });
  it('the order is the burn order: engrave above cut puts the engraving first, in G-code and in the Ruida plan', () => {
    let d = run(emptyDoc(), 'add_rect', { x: 0, y: 0, w: 20, h: 20, layer: 'Layer 1' });
    d = run(d, 'layer_set', { name: 'Layer 1', mode: 'cut', speed: 20, power: 20 });
    d = run(d, 'layer_set', { name: 'Engrave', mode: 'engrave', speed: 100, power: 10 });
    d = run(d, 'add_rect', { x: 5, y: 5, w: 10, h: 10, layer: 'Engrave' });
    const order = (doc: Doc) => buildRuidaPlan(doc).plan.layers.map((l) => l.mode);
    expect(order(d)).toEqual(['line', 'fill']);
    expect(order(run(d, 'layer_move', { name: 'Engrave', direction: 'up' }))).toEqual(['fill', 'line']);
    const g = buildLaserJob(run(d, 'layer_move', { name: 'Engrave', direction: 'up' })).gcode;
    expect(g.indexOf('; Layer Engrave')).toBeLessThan(g.indexOf('; Layer Layer 1'));
  });
});
