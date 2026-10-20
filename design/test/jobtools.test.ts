import { describe, expect, it } from 'vitest';
import { bestRecipe, fitsJob, libraryFilters, parseToolLibrary } from '../src/core/toollib';
import { emptyDoc } from '../src/core/types';
import { execute } from '../src/core/commands';
import { parseProject, serializeProject } from '../src/core/project';

const lib = parseToolLibrary({ v: 1, tools: [
  { id: 'A', name: 'Upcut', kind: 'flat', diameter: 6, recipes: [
    { machine: 'DemonCarve', material: 'MDF', status: 'Testing Required', rpm: 18000, feed: 1000, plunge: 300 },
    { machine: 'DemonCarve', material: 'MDF', status: 'Approved', rpm: 18000, feed: 1500, plunge: 500 },
    { machine: 'DemonCarve', material: 'Hardwood', status: 'Approved' },
    { machine: 'Cubiko', material: 'PCB', status: 'Approved', rpm: 20000, feed: 400, plunge: 100 },
  ] },
  { id: 'B', name: 'New', kind: 'ball', diameter: 3, recipes: [] },
  { id: 'C', name: 'Hardwood only', kind: 'flat', diameter: 3, recipes: [{ machine: 'DemonCarve', material: 'Hardwood', status: 'Approved', rpm: 18000, feed: 800, plunge: 300 }] },
] });

describe('machine and material of a job, and the recipes offered', () => {
  it('lists the machines, and the materials of the chosen machine', () => {
    expect(libraryFilters(lib)).toEqual({ machines: ['Cubiko', 'DemonCarve'], materials: ['Hardwood', 'MDF', 'PCB'] });
    expect(libraryFilters(lib, 'DemonCarve').materials).toEqual(['Hardwood', 'MDF']);
    expect(libraryFilters(lib, 'Cubiko').materials).toEqual(['PCB']);
  });
  it('offers the approved recipe with its numbers first, then any with numbers, else none', () => {
    expect(bestRecipe(lib.tools[0], 'DemonCarve', 'MDF')).toMatchObject({ status: 'Approved', feed: 1500 });
    expect(bestRecipe(lib.tools[0], 'DemonCarve', 'Hardwood')).toBeUndefined();   // approved, but no speed or feed yet
    expect(bestRecipe(lib.tools[0], '', 'PCB')).toMatchObject({ machine: 'Cubiko' });
    expect(bestRecipe(lib.tools[1], 'DemonCarve', 'MDF')).toBeUndefined();
    expect(bestRecipe(lib.tools[2], 'DemonCarve', '')).toMatchObject({ feed: 800 });
  });
  it('a tool fits when it has a recipe for the machine and material, or none at all yet', () => {
    expect(lib.tools.map((t) => fitsJob(t, 'DemonCarve', 'MDF'))).toEqual([true, true, false]);
    expect(lib.tools.map((t) => fitsJob(t, 'Cubiko', ''))).toEqual([true, true, false]);
    expect(lib.tools.map((t) => fitsJob(t, '', ''))).toEqual([true, true, true]);
  });
  it('the job keeps its machine and material, and any clears them', () => {
    let d = execute(emptyDoc(), 'new_project', { kind: 'cnc', width: 100, height: 100, thickness: 10 }).doc;
    d = execute(d, 'cnc_job_set', { machine: 'DemonCarve', material: 'MDF' }).doc;
    expect(d.cnc).toMatchObject({ machine: 'DemonCarve', material: 'MDF' });
    expect(parseProject(serializeProject(d)).cnc).toMatchObject({ machine: 'DemonCarve', material: 'MDF' });
    d = execute(d, 'cnc_job_set', { material: '' }).doc;
    expect(d.cnc!.material).toBeUndefined();
    expect(d.cnc!.machine).toBe('DemonCarve');
    d = execute(d, 'cnc_job_set', { machine: '' }).doc;
    expect(parseProject(serializeProject(d)).cnc!.machine).toBeUndefined();   // (the laser's machine in the file is another thing)
    expect(() => execute(d, 'cnc_job_set', { machine: 5 })).toThrow(/must be a name/);
    const j = JSON.parse(serializeProject(execute(d, 'cnc_job_set', { machine: 'X' }).doc));
    j.doc.cnc.machine = 42;
    expect(() => parseProject(JSON.stringify(j))).toThrow(/job machine/);
  });
});
