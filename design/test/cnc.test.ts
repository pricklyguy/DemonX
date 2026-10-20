import { describe, expect, it } from 'vitest';
import { emptyDoc } from '../src/core/types';
import type { Doc, Pt } from '../src/core/types';
import { execute, CommandError } from '../src/core/commands';
import { buildToolpath, depthLevels } from '../src/core/cam';
import { cncOf } from '../src/core/cncjob';
import { BUILT_IN_POSTS, GRBL_POST, emitGcode, parsePost, PostError } from '../src/core/post';
import { parseProject, serializeProject } from '../src/core/project';

const area = (r: Pt[]) => { let a = 0; for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; };
const cncDoc = () => execute(emptyDoc(), 'workspace_set', { kind: 'cnc', width: 600, height: 400, thickness: 18 }).doc;
const rect = (d: Doc, x: number, y: number, w: number, h: number) => execute(d, 'add_rect', { x, y, w, h, layer: 'Layer 1' }).doc;
const circle = (d: Doc, cx: number, cy: number, r: number) => execute(d, 'add_circle', { cx, cy, r, layer: 'Layer 1' }).doc;
const addTp = (d: Doc, args: any) => execute(d, 'cnc_toolpath_add', { toolId: 'flat-6', cutDepth: 6, ...args }).doc;
const run = (d: Doc, i = 0) => { const tp = cncOf(d).toolpaths[i]; return buildToolpath(d, tp, cncOf(d).tools.find((t) => t.id === tp.toolId)!); };
/** the closed loops the tool follows at the final depth, as point lists */
function loopsAtDepth(moves: { kind: string; x: number; y: number; z: number }[], z: number): Pt[][] {
  const loops: Pt[][] = [];
  let cur: Pt[] = [];
  for (const m of moves) {
    if (m.kind === 'rapid') { if (cur.length) loops.push(cur); cur = []; continue; }
    if (Math.abs(m.z - z) < 1e-9) cur.push([m.x, m.y]);
    else if (cur.length) { loops.push(cur); cur = []; }
  }
  if (cur.length) loops.push(cur);
  return loops;
}

describe('depth levels', () => {
  it('splits into equal passes no deeper than the stepdown', () => {
    expect(depthLevels(0, 6, 2)).toEqual([2, 4, 6]);
    expect(depthLevels(0, 5, 2).map((v) => Math.round(v * 1e6) / 1e6)).toEqual([1.666667, 3.333333, 5]);
    expect(depthLevels(1, 3, 5)).toEqual([3]);
    expect(depthLevels(3, 3, 1)).toEqual([]);
  });
});

describe('profile', () => {
  it('outside a rectangle: a tool radius out, down to the cut depth, in equal passes', () => {
    const d = addTp(rect(cncDoc(), 10, 10, 40, 30), { kind: 'profile', ids: [1], side: 'outside' });
    const r = run(d);
    const loops = loopsAtDepth(r.moves, -6);
    expect(loops).toHaveLength(1);
    const xs = loops[0].map((p) => p[0]), ys = loops[0].map((p) => p[1]);
    expect(Math.min(...xs)).toBeCloseTo(7, 3);
    expect(Math.max(...xs)).toBeCloseTo(53, 3);
    expect(Math.min(...ys)).toBeCloseTo(7, 3);
    expect(Math.max(...ys)).toBeCloseTo(43, 3);
    expect(r.stats.passes).toBe(3);
    const zs = new Set(r.moves.filter((m) => m.kind !== 'rapid').map((m) => Math.round(m.z * 1000) / 1000));
    expect([...zs].sort((a, b) => b - a)).toEqual([-2, -4, -6]);
    expect(Math.max(...r.moves.map((m) => m.z))).toBe(5);
  });
  it('inside a rectangle goes a radius in; allowance leaves material', () => {
    const d = addTp(rect(cncDoc(), 10, 10, 40, 30), { kind: 'profile', ids: [1], side: 'inside', allowance: 0.5 });
    const loop = loopsAtDepth(run(d).moves, -6)[0];
    expect(Math.min(...loop.map((p) => p[0]))).toBeCloseTo(13.5, 3);
    expect(Math.max(...loop.map((p) => p[0]))).toBeCloseTo(46.5, 3);
  });
  it('climb and conventional run opposite ways round', () => {
    const out = (dir: string, side: string) => { const d = addTp(rect(cncDoc(), 10, 10, 40, 30), { kind: 'profile', ids: [1], side, direction: dir }); return area(loopsAtDepth(run(d).moves, -6)[0]); };
    expect(out('climb', 'outside')).toBeGreaterThan(0);          // counter-clockwise round a part
    expect(out('conventional', 'outside')).toBeLessThan(0);
    expect(out('climb', 'inside')).toBeLessThan(0);              // clockwise inside a pocket wall
    expect(out('conventional', 'inside')).toBeGreaterThan(0);
  });
  it('outside a part with a hole leaves the hole to be cut from inside, smallest first', () => {
    let d = rect(cncDoc(), 0, 0, 60, 40);
    d = circle(d, 30, 20, 8);
    d = addTp(d, { kind: 'profile', ids: [1, 2], side: 'inside' });
    const loops = loopsAtDepth(run(d).moves, -6);
    expect(loops).toHaveLength(2);
    const w = (l: Pt[]) => Math.max(...l.map((p) => p[0])) - Math.min(...l.map((p) => p[0]));
    expect(w(loops[0])).toBeLessThan(w(loops[1])); // the hole first, then the outline
    expect(w(loops[0])).toBeCloseTo(10, 1);        // 16 mm hole, 6 mm tool
  });
  it('on the line follows the shape itself, open lines included', () => {
    const d = execute(cncDoc(), 'add_path', { points: [[0, 0], [20, 0], [20, 10]], closed: false, layer: 'Layer 1' }).doc;
    const r = run(addTp(d, { kind: 'profile', ids: [1], side: 'on' }));
    expect(loopsAtDepth(r.moves, -2)[0]).toEqual([[0, 0], [20, 0], [20, 10]]);
  });
  it('says so when a shape is too small for the tool', () => {
    const d = addTp(circle(cncDoc(), 0, 0, 2), { kind: 'profile', ids: [1], side: 'inside' });
    expect(run(d).warnings.join(' ')).toMatch(/too small/);
  });
  it('uses Z from the bed when that is the zero', () => {
    const d = execute(emptyDoc(), 'workspace_set', { kind: 'cnc', width: 600, height: 400, thickness: 18, zZero: 'bed' }).doc;
    const r = run(addTp(rect(d, 10, 10, 40, 30), { kind: 'profile', ids: [1], side: 'outside' }));
    expect(Math.min(...r.moves.map((m) => m.z))).toBeCloseTo(12, 6);
    expect(Math.max(...r.moves.map((m) => m.z))).toBeCloseTo(23, 6);
  });
  it('warns when the cut goes deeper than the material', () => {
    const d = addTp(rect(cncDoc(), 10, 10, 40, 30), { kind: 'profile', ids: [1], side: 'outside', cutDepth: 20 });
    expect(run(d).warnings.join(' ')).toMatch(/spoilboard/);
  });
});

describe('pocket', () => {
  const dist2seg = (p: Pt, a: Pt, b: Pt) => { const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy; const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0; return Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]); };
  it('clears the whole rectangle and never goes through the wall', () => {
    const d = addTp(rect(cncDoc(), 0, 0, 40, 30), { kind: 'pocket', ids: [1], cutDepth: 2 });
    const loops = loopsAtDepth(run(d).moves, -2);
    expect(loops.length).toBeGreaterThan(2);
    for (const l of loops) for (const p of l) { expect(p[0]).toBeGreaterThan(3 - 1e-6); expect(p[0]).toBeLessThan(37 + 1e-6); expect(p[1]).toBeGreaterThan(3 - 1e-6); expect(p[1]).toBeLessThan(27 + 1e-6); }
    let worst = 0;
    // the tool cannot reach into the corners (they stay rounded by its radius), so only points it can reach count
    const reach = (x: number, y: number) => Math.hypot(Math.max(3 - x, 0, x - 37), Math.max(3 - y, 0, y - 27)) <= 3;
    for (let x = 0.5; x < 40; x += 1) for (let y = 0.5; y < 30; y += 1) {
      if (!reach(x, y)) continue;
      let best = Infinity;
      for (const l of loops) for (let i = 0; i < l.length; i++) best = Math.min(best, dist2seg([x, y], l[i], l[(i + 1) % l.length]));
      worst = Math.max(worst, best);
    }
    expect(worst).toBeLessThanOrEqual(3 + 1e-6); // every point is within the tool radius of the path
  });
  it('leaves an island standing', () => {
    let d = rect(cncDoc(), 0, 0, 60, 40);
    d = circle(d, 30, 20, 6);
    // a rectangle with a hole in it, made by subtracting the circle
    d = execute(d, 'boolean', { op: 'difference', ids: [1, 2] }).doc;
    d = addTp(d, { kind: 'pocket', ids: [d.shapes[0].id], cutDepth: 2 });
    for (const l of loopsAtDepth(run(d).moves, -2)) for (const p of l) expect(Math.hypot(p[0] - 30, p[1] - 20)).toBeGreaterThan(6 + 3 - 0.03);
  });
});

describe('drill', () => {
  it('goes down in pecks at the middle of each shape', () => {
    const d = addTp(circle(cncDoc(), 20, 15, 1.5), { kind: 'drill', ids: [1], toolId: 'drill-3', cutDepth: 9 });
    const r = run(d);
    const downs = r.moves.filter((m) => m.kind === 'plunge').map((m) => m.z);
    expect(downs).toEqual([-3, -6, -9]);
    expect(r.moves.every((m) => m.x === 20 && m.y === 15)).toBe(true);
  });
});

describe('post processors', () => {
  it('writes modal G-code: coordinates only when they change, F when the speed changes', () => {
    const d = addTp(rect(cncDoc(), 10, 10, 40, 30), { kind: 'profile', ids: [1], side: 'outside', cutDepth: 2 });
    const files = execute(d, 'cnc_gcode', {}).data as any;
    const g: string = files.files[0].gcode;
    const lines = g.trim().split('\n').filter((l) => !l.startsWith('('));
    expect(lines.slice(0, 7)).toEqual(['G17', 'G21', 'G90', 'G0Z5.000', 'G0X0.000Y0.000', 'S16000M3', 'G4 P3']);
    expect(lines.at(-1)).toBe('M2');
    expect(g).toContain('G1Z-2.000F400.0');         // the plunge, at the plunge speed
    expect(g).toMatch(/G1X[\d.]+Y[\d.]+F1200\.0/);  // the first cutting move names the cutting speed
    expect(lines.some((l) => /^G1X\d/.test(l) && l.includes('Z'))).toBe(false);          // no Z repeated on flat moves
  });
  it('the vacuum post switches M7 on first and M9 off before the end', () => {
    const d = addTp(rect(cncDoc(), 10, 10, 40, 30), { kind: 'profile', ids: [1], cutDepth: 2 });
    const g = (execute(d, 'cnc_gcode', { post: 'GRBL with vacuum (mm)' }).data as any).files[0].gcode.trim().split('\n').filter((l: string) => !l.startsWith('('));
    expect(g[0]).toBe('M7');
    expect(g.slice(-2)).toEqual(['M9', 'M2']);
  });
  it('reads a post file of the usual layout, with always and changed-only variables', () => {
    const text = `+ a test post
POST_NAME = "Test (mm) (*.nc)"
FILE_EXTENSION = "nc"
UNITS = "MM"
LINE_ENDING = "[13][10]"
VAR SPINDLE_SPEED = [S|A|S|1.0]
VAR FEED_RATE = [F|C|F|1.1]
VAR X_POSITION = [X|A|X|1.2]
VAR Y_POSITION = [Y|C|Y|1.2]
VAR Z_POSITION = [Z|C|Z|1.2]
VAR X_HOME_POSITION = [XH|A|X|1.3]
VAR Y_HOME_POSITION = [YH|A|Y|1.3]
VAR Z_HOME_POSITION = [ZH|A|Z|1.3]
begin HEADER
  "G90"
  "[S]M3"
begin RAPID_MOVE
  "G0[X][Y][Z]"
begin FEED_MOVE
  "G1[X][Y][Z][F]"
begin FOOTER
  "M5"
  "M30"
`;
    const p = parsePost(text);
    expect(p.name).toBe('Test (mm)');
    expect(p.extension).toBe('nc');
    expect(p.lineEnding).toBe('\\r\\n'.replace('\\r\\n', '\r\n'));
    const out = emitGcode(p, [{ kind: 'rapid', x: 1, y: 2, z: 5 }, { kind: 'cut', x: 1, y: 3, z: 5 }], { rpm: 12000, feed: 500, plunge: 200, home: { x: 0, y: 0, z: 5 } });
    expect(out.split('\r\n')).toEqual(['G90', 'S12000M3', 'G0X1.00Y2.00Z5.00', 'G1X1.00Y3.00F500.0', 'M5', 'M30', '']);
  });
  it('refuses a file that is not a usable post, or not in millimetres', () => {
    expect(() => parsePost('hello')).toThrow(PostError);
    expect(() => parsePost(GRBL_POST.replace('UNITS = "MM"', 'UNITS = "INCHES"'))).toThrow(/millimetre/);
    expect(() => parsePost(GRBL_POST.replace('begin FOOTER', 'begin NOPE'))).toThrow(/FOOTER/);
    expect(BUILT_IN_POSTS.map((p) => p.name).slice(0, 2)).toEqual(['GRBL (mm)', 'GRBL with vacuum (mm)']);   // the generic ones first; the DemonX ones follow (posts.test.ts)
  });
});

describe('commands and files', () => {
  it('one file per tool, in toolpath order', () => {
    let d = rect(rect(cncDoc(), 0, 0, 40, 30), 100, 0, 20, 20);
    d = addTp(d, { kind: 'pocket', ids: [1], cutDepth: 2 });
    d = addTp(d, { kind: 'profile', ids: [2], toolId: 'flat-3', cutDepth: 4, side: 'outside' });
    d = addTp(d, { kind: 'profile', ids: [1], side: 'outside', cutDepth: 4, name: 'Outline' });
    const r = (execute(d, 'cnc_gcode', {}).data as any).files;
    expect(r).toHaveLength(2);
    expect(r[0].toolpaths).toEqual(['Pocket 1', 'Outline']);
    expect(r[1].tool).toBe('3.175 mm flat end mill');
  });
  it('validates what it is given', () => {
    const d = rect(cncDoc(), 0, 0, 10, 10);
    expect(() => execute(d, 'cnc_toolpath_add', { kind: 'profile', toolId: 'nope', ids: [1], cutDepth: 3 })).toThrow(/no tool/);
    expect(() => execute(d, 'cnc_toolpath_add', { kind: 'profile', toolId: 'flat-6', ids: [1], cutDepth: 3, startDepth: 3 })).toThrow(/start depth/);
    expect(() => execute(d, 'cnc_toolpath_add', { kind: 'carve', toolId: 'flat-6', ids: [1], cutDepth: 3 })).toThrow(/kind/);
    expect(() => execute(d, 'cnc_gcode', {})).toThrow(/nothing to write/);
    const withTp = addTp(d, { kind: 'profile', ids: [1] });
    expect(() => execute(withTp, 'cnc_tool_delete', { id: 'flat-6' })).toThrow(/uses this tool/);
    expect(() => execute(d, 'cnc_tool_set', { tool: { id: 'x', name: 'bad', kind: 'flat', diameter: -1, flutes: 2, rpm: 1, feed: 1, plunge: 1, stepdown: 1, stepover: 40 } })).toThrow(CommandError);
  });
  it('tools and toolpaths can be added, changed and removed', () => {
    let d = rect(cncDoc(), 0, 0, 10, 10);
    d = execute(d, 'cnc_tool_set', { tool: { id: 'mine', name: 'My 4 mm', kind: 'flat', diameter: 4, flutes: 2, rpm: 15000, feed: 1000, plunge: 300, stepdown: 1.5, stepover: 45 } }).doc;
    expect(cncOf(d).tools.some((t) => t.id === 'mine')).toBe(true);
    d = addTp(d, { kind: 'profile', ids: [1], toolId: 'mine' });
    d = execute(d, 'cnc_toolpath_update', { id: 1, cutDepth: 9, name: 'Cut out' }).doc;
    expect(cncOf(d).toolpaths[0]).toMatchObject({ cutDepth: 9, name: 'Cut out' });
    d = execute(d, 'cnc_toolpath_delete', { id: 1 }).doc;
    d = execute(d, 'cnc_tool_delete', { id: 'mine' }).doc;
    expect(cncOf(d).tools.some((t) => t.id === 'mine')).toBe(false);
  });
  it('survives saving and opening, and damaged CNC data is refused', () => {
    let d = rect(cncDoc(), 0, 0, 10, 10);
    d = addTp(d, { kind: 'pocket', ids: [1], cutDepth: 3 });
    const back = parseProject(serializeProject(d));
    expect(back.cnc?.toolpaths[0]).toMatchObject({ kind: 'pocket', cutDepth: 3, shapeIds: [1] });
    expect(back.cnc?.nextToolpathId).toBeGreaterThan(1);
    const bad = JSON.parse(serializeProject(d));
    bad.doc.cnc.toolpaths[0].toolId = 'ghost';
    expect(() => parseProject(JSON.stringify(bad))).toThrow(/tool that is not/);
    const bad2 = JSON.parse(serializeProject(d));
    bad2.doc.cnc.tools[0].diameter = 'wide';
    expect(() => parseProject(JSON.stringify(bad2))).toThrow(/diameter/);
  });
});
