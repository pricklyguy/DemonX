import type { Pt } from './types';
import { fitRing } from './fit';

/**
 * Tracing a bitmap into vectors. A picture is turned to black and white (a threshold on its brightness), specks are dropped, the edges
 * between black and white are followed pixel edge by pixel edge into closed outlines (an outline round each black blob, and one round
 * each hole in it), and the staircase of pixel edges is smoothed into curves with the curve fitter (corners kept).
 */
export interface Bitmap { width: number; height: number; data: Uint8Array | Uint8ClampedArray }   // RGBA

/** Brightness 0..255 of every pixel; transparent pixels count as white. */
export function grey(img: Bitmap): Uint8Array {
  const out = new Uint8Array(img.width * img.height);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) {
    const a = img.data[j + 3] / 255;
    const y = 0.299 * img.data[j] + 0.587 * img.data[j + 1] + 0.114 * img.data[j + 2];
    out[i] = Math.round(y * a + 255 * (1 - a));
  }
  return out;
}

/** The brightness that best separates dark from light (Otsu's method). */
export function autoThreshold(g: Uint8Array): number {
  const hist = new Array<number>(256).fill(0);
  for (const v of g) hist[v]++;
  const total = g.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let wB = 0, sumB = 0, best = 0, bestVar = -1;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > bestVar) { bestVar = v; best = t; }
  }
  return best;
}

/** 1 for the pixels that will be traced (darker than the level, or lighter when inverted), 0 for the rest. */
export function binarize(g: Uint8Array, level: number, invert: boolean): Uint8Array {
  const out = new Uint8Array(g.length);
  for (let i = 0; i < g.length; i++) out[i] = (g[i] <= level) !== invert ? 1 : 0;
  return out;
}

/** Drop black blobs smaller than `minArea` pixels, and fill white holes smaller than that (not touching the edge of the picture). */
export function despeckle(bin: Uint8Array, w: number, h: number, minArea: number): Uint8Array {
  if (minArea <= 1) return bin;
  const out = new Uint8Array(bin);
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  for (const value of [1, 0] as const) {
    seen.fill(0);
    for (let s = 0; s < w * h; s++) {
      if (seen[s] || out[s] !== value) continue;
      const comp: number[] = [];
      let touchesEdge = false;
      stack.push(s); seen[s] = 1;
      while (stack.length) {
        const p = stack.pop()!;
        comp.push(p);
        const x = p % w, y = (p / w) | 0;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touchesEdge = true;
        if (x > 0 && !seen[p - 1] && out[p - 1] === value) { seen[p - 1] = 1; stack.push(p - 1); }
        if (x < w - 1 && !seen[p + 1] && out[p + 1] === value) { seen[p + 1] = 1; stack.push(p + 1); }
        if (y > 0 && !seen[p - w] && out[p - w] === value) { seen[p - w] = 1; stack.push(p - w); }
        if (y < h - 1 && !seen[p + w] && out[p + w] === value) { seen[p + w] = 1; stack.push(p + w); }
      }
      if (comp.length < minArea && (value === 1 || !touchesEdge)) for (const p of comp) out[p] = value === 1 ? 0 : 1;
    }
  }
  return out;
}

/**
 * The outlines of the black pixels, as closed rings of pixel-corner points (x to the right, y DOWN the picture). Black is on the left of
 * every edge as it is followed, so the ring round a blob runs one way and the ring round a hole the other (see `ringArea`).
 */
export function traceEdges(bin: Uint8Array, w: number, h: number): Pt[][] {
  const W = w + 1;
  const px = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : bin[y * w + x]);
  // directed edges with black on the left. dir: 0 right, 1 down, 2 left, 3 up (y down the picture). An edge starts at a vertex and is stored there.
  const next = new Int32Array(W * (h + 1) * 4).fill(-1);   // vertex*4 + dir -> 1 when there is such an edge
  const mark = (x: number, y: number, d: number) => { next[(y * W + x) * 4 + d] = 1; };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!bin[y * w + x]) continue;
      if (!px(x, y - 1)) mark(x + 1, y, 2);       // top side, black below it: run left? (black on the left of a leftward edge when y is down)
      if (!px(x + 1, y)) mark(x + 1, y + 1, 3);   // right side: run up
      if (!px(x, y + 1)) mark(x, y + 1, 0);       // bottom side: run right
      if (!px(x - 1, y)) mark(x, y, 1);           // left side: run down
    }
  }
  const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];
  const rings: Pt[][] = [];
  for (let v = 0; v < W * (h + 1); v++) {
    for (let d0 = 0; d0 < 4; d0++) {
      if (next[v * 4 + d0] !== 1) continue;
      const ring: Pt[] = [];
      let x = v % W, y = (v / W) | 0, d = d0;
      for (;;) {
        next[(y * W + x) * 4 + d] = 0;
        ring.push([x, y]);
        x += DX[d]; y += DY[d];
        // at the next vertex, prefer turning towards the black side (left), then straight, then right: this keeps blobs that touch only at a corner apart
        const base = (y * W + x) * 4;
        const left = (d + 3) % 4, right = (d + 1) % 4;
        let nd = -1;
        if (next[base + left] === 1) nd = left;
        else if (next[base + d] === 1) nd = d;
        else if (next[base + right] === 1) nd = right;
        if (nd < 0) break;
        d = nd;
        if (x === v % W && y === ((v / W) | 0) && d === d0) break;
      }
      // keep only the corners (drop points in the middle of a straight run)
      const keep = ring.filter((p, i) => {
        const a = ring[(i + ring.length - 1) % ring.length], b = ring[(i + 1) % ring.length];
        return (p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0]) !== 0;
      });
      if (keep.length >= 4) rings.push(keep);
    }
  }
  return rings;
}

export const ringArea = (r: Pt[]): number => { let a = 0; for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; };
const inside = (p: Pt, r: Pt[]): boolean => {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    if ((r[i][1] > p[1]) !== (r[j][1] > p[1]) && p[0] < ((r[j][0] - r[i][0]) * (p[1] - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) c = !c;
  }
  return c;
};

export interface TraceOptions {
  /** Brightness cut: darker pixels are traced (0 to 255). Default: found automatically */
  threshold?: number;
  /** Trace the light parts instead of the dark ones */
  invert?: boolean;
  /** Black blobs and white holes smaller than this many pixels are dropped */
  minArea?: number;
  /** How wide the traced drawing is, mm (the height follows the picture) */
  width: number;
  /** How far (in pixels) the curve may stray from the pixel edges; bigger is smoother */
  smooth?: number;
  /** A turn of this many degrees or more (looking 3 pixels each way) stays a sharp corner */
  corner?: number;
}

export interface Traced {
  /** One entry per blob: its outline first, then the outlines of the holes in it. Millimetres, Y up, the lower left of the picture at 0, 0 */
  shapes: Pt[][][];
  threshold: number;
  width: number;
  height: number;
  points: number;
}

/** Trace a picture. Throws an Error with a plain message when there is nothing to trace. */
export function traceBitmap(img: Bitmap, o: TraceOptions): Traced {
  if (!(o.width > 0)) throw new Error('The width must be more than 0');
  const g = grey(img);
  const level = o.threshold ?? autoThreshold(g);
  const bin = despeckle(binarize(g, level, !!o.invert), img.width, img.height, o.minArea ?? 4);
  const edges = traceEdges(bin, img.width, img.height);
  if (!edges.length) throw new Error('Nothing to trace at this threshold: the picture is all one tone');
  const scale = o.width / img.width;
  const smooth = o.smooth ?? 1;
  const mm = (r: Pt[]): Pt[] => r.map((p): Pt => [p[0] * scale, (img.height - p[1]) * scale]);
  // y flipped to point up: the rings that run one way are blobs, the others holes (by the sign of their area)
  const fitted = edges.map((r) => {
    const ring = mm(r);
    const area = ringArea(ring);
    const f = smooth > 0 ? fitRing(ring, true, { tolerance: smooth * scale, cornerAngle: o.corner ?? 55, window: 3 * scale, flat: (smooth * scale) / 8 }) : ring;
    return { ring: f, area, hole: false };
  }).filter((r) => r.ring.length >= 3);
  // seen upright, a blob's outline runs anticlockwise (positive area) and a hole's clockwise
  for (const r of fitted) r.hole = r.area < 0;
  const blobs = fitted.filter((r) => !r.hole);
  const holes = fitted.filter((r) => r.hole);
  const shapes: Pt[][][] = blobs.map((b) => [b.ring]);
  const sizes = blobs.map((b) => Math.abs(b.area));
  for (const h of holes) {
    // the smallest blob that holds it
    let best = -1;
    blobs.forEach((b, i) => { if (inside(h.ring[0], b.ring) && (best < 0 || sizes[i] < sizes[best])) best = i; });
    if (best >= 0) shapes[best].push(h.ring);
  }
  const points = shapes.reduce((n, s) => n + s.reduce((m, r) => m + r.length, 0), 0);
  return { shapes, threshold: level, width: o.width, height: img.height * scale, points };
}
