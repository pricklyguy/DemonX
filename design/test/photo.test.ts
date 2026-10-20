import { describe, expect, it } from 'vitest';
import { emptyDoc } from '../src/core/types';
import { execute } from '../src/core/commands';
import { buildAll } from '../src/core/cncjob';
import { bytesToBase64, parsePhoto } from '../src/core/cnc';
import { parseProject, serializeProject } from '../src/core/project';

const run = (d: any, id: string, a: any): any => execute(d, id, a).doc;
/** A picture going from black on the left to white on the right */
const gradient = (w = 40, h = 40) => { const b = new Uint8Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) b[y * w + x] = Math.round((255 * x) / (w - 1)); return { w, h, data: bytesToBase64(b) }; };
const spec = (extra: any = {}) => ({ ...gradient(), x: 10, y: 10, width: 40, mode: 'lines', spacing: 1, dir: 'x', invert: false, ...extra });
const job = (extra: any = {}, tool = 'vbit-60', depth = 2): any => run(run(emptyDoc(), 'new_project', { kind: 'cnc', width: 300, height: 200, thickness: 18 }), 'cnc_toolpath_add', { kind: 'photo', toolId: tool, cutDepth: depth, photo: spec(extra) });
const moves = (d: any) => buildAll(d)[0].result.moves;

describe('photo toolpaths', () => {
  it('needs no shapes, and keeps the picture and settings', () => {
    const d = job();
    expect(d.cnc.toolpaths[0]).toMatchObject({ kind: 'photo', name: 'Photo 1', shapeIds: [] });
    expect(d.cnc.toolpaths[0].photo).toMatchObject({ w: 40, h: 40, mode: 'lines', spacing: 1, width: 40 });
  });
  it('lines: deepest where it is darkest, nothing cut where it is white, and every line stays inside the picture', () => {
    const cuts = moves(job()).filter((m) => m.kind === 'cut');
    expect(cuts.length).toBeGreaterThan(30);   // a straight ramp is one move a line: the moves are thinned to within 0.02 mm
    expect(Math.min(...cuts.map((m) => m.z))).toBeLessThan(-1.9);
    for (const m of cuts) { expect(m.x).toBeGreaterThanOrEqual(10 - 1e-6); expect(m.x).toBeLessThanOrEqual(50 + 1e-6); expect(m.y).toBeGreaterThanOrEqual(10); expect(m.y).toBeLessThanOrEqual(50); }
    // the depth at a point is what the brightness there says: about 2 x (1 - x/40) along the line
    for (const m of cuts.filter((c) => Math.abs(c.y - 10.5) < 1e-6)) expect(-m.z).toBeCloseTo(2 * (1 - (m.x - 10) / 40), 0);
    // nothing is cut in the last stretch, which is almost white
    expect(Math.max(...cuts.map((m) => m.x))).toBeLessThan(50);
  });
  it('invert makes light deep and dark shallow', () => {
    const cuts = moves(job({ invert: true })).filter((m) => m.kind === 'cut');
    for (const m of cuts.filter((c) => Math.abs(c.y - 10.5) < 1e-6)) expect(-m.z).toBeCloseTo(2 * ((m.x - 10) / 40), 0);
    expect(Math.max(...cuts.map((m) => m.x))).toBeGreaterThan(49);
  });
  it('lines along Y make the same picture turned', () => {
    const cuts = moves(job({ dir: 'y' })).filter((m) => m.kind === 'cut');
    expect(cuts.length).toBeGreaterThan(30);
    for (const m of cuts) expect(-m.z).toBeCloseTo(2 * (1 - (m.x - 10) / 40), 0);
  });
  it('dots: one hole where it is dark enough, as deep as it is dark', () => {
    const m = moves(job({ mode: 'dots', spacing: 4 }));
    const holes = m.filter((x) => x.kind === 'plunge');
    expect(holes.length).toBeGreaterThan(20);
    expect(holes.length).toBeLessThan(100);
    for (const h of holes) expect(-h.z).toBeCloseTo(2 * (1 - (h.x - 10) / 40), 0);
    expect(m.filter((x) => x.kind === 'cut')).toEqual([]);
  });
  it('warns about a drill, about dots running together and about too small a depth', () => {
    expect(buildAll(job({}, 'drill-3'))[0].result.warnings.join(' ')).toMatch(/drill cannot engrave/);
    expect(buildAll(job({ mode: 'dots', spacing: 1 }, 'vbit-60', 6))[0].result.warnings.join(' ')).toMatch(/run together/);
  });
  it('is kept in the file, and a damaged picture is refused', () => {
    const d = job();
    const again = parseProject(serializeProject(d));
    expect(again.cnc!.toolpaths[0].photo).toEqual(d.cnc.toolpaths[0].photo);
    const j = JSON.parse(serializeProject(d));
    j.doc.cnc.toolpaths[0].photo.w = 41;
    expect(() => parseProject(JSON.stringify(j))).toThrow(/picture/);
    expect(() => parsePhoto({ ...spec(), mode: 'stripes' })).toThrow(/lines or dots/);
    expect(() => parsePhoto({ ...spec(), spacing: 0 })).toThrow(/spacing/);
    expect(() => run(emptyDoc(), 'cnc_toolpath_add', { kind: 'photo', toolId: 'vbit-60', cutDepth: 1 })).toThrow(/photo settings/);
  });
  it('the settings can be changed without sending the picture again', () => {
    let d = job();
    d = run(d, 'cnc_toolpath_update', { id: 1, photo: { spacing: 2, mode: 'dots' } });
    expect(d.cnc.toolpaths[0].photo).toMatchObject({ spacing: 2, mode: 'dots', w: 40 });
    expect(() => run(d, 'cnc_toolpath_update', { id: 1, photo: { spacing: -1 } })).toThrow(/spacing/);
  });
});
