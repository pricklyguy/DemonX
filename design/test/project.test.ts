import { describe, expect, it } from 'vitest';
import { emptyDoc as baseDoc } from '../src/core/types';
/** The old two-layer starting document: Layer 1 (cut) and Engrave */
const emptyDoc = () => { const d = baseDoc(); return { ...d, layers: [...d.layers, { ...d.layers[0], name: 'Engrave', mode: 'engrave' as const, speed: 100, power: 20, color: '#2bb5c9' }] }; };
import type { Doc } from '../src/core/types';
import { execute } from '../src/core/commands';
import { ProjectError, parseProject, projectName, serializeProject, PROJECT_VERSION } from '../src/core/project';
import { buildExample } from '../src/core/example';
import { buildLaserJob } from '../src/core/laser';

const run = (doc: Doc, id: string, args: any) => execute(doc, id, args);

function richDoc(): Doc {
  let d = run(emptyDoc(), 'new_project', { kind: 'laser', width: 600, height: 400, machine: { name: 'CO2 test', sMax: 255, rapid: 120 } }).doc;
  d = buildExample(d);
  d = run(d, 'layer_set', { name: 'Layer 1', speed: 7.5, power: 42, passes: 2, air: true, output: true }).doc;
  d = run(d, 'layer_set', { name: 'Engrave', interval: 0.07, overscan: 3, visible: false }).doc;
  d = run(d, 'add_path', { points: [[0, 0], [5, 5], [9, 1]], closed: false, layer: 'Layer 1' }).doc;
  d = run(d, 'add_circle', { cx: 100, cy: 100, r: 12.5, layer: 'Engrave' }).doc;
  return d;
}

describe('project file', () => {
  it('round trips everything: shapes with holes, circles, open lines, layer and laser settings, machine and job size', () => {
    const doc = richDoc();
    const back = parseProject(serializeProject(doc));
    expect(back).toEqual(doc);
    // and the laser job made from the reopened design is identical
    expect(buildLaserJob(back).gcode).toBe(buildLaserJob(doc).gcode);
  });

  it('a CNC job keeps its datum, thickness and Z zero', () => {
    const doc = run(emptyDoc(), 'new_project', { kind: 'cnc', width: 969, height: 1044, thickness: 18, datum: 'c', zZero: 'bed' }).doc;
    expect(parseProject(serializeProject(doc)).workspace).toEqual(doc.workspace);
  });

  it('keeps ids and carries on numbering after them', () => {
    const base = richDoc();
    const doc = run(base, 'delete', { ids: [base.shapes[0].id] }).doc; // a gap in the ids
    const back = parseProject(serializeProject(doc));
    const more = run(back, 'add_rect', { x: 0, y: 0, w: 1, h: 1 }).doc;
    expect(new Set(more.shapes.map((s) => s.id)).size).toBe(more.shapes.length);
    expect(more.shapes.at(-1)!.id).toBe(doc.nextId);
  });

  it('repairs a nextId that is too low rather than reusing an id', () => {
    const j = JSON.parse(serializeProject(richDoc()));
    j.doc.nextId = 1;
    const back = parseProject(JSON.stringify(j));
    expect(back.nextId).toBeGreaterThan(Math.max(...back.shapes.map((s) => s.id)));
  });

  it('opens an older file that has no machine or job size, and ignores fields it does not know', () => {
    const j = JSON.parse(serializeProject(richDoc()));
    delete j.doc.machine; delete j.doc.workspace;
    j.doc.somethingNew = { a: 1 };
    j.doc.layers[0].futureField = 'x';
    const back = parseProject(JSON.stringify(j));
    expect(back.workspace.kind).toBe('free');
    expect(back.machine.name).toBeTruthy();
    expect((back as any).somethingNew).toBeUndefined();
    expect((back.layers[0] as any).futureField).toBeUndefined();
  });

  const bad: [string, (j: any) => void, RegExp][] = [
    ['a file that is not JSON', () => {}, /not readable JSON/],
    ['the wrong kind of file', (j) => { j.format = 'something-else'; }, /not a DemonX Design file/],
    ['a newer file version', (j) => { j.version = PROJECT_VERSION + 1; }, /newer version/],
    ['no version', (j) => { delete j.version; }, /no valid version/],
    ['a missing design', (j) => { delete j.doc; }, /missing/],
    ['no layers', (j) => { j.doc.layers = []; }, /layers are damaged/],
    ['a bad layer colour', (j) => { j.doc.layers[0].color = 'red'; }, /colour must look like/],
    ['a bad layer mode', (j) => { j.doc.layers[0].mode = 'burn'; }, /mode must be/],
    ['power above 100', (j) => { j.doc.layers[0].power = 500; }, /power is not a valid number/],
    ['zero speed', (j) => { j.doc.layers[0].speed = 0; }, /speed is not a valid number/],
    ['fractional passes', (j) => { j.doc.layers[0].passes = 1.5; }, /whole number/],
    ['two layers with one name', (j) => { j.doc.layers[1].name = j.doc.layers[0].name; }, /same name/],
    ['a shape on a missing layer', (j) => { j.doc.shapes[0].layer = 'Ghost'; }, /layer that does not exist/],
    ['a repeated id', (j) => { j.doc.shapes[1].id = j.doc.shapes[0].id; }, /repeated or invalid id/],
    ['a circle with a negative radius', (j) => { const c = j.doc.shapes.find((s: any) => s.kind === 'circle'); c.r = -3; }, /radius is not a valid number/],
    ['a point that is not a number', (j) => { const p = j.doc.shapes.find((s: any) => s.kind === 'path'); p.rings[0][0][0] = null; }, /not a valid number/],
    ['a huge coordinate', (j) => { const p = j.doc.shapes.find((s: any) => s.kind === 'path'); p.rings[0][0][1] = 1e12; }, /not a valid number/],
    ['a ring with too few points', (j) => { const p = j.doc.shapes.find((s: any) => s.kind === 'path' && s.closed); p.rings[0] = p.rings[0].slice(0, 2); }, /too few points/],
    ['an unknown shape type', (j) => { j.doc.shapes[0].kind = 'spline'; }, /unknown type/],
    ['a bad job type', (j) => { j.doc.workspace.kind = 'lathe'; }, /laser, cnc, canvas or free/],
    ['a CNC job with no thickness', (j) => { j.doc.workspace.kind = 'cnc'; j.doc.workspace.thickness = 0; }, /thickness/],
    ['a machine with zero S max', (j) => { j.doc.machine.sMax = 0; }, /S max/],
  ];
  for (const [what, mutate, why] of bad) {
    it(`refuses ${what}`, () => {
      const j = JSON.parse(serializeProject(richDoc()));
      let text: string;
      if (what === 'a file that is not JSON') text = '{ not json';
      else { mutate(j); text = JSON.stringify(j); }
      expect(() => parseProject(text)).toThrow(ProjectError);
      expect(() => parseProject(text)).toThrow(why);
    });
  }

  it('refuses things that are not objects at all', () => {
    for (const t of ['null', '42', '"text"', '[]', '']) expect(() => parseProject(t)).toThrow(ProjectError);
  });

  it('the open_project command replaces the drawing, says what is wrong, and export_project returns the text', () => {
    const doc = richDoc();
    const text = (run(doc, 'export_project', {}).data as { text: string }).text;
    const opened = run(emptyDoc(), 'open_project', { text });
    expect(opened.doc).toEqual(doc);
    expect(opened.message).toMatch(/Opened a design with \d+ shapes? on 2 layers/);
    expect(() => run(emptyDoc(), 'open_project', { text: '{}' })).toThrow(/not a DemonX Design file/);
    expect(() => run(emptyDoc(), 'open_project', {})).toThrow(/"text"/);
  });

  it('names a project from its file name', () => {
    expect(projectName('Kiosk base.dxd')).toBe('Kiosk base');
    expect(projectName('C:\\work\\Kiosk base.DXD')).toBe('Kiosk base');
    expect(projectName('/home/me/a.b.dxd')).toBe('a.b');
    expect(projectName(null)).toBe('Untitled');
    expect(projectName('.dxd')).toBe('Untitled');
  });
});
