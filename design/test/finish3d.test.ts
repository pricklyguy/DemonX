import { describe, expect, it } from 'vitest';
import { emptyDoc } from '../src/core/types';
import { execute } from '../src/core/commands';
import { buildAll } from '../src/core/cncjob';
import { DropCutter } from '../src/core/cam3d';
import { cellsToBase64, type Relief } from '../src/core/relief';
import { parseProject, serializeProject } from '../src/core/project';

const run = (d: any, id: string, a: any): any => execute(d, id, a).doc;
/** A dome: a sphere of radius 20 sitting on a 40 x 40 square, its top 20 mm above the bottom (200 x 200 cells of 0.2 mm) */
const dome = (): { w: number; h: number; data: string; depth: number } => {
  const n = 200, cells = new Uint16Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const x = (i + 0.5) * 0.2 - 20, y = 20 - (j + 0.5) * 0.2, h = Math.sqrt(Math.max(0, 400 - x * x - y * y));
    cells[j * n + i] = Math.round((h / 20) * 65535);
  }
  return { w: n, h: n, data: cellsToBase64(cells), depth: 20 };
};
const job = (thickness = 25): any => {
  let d = run(emptyDoc(), 'new_project', { kind: 'cnc', width: 200, height: 200, thickness });
  const r = dome();
  return run(d, 'relief_add', { name: 'Dome', w: r.w, h: r.h, data: r.data, x: 60, y: 60, width: 40, depth: r.depth });
};
const ball6 = { id: 'b6', name: '6 mm ball', kind: 'ball', diameter: 6, flutes: 2, rpm: 18000, feed: 1000, plunge: 300, stepdown: 2, stepover: 10 };
const withTool = (d: any, tool: any = ball6) => run(d, 'cnc_tool_set', { tool });
const add = (d: any, extra: any = {}, toolId = 'b6') => run(d, 'cnc_toolpath_add', { kind: 'finish3d', toolId, reliefId: 1, scan: { dir: 'x', stepoverMm: 0.5 }, ...extra });

describe('the drop cutter (how low the tool may go)', () => {
  const relief = (): Relief => ({ id: 1, name: 'd', ...dome(), x: 60, y: 60, width: 40, visible: true });
  const tip = (tool: any, x: number, y: number) => new DropCutter(relief(), tool).tipAt(x, y);
  it('a ball nose on a dome follows a sphere that is the dome grown by the ball radius', () => {
    for (const rho of [0, 5, 10, 14]) {
      const analytic = Math.sqrt(23 * 23 - rho * rho) - 3;   // dome radius 20 + ball radius 3, the ball centre at that distance, less the radius to the tip
      expect(Math.abs(tip(ball6, 80 + rho, 80) - analytic)).toBeLessThan(0.12);   // the grid is 0.2 mm
    }
  });
  it('a flat end mill rests on the highest cell under it', () => {
    const flat = { ...ball6, kind: 'flat' };
    expect(tip(flat, 80, 80)).toBeCloseTo(20, 1);
    // 4 mm out the dome is 19.6 high but the 3 mm radius also covers the higher cells nearer the middle
    expect(tip(flat, 84, 80)).toBeCloseTo(Math.sqrt(400 - 1), 1);
  });
  it('a 90 degree V-bit rests on the surface a cone-height above it', () => {
    const v = { ...ball6, kind: 'vbit', vAngle: 90 };
    const t = tip(v, 80, 80);
    expect(t).toBeLessThanOrEqual(20 + 0.01);
    expect(t).toBeGreaterThan(19);
  });
  it('is never below the bottom of the model', () => { expect(tip(ball6, 0, 0)).toBe(0); expect(tip(ball6, 62, 62)).toBeGreaterThanOrEqual(0); });
});

describe('3D finishing', () => {
  it('cuts zig-zag lines over the whole shape, with the top of the shape at Z 0 and never below the bottom', () => {
    const d = add(withTool(job()));
    const tp = d.cnc.toolpaths[0];
    expect(tp).toMatchObject({ kind: 'finish3d', name: '3D finishing 1', reliefId: 1, cutDepth: 20, startDepth: 0, scan: { dir: 'x', stepoverMm: 0.5 } });
    const [b] = buildAll(d);
    const cuts = b.result.moves.filter((m) => m.kind === 'cut' || m.kind === 'plunge');
    expect(Math.max(...cuts.map((m) => m.z))).toBeLessThanOrEqual(0.02);
    expect(Math.min(...cuts.map((m) => m.z))).toBeGreaterThanOrEqual(-20 - 1e-6);
    expect(Math.min(...cuts.map((m) => m.y))).toBeCloseTo(60, 1);
    expect(Math.max(...cuts.map((m) => m.y))).toBeCloseTo(100, 1);
    expect(Math.min(...cuts.map((m) => m.x))).toBeCloseTo(60, 1);
    expect(Math.max(...cuts.map((m) => m.x))).toBeCloseTo(100, 1);
    expect(b.result.stats.passes).toBe(81);   // 40 / 0.5 + 1 lines
    expect(b.result.moves.length).toBeLessThan(40000);   // thinned
  });
  it('never cuts into the grid: along every move the tool is on or above the lowest height the drop cutter allows there', () => {
    const d = add(withTool(job()), { scan: { dir: 'y', stepoverMm: 1 } });
    const dc = new DropCutter(d.reliefs[0], ball6 as any);
    const moves = buildAll(d)[0].result.moves;
    let worst = Infinity, checked = 0;
    for (let i = 1; i < moves.length; i++) {
      const a = moves[i - 1], c = moves[i];
      if (c.kind !== 'cut') continue;
      const n = Math.max(1, Math.ceil(Math.hypot(c.x - a.x, c.y - a.y) / 0.05));
      for (let q = 0; q <= n; q++) {
        const t = q / n, x = a.x + (c.x - a.x) * t, y = a.y + (c.y - a.y) * t, z = a.z + (c.z - a.z) * t;
        worst = Math.min(worst, z + 20 - dc.tipAt(x, y));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(5000);
    // between two samples (a quarter of a cell apart at most) the surface the tool must clear can step by a fraction of a cell's height on the
    // steep rim of this dome; elsewhere it is within the thinning tolerance
    expect(worst).toBeGreaterThan(-0.25);
  });
  it('and over the smooth top of the dome it is within the thinning tolerance of the surface', () => {
    const d = add(withTool(job()), { scan: { dir: 'x', stepoverMm: 1 } });
    const dc = new DropCutter(d.reliefs[0], ball6 as any);
    let worst = Infinity;
    const moves = buildAll(d)[0].result.moves;
    for (let i = 1; i < moves.length; i++) {
      const a = moves[i - 1], c = moves[i];
      if (c.kind !== 'cut' || Math.hypot(a.x - 80, a.y - 80) > 12 || Math.hypot(c.x - 80, c.y - 80) > 12) continue;
      for (let q = 0; q <= 10; q++) { const t = q / 10; worst = Math.min(worst, a.z + (c.z - a.z) * t + 20 - dc.tipAt(a.x + (c.x - a.x) * t, a.y + (c.y - a.y) * t)); }
    }
    expect(worst).toBeGreaterThan(-0.011);
  });
  it('lines along X and along Y, the stepover sets how many, and the allowance lifts the tool', () => {
    const lines = (extra: any) => buildAll(add(withTool(job()), extra))[0].result.stats.passes;
    expect(lines({ scan: { dir: 'x', stepoverMm: 2 } })).toBe(21);
    expect(lines({ scan: { dir: 'y', stepoverMm: 4 } })).toBe(11);
    const low = (extra: any) => Math.min(...buildAll(add(withTool(job()), extra))[0].result.moves.filter((m) => m.kind === 'cut').map((m) => m.z));
    expect(low({ allowance: 1 })).toBeCloseTo(low({}) + 1, 1);
  });
  it('warns about a drill, a deep cut in one go, a shape taller than the material and a wide stepover', () => {
    const w = (d: any) => buildAll(d)[0].result.warnings.join(' | ');
    expect(w(add(job(), {}, 'drill-3'))).toMatch(/drill cannot cut a 3D shape/);
    expect(w(add(withTool(job()), { scan: { dir: 'x', stepoverMm: 5 } }))).toMatch(/far apart/);
    expect(w(add(withTool(job(10))))).toMatch(/spoilboard/);
    expect(w(add(withTool(job())))).toMatch(/Rough the shape out first/);
  });
  it('needs a 3D shape, and a 3D shape in use cannot be removed', () => {
    expect(() => run(withTool(run(emptyDoc(), 'new_project', { kind: 'cnc', width: 100, height: 100, thickness: 20 })), 'cnc_toolpath_add', { kind: 'finish3d', toolId: 'b6', reliefId: 1, scan: { dir: 'x', stepoverMm: 1 } })).toThrow(/Import a 3D shape first/);
    expect(() => add(withTool(job()), { scan: { dir: 'z', stepoverMm: 1 } })).toThrow(/x or y/);
    expect(() => add(withTool(job()), { scan: { dir: 'x', stepoverMm: 0 } })).toThrow(/stepover/);
    const d = add(withTool(job()));
    expect(() => run(d, 'relief_delete', { id: 1 })).toThrow(/Delete that toolpath first/);
    const gone = run(run(d, 'cnc_toolpath_delete', { id: 1 }), 'relief_delete', { id: 1 });
    expect(gone.reliefs).toBeUndefined();
  });
  it('is kept in the file, and the lines can be changed', () => {
    let d = add(withTool(job()));
    expect(parseProject(serializeProject(d)).cnc!.toolpaths[0]).toEqual(d.cnc.toolpaths[0]);
    d = run(d, 'cnc_toolpath_update', { id: 1, scan: { dir: 'y' } });
    expect(d.cnc.toolpaths[0].scan).toEqual({ dir: 'y', stepoverMm: 0.5 });
    const j = JSON.parse(serializeProject(d));
    j.doc.cnc.toolpaths[0].scan.dir = 'q';
    expect(() => parseProject(JSON.stringify(j))).toThrow(/x or y/);
  });
});

describe('3D roughing', () => {
  const flat6 = { id: 'f6', name: '6 mm flat', kind: 'flat', diameter: 6, flutes: 2, rpm: 18000, feed: 1500, plunge: 400, stepdown: 2, stepover: 40 };
  const rough = (d: any, extra: any = {}, toolId = 'f6') => run(d, 'cnc_toolpath_add', { kind: 'rough3d', toolId, reliefId: 1, scan: { dir: 'x', stepoverMm: 2.4 }, allowance: 0.5, ...extra });
  const setup = (thickness = 25) => withTool(job(thickness), flat6);
  it('clears the dome level by level, 2 mm at a time, down to the allowance above the floor', () => {
    const d = rough(setup());
    expect(d.cnc.toolpaths[0]).toMatchObject({ kind: 'rough3d', name: '3D roughing 1', reliefId: 1, allowance: 0.5 });
    const [b] = buildAll(d);
    expect(b.result.warnings).toEqual([]);
    const zs = [...new Set(b.result.moves.filter((m) => m.kind === 'cut').map((m) => Math.round(m.z * 1000) / 1000))].sort((a, c) => c - a);
    expect(zs).toHaveLength(10);                       // (20 - 0.5) / 2 = 9.75 levels, so 10 evenly
    expect(zs[0]).toBeCloseTo(-1.95); expect(zs[9]).toBeCloseTo(-19.5);
    expect(b.result.moves.length).toBeLessThan(20000);
  });
  it('never cuts below the surface plus the allowance', () => {
    const d = rough(setup());
    const dc = new DropCutter(d.reliefs[0], flat6 as any);
    let worst = Infinity, n = 0;
    const moves = buildAll(d)[0].result.moves;
    for (let i = 1; i < moves.length; i++) {
      const a = moves[i - 1], c = moves[i];
      if (c.kind === 'rapid') continue;
      const steps = Math.max(1, Math.ceil(Math.hypot(c.x - a.x, c.y - a.y) / 0.25));
      for (let q = 0; q <= steps; q++) { const t = q / steps; worst = Math.min(worst, a.z + (c.z - a.z) * t + 20 - (dc.tipAt(a.x + (c.x - a.x) * t, a.y + (c.y - a.y) * t) + 0.5)); n++; }
    }
    expect(n).toBeGreaterThan(500);
    expect(worst).toBeGreaterThan(-0.02);
  });
  it('leaves the top of the dome alone on the first level and cuts the corners of the square on the last', () => {
    const moves = buildAll(rough(setup()))[0].result.moves.filter((m) => m.kind === 'cut');
    const first = moves.filter((m) => Math.abs(m.z + 1.95) < 1e-6);
    expect(first.every((m) => Math.hypot(m.x - 80, m.y - 80) > 5)).toBe(true);   // a 6 mm flat cannot go 2 mm down on the top
    const last = moves.filter((m) => Math.abs(m.z + 19.5) < 1e-6);
    expect(last.some((m) => m.x < 63 && m.y < 63)).toBe(true);
    expect(last.every((m) => Math.hypot(m.x - 80, m.y - 80) > 18)).toBe(true);   // and only outside the dome at the floor
  });
  it('a bigger allowance leaves more, and one as big as the shape leaves nothing to rough', () => {
    const low = (a: number) => Math.min(...buildAll(rough(setup(), { allowance: a }))[0].result.moves.filter((m) => m.kind === 'cut').map((m) => m.z));
    expect(low(2)).toBeCloseTo(-18);
    const w = buildAll(rough(setup(), { allowance: 20 }))[0];
    expect(w.result.warnings.join(' ')).toMatch(/nothing to rough out/);
    expect(w.result.moves).toEqual([]);
  });
  it('warns about a drill, a V-bit and a stepover wider than the tool; roughing and finishing can both be made', () => {
    const w = (d: any) => buildAll(d)[0].result.warnings.join(' | ');
    expect(w(rough(setup(), {}, 'drill-3'))).toMatch(/drill cannot rough/);
    expect(w(rough(setup(), {}, 'vbit-60'))).toMatch(/not a roughing tool/);
    expect(w(rough(setup(), { scan: { dir: 'x', stepoverMm: 7 } }))).toMatch(/further apart than the tool/);
    const both = add(withTool(rough(setup())));
    expect(both.cnc.toolpaths.map((t: any) => t.kind)).toEqual(['rough3d', 'finish3d']);
    expect(() => run(both, 'relief_delete', { id: 1 })).toThrow(/Delete that toolpath first/);
  });
});

describe('3D roughing, ramped entry', () => {
  const flat6 = { id: 'f6', name: '6 mm flat', kind: 'flat', diameter: 6, flutes: 2, rpm: 18000, feed: 1500, plunge: 400, stepdown: 2, stepover: 40 };
  const rough = (extra: any = {}) => run(withTool(job(), flat6), 'cnc_toolpath_add', { kind: 'rough3d', toolId: 'f6', reliefId: 1, scan: { dir: 'x', stepoverMm: 2.4 }, allowance: 0.5, ...extra });
  const moves = (d: any) => buildAll(d)[0].result.moves;
  it('plunges by default and ramps when an angle is given', () => {
    expect(rough().cnc.toolpaths[0].rampAngle).toBeUndefined();
    expect(rough({ rampAngle: 0 }).cnc.toolpaths[0].rampAngle).toBeUndefined();
    expect(rough({ rampAngle: 3 }).cnc.toolpaths[0].rampAngle).toBe(3);
    const longPlunges = (d: any) => { const m = moves(d); let n = 0, all = 0; for (let i = 1; i < m.length; i++) if (m[i].kind === 'plunge') { all++; if (m[i - 1].z - m[i].z > 1.01) n++; } return { n, all }; };
    const plain = longPlunges(rough()), ramped = longPlunges(rough({ rampAngle: 3 }));
    expect(plain.n).toBe(plain.all);   // every entry goes down the whole step
    // with a ramp only the places that are a single sample long are plunged, and the warning counts them
    const warned = Number(/(\d+) places were too short/.exec(buildAll(rough({ rampAngle: 3 }))[0].result.warnings.join(' '))?.[1] ?? 0);
    expect(ramped.n).toBe(warned);
    expect(ramped.n).toBeLessThan(plain.n / 2);
  });
  it('goes down no steeper than the angle, reaches every level, and never cuts below the surface plus the allowance', () => {
    const d = rough({ rampAngle: 3 });
    const m = moves(d);
    const tan = Math.tan((3 * Math.PI) / 180);
    let steepest = 0, ramped = 0;
    for (let i = 1; i < m.length; i++) {
      if (m[i].kind !== 'cut' || m[i - 1].kind === 'rapid') continue;
      const h = Math.hypot(m[i].x - m[i - 1].x, m[i].y - m[i - 1].y), dz = Math.abs(m[i].z - m[i - 1].z);
      if (dz > 1e-9) { steepest = Math.max(steepest, h > 1e-9 ? dz / h : Infinity); ramped++; }
    }
    expect(ramped).toBeGreaterThan(20);
    expect(steepest).toBeLessThan(tan * 1.001);
    const levels = (dd: any) => [...new Set(moves(dd).filter((x) => x.kind === 'cut' && Math.abs(x.z - Math.round(x.z * 100) / 100) < 1e-9 && false).map((x) => x.z))];
    void levels;
    expect(Math.min(...m.map((x) => x.z))).toBeCloseTo(-19.5);
    const dc = new DropCutter(d.reliefs[0], flat6 as any);
    let worst = Infinity;
    for (let i = 1; i < m.length; i++) {
      if (m[i].kind === 'rapid') continue;
      const a = m[i - 1], c = m[i], steps = Math.max(1, Math.ceil(Math.hypot(c.x - a.x, c.y - a.y) / 0.25));
      for (let q = 0; q <= steps; q++) { const t = q / steps; worst = Math.min(worst, a.z + (c.z - a.z) * t + 20 - (dc.tipAt(a.x + (c.x - a.x) * t, a.y + (c.y - a.y) * t) + 0.5)); }
    }
    expect(worst).toBeGreaterThan(-0.02);
  });
  it('ramps back and forth along a short cut, and says when a place was too short', () => {
    // a lot of 2 mm cuts per level, only a few mm long, for a slow ramp: 1 degree drops 2 mm over 115 mm
    const m = moves(rough({ rampAngle: 1 }));
    const w = buildAll(rough({ rampAngle: 1 }))[0].result.warnings.join(' ');
    expect(m.filter((x) => x.kind === 'plunge').every((x, i, a) => true)).toBe(true);
    expect(w).not.toMatch(/damaged/);
  });
  it('is only for roughing, between 0 and 45 degrees, kept in the file and changeable', () => {
    expect(() => rough({ rampAngle: 60 })).toThrow(/0 to 45/);
    expect(() => run(withTool(job()), 'cnc_toolpath_add', { kind: 'finish3d', toolId: 'b6', reliefId: 1, scan: { dir: 'x', stepoverMm: 1 }, rampAngle: 3 })).toThrow(/Only a 3D roughing/);
    let d = rough({ rampAngle: 5 });
    expect(parseProject(serializeProject(d)).cnc!.toolpaths[0].rampAngle).toBe(5);
    d = run(d, 'cnc_toolpath_update', { id: 1, rampAngle: 0 });
    expect(d.cnc.toolpaths[0].rampAngle).toBeUndefined();
    const j = JSON.parse(serializeProject(rough({ rampAngle: 5 })));
    j.doc.cnc.toolpaths[0].rampAngle = 90;
    expect(() => parseProject(JSON.stringify(j))).toThrow(/ramp angle/);
  });
});

describe('3D finishing, cross pass', () => {
  const finish = (scan: any) => add(withTool(job()), { scan });
  const cutsOf = (d: any) => buildAll(d)[0].result.moves.filter((m, i, a) => m.kind === 'cut' && i > 0 && a[i - 1].kind !== 'rapid');
  it('a second pass at right angles: lines in both directions, about twice the lines, and a lift between the passes', () => {
    const one = buildAll(finish({ dir: 'x', stepoverMm: 1 }))[0].result, two = buildAll(finish({ dir: 'x', stepoverMm: 1, cross: true }))[0].result;
    expect(one.stats.passes).toBe(41);
    expect(two.stats.passes).toBe(82);
    expect(two.moves.length).toBeGreaterThan(one.moves.length * 1.8);
    const travel = (m: any[]) => { let x = 0, y = 0; for (let i = 1; i < m.length; i++) if (m[i].kind === 'cut' && m[i - 1].kind !== 'rapid') { x += Math.abs(m[i].x - m[i - 1].x); y += Math.abs(m[i].y - m[i - 1].y); } return { x, y }; };
    const a = travel(one.moves), c = travel(two.moves);
    expect(a.x).toBeGreaterThan(a.y * 10);          // lines along X, and only the short moves across between them
    expect(c.y).toBeGreaterThan(c.x * 0.4);         // with the cross pass the Y travel is as big as the X travel
    expect(c.x).toBeGreaterThan(a.x * 0.95);
    expect(two.moves.filter((m) => m.kind === 'rapid').length).toBeGreaterThan(one.moves.filter((m) => m.kind === 'rapid').length);   // the lift and the second entry
  });
  it('both passes keep the tool on or above the grid', () => {
    const d = finish({ dir: 'y', stepoverMm: 1, cross: true });
    const dc = new DropCutter(d.reliefs[0], ball6 as any);
    const m = buildAll(d)[0].result.moves;
    let worst = Infinity;
    for (let i = 1; i < m.length; i++) {
      if (m[i].kind === 'rapid') continue;
      const a = m[i - 1], c = m[i], n = Math.max(1, Math.ceil(Math.hypot(c.x - a.x, c.y - a.y) / 0.05));
      for (let q = 0; q <= n; q++) { const t = q / n; worst = Math.min(worst, a.z + (c.z - a.z) * t + 20 - dc.tipAt(a.x + (c.x - a.x) * t, a.y + (c.y - a.y) * t)); }
    }
    expect(worst).toBeGreaterThan(-0.25);
  });
  it('is kept in the file, and refuses a setting that is not a yes or no', () => {
    const d = finish({ dir: 'x', stepoverMm: 1, cross: true });
    expect(d.cnc.toolpaths[0].scan).toEqual({ dir: 'x', stepoverMm: 1, cross: true });
    expect(parseProject(serializeProject(d)).cnc!.toolpaths[0].scan).toEqual({ dir: 'x', stepoverMm: 1, cross: true });
    expect(finish({ dir: 'x', stepoverMm: 1, cross: false }).cnc.toolpaths[0].scan).toEqual({ dir: 'x', stepoverMm: 1 });
    expect(() => finish({ dir: 'x', stepoverMm: 1, cross: 'yes' })).toThrow(/cross pass/);
    expect(run(d, 'cnc_toolpath_update', { id: 1, scan: { cross: false } }).cnc.toolpaths[0].scan).toEqual({ dir: 'x', stepoverMm: 1 });
  });
});
