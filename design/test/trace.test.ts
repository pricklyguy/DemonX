import { describe, expect, it } from 'vitest';
import { autoThreshold, binarize, despeckle, grey, ringArea, traceBitmap, traceEdges } from '../src/core/trace';
import type { Bitmap } from '../src/core/trace';

/** A made-up picture: black where `on(x, y)`, white elsewhere. */
function pic(w: number, h: number, on: (x: number, y: number) => boolean): Bitmap {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = on(x, y) ? 0 : 255; const i = (y * w + x) * 4; data[i] = data[i + 1] = data[i + 2] = v; data[i + 3] = 255; }
  return { width: w, height: h, data };
}
const bits = (b: Bitmap, level = 128) => binarize(grey(b), level, false);

describe('threshold', () => {
  it('finds a level between a dark and a light tone, and treats clear pixels as white', () => {
    const g = new Uint8Array(100).fill(40); g.fill(220, 50);
    const t = autoThreshold(g);
    expect(t).toBeGreaterThanOrEqual(40); expect(t).toBeLessThan(220);
    const clear: Bitmap = { width: 1, height: 1, data: new Uint8ClampedArray([0, 0, 0, 0]) };
    expect(grey(clear)[0]).toBe(255);
  });
  it('invert traces the light parts', () => {
    const b = pic(4, 1, (x) => x < 2);
    expect([...binarize(grey(b), 128, false)]).toEqual([1, 1, 0, 0]);
    expect([...binarize(grey(b), 128, true)]).toEqual([0, 0, 1, 1]);
  });
});

describe('despeckle', () => {
  it('drops small black specks and fills small white holes, keeps the big ones', () => {
    const b = pic(20, 20, (x, y) => (x < 8 && y < 8 && !(x === 3 && y === 3)) || (x === 15 && y === 15));
    const out = despeckle(bits(b), 20, 20, 4);
    expect(out[15 * 20 + 15]).toBe(0);      // the one-pixel speck is gone
    expect(out[3 * 20 + 3]).toBe(1);        // the one-pixel hole is filled
    expect(out[1 * 20 + 1]).toBe(1);        // the big blob stays
  });
});

describe('traceEdges', () => {
  it('a single pixel is a square of four corners', () => {
    const r = traceEdges(bits(pic(3, 3, (x, y) => x === 1 && y === 1)), 3, 3);
    expect(r).toHaveLength(1);
    expect(r[0]).toHaveLength(4);
    expect(Math.abs(ringArea(r[0]))).toBe(1);
  });
  it('a ring of pixels is two outlines, a blob and a hole of opposite direction', () => {
    const r = traceEdges(bits(pic(9, 9, (x, y) => x >= 1 && x <= 7 && y >= 1 && y <= 7 && !(x >= 3 && x <= 5 && y >= 3 && y <= 5))), 9, 9);
    expect(r).toHaveLength(2);
    const areas = r.map(ringArea).sort((a, b) => a - b);
    expect(Math.sign(areas[0])).not.toBe(Math.sign(areas[1]));
    expect(Math.abs(areas[0]) + Math.abs(areas[1])).toBe(49 + 9);
    expect(Math.abs(areas[0]) === 49 || Math.abs(areas[1]) === 49).toBe(true);
  });
  it('blobs that touch only at a corner stay two outlines', () => {
    const r = traceEdges(bits(pic(4, 4, (x, y) => (x === 1 && y === 1) || (x === 2 && y === 2))), 4, 4);
    expect(r).toHaveLength(2);
  });
});

describe('traceBitmap', () => {
  it('a square picture becomes a square of the width asked, upright, with four corners', () => {
    const t = traceBitmap(pic(50, 40, (x, y) => x >= 10 && x < 40 && y >= 10 && y < 30), { width: 100 });   // 2 mm a pixel
    expect(t.shapes).toHaveLength(1);
    const ring = t.shapes[0][0];
    expect(ring).toHaveLength(4);
    const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
    expect(Math.min(...xs)).toBeCloseTo(20); expect(Math.max(...xs)).toBeCloseTo(80);
    // y up: the square spans picture rows 10..30 of 40, so from 20 to 60 mm up
    expect(Math.min(...ys)).toBeCloseTo(20); expect(Math.max(...ys)).toBeCloseTo(60);
    expect(t.height).toBeCloseTo(80);
    expect(ringArea(ring)).toBeGreaterThan(0);
  });
  it('a raster circle becomes a smooth circle within a pixel of the true one, with far fewer points than pixels on its edge', () => {
    const R = 60;
    const t = traceBitmap(pic(200, 200, (x, y) => Math.hypot(x + 0.5 - 100, y + 0.5 - 100) <= R), { width: 200 });   // 1 mm a pixel
    expect(t.shapes).toHaveLength(1);
    const ring = t.shapes[0][0];
    for (const p of ring) expect(Math.abs(Math.hypot(p[0] - 100, p[1] - 100) - R)).toBeLessThan(1.2);
    expect(ring.length).toBeLessThan(300);
    expect(t.shapes[0]).toHaveLength(1);
  });
  it('holes belong to the blob that holds them, and the corners of a letter stay sharp', () => {
    // a block letter "O" made of a square with a square hole, and a separate dot
    const t = traceBitmap(pic(60, 60, (x, y) => (x >= 10 && x < 40 && y >= 10 && y < 40 && !(x >= 20 && x < 30 && y >= 20 && y < 30)) || (x >= 48 && x < 54 && y >= 48 && y < 54)), { width: 60 });
    expect(t.shapes).toHaveLength(2);
    const withHole = t.shapes.find((s) => s.length === 2)!;
    expect(withHole).toBeTruthy();
    expect(withHole[0]).toHaveLength(4); expect(withHole[1]).toHaveLength(4);
    expect(ringArea(withHole[0])).toBeGreaterThan(0); expect(ringArea(withHole[1])).toBeLessThan(0);
  });
  it('says so when there is nothing to trace, and refuses a zero width', () => {
    expect(() => traceBitmap(pic(10, 10, () => false), { width: 10, threshold: 128 })).toThrow(/Nothing to trace/);
    expect(() => traceBitmap(pic(10, 10, () => true), { width: 0 })).toThrow(/width/);
  });
  it('invert traces the light parts instead', () => {
    const t = traceBitmap(pic(30, 30, (x, y) => !(x >= 10 && x < 20 && y >= 10 && y < 20)), { width: 30, invert: true });
    expect(t.shapes).toHaveLength(1);
    expect(Math.abs(ringArea(t.shapes[0][0]))).toBeCloseTo(100, 0);
  });
  it('a 1000 x 1000 picture is traced in about a second', () => {
    const t0 = Date.now();
    const t = traceBitmap(pic(1000, 1000, (x, y) => Math.hypot(x - 500, y - 500) < 400 && Math.hypot(x - 500, y - 500) > 200), { width: 200 });
    expect(t.shapes).toHaveLength(1);
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});
