// Booleans and offsets, using Clipper (Angus Johnson's polygon clipper, Boost licence) on integer coordinates.
// Everything else only sees plain Pt rings, so Clipper2 or a WASM build can replace this file later.
import ClipperLib from 'clipper-lib';
import type { Pt, Shape } from './types';
import { shapeClosed, shapeRings } from './geom';

const SCALE = 1000; // 0.001 mm
const ARC_TOLERANCE = 0.01 * SCALE;

type CPath = { X: number; Y: number }[];

const toClip = (ring: Pt[]): CPath => ring.map(([x, y]) => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) }));
const fromClip = (path: CPath): Pt[] => path.map((p) => [p.X / SCALE, p.Y / SCALE] as Pt);

const CT = ClipperLib.ClipType;
const PT = ClipperLib.PolyType;
const PFT = ClipperLib.PolyFillType;

export type BooleanOp = 'union' | 'difference' | 'intersection';
export type JoinType = 'round' | 'miter' | 'square';

/** A closed shape as clean regions: outer rings positive, holes negative, no self-overlap. */
export function regionOf(shape: Shape): CPath[] {
  const c = new ClipperLib.Clipper();
  c.StrictlySimple = true;
  c.AddPaths(shapeRings(shape).map(toClip), PT.ptSubject, true);
  const out: CPath[] = [];
  c.Execute(CT.ctUnion, out, PFT.pftEvenOdd, PFT.pftEvenOdd);
  return out;
}

function run(op: BooleanOp, subject: CPath[], clip: CPath[]): CPath[] {
  const c = new ClipperLib.Clipper();
  c.StrictlySimple = true;
  c.AddPaths(subject, PT.ptSubject, true);
  c.AddPaths(clip, PT.ptClip, true);
  const out: CPath[] = [];
  const type = op === 'union' ? CT.ctUnion : op === 'difference' ? CT.ctDifference : CT.ctIntersection;
  c.Execute(type, out, PFT.pftNonZero, PFT.pftNonZero);
  return out;
}

/** union: all together. difference: the first shape minus all the others. intersection: what all of them share. */
export function booleanOp(op: BooleanOp, shapes: Shape[]): Pt[][] {
  if (shapes.length < 2) throw new Error('A boolean needs at least two closed shapes');
  const regions = shapes.map(regionOf);
  let acc = regions[0];
  if (op === 'union') {
    acc = run('union', regions.flat(), []);
  } else if (op === 'difference') {
    acc = run('difference', regions[0], regions.slice(1).flat());
  } else {
    for (let i = 1; i < regions.length; i++) acc = run('intersection', acc, regions[i]);
  }
  return acc.map(fromClip);
}

const JOIN = { round: ClipperLib.JoinType.jtRound, miter: ClipperLib.JoinType.jtMiter, square: ClipperLib.JoinType.jtSquare };

/**
 * Grow (distance > 0) or shrink (distance < 0) a shape. Open paths become a closed outline around the line
 * (round ends), so only a positive distance makes sense for them.
 */
export function offsetShape(shape: Shape, distance: number, join: JoinType = 'round'): Pt[][] {
  const co = new ClipperLib.ClipperOffset(2, ARC_TOLERANCE);
  if (shapeClosed(shape)) {
    co.AddPaths(regionOf(shape), JOIN[join], ClipperLib.EndType.etClosedPolygon);
  } else {
    if (distance <= 0) throw new Error('An open line can only be offset outwards (a positive distance)');
    co.AddPaths(shapeRings(shape).map(toClip), JOIN[join], join === 'round' ? ClipperLib.EndType.etOpenRound : ClipperLib.EndType.etOpenSquare);
  }
  const out: CPath[] = [];
  co.Execute(out, distance * SCALE);
  return out.map(fromClip);
}

/** Everything the shapes cover, as clean rings (outer and holes), with overlaps merged. */
export function unionRings(shapes: Shape[]): Pt[][] {
  if (!shapes.length) return [];
  if (shapes.length === 1) return regionOf(shapes[0]).map(fromClip);
  return booleanOp('union', shapes);
}

/** Rings drawn by a font or by hand, which may overlap: merge them (non-zero fill) into clean outer rings and holes. */
export function mergeRings(rings: Pt[][]): Pt[][] {
  const c = new ClipperLib.Clipper();
  c.StrictlySimple = true;
  c.AddPaths(rings.map(toClip), PT.ptSubject, true);
  const out: CPath[] = [];
  c.Execute(CT.ctUnion, out, PFT.pftNonZero, PFT.pftNonZero);
  return out.map(fromClip);
}
