// The server decides what may be sent to the laser. The Design app only ever produces a handful of G-code words, so
// anything else is refused: a stale tab, a hand-edited file or another program cannot slip a different command in.
import { cleanGcode } from '../../../server/src/parser.js';

export interface GcodeCheck {
  ok: boolean;
  error?: string;
  /** Highest S value in the job */
  maxS: number;
  lines: number;
}

const ALLOWED_G = new Set([0, 1, 21, 90]);
const ALLOWED_M = new Set([2, 4, 5, 8, 9]);
const MAX_FEED = 30000; // mm/min
const MAX_COORD = 100000; // mm

/**
 * Accepts: G0, G1, G21, G90, M2, M4, M5, M8, M9 with X, Y, F, S; comments and blank lines.
 * Refuses: M3 (constant power: fires while the head is still), arcs, offsets, homing, `$` settings, any other word,
 * power without M4, an S above `maxAllowedS`, and a job that ends with the laser on.
 */
export function validateLaserGcode(text: string, maxAllowedS: number | null = null): GcodeCheck {
  const fail = (line: number, why: string): GcodeCheck => ({ ok: false, error: `Line ${line}: ${why}`, maxS: 0, lines: 0 });
  let laserOn = false;
  let maxS = 0;
  let count = 0;
  const raw = text.split(/\r?\n/);
  for (let i = 0; i < raw.length; i++) {
    const n = i + 1;
    const line = cleanGcode(raw[i]);
    if (!line) continue;
    count++;
    if (line.startsWith('$')) return fail(n, 'settings commands ($...) are not part of a laser job');
    const words = [...line.matchAll(/([A-Z])(-?(?:\d+\.?\d*|\.\d+))/g)];
    if (words.map((w) => w[0]).join('') !== line) return fail(n, `not understood: ${raw[i].trim().slice(0, 40)}`);
    let g: number | undefined;
    let hasXY = false;
    let s: number | undefined;
    for (const [, letter, value] of words) {
      const v = Number(value);
      if (!Number.isFinite(v)) return fail(n, 'bad number');
      switch (letter) {
        case 'G':
          if (!ALLOWED_G.has(v)) return fail(n, `G${v} is not allowed in a laser job (only G0, G1, G21, G90)`);
          if (v === 0 || v === 1) { if (g !== undefined) return fail(n, 'two motion commands on one line'); g = v; }
          break;
        case 'M':
          if (v === 3) return fail(n, 'M3 is not allowed: it keeps the laser on while the head is still. Use M4 (laser mode).');
          if (!ALLOWED_M.has(v)) return fail(n, `M${v} is not allowed in a laser job`);
          if (v === 4) laserOn = true;
          if (v === 5 || v === 2) laserOn = false;
          break;
        case 'X': case 'Y':
          if (Math.abs(v) > MAX_COORD) return fail(n, `${letter}${v} is out of range`);
          hasXY = true;
          break;
        case 'F':
          if (!(v > 0 && v <= MAX_FEED)) return fail(n, `feed F${v} must be above 0 and at most ${MAX_FEED} mm/min`);
          break;
        case 'S':
          if (v < 0) return fail(n, 'S cannot be negative');
          s = v;
          if (v > maxS) maxS = v;
          if (maxAllowedS !== null && v > maxAllowedS) return fail(n, `S${v} is above the controller's maximum (${maxAllowedS}, $30)`);
          break;
        default:
          return fail(n, `${letter} words are not allowed in a laser job`);
      }
    }
    if (hasXY && g === undefined) return fail(n, 'X/Y without G0 or G1');
    if (g === 0 && s !== undefined) return fail(n, 'S on a G0 rapid');
    if (g === 1 && s !== undefined && s > 0 && !laserOn) return fail(n, 'power without M4 (the laser is not switched on for this move)');
  }
  if (count === 0) return { ok: false, error: 'The job is empty', maxS: 0, lines: 0 };
  if (laserOn) return { ok: false, error: 'The job ends with the laser still on (no M5 or M2 at the end)', maxS, lines: count };
  return { ok: true, maxS, lines: count };
}
