import { describe, expect, it } from 'vitest';
import { geometryGaps, geometryOk, isApproved, mergeLibraries, parseToolLibrary, recipeComplete, toJobTool, type ToolLibrary } from '../src/core/toollib';
import { emptyDoc } from '../src/core/types';
import { execute } from '../src/core/commands';

const lib = (): ToolLibrary => parseToolLibrary({
  v: 1,
  tools: [
    { id: 'T1', name: '1/4 upcut', manufacturer: 'Maker', part: 'P-1', kind: 'flat', diameter: 6.35, flutes: 3, recipes: [
      { machine: 'DemonCarve', material: 'MDF', status: 'Approved', rpm: 18000, feed: 1270, plunge: 381, passDepth: 5, stepoverMm: 2.54 },
      { machine: 'DemonCarve', material: 'Hardwood', status: 'Testing Required', rpm: 18000 },
    ] },
    { id: 'T2', name: 'V-bit', kind: 'vbit', diameter: 12.7, vAngle: 60, recipes: [] },
    { id: 'T3', name: 'Pending', kind: null, recipes: [] },
    { id: 'T4', name: 'Drag', kind: 'other', diameter: 6, recipes: [] },
    { id: 'T5', name: 'V no angle', kind: 'vbit', diameter: 6, recipes: [] },
  ],
});

describe('the tool library', () => {
  it('reads a library and says which tools are ready for a job', () => {
    const l = lib();
    expect(l.tools.map(geometryOk)).toEqual([true, true, false, false, false]);
    expect(geometryGaps(l.tools[2])).toEqual(['the kind', 'the diameter']);
    expect(geometryGaps(l.tools[3])).toEqual(['not a kind Design can cut with']);
    expect(geometryGaps(l.tools[4])).toEqual(['the angle']);
    expect(l.tools[0].recipes.map(isApproved)).toEqual([true, false]);
    expect(l.tools[0].recipes.map(recipeComplete)).toEqual([true, false]);
  });
  it('makes a job tool from a library tool and a recipe, with the stepover as a percent of the diameter', () => {
    const l = lib();
    const t = toJobTool(l.tools[0], l.tools[0].recipes[0]);
    expect(t).toMatchObject({ id: 'lib-t1-demoncarve-mdf', name: '1/4 upcut · MDF', kind: 'flat', diameter: 6.35, flutes: 3, rpm: 18000, feed: 1270, plunge: 381, stepdown: 5, stepover: 40 });
    expect(toJobTool(l.tools[1])).toMatchObject({ id: 'lib-t2', kind: 'vbit', vAngle: 60 });
    expect(() => toJobTool(l.tools[2])).toThrow(/missing the kind and the diameter/);
    // a job accepts it as it is
    const d = execute(emptyDoc(), 'cnc_tool_set', { tool: t }).doc;
    expect(d.cnc!.tools.some((x) => x.id === t.id)).toBe(true);
    const v = execute(d, 'cnc_tool_set', { tool: toJobTool(l.tools[1]) }).doc;
    expect(v.cnc!.tools.find((x) => x.kind === 'vbit' && x.id === 'lib-t2')!.vAngle).toBe(60);
  });
  it('refuses a damaged library with a plain message', () => {
    expect(() => parseToolLibrary({ v: 2, tools: [] })).toThrow(/not a DemonX tool library/);
    expect(() => parseToolLibrary({ v: 1, tools: [{ id: 'a', name: 'x', kind: 'saw', recipes: [] }] })).toThrow(/kind must be/);
    expect(() => parseToolLibrary({ v: 1, tools: [{ id: 'a', name: 'x', kind: 'flat', recipes: [] }, { id: 'a', name: 'y', kind: 'flat', recipes: [] }] })).toThrow(/same id|Two tools/);
    expect(() => parseToolLibrary({ v: 1, tools: [{ id: 'a', name: 'x', kind: 'flat', diameter: -1, recipes: [] }] })).toThrow(/diameter/);
    expect(() => parseToolLibrary({ v: 1, tools: [{ id: 'a', name: 'x', kind: 'flat', recipes: [{ machine: 'm', material: 'x' }] }] })).toThrow(/status/);
  });
  it('merging replaces a tool with the same id and keeps the others', () => {
    const cur = lib();
    const add = parseToolLibrary({ v: 1, tools: [{ id: 'T3', name: 'Now known', kind: 'ball', diameter: 3, recipes: [] }, { id: 'T9', name: 'New', kind: 'flat', diameter: 3, recipes: [] }] });
    const { lib: merged, added, replaced } = mergeLibraries(cur, add);
    expect([added, replaced, merged.tools.length]).toEqual([1, 1, 6]);
    expect(merged.tools.find((t) => t.id === 'T3')!.name).toBe('Now known');
  });
});
