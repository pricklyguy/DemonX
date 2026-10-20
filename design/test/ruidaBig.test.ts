import { describe, expect, it } from 'vitest';
import { writeJobStream } from '../server/src/ruida/write';
import { parseJobStream } from '../server/src/ruida/parse';
import { checkJob } from '../server/src/ruida/validate';
import { DEFAULT_LIMITS } from '../server/src/ruida/validate';
import type { RuidaPlan } from '../server/src/ruida/plan';

/** a fill-like layer: back and forth lines, `lines` of them */
function bigPlan(lines: number): RuidaPlan {
  const points: { x: number; y: number; burn: boolean }[] = [];
  for (let i = 0; i < lines; i++) {
    const y = i * 0.05, left = i % 2 === 0;
    points.push({ x: left ? -1 : 101, y, burn: false }, { x: left ? 0 : 100, y, burn: false }, { x: left ? 100 : 0, y, burn: true }, { x: left ? 101 : -1, y, burn: false });
  }
  points[0] = { ...points[0], burn: false };
  return { layers: [{ colorRaw: 0xff, mode: 'fill', speed: 400, minPower: 20, maxPower: 20, air: false, points }] };
}

describe('very big jobs', () => {
  it('writes and reads back a fill with half a million points (the byte list is far more than a function call can take)', () => {
    const plan = bigPlan(130_000);   // 520,000 points, several million bytes
    const t = Date.now();
    const stream = writeJobStream(plan);
    expect(stream.length).toBeGreaterThan(2_000_000);
    const back = parseJobStream(stream);
    expect(back.plan.layers).toHaveLength(1);
    expect(back.plan.layers[0].points).toHaveLength(plan.layers[0].points.length);
    expect(Date.now() - t).toBeLessThan(20_000);
  });
  it('is accepted by the server check up to the point limit', () => {
    const plan = bigPlan(10_000);   // 500 mm tall
    const stream = writeJobStream(plan);
    const check = checkJob(parseJobStream(stream), DEFAULT_LIMITS);
    expect(check.ok, check.error).toBe(true);
  });
});
