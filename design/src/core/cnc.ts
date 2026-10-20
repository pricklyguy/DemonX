/** CNC job data: the tool library and the toolpaths of a design. Everything in millimetres. */

export type ToolKind = 'flat' | 'ball' | 'vbit' | 'drill';
export const TOOL_KINDS: ToolKind[] = ['flat', 'ball', 'vbit', 'drill'];

export interface CncTool {
  id: string;
  name: string;
  kind: ToolKind;
  /** Cutting diameter, mm */
  diameter: number;
  /** Included angle of a V-bit, degrees */
  vAngle?: number;
  /** A tapered ball nose: the included angle of the taper above the ball (degrees) and the cutting diameter at the top of it (mm). `diameter` is the ball at the tip. Absent for a plain ball nose. */
  taperAngle?: number;
  maxDiameter?: number;
  flutes: number;
  rpm: number;
  /** Cutting feed, mm/min */
  feed: number;
  /** Plunge feed, mm/min */
  plunge: number;
  /** Most it cuts per pass, mm */
  stepdown: number;
  /** Distance between clearing passes, percent of the diameter */
  stepover: number;
}

export type ToolpathKind = 'profile' | 'pocket' | 'drill' | 'engrave' | 'vcarve' | 'plug' | 'photo' | 'finish3d' | 'rough3d';
export const TOOLPATH_KINDS: ToolpathKind[] = ['profile', 'pocket', 'drill', 'engrave', 'vcarve', 'plug', 'photo', 'finish3d', 'rough3d'];
export type ProfileSide = 'outside' | 'inside' | 'on';
export const PROFILE_SIDES: ProfileSide[] = ['outside', 'inside', 'on'];

export interface Toolpath {
  id: number;
  name: string;
  kind: ToolpathKind;
  toolId: string;
  shapeIds: number[];
  /** Profile only */
  side: ProfileSide;
  direction: 'climb' | 'conventional';
  /** Where cutting starts and ends, measured down from the top of the material (mm, positive) */
  startDepth: number;
  cutDepth: number;
  /** Material left on the walls (mm) */
  allowance: number;
  /** Height above the top of the material for rapid moves (mm) */
  safeZ: number;
  visible: boolean;
  /** Cut as the mirror image about the vertical line through the middle of its shapes (the plug of an inlay, which is turned over) */
  mirror?: boolean;
  /** Photo toolpaths only: the picture and how it is cut */
  photo?: PhotoSpec;
  /** 3D toolpaths only: which 3D shape (doc.reliefs) and how the lines run */
  reliefId?: number;
  scan?: ScanSpec;
  /** 3D roughing: ramp into each cut at this angle (degrees) instead of plunging; 0 or absent plunges */
  rampAngle?: number;
}

export interface ScanSpec {
  /** Lines along X or along Y */
  dir: 'x' | 'y';
  /** Distance between lines, mm */
  stepoverMm: number;
  /** 3D finishing: a second pass at right angles to the first */
  cross?: boolean;
}

/** Check a scan setting (from a command or a file). Throws an Error with a plain message. */
export function parseScan(v: unknown): ScanSpec {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') throw new Error('The scan settings are missing');
  if (o.dir !== 'x' && o.dir !== 'y') throw new Error('The line direction must be x or y');
  if (typeof o.stepoverMm !== 'number' || !Number.isFinite(o.stepoverMm) || o.stepoverMm < 0.02 || o.stepoverMm > 500) throw new Error('The stepover must be 0.02 to 500 mm');
  if (o.cross !== undefined && typeof o.cross !== 'boolean') throw new Error('The cross pass setting is not valid');
  return { dir: o.dir, stepoverMm: o.stepoverMm, ...(o.cross ? { cross: true } : {}) };
}

export interface CncData {
  tools: CncTool[];
  toolpaths: Toolpath[];
  nextToolpathId: number;
  /** Name of the post processor used to write G-code */
  post: string;
  /** The machine and the material of this job, as the tool library names them (they choose which recipes are offered) */
  machine?: string;
  material?: string;
}

export const DEFAULT_TOOLS: CncTool[] = [
  { id: 'flat-6', name: '6 mm flat end mill', kind: 'flat', diameter: 6, flutes: 2, rpm: 16000, feed: 1200, plunge: 400, stepdown: 2, stepover: 40 },
  { id: 'flat-3', name: '3.175 mm flat end mill', kind: 'flat', diameter: 3.175, flutes: 2, rpm: 18000, feed: 900, plunge: 300, stepdown: 1, stepover: 40 },
  { id: 'ball-3', name: '3.175 mm ball nose', kind: 'ball', diameter: 3.175, flutes: 2, rpm: 18000, feed: 800, plunge: 300, stepdown: 1, stepover: 15 },
  { id: 'vbit-60', name: '60° V-bit', kind: 'vbit', diameter: 12.7, vAngle: 60, flutes: 2, rpm: 18000, feed: 800, plunge: 300, stepdown: 1.5, stepover: 30 },
  { id: 'drill-3', name: '3 mm drill', kind: 'drill', diameter: 3, flutes: 2, rpm: 12000, feed: 300, plunge: 150, stepdown: 3, stepover: 0 },
];

export function defaultCnc(tools: CncTool[] = DEFAULT_TOOLS): CncData {
  return { tools: tools.map((t) => ({ ...t })), toolpaths: [], nextToolpathId: 1, post: 'GRBL (mm)' };
}

/** The most pixels along the longer side of a stored picture (a bigger one is shrunk before it is kept). */
export const PHOTO_MAX_SIDE = 400;

export interface PhotoSpec {
  /** Pixels of the stored grey picture, row by row from the top, one byte each (0 black, 255 white), as base64 */
  w: number;
  h: number;
  data: string;
  /** Where the lower left corner of the picture is, and how wide it is, mm (the height follows) */
  x: number;
  y: number;
  width: number;
  mode: 'lines' | 'dots';
  /** Distance between lines (or between dots), mm */
  spacing: number;
  /** Direction of the lines: along X or along Y */
  dir: 'x' | 'y';
  /** Dark is shallow and light is deep, instead of the other way */
  invert: boolean;
}

export const base64ToBytes = (b64: string): Uint8Array => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
export const bytesToBase64 = (bytes: Uint8Array): string => {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

/** Check a photo setting (from a command or a file). Throws an Error with a plain message. */
export function parsePhoto(v: unknown): PhotoSpec {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') throw new Error('The photo settings are missing');
  const int = (k: string) => { const n = o[k]; if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > PHOTO_MAX_SIDE) throw new Error(`The picture ${k === 'w' ? 'width' : 'height'} must be 1 to ${PHOTO_MAX_SIDE} pixels`); return n; };
  const num = (k: string, lo: number, hi: number, what: string) => { const n = o[k]; if (typeof n !== 'number' || !Number.isFinite(n) || n < lo || n > hi) throw new Error(`${what} is not valid`); return n; };
  const w = int('w'), h = int('h');
  if (typeof o.data !== 'string' || o.data.length > Math.ceil((PHOTO_MAX_SIDE * PHOTO_MAX_SIDE * 4) / 3) + 8) throw new Error('The picture is damaged');
  let bytes: Uint8Array;
  try { bytes = base64ToBytes(o.data); } catch { throw new Error('The picture is damaged'); }
  if (bytes.length !== w * h) throw new Error('The picture does not match its size');
  if (o.mode !== 'lines' && o.mode !== 'dots') throw new Error('The photo style must be lines or dots');
  if (o.dir !== 'x' && o.dir !== 'y') throw new Error('The line direction must be x or y');
  if (typeof o.invert !== 'boolean') throw new Error('The invert setting is not valid');
  return {
    w, h, data: o.data, x: num('x', -1e5, 1e5, 'The picture position'), y: num('y', -1e5, 1e5, 'The picture position'), width: num('width', 0.1, 1e5, 'The picture width'),
    mode: o.mode, spacing: num('spacing', 0.05, 1000, 'The spacing'), dir: o.dir, invert: o.invert,
  };
}

/** The shape of a tool for the 3D toolpaths: how far above its tip its cutting surface is at a sideways distance d from its axis, and how far out it reaches. */
export function toolProfile(tool: CncTool): { rMax: number; z: (d: number) => number } {
  const R = tool.diameter / 2;
  if (tool.kind === 'ball') {
    if (tool.taperAngle && tool.maxDiameter && tool.maxDiameter > tool.diameter) {
      const beta = (tool.taperAngle * Math.PI) / 360, tanB = Math.tan(beta);
      const dt = R * Math.cos(beta), ht = R * (1 - Math.sin(beta));   // where the cone leaves the ball
      return { rMax: tool.maxDiameter / 2, z: (d) => (d <= dt ? R - Math.sqrt(Math.max(0, R * R - d * d)) : ht + (d - dt) / tanB) };
    }
    return { rMax: R, z: (d) => R - Math.sqrt(Math.max(0, R * R - d * d)) };
  }
  if (tool.kind === 'vbit' && tool.vAngle) { const t = Math.tan((tool.vAngle * Math.PI) / 360); return { rMax: R, z: (d) => d / t }; }
  return { rMax: R, z: () => 0 };
}

/** Check the taper of a ball nose (from a command or a file). Throws an Error with a plain message. */
export function parseTaper(v: { diameter: number; taperAngle?: unknown; maxDiameter?: unknown }): { taperAngle: number; maxDiameter: number } | null {
  if (v.taperAngle === undefined && v.maxDiameter === undefined) return null;
  const a = v.taperAngle, m = v.maxDiameter;
  if (typeof a !== 'number' || !Number.isFinite(a) || a < 0.5 || a > 60) throw new Error('The taper angle must be 0.5 to 60 degrees');
  if (typeof m !== 'number' || !Number.isFinite(m) || m <= v.diameter || m > 500) throw new Error('The largest diameter must be more than the ball at the tip');
  return { taperAngle: a, maxDiameter: m };
}
