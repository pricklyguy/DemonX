/** 3D toolpaths: cutting a relief (a height grid, see relief.ts) with parallel lines. Millimetres, Y up, Z up from the work zero (the top of the model is Z 0). */
import { Builder, resultOf, zAt, type ToolpathResult } from './cam';
import { toolProfile, type CncTool, type Toolpath } from './cnc';
import { reliefCells, reliefHeightMm, type Relief } from './relief';
import { fingerprint } from './hash';
import type { Doc } from './types';

interface Footprint { di: Int16Array; dj: Int16Array; off: Float32Array }

/** The cells under the tool and how far below the tool's lowest point the cutting surface is at each (0 or less): the tool centre may go as low as the highest (surface height plus offset) over them. Cells where the tool is higher than the whole shape cannot matter and are left out (a long taper is mostly that). */
function footprintOf(tool: CncTool, cell: number, height: number): Footprint {
  const { rMax, z } = toolProfile(tool);
  const n = Math.ceil(rMax / cell);
  const di: number[] = [], dj: number[] = [], off: number[] = [];
  for (let j = -n; j <= n; j++) {
    for (let i = -n; i <= n; i++) {
      const d = Math.hypot(i, j) * cell;
      if (d > rMax + 1e-9) continue;
      const zp = z(d);
      if (zp > height) continue;
      di.push(i); dj.push(j); off.push(-zp);
    }
  }
  return { di: Int16Array.from(di), dj: Int16Array.from(dj), off: Float32Array.from(off) };
}

/** Lowest height of the tool's tip (mm above the bottom of the model) that does not cut into the relief at a point of the work. */
export class DropCutter {
  readonly cells: Uint16Array;
  readonly k: number;
  readonly cell: number;
  private fp: Footprint;
  /** `cells` (the grid of `r`) is given when a coarser grid than the stored one is wanted */
  constructor(readonly r: Relief, tool: CncTool, cells?: Uint16Array) {
    this.cells = cells ?? reliefCells(r);
    this.k = r.depth / 65535;
    this.cell = r.width / r.w;
    this.fp = footprintOf(tool, this.cell, r.depth);
  }
  tipAt(x: number, y: number): number {
    const { r, cells, k, fp } = this;
    const ci = Math.floor((x - r.x) / this.cell), cj = Math.floor((r.y + r.h * this.cell - y) / this.cell);
    let best = 0;
    for (let n = 0; n < fp.off.length; n++) {
      const i = ci + fp.di[n], j = cj + fp.dj[n];
      if (i < 0 || j < 0 || i >= r.w || j >= r.h) continue;
      const v = cells[j * r.w + i] * k + fp.off[n];
      if (v > best) best = v;
    }
    return best;
  }
}

const MOVE_CAP = 600000;
const TOL = 0.02;

const cache = new Map<string, ToolpathResult>();

/** Working out a big 3D toolpath takes seconds and the screen asks for it again at every change, so the last few results are kept (keyed by everything that goes into them). */
export function buildFinish3d(doc: Doc, tp: Toolpath, tool: CncTool): ToolpathResult {
  const rel = (doc.reliefs ?? []).find((r) => r.id === tp.reliefId);
  const ws = doc.workspace;
  const key = JSON.stringify([rel ? [rel.x, rel.y, rel.width, rel.depth, rel.w, rel.h, fingerprint(rel.data)] : null, tool.kind, tool.diameter, tool.vAngle, tool.stepdown, tp.scan, tp.allowance, tp.safeZ, ws.kind, ws.kind === 'cnc' ? [ws.zZero, ws.thickness] : null]);
  const hit = cache.get(key);
  if (hit) return hit;
  const result = buildFinish3dUncached(doc, tp, tool);
  cache.set(key, result);
  if (cache.size > 4) cache.delete(cache.keys().next().value as string);
  return result;
}

/** Parallel lines over the whole relief, zig-zag, the tool following the surface (the drop cutter), moves thinned within 0.02 mm and never below the surface. */
function buildFinish3dUncached(doc: Doc, tp: Toolpath, tool: CncTool): ToolpathResult {
  const warnings: string[] = [];
  const relief = (doc.reliefs ?? []).find((r) => r.id === tp.reliefId);
  const b = new Builder(tool, zAt(doc, -tp.safeZ), zAt(doc, 0));
  if (!relief) { warnings.push('The 3D shape this toolpath cuts is not in the job any more'); return resultOf(b, warnings); }
  if (!tp.scan) { warnings.push('This toolpath has no line settings'); return resultOf(b, warnings); }
  if (tool.kind === 'drill') { warnings.push('A drill cannot cut a 3D shape: pick a ball nose, an end mill or a V-bit'); return resultOf(b, warnings); }
  if (tool.kind === 'vbit' && !(tool.vAngle && tool.vAngle > 0)) { warnings.push('This V-bit has no angle set'); return resultOf(b, warnings); }
  const scan = tp.scan;
  const ws = doc.workspace;
  if (ws.kind === 'cnc' && relief.depth > ws.thickness + 1e-9) warnings.push(`The shape is ${relief.depth} mm high and the material ${ws.thickness} mm: the tool goes into the spoilboard`);
  if (relief.depth > Math.max(tool.stepdown * 3, tool.diameter)) warnings.push('This cuts the full depth in one go. Rough the shape out first (3D roughing) or the tool will be overloaded.');
  const dc = new DropCutter(relief, tool);
  const W = relief.width, H = reliefHeightMm(relief);
  const FAR = 'The lines are far apart for this tool: the surface will be rough';
  /** One pass of parallel lines over the whole shape, along X or along Y. Returns how many lines it made. */
  const pass = (alongX: boolean): number => {
    const alongLen = alongX ? W : H, acrossLen = alongX ? H : W;
    // sampled at half a cell (at least 0.05 mm): the height the tool must be at can change by a lot over one cell on a steep wall
    const ds = Math.max(dc.cell / 2, 0.05);
    const nAlong = Math.max(1, Math.ceil(alongLen / ds));
    const lines = Math.max(1, Math.ceil(acrossLen / scan.stepoverMm));
    const step = acrossLen / lines;
    if (step > tool.diameter * 0.75 && !warnings.includes(FAR)) warnings.push(FAR);
    if (lines + 1 > 200000) { warnings.push('Too many lines; use a bigger stepover'); return 0; }
    const at = (along: number, across: number): [number, number] => (alongX ? [relief.x + along, relief.y + across] : [relief.x + across, relief.y + along]);
    const raise = tp.allowance;
    type S = { s: number; x: number; y: number; z: number; corner: boolean };
    const path: S[] = [];
    let s = 0;
    const push = (x: number, y: number, corner = false) => {
      const tip = Math.min(relief.depth + raise, dc.tipAt(x, y) + raise);
      path.push({ s, x, y, z: zAt(doc, relief.depth - tip), corner });
    };
    let capped = false;
    for (let j = 0; j <= lines && !capped; j++) {
      const across = j * step;
      const forward = j % 2 === 0;
      for (let k = 0; k <= nAlong; k++) {
        const along = forward ? Math.min(alongLen, k * ds) : alongLen - Math.min(alongLen, k * ds);
        const [x, y] = at(along, across);
        if (path.length) { const l = path[path.length - 1]; s += Math.hypot(x - l.x, y - l.y); }
        push(x, y, k === 0 || k === nAlong);
      }
      // across to the next line at this end, sampled so the surface under the connecting move is still followed
      if (j < lines) {
        const along = forward ? alongLen : 0;
        const n = Math.max(1, Math.ceil(step / ds));
        for (let q = 1; q < n; q++) {   // the last of the n steps is the first point of the next line
          const [x, y] = at(along, across + (step * q) / n);
          const l = path[path.length - 1];
          s += Math.hypot(x - l.x, y - l.y);
          push(x, y);
        }
      }
      if (path.length > MOVE_CAP * 3) { capped = true; warnings.push('Too many points; the rest was left out. Use a bigger stepover.'); }
    }
    // the tool's lowest height can change fast on a steep wall and a straight line between two samples would cut across it, so each sample is lifted
    // to the highest of itself and its two neighbours
    const zRaw = path.map((p) => p.z);
    for (let i = 0; i < path.length; i++) path[i].z = Math.max(zRaw[i], i > 0 ? zRaw[i - 1] : -Infinity, i + 1 < path.length ? zRaw[i + 1] : -Infinity);
    // thin each straight run (a line, or the move across to the next one) to the fewest points that stay within TOL of the true height; the tool's z is
    // raised by TOL / 2 so the thinned line stays on or above the surface. The corners between runs are always kept.
    const zs = (p: S) => p.z + TOL / 2;
    const out: S[] = [];
    const thin = (from: number, to: number) => {
      let anchor = path[from], lo = -Infinity, hi = Infinity, prev = path[from];
      out.push(anchor);
      for (let k = from + 1; k <= to;) {
        const q = path[k];
        const d = q.s - anchor.s;
        if (!(d > 0)) { prev = q; k++; continue; }
        const nlo = Math.max(lo, (zs(q) - TOL / 2 - zs(anchor)) / d), nhi = Math.min(hi, (zs(q) + TOL / 2 - zs(anchor)) / d);
        if (nlo > nhi) { out.push(prev); anchor = prev; lo = -Infinity; hi = Infinity; } else { lo = nlo; hi = nhi; prev = q; k++; }
      }
      if (out[out.length - 1] !== path[to]) out.push(path[to]);
    };
    let from = 0;
    for (let k = 1; k < path.length; k++) if (path[k].corner || k === path.length - 1) { if (k > from) thin(from, k); from = k; }
    const kept = out.filter((p, i) => i === 0 || p !== out[i - 1]);   // by a loop: spreading a long list into push overflows the stack
    if (kept.length > MOVE_CAP) warnings.push(`This is a very big toolpath (${kept.length.toLocaleString()} moves). A bigger stepover makes a smaller file.`);
    b.enter(kept[0].x, kept[0].y, zs(kept[0]), zAt(doc, 0));
    for (let k = 1; k < kept.length; k++) b.cutTo(kept[k].x, kept[k].y, zs(kept[k]));
    b.retract();
    return lines + 1;
  };
  const first = scan.dir === 'x';
  b.passes = pass(first);
  // a second pass at right angles to the first, over the same surface
  if (scan.cross) b.passes += pass(!first);
  return resultOf(b, warnings);
}


/** The relief on a coarser grid (each cell the highest of the cells it covers), keeping its top edge and left edge where they were. */
function coarsen(r: Relief, cells: Uint16Array, block: number): { r2: Relief; cells2: Uint16Array } {
  if (block <= 1) return { r2: r, cells2: cells };
  const w2 = Math.ceil(r.w / block), h2 = Math.ceil(r.h / block);
  const out = new Uint16Array(w2 * h2);
  for (let j = 0; j < r.h; j++) {
    const oj = Math.floor(j / block) * w2;
    for (let i = 0; i < r.w; i++) {
      const v = cells[j * r.w + i], o = oj + Math.floor(i / block);
      if (v > out[o]) out[o] = v;
    }
  }
  const cs = (r.width / r.w) * block;
  const H = (r.width * r.h) / r.w;
  return { r2: { ...r, w: w2, h: h2, width: w2 * cs, y: r.y + H - h2 * cs }, cells2: out };
}

/**
 * 3D roughing: clear the material above the shape level by level, leaving an allowance on the surface for finishing. At each level (the tool's
 * step-down apart) the tool cuts, in parallel lines, wherever the drop cutter says it may go that low; the rest of the shape stands in the way.
 * Worked out on a coarser grid (the cell no smaller than a twelfth of the tool, each cell the highest it covers, the tool a cell wider) so it is
 * quick and never goes below the surface plus the allowance.
 */
export function buildRough3d(doc: Doc, tp: Toolpath, tool: CncTool): ToolpathResult {
  const warnings: string[] = [];
  const relief = (doc.reliefs ?? []).find((r) => r.id === tp.reliefId);
  const b = new Builder(tool, zAt(doc, -tp.safeZ), zAt(doc, 0));
  if (!relief) { warnings.push('The 3D shape this toolpath cuts is not in the job any more'); return resultOf(b, warnings); }
  if (!tp.scan) { warnings.push('This toolpath has no line settings'); return resultOf(b, warnings); }
  if (tool.kind === 'drill') { warnings.push('A drill cannot rough out a 3D shape: pick an end mill or a ball nose'); return resultOf(b, warnings); }
  if (tool.kind === 'vbit') warnings.push('A V-bit is not a roughing tool: it takes very little at a time');
  const scan = tp.scan;
  const ws = doc.workspace;
  if (ws.kind === 'cnc' && relief.depth > ws.thickness + 1e-9) warnings.push(`The shape is ${relief.depth} mm high and the material ${ws.thickness} mm: the tool goes into the spoilboard`);
  const allowance = Math.max(0, tp.allowance);
  const span = relief.depth - allowance;
  if (!(span > 1e-6)) { warnings.push('The allowance is as big as the shape is high: nothing to rough out'); return resultOf(b, warnings); }
  const fineCell = relief.width / relief.w;
  const block = Math.max(1, Math.round(tool.diameter / 12 / fineCell));
  const { r2, cells2 } = coarsen(relief, reliefCells(relief), block);
  const cs = r2.width / r2.w;
  const dc = new DropCutter(r2, { ...tool, diameter: tool.diameter + 2 * cs, ...(tool.maxDiameter ? { maxDiameter: tool.maxDiameter + 2 * cs } : {}), kind: tool.kind === 'ball' ? 'ball' : 'flat' }, cells2);
  const W = relief.width, H = reliefHeightMm(relief);
  const alongX = scan.dir === 'x';
  const alongLen = alongX ? W : H, acrossLen = alongX ? H : W;
  const step = scan.stepoverMm;
  const lines = Math.max(1, Math.ceil(acrossLen / step));
  const spacing = acrossLen / lines;
  if (spacing > tool.diameter * 0.9) warnings.push('The lines are further apart than the tool is wide: strips will be left');
  const nAlong = Math.max(1, Math.ceil(alongLen / cs));
  const levelsN = Math.max(1, Math.ceil(span / Math.max(0.05, tool.stepdown) - 1e-9));
  if (levelsN * (lines + 1) > 400000) { warnings.push('Too many passes; use a bigger step-down or stepover'); return resultOf(b, warnings); }
  const at = (along: number, across: number): [number, number] => (alongX ? [relief.x + along, relief.y + across] : [relief.x + across, relief.y + along]);
  // the lowest height the tool tip may be at each sample of each line (the surface plus the allowance), worked out once
  const lows: Float32Array[] = [];
  for (let j = 0; j <= lines; j++) {
    const row = new Float32Array(nAlong + 1);
    for (let k = 0; k <= nAlong; k++) { const [x, y] = at(Math.min(alongLen, k * cs), j * spacing); row[k] = dc.tipAt(x, y) + allowance; }
    lows.push(row);
  }
  const MOVE_CAP = 600000;
  const tanRamp = tp.rampAngle && tp.rampAngle > 0 ? Math.tan((Math.min(45, tp.rampAngle) * Math.PI) / 180) : 0;
  let plunged = 0;
  let cuts = 0;
  for (let lv = 1; lv <= levelsN && b.moves.length < MOVE_CAP; lv++) {
    const L = relief.depth - (span * lv) / levelsN;   // tip height above the bottom of the model
    const z = zAt(doc, relief.depth - L);
    const zAbove = zAt(doc, (span * (lv - 1)) / levelsN);   // the level above, already cleared (the top of the material for the first)
    let prevEnd: [number, number, number] | null = null;   // the end of the last run, and its line
    for (let j = 0; j <= lines; j++) {
      const forward = j % 2 === 0;
      const row = lows[j];
      // runs of samples where the tool may be at this level, along this line, in the order of travel
      let k = forward ? 0 : nAlong;
      const dk = forward ? 1 : -1;
      while (k >= 0 && k <= nAlong) {
        if (row[k] > L + 1e-6) { k += dk; continue; }
        const start = k;
        while (k >= 0 && k <= nAlong && row[k] <= L + 1e-6) k += dk;
        const end = k - dk;
        const [sx, sy] = at(Math.min(alongLen, start * cs), j * spacing);
        const [ex, ey] = at(Math.min(alongLen, end * cs), j * spacing);
        // the move across to the next line is cut (no lift) when it is one stepover long and the tool may be where it goes
        const joined = prevEnd !== null && prevEnd[2] === j - 1 && Math.hypot(sx - prevEnd[0], sy - prevEnd[1]) <= spacing * 1.01 + 1e-9
          && dc.tipAt((prevEnd[0] + sx) / 2, (prevEnd[1] + sy) / 2) + allowance <= L + 1e-6;
        if (joined) {
          b.cutTo(sx, sy, z);
          if (end !== start) b.cutTo(ex, ey, z);
        } else {
          if (prevEnd) b.retract();
          const len = Math.hypot(ex - sx, ey - sy), drop = zAbove - z;
          if (tanRamp > 0 && len > 1e-6 && drop > 1e-9) {
            // ramp in: down along the run (and back along it, as often as it takes) from the level above, which is already cleared, then cut the whole run at the level
            b.enter(sx, sy, zAbove, zAbove);
            let pos = 0, sign = 1, zc = zAbove;
            while (zc > z + 1e-9) {
              const room = sign > 0 ? len - pos : pos;
              const run = Math.min(room, (zc - z) / tanRamp);
              pos += sign * run; zc -= run * tanRamp;
              if (zc < z + 1e-9) zc = z;
              b.cutTo(sx + ((ex - sx) * pos) / len, sy + ((ey - sy) * pos) / len, zc);
              if (zc > z) sign = -sign;
            }
            if (pos > 1e-9) b.cutTo(sx, sy, z);
            b.cutTo(ex, ey, z);
          } else {
            if (tanRamp > 0 && drop > 1e-9) plunged++;
            b.enter(sx, sy, z, zAbove);
            if (end !== start) b.cutTo(ex, ey, z);
          }
        }
        prevEnd = [ex, ey, j];
        cuts++;
      }
    }
    b.retract();
    b.passes++;
  }
  if (b.moves.length >= MOVE_CAP) warnings.push('This is a very big toolpath; the rest was left out. Use a bigger step-down or stepover.');
  if (plunged) warnings.push(`${plunged} places were too short to ramp into and were plunged instead`);
  if (!cuts) warnings.push('Nothing to rough out: the shape fills the area, or the allowance is too big');
  return resultOf(b, warnings);

}
