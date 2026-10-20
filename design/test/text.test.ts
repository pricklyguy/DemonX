import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { emptyDoc } from '../src/core/types';
import { execute, CommandError } from '../src/core/commands';
import { loadFontBuffer } from '../src/core/fonts';
import { shapeBounds, shapeRings } from '../src/core/geom';
import { buildLaserJob } from '../src/core/laser';

const file = (p: string) => { const b = readFileSync(new URL(`../node_modules/@fontsource/${p}.woff`, import.meta.url)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer; };
const area = (r: number[][]) => { let a = 0; for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; };
const text = (args: any, doc = emptyDoc()) => execute(doc, 'add_text', { x: 0, y: 0, height: 10, font: 'Roboto Bold', ...args });

beforeAll(() => {
  loadFontBuffer('Roboto Bold', file('roboto/files/roboto-latin-700-normal'));
  loadFontBuffer('Pacifico', file('pacifico/files/pacifico-latin-400-normal'));
});

describe('add_text', () => {
  it('a capital letter is as tall as asked and sits on the baseline', () => {
    const r = text({ text: 'H' });
    const b = shapeBounds(r.doc.shapes[0])!;
    expect(b.minY).toBeCloseTo(0, 1);
    expect(b.maxY).toBeCloseTo(10, 1);
  });
  it('makes one closed shape per letter and skips spaces', () => {
    const r = text({ text: 'A B' });
    expect(r.doc.shapes).toHaveLength(2);
    expect(r.doc.shapes.every((s) => s.kind === 'path' && s.closed)).toBe(true);
    expect(r.ids).toHaveLength(2);
  });
  it('keeps the hole in an O', () => {
    const s = text({ text: 'O' }).doc.shapes[0];
    const rings = shapeRings(s);
    expect(rings).toHaveLength(2);
    const areas = rings.map(area).sort((p, q) => Math.abs(q) - Math.abs(p));
    expect(Math.sign(areas[0])).not.toBe(Math.sign(areas[1]));
    expect(Math.abs(areas[1])).toBeLessThan(Math.abs(areas[0]));
  });
  it('welds the letters into one shape when asked', () => {
    const loose = text({ text: 'AB' }).doc.shapes;
    const welded = text({ text: 'AB', weld: true }).doc.shapes;
    expect(loose).toHaveLength(2);
    expect(welded).toHaveLength(1);
  });
  it('spacing widens the text and kerning is applied', () => {
    const w = (a: any) => { const b = shapeBounds(text(a).doc.shapes.at(-1)!)!; return b.maxX; };
    expect(w({ text: 'HH', spacing: 5 })).toBeGreaterThan(w({ text: 'HH' }) + 4.9);
    const av = shapeBounds(text({ text: 'AV' }).doc.shapes[1])!.minX;
    const noKern = shapeBounds(text({ text: 'A' }).doc.shapes[0])!.maxX;
    expect(av).toBeLessThan(noKern + 6.7); // V starts closer than A's full advance would put it
  });
  it('centres and right-aligns each line', () => {
    const mid = text({ text: 'HH', align: 'center' }).doc.shapes.map((s) => shapeBounds(s)!);
    expect((mid[0].minX + mid[1].maxX) / 2).toBeCloseTo(0, 0);
    const right = text({ text: 'HH', align: 'right' }).doc.shapes.map((s) => shapeBounds(s)!);
    expect(right[1].maxX).toBeLessThan(0.1);
    expect(right[1].maxX).toBeGreaterThan(-2); // the side bearing
  });
  it('starts a new line below with the line spacing applied', () => {
    const r = text({ text: 'H\nH' }).doc.shapes.map((s) => shapeBounds(s)!);
    const pitch = r[0].minY - r[1].minY;
    expect(pitch).toBeGreaterThan(14);
    const wide = text({ text: 'H\nH', line_spacing: 2 }).doc.shapes.map((s) => shapeBounds(s)!);
    expect(wide[0].minY - wide[1].minY).toBeCloseTo(pitch * 2, 3);
  });
  it('reports characters the font does not have, but draws the rest', () => {
    const r = text({ text: 'A日B' });
    expect(r.doc.shapes).toHaveLength(2);
    expect(r.message).toContain('日');
    expect(() => text({ text: '日' })).toThrow(/none of those/);
  });
  it('works with a script font whose letters overlap', () => {
    const r = text({ text: 'Hello', font: 'Pacifico', weld: true });
    expect(r.doc.shapes).toHaveLength(1);
    expect(shapeRings(r.doc.shapes[0]).every((ring) => ring.length >= 3)).toBe(true);
  });
  it('refuses bad input', () => {
    expect(() => text({ text: '   ' })).toThrow(/Type some text/);
    expect(() => text({ text: 'A', font: 'Nope' })).toThrow(/not loaded/);
    expect(() => text({ text: 'A', height: 0 })).toThrow(CommandError);
    expect(() => text({ text: 'A', align: 'middle' })).toThrow(/align/);
    expect(() => text({ text: 'A'.repeat(2001) })).toThrow(/2000/);
  });
  it('goes through the laser job like any other outline', () => {
    const d = text({ text: 'Hi', height: 20 }).doc;
    const job = buildLaserJob(d, {});
    expect(job.empty).toBe(false);
    expect(job.stats.burnLength).toBeGreaterThan(100);
  });
});

describe('editable text', () => {
  const ids = (d: any) => d.shapes.map((s: any) => s.id);
  const box = (d: any) => { const b = d.shapes.map((s: any) => shapeBounds(s)!); return { minX: Math.min(...b.map((x: any) => x.minX)), maxX: Math.max(...b.map((x: any) => x.maxX)), minY: Math.min(...b.map((x: any) => x.minY)), maxY: Math.max(...b.map((x: any) => x.maxY)) }; };

  it('the letters of one text are one group with a record', () => {
    const d = text({ text: 'ABC' }).doc;
    expect(d.shapes).toHaveLength(3);
    const g = d.shapes[0].group;
    expect(g).toBeDefined();
    expect(d.shapes.every((s) => s.group === g)).toBe(true);
    expect(d.texts).toHaveLength(1);
    expect(d.texts![0]).toMatchObject({ group: g, text: 'ABC', font: 'Roboto Bold', height: 10, count: 3 });
  });

  it('edit_text changes the words and keeps the place', () => {
    let d = text({ text: 'AB', x: 30, y: 40 }).doc;
    d = execute(d, 'edit_text', { ids: ids(d), text: 'ABCD' }).doc;
    expect(d.shapes).toHaveLength(4);
    expect(d.texts).toHaveLength(1);
    expect(d.texts![0].text).toBe('ABCD');
    expect(box(d).minX).toBeGreaterThan(29);
    expect(box(d).minX).toBeLessThan(33);
    expect(box(d).minY).toBeCloseTo(40, 0);
  });

  it('spacing, height, font and alignment are edited the same way', () => {
    let d = text({ text: 'HH' }).doc;
    const w0 = box(d).maxX - box(d).minX;
    d = execute(d, 'edit_text', { ids: ids(d), spacing: 5 }).doc;
    expect(box(d).maxX - box(d).minX).toBeCloseTo(w0 + 5, 0);
    d = execute(d, 'edit_text', { ids: ids(d), height: 20 }).doc;
    expect(box(d).maxY - box(d).minY).toBeCloseTo(20, 0);
    d = execute(d, 'edit_text', { ids: ids(d), font: 'Pacifico' }).doc;
    expect(d.texts![0].font).toBe('Pacifico');
  });

  it('follows the text when it was moved or resized before the edit', () => {
    let d = text({ text: 'AB', x: 0, y: 0 }).doc;
    d = execute(d, 'move', { ids: ids(d), dx: 100, dy: 50 }).doc;
    d = execute(d, 'edit_text', { ids: ids(d), spacing: 1 }).doc;
    expect(box(d).minX).toBeGreaterThan(99);
    expect(box(d).minY).toBeCloseTo(50, 1);
    d = execute(d, 'scale', { ids: ids(d), sx: 2 }).doc;
    const hBefore = box(d).maxY - box(d).minY;
    d = execute(d, 'edit_text', { ids: ids(d), text: 'AB' }).doc;
    expect(d.texts![0].height).toBeCloseTo(20, 3);
    expect(box(d).maxY - box(d).minY).toBeCloseTo(hBefore, 1);
  });

  it('refuses text whose letters were changed by hand, and shapes that are not text', () => {
    let d = text({ text: 'ABC' }).doc;
    const del = execute(d, 'delete', { ids: [d.shapes[0].id] }).doc;
    expect(() => execute(del, 'edit_text', { ids: ids(del), text: 'x' })).toThrow(CommandError);
    const plain = execute(emptyDoc(), 'add_rect', { x: 0, y: 0, w: 5, h: 5, layer: 'Layer 1' }).doc;
    expect(() => execute(plain, 'edit_text', { ids: ids(plain), text: 'x' })).toThrow(/typed with the Text tool/);
  });

  it('text_to_lines frees the letters and drops the record', () => {
    let d = text({ text: 'AB' }).doc;
    d = execute(d, 'text_to_lines', { ids: ids(d) }).doc;
    expect(d.texts ?? []).toHaveLength(0);
    expect(d.shapes.every((s) => s.group === undefined)).toBe(true);
    expect(() => execute(d, 'edit_text', { ids: ids(d), text: 'x' })).toThrow(CommandError);
    expect(() => execute(d, 'text_to_lines', { ids: ids(d) })).toThrow(CommandError);
  });

  it('a duplicate of the text is editable text too', () => {
    let d = text({ text: 'AB' }).doc;
    const r = execute(d, 'duplicate', { ids: ids(d), dx: 0, dy: -30 });
    expect(r.doc.texts).toHaveLength(2);
    const e = execute(r.doc, 'edit_text', { ids: r.ids, text: 'ABC' }).doc;
    expect(e.shapes).toHaveLength(2 + 3);
    expect(e.texts).toHaveLength(2);
  });

  it('survives saving and opening, and a record whose letters are gone is not saved', async () => {
    const { serializeProject, parseProject } = await import('../src/core/project');
    const d = text({ text: 'AB' }).doc;
    const back = parseProject(serializeProject(d));
    expect(back.texts).toHaveLength(1);
    expect(back.texts![0].text).toBe('AB');
    const loose = execute(d, 'ungroup', { ids: ids(d) }).doc;
    expect(parseProject(serializeProject(loose)).texts).toBeUndefined();
  });
});

describe('text on a curve', () => {
  const ids = (d: any) => d.shapes.filter((s: any) => s.group !== undefined).map((s: any) => s.id);
  it('stands the letters on a circle and turns them to follow it', () => {
    let d = execute(emptyDoc(), 'add_circle', { cx: 0, cy: 0, r: 50, layer: 'Layer 1' }).doc;
    const circle = d.shapes[0].id;
    d = execute(d, 'add_text', { text: 'HELLO', x: 200, y: 200, height: 10, font: 'Roboto Bold', layer: 'Layer 1' }).doc;
    d = execute(d, 'edit_text', { ids: ids(d), curve: circle }).doc;
    expect(d.texts![0].curve).toBeDefined();
    const letters = d.shapes.filter((s) => s.group !== undefined);
    expect(letters).toHaveLength(5);
    // every letter stands on the outside of the circle, within the letter height of it
    for (const s of letters) {
      const b = shapeBounds(s)!;
      const r = Math.hypot((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2);
      expect(r).toBeGreaterThan(52);   // outside the circle
      expect(r).toBeLessThan(62);
    }
    // letters sit at different angles, not all in one place
    const angles = letters.map((s) => { const b = shapeBounds(s)!; return Math.atan2((b.minY + b.maxY) / 2, (b.minX + b.maxX) / 2); });
    expect(new Set(angles.map((a) => a.toFixed(2))).size).toBe(5);
  });
  it('flip puts the text on the other side, and curve null takes it off again', () => {
    let d = execute(emptyDoc(), 'add_circle', { cx: 0, cy: 0, r: 50, layer: 'Layer 1' }).doc;
    const circle = d.shapes[0].id;
    d = execute(d, 'add_text', { text: 'AB', x: 0, y: 0, height: 10, font: 'Roboto Bold', layer: 'Layer 1' }).doc;
    d = execute(d, 'edit_text', { ids: ids(d), curve: circle, flip: true }).doc;
    const b = shapeBounds(d.shapes.find((s) => s.group !== undefined)!)!;
    expect(Math.hypot((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2)).toBeLessThan(50);   // inside
    d = execute(d, 'edit_text', { ids: ids(d), curve: null }).doc;
    expect(d.texts![0].curve).toBeUndefined();
  });
  it('letters past the end of an open curve are dropped and counted', () => {
    let d = execute(emptyDoc(), 'add_path', { points: [[0, 0], [30, 0]], closed: false, layer: 'Layer 1' }).doc;
    const line = d.shapes[0].id;
    d = execute(d, 'add_text', { text: 'MMMMMMMMMM', x: 0, y: 20, height: 10, font: 'Roboto Bold', layer: 'Layer 1' }).doc;
    const r = execute(d, 'edit_text', { ids: ids(d), curve: line });
    expect(r.message).toMatch(/did not fit on the curve/);
    expect(r.doc.shapes.filter((s) => s.group !== undefined).length).toBeLessThan(10);
  });
  it('the text cannot run along itself', () => {
    let d = execute(emptyDoc(), 'add_text', { text: 'AB', x: 0, y: 0, height: 10, font: 'Roboto Bold', layer: 'Layer 1' }).doc;
    expect(() => execute(d, 'edit_text', { ids: ids(d), curve: d.shapes[0].id })).toThrow(/itself/);
  });
});

describe('bent text', () => {
  const ids = (d: any) => d.shapes.filter((s: any) => s.group !== undefined).map((s: any) => s.id);
  const mid = (s: any) => { const b = shapeBounds(s)!; return [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2]; };

  it('an arch raises the middle letter above the ends, a smile lowers it, and 0 is straight again', () => {
    let d = text({ text: 'HHHHH', x: 0, y: 0 }).doc;
    const flatY = d.shapes.map((s: any) => mid(s)[1]);
    expect(Math.max(...flatY) - Math.min(...flatY)).toBeLessThan(0.01);
    const arch = execute(d, 'edit_text', { ids: ids(d), bend: 90 }).doc;
    const ay = arch.shapes.filter((s: any) => s.group !== undefined).map((s: any) => mid(s)[1]);
    expect(ay[2]).toBeGreaterThan(ay[0] + 2); expect(ay[2]).toBeGreaterThan(ay[4] + 2);
    expect(arch.texts![0].bend).toBe(90);
    const smile = execute(d, 'edit_text', { ids: ids(d), bend: -90 }).doc;
    const sy = smile.shapes.filter((s: any) => s.group !== undefined).map((s: any) => mid(s)[1]);
    expect(sy[2]).toBeLessThan(sy[0] - 2);
    const back = execute(arch, 'edit_text', { ids: ids(arch), bend: 0 }).doc;
    expect(back.texts![0].bend).toBeUndefined();
    const by = back.shapes.filter((s: any) => s.group !== undefined).map((s: any) => mid(s)[1]);
    expect(Math.max(...by) - Math.min(...by)).toBeLessThan(0.01);
  });
  it('the middle of the line stays where the straight line\'s middle was, and the letters turn with the arc', () => {
    let d = text({ text: 'HHH', x: 20, y: 30, align: 'center' }).doc;
    const arch = execute(d, 'edit_text', { ids: ids(d), bend: 120 }).doc;
    const m = mid(arch.shapes.filter((s: any) => s.group !== undefined)[1]);
    expect(m[0]).toBeCloseTo(20, 0);
    expect(m[1]).toBeGreaterThan(30);          // standing on the baseline point at the middle
    const ends = arch.shapes.filter((s: any) => s.group !== undefined).map((s: any) => shapeBounds(s)!);
    expect(ends[0].maxY - ends[0].minY).toBeGreaterThan(ends[1].maxY - ends[1].minY);   // a tilted letter is taller in the box than the upright one
  });
  it('bending and running along a picked curve replace each other', () => {
    let d = execute(emptyDoc(), 'add_circle', { cx: 0, cy: 0, r: 50, layer: 'Layer 1' }).doc;
    const circle = d.shapes[0].id;
    d = execute(d, 'add_text', { text: 'AB', x: 0, y: 0, height: 10, font: 'Roboto Bold', layer: 'Layer 1', bend: 60 }).doc;
    expect(d.texts![0].bend).toBe(60);
    d = execute(d, 'edit_text', { ids: ids(d), curve: circle }).doc;
    expect(d.texts![0].curve).toBeDefined(); expect(d.texts![0].bend).toBeUndefined();
    d = execute(d, 'edit_text', { ids: ids(d), bend: 45 }).doc;
    expect(d.texts![0].curve).toBeUndefined(); expect(d.texts![0].bend).toBe(45);
  });
  it('follows a move, keeps its bend through a scale, and survives saving', async () => {
    const box = (d: any) => { const b = d.shapes.map((s: any) => shapeBounds(s)!); return { minX: Math.min(...b.map((x: any) => x.minX)) }; };
    const { serializeProject, parseProject } = await import('../src/core/project');
    let d = text({ text: 'HELLO', x: 0, y: 0, bend: 80 }).doc;
    d = execute(d, 'move', { ids: ids(d), dx: 40, dy: 10 }).doc;
    d = execute(d, 'edit_text', { ids: ids(d), spacing: 1 }).doc;
    expect(d.texts![0].bend).toBe(80);
    expect(box(d).minX).toBeGreaterThan(35);   // the bent left end leans out a little
    expect(parseProject(serializeProject(d)).texts![0].bend).toBe(80);
  });
  it('refuses a bend past the limit and ignores a hair of one', () => {
    expect(() => text({ text: 'A', bend: 300 })).toThrow(CommandError);
    expect(text({ text: 'A', bend: 0.2 }).doc.texts![0].bend).toBeUndefined();
  });
});

describe('bend sag and the text cursor', () => {
  it('bendSag and bendForSag are each other\'s inverse, with the sign of the bend', async () => {
    const { bendSag, bendForSag } = await import('../src/core/text');
    for (const b of [10, 45, 90, 180, 250, -30, -120]) expect(bendForSag(200, bendSag(200, b))).toBeCloseTo(b, 1);
    expect(bendForSag(200, 0)).toBe(0);
    expect(Math.abs(bendForSag(200, 500))).toBe(260);
  });
  it('the cursor sits after the typed characters, follows the line and the alignment', async () => {
    const { caretSegment, getFont } = await import('../src/core/text');
    const font = getFont('Roboto Bold')!;
    const o = { height: 10, x: 5, y: 7, align: 'left' as const };
    const start = caretSegment(font, 'Hi\nthere', 0, o);
    expect(start[0][0]).toBeCloseTo(5); expect(start[0][1]).toBeCloseTo(7);
    const a = caretSegment(font, 'Hi\nthere', 1, o), b = caretSegment(font, 'Hi\nthere', 2, o);
    expect(a[0][0]).toBeGreaterThan(5); expect(b[0][0]).toBeGreaterThan(a[0][0]);
    const second = caretSegment(font, 'Hi\nthere', 3, o);
    expect(second[0][0]).toBeCloseTo(5); expect(second[0][1]).toBeLessThan(7 - 5);
    const centred = caretSegment(font, 'Hi', 2, { ...o, align: 'center' });
    expect(centred[0][0]).toBeGreaterThan(5);      // the end of a centred line is half its width to the right of x
    const right = caretSegment(font, 'Hi', 2, { ...o, align: 'right' });
    expect(right[0][0]).toBeCloseTo(5, 1);
    const bent = caretSegment(font, 'Hi', 2, { ...o, bend: 90 });
    expect(bent[0][1]).not.toBeCloseTo(7, 1);
  });
});
