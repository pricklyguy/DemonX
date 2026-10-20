import { describe, expect, it } from 'vitest';
import { emptyDoc } from '../src/core/types';
import type { Doc, Shape } from '../src/core/types';
import { execute } from '../src/core/commands';
import { buildRuidaPlan } from '../src/core/ruidaPlan';
import { contoursOf, orderContours, orderLayer, travelLength } from '../src/core/laser';
import { estimateMoves, planToMoves } from '../src/core/jobEstimate';

const run = (d: Doc, id: string, a: any) => execute(d, id, a).doc;

/** a scatter of small squares, the same every time */
function scatter(n: number): Doc {
  let d = emptyDoc();
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < n; i++) d = run(d, 'add_rect', { x: Math.round(rnd() * 400), y: Math.round(rnd() * 250), w: 8, h: 8, layer: 'Layer 1' });
  return d;
}
const shapesOf = (d: Doc): Shape[] => d.shapes;

describe('cut order', () => {
  it('a shorter route between scattered parts than the drawing order, and never longer than nearest-first', () => {
    const d = scatter(40);
    const all = contoursOf(shapesOf(d));
    const from: [number, number] = [0, 0];
    const asDrawn = travelLength(orderContours(all, from, { reduceTravel: false }), from);
    const tuned = travelLength(orderContours(all, from), from);
    expect(tuned).toBeLessThan(asDrawn * 0.4);
    expect(orderContours(all, from)).toHaveLength(all.length);
  });
  it('keeps inner shapes first, and every contour is cut exactly once', () => {
    let d = run(emptyDoc(), 'add_rect', { x: 0, y: 0, w: 100, h: 100, layer: 'Layer 1' });
    d = run(d, 'add_rect', { x: 40, y: 40, w: 10, h: 10, layer: 'Layer 1' });
    d = run(d, 'add_rect', { x: 200, y: 0, w: 20, h: 20, layer: 'Layer 1' });
    const list = orderContours(contoursOf(d.shapes), [0, 0]);
    expect(list.map((c) => c.depth)).toEqual([...list.map((c) => c.depth)].sort((a, b) => b - a));
    expect(list).toHaveLength(3);
    const unsorted = orderContours(contoursOf(d.shapes), [0, 0], { innerFirst: false });
    expect(unsorted).toHaveLength(3);
  });
  it('turns open lines round when that is shorter, and keeps their points', () => {
    let d = run(emptyDoc(), 'add_path', { points: [[0, 0], [50, 0]], closed: false, layer: 'Layer 1' });
    d = run(d, 'add_path', { points: [[100, 0], [60, 0]], closed: false, layer: 'Layer 1' });
    const list = orderContours(contoursOf(d.shapes), [0, 0]);
    expect(list[0].pts[0]).toEqual([0, 0]);
    expect(list[1].pts[0]).toEqual([60, 0]); // started at its near end
    expect(list[1].pts).toHaveLength(2);
  });
  it('the Ruida plan follows the order option, and says what it saved', () => {
    let d = scatter(30);
    d = run(d, 'layer_set', { name: 'Layer 1', mode: 'cut', speed: 20, power: 20 });
    const on = buildRuidaPlan(d), off = buildRuidaPlan(d, { order: { reduceTravel: false } });
    const t = (r: typeof on) => estimateMoves(planToMoves(r.plan));
    expect(t(on).rapidMm).toBeLessThan(t(off).rapidMm * 0.5);
    expect(t(on).totalSeconds).toBeLessThan(t(off).totalSeconds);
    expect(on.info.join(' ')).toMatch(/Cut order: empty travel \d+ mm → \d+ mm/);
    expect(off.info).toEqual([]);
    // the same cutting: the burn length does not change
    expect(Math.abs(t(on).cutMm - t(off).cutMm)).toBeLessThan(1);
    expect(orderLayer(d.shapes, [0, 0]).list.length).toBe(30);
  });
});
