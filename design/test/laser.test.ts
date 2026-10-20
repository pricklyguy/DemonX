import { describe, expect, it } from 'vitest';
import { emptyDoc as baseDoc } from '../src/core/types';
/** The old two-layer starting document: Layer 1 (cut) and Engrave */
const emptyDoc = () => { const d = baseDoc(); return { ...d, layers: [...d.layers, { ...d.layers[0], name: 'Engrave', mode: 'engrave' as const, speed: 100, power: 20, color: '#2bb5c9' }] }; };
import type { Doc } from '../src/core/types';
import { execute } from '../src/core/commands';
import { buildLaserJob } from '../src/core/laser';
import { workRect } from '../src/core/types';

const run = (doc: Doc, id: string, args: any) => execute(doc, id, args);

/** A tiny reader for the G-code we write: where the head goes, and whether the laser is on while it does. */
function read(gcode: string) {
  let x = 0, y = 0, s = 0, mode = 'M5', absolute = true;
  const burns: { x0: number; y0: number; x1: number; y1: number }[] = [];
  const problems: string[] = [];
  let burnLen = 0;
  const order: string[] = [];
  for (const raw of gcode.split('\n')) {
    const line = raw.replace(/;.*/, '').trim();
    if (!line) continue;
    const words = [...line.matchAll(/([A-Z])(-?\d*\.?\d+)/g)].map((m) => [m[1], Number(m[2])] as const);
    const g = words.find((w) => w[0] === 'G')?.[1];
    const mcode = words.filter((w) => w[0] === 'M').map((w) => w[1]);
    for (const mc of mcode) { if (mc === 3 || mc === 4 || mc === 5) mode = 'M' + mc; if (mc === 8) order.push('air on'); if (mc === 9) order.push('air off'); }
    const sw = words.find((w) => w[0] === 'S');
    if (sw) s = sw[1];
    if (g === 90) absolute = true;
    if (g === 0 || g === 1) {
      if (!absolute) problems.push('relative move');
      const nx = words.find((w) => w[0] === 'X')?.[1] ?? x;
      const ny = words.find((w) => w[0] === 'Y')?.[1] ?? y;
      const firing = g === 1 && s > 0 && mode === 'M4';
      if (g === 0 && sw) problems.push('S on a rapid: ' + line);
      if (g === 1 && s > 0 && mode !== 'M4') problems.push('G1 with power but the laser is not in M4: ' + line);
      if (firing) { burns.push({ x0: x, y0: y, x1: nx, y1: ny }); burnLen += Math.hypot(nx - x, ny - y); }
      x = nx; y = ny;
    }
  }
  return { burns, burnLen, problems, endMode: mode, order, end: [x, y] };
}

function rectDoc(w = 20, h = 10) {
  const a = run(emptyDoc(), 'add_rect', { x: 5, y: 7, w, h, layer: 'Layer 1' });
  return { doc: a.doc, id: a.ids![0] };
}

describe('laser job: cut', () => {
  it('cuts a rectangle once, at the right power, starting at work zero, and switches the laser off', () => {
    const { doc } = rectDoc();
    const job = buildLaserJob(run(doc, 'layer_set', { name: 'Layer 1', power: 40, speed: 5 }).doc);
    const r = read(job.gcode);
    expect(job.empty).toBe(false);
    expect(r.problems).toEqual([]);
    expect(r.burnLen).toBeCloseTo(60, 6);
    expect(job.gcode).toContain('M4 S0');
    expect(job.gcode).toContain('S400'); // 40% of S1000
    expect(job.gcode).toContain('F300'); // 5 mm/s
    expect(r.endMode).toBe('M5');
    const xs = r.burns.flatMap((b) => [b.x0, b.x1]), ys = r.burns.flatMap((b) => [b.y0, b.y1]);
    expect([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]).toEqual([0, 20, 0, 10]); // bottom-left of the job is X0 Y0
    expect(job.stats.seconds).toBeCloseTo(60 / 5 + job.stats.travelLength / 50, 3);
  });

  it('never fires on a rapid and never leaves the laser on at the end', () => {
    let { doc, id } = rectDoc();
    doc = run(doc, 'add_circle', { cx: 50, cy: 20, r: 6, layer: 'Layer 1' }).doc;
    const r = read(buildLaserJob(doc).gcode);
    expect(r.problems).toEqual([]);
    expect(r.endMode).toBe('M5');
    expect(r.end).toEqual([0, 0]);
  });

  it('cuts holes before the outside', () => {
    let doc = run(emptyDoc(), 'add_rect', { x: 0, y: 0, w: 40, h: 40, layer: 'Layer 1' }).doc;
    doc = run(doc, 'add_circle', { cx: 20, cy: 20, r: 5, layer: 'Layer 1' }).doc;
    const burns = read(buildLaserJob(doc).gcode).burns;
    const inHole = (b: { x1: number; y1: number }) => Math.hypot(b.x1 - 20, b.y1 - 20) < 6;
    const firstOuter = burns.findIndex((b) => !inHole(b));
    const lastHole = burns.map(inHole).lastIndexOf(true);
    expect(firstOuter).toBeGreaterThan(lastHole); // every hole move comes before any move of the outline
  });

  it('a compound shape with a hole (from Subtract) also cuts the hole first', () => {
    let doc = run(emptyDoc(), 'add_rect', { x: 0, y: 0, w: 40, h: 40, layer: 'Layer 1' });
    const big = doc.ids![0];
    const hole = run(doc.doc, 'add_circle', { cx: 20, cy: 20, r: 5, layer: 'Layer 1' });
    const part = run(hole.doc, 'boolean', { op: 'difference', ids: [big, hole.ids![0]] });
    const burns = read(buildLaserJob(part.doc).gcode).burns;
    const inHole = (b: { x1: number; y1: number }) => Math.hypot(b.x1 - 20, b.y1 - 20) < 6;
    expect(burns.findIndex((b) => !inHole(b))).toBeGreaterThan(burns.map(inHole).lastIndexOf(true));
  });

  it('passes repeat the layer', () => {
    const { doc } = rectDoc();
    const one = read(buildLaserJob(doc).gcode).burnLen;
    const three = read(buildLaserJob(run(doc, 'layer_set', { name: 'Layer 1', passes: 3 }).doc).gcode).burnLen;
    expect(three).toBeCloseTo(one * 3, 6);
  });

  it('open lines are cut as lines', () => {
    const a = run(emptyDoc(), 'add_path', { points: [[0, 0], [10, 0], [10, 10]], closed: false, layer: 'Layer 1' });
    const r = read(buildLaserJob(a.doc).gcode);
    expect(r.burnLen).toBeCloseTo(20, 6);
  });
});

describe('laser job: start from', () => {
  const placed = () => {
    const a = run(emptyDoc(), 'new_project', { kind: 'laser', width: 200, height: 100 });
    return run(a.doc, 'add_rect', { x: 50, y: 30, w: 20, h: 10, layer: 'Layer 1' }).doc;
  };

  it('user origin (default) puts the job corner at zero wherever it was drawn', () => {
    const r = read(buildLaserJob(placed()).gcode);
    const xs = r.burns.flatMap((b) => [b.x0, b.x1]);
    expect([Math.min(...xs), Math.max(...xs)]).toEqual([0, 20]);
  });

  it('absolute coordinates keep the position in the work area', () => {
    const job = buildLaserJob(placed(), { startFrom: 'absolute' });
    const r = read(job.gcode);
    const xs = r.burns.flatMap((b) => [b.x0, b.x1]), ys = r.burns.flatMap((b) => [b.y0, b.y1]);
    expect([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]).toEqual([50, 70, 30, 40]);
    expect(job.gcode).toMatch(/Absolute coordinates/);
    expect(job.stats.warnings).toEqual([]);
  });

  it('absolute coordinates warn when the job is outside the work area, user origin does not', () => {
    const doc = run(placed(), 'move', { ids: [1], dx: 170, dy: 0 }).doc; // right edge now at 240 > 200
    const abs = buildLaserJob(doc, { startFrom: 'absolute' });
    expect(abs.stats.warnings.join(' ')).toMatch(/outside the machine area \(0 to 200 by 0 to 100 mm\)/);
    expect(buildLaserJob(doc).stats.warnings).toEqual([]);
    const neg = run(placed(), 'move', { ids: [1], dx: -60, dy: 0 }).doc;
    expect(buildLaserJob(neg, { startFrom: 'absolute' }).stats.warnings.join(' ')).toMatch(/X -10 to 10/);
  });
});

describe('job setup', () => {
  it('a new laser project has the machine area, with 0,0 at the bottom-left', () => {
    const d = run(emptyDoc(), 'new_project', { kind: 'laser', width: 600, height: 400, machine: { name: 'CO2', sMax: 255 } }).doc;
    expect(d.workspace).toMatchObject({ kind: 'laser', width: 600, height: 400 });
    expect(d.machine).toMatchObject({ name: 'CO2', width: 600, height: 400, sMax: 255 });
    expect(workRect(d.workspace)).toEqual({ minX: 0, minY: 0, maxX: 600, maxY: 400 });
    expect(d.shapes).toEqual([]);
  });

  it('a CNC job puts 0,0 at the chosen corner of the stock', () => {
    const base = { kind: 'cnc', width: 969, height: 1044, thickness: 18 };
    expect(workRect(run(emptyDoc(), 'new_project', base).doc.workspace)).toEqual({ minX: 0, minY: 0, maxX: 969, maxY: 1044 });
    expect(workRect(run(emptyDoc(), 'new_project', { ...base, datum: 'c' }).doc.workspace)).toEqual({ minX: -484.5, minY: -522, maxX: 484.5, maxY: 522 });
    expect(workRect(run(emptyDoc(), 'new_project', { ...base, datum: 'tr' }).doc.workspace)).toEqual({ minX: -969, minY: -1044, maxX: 0, maxY: 0 });
  });

  it('free means no limit', () => {
    expect(workRect(emptyDoc().workspace)).toBeNull();
  });

  it('changing the job keeps the shapes; changing a laser machine size changes the work area', () => {
    let d = run(emptyDoc(), 'new_project', { kind: 'laser', width: 300, height: 180 }).doc;
    d = run(d, 'add_rect', { x: 0, y: 0, w: 10, h: 10 }).doc;
    d = run(d, 'workspace_set', { width: 500 }).doc;
    expect(d.shapes).toHaveLength(1);
    expect(d.workspace.width).toBe(500);
    expect(d.machine.width).toBe(500);
    d = run(d, 'machine_set', { height: 250 }).doc;
    expect(d.workspace.height).toBe(250);
    const cnc = run(d, 'workspace_set', { kind: 'cnc', thickness: 12 }).doc;
    expect(cnc.machine.width).toBe(500); // the laser machine is left as it was
  });

  it('refuses nonsense', () => {
    const d = emptyDoc();
    expect(() => run(d, 'new_project', { kind: 'cnc', width: 100, height: 100 })).toThrow(/thickness/);
    expect(() => run(d, 'new_project', { kind: 'lathe' })).toThrow(/"kind"/);
    expect(() => run(d, 'workspace_set', { width: 0 })).toThrow(/"width"/);
    expect(() => run(d, 'workspace_set', { datum: 'zz' })).toThrow(/datum/);
    expect(() => run(d, 'workspace_set', { zZero: 'air' })).toThrow(/zZero/);
  });
});

describe('laser job: layers, output, selection', () => {
  function twoLayers() {
    let doc = run(emptyDoc(), 'add_rect', { x: 0, y: 0, w: 10, h: 10, layer: 'Layer 1' }).doc;
    const b = run(doc, 'add_rect', { x: 20, y: 0, w: 10, h: 10, layer: 'Engrave' });
    return { doc: b.doc, second: b.ids![0] };
  }

  it('Output off leaves a layer out; Show off does not', () => {
    const { doc } = twoLayers();
    const both = buildLaserJob(doc);
    expect(both.stats.layers).toBe(2);
    const noEngrave = buildLaserJob(run(doc, 'layer_set', { name: 'Engrave', output: false }).doc);
    expect(noEngrave.stats.layers).toBe(1);
    expect(noEngrave.gcode).not.toContain('Layer Engrave');
    const hidden = buildLaserJob(run(doc, 'layer_set', { name: 'Engrave', visible: false }).doc);
    expect(hidden.stats.layers).toBe(2); // hidden on screen, still burns
  });

  it('only the chosen shapes, and an empty job says why', () => {
    const { doc, second } = twoLayers();
    const one = buildLaserJob(doc, { onlyIds: [second] });
    expect(one.stats.layers).toBe(1);
    expect(one.gcode).toContain('Layer Engrave');
    const none = buildLaserJob(run(doc, 'layer_set', { name: 'Layer 1', output: false }).doc, { onlyIds: [doc.shapes[0].id] });
    expect(none.empty).toBe(true);
    expect(none.gcode).toBe('');
    expect(none.stats.warnings[0]).toMatch(/Output on/);
  });

  it('layers burn in list order', () => {
    const { doc } = twoLayers();
    const g = buildLaserJob(doc).gcode;
    expect(g.indexOf('Layer Cut')).toBeLessThan(g.indexOf('Layer Engrave'));
  });

  it('air assist turns on and off around its layer only', () => {
    const { doc } = twoLayers();
    const g = buildLaserJob(run(doc, 'layer_set', { name: 'Layer 1', air: true }).doc).gcode.split('\n');
    expect(g.filter((l) => l === 'M8')).toHaveLength(1);
    expect(g.filter((l) => l === 'M9')).toHaveLength(1);
    expect(g.indexOf('M8')).toBeLessThan(g.indexOf('M9'));
    expect(g.indexOf('M9')).toBeLessThan(g.findIndex((l) => l.includes('Layer Engrave')));
    expect(buildLaserJob(doc).gcode).not.toContain('M8');
  });

  it('the work zero follows the anchor', () => {
    const { doc } = rectDoc();
    const centre = read(buildLaserJob(doc, { anchor: 'c' }).gcode);
    const xs = centre.burns.flatMap((b) => [b.x0, b.x1]);
    expect([Math.min(...xs), Math.max(...xs)]).toEqual([-10, 10]);
    expect(buildLaserJob(doc, { anchor: 'tr' }).gcode).toMatch(/top-right/);
  });

  it('warns when the job is bigger than the machine, and when power is 0', () => {
    const { doc } = rectDoc(400, 10);
    expect(buildLaserJob(doc).stats.warnings[0]).toMatch(/400 × 10 mm but the machine area is 300 × 180/);
    expect(buildLaserJob(run(doc, 'layer_set', { name: 'Layer 1', power: 0 }).doc).stats.warnings.join(' ')).toMatch(/0% power/);
  });

  it('power is scaled to the controller S max', () => {
    const { doc } = rectDoc();
    const d = run(run(doc, 'machine_set', { sMax: 255 }).doc, 'layer_set', { name: 'Layer 1', power: 50 }).doc;
    expect(buildLaserJob(d).gcode).toContain('S128'); // 127.5 rounds up
  });
});

describe('laser job: engrave (fill)', () => {
  const engrave = (doc: Doc, patch: any = {}) => run(doc, 'layer_set', { name: 'Engrave', interval: 1, overscan: 0, speed: 50, power: 20, ...patch }).doc;

  it('fills a square with lines the interval apart, back and forth', () => {
    const a = run(emptyDoc(), 'add_rect', { x: 0, y: 0, w: 10, h: 10, layer: 'Engrave' });
    const job = buildLaserJob(engrave(a.doc, { mode: 'engrave' }));
    const r = read(job.gcode);
    expect(r.problems).toEqual([]);
    expect(r.burns).toHaveLength(10);
    expect(r.burnLen).toBeCloseTo(100, 6);
    // lines go alternately left to right and right to left
    r.burns.forEach((b, i) => expect(b.x1 > b.x0).toBe(i % 2 === 0));
    expect(r.burns.map((b) => b.y0)).toEqual([0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5, 8.5, 9.5]);
  });

  it('overscan runs past the shape with the laser off', () => {
    const a = run(emptyDoc(), 'add_rect', { x: 0, y: 0, w: 10, h: 4, layer: 'Engrave' });
    const job = buildLaserJob(engrave(a.doc, { mode: 'engrave', overscan: 2 }));
    const r = read(job.gcode);
    expect(r.problems).toEqual([]);
    expect(r.burnLen).toBeCloseTo(40, 6); // only inside the shape burns
    const xs = job.moves.flatMap((m) => [m.x0, m.x1]);
    expect(Math.min(...xs)).toBeCloseTo(-2, 6);
    expect(Math.max(...xs)).toBeCloseTo(12, 6);
    expect(job.moves.filter((m) => !m.burn && Math.abs(m.y0 - m.y1) < 1e-9 && m.x0 !== m.x1).length).toBeGreaterThan(0);
    expect(job.stats.warnings.join(' ')).toMatch(/up to 2 mm outside the job/);
  });

  it('leaves a hole unburnt', () => {
    let doc = run(emptyDoc(), 'add_rect', { x: 0, y: 0, w: 30, h: 30, layer: 'Engrave' });
    const big = doc.ids![0];
    const hole = run(doc.doc, 'add_circle', { cx: 15, cy: 15, r: 8, layer: 'Engrave' });
    const part = run(hole.doc, 'boolean', { op: 'difference', ids: [big, hole.ids![0]] });
    const r = read(buildLaserJob(engrave(part.doc, { mode: 'engrave', interval: 0.1 })).gcode);
    const expected = (900 - Math.PI * 64) / 0.1; // area / interval
    expect(Math.abs(r.burnLen - expected) / expected).toBeLessThan(0.01);
    // nothing burns inside the hole
    for (const b of r.burns) {
      const midX = (b.x0 + b.x1) / 2, midY = b.y0;
      expect(Math.hypot(midX - 15, midY - 15) > 7.9 || b.x1 === b.x0).toBe(true);
    }
  });

  it('merges overlapping shapes so they are not burnt twice', () => {
    let doc = run(emptyDoc(), 'add_rect', { x: 0, y: 0, w: 10, h: 10, layer: 'Engrave' }).doc;
    doc = run(doc, 'add_rect', { x: 5, y: 0, w: 10, h: 10, layer: 'Engrave' }).doc;
    const r = read(buildLaserJob(engrave(doc, { mode: 'engrave' })).gcode);
    expect(r.burnLen).toBeCloseTo(150, 6); // 15 wide x 10 lines, not 200
  });

  it('skips open lines on an engrave layer and says so', () => {
    let doc = run(emptyDoc(), 'add_rect', { x: 0, y: 0, w: 10, h: 10, layer: 'Engrave' }).doc;
    doc = run(doc, 'add_path', { points: [[0, 0], [10, 10]], closed: false, layer: 'Engrave' }).doc;
    const job = buildLaserJob(engrave(doc, { mode: 'engrave' }));
    expect(job.stats.warnings.join(' ')).toMatch(/open lines are skipped/);
  });

  it('commands: laser_gcode returns the job and changes nothing', () => {
    const { doc } = rectDoc();
    const r = run(doc, 'laser_gcode', {});
    expect(r.doc).toBe(doc);
    expect((r.data as any).gcode).toContain('M4 S0');
    expect(() => run(doc, 'laser_gcode', { anchor: 'zz' })).toThrow(/anchor/);
    expect(() => run(doc, 'laser_gcode', { only: 'x' })).toThrow(/list of shape ids/);
    expect(() => run(doc, 'layer_set', { name: 'Layer 1', interval: 0 })).toThrow(/interval/);
    expect(() => run(doc, 'layer_set', { name: 'Layer 1', output: 'yes' })).toThrow(/true or false/);
    expect(() => run(doc, 'machine_set', { width: -5 })).toThrow(/"width"/);
  });
});
