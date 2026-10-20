import type { Bounds } from './geom';

export type AlignEdge = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom' | 'center';
export const ALIGN_EDGES: AlignEdge[] = ['left', 'hcenter', 'right', 'top', 'vcenter', 'bottom', 'center'];

/** How far each box must move so that its chosen edge (or centre) lands on the frame's. Y points up. */
export function alignOffsets(boxes: Bounds[], edge: AlignEdge, frame: Bounds): Array<[number, number]> {
  return boxes.map((b) => {
    switch (edge) {
      case 'left': return [frame.minX - b.minX, 0];
      case 'right': return [frame.maxX - b.maxX, 0];
      case 'hcenter': return [(frame.minX + frame.maxX) / 2 - (b.minX + b.maxX) / 2, 0];
      case 'top': return [0, frame.maxY - b.maxY];
      case 'bottom': return [0, frame.minY - b.minY];
      case 'vcenter': return [0, (frame.minY + frame.maxY) / 2 - (b.minY + b.maxY) / 2];
      default: return [(frame.minX + frame.maxX) / 2 - (b.minX + b.maxX) / 2, (frame.minY + frame.maxY) / 2 - (b.minY + b.maxY) / 2];
    }
  });
}

/**
 * Spread boxes along one axis, keeping the two outermost where they are.
 * "gaps" makes the space between neighbours equal; "centers" makes the centres evenly spaced.
 * With `gap` the space between neighbours is that many mm instead (the first box stays, the rest follow it in order; two boxes are enough).
 */
export function distributeOffsets(boxes: Bounds[], axis: 'x' | 'y', mode: 'gaps' | 'centers', gap?: number): Array<[number, number]> {
  const lo = (b: Bounds) => (axis === 'x' ? b.minX : b.minY);
  const hi = (b: Bounds) => (axis === 'x' ? b.maxX : b.maxY);
  const mid = (b: Bounds) => (lo(b) + hi(b)) / 2;
  const order = boxes.map((_, i) => i).sort((a, b) => mid(boxes[a]) - mid(boxes[b]) || a - b);
  const out: Array<[number, number]> = boxes.map(() => [0, 0]);
  const n = order.length;
  if (n < (gap === undefined ? 3 : 2)) return out;
  const first = boxes[order[0]], last = boxes[order[n - 1]];
  const put = (i: number, d: number) => { out[i] = axis === 'x' ? [d, 0] : [0, d]; };
  if (gap !== undefined) {
    let pos = lo(first);
    order.forEach((i) => { put(i, pos - lo(boxes[i])); pos += hi(boxes[i]) - lo(boxes[i]) + gap; });
  } else if (mode === 'centers') {
    const step = (mid(last) - mid(first)) / (n - 1);
    order.forEach((i, k) => put(i, mid(first) + step * k - mid(boxes[i])));
  } else {
    const total = order.reduce((s, i) => s + (hi(boxes[i]) - lo(boxes[i])), 0);
    const gap = (hi(last) - lo(first) - total) / (n - 1);
    let pos = lo(first);
    order.forEach((i) => { put(i, pos - lo(boxes[i])); pos += hi(boxes[i]) - lo(boxes[i]) + gap; });
  }
  return out;
}
