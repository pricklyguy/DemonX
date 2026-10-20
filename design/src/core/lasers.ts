// The list of lasers (name, bed size, power scale, where 0,0 is), kept on the server so every computer sees the same ones.
import type { Machine } from './types';

export interface LaserList { v: 1; lasers: Machine[] }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nr = (v: unknown, what: string, lo: number, hi: number): number => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) throw new Error(`${what} must be a number from ${lo} to ${hi}`);
  return v;
};

/** Strict: anything unexpected is refused with a plain message (the server uses this before it writes the file). */
export function parseLasers(v: unknown): LaserList {
  if (!isObj(v) || v.v !== 1 || !Array.isArray(v.lasers)) throw new Error('This is not a laser list');
  if (v.lasers.length > 100) throw new Error('Too many lasers');
  const seen = new Set<string>();
  const lasers = v.lasers.map((l, i): Machine => {
    if (!isObj(l)) throw new Error(`Laser ${i + 1} is damaged`);
    if (typeof l.name !== 'string' || !l.name.trim() || l.name.length > 120) throw new Error(`Laser ${i + 1} needs a name of at most 120 characters`);
    const name = l.name.trim();
    if (seen.has(name)) throw new Error(`Two lasers are called "${name}"`);
    seen.add(name);
    return {
      name,
      width: nr(l.width, `${name}: width`, 1, 100000), height: nr(l.height, `${name}: height`, 1, 100000),
      sMax: nr(l.sMax, `${name}: S max`, 1, 100000), rapid: nr(l.rapid ?? 100, `${name}: rapid speed`, 1, 5000),
      ...(l.origin === 'tl' || l.origin === 'bl' ? { origin: l.origin } : {}),
    };
  });
  return { v: 1, lasers };
}
