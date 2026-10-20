/** From a toolpath definition to moves: profile, pocket and drill. Millimetres, Y up, Z up from the work zero. */
import { base64ToBytes, type CncTool, type Toolpath } from './cnc';
import { offsetShape } from './clip';
import { anchorOf } from './gadgets';
import { shapeBounds, shapeClosed, shapeRings } from './geom';
import type { Move3 } from './post';
import type { Doc, PathShape, Pt, Shape } from './types';

export interface ToolpathResult {
  moves: Move3[];
  warnings: string[];
  stats: { cutLength: number; rapidLength: number; seconds: number; passes: number; bounds: { minX: number; minY: number; maxX: number; maxY: number } | null };
}

const EPS = 1e-9;
const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const ringArea = (r: Pt[]) => { let a = 0; for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; a += p[0] * q[1] - q[0] * p[1]; } return Math.abs(a) / 2; };

/** The height of the top of the material minus `depth`, in the job's Z. */
export function zAt(doc: Doc, depth: number): number {
  const ws = doc.workspace;
  return ws.kind === 'cnc' && ws.zZero === 'bed' ? ws.thickness - depth : -depth;
}

/** How far the nearest point of the original outline is, and which side of the travel direction it is on (+1 = left). */
function materialSide(ring: Pt[], original: Pt[][], closed: boolean): number {
  const a = ring[0], b = ring[1 % ring.length];
  const mid: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const left: Pt = [-(b[1] - a[1]), b[0] - a[0]];
  let best = Infinity, dir: Pt = [0, 0];
  for (const o of original) {
    const n = closed ? o.length : o.length - 1;
    for (let i = 0; i < n; i++) {
      const p = o[i], q = o[(i + 1) % o.length];
      const dx = q[0] - p[0], dy = q[1] - p[1];
      const l2 = dx * dx + dy * dy;
      const t = l2 < EPS ? 0 : Math.max(0, Math.min(1, ((mid[0] - p[0]) * dx + (mid[1] - p[1]) * dy) / l2));
      const c: Pt = [p[0] + t * dx, p[1] + t * dy];
      const d = dist(mid, c);
      if (d < best) { best = d; dir = [c[0] - mid[0], c[1] - mid[1]]; }
    }
  }
  return left[0] * dir[0] + left[1] * dir[1] >= 0 ? 1 : -1;
}

/** Depths to cut at, from start to cut, none deeper than the stepdown apart. */
export function depthLevels(start: number, cut: number, stepdown: number): number[] {
  const total = cut - start;
  if (!(total > 0) || !(stepdown > 0)) return [];
  const n = Math.ceil(total / stepdown - 1e-9);
  return Array.from({ length: n }, (_, i) => start + (total * (i + 1)) / n);
}

export class Builder {
  moves: Move3[] = [];
  cutLength = 0;
  rapidLength = 0;
  cutTime = 0;
  passes = 0;
  private at: [number, number, number] | null = null;
  constructor(private tool: CncTool, private zSafe: number, private zTop: number) {}
  private go(kind: Move3['kind'], x: number, y: number, z: number) {
    if (this.at) {
      const d = Math.hypot(x - this.at[0], y - this.at[1], z - this.at[2]);
      if (kind === 'rapid') this.rapidLength += d;
      else { this.cutLength += d; this.cutTime += d / ((kind === 'plunge' ? this.tool.plunge : this.tool.feed) / 60 || 1); }
    }
    this.moves.push({ kind, x, y, z });
    this.at = [x, y, z];
  }
  /** Rapid to above (x, y), come down to just above the top of the cut, plunge to z. */
  enter(x: number, y: number, z: number, zFrom: number) {
    if (!this.at || this.at[0] !== x || this.at[1] !== y || this.at[2] < this.zSafe) this.go('rapid', x, y, this.zSafe);
    const clear = Math.min(this.zSafe, zFrom + 1);
    if (this.at![2] > clear) this.go('rapid', x, y, clear);
    this.go('plunge', x, y, z);
  }
  cutTo(x: number, y: number, z: number) { this.go('cut', x, y, z); }
  retract() { if (this.at) this.go('rapid', this.at[0], this.at[1], this.zSafe); }
  get position() { return this.at; }
}

/** Order closed or open paths so the smallest come first (so a hole is cut before the outline around it), then nearest next. */
function order(paths: { ring: Pt[]; closed: boolean }[]): { ring: Pt[]; closed: boolean }[] {
  return [...paths].sort((a, b) => ringArea(a.ring) - ringArea(b.ring));
}

const signedArea = (r: Pt[]) => { let a = 0; for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; };

/** Engraving order: each path next to where the tool is, open lines run from their nearer end, loops start at their nearest corner. */
function nearestFirst(paths: { ring: Pt[]; closed: boolean }[], from: Pt): { ring: Pt[]; closed: boolean }[] {
  const left = [...paths];
  const out: { ring: Pt[]; closed: boolean }[] = [];
  let at = from;
  while (left.length) {
    let bi = 0, bd = Infinity, bring: Pt[] = left[0].ring;
    left.forEach((p, i) => {
      if (p.closed) {
        p.ring.forEach((q, k) => { const d = dist(at, q); if (d < bd) { bd = d; bi = i; bring = [...p.ring.slice(k), ...p.ring.slice(0, k)]; } });
      } else {
        const d0 = dist(at, p.ring[0]), d1 = dist(at, p.ring[p.ring.length - 1]);
        if (d0 < bd) { bd = d0; bi = i; bring = p.ring; }
        if (d1 < bd) { bd = d1; bi = i; bring = [...p.ring].reverse(); }
      }
    });
    const pick = left.splice(bi, 1)[0];
    out.push({ ring: bring, closed: pick.closed });
    at = pick.closed ? bring[0] : bring[bring.length - 1];
  }
  return out;
}

function cutRings(b: Builder, rings: { ring: Pt[]; closed: boolean }[], levels: number[], zOf: (depth: number) => number, topDepth: number) {
  for (const { ring, closed } of rings) {
    const start = ring[0];
    const pts = closed ? [...ring.slice(1), ring[0]] : ring.slice(1);
    levels.forEach((depth, k) => {
      const z = zOf(depth);
      if (k === 0 || !closed) b.enter(start[0], start[1], z, zOf(topDepth));
      else b.cutTo(start[0], start[1], z); // closed outlines step down where they ended, which is where they began
      for (const p of pts) b.cutTo(p[0], p[1], z);
      b.passes++;
      if (!closed && k < levels.length - 1) b.retract();
    });
    b.retract();
  }
}

/** What a V-bit can do: the tangent of half its angle, the deepest it may go, and the depth between rings. Null (with a warning) when it is not a V-bit. */
function vbitInfo(tool: CncTool, wanted: number, warnings: string[]): { tanH: number; maxDepth: number; dd: number } | null {
  const half = ((tool.vAngle ?? 0) * Math.PI) / 360;
  if (tool.kind !== 'vbit' || !(half > 0 && half < Math.PI / 2)) { warnings.push('V-carving needs a V-bit with its angle set'); return null; }
  const tanH = Math.tan(half);
  const reach = tool.diameter / 2 / tanH;   // the deepest this bit can go before its shank is in the cut
  let maxDepth = wanted;
  if (maxDepth > reach + 1e-9) { warnings.push(`This V-bit can only go ${reach.toFixed(2)} mm deep, so the depth is limited to that`); maxDepth = reach; }
  return { tanH, maxDepth, dd: Math.min(0.5, Math.max(0.1, tool.stepdown / 4)) };
}

export function buildToolpath(doc: Doc, tp: Toolpath, tool: CncTool): ToolpathResult {
  const warnings: string[] = [];
  const shapes = tp.shapeIds.map((id) => doc.shapes.find((s) => s.id === id)).filter((s): s is Shape => !!s);
  const mirror = tp.mirror === true;
  // a mirrored toolpath is worked out as the other direction and flipped at the end, so climb stays climb
  const dirKind = mirror ? (tp.direction === 'climb' ? 'conventional' : 'climb') : tp.direction;
  if (shapes.length < tp.shapeIds.length) warnings.push(`${tp.shapeIds.length - shapes.length} shape(s) of this toolpath no longer exist`);
  const ws = doc.workspace;
  const zSafe = zAt(doc, -tp.safeZ);
  const zOf = (depth: number) => zAt(doc, depth);
  const b = new Builder(tool, zSafe, zAt(doc, 0));
  const levels = depthLevels(tp.startDepth, tp.cutDepth, tool.stepdown);
  if (!levels.length) warnings.push('The cut depth must be greater than the start depth');
  if (ws.kind === 'cnc' && tp.cutDepth > ws.thickness + 1e-9) warnings.push(`Cuts ${tp.cutDepth} mm deep into ${ws.thickness} mm material: the tool goes into the spoilboard`);
  const r = tool.diameter / 2;

  if (tp.kind === 'profile') {
    const out: { ring: Pt[]; closed: boolean }[] = [];
    for (const s of shapes) {
      const closed = shapeClosed(s);
      if (tp.side === 'on' || !closed) {
        if (tp.side !== 'on' && !closed) warnings.push('An open line can only be cut "on" the line');
        for (const ring of shapeRings(s)) out.push({ ring, closed });
        continue;
      }
      const dist = (tp.side === 'outside' ? 1 : -1) * (r + tp.allowance);
      const result = offsetShape(s, dist, 'round');
      if (!result.length) warnings.push(`A shape is too small for this tool to cut ${tp.side} it`);
      for (const ring of result) out.push({ ring, closed: true });
    }
    const wantLeft = dirKind === 'climb' ? 1 : -1;
    const closedOriginal = shapes.flatMap((s) => shapeRings(s));
    const oriented = out.map(({ ring, closed }) => {
      if (tp.side === 'on' && !closed) return { ring, closed };
      if (ring.length < 3) return { ring, closed };
      if (tp.side === 'on') return { ring, closed }; // on the line there is no inside to take a side from
      return { ring: materialSide(ring, closedOriginal, true) === wantLeft ? ring : [...ring].reverse(), closed };
    });
    cutRings(b, order(oriented), levels, zOf, tp.startDepth);
  } else if (tp.kind === 'engrave') {
    // follow the lines themselves, open or closed, at the cut depth: no side, no offset. A loop is cut counter-clockwise for climb, clockwise for conventional.
    if (tool.kind === 'drill') warnings.push('A drill cannot engrave: pick an end mill, a ball nose or a V-bit');
    const paths: { ring: Pt[]; closed: boolean }[] = [];
    for (const s of shapes) {
      const closed = shapeClosed(s);
      for (const raw of shapeRings(s)) {
        let ring = raw;
        if (closed && ring.length > 1 && dist(ring[0], ring[ring.length - 1]) < EPS) ring = ring.slice(0, -1);
        if (ring.length < (closed ? 3 : 2)) { if (ring.length) warnings.push('A shape with too few points was skipped'); continue; }
        if (closed && (signedArea(ring) > 0) !== (dirKind === 'climb')) ring = [...ring].reverse();
        paths.push({ ring, closed });
      }
    }
    cutRings(b, nearestFirst(paths, [0, 0]), levels, zOf, tp.startDepth);
  } else if (tp.kind === 'vcarve') {
    // a V-bit with its centre r mm in from the wall cuts r / tan(half the angle) deep, so each ring in from the edge is cut at the depth that just
    // touches the wall. The depth stops at the cut depth (the deepest the bit may go), and rings past that are spaced to clear the flat part.
    // An allowance grows the shape first (the glue gap of an inlay pocket).
    const info = vbitInfo(tool, tp.cutDepth, warnings);
    if (info) {
      const { tanH, maxDepth, dd } = info;
      const flat = maxDepth * tanH;                  // how far in from the wall the full depth is reached
      const dists: number[] = [];
      for (let k = 1; k * dd < maxDepth - 1e-9; k++) dists.push(k * dd * tanH);
      for (let d = flat; dists.length < 400; d += Math.max(0.1, flat * 0.5)) dists.push(d);
      const wantLeft = dirKind === 'climb' ? 1 : -1;
      const closedShapes = shapes.filter((s) => shapeClosed(s));
      if (closedShapes.length < shapes.length) warnings.push('V-carving needs closed shapes; open lines were skipped');
      for (const s0 of closedShapes) {
        let s: Shape = s0;
        if (tp.allowance > 0) { const grown = offsetShape(s0, tp.allowance, 'round'); if (grown.length) s = { id: 0, kind: 'path', layer: s0.layer, rings: grown, closed: true } as PathShape; }
        const original = shapeRings(s);
        let any = false;
        for (const d of dists) {
          const rings = offsetShape(s, -d, 'round');
          if (!rings.length) break;
          any = true;
          const z = zOf(Math.min(maxDepth, d / tanH));
          for (let ring of rings) {
            if (ring.length < 3) continue;
            if (materialSide(ring, original, true) !== wantLeft) ring = [...ring].reverse();
            b.enter(ring[0][0], ring[0][1], z, zOf(0));
            for (const p of [...ring.slice(1), ring[0]]) b.cutTo(p[0], p[1], z);
            b.retract();
          }
          b.passes++;
        }
        if (!any) warnings.push('A shape is too narrow for this V-bit to carve');
      }
    }
  } else if (tp.kind === 'plug') {
    // the plug of an inlay: a chamfer cut round the inside of the outline. The ring c mm in from the outline is cut at the depth where the
    // bit's inner face is on the chamfer, which is the mate of the V-carved pocket's wall (the full pocket depth at the outline, 0 at c = depth x tan).
    const info = vbitInfo(tool, tp.cutDepth, warnings);
    if (info) {
      const { tanH, maxDepth, dd } = info;
      const wantLeft = dirKind === 'climb' ? 1 : -1;
      const closedShapes = shapes.filter((s) => shapeClosed(s));
      if (closedShapes.length < shapes.length) warnings.push('A plug needs closed shapes; open lines were skipped');
      for (const s of closedShapes) {
        const original = shapeRings(s);
        let any = false;
        for (let k = 0; k * dd < maxDepth - 1e-9; k++) {
          const c = k * dd * tanH;
          const rings = k === 0 ? original : offsetShape(s, -c, 'round');
          if (!rings.length) break;
          any = true;
          const z = zOf(maxDepth - k * dd);
          for (let ring of rings) {
            if (ring.length < 3) continue;
            if (materialSide(ring, original, true) !== wantLeft) ring = [...ring].reverse();
            b.enter(ring[0][0], ring[0][1], z, zOf(0));
            for (const p of [...ring.slice(1), ring[0]]) b.cutTo(p[0], p[1], z);
            b.retract();
          }
          b.passes++;
        }
        if (!any) warnings.push('A shape is too small for this plug');
      }
    }
  } else if (tp.kind === 'pocket') {
    const step = Math.max(0.05, (tool.stepover / 100) * tool.diameter);
    const closedShapes = shapes.filter((s) => shapeClosed(s));
    if (closedShapes.length < shapes.length) warnings.push('Pockets need closed shapes; open lines were skipped');
    const wantLeft = dirKind === 'climb' ? 1 : -1;
    const levelsOfRings: { ring: Pt[]; closed: boolean }[] = [];
    for (const s of closedShapes) {
      let current: Pt[][] = offsetShape(s, -(r + tp.allowance), 'round');
      if (!current.length) { warnings.push('A shape is too small for this tool to pocket'); continue; }
      const original = shapeRings(s);
      let guard = 0;
      while (current.length && guard++ < 500) {
        for (const ring of current) {
          if (ring.length < 3) continue;
          // the material is outside the pocket wall, so "left" means towards the wall
          levelsOfRings.push({ ring: materialSide(ring, original, true) === wantLeft ? ring : [...ring].reverse(), closed: true });
        }
        const next: Pt[][] = [];
        const temp: PathShape = { id: 0, kind: 'path', layer: s.layer, rings: current, closed: true };
        next.push(...offsetShape(temp, -step, 'round'));
        current = next;
      }
    }
    // deepest-first is wrong for pockets: clear each depth level completely before going deeper
    for (const depth of levels) {
      for (const { ring } of levelsOfRings) {
        const start = ring[0];
        b.enter(start[0], start[1], zOf(depth), zOf(tp.startDepth));
        for (const p of [...ring.slice(1), ring[0]]) b.cutTo(p[0], p[1], zOf(depth));
        b.retract();
      }
      b.passes++;
    }
  } else if (tp.kind === 'photo') {
    // a picture engraved as lines (the depth follows the brightness along each line) or as dots (a hole at each point, as deep as it is dark)
    const ph = tp.photo;
    if (!ph) warnings.push('This photo toolpath has no picture');
    else {
      if (tool.kind === 'drill') warnings.push('A drill cannot engrave a photo: pick a V-bit, a ball nose or an end mill');
      const gray = base64ToBytes(ph.data);
      const imgH = (ph.width * ph.h) / ph.w;
      const at = (px: number, py: number) => gray[Math.min(ph.h - 1, Math.max(0, py)) * ph.w + Math.min(ph.w - 1, Math.max(0, px))];
      /** 0 (nothing) to 1 (the deepest) at a point of the work, from the picture's brightness (bilinear between its pixels) */
      const depthAt = (x: number, y: number): number => {
        const u = ((x - ph.x) / ph.width) * ph.w - 0.5, v = ((ph.y + imgH - y) / imgH) * ph.h - 0.5;
        const u0 = Math.floor(u), v0 = Math.floor(v), fu = u - u0, fv = v - v0;
        const g = (at(u0, v0) * (1 - fu) + at(u0 + 1, v0) * fu) * (1 - fv) + (at(u0, v0 + 1) * (1 - fu) + at(u0 + 1, v0 + 1) * fu) * fv;
        const dark = 1 - g / 255;
        return ph.invert ? 1 - dark : dark;
      };
      const span = tp.cutDepth - tp.startDepth;
      const MOVE_CAP = 400000;
      const tanH = tool.kind === 'vbit' && tool.vAngle ? Math.tan((tool.vAngle * Math.PI) / 360) : 0;
      if (span <= 0) warnings.push('The cut depth must be greater than the start depth');
      else if (ph.mode === 'dots') {
        const cols = Math.floor(ph.width / ph.spacing), rows = Math.floor(imgH / ph.spacing);
        let capped = false;
        for (let j = 0; j < rows && !capped; j++) {
          const y = ph.y + (j + 0.5) * ph.spacing;
          for (let ii = 0; ii < cols; ii++) {
            const i = j % 2 ? cols - 1 - ii : ii;
            const x = ph.x + (i + 0.5) * ph.spacing;
            const d = depthAt(x, y);
            if (d < 0.05) continue;
            b.enter(x, y, zOf(tp.startDepth + d * span), zOf(tp.startDepth));
            b.retract();
            if (b.moves.length > MOVE_CAP) { capped = true; break; }
          }
          b.passes++;
        }
        if (capped) warnings.push('The photo has too many dots; the rest were left out. Use a bigger spacing.');
        if (tanH && 2 * tp.cutDepth * tanH > ph.spacing * 1.5) warnings.push('The deepest dots are wider than the spacing, so they will run together');
      } else {
        const alongLen = ph.dir === 'x' ? ph.width : imgH, acrossLen = ph.dir === 'x' ? imgH : ph.width;
        const ds = Math.max(0.2, ph.spacing / 2, ph.width / ph.w);
        const n = Math.max(1, Math.ceil(alongLen / ds));
        const rows = Math.floor(acrossLen / ph.spacing);
        const at2 = (along: number, across: number): [number, number] => (ph.dir === 'x' ? [ph.x + along, ph.y + across] : [ph.x + across, ph.y + along]);
        const TOL = 0.02, GAP = 2;
        let capped = false;
        for (let j = 0; j < rows && !capped; j++) {
          const across = (j + 0.5) * ph.spacing;
          // the depth at each sample along the line, nearest the start of the line first (every other line runs back)
          const samples: { s: number; p: [number, number]; d: number }[] = [];
          for (let k = 0; k <= n; k++) {
            const along = j % 2 ? alongLen - Math.min(alongLen, k * ds) : Math.min(alongLen, k * ds);
            const p = at2(along, across);
            samples.push({ s: k * ds, p, d: depthAt(p[0], p[1]) });
          }
          // runs of cutting; a short light stretch inside a run is cut through at the top rather than lifted over
          let run: { s: number; p: [number, number]; z: number }[] = [];
          let gapStart = -1;
          const flush = () => {
            if (run.length > 1) {
              const out = [run[0]];
              let anchor = run[0], lo = -Infinity, hi = Infinity, prev = run[0];
              for (let k = 1; k < run.length;) {
                const q = run[k];
                const da = q.s - anchor.s;
                const nlo = Math.max(lo, (q.z - TOL - anchor.z) / da), nhi = Math.min(hi, (q.z + TOL - anchor.z) / da);
                if (nlo > nhi) { out.push(prev); anchor = prev; lo = -Infinity; hi = Infinity; } else { lo = nlo; hi = nhi; prev = q; k++; }
              }
              if (out[out.length - 1] !== run[run.length - 1]) out.push(run[run.length - 1]);
              b.enter(out[0].p[0], out[0].p[1], out[0].z, zOf(tp.startDepth));
              for (let k = 1; k < out.length; k++) b.cutTo(out[k].p[0], out[k].p[1], out[k].z);
              b.retract();
            }
            run = [];
            gapStart = -1;
          };
          const lightRun: typeof run = [];
          for (const sm of samples) {
            const cutting = sm.d >= 0.03;
            const z = zOf(tp.startDepth + sm.d * span);
            if (cutting) {
              if (lightRun.length && run.length && sm.s - gapStart <= GAP) run.push(...lightRun);
              else if (lightRun.length) flush();
              lightRun.length = 0; gapStart = -1;
              run.push({ s: sm.s, p: sm.p, z });
            } else if (run.length) {
              if (gapStart < 0) gapStart = sm.s;
              lightRun.push({ s: sm.s, p: sm.p, z: zOf(tp.startDepth) });
              if (sm.s - gapStart > GAP) { lightRun.length = 0; flush(); }
            }
          }
          lightRun.length = 0;
          flush();
          b.passes++;
          if (b.moves.length > MOVE_CAP) { capped = true; warnings.push('The photo has too many moves; the rest was left out. Use a bigger spacing.'); }
        }
        if (tanH && 2 * tp.cutDepth * tanH < ph.spacing * 0.5) warnings.push('The lines are far apart for this V-bit and depth: the picture will look striped');
      }
    }
  } else {
    // drill: one hole at the middle of each shape, in pecks
    for (const s of shapes) {
      const c = anchorOf(s);
      const bb = shapeBounds(s)!;
      if (tool.kind !== 'drill' && Math.max(bb.maxX - bb.minX, bb.maxY - bb.minY) > tool.diameter + 1e-6 && s.kind === 'circle') warnings.push(`A ${(2 * (s as any).r).toFixed(2)} mm hole is bigger than the ${tool.diameter} mm tool: use a profile or pocket instead`);
      levels.forEach((depth) => {
        b.enter(c[0], c[1], zOf(depth), zOf(tp.startDepth));
        b.retract();
      });
      b.passes++;
    }
  }

  if (mirror && b.moves.length) {
    const bs = shapes.map((s) => shapeBounds(s)).filter((x): x is NonNullable<ReturnType<typeof shapeBounds>> => !!x);
    if (bs.length) { const sum = Math.min(...bs.map((x) => x.minX)) + Math.max(...bs.map((x) => x.maxX)); for (const m of b.moves) m.x = sum - m.x; }
  }
  return resultOf(b, warnings);
}

/** The moves, warnings and totals of a finished toolpath. */
export function resultOf(b: Builder, warnings: string[]): ToolpathResult {
  // by a loop: spreading every move into Math.min overflows the stack on a big toolpath
  let bounds: { minX: number; maxX: number; minY: number; maxY: number } | null = null;
  if (b.moves.length) {
    bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
    for (const m of b.moves) { if (m.x < bounds.minX) bounds.minX = m.x; if (m.x > bounds.maxX) bounds.maxX = m.x; if (m.y < bounds.minY) bounds.minY = m.y; if (m.y > bounds.maxY) bounds.maxY = m.y; }
  }
  return { moves: b.moves, warnings, stats: { cutLength: b.cutLength, rapidLength: b.rapidLength, seconds: b.cutTime + b.rapidLength / (5000 / 60), passes: b.passes, bounds } };
}
