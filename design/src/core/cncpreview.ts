/** What the CNC preview draws, and where the animated simulation is at a given moment. Pure; the screen part is in the UI. */
import type { Move3 } from './post';

export interface PMove { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number; kind: Move3['kind'] }

/** The moves of the given built toolpaths (all of them when `ids` is null), as segments with both ends. */
export function previewMoves(built: { tp: { id: number }; result: { moves: Move3[] } }[], ids: number[] | null): PMove[] {
  const out: PMove[] = [];
  for (const b of built) {
    if (ids && !ids.includes(b.tp.id)) continue;
    let prev: Move3 | null = null;
    for (const m of b.result.moves) {
      if (prev && (m.x !== prev.x || m.y !== prev.y || m.z !== prev.z)) out.push({ x0: prev.x, y0: prev.y, z0: prev.z, x1: m.x, y1: m.y, z1: m.z, kind: m.kind });
      prev = m;
    }
  }
  return out;
}

/** Rapid moves cost this much of their length in the animation, so the cutting is not lost in the travelling. */
const RAPID_WEIGHT = 0.15;
const weight = (m: PMove) => Math.hypot(m.x1 - m.x0, m.y1 - m.y0, m.z1 - m.z0) * (m.kind === 'rapid' ? RAPID_WEIGHT : 1);

export interface SimFrame {
  /** Segments finished (drawn whole) */
  done: number;
  /** The tool now */
  x: number; y: number; z: number;
  /** The segment being cut now, up to the tool (null at the very start or end) */
  partial: PMove | null;
}

/** Where the tool is after `frac` (0 to 1) of the animation. */
export function simFrame(moves: PMove[], frac: number): SimFrame {
  if (!moves.length) return { done: 0, x: 0, y: 0, z: 0, partial: null };
  const f = Math.min(1, Math.max(0, frac));
  const total = moves.reduce((n, m) => n + weight(m), 0);
  if (f >= 1 || total <= 0) { const l = moves[moves.length - 1]; return { done: moves.length, x: l.x1, y: l.y1, z: l.z1, partial: null }; }
  let target = f * total;
  for (let i = 0; i < moves.length; i++) {
    const w = weight(moves[i]);
    if (target <= w || i === moves.length - 1) {
      const m = moves[i];
      const k = w > 0 ? Math.min(1, target / w) : 1;
      const x = m.x0 + (m.x1 - m.x0) * k, y = m.y0 + (m.y1 - m.y0) * k, z = m.z0 + (m.z1 - m.z0) * k;
      return { done: i, x, y, z, partial: k > 0 ? { ...m, x1: x, y1: y, z1: z } : null };
    }
    target -= w;
  }
  const l = moves[moves.length - 1];
  return { done: moves.length, x: l.x1, y: l.y1, z: l.z1, partial: null };
}
