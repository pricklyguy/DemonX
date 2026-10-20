import type { Pt } from './types';

/** The shapes drawn from a few numbers: they become ordinary paths (an arc is an open one). */
export type ShapeSpec =
  | { kind: 'ellipse'; w: number; h: number }
  | { kind: 'polygon'; sides: number; r: number }
  | { kind: 'star'; points: number; r: number; inner: number }
  | { kind: 'arc'; r: number; start: number; end: number };

export type ShapeKind = ShapeSpec['kind'];
export const SHAPE_KINDS: ShapeKind[] = ['ellipse', 'polygon', 'star', 'arc'];

export const DEFAULT_SHAPES: { [K in ShapeKind]: Extract<ShapeSpec, { kind: K }> } = {
  ellipse: { kind: 'ellipse', w: 20, h: 10 },
  polygon: { kind: 'polygon', sides: 6, r: 10 },
  star: { kind: 'star', points: 5, r: 10, inner: 0.4 },
  arc: { kind: 'arc', r: 10, start: 0, end: 90 },
};

/** Segments for a curve of radius r so a chord is never more than ~0.005 mm off the true curve */
function steps(r: number, sweep: number): number {
  const rr = Math.max(r, 0.01);
  const per = 2 * Math.acos(Math.max(0, 1 - 0.005 / rr));
  return Math.min(720, Math.max(8, Math.ceil(sweep / Math.max(per, 1e-3))));
}

/** The points of a shape centred on (cx, cy), and whether it closes. A polygon or star points its first corner up. */
export function buildShape(spec: ShapeSpec, cx: number, cy: number): { pts: Pt[]; closed: boolean } {
  const pts: Pt[] = [];
  switch (spec.kind) {
    case 'ellipse': {
      const rx = spec.w / 2, ry = spec.h / 2;
      const n = Math.max(48, steps(Math.max(rx, ry), 2 * Math.PI));
      for (let i = 0; i < n; i++) { const a = (2 * Math.PI * i) / n; pts.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]); }
      return { pts, closed: true };
    }
    case 'polygon': {
      const n = Math.max(3, Math.round(spec.sides));
      for (let i = 0; i < n; i++) { const a = Math.PI / 2 + (2 * Math.PI * i) / n; pts.push([cx + spec.r * Math.cos(a), cy + spec.r * Math.sin(a)]); }
      return { pts, closed: true };
    }
    case 'star': {
      const n = Math.max(3, Math.round(spec.points));
      for (let i = 0; i < 2 * n; i++) {
        const a = Math.PI / 2 + (Math.PI * i) / n;
        const r = i % 2 === 0 ? spec.r : spec.r * spec.inner;
        pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
      }
      return { pts, closed: true };
    }
    case 'arc': {
      // from the start angle anticlockwise to the end angle (degrees, 0 = to the right)
      let sweep = spec.end - spec.start;
      if (sweep <= 0) sweep += 360;
      if (sweep > 360) sweep = 360;
      const n = steps(spec.r, (sweep * Math.PI) / 180);
      for (let i = 0; i <= n; i++) { const a = ((spec.start + (sweep * i) / n) * Math.PI) / 180; pts.push([cx + spec.r * Math.cos(a), cy + spec.r * Math.sin(a)]); }
      return { pts, closed: false };
    }
  }
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** A drag on the drawing: an ellipse fills the box between the corners, the others grow from the centre out to the cursor. */
export function fromDrag(spec: ShapeSpec, a: Pt, b: Pt): { spec: ShapeSpec; cx: number; cy: number } {
  if (spec.kind === 'ellipse') return { spec: { ...spec, w: r3(Math.abs(b[0] - a[0])), h: r3(Math.abs(b[1] - a[1])) }, cx: (a[0] + b[0]) / 2, cy: (a[1] + b[1]) / 2 };
  return { spec: { ...spec, r: r3(Math.hypot(b[0] - a[0], b[1] - a[1])) }, cx: a[0], cy: a[1] };
}

export const shapeValid = (s: ShapeSpec): boolean =>
  s.kind === 'ellipse' ? s.w > 0 && s.h > 0 : s.kind === 'star' ? s.r > 0 && s.inner > 0 && s.inner < 1 : s.r > 0;
