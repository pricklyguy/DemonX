// Turns the layers that have Output on into a Ruida job plan: the same paths buildLaserJob draws for GRBL (same contour
// order, same fill lines, same overscan), written as points for the Ruida job writer on the server (see
// server/src/ruida/). Pure functions, no screen.
//
// Coordinates: the job starts where the head stands (LightBurn's "Current Position"). The job's anchor point is that spot:
// x grows to the right, and y grows toward the FRONT of the machine, which is the opposite of the drawing (Y points up in
// the drawing), so y is flipped. Only that mode has been seen on a real controller; "Absolute coordinates" is not offered.
import type { Doc, Layer, Shape } from './types';
import { shapeBounds, shapeClosed, unionBounds, type Anchor } from './geom';
import { planFill, type FillPlan } from './fill';
import { jobOrigin, orderLayer, type OrderOptions } from './laser';
import type { Pt } from './types';
import type { RuidaLayer, RuidaPlan, RuidaPoint } from '../../server/src/ruida/plan';

export interface RuidaPlanOptions {
  /** Only these shapes. */
  onlyIds?: number[];
  /** Which point of the job sits under the head when the job starts. Default bottom-left. */
  anchor?: Anchor;
  /** How the cuts of line layers are ordered (the cut optimizer). */
  order?: OrderOptions;
}

export interface RuidaPlanResult {
  plan: RuidaPlan;
  empty: boolean;
  warnings: string[];
  /** What the program chose for the user, such as a faster fill layout */
  info: string[];
}

/** "#rrggbb" to the controller's colour word (LightBurn writes blue-green-red: red is 0x0000ff) */
export function colorRaw(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return 0;
  const v = parseInt(m[1], 16);
  return ((v & 0xff) << 16) | (v & 0xff00) | (v >> 16);
}

const um = (v: number) => Math.round(v * 1000) / 1000;

export function buildRuidaPlan(doc: Doc, opts: RuidaPlanOptions = {}): RuidaPlanResult {
  const warnings: string[] = [];
  const info: string[] = [];
  const fillPlans = new Map<string, FillPlan>();
  const only = opts.onlyIds ? new Set(opts.onlyIds) : null;
  const jobLayers: { layer: Layer; shapes: Shape[] }[] = [];
  for (const layer of doc.layers) {
    if (!layer.output || layer.mode === 'tool') continue;
    const shapes = doc.shapes.filter((s) => s.layer === layer.name && (!only || only.has(s.id)));
    if (shapes.length) jobLayers.push({ layer, shapes });
  }
  const bounds = unionBounds(jobLayers.flatMap((j) => j.shapes.map(shapeBounds)));
  if (!bounds) {
    warnings.push(only ? 'None of the selected shapes are on a layer with Output on.' : 'No layer with Output on has any shapes.');
    return { plan: { layers: [] }, empty: true, warnings, info };
  }
  // measured from the whole design, so switching a layer's Output off does not move the start point
  const origin: Pt = jobOrigin(doc, { onlyIds: opts.onlyIds, anchor: opts.anchor ?? 'bl' })!;
  const toJob = (x: number, y: number): [number, number] => [um(x - origin[0]), um(origin[1] - y)];

  const layers: RuidaLayer[] = [];
  for (const { layer, shapes } of jobLayers) {
    const points: RuidaPoint[] = [];
    let cx = NaN, cy = NaN;
    const travel = (x: number, y: number) => {
      if (x === cx && y === cy) return;
      const [jx, jy] = toJob(x, y);
      points.push({ x: jx, y: jy, burn: false });
      cx = x; cy = y;
    };
    const feed = (x: number, y: number, burn: boolean) => {
      const [jx, jy] = toJob(x, y);
      points.push({ x: jx, y: jy, burn });
      cx = x; cy = y;
    };
    if (layer.minPower > layer.power) warnings.push(`Layer ${layer.name}: the minimum power is above the maximum.`);
    if (layer.power === 0) warnings.push(`Layer ${layer.name} has 0% power, so it will not burn anything.`);

    for (let pass = 0; pass < layer.passes; pass++) {
      if (layer.mode === 'engrave') {
        const closed = shapes.filter(shapeClosed);
        if (closed.length < shapes.length && pass === 0) warnings.push(`Layer ${layer.name} is set to engrave, so its open lines are skipped (a line has no inside to fill).`);
        if (!fillPlans.has(layer.name)) fillPlans.set(layer.name, planFill(closed, { interval: layer.interval, overscan: layer.overscan, speed: layer.speed, mode: layer.fillMode }, Number.isNaN(cx) ? origin : [cx, cy]));
        const fp = fillPlans.get(layer.name)!;
        if (fp.note && pass === 0) info.push(`${layer.name}: ${fp.note}`);
        for (const o of fp.ops) { if (o.feed) feed(o.x, o.y, o.burn); else travel(o.x, o.y); }
      } else {
        const ordered = orderLayer(shapes, Number.isNaN(cx) ? origin : [cx, cy], opts.order);
        if (ordered.note && pass === 0) info.push(`${layer.name}: ${ordered.note}`);
        for (const c of ordered.list) {
          travel(c.pts[0][0], c.pts[0][1]);
          for (let i = 1; i < c.pts.length; i++) feed(c.pts[i][0], c.pts[i][1], true);
          if (c.closed) feed(c.pts[0][0], c.pts[0][1], true);
        }
      }
    }
    if (points.length < 2 || !points.some((p) => p.burn)) continue;
    // the writer wants a layer to begin with a move
    if (points[0].burn) points[0] = { ...points[0], burn: false };
    layers.push({
      colorRaw: colorRaw(layer.color),
      // line follow for cut and score, fill for engrave (the two modes seen on the wire)
      mode: layer.mode === 'engrave' ? 'fill' : 'line',
      speed: layer.speed,
      minPower: layer.minPower,
      maxPower: layer.power,
      air: layer.air,
      points,
    });
  }
  if (!layers.length) {
    warnings.push('Nothing to burn: the layers with Output on have no lines or closed shapes to follow.');
    return { plan: { layers: [] }, empty: true, warnings, info };
  }
  if (layers.some((l) => l.mode === 'fill' && l.minPower !== l.maxPower)) warnings.push('Engrave (fill) layers: the minimum and maximum power are sent as set, but only a line layer has been tried on the machine.');
  return { plan: { layers }, empty: false, warnings, info };
}
