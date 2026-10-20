// The size of the machine's work area, worked out from the controller's own settings (or typed in), so the 3D view can show the
// whole machine before a file is loaded. Pure, and tested without a controller (server/test/bed.test.ts).

/** Which end of an axis machine zero is at: true means the far (positive) end, so positions run from -travel up to 0 (the usual GRBL setup) */
export interface ManualBed {
  /** Use these numbers instead of what the controller says */
  enabled: boolean;
  /** Travel of each axis in mm */
  x: number; y: number; z: number;
  /** Machine zero at the far end of the axis (usual) or the near end */
  zeroAtMax: { x: boolean; y: boolean; z: boolean };
}
export const defaultManualBed = (): ManualBed => ({ enabled: false, x: 0, y: 0, z: 0, zeroAtMax: { x: true, y: true, z: true } });

/** The machine's reach in MACHINE coordinates (what the controller reports as MPos), per axis */
export interface MachineBed {
  minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number;
  source: 'grbl' | 'fluidnc' | 'manual';
}

type Values = Record<string, string | number | boolean>;
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);
const ok = (travel: number | undefined): travel is number => travel !== undefined && travel > 0 && travel <= 100_000;

/** Machine range of one axis, given its travel, where machine zero is, and the position it has at the home switch */
function range(travel: number, homeAtMax: boolean, mposAtHome: number): [number, number] {
  return homeAtMax ? [mposAtHome - travel, mposAtHome] : [mposAtHome, mposAtHome + travel];
}

const make = (r: Record<'x' | 'y' | 'z', [number, number] | undefined>, source: MachineBed['source']): MachineBed | null => {
  if (!r.x || !r.y) return null;                      // without both X and Y there is no work area to show
  const z = r.z ?? [0, 0];
  return { minX: r.x[0], maxX: r.x[1], minY: r.y[0], maxY: r.y[1], minZ: z[0], maxZ: z[1], source };
};

/** GRBL: `$130 $131 $132` are the travels, and bits 0 to 2 of `$23` say which axes home towards the negative end (machine zero is at the near end) */
export function bedFromGrbl(values: Values): MachineBed | null {
  const mask = num(values['$23']) ?? 0;
  const axis = (key: string, bit: number): [number, number] | undefined => {
    const t = num(values[key]);
    return ok(t) ? range(t, !((mask >> bit) & 1), 0) : undefined;
  };
  return make({ x: axis('$130', 0), y: axis('$131', 1), z: axis('$132', 2) }, 'grbl');
}

/** FluidNC: `axes/<a>/max_travel_mm`, and where the axis homes (`homing/positive_direction`, `homing/mpos_mm`, the position at the switch) */
export function bedFromFluidNc(raw: Values): MachineBed | null {
  // a real controller prints the axis names in capitals (axes/X/max_travel_mm) and a config file may use either: ignore case
  const values: Values = {};
  for (const [k, v] of Object.entries(raw)) values[k.toLowerCase()] = v;
  const axis = (a: string): [number, number] | undefined => {
    const t = num(values[`axes/${a}/max_travel_mm`]);
    if (!ok(t)) return undefined;
    const pos = values[`axes/${a}/homing/positive_direction`];
    const homeAtMax = pos === undefined ? true : pos === true || String(pos).toLowerCase() === 'true';
    return range(t, homeAtMax, num(values[`axes/${a}/homing/mpos_mm`]) ?? 0);
  };
  return make({ x: axis('x'), y: axis('y'), z: axis('z') }, 'fluidnc');
}

/** The numbers typed in Settings */
export function bedFromManual(m: ManualBed): MachineBed | null {
  if (!m.enabled) return null;
  const axis = (t: number, atMax: boolean): [number, number] | undefined => (ok(t) ? range(t, atMax, 0) : undefined);
  return make({ x: axis(m.x, m.zeroAtMax.x), y: axis(m.y, m.zeroAtMax.y), z: axis(m.z, m.zeroAtMax.z) }, 'manual');
}

/** The same box in WORK coordinates (what the 3D view draws): machine position minus the work offset */
export function bedInWork(b: MachineBed, wco: { x: number; y: number; z: number }) {
  return { minX: b.minX - wco.x, maxX: b.maxX - wco.x, minY: b.minY - wco.y, maxY: b.maxY - wco.y, minZ: b.minZ - wco.z, maxZ: b.maxZ - wco.z };
}
