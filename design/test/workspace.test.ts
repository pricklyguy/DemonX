import { describe, expect, it } from 'vitest';
import { emptyDoc, workRect } from '../src/core/types';
import { execute, CommandError } from '../src/core/commands';
import { parseProject, serializeProject } from '../src/core/project';

describe('canvas jobs and CNC sides', () => {
  it('a canvas is a page of the size given, drawn from 0, 0 at the bottom left, with no machine', () => {
    const d = execute(emptyDoc(), 'new_project', { kind: 'canvas', width: 609, height: 609 }).doc;
    expect(d.workspace).toMatchObject({ kind: 'canvas', width: 609, height: 609 });
    expect(workRect(d.workspace)).toEqual({ minX: 0, minY: 0, maxX: 609, maxY: 609 });
  });
  it('a laser job may carry an optional thickness; a CNC job must have one', () => {
    const l = execute(emptyDoc(), 'new_project', { kind: 'laser', width: 600, height: 400, thickness: 3, machine: { name: 'Shop laser', sMax: 1000, rapid: 100 } }).doc;
    expect(l.workspace.thickness).toBe(3);
    expect(execute(emptyDoc(), 'new_project', { kind: 'laser', width: 600, height: 400, machine: { name: 'Shop laser', sMax: 1000, rapid: 100 } }).doc.workspace.thickness).toBe(0);
    expect(() => execute(emptyDoc(), 'new_project', { kind: 'cnc', width: 600, height: 400 })).toThrow(CommandError);
  });
  it('sides is kept for a CNC job, refused when it is not 1 or 2, and dropped for the other kinds', () => {
    const c = execute(emptyDoc(), 'new_project', { kind: 'cnc', width: 600, height: 400, thickness: 18, sides: 2 }).doc;
    expect(c.workspace.sides).toBe(2);
    expect(() => execute(emptyDoc(), 'new_project', { kind: 'cnc', width: 600, height: 400, thickness: 18, sides: 3 })).toThrow(/sides/);
    const l = execute(c, 'workspace_set', { kind: 'laser' }).doc;
    expect(l.workspace.sides).toBeUndefined();
    expect(execute(emptyDoc(), 'new_project', { kind: 'canvas', width: 10, height: 10, sides: 2 }).doc.workspace.sides).toBeUndefined();
  });
  it('a CNC job saved and opened keeps its sides, and a canvas keeps its kind', () => {
    const c = execute(emptyDoc(), 'new_project', { kind: 'cnc', width: 1290, height: 1300, thickness: 19, sides: 2, zZero: 'bed', datum: 'c' }).doc;
    expect(parseProject(serializeProject(c)).workspace).toMatchObject({ kind: 'cnc', sides: 2, zZero: 'bed', datum: 'c', thickness: 19 });
    const v = execute(emptyDoc(), 'new_project', { kind: 'canvas', width: 300, height: 200 }).doc;
    expect(parseProject(serializeProject(v)).workspace).toMatchObject({ kind: 'canvas', width: 300, height: 200 });
    const old = parseProject(serializeProject(execute(emptyDoc(), 'new_project', { kind: 'cnc', width: 600, height: 400, thickness: 18 }).doc));
    expect(old.workspace.sides).toBeUndefined();   // a file made before sides existed opens unchanged
  });
  it('a file with a sides value that is not 1 or 2 is refused, not quietly changed', () => {
    const c = execute(emptyDoc(), 'new_project', { kind: 'cnc', width: 600, height: 400, thickness: 18, sides: 2 }).doc;
    for (const bad of [3, 0, '2', null]) {
      const j = JSON.parse(serializeProject(c));
      j.doc.workspace.sides = bad;
      expect(() => parseProject(JSON.stringify(j))).toThrow(/sides/);
    }
  });
});

describe('a canvas makes no machine output until it is made a laser job', () => {
  it('has no laser job, with the reason, and the drawing is untouched', async () => {
    const { buildLaserJob, CANVAS_NOTE } = await import('../src/core/laser');
    let d = execute(emptyDoc(), 'new_project', { kind: 'canvas', width: 300, height: 200 }).doc;
    d = execute(d, 'add_rect', { x: 10, y: 10, w: 50, h: 30, layer: 'Layer 1' }).doc;
    const j = buildLaserJob(d);
    expect(j.empty).toBe(true);
    expect(j.gcode).toBe('');
    expect(j.stats.warnings).toEqual([CANVAS_NOTE]);
    expect(d.shapes).toHaveLength(1);
  });
  it('the Ruida job is empty too', async () => {
    const { computeJobs } = await import('../src/core/jobBuild');
    let d = execute(emptyDoc(), 'new_project', { kind: 'canvas', width: 300, height: 200 }).doc;
    d = execute(d, 'add_rect', { x: 10, y: 10, w: 50, h: 30, layer: 'Layer 1' }).doc;
    const out = computeJobs({ doc: d, ruida: true, anchor: 'bl', startFrom: 'current', order: undefined } as any);
    expect(out.job.empty).toBe(true);
    expect(out.ruida.empty).toBe(true);
    expect(out.ruida.text).toBe('');
  });
  it('making it a laser job keeps the shapes and gives a job', async () => {
    const { buildLaserJob } = await import('../src/core/laser');
    let d = execute(emptyDoc(), 'new_project', { kind: 'canvas', width: 300, height: 200 }).doc;
    d = execute(d, 'add_rect', { x: 10, y: 10, w: 50, h: 30, layer: 'Layer 1' }).doc;
    d = execute(d, 'workspace_set', { kind: 'laser', width: 600, height: 400, machine: { name: 'Shop laser', sMax: 1000, rapid: 100 } }).doc;
    expect(d.workspace.kind).toBe('laser');
    expect(d.shapes).toHaveLength(1);
    expect(buildLaserJob(d).empty).toBe(false);
  });
});

describe('a canvas makes no CNC job until it is made a CNC job', () => {
  const cncWithPath = () => {
    let d = execute(emptyDoc(), 'new_project', { kind: 'cnc', width: 600, height: 400, thickness: 18 }).doc;
    d = execute(d, 'add_rect', { x: 10, y: 10, w: 40, h: 30, layer: 'Layer 1' }).doc;
    return execute(d, 'cnc_toolpath_add', { kind: 'profile', toolId: 'flat-6', cutDepth: 6, ids: [d.shapes[0].id], side: 'outside' }).doc;
  };
  it('a CNC job has toolpaths and files, and the same design as a canvas has none (even toolpaths made before)', async () => {
    const { buildAll, generateFiles } = await import('../src/core/cncjob');
    const { BUILT_IN_POSTS } = await import('../src/core/post');
    const d = cncWithPath();
    expect(buildAll(d)).toHaveLength(1);
    expect(generateFiles(d, BUILT_IN_POSTS[0])).toHaveLength(1);
    const canvas = execute(d, 'workspace_set', { kind: 'canvas' }).doc;
    expect(canvas.cnc?.toolpaths).toHaveLength(1);      // kept, in case it is made a CNC job again
    expect(buildAll(canvas)).toEqual([]);
    expect(generateFiles(canvas, BUILT_IN_POSTS[0])).toEqual([]);
    expect(generateFiles(canvas, BUILT_IN_POSTS[0], {}, buildAll(d))).toEqual([]);   // not even from toolpaths built earlier
  });
  it('the commands refuse, with the reason, and work again once it is a CNC job', async () => {
    const { CNC_CANVAS_NOTE } = await import('../src/core/cncjob');
    const canvas = execute(cncWithPath(), 'workspace_set', { kind: 'canvas' }).doc;
    expect(() => execute(canvas, 'cnc_gcode', {})).toThrow(CNC_CANVAS_NOTE);
    expect(() => execute(canvas, 'cnc_toolpath_add', { kind: 'profile', toolId: 'flat-6', cutDepth: 6, ids: [canvas.shapes[0].id] })).toThrow(CNC_CANVAS_NOTE);
    const back = execute(canvas, 'workspace_set', { kind: 'cnc', thickness: 18 }).doc;
    expect(execute(back, 'cnc_gcode', {}).data).toBeTruthy();
  });
});
