import { describe, expect, it } from 'vitest';
import { emptyDoc } from '../src/core/types';
import { execute } from '../src/core/commands';
import { buildRuidaPlan } from '../src/core/ruidaPlan';
import { buildLaserJob } from '../src/core/laser';
import { clock, estimateMoves, planToMoves } from '../src/core/jobEstimate';
import type { Doc } from '../src/core/types';

const run = (d: Doc, id: string, a: any) => execute(d, id, a).doc;

describe('job estimate', () => {
  it('prices a feed run with its ramps (none below the start speed) and a rapid by a trapezoid', () => {
    const model = { rapid: 400, rapidAccel: 3000, feedAccel: 4000, startSpeed: 20, shiftSpeed: 100 };
    const moves = [
      { x0: 0, y0: 0, x1: 100, y1: 0, burn: true, layer: 'a', speed: 60 },
      { x0: 100, y0: 0, x1: 100, y1: 100, burn: false, layer: 'a' },
    ];
    const e = estimateMoves(moves, model);
    expect(e.cutMm).toBe(100); expect(e.rapidMm).toBe(100);
    expect(e.cutSeconds).toBeCloseTo(100 / 60 + (2 * 40) / 4000, 6);
    expect(e.rapidSeconds).toBeCloseTo(100 / 400 + 400 / 3000, 6);
    expect(e.at[1]).toBeCloseTo(e.totalSeconds, 9);
    expect(estimateMoves([{ x0: 0, y0: 0, x1: 100, y1: 0, burn: true, layer: 'a', speed: 10 }], model).cutSeconds).toBeCloseTo(10, 9);
    expect(estimateMoves([{ x0: 0, y0: 0, x1: 1, y1: 0, burn: false, layer: 'a' }], model).rapidSeconds).toBeCloseTo(2 * Math.sqrt(1 / 3000), 6);
  });
  it('matches two timed fills on the Pronto 45 (121 s and 182 s measured; LightBurn said 199 s and 339 s)', () => {
    const fill = (w: number, h: number) => {
      let d = run(emptyDoc(), 'add_rect', { x: 0, y: 0, w, h, layer: 'Layer 1' });
      d = run(d, 'layer_set', { name: 'Layer 1', mode: 'engrave', speed: 415, power: 20, interval: 0.1, overscan: 1 });
      return estimateMoves(planToMoves(buildRuidaPlan(d).plan, 1));
    };
    const a = fill(50, 50), b = fill(25, 100);
    expect(a.cutMm).toBeGreaterThan(24900); expect(a.cutMm).toBeLessThan(25100);
    expect(Math.abs(a.totalSeconds - 121) / 121).toBeLessThan(0.06);
    expect(Math.abs(b.totalSeconds - 182) / 182).toBeLessThan(0.06);
  });
  it('the plan and the G-code job give the same burn length for the same drawing', () => {
    let d = run(emptyDoc(), 'add_rect', { x: 0, y: 0, w: 40, h: 20, layer: 'Layer 1' });
    d = run(d, 'layer_set', { name: 'Layer 1', mode: 'engrave', speed: 100, power: 20, interval: 1, overscan: 2 });
    const a = estimateMoves(planToMoves(buildRuidaPlan(d).plan, 2));
    const b = estimateMoves(buildLaserJob(d).moves);
    expect(a.cutMm).toBeCloseTo(b.cutMm, 3);
    // overscan is a feed at the layer speed in both, so both count it as cutting time, not rapid
    expect(a.cutSeconds).toBeCloseTo(b.cutSeconds, 1);
  });
  it('matches the timed frame job (366 s all at once, 337 s cut through the gap) on the Pronto 45', () => {
    const frame = (mode: string) => {
      let d = run(emptyDoc(), 'add_rect', { x: 0, y: 0, w: 100, h: 100, layer: 'Layer 1' });
      d = run(d, 'add_rect', { x: 10, y: 10, w: 80, h: 80, layer: 'Layer 1' });
      d = run(d, 'layer_set', { name: 'Layer 1', mode: 'engrave', speed: 415, power: 20, interval: 0.1, overscan: 1, fillMode: mode });
      return estimateMoves(planToMoves(buildRuidaPlan(d).plan, 1)).totalSeconds;
    };
    expect(Math.abs(frame('all') - 366) / 366).toBeLessThan(0.05);
    expect(Math.abs(frame('auto') - 337) / 337).toBeLessThan(0.05);
  });
  it('formats like LightBurn', () => {
    expect(clock(52 * 60 + 33)).toBe('52:33');
    expect(clock(2 * 3600 + 49 * 60 + 26)).toBe('2:49:26');
    expect(clock(45)).toBe('0:45');
  });
});

import { findProgress, type MonitorJob } from '../src/ui/JobMonitor';
describe('monitor progress', () => {
  it('finds where in the path the head is, only forwards, near where the clock says', () => {
    let d = run(emptyDoc(), 'add_rect', { x: 0, y: 0, w: 60, h: 40, layer: 'Layer 1' });
    d = run(d, 'layer_set', { name: 'Layer 1', mode: 'engrave', speed: 100, power: 20, interval: 1, overscan: 1 });
    const moves = planToMoves(buildRuidaPlan(d).plan, 1);
    const est = estimateMoves(moves);
    const job: MonitorJob = { moves, est, start: { x: 200, y: 100 } };
    let from = 0;
    for (const frac of [0.2, 0.5, 0.8]) {
      const i = est.at.findIndex((a) => a >= est.totalSeconds * frac);
      const m = moves[i];
      // the head in controller coordinates: x right, y toward the front (the plan is Y up)
      const head = { x: job.start.x + (m.x0 + m.x1) / 2, y: job.start.y - (m.y0 + m.y1) / 2 };
      const found = findProgress(job, head, est.totalSeconds * frac, from);
      expect(Math.abs(est.at[found] - est.at[i])).toBeLessThan(est.totalSeconds * 0.05);
      from = found;
    }
    // never goes backwards
    expect(findProgress(job, { x: 200, y: 100 }, est.totalSeconds * 0.9, from)).toBeGreaterThanOrEqual(from);
  });
});
