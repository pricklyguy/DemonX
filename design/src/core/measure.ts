import type { Pt } from './types';

export interface Measurement {
  /** Straight-line distance, mm */
  distance: number;
  /** How far B is to the right of A, mm */
  dx: number;
  /** How far B is above A (or below it, when `yDown`: the same way the Y boxes count), mm */
  dy: number;
  /** The direction from A to B as it looks on the screen: degrees anticlockwise from the right, 0 to 360 (a point straight up is 90) */
  angle: number;
}

/** What the measuring tool reports for two points of the drawing (Y up). `yDown` makes ΔY count downwards, as on a laser page. */
export function measure(a: Pt, b: Pt, yDown = false): Measurement {
  const dx = b[0] - a[0], up = b[1] - a[1];
  let angle = (Math.atan2(up, dx) * 180) / Math.PI;
  if (angle < 0) angle += 360;
  if (Math.hypot(dx, up) < 1e-12) angle = 0;
  const round = (v: number) => Math.round(v * 1e6) / 1e6;
  return { distance: round(Math.hypot(dx, up)), dx: round(dx), dy: round(yDown ? -up : up) || 0, angle: round(angle) };
}

/** "42.50" style: at most `digits` decimals, no trailing zeros dropped (a ruler reading, not a number). */
export const fmt = (v: number, digits = 3): string => (Math.abs(v) < 5 * Math.pow(10, -digits - 1) ? 0 : v).toFixed(digits);
