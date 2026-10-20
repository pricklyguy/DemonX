import { describe, expect, it } from 'vitest';
import { toolProfile, parseTaper, type CncTool } from '../src/core/cnc';
import { DropCutter } from '../src/core/cam3d';
import { cellsToBase64, type Relief } from '../src/core/relief';
import { emptyDoc } from '../src/core/types';
import { execute } from '../src/core/commands';
import { buildAll } from '../src/core/cncjob';
import { parseProject, serializeProject } from '../src/core/project';
import { parseToolLibrary, geometryOk, geometryGaps, toJobTool } from '../src/core/toollib';

const base: CncTool = { id: 't', name: 'tapered', kind: 'ball', diameter: 1, flutes: 2, rpm: 18000, feed: 800, plunge: 300, stepdown: 1, stepover: 15, taperAngle: 20, maxDiameter: 6 };
const run = (d: any, id: string, a: any): any => execute(d, id, a).doc;

describe('the shape of a tapered ball nose', () => {
  const p = toolProfile(base);
  it('is a ball at the tip and a cone above it that touches the ball without a corner', () => {
    expect(p.rMax).toBe(3);
    expect(p.z(0)).toBe(0);
    expect(p.z(0.2)).toBeCloseTo(0.5 - Math.sqrt(0.25 - 0.04), 6);   // still on the ball (radius 0.5)
    const beta = (10 * Math.PI) / 180, dt = 0.5 * Math.cos(beta), ht = 0.5 * (1 - Math.sin(beta));
    expect(p.z(dt)).toBeCloseTo(ht, 6);
    expect(p.z(1.5)).toBeCloseTo(ht + (1.5 - dt) / Math.tan(beta), 6);   // on the cone
    // the slope is the same just either side of where they meet (tangent)
    const e = 1e-4;
    expect((p.z(dt) - p.z(dt - e)) / e).toBeCloseTo((p.z(dt + e) - p.z(dt)) / e, 1);
    // it rises more slowly than a plain ball of the same radius would not: it is much lower than a ball far out
    expect(p.z(2)).toBeGreaterThan(toolProfile({ ...base, taperAngle: undefined, maxDiameter: undefined }).z(0.49));
  });
  it('a plain ball, a flat and a V-bit are as before', () => {
    expect(toolProfile({ ...base, diameter: 6, taperAngle: undefined, maxDiameter: undefined }).z(3)).toBeCloseTo(3);
    expect(toolProfile({ ...base, kind: 'flat', diameter: 6, taperAngle: undefined, maxDiameter: undefined }).z(2)).toBe(0);
    expect(toolProfile({ ...base, kind: 'vbit', diameter: 12, vAngle: 90, taperAngle: undefined, maxDiameter: undefined }).z(2)).toBeCloseTo(2);
  });
});

describe('a tapered ball nose and the drop cutter', () => {
  /** A step wall: the left half 10 high, the right half at the bottom, on 40 x 40 mm of 0.1 mm cells */
  const wall = (): Relief => {
    const n = 400, c = new Uint16Array(n * n);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) c[j * n + i] = i < 200 ? 65535 : 0;
    return { id: 1, name: 'w', w: n, h: n, data: cellsToBase64(c), x: 0, y: 0, width: 40, depth: 10, visible: true };
  };
  it('rests on the wall by the shape of the tool: ball where it is close, cone where it is further', () => {
    const dc = new DropCutter(wall(), base);
    const p = toolProfile(base);
    // d from the wall; the wall is on a cell edge (0.1 mm cells), so the answer is between what d - 0.1 and d + 0.1 would give
    for (const d of [0.3, 1.0, 1.5, 2.5]) { const t = dc.tipAt(20 + d, 20); expect(t).toBeGreaterThanOrEqual(Math.max(0, 10 - p.z(d + 0.1)) - 1e-6); expect(t).toBeLessThanOrEqual(Math.max(0, 10 - p.z(Math.max(0, d - 0.1))) + 1e-6); }
    expect(dc.tipAt(30, 20)).toBe(0);                  // far from the wall, down to the bottom
    expect(dc.tipAt(10, 20)).toBeCloseTo(10, 2);       // on top of it
  });
  it('goes much deeper into a narrow groove than a 6 mm ball can', () => {
    const n = 400, c = new Uint16Array(n * n).fill(65535);
    for (let j = 0; j < n; j++) for (let i = 190; i < 210; i++) c[j * n + i] = 0;   // a groove 2 mm wide
    const groove: Relief = { id: 1, name: 'g', w: n, h: n, data: cellsToBase64(c), x: 0, y: 0, width: 40, depth: 10, visible: true };
    const tapered = new DropCutter(groove, base).tipAt(20, 20);
    const ball6 = new DropCutter(groove, { ...base, diameter: 6, taperAngle: undefined, maxDiameter: undefined }).tipAt(20, 20);
    expect(tapered).toBeLessThan(7.2);   // a 1 mm tip with a 20 degree taper gets about 3.3 mm down from the top
    expect(ball6).toBeGreaterThan(9.5);
  });
});

describe('a tapered ball nose in a job and in the library', () => {
  it('is kept with the tool, only for a ball nose, with a sensible taper and diameter', () => {
    let d = run(emptyDoc(), 'cnc_tool_set', { tool: base });
    expect(d.cnc.tools.find((t: any) => t.id === 't')).toMatchObject({ taperAngle: 20, maxDiameter: 6, diameter: 1 });
    expect(parseProject(serializeProject(d)).cnc!.tools.find((t) => t.id === 't')).toMatchObject({ taperAngle: 20, maxDiameter: 6 });
    expect(() => run(emptyDoc(), 'cnc_tool_set', { tool: { ...base, kind: 'flat' } })).toThrow(/Only a ball nose/);
    expect(() => run(emptyDoc(), 'cnc_tool_set', { tool: { ...base, maxDiameter: 0.5 } })).toThrow(/largest diameter/);
    expect(() => run(emptyDoc(), 'cnc_tool_set', { tool: { ...base, taperAngle: 90 } })).toThrow(/taper angle/);
    expect(() => run(emptyDoc(), 'cnc_tool_set', { tool: { ...base, taperAngle: undefined } })).toThrow(/taper angle/);
    const j = JSON.parse(serializeProject(d));
    j.doc.cnc.tools.find((t: any) => t.id === 't').kind = 'flat';
    expect(() => parseProject(JSON.stringify(j))).toThrow(/only a ball nose/);
    expect(parseTaper({ diameter: 1 })).toBeNull();
  });
  it('the library knows its taper, says what is missing, and passes it to the job', () => {
    const lib = parseToolLibrary({ v: 1, tools: [
      { id: 'A', name: 'Taper', kind: 'ball', diameter: 0.8, taper: 12, recipes: [] },
      { id: 'B', name: 'Taper, known', kind: 'ball', diameter: 0.8, taper: 12, maxDiameter: 6.35, flutes: 2, recipes: [{ machine: 'M', material: 'MDF', status: 'Approved', rpm: 18000, feed: 1000, plunge: 400, passDepth: 0.5, stepoverMm: 0.1 }] },
      { id: 'C', name: 'Plain ball', kind: 'ball', diameter: 3, recipes: [] },
    ] });
    expect(lib.tools.map(geometryOk)).toEqual([false, true, true]);
    expect(geometryGaps(lib.tools[0])).toEqual(['the largest diameter of the taper']);
    expect(toJobTool(lib.tools[1], lib.tools[1].recipes[0])).toMatchObject({ kind: 'ball', diameter: 0.8, taperAngle: 12, maxDiameter: 6.35, stepover: 12.5 });
    expect(toJobTool(lib.tools[2]).taperAngle).toBeUndefined();
    expect(() => parseToolLibrary({ v: 1, tools: [{ id: 'A', name: 'x', kind: 'ball', taper: 80, recipes: [] }] })).toThrow(/taper/);
  });
  it('3D finishing and roughing work with it and keep the tool above the grid', () => {
    const n = 100, c = new Uint16Array(n * n);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) c[j * n + i] = Math.round(20000 + 30000 * Math.abs(Math.sin(i * 0.2)) * Math.abs(Math.cos(j * 0.15)));
    let d: any = run(emptyDoc(), 'new_project', { kind: 'cnc', width: 100, height: 100, thickness: 20 });
    d = run(d, 'relief_add', { name: 'R', w: n, h: n, data: cellsToBase64(c), x: 10, y: 10, width: 30, depth: 8 });
    d = run(d, 'cnc_tool_set', { tool: base });
    d = run(d, 'cnc_toolpath_add', { kind: 'finish3d', toolId: 't', reliefId: 1, scan: { dir: 'x', stepoverMm: 0.4 } });
    d = run(d, 'cnc_toolpath_add', { kind: 'rough3d', toolId: 't', reliefId: 1, scan: { dir: 'x', stepoverMm: 1.5 }, allowance: 0.3 });
    const dc = new DropCutter(d.reliefs[0], base);
    for (const bp of buildAll(d)) {
      const allowance = bp.tp.kind === 'rough3d' ? 0.3 : 0;
      const m = bp.result.moves;
      expect(m.length).toBeGreaterThan(100);
      let worst = Infinity;
      for (let i = 1; i < m.length; i++) {
        if (m[i].kind === 'rapid') continue;
        const a = m[i - 1], q = m[i], steps = Math.max(1, Math.ceil(Math.hypot(q.x - a.x, q.y - a.y) / 0.1));
        for (let k = 0; k <= steps; k++) { const t = k / steps; worst = Math.min(worst, a.z + (q.z - a.z) * t + 8 - (dc.tipAt(a.x + (q.x - a.x) * t, a.y + (q.y - a.y) * t) + allowance)); }
      }
      expect(worst).toBeGreaterThan(bp.tp.kind === 'rough3d' ? -0.02 : -0.3);
    }
  });
});
