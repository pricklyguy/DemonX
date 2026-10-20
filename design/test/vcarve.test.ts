import { describe, expect, it } from 'vitest';
import { emptyDoc } from '../src/core/types';
import { execute } from '../src/core/commands';
import { buildAll } from '../src/core/cncjob';

const job = () => execute(emptyDoc(), 'new_project', { kind: 'cnc', width: 300, height: 200, thickness: 18 }).doc;
const run = (d: any, id: string, a: any) => execute(d, id, a).doc;
const vbit90 = { id: 'v90', name: '90° V-bit', kind: 'vbit', diameter: 24, vAngle: 90, flutes: 2, rpm: 18000, feed: 800, plunge: 300, stepdown: 1.5, stepover: 30 };

describe('V-bit carving', () => {
  const square = (size: number, depth: number, tool = 'v90') => {
    let d = run(job(), 'cnc_tool_set', { tool: vbit90 });
    d = run(d, 'add_rect', { x: 50, y: 50, w: size, h: size, layer: 'Layer 1' });
    return run(d, 'cnc_toolpath_add', { kind: 'vcarve', toolId: tool, cutDepth: depth, ids: [d.shapes[0].id] });
  };
  it('cuts each ring in from the edge at the depth where a 90 degree bit just touches the wall', () => {
    const d = square(20, 8);
    const [b] = buildAll(d);
    expect(b.result.warnings).toEqual([]);
    const cuts = b.result.moves.filter((m) => m.kind === 'cut');
    for (const m of cuts) {
      // 90 degrees: depth equals the distance in from the nearest wall of the 20 mm square
      const dist = Math.min(m.x - 50, 70 - m.x, m.y - 50, 70 - m.y);
      expect(-m.z).toBeCloseTo(Math.min(dist, 8), 0);
    }
    expect(Math.min(...cuts.map((m) => m.z))).toBeCloseTo(-8, 0);   // the middle is 10 mm from the walls, so the max depth of 8 is reached
  });
  it('never goes deeper than the max depth, and clears the flat part at that depth', () => {
    const d = square(40, 5);
    const [b] = buildAll(d);
    const zs = b.result.moves.filter((m) => m.kind === 'cut').map((m) => m.z);
    expect(Math.min(...zs)).toBeCloseTo(-5);
    expect(zs.filter((z) => Math.abs(z + 5) < 1e-6).length).toBeGreaterThan(8);
  });
  it('limits the depth to what the bit can reach, and warns', () => {
    const d = square(60, 40);
    const [b] = buildAll(d);
    expect(b.result.warnings.join(' ')).toMatch(/can only go 12\.00 mm deep/);
    expect(Math.min(...b.result.moves.map((m) => m.z))).toBeGreaterThanOrEqual(-12.0001);
  });
  it('says so for a flat end mill, an open line and a shape that is too narrow', () => {
    let d = run(job(), 'add_rect', { x: 10, y: 10, w: 20, h: 20, layer: 'Layer 1' });
    d = run(d, 'cnc_toolpath_add', { kind: 'vcarve', toolId: 'flat-6', cutDepth: 3, ids: [d.shapes[0].id] });
    expect(buildAll(d)[0].result.warnings.join(' ')).toMatch(/needs a V-bit/);
    expect(buildAll(d)[0].result.moves).toEqual([]);
    let e = run(job(), 'add_path', { points: [[0, 0], [30, 0]], closed: false, layer: 'Layer 1' });
    e = run(e, 'cnc_toolpath_add', { kind: 'vcarve', toolId: 'vbit-60', cutDepth: 3, ids: [e.shapes[0].id] });
    expect(buildAll(e)[0].result.warnings.join(' ')).toMatch(/closed shapes/);
  });
});
