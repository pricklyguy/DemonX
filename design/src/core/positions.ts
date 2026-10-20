// Saved head positions, one list per laser, kept on the server so every computer sees the same ones.
// A position is where the head sits, in the controller's own numbers (mm from the rear-left corner for a Ruida).

export interface SavedPosition {
  name: string; x: number; y: number;
  /** The job's origin for "Start from: User origin" (at most one per laser): jobs and frames are placed from here */
  origin?: boolean;
}
export interface PositionList { v: 1; sets: Record<string, SavedPosition[]> }

export const emptyPositions = (): PositionList => ({ v: 1, sets: {} });

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Strict: anything unexpected is refused with a plain message (the server uses this before it writes the file). */
export function parsePositions(v: unknown): PositionList {
  if (!isObj(v) || v.v !== 1 || !isObj(v.sets)) throw new Error('This is not a list of positions');
  const keys = Object.keys(v.sets);
  if (keys.length > 100) throw new Error('Too many lasers');
  const sets: Record<string, SavedPosition[]> = {};
  for (const k of keys) {
    if (!k.trim() || k.length > 200) throw new Error('A laser name is empty or too long');
    const list = v.sets[k];
    if (!Array.isArray(list) || list.length > 50) throw new Error(`"${k}" has too many positions (50 at most)`);
    const seen = new Set<string>();
    sets[k] = list.map((p, i): SavedPosition => {
      if (!isObj(p) || typeof p.name !== 'string' || !p.name.trim() || p.name.length > 40) throw new Error(`Position ${i + 1} of "${k}" needs a name of at most 40 characters`);
      const name = p.name.trim();
      if (seen.has(name)) throw new Error(`Two positions are called "${name}"`);
      seen.add(name);
      for (const c of [p.x, p.y]) if (typeof c !== 'number' || !Number.isFinite(c) || c < 0 || c > 100000) throw new Error(`"${name}" needs X and Y from 0 to 100000 mm`);
      return { name, x: Math.round((p.x as number) * 1000) / 1000, y: Math.round((p.y as number) * 1000) / 1000, ...(p.origin === true ? { origin: true } : {}) };
    });
    if (sets[k].filter((p) => p.origin).length > 1) throw new Error(`"${k}" has more than one job origin`);
  }
  return { v: 1, sets };
}
