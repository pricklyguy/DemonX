import { describe, expect, it } from 'vitest';
import { emptyDoc } from '../src/core/types';
import { execute } from '../src/core/commands';
import { buildAll } from '../src/core/cncjob';
import { parseProject, serializeProject } from '../src/core/project';

const vbit90 = { id: 'v90', name: '90° V-bit', kind: 'vbit', diameter: 24, vAngle: 90, flutes: 2, rpm: 18000, feed: 800, plunge: 300, stepdown: 1.5, stepover: 30 };
const run = (d: any, id: string, a: any): any => execute(d, id, a).doc;
const base = (): any => {
  let d = run(emptyDoc(), 'new_project', { kind: 'cnc', width: 300, height: 200, thickness: 18 });
  d = run(d, 'cnc_tool_set', { tool: vbit90 });
  return run(d, 'add_rect', { x: 50, y: 50, w: 40, h: 20, layer: 'Layer 1' });
};
const inlay = (extra: any = {}): any => { const d = base(); return run(d, 'cnc_inlay_add', { ids: [d.shapes[0].id], vbitId: 'v90', depth: 4, ...extra }); };
const cuts = (d: any, i: number) => buildAll(d, [d.cnc.toolpaths[i].id])[0].result.moves.filter((m: any) => m.kind === 'cut');
const signedArea = (pts: any[]) => { let a = 0; for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p.x * q.y - q.x * p.y; } return a; };

describe('inlay toolpaths', () => {
  it('makes the pocket, the plug and the cut-out in one go', () => {
    const d = inlay({ gap: 0.2, cutterId: 'flat-6', through: 18.3 });
    expect(d.cnc.toolpaths.map((t: any) => [t.kind, t.mirror === true, t.toolId])).toEqual([['vcarve', false, 'v90'], ['plug', true, 'v90'], ['profile', true, 'flat-6']]);
    expect(d.cnc.toolpaths[0]).toMatchObject({ allowance: 0.2, cutDepth: 4 });
    expect(d.cnc.toolpaths[2]).toMatchObject({ side: 'outside', cutDepth: 18.3 });
    expect(inlay().cnc.toolpaths).toHaveLength(2);
    expect(inlay({ mirror: false }).cnc.toolpaths[1].mirror).toBeUndefined();
  });
  it('the pocket is the shape grown by the gap, V-carved to the full depth', () => {
    const d = inlay({ gap: 0.5 });
    const c = cuts(d, 0);
    expect(Math.min(...c.map((m: any) => m.z))).toBeCloseTo(-4);
    // the first ring is a little way in from the grown outline (49.5 .. 90.5), never outside it
    expect(Math.min(...c.map((m: any) => m.x))).toBeGreaterThanOrEqual(49.5 - 1e-6);
    expect(Math.max(...c.map((m: any) => m.x))).toBeLessThanOrEqual(90.5 + 1e-6);
    const plain = cuts(inlay({ gap: 0 }), 0);
    expect(Math.min(...plain.map((m: any) => m.x))).toBeGreaterThanOrEqual(50 - 1e-6);
  });
  it('the plug is a chamfer: full depth at the outline, shallower the further in, none past depth x tan(half angle)', () => {
    const d = inlay({ mirror: false });
    for (const m of cuts(d, 1)) {
      const inward = Math.min(m.x - 50, 90 - m.x, m.y - 50, 70 - m.y);   // 90 degrees: tan(45) = 1
      expect(inward).toBeGreaterThanOrEqual(-1e-6);
      expect(-m.z).toBeCloseTo(4 - inward, 1);
    }
    expect(Math.min(...cuts(d, 1).map((m: any) => m.z))).toBeCloseTo(-4);
  });
  it('a mirrored plug is the same cuts flipped about the middle of the shape, still climb', () => {
    const plain = cuts(inlay({ mirror: false }), 1), flipped = cuts(inlay({ mirror: true }), 1);
    expect(flipped).toHaveLength(plain.length);
    const sum = 50 + 90;
    const key = (m: any) => `${(sum - m.x).toFixed(3)},${m.y.toFixed(3)},${m.z.toFixed(3)}`;
    expect(new Set(flipped.map((m: any) => `${m.x.toFixed(3)},${m.y.toFixed(3)},${m.z.toFixed(3)}`))).toEqual(new Set(plain.map(key)));
    const firstRing = (c: any[]) => c.slice(0, 4);
    expect(Math.sign(signedArea(firstRing(flipped)))).toBe(Math.sign(signedArea(firstRing(plain))));
  });
  it('refuses a flat end mill, a depth the bit cannot reach, and keeps the mirror when saved', () => {
    const d = base();
    expect(() => run(d, 'cnc_inlay_add', { ids: [d.shapes[0].id], vbitId: 'nope', depth: 4 })).toThrow(/no tool/);
    const e = inlay();
    expect(parseProject(serializeProject(e)).cnc!.toolpaths.map((t) => t.mirror === true)).toEqual([false, true]);
    const j = JSON.parse(serializeProject(e));
    j.doc.cnc.toolpaths[1].mirror = 'yes';
    expect(() => parseProject(JSON.stringify(j))).toThrow(/mirror/);
    const canvas = run(e, 'workspace_set', { kind: 'canvas' });
    expect(() => run(canvas, 'cnc_inlay_add', { ids: [canvas.shapes[0].id], vbitId: 'v90', depth: 3 })).toThrow(/canvas/);
  });
});
