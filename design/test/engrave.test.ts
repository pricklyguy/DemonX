import { describe, expect, it } from 'vitest';
import { emptyDoc } from '../src/core/types';
import { execute } from '../src/core/commands';
import { buildAll } from '../src/core/cncjob';

const job = () => execute(emptyDoc(), 'new_project', { kind: 'cnc', width: 300, height: 200, thickness: 18 }).doc;
const run = (d: any, id: string, a: any) => execute(d, id, a).doc;

describe('engraving toolpaths', () => {
  it('follows an open line and a closed shape at the cut depth, with no offset', () => {
    let d = job();
    d = run(d, 'add_path', { points: [[10, 10], [50, 10], [50, 30]], closed: false, layer: 'Layer 1' });
    d = run(d, 'add_rect', { x: 100, y: 100, w: 20, h: 20, layer: 'Layer 1' });
    d = run(d, 'cnc_toolpath_add', { kind: 'engrave', toolId: 'vbit-60', cutDepth: 1, ids: d.shapes.map((s) => s.id) });
    expect(d.cnc!.toolpaths[0]).toMatchObject({ kind: 'engrave', name: 'Engraving 1' });
    const [b] = buildAll(d);
    const cuts = b.result.moves.filter((m) => m.kind === 'cut');
    expect(b.result.warnings).toEqual([]);
    expect(Math.min(...cuts.map((m) => m.z))).toBeCloseTo(-1);
    expect(Math.max(...cuts.map((m) => m.z))).toBeCloseTo(-1);
    // the rectangle's corners are cut exactly, not offset by the tool radius
    expect(cuts.some((m) => m.x === 100 && m.y === 100)).toBe(true);
    expect(cuts.some((m) => m.x === 120 && m.y === 120)).toBe(true);
  });
  it('runs the line nearest the origin first, from its nearer end', () => {
    let d = job();
    d = run(d, 'add_path', { points: [[200, 150], [250, 150]], closed: false, layer: 'Layer 1' });
    d = run(d, 'add_path', { points: [[10, 10], [60, 10]], closed: false, layer: 'Layer 1' });
    d = run(d, 'cnc_toolpath_add', { kind: 'engrave', toolId: 'ball-3', cutDepth: 0.5, ids: d.shapes.map((s) => s.id) });
    const m = buildAll(d)[0].result.moves;
    const firstPlunge = m.find((x) => x.kind === 'plunge')!;
    expect([firstPlunge.x, firstPlunge.y]).toEqual([10, 10]);
  });
  it('climb and conventional run a closed shape in opposite directions', () => {
    const area = (dir: string) => {
      let d = job();
      d = run(d, 'add_rect', { x: 10, y: 10, w: 30, h: 20, layer: 'Layer 1' });
      d = run(d, 'cnc_toolpath_add', { kind: 'engrave', toolId: 'flat-3', cutDepth: 0.5, ids: [d.shapes[0].id], direction: dir });
      const pts = buildAll(d)[0].result.moves.filter((m) => m.kind === 'plunge' || m.kind === 'cut');
      let a = 0; for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p.x * q.y - q.x * p.y; }
      return a;
    };
    expect(area('climb')).toBeGreaterThan(0);
    expect(area('conventional')).toBeLessThan(0);
  });
  it('makes several passes when deeper than the tool steps down, and warns about a drill', () => {
    let d = job();
    d = run(d, 'add_path', { points: [[10, 10], [60, 10]], closed: false, layer: 'Layer 1' });
    d = run(d, 'cnc_toolpath_add', { kind: 'engrave', toolId: 'flat-6', cutDepth: 5, ids: [d.shapes[0].id] });
    expect(buildAll(d)[0].result.stats.passes).toBe(3);
    d = run(d, 'cnc_toolpath_update', { id: 1, toolId: 'drill-3' });
    expect(buildAll(d)[0].result.warnings.join(' ')).toMatch(/drill cannot engrave/);
  });
});
