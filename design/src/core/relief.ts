/**
 * A relief: a grid of heights (a 3D shape seen from above) that 3D roughing and 3D finishing cut. It comes from an STL file
 * (`parseStl` then `stlToRelief`), later also from a picture. Heights are kept as 16 bit numbers, 0 at the bottom of the model
 * and 65535 at its top, with `depth` saying how many millimetres that is.
 */
import { base64ToBytes, bytesToBase64 } from './cnc';

export const RELIEF_MAX_SIDE = 800;
export const MAX_RELIEFS = 8;

export interface Relief {
  id: number;
  name: string;
  /** Cells across and down. Row 0 is the top (largest Y) edge. */
  w: number;
  h: number;
  /** Uint16 little endian, row by row, as base64 */
  data: string;
  /** Where the lower left corner of the grid is on the work, and how wide it is (mm); the height of the grid follows from the cells */
  x: number;
  y: number;
  width: number;
  /** The height of the model, mm (the top of the grid is this far above its bottom) */
  depth: number;
  visible: boolean;
}

export const reliefHeightMm = (r: Relief) => (r.width * r.h) / r.w;

export function reliefCells(r: Relief): Uint16Array {
  const b = base64ToBytes(r.data);
  const out = new Uint16Array(r.w * r.h);
  for (let i = 0; i < out.length; i++) out[i] = b[i * 2] | (b[i * 2 + 1] << 8);
  return out;
}

export function cellsToBase64(c: Uint16Array): string {
  const b = new Uint8Array(c.length * 2);
  for (let i = 0; i < c.length; i++) { b[i * 2] = c[i] & 255; b[i * 2 + 1] = c[i] >> 8; }
  return bytesToBase64(b);
}

/** Check a relief (from a command or a file). Throws an Error with a plain message. */
export function parseRelief(v: unknown): Relief {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') throw new Error('The relief is missing');
  const int = (k: string, what: string) => { const n = o[k]; if (typeof n !== 'number' || !Number.isInteger(n) || n < 2 || n > RELIEF_MAX_SIDE) throw new Error(`The relief ${what} must be 2 to ${RELIEF_MAX_SIDE} cells`); return n; };
  const num = (k: string, lo: number, hi: number, what: string) => { const n = o[k]; if (typeof n !== 'number' || !Number.isFinite(n) || n < lo || n > hi) throw new Error(`${what} is not valid`); return n; };
  const w = int('w', 'width'), h = int('h', 'height');
  if (typeof o.data !== 'string' || o.data.length > Math.ceil((RELIEF_MAX_SIDE * RELIEF_MAX_SIDE * 2 * 4) / 3) + 8) throw new Error('The relief data is damaged');
  let bytes: Uint8Array;
  try { bytes = base64ToBytes(o.data); } catch { throw new Error('The relief data is damaged'); }
  if (bytes.length !== w * h * 2) throw new Error('The relief data does not match its size');
  const id = typeof o.id === 'number' && Number.isInteger(o.id) && o.id >= 1 ? o.id : 1;
  const name = typeof o.name === 'string' && o.name.trim() && o.name.length <= 80 ? o.name.trim() : 'Relief';
  return {
    id, name, w, h, data: o.data, x: num('x', -1e5, 1e5, 'The relief position'), y: num('y', -1e5, 1e5, 'The relief position'),
    width: num('width', 0.1, 1e5, 'The relief width'), depth: num('depth', 0.01, 1e4, 'The relief depth'), visible: o.visible === false ? false : true,
  };
}

// ---- STL ---------------------------------------------------------------------------------------------------

export const STL_MAX_TRIANGLES = 3_000_000;

export interface Mesh {
  /** Nine numbers a triangle: x y z for each corner, in the file's units */
  tris: Float32Array;
  count: number;
}

/** Read a binary or ASCII STL. Throws an Error with a plain message when it is neither or is too big. */
export function parseStl(buf: ArrayBuffer): Mesh {
  const bytes = new Uint8Array(buf);
  if (bytes.length < 84) throw new Error('This is not an STL file (it is too short)');
  const dv = new DataView(buf);
  const n = dv.getUint32(80, true);
  if (bytes.length === 84 + n * 50) {
    if (n === 0) throw new Error('This STL has no triangles');
    if (n > STL_MAX_TRIANGLES) throw new Error(`This STL has ${n.toLocaleString()} triangles; the limit is ${STL_MAX_TRIANGLES.toLocaleString()}. Reduce it in the program that made it.`);
    const tris = new Float32Array(n * 9);
    for (let i = 0; i < n; i++) {
      const o = 84 + i * 50 + 12;
      for (let k = 0; k < 9; k++) tris[i * 9 + k] = dv.getFloat32(o + k * 4, true);
    }
    for (let i = 0; i < tris.length; i++) if (!Number.isFinite(tris[i])) throw new Error('This STL has a damaged triangle (not a number)');
    return { tris, count: n };
  }
  const head = new TextDecoder().decode(bytes.subarray(0, 256)).trimStart().toLowerCase();
  if (!head.startsWith('solid')) throw new Error('This is not an STL file (it is neither a binary nor a text STL)');
  const text = new TextDecoder().decode(bytes);
  const re = /vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/g;
  const out: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    out.push(Number(m[1]), Number(m[2]), Number(m[3]));
    if (out.length / 9 > STL_MAX_TRIANGLES) throw new Error(`This STL has too many triangles (the limit is ${STL_MAX_TRIANGLES.toLocaleString()})`);
  }
  if (!out.length || out.length % 9) throw new Error('This text STL has no triangles, or a triangle without three corners');
  for (const v of out) if (!Number.isFinite(v)) throw new Error('This STL has a damaged triangle (not a number)');
  return { tris: Float32Array.from(out), count: out.length / 9 };
}

export type UpAxis = '+z' | '-z' | '+y' | '-y' | '+x' | '-x';
export const UP_AXES: UpAxis[] = ['+z', '-z', '+y', '-y', '+x', '-x'];

/** Turn the model so the given axis points up (a turn, never a mirror). */
const ORIENT: Record<UpAxis, (x: number, y: number, z: number) => [number, number, number]> = {
  '+z': (x, y, z) => [x, y, z],
  '-z': (x, y, z) => [x, -y, -z],
  '+y': (x, y, z) => [x, -z, y],
  '-y': (x, y, z) => [x, z, -y],
  '+x': (x, y, z) => [y, z, x],
  '-x': (x, y, z) => [y, -z, -x],
};

export interface StlOptions {
  up: UpAxis;
  /** Millimetres in one unit of the file (1 for mm, 25.4 for inches) */
  unitMm: number;
  /** Cells along the longer side (at most RELIEF_MAX_SIDE) */
  maxSide: number;
}

export interface StlRaster {
  w: number;
  h: number;
  cells: Uint16Array;
  /** Size of the model, mm */
  width: number;
  height: number;
  depth: number;
}

/** Look straight down at the model: the highest surface at each cell, heights from the model's lowest point. */
export function rasterizeStl(mesh: Mesh, o: StlOptions): StlRaster {
  const n = mesh.count;
  const P = new Float64Array(n * 9);
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  const f = ORIENT[o.up];
  for (let i = 0; i < n * 3; i++) {
    const [x, y, z] = f(mesh.tris[i * 3] * o.unitMm, mesh.tris[i * 3 + 1] * o.unitMm, mesh.tris[i * 3 + 2] * o.unitMm);
    P[i * 3] = x; P[i * 3 + 1] = y; P[i * 3 + 2] = z;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const width = maxX - minX, height = maxY - minY, depth = maxZ - minZ;
  if (!(width > 1e-6) || !(height > 1e-6)) throw new Error('This model has no width or no length seen from above');
  const side = Math.min(RELIEF_MAX_SIDE, Math.max(2, Math.round(o.maxSide)));
  const cell = Math.max(width, height) / side;
  const w = Math.max(2, Math.ceil(width / cell)), h = Math.max(2, Math.ceil(height / cell));
  const z = new Float32Array(w * h).fill(-Infinity);
  for (let t = 0; t < n; t++) {
    const b = t * 9;
    const x0 = P[b], y0 = P[b + 1], z0 = P[b + 2], x1 = P[b + 3], y1 = P[b + 4], z1 = P[b + 5], x2 = P[b + 6], y2 = P[b + 7], z2 = P[b + 8];
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (Math.abs(area) < 1e-12) continue;   // standing on its edge seen from above
    // cells whose centre can be inside: column i is at x = minX + (i + 0.5) cell, row j at y = maxY - (j + 0.5) cell
    const ci0 = Math.max(0, Math.floor((Math.min(x0, x1, x2) - minX) / cell - 0.5)), ci1 = Math.min(w - 1, Math.ceil((Math.max(x0, x1, x2) - minX) / cell - 0.5));
    const rj0 = Math.max(0, Math.floor((maxY - Math.max(y0, y1, y2)) / cell - 0.5)), rj1 = Math.min(h - 1, Math.ceil((maxY - Math.min(y0, y1, y2)) / cell - 0.5));
    const eps = 1e-9 * Math.abs(area);
    for (let j = rj0; j <= rj1; j++) {
      const py = maxY - (j + 0.5) * cell;
      for (let i = ci0; i <= ci1; i++) {
        const px = minX + (i + 0.5) * cell;
        const w0 = ((x1 - px) * (y2 - py) - (x2 - px) * (y1 - py)) / area;
        const w1 = ((x2 - px) * (y0 - py) - (x0 - px) * (y2 - py)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < -eps / Math.abs(area) || w1 < -eps / Math.abs(area) || w2 < -eps / Math.abs(area)) continue;
        const zz = w0 * z0 + w1 * z1 + w2 * z2;
        if (zz > z[j * w + i]) z[j * w + i] = zz;
      }
    }
  }
  const cells = new Uint16Array(w * h);
  for (let i = 0; i < cells.length; i++) cells[i] = z[i] === -Infinity || depth <= 1e-9 ? 0 : Math.max(0, Math.min(65535, Math.round(((z[i] - minZ) / depth) * 65535)));
  return { w, h, cells, width, height, depth };
}

/** The height in mm above the bottom of the model at a point of the work (bilinear between cells), or null outside the grid. */
export function reliefHeightAt(r: Relief, cells: Uint16Array, x: number, y: number): number | null {
  const cell = r.width / r.w;
  const u = (x - r.x) / cell - 0.5, v = (r.y + r.h * cell - y) / cell - 0.5;
  if (u < -0.5 || v < -0.5 || u > r.w - 0.5 || v > r.h - 0.5) return null;
  const at = (i: number, j: number) => cells[Math.min(r.h - 1, Math.max(0, j)) * r.w + Math.min(r.w - 1, Math.max(0, i))];
  const i0 = Math.floor(u), j0 = Math.floor(v), fu = u - i0, fv = v - j0;
  const hgt = (at(i0, j0) * (1 - fu) + at(i0 + 1, j0) * fu) * (1 - fv) + (at(i0, j0 + 1) * (1 - fu) + at(i0 + 1, j0 + 1) * fu) * fv;
  return (hgt / 65535) * r.depth;
}

/** A hillshaded picture of a relief as RGBA bytes (light from the upper left), tinted with `rgb` and a little lighter higher up. */
export function reliefShade(r: Relief, cells: Uint16Array, rgb: [number, number, number]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(r.w * r.h * 4);
  const cell = r.width / r.w;
  const k = r.depth / 65535;
  const L = [-0.5, 0.5, 0.7];
  const ll = Math.hypot(L[0], L[1], L[2]);
  L[0] /= ll; L[1] /= ll; L[2] /= ll;
  const at = (i: number, j: number) => cells[Math.min(r.h - 1, Math.max(0, j)) * r.w + Math.min(r.w - 1, Math.max(0, i))];
  for (let j = 0; j < r.h; j++) {
    for (let i = 0; i < r.w; i++) {
      const dzdx = ((at(i + 1, j) - at(i - 1, j)) * k) / (2 * cell);
      const dzdy = (-(at(i, j + 1) - at(i, j - 1)) * k) / (2 * cell);   // rows run down the page, Y runs up
      const nl = Math.hypot(dzdx, dzdy, 1);
      const dot = (-dzdx * L[0] - dzdy * L[1] + L[2]) / nl;
      const light = Math.max(0.15, Math.min(1.25, 0.8 + 1.4 * (dot - L[2])));
      const tint = 0.85 + 0.15 * (at(i, j) / 65535);
      const o = (j * r.w + i) * 4;
      out[o] = rgb[0] * light * tint; out[o + 1] = rgb[1] * light * tint; out[o + 2] = rgb[2] * light * tint; out[o + 3] = 255;
    }
  }
  return out;
}
