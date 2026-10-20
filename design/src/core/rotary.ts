// Rotary settings, one set per laser, kept on the server so every computer sees the same ones.
// What is known so far comes from LightBurn's Rotary Setup window: a chuck or a roller, steps per rotation, the object's diameter
// (and the roller's), and a circumference worked out from the diameter. How the controller wants a rotary job (does LightBurn scale
// Y? does it send a command to switch the controller to rotary?) has not been captured yet, so jobs are NOT sent while rotary is on.

export interface RotarySetup {
  /** The rotary is fitted and in use: jobs are not sent to the laser while this is on (see above) */
  enabled: boolean;
  type: 'chuck' | 'roller';
  /** The rotary motor's steps for one full turn (LightBurn reads this from the controller) */
  steps: number;
  /** mm, across the piece being engraved */
  objectDiameter: number;
  /** mm, the roller's own diameter (rollers only) */
  rollerDiameter: number;
}
export interface RotaryList { v: 1; sets: Record<string, RotarySetup> }

export const DEFAULT_ROTARY: RotarySetup = { enabled: false, type: 'chuck', steps: 10000, objectDiameter: 100, rollerDiameter: 50 };
export const emptyRotary = (): RotaryList => ({ v: 1, sets: {} });

/** mm of the piece's surface that pass the laser in one full turn of the piece */
export const circumference = (r: RotarySetup): number => Math.PI * r.objectDiameter;
/** mm of the piece's surface for one step of the motor. A chuck turns the piece itself; a roller moves the surface at the roller's rim. */
export const mmPerStep = (r: RotarySetup): number => (r.type === 'chuck' ? Math.PI * r.objectDiameter : Math.PI * r.rollerDiameter) / r.steps;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nr = (v: unknown, what: string, lo: number, hi: number): number => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) throw new Error(`${what} must be a number from ${lo} to ${hi}`);
  return v;
};

/** Strict: anything unexpected is refused with a plain message (the server uses this before it writes the file). */
export function parseRotary(v: unknown): RotaryList {
  if (!isObj(v) || v.v !== 1 || !isObj(v.sets)) throw new Error('These are not rotary settings');
  const keys = Object.keys(v.sets);
  if (keys.length > 100) throw new Error('Too many lasers');
  const sets: Record<string, RotarySetup> = {};
  for (const k of keys) {
    if (!k.trim() || k.length > 200) throw new Error('A laser name is empty or too long');
    const r = v.sets[k];
    if (!isObj(r)) throw new Error(`The rotary settings of "${k}" are damaged`);
    if (r.type !== 'chuck' && r.type !== 'roller') throw new Error(`"${k}": the rotary type must be chuck or roller`);
    sets[k] = {
      enabled: r.enabled === true,
      type: r.type,
      steps: nr(r.steps, `${k}: steps per rotation`, 1, 10_000_000),
      objectDiameter: nr(r.objectDiameter, `${k}: object diameter`, 0.1, 5000),
      rollerDiameter: nr(r.rollerDiameter ?? DEFAULT_ROTARY.rollerDiameter, `${k}: roller diameter`, 0.1, 5000),
    };
  }
  return { v: 1, sets };
}
