import { describe, expect, it } from 'vitest';
import { previewMoves, simFrame } from '../src/core/cncpreview';

const built = [
  { tp: { id: 1 }, result: { moves: [{ kind: 'rapid', x: 0, y: 0, z: 5 }, { kind: 'plunge', x: 0, y: 0, z: -2 }, { kind: 'cut', x: 10, y: 0, z: -2 }, { kind: 'cut', x: 10, y: 10, z: -2 }] as any } },
  { tp: { id: 2 }, result: { moves: [{ kind: 'rapid', x: 20, y: 20, z: 5 }, { kind: 'cut', x: 30, y: 20, z: 5 }] as any } },
];

describe('cnc preview', () => {
  it('turns moves into segments, for all toolpaths or only the chosen ones', () => {
    expect(previewMoves(built, null)).toHaveLength(4);
    expect(previewMoves(built, [1])).toHaveLength(3);
    expect(previewMoves(built, [2]).map((m) => m.kind)).toEqual(['cut']);
    expect(previewMoves(built, [])).toEqual([]);
  });
  it('finds the tool at the start, the middle and the end of the animation', () => {
    const m = previewMoves(built, [1]);
    expect(simFrame(m, 0).partial).toBeNull();
    const end = simFrame(m, 1);
    expect(end).toMatchObject({ x: 10, y: 10, z: -2, done: 3, partial: null });
    const mid = simFrame(m, 0.6);
    expect(mid.done).toBeGreaterThanOrEqual(1);
    expect(mid.partial).not.toBeNull();
    expect(simFrame([], 0.5)).toMatchObject({ done: 0, partial: null });
  });
  it('never goes backwards as the fraction grows', () => {
    const m = previewMoves(built, null);
    let last = -1;
    for (let i = 0; i <= 50; i++) { const f = simFrame(m, i / 50); const key = f.done + (f.partial ? 0.5 : 0); expect(key).toBeGreaterThanOrEqual(last); last = key; }
  });
});
