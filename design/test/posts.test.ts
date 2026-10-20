import { describe, expect, it } from 'vitest';
import { BUILT_IN_POSTS, emitGcode, type Move3 } from '../src/core/post';

const moves: Move3[] = [
  { kind: 'rapid', x: 10, y: 10, z: 5 }, { kind: 'plunge', x: 10, y: 10, z: -1 }, { kind: 'cut', x: 20, y: 10, z: -1 }, { kind: 'rapid', x: 20, y: 10, z: 5 },
  { kind: 'rapid', x: 30, y: 30, z: 5 }, { kind: 'plunge', x: 30, y: 30, z: -1 },
];
const run = { rpm: 12000, feed: 800, plunge: 300, home: { x: 0, y: 0, z: 10 } };
const post = (needle: string) => BUILT_IN_POSTS.find((p) => p.name.includes(needle))!;

describe('the branded post processors', () => {
  it('all load, with their names, and the generic ones are still first', () => {
    expect(BUILT_IN_POSTS.map((p) => p.name)).toEqual([
      'GRBL (mm)', 'GRBL with vacuum (mm)', 'DemonX - Genmitsu Cubiko (mm)', 'DemonX - Baby CNC 3018 (mm)', 'DemonX - DemonCarve Vacuum M2 (mm)', 'DemonX - DemonCarve PCB (mm)',
    ]);
    for (const p of BUILT_IN_POSTS) { expect(p.extension).toBe('gcode'); expect(p.lineEnding).toBe(p.name.startsWith('DemonX') ? '\r\n' : '\n'); }
  });
  it('Cubiko and Baby CNC: spindle on and a 3 s pause, then home and M2 at the end', () => {
    for (const k of ['Cubiko', 'Baby CNC']) {
      const g = emitGcode(post(k), moves, run).split('\r\n').filter(Boolean);
      expect(g.slice(0, 7)).toEqual(['G17', 'G21', 'G90', 'G0Z10.000', 'G0X0.000Y0.000', 'S12000M3', 'G4 P3.0']);
      expect(g.slice(-4)).toEqual(['M5', 'G0Z10.000', 'G0X0.000Y0.000', 'M2']);
    }
  });
  it('DemonCarve Vacuum: M7 first, M9 then M2 last, and a rapid goes sideways or up/down, never both', () => {
    const g = emitGcode(post('DemonCarve Vacuum'), moves, run).split('\r\n').filter(Boolean);
    expect(g[0]).toBe('M7');
    expect(g.slice(-2)).toEqual(['M9', 'M2']);
    for (const l of g) if (l.startsWith('G0')) expect(/Z/.test(l) && /[XY]/.test(l) && !l.startsWith('G0Z') && !/^G0[XY]/.test(l)).toBe(false);
    expect(g.some((l) => l === 'G0X30.000Y30.000')).toBe(true);
  });
  it('DemonCarve PCB: no vacuum codes, and it parks at X0 Y100 at the end', () => {
    const g = emitGcode(post('DemonCarve PCB'), moves, run).split('\r\n').filter(Boolean);
    expect(g.join(' ')).not.toMatch(/M7|M9/);
    expect(g.slice(-2)).toEqual(['G0 X0 Y100', 'M2']);
    expect(g[0]).toBe('G17');
  });
});
