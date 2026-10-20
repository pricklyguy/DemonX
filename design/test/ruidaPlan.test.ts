import { describe, expect, it } from 'vitest';
import { emptyDoc as baseDoc } from '../src/core/types';
import type { Doc } from '../src/core/types';
import { execute } from '../src/core/commands';
import { buildRuidaPlan, colorRaw } from '../src/core/ruidaPlan';
import { parsePlan, serializePlan } from '../server/src/ruida/plan';
import { writeJobStream } from '../server/src/ruida/write';
import { parseJobStream } from '../server/src/ruida/parse';
import { checkJob } from '../server/src/ruida/validate';

const run = (doc: Doc, id: string, args: any) => execute(doc, id, args).doc;
const base = () => baseDoc();

describe('plan for the Ruida laser from the drawing', () => {
  it('follows a rectangle on a cut layer: one line layer, a move then four burns, y flipped, anchor at the bottom-left', () => {
    let d = run(base(), 'add_rect', { x: 50, y: 40, w: 20, h: 10, layer: 'Layer 1' });
    d = run(d, 'layer_set', { name: 'Layer 1', speed: 40, power: 12.5, air: true, color: '#00e000' });
    const r = buildRuidaPlan(d);
    expect(r.empty).toBe(false);
    const l = r.plan.layers[0];
    expect(l).toMatchObject({ mode: 'line', speed: 40, minPower: 12.5, maxPower: 12.5, air: true, colorRaw: 0x00e000 });
    expect(l.points[0].burn).toBe(false);
    expect(l.points.filter((p) => p.burn).length).toBe(l.points.length - 1);
    const xs = l.points.map((p) => p.x), ys = l.points.map((p) => p.y);
    expect(Math.min(...xs)).toBe(0); expect(Math.max(...xs)).toBe(20);
    // the drawing's Y points up and the job's points toward the front: the bottom-left anchor is y 0 and the rest is negative
    expect(Math.max(...ys)).toBe(0); expect(Math.min(...ys)).toBe(-10);
  });
  it('engrave makes a fill layer with overscan moves, and passes repeat the path', () => {
    let d = run(base(), 'add_circle', { cx: 30, cy: 30, r: 10, layer: 'Layer 1' });
    d = run(d, 'layer_set', { name: 'Layer 1', mode: 'engrave', speed: 415, power: 15, interval: 0.5, overscan: 2 });
    const one = buildRuidaPlan(d).plan.layers[0];
    expect(one.mode).toBe('fill');
    expect(one.points.some((p) => p.burn)).toBe(true);
    expect(one.points.some((p) => !p.burn)).toBe(true);
    d = run(d, 'layer_set', { name: 'Layer 1', passes: 2 });
    const two = buildRuidaPlan(d).plan.layers[0];
    expect(two.points.length).toBeGreaterThan(one.points.length * 1.9);
  });
  it('leaves out layers with Output off and says so when nothing is left', () => {
    let d = run(base(), 'add_rect', { x: 0, y: 0, w: 10, h: 10, layer: 'Layer 1' });
    d = run(d, 'layer_set', { name: 'Layer 1', output: false });
    const r = buildRuidaPlan(d);
    expect(r.empty).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/Output/);
  });
  it('colours are written blue-green-red like LightBurn: red is 0x0000ff', () => {
    expect(colorRaw('#ff0000')).toBe(0x0000ff);
    expect(colorRaw('#00e000')).toBe(0x00e000);
    expect(colorRaw('#0000ff')).toBe(0xff0000);
  });
  it('the plan survives the wire format and becomes a job the reader and the checks accept', () => {
    let d = run(base(), 'add_rect', { x: 10, y: 10, w: 30, h: 20, layer: 'Layer 1' });
    d = run(d, 'layer_set', { name: 'Layer 1', speed: 40, power: 20 });
    const plan = buildRuidaPlan(d).plan;
    const back = parsePlan(serializePlan(plan));
    expect(back.layers[0].points).toEqual(plan.layers[0].points);
    const job = parseJobStream(writeJobStream(back));
    expect(checkJob(job).ok).toBe(true);
  });
  it('the reader refuses anything that is not a plan', () => {
    for (const bad of ['', '{', '[]', '{"v":2,"layers":[]}', '{"v":1,"layers":[]}', '{"v":1,"layers":[{"color":1,"mode":"image","speed":1,"min":0,"max":1,"air":false,"pts":[]}]}',
      '{"v":1,"layers":[{"color":1,"mode":"line","speed":"1","min":0,"max":1,"air":false,"pts":[[0,0,0],[1,1,1]]}]}',
      '{"v":1,"layers":[{"color":1,"mode":"line","speed":1,"min":0,"max":1,"air":false,"pts":[[0,0,2]]}]}',
      '{"v":1,"layers":[{"color":1,"mode":"line","speed":1,"min":0,"max":1,"air":false,"pts":[[0,0,0],[1,null,1]]}]}']) {
      expect(() => parsePlan(bad), bad).toThrow();
    }
  });
});

describe('layer power range and tool layers', () => {
  it('sends the minimum and maximum power separately and keeps them in order', () => {
    let d = run(base(), 'add_rect', { x: 0, y: 0, w: 20, h: 10, layer: 'Layer 1' });
    d = run(d, 'layer_set', { name: 'Layer 1', power: 30 });
    expect(d.layers[0]).toMatchObject({ power: 30, minPower: 30 });
    d = run(d, 'layer_set', { name: 'Layer 1', minPower: 15 });
    expect(buildRuidaPlan(d).plan.layers[0]).toMatchObject({ minPower: 15, maxPower: 30 });
    // lowering the maximum below the minimum drags the minimum down; a minimum above the maximum is refused
    d = run(d, 'layer_set', { name: 'Layer 1', power: 10 });
    expect(d.layers[0]).toMatchObject({ power: 10, minPower: 10 });
    expect(() => execute(d, 'layer_set', { name: 'Layer 1', minPower: 50 })).toThrow();
    const back = parsePlan(serializePlan(buildRuidaPlan(run(d, 'layer_set', { name: 'Layer 1', minPower: 4 })).plan));
    expect(back.layers[0]).toMatchObject({ minPower: 4, maxPower: 10 });
  });
  it('never burns a tool layer, but its shapes still set the start point', () => {
    let d = run(base(), 'layer_set', { name: 'T1', mode: 'tool' });
    d = run(d, 'add_rect', { x: 0, y: 0, w: 100, h: 100, layer: 'T1' });
    d = run(d, 'add_rect', { x: 40, y: 40, w: 10, h: 10, layer: 'Layer 1' });
    const r = buildRuidaPlan(d, { anchor: 'bl' });
    expect(r.plan.layers).toHaveLength(1);
    // measured from the tool rectangle's corner (0,0), not from the burned square
    expect(Math.min(...r.plan.layers[0].points.map((p) => p.x))).toBe(40);
    const only = run(base(), 'layer_set', { name: 'T1', mode: 'tool' });
    expect(buildRuidaPlan(run(only, 'add_rect', { x: 0, y: 0, w: 5, h: 5, layer: 'T1' })).empty).toBe(true);
  });
});
