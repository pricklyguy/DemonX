// Program analysis shared by the server (job extents) and the browser (3D toolpath).
// Lenient on purpose: it only needs to know where the tool goes, so it understands
// absolute/relative mode, inches, and arcs, and ignores anything else. (The autolevel
// rewriter in server/src/gcode.ts is the strict one.)

export interface Box3 {
  minX: number; maxX: number;
  minY: number; maxY: number;
  minZ: number; maxZ: number;
}

export interface Extents {
  /** Points the tool reaches while cutting (G1/G2/G3): the real size and depth of the work. When every cut is below Z0, the top of the Z range is Z0 (the surface). */
  cut?: Box3;
  /** Every point including rapids, so a stray rapid Z still shows */
  all?: Box3;
}

export interface Toolpath {
  extents: Extents;
  /** Flat x,y,z,x,y,z per segment end: segment i is values [6i .. 6i+5]. Units are mm. */
  cut: Float32Array;
  rapid: Float32Array;
  /** Index into the analysed lines that produced each segment (non-decreasing) */
  cutLine: Uint32Array;
  rapidLine: Uint32Array;
}

const TAU = Math.PI * 2;
const WORD = /([A-Z])\s*([-+]?\d*\.?\d+)/g;

function grow(b: Box3 | undefined, x: number, y: number, z: number): Box3 {
  return b
    ? { minX: Math.min(b.minX, x), maxX: Math.max(b.maxX, x), minY: Math.min(b.minY, y), maxY: Math.max(b.maxY, y), minZ: Math.min(b.minZ, z), maxZ: Math.max(b.maxZ, z) }
    : { minX: x, maxX: x, minY: y, maxY: y, minZ: z, maxZ: z };
}

/**
 * Walk a program and collect its extents and, unless `path` is false, its segments.
 * The start position is taken as 0,0,0 until the program moves.
 */
export function analyzeProgram(lines: string[], opts: { path?: boolean } = {}): Toolpath {
  const wantPath = opts.path !== false;
  const cut: number[] = [], rapid: number[] = [], cutLine: number[] = [], rapidLine: number[] = [];
  let ext: Extents = {};
  let x = 0, y = 0, z = 0;
  let relative = false, scale = 1, plane = 17, motion: 0 | 1 | 2 | 3 = 0;

  const emit = (isCut: boolean, line: number, nx: number, ny: number, nz: number, ox: number, oy: number, oz: number) => {
    ext = { all: grow(ext.all, nx, ny, nz), cut: isCut ? grow(ext.cut, nx, ny, nz) : ext.cut };
    if (!wantPath) return;
    (isCut ? cut : rapid).push(ox, oy, oz, nx, ny, nz);
    (isCut ? cutLine : rapidLine).push(line);
  };

  lines.forEach((raw, idx) => {
    const clean = raw.replace(/\([^)]*\)/g, '').replace(/;.*$/, '').toUpperCase();
    const words = [...clean.matchAll(WORD)].map((m) => ({ c: m[1], v: Number(m[2]) }));
    if (!words.length) return;
    for (const w of words) {
      if (w.c !== 'G') continue;
      if (w.v === 0 || w.v === 1 || w.v === 2 || w.v === 3) motion = w.v as 0 | 1 | 2 | 3;
      else if (w.v === 90) relative = false;
      else if (w.v === 91) relative = true;
      else if (w.v === 20) scale = 25.4;
      else if (w.v === 21) scale = 1;
      else if (w.v === 17 || w.v === 18 || w.v === 19) plane = w.v;
    }
    const get = (c: string) => { const w = words.find((q) => q.c === c); return w ? w.v * scale : undefined; };
    const gx = get('X'), gy = get('Y'), gz = get('Z');
    if (gx === undefined && gy === undefined && gz === undefined) return;
    const tx = gx === undefined ? x : relative ? x + gx : gx;
    const ty = gy === undefined ? y : relative ? y + gy : gy;
    const tz = gz === undefined ? z : relative ? z + gz : gz;
    const isCut = motion !== 0;

    if ((motion === 2 || motion === 3) && plane === 17) {
      const i = get('I'), j = get('J'), r = get('R');
      let cx: number | undefined, cy: number | undefined;
      if (i !== undefined || j !== undefined) { cx = x + (i ?? 0); cy = y + (j ?? 0); }
      else if (r !== undefined) {
        const dx = tx - x, dy = ty - y, d = Math.hypot(dx, dy);
        if (d > 1e-9) {
          const h = Math.sqrt(Math.max(0, r * r - (d / 2) ** 2));
          // centre sits left of the chord for CCW with +R, right for CW; a negative R flips it
          const side = (motion === 3 ? 1 : -1) * (r < 0 ? -1 : 1);
          cx = (x + tx) / 2 + side * h * (-dy / d); cy = (y + ty) / 2 + side * h * (dx / d);
        }
      }
      if (cx !== undefined && cy !== undefined) {
        const r0 = Math.hypot(x - cx, y - cy), r1 = Math.hypot(tx - cx, ty - cy);
        const a0 = Math.atan2(y - cy, x - cx);
        let sweep = Math.atan2(ty - cy, tx - cx) - a0;
        if (motion === 2) { if (sweep >= -1e-9) sweep -= TAU; } else if (sweep <= 1e-9) sweep += TAU;
        const n = Math.max(8, Math.ceil(Math.abs(sweep) / (Math.PI / 36)));
        let px = x, py = y, pz = z;
        for (let k = 1; k <= n; k++) {
          const t = k / n, a = a0 + sweep * t, rr = r0 + (r1 - r0) * t;
          const nx = k === n ? tx : cx + rr * Math.cos(a), ny = k === n ? ty : cy + rr * Math.sin(a), nz = z + (tz - z) * t;
          emit(true, idx, nx, ny, nz, px, py, pz);
          px = nx; py = ny; pz = nz;
        }
        x = tx; y = ty; z = tz;
        return;
      }
    }
    emit(isCut, idx, tx, ty, tz, x, y, z);
    x = tx; y = ty; z = tz;
  });

  // Cutting starts at the work surface: the first cut may be a plunge to -3, but the tool came down from Z0, so
  // the cutting depth range is the surface (0) to the deepest cut, not -3 to the deepest cut.
  if (ext.cut && ext.cut.maxZ < 0) ext = { ...ext, cut: { ...ext.cut, maxZ: 0 } };

  return {
    extents: ext,
    cut: Float32Array.from(cut), rapid: Float32Array.from(rapid),
    cutLine: Uint32Array.from(cutLine), rapidLine: Uint32Array.from(rapidLine),
  };
}
