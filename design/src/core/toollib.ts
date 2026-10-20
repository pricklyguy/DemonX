/**
 * The tool library: the cutters the shop owns, with what is known about each (kind, size, angle) and the cutting recipes
 * tried for them (machine, material, speeds and feeds). It lives on the server (so every computer sees the same one) and
 * is loaded from a JSON file made from the shop's library database (`scripts/library-from-sqlite.py`). A tool whose
 * geometry is not known yet is kept as "pending" and cannot be put in a job until it is filled in.
 */
import type { CncTool, ToolKind } from './cnc';
import { TOOL_KINDS } from './cnc';

export type LibKind = ToolKind | 'other';
export const LIB_KINDS: LibKind[] = [...TOOL_KINDS, 'other'];

export interface LibRecipe {
  machine: string;
  material: string;
  /** As the shop wrote it: "Approved", "Testing Required", "Unapproved - Geometry", ... */
  status: string;
  rpm?: number;
  /** mm/min */
  feed?: number;
  plunge?: number;
  /** Depth per pass, mm */
  passDepth?: number;
  /** Distance between passes, mm */
  stepoverMm?: number;
  notes?: string;
}

export interface LibTool {
  id: string;
  name: string;
  manufacturer?: string;
  part?: string;
  /** null while it is not known */
  kind: LibKind | null;
  /** Cutting diameter, mm (the widest cut of a V-bit) */
  diameter?: number;
  /** Included angle of a V-bit, degrees */
  vAngle?: number;
  /** A tapered ball nose: `diameter` is the ball at the tip, `taper` the included angle of the taper above it (degrees) and `maxDiameter` the cutting diameter at the top of it (mm) */
  taper?: number;
  maxDiameter?: number;
  flutes?: number;
  shank?: number;
  priority?: string;
  ownership?: string;
  notes?: string;
  recipes: LibRecipe[];
}

export interface ToolLibrary { v: 1; tools: LibTool[] }

export const EMPTY_LIBRARY: ToolLibrary = { v: 1, tools: [] };
const MAX_TOOLS = 1000, MAX_RECIPES = 200;

const str = (v: unknown, what: string, max = 500, optional = true): string | undefined => {
  if (v === undefined || v === null || v === '') { if (optional) return undefined; throw new Error(`${what} is missing`); }
  if (typeof v !== 'string' || v.length > max) throw new Error(`${what} is not valid`);
  return v;
};
const numOpt = (v: unknown, what: string, lo: number, hi: number): number | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) throw new Error(`${what} is not valid`);
  return v;
};

/** Check a library (from a file or from the server). Throws an Error with a plain message. */
export function parseToolLibrary(raw: unknown): ToolLibrary {
  const o = raw as { v?: unknown; tools?: unknown } | null;
  if (!o || typeof o !== 'object' || o.v !== 1 || !Array.isArray(o.tools)) throw new Error('This is not a DemonX tool library file');
  if (o.tools.length > MAX_TOOLS) throw new Error('That is too many tools');
  const seen = new Set<string>();
  const tools = o.tools.map((t: any, i: number): LibTool => {
    const w = `Tool ${i + 1}`;
    if (!t || typeof t !== 'object') throw new Error(`${w} is damaged`);
    const id = str(t.id, `${w}: id`, 60, false)!;
    if (seen.has(id)) throw new Error(`Two tools have the id ${id}`);
    seen.add(id);
    if (t.kind !== null && t.kind !== undefined && !LIB_KINDS.includes(t.kind)) throw new Error(`${w}: the kind must be one of ${LIB_KINDS.join(', ')}`);
    if (!Array.isArray(t.recipes) || t.recipes.length > MAX_RECIPES) throw new Error(`${w}: its recipes are damaged`);
    const tool: LibTool = {
      id, name: str(t.name, `${w}: name`, 120, false)!, kind: t.kind ?? null,
      recipes: t.recipes.map((r: any, j: number): LibRecipe => {
        const rw = `${w}, recipe ${j + 1}`;
        if (!r || typeof r !== 'object') throw new Error(`${rw} is damaged`);
        const rec: LibRecipe = { machine: str(r.machine, `${rw}: machine`, 80, false)!, material: str(r.material, `${rw}: material`, 80, false)!, status: str(r.status, `${rw}: status`, 80, false)! };
        const rpm = numOpt(r.rpm, `${rw}: rpm`, 1, 100000), feed = numOpt(r.feed, `${rw}: feed`, 0.001, 20000), plunge = numOpt(r.plunge, `${rw}: plunge`, 0.001, 20000);
        const pass = numOpt(r.passDepth, `${rw}: pass depth`, 0.0001, 500), step = numOpt(r.stepoverMm, `${rw}: stepover`, 0.0001, 500);
        if (rpm !== undefined) rec.rpm = rpm;
        if (feed !== undefined) rec.feed = feed;
        if (plunge !== undefined) rec.plunge = plunge;
        if (pass !== undefined) rec.passDepth = pass;
        if (step !== undefined) rec.stepoverMm = step;
        const n = str(r.notes, `${rw}: notes`, 1000); if (n) rec.notes = n;
        return rec;
      }),
    };
    for (const [k, max] of [['manufacturer', 80], ['part', 80], ['priority', 120], ['ownership', 120], ['notes', 2000]] as const) { const v = str(t[k], `${w}: ${k}`, max); if (v) (tool as any)[k] = v; }
    const dia = numOpt(t.diameter, `${w}: diameter`, 0.001, 500), ang = numOpt(t.vAngle, `${w}: V angle`, 0.1, 179), fl = numOpt(t.flutes, `${w}: flutes`, 1, 12), sh = numOpt(t.shank, `${w}: shank`, 0.001, 500);
    if (dia !== undefined) tool.diameter = dia;
    if (ang !== undefined) tool.vAngle = ang;
    const tp = numOpt(t.taper, `${w}: taper`, 0.5, 60), md = numOpt(t.maxDiameter, `${w}: largest diameter`, 0.001, 500);
    if (tp !== undefined) tool.taper = tp;
    if (md !== undefined) tool.maxDiameter = md;
    if (fl !== undefined) tool.flutes = Math.round(fl);
    if (sh !== undefined) tool.shank = sh;
    return tool;
  });
  return { v: 1, tools };
}

/** Whether a tool can be put in a job: a kind Design can cut with, a diameter and, for a V-bit, its angle. */
export function geometryOk(t: LibTool): boolean {
  if (!t.kind || t.kind === 'other' || !(t.diameter && t.diameter > 0)) return false;
  if (t.kind === 'ball' && t.taper && !(t.maxDiameter && t.maxDiameter > t.diameter)) return false;
  return t.kind !== 'vbit' || !!(t.vAngle && t.vAngle > 0 && t.vAngle < 180);
}

/** What is missing from a tool, in words, for the list (empty when it is ready) */
export function geometryGaps(t: LibTool): string[] {
  const out: string[] = [];
  if (!t.kind) out.push('the kind');
  else if (t.kind === 'other') out.push('not a kind Design can cut with');
  if (t.kind !== 'other' && !(t.diameter && t.diameter > 0)) out.push('the diameter');
  if (t.kind === 'vbit' && !(t.vAngle && t.vAngle > 0)) out.push('the angle');
  if (t.kind === 'ball' && t.taper && !(t.maxDiameter && t.diameter && t.maxDiameter > t.diameter)) out.push('the largest diameter of the taper');
  return out;
}

export const isApproved = (r: LibRecipe) => /^approved/i.test(r.status);
/** A recipe with the numbers a toolpath needs (rpm, feed and plunge) */
export const recipeComplete = (r: LibRecipe) => !!(r.rpm && r.feed && r.plunge);

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);

/** A job tool from a library tool, using a recipe's speeds and feeds when one is given (otherwise cautious defaults to be checked). */
export function toJobTool(t: LibTool, recipe?: LibRecipe): CncTool {
  if (!geometryOk(t)) throw new Error(t.kind === 'other' ? `${t.name} is a kind of cutter Design cannot cut with` : `${t.name} is missing ${geometryGaps(t).join(' and ')}`);
  const kind = t.kind as ToolKind;
  const d = t.diameter!;
  const stepover = kind === 'drill' ? 0 : recipe?.stepoverMm ? Math.min(100, Math.max(1, (recipe.stepoverMm / d) * 100)) : 40;
  const id = `lib-${slug(t.id)}${recipe ? `-${slug(recipe.machine)}-${slug(recipe.material)}` : ''}`.slice(0, 60);
  return {
    id, name: `${t.name}${recipe ? ` · ${recipe.material}` : ''}`.slice(0, 80), kind, diameter: d, flutes: t.flutes ?? 2,
    rpm: recipe?.rpm ?? 12000, feed: recipe?.feed ?? 600, plunge: recipe?.plunge ?? 200, stepdown: recipe?.passDepth ?? Math.max(0.2, Math.min(2, d / 2)),
    stepover: Math.round(stepover * 100) / 100, ...(kind === 'vbit' ? { vAngle: t.vAngle } : {}),
    ...(kind === 'ball' && t.taper ? { taperAngle: t.taper, maxDiameter: t.maxDiameter } : {}),
  };
}

/** Add the tools of a new library to the current one: the same id replaces the tool (its recipes with it). Returns the merged library and the counts. */
export function mergeLibraries(cur: ToolLibrary, add: ToolLibrary): { lib: ToolLibrary; added: number; replaced: number } {
  const byId = new Map(cur.tools.map((t) => [t.id, t]));
  let added = 0, replaced = 0;
  for (const t of add.tools) { if (byId.has(t.id)) replaced++; else added++; byId.set(t.id, t); }
  return { lib: { v: 1, tools: [...byId.values()] }, added, replaced };
}

/**
 * The recipe to offer for a machine and a material: an approved one with its speed, feed and plunge, else any with them, else none.
 * `machine` or `material` empty means any.
 */
export function bestRecipe(t: LibTool, machine: string, material: string): LibRecipe | undefined {
  const fit = t.recipes.filter((r) => (!machine || r.machine === machine) && (!material || r.material === material));
  return fit.find((r) => isApproved(r) && recipeComplete(r)) ?? fit.find(recipeComplete);
}

/** Whether a library tool belongs in a list for a machine and material: it has a recipe for them, or no recipes at all yet. */
export function fitsJob(t: LibTool, machine: string, material: string): boolean {
  if (!t.recipes.length) return true;
  return t.recipes.some((r) => (!machine || r.machine === machine) && (!material || r.material === material));
}

/** The machines the library has recipes for, and the materials it has for the machine (any machine when none is given), sorted */
export function libraryFilters(lib: ToolLibrary, machine = ''): { machines: string[]; materials: string[] } {
  const all = lib.tools.flatMap((t) => t.recipes);
  return { machines: [...new Set(all.map((r) => r.machine))].sort(), materials: [...new Set(all.filter((r) => !machine || r.machine === machine).map((r) => r.material))].sort() };
}
