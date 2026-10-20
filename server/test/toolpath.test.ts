import { describe, it, expect } from 'vitest';
import { analyzeProgram } from '../../shared/toolpath.js';

const A = (lines: string[], path = true) => analyzeProgram(lines, { path });

describe('analyzeProgram extents', () => {
  it('measures the cutting depth from the surface, not from the first plunge', () => {
    const e = A(['G0 X0 Y0 Z5', 'G0 Z0', 'G1 Z-3 F300', 'G1 X10', 'G1 Z-10.5', 'G1 X0']).extents;
    expect(e.cut).toMatchObject({ minZ: -10.5, maxZ: 0 });
    expect(e.all).toMatchObject({ minZ: -10.5, maxZ: 5 });   // rapids still reported as they are
    // a program that never cuts below Z0 keeps its real range
    expect(A(['G0 X0 Y0 Z5', 'G1 Z2', 'G1 X10']).extents.cut).toMatchObject({ minZ: 2, maxZ: 2 });
  });

  it('separates cutting moves from rapids, so a park move does not inflate the part size', () => {
    const e = A(['G21 G90', 'G0 Z5', 'G0 X10 Y10', 'G1 Z-0.1 F100', 'G1 X30 Y20', 'G0 Z5', 'G0 X400 Y400']).extents;
    expect(e.cut).toEqual({ minX: 10, maxX: 30, minY: 10, maxY: 20, minZ: -0.1, maxZ: 0 }); // cutting below Z0: the range starts at the surface
    expect(e.all).toEqual({ minX: 0, maxX: 400, minY: 0, maxY: 400, minZ: -0.1, maxZ: 5 });
  });

  it('shows a stray rapid Z in the all-moves box', () => {
    const e = A(['G0 X1 Y1 Z-40', 'G1 X5 Y5 Z-0.1']).extents;
    expect(e.all!.minZ).toBe(-40);
    expect(e.cut!.minZ).toBe(-0.1);
  });

  it('understands relative mode and inches', () => {
    expect(A(['G91', 'G1 X10 Y5', 'G1 X10 Y5', 'G1 Z-1']).extents.cut).toMatchObject({ maxX: 20, maxY: 10, minZ: -1 });
    expect(A(['G20', 'G90', 'G1 X1 Y2 Z-0.1']).extents.cut).toMatchObject({ maxX: 25.4, maxY: 50.8, minZ: -2.54 });
  });

  it('includes the reach of arcs, not only their end points', () => {
    // CCW half circle radius 10 about (20,15) from (10,15) to (30,15): bulges down to y=5
    const e = A(['G0 X10 Y15 Z0', 'G3 X30 Y15 I10 J0']).extents.cut!;
    expect(e.minY).toBeLessThan(5.1);
    expect(e.maxX).toBeCloseTo(30, 6);
    // CW goes over the top instead
    expect(A(['G0 X10 Y15 Z0', 'G2 X30 Y15 I10 J0']).extents.cut!.maxY).toBeGreaterThan(24.9);
  });

  it('handles radius-format arcs and full circles', () => {
    const half = A(['G0 X10 Y15 Z0', 'G3 X30 Y15 R10']).extents.cut!;
    expect(half.minY).toBeLessThan(5.1); // same arc as the I/J version
    const full = A(['G0 X10 Y15 Z0', 'G2 X10 Y15 I5 J0']).extents.cut!;
    expect(full.maxX).toBeCloseTo(20, 1);
  });

  it('copes with comments, line numbers, no spaces and empty programs', () => {
    expect(A(['(hi)', 'N10 G1X5Y5Z-1 ; cut', '']).extents.cut).toMatchObject({ maxX: 5, minZ: -1 });
    expect(A([]).extents).toEqual({});
    expect(A(['M3 S1000', 'G4 P1']).extents).toEqual({});
  });
});

describe('analyzeProgram toolpath', () => {
  it('records segments with start and end, tagged by the source line', () => {
    const t = A(['G0 X0 Y0 Z5', 'G1 Z-1', 'G1 X10']);
    expect(Array.from(t.rapid)).toEqual([0, 0, 0, 0, 0, 5]);
    expect(Array.from(t.cut)).toEqual([0, 0, 5, 0, 0, -1, 0, 0, -1, 10, 0, -1]);
    expect(Array.from(t.cutLine)).toEqual([1, 2]);
    expect(Array.from(t.rapidLine)).toEqual([0]);
  });

  it('skips building the path when only extents are wanted, with the same extents', () => {
    const prog = ['G0 Z5', 'G1 X3 Y4 Z-1'];
    const withPath = A(prog, true), without = A(prog, false);
    expect(without.cut.length).toBe(0);
    expect(without.extents).toEqual(withPath.extents);
  });

  it('keeps line indices non-decreasing so progress can be drawn by range', () => {
    const lines = ['G0 X0 Y0 Z1', 'G1 X10 Y0 Z0', 'G3 X0 Y0 I-5 J0', 'G1 X0 Y10'];
    const t = A(lines);
    for (let i = 1; i < t.cutLine.length; i++) expect(t.cutLine[i]).toBeGreaterThanOrEqual(t.cutLine[i - 1]);
    expect(t.cutLine.length).toBeGreaterThan(10); // the arc was split
  });
});
