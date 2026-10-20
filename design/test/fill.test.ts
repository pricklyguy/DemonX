import { describe, expect, it } from 'vitest';
import { emptyDoc } from '../src/core/types';
import type { Doc } from '../src/core/types';
import { execute } from '../src/core/commands';
import { fillOps } from '../src/core/fill';
import { buildRuidaPlan } from '../src/core/ruidaPlan';
import { buildLaserJob } from '../src/core/laser';
import { estimateMoves, planToMoves } from '../src/core/jobEstimate';
import { parseProject, serializeProject } from '../src/core/project';

const run = (d: Doc, id: string, a: any) => execute(d, id, a).doc;
const ids = (d: Doc) => d.shapes.map((s) => s.id);

/** a 200 x 120 mm frame, 6 mm wide, as one shape with a hole (the border case) */
function frame(mode: string): Doc {
  let d = run(emptyDoc(), 'add_rect', { x: 0, y: 0, w: 200, h: 120, layer: 'Layer 1' });
  d = run(d, 'add_rect', { x: 6, y: 6, w: 188, h: 108, layer: 'Layer 1' });
  const r = execute(d, 'boolean', { op: 'difference', ids: ids(d) });
  d = run(r.doc, 'layer_set', { name: 'Layer 1', mode: 'engrave', speed: 415, power: 20, interval: 0.5, overscan: 1, fillMode: mode });
  return d;
}
const seconds = (d: Doc) => estimateMoves(planToMoves(buildRuidaPlan(d).plan, 0));

describe('fill modes and the automatic split', () => {
  it('a frame filled all at once crosses the empty middle on every line; auto cuts through the gap and is much faster', () => {
    const all = buildRuidaPlan(frame('all'));
    const auto = buildRuidaPlan(frame('auto'));
    const a = estimateMoves(planToMoves(all.plan, 1)), b = estimateMoves(planToMoves(auto.plan, 1));
    expect(b.totalSeconds).toBeLessThan(a.totalSeconds * 0.65);
    // the same ink: the burn length stays within a little of the same
    expect(Math.abs(b.cutMm - a.cutMm) / a.cutMm).toBeLessThan(0.05);
    expect(auto.info.join(' ')).toMatch(/cut through \d+ wide gap/);
    expect(all.info).toEqual([]);
  });
  it('auto leaves a plain rectangle alone, and the GRBL job follows the same layout', () => {
    let d = run(emptyDoc(), 'add_rect', { x: 0, y: 0, w: 60, h: 40, layer: 'Layer 1' });
    d = run(d, 'layer_set', { name: 'Layer 1', mode: 'engrave', speed: 300, power: 20, interval: 0.5, fillMode: 'auto' });
    expect(buildRuidaPlan(d).info).toEqual([]);
    const g = buildLaserJob(frame('auto'));
    expect(g.stats.info?.join(' ')).toMatch(/Fill:/);
    const plain = buildLaserJob(frame('all'));
    expect(g.stats.seconds).toBeLessThan(plain.stats.seconds);
  });
  it('groups and individually fill the same area in a different order', () => {
    let d = run(emptyDoc(), 'add_rect', { x: 0, y: 0, w: 20, h: 20, layer: 'Layer 1' });
    d = run(d, 'add_rect', { x: 100, y: 0, w: 20, h: 20, layer: 'Layer 1' });
    d = run(d, 'layer_set', { name: 'Layer 1', mode: 'engrave', speed: 300, power: 20, interval: 1, overscan: 0 });
    const t = (mode: string) => seconds(run(d, 'layer_set', { name: 'Layer 1', fillMode: mode }));
    const all = t('all'), single = t('individual');
    expect(Math.abs(all.cutMm - single.cutMm)).toBeLessThan(1);
    expect(t('auto').totalSeconds).toBeLessThanOrEqual(all.totalSeconds);
  });
  it('is saved with the layer, defaults to all, and bad values are refused', () => {
    const d = run(frame('auto'), 'add_rect', { x: 300, y: 0, w: 5, h: 5, layer: 'Layer 1' });
    expect(parseProject(serializeProject(d)).layers[0].fillMode).toBe('auto');
    const raw = JSON.parse(serializeProject(d));
    delete raw.doc.layers[0].fillMode;
    expect(parseProject(JSON.stringify(raw)).layers[0].fillMode).toBe('all');
    raw.doc.layers[0].fillMode = 'nope';
    expect(() => parseProject(JSON.stringify(raw))).toThrow(/fill mode/);
    expect(() => execute(d, 'layer_set', { name: 'Layer 1', fillMode: 'x' })).toThrow();
  });
});

describe('offset options', () => {
  it('outward, inward and both; outer shapes only drops holes; delete original', () => {
    const base = run(emptyDoc(), 'add_rect', { x: 0, y: 0, w: 100, h: 100, layer: 'Layer 1' });
    const o = (a: any) => execute(base, 'offset', { ids: ids(base), distance: 10, join: 'miter', ...a }).doc;
    const grown = o({ direction: 'outward' }).shapes[1], shrunk = o({ direction: 'inward' }).shapes[1];
    const width = (s: any) => Math.max(...s.rings[0].map((p: number[]) => p[0])) - Math.min(...s.rings[0].map((p: number[]) => p[0]));
    expect(Math.round(width(grown))).toBe(120); expect(Math.round(width(shrunk))).toBe(80);
    expect(o({ direction: 'both' }).shapes).toHaveLength(3);
    expect(o({ direction: 'outward', keep: false }).shapes).toHaveLength(1);
    // a frame (square with a hole), grown: the hole shrinks; outer only leaves just the outside
    const frame2 = execute(run(base, 'add_rect', { x: 20, y: 20, w: 60, h: 60, layer: 'Layer 1' }), 'boolean', { op: 'difference', ids: [1, 2] }).doc;
    const withHole = execute(frame2, 'offset', { ids: ids(frame2), distance: 5, direction: 'outward', keep: false, outerOnly: false }).doc.shapes[0];
    const outerOnly = execute(frame2, 'offset', { ids: ids(frame2), distance: 5, direction: 'outward', keep: false, outerOnly: true }).doc.shapes[0];
    expect((withHole as any).rings.length).toBe(2);
    expect((outerOnly as any).rings.length).toBe(1);
    expect(() => execute(base, 'offset', { ids: ids(base), distance: 5, direction: 'sideways' })).toThrow();
  });
});

describe('shapes inside shapes', () => {
  const eng = (d: Doc) => run(d, 'layer_set', { name: 'Layer 1', mode: 'engrave', speed: 400, power: 20, interval: 0.5, overscan: 0, fillMode: 'all' });
  const burn = (d: Doc) => estimateMoves(planToMoves(buildRuidaPlan(d).plan, 0)).cutMm;
  it('two nested squares on one layer fill only the band between them', () => {
    let d = run(emptyDoc(), 'add_rect', { x: 0, y: 0, w: 100, h: 100, layer: 'Layer 1' });
    d = eng(run(d, 'add_rect', { x: 10, y: 10, w: 80, h: 80, layer: 'Layer 1' }));
    // area of the band = 10000 - 6400 = 3600 mm2, at 0.5 mm between lines: 7200 mm of burn
    expect(burn(d)).toBeGreaterThan(7100); expect(burn(d)).toBeLessThan(7300);
  });
  it('a shape inside the hole fills again, and an overlap between two shapes is burnt once', () => {
    let d = run(emptyDoc(), 'add_rect', { x: 0, y: 0, w: 100, h: 100, layer: 'Layer 1' });
    d = run(d, 'add_rect', { x: 10, y: 10, w: 80, h: 80, layer: 'Layer 1' });
    d = eng(run(d, 'add_rect', { x: 30, y: 30, w: 40, h: 40, layer: 'Layer 1' }));
    expect(burn(d)).toBeGreaterThan((3600 + 1600) / 0.5 - 100); expect(burn(d)).toBeLessThan((3600 + 1600) / 0.5 + 100);
    let o = run(emptyDoc(), 'add_rect', { x: 0, y: 0, w: 60, h: 60, layer: 'Layer 1' });
    o = eng(run(o, 'add_rect', { x: 40, y: 0, w: 60, h: 60, layer: 'Layer 1' }));
    expect(burn(o)).toBeGreaterThan(100 * 60 / 0.5 - 100); expect(burn(o)).toBeLessThan(100 * 60 / 0.5 + 100);
  });
});

describe('one sweep per scan line', () => {
  it('crosses the gap between two spans of a line with the laser off, and overscans only at the two ends', () => {
    const ops = fillOps([[{ y: 0, spans: [[0, 2], [3, 5]] }]], 1);
    expect(ops.map((o) => [o.x, o.feed, o.burn])).toEqual([[-1, false, false], [0, true, false], [2, true, true], [3, true, false], [5, true, true], [6, true, false]]);
  });
});
