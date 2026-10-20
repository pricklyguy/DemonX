// Everything the Laser tab works out from the drawing (the G-code job, the Ruida plan and the time), in one function so it can
// run in a worker (jobWorker.ts) and the page never waits for it.
import type { Doc } from './types';
import { CANVAS_NOTE, buildLaserJob, jobOrigin, anchorName, type LaserJob, type Move, type OrderOptions } from './laser';
import { buildRuidaPlan } from './ruidaPlan';
import { estimateMoves, planToMoves, type Estimate } from './jobEstimate';
import { planBox, serializePlan, type Box } from '../../server/src/ruida/plan';
import { shapeBounds, unionBounds, type Anchor } from './geom';

export interface JobInput {
  doc: Doc;
  onlyIds?: number[];
  anchor: Anchor;
  startFrom: 'user' | 'absolute';
  order: OrderOptions;
  /** a Ruida controller is connected: the plan is built too */
  ruida: boolean;
}

export interface RuidaJobInfo {
  /** the plan as moves, for the preview and the time */
  moves: Move[]; text: string; empty: boolean; warnings: string[]; info?: string[]; box: Box | null;
  /** the job's box plus the tool layers' (T1/T2), for the reach warning */
  reachBox?: Box | null;
  /** one line per layer, for the Start confirmation */
  summary: string[];
}

export interface JobOutput { job: LaserJob; ruida: RuidaJobInfo; est: Estimate }

export const NO_RUIDA_JOB: RuidaJobInfo = { moves: [], text: '', empty: true, warnings: [], info: [], box: null, reachBox: null, summary: [] };

export function computeJobs(i: JobInput): JobOutput {
  const { doc } = i;
  const job = buildLaserJob(doc, { onlyIds: i.onlyIds, anchor: i.anchor, startFrom: i.startFrom, order: i.order });
  let ruida = NO_RUIDA_JOB;
  if (i.ruida && doc.workspace.kind === 'canvas') ruida = { ...NO_RUIDA_JOB, warnings: [CANVAS_NOTE] };
  else if (i.ruida) {
    const r = buildRuidaPlan(doc, { onlyIds: i.onlyIds, anchor: i.anchor, order: i.order });
    const summary = [`The job starts where the head is now: the head is at the ${anchorName(i.anchor)} of the job.`, ...r.plan.layers.map((l, k) => {
      const n = (v: number) => String(Math.round(v * 10) / 10);
      return `Layer ${k + 1}: ${l.mode === 'fill' ? 'engrave (fill)' : 'line (cut / score)'} · ${n(l.speed)} mm/s · ${n(l.maxPower)} % power · air ${l.air ? 'ON (high pressure)' : 'off (low pressure)'}`;
    })];
    const box = r.empty ? null : planBox(r.plan);
    // tool layers (T1/T2) are not burned but mark the outer limits, so the reach check covers them too
    const toolNames = new Set(doc.layers.filter((l) => l.mode === 'tool').map((l) => l.name));
    const tb = unionBounds(doc.shapes.filter((s) => toolNames.has(s.layer)).map(shapeBounds));
    const origin = tb && jobOrigin(doc, { onlyIds: i.onlyIds, anchor: i.anchor });
    const toolBox = tb && origin ? { minX: tb.minX - origin[0], maxX: tb.maxX - origin[0], minY: origin[1] - tb.maxY, maxY: origin[1] - tb.minY } : null;
    const reachBox = box && toolBox ? { minX: Math.min(box.minX, toolBox.minX), minY: Math.min(box.minY, toolBox.minY), maxX: Math.max(box.maxX, toolBox.maxX), maxY: Math.max(box.maxY, toolBox.maxY) } : box ?? toolBox;
    ruida = { moves: r.empty ? [] : planToMoves(r.plan, Math.max(0, ...doc.layers.filter((l) => l.mode === 'engrave').map((l) => l.overscan))), text: r.empty ? '' : serializePlan(r.plan), empty: r.empty, warnings: r.warnings, info: r.info, box, reachBox, summary };
  }
  const est = estimateMoves(i.ruida ? ruida.moves : job.moves, { rapid: doc.machine.rapid });
  return { job, ruida, est };
}

/** Moves as one array of numbers (7 per move) and the layer names: copying that between the worker and the page is far quicker than a hundred thousand objects */
export interface PackedMoves { f: Float64Array; layers: string[] }
export function packMoves(moves: Move[]): PackedMoves {
  const names = new Map<string, number>();
  const f = new Float64Array(moves.length * 7);
  moves.forEach((m, i) => {
    let li = names.get(m.layer);
    if (li === undefined) { li = names.size; names.set(m.layer, li); }
    f.set([m.x0, m.y0, m.x1, m.y1, m.burn ? 1 : 0, m.speed ?? NaN, li], i * 7);
  });
  return { f, layers: [...names.keys()] };
}
export function unpackMoves(p: PackedMoves): Move[] {
  const n = p.f.length / 7, out: Move[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 7, sp = p.f[o + 5];
    out[i] = { x0: p.f[o], y0: p.f[o + 1], x1: p.f[o + 2], y1: p.f[o + 3], burn: p.f[o + 4] === 1, layer: p.layers[p.f[o + 6]], ...(Number.isNaN(sp) ? {} : { speed: sp }) };
  }
  return out;
}

/** What the worker sends: the same result with the two move lists packed */
export interface JobWire { job: Omit<LaserJob, 'moves'>; jobMoves: PackedMoves; ruida: Omit<RuidaJobInfo, 'moves'>; ruidaMoves: PackedMoves; est: Estimate }
export function toWire(o: JobOutput): { wire: JobWire; transfer: ArrayBuffer[] } {
  const { moves: jm, ...job } = o.job, { moves: rm, ...ruida } = o.ruida;
  const jobMoves = packMoves(jm), ruidaMoves = packMoves(rm);
  return { wire: { job, jobMoves, ruida, ruidaMoves, est: o.est }, transfer: [jobMoves.f.buffer as ArrayBuffer, ruidaMoves.f.buffer as ArrayBuffer, o.est.at.buffer as ArrayBuffer] };
}
export function fromWire(w: JobWire): JobOutput {
  return { job: { ...w.job, moves: unpackMoves(w.jobMoves) } as LaserJob, ruida: { ...w.ruida, moves: unpackMoves(w.ruidaMoves) }, est: w.est };
}
