import { describe, expect, it } from 'vitest';
import { emptyDoc } from '../src/core/types';
import { execute } from '../src/core/commands';
import { computeJobs, fromWire, packMoves, toWire, unpackMoves } from '../src/core/jobBuild';

const input = (ruida: boolean) => {
  let d = execute(emptyDoc(), 'add_rect', { x: 0, y: 0, w: 20, h: 10, layer: 'Layer 1' }).doc;
  d = execute(d, 'layer_set', { name: 'Layer 1', mode: 'engrave', speed: 100, power: 20, interval: 1, overscan: 1 }).doc;
  return { doc: d, anchor: 'bl' as const, startFrom: 'user' as const, order: { innerFirst: true, reduceTravel: true }, ruida };
};

describe('job building off the page', () => {
  it('packs and unpacks moves exactly, with and without a speed', () => {
    const moves = [
      { x0: 0, y0: 1, x1: 2, y1: 3, burn: true, layer: 'a', speed: 50 },
      { x0: 2, y0: 3, x1: 9, y1: 9, burn: false, layer: 'b' },
    ];
    expect(unpackMoves(packMoves(moves))).toEqual(moves);
  });
  it('the result that crosses from the worker is the same job', () => {
    for (const ruida of [false, true]) {
      const out = computeJobs(input(ruida));
      const back = fromWire(toWire(out).wire);
      expect(back.job.moves).toEqual(out.job.moves);
      expect(back.ruida).toEqual(out.ruida);
      expect(back.est.totalSeconds).toBe(out.est.totalSeconds);
      expect(Array.from(back.est.at)).toEqual(Array.from(out.est.at));
    }
    expect(computeJobs(input(true)).ruida.empty).toBe(false);
  });
});
