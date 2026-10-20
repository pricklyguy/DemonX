import type { Anchor } from '../core/geom';
import type { Workspace } from '../core/types';

/** A saved CNC setup: the stock and how it is held and zeroed */
export interface CncSetup { name: string; width: number; height: number; thickness: number; datum: Anchor; zZero: Workspace['zZero']; sides: 1 | 2 }
/** A saved canvas: a page of a given size for a design that is not for a machine */
export interface CanvasSetup { name: string; width: number; height: number }

const STORE_CNC = 'design-cnc-setups';
const STORE_CANVAS = 'design-canvas-setups';
const STORE_LAST = 'design-last-job';

const ANCHORS = ['tl', 'tc', 'tr', 'ml', 'c', 'mr', 'bl', 'bc', 'br'];

/** The positions of 0,0 the New Job screen offers for a CNC job: the four corners and the middle */
export const DATUM_CHOICES: Anchor[] = ['tl', 'tr', 'c', 'bl', 'br'];

function read<T>(key: string, ok: (v: any) => v is T): T[] {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(raw) ? raw.filter(ok) : [];
  } catch { return []; }
}
const write = (key: string, list: unknown[]) => { try { localStorage.setItem(key, JSON.stringify(list)); } catch { /* it just will not be remembered */ } };

const isNum = (v: unknown, min = 0): v is number => typeof v === 'number' && Number.isFinite(v) && v > min;

export function loadCncSetups(): CncSetup[] {
  return read<any>(STORE_CNC, (d): d is CncSetup => !!d && typeof d.name === 'string' && !!d.name.trim() && isNum(d.width) && isNum(d.height) && isNum(d.thickness))
    .map((d) => ({ ...d, datum: ANCHORS.includes(d.datum) ? d.datum : 'bl', zZero: d.zZero === 'bed' ? 'bed' : 'surface', sides: d.sides === 2 ? 2 : 1 }) as CncSetup);
}
export const saveCncSetups = (list: CncSetup[]) => write(STORE_CNC, list);

export function loadCanvasSetups(): CanvasSetup[] {
  return read<CanvasSetup>(STORE_CANVAS, (d): d is CanvasSetup => !!d && typeof d.name === 'string' && !!d.name.trim() && isNum(d.width) && isNum(d.height));
}
export const saveCanvasSetups = (list: CanvasSetup[]) => write(STORE_CANVAS, list);

/** What was typed on the New Job screen last time, so the next one starts the same way */
export interface LastJob { type: 'cnc' | 'laser' | 'canvas'; width: number; height: number; thickness: number; sides: 1 | 2; zZero: Workspace['zZero']; datum: Anchor }
export const DEFAULT_JOB: LastJob = { type: 'cnc', width: 600, height: 400, thickness: 18, sides: 1, zZero: 'surface', datum: 'bl' };
export function loadLastJob(): LastJob {
  try {
    const v = JSON.parse(localStorage.getItem(STORE_LAST) ?? 'null');
    if (v && ['cnc', 'laser', 'canvas'].includes(v.type) && isNum(v.width) && isNum(v.height)) {
      return { type: v.type, width: v.width, height: v.height, thickness: typeof v.thickness === 'number' && v.thickness >= 0 ? v.thickness : DEFAULT_JOB.thickness, sides: v.sides === 2 ? 2 : 1, zZero: v.zZero === 'bed' ? 'bed' : 'surface', datum: DATUM_CHOICES.includes(v.datum) ? v.datum : 'bl' };
    }
  } catch { /* nothing remembered */ }
  return { ...DEFAULT_JOB };
}
export const saveLastJob = (j: LastJob) => { try { localStorage.setItem(STORE_LAST, JSON.stringify(j)); } catch { /* it just will not be remembered */ } };
