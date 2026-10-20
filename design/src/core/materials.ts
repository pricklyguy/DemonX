// The material library: per laser, a list of materials, each with named cut settings (speed, power, passes ...) that can be
// assigned to a layer. Modelled on LightBurn's library (.clb files can be imported). Kept on the computer that runs the
// server (see server/src/library.ts); assigning copies the values into the layer, so a design file never depends on the library.
import type { Layer, LayerMode } from './types';

/** The settings an entry carries. interval and overscan are optional: an entry without them leaves the layer's own. */
export interface LibraryEntry {
  /** What the user calls it, e.g. "Light etch, no air" */
  name: string;
  /** Material thickness in mm for a cut-out, or null for engraving and lines (they are listed under `group`) */
  thickness: number | null;
  /** Heading under the material when there is no thickness, e.g. "Engraving" or "Line (score)" */
  group: string;
  mode: Exclude<LayerMode, 'tool'>;
  speed: number;
  power: number;
  minPower: number;
  passes: number;
  air: boolean;
  interval?: number;
  overscan?: number;
}

export interface LibraryMaterial { name: string; entries: LibraryEntry[] }
export interface Library { name: string; materials: LibraryMaterial[] }
export interface Libraries { v: 1; libraries: Library[] }

export const emptyLibraries = (): Libraries => ({ v: 1, libraries: [] });

/** The heading an entry is listed under inside its material */
export const groupOf = (e: LibraryEntry): string => (e.thickness !== null ? `${Math.round(e.thickness * 1000) / 1000} mm` : e.group || 'General');

const LIMIT = { text: 120, materials: 500, entries: 2000 };
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || v.length > LIMIT.text) throw new Error(`${what} must be text of at most ${LIMIT.text} characters`);
  return v;
};
const nr = (v: unknown, what: string, lo: number, hi: number): number => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) throw new Error(`${what} must be a number from ${lo} to ${hi}`);
  return v;
};

function readEntry(v: unknown, where: string): LibraryEntry {
  if (!isObj(v)) throw new Error(`${where} is damaged`);
  const mode = v.mode;
  if (mode !== 'cut' && mode !== 'engrave' && mode !== 'score') throw new Error(`${where}: mode must be cut, engrave or score`);
  const power = nr(v.power, `${where}: power`, 0, 100);
  const minPower = v.minPower === undefined ? power : nr(v.minPower, `${where}: minimum power`, 0, 100);
  if (minPower > power) throw new Error(`${where}: the minimum power is above the maximum`);
  const passes = nr(v.passes ?? 1, `${where}: passes`, 1, 999);
  if (!Number.isInteger(passes)) throw new Error(`${where}: passes must be a whole number`);
  return {
    name: text(v.name, `${where}: name`),
    thickness: v.thickness === null || v.thickness === undefined ? null : nr(v.thickness, `${where}: thickness`, 0.001, 1000),
    group: v.group === undefined ? '' : text(v.group, `${where}: group`),
    mode, speed: nr(v.speed, `${where}: speed`, 0.001, 100000), power, minPower, passes,
    air: v.air === true,
    ...(v.interval === undefined ? {} : { interval: nr(v.interval, `${where}: interval`, 0.01, 10) }),
    ...(v.overscan === undefined ? {} : { overscan: nr(v.overscan, `${where}: overscan`, 0, 50) }),
  };
}

/** Strict: anything unexpected is refused with a plain message (the server uses this before it writes the file). */
export function parseLibraries(v: unknown): Libraries {
  if (!isObj(v) || v.v !== 1 || !Array.isArray(v.libraries)) throw new Error('This is not a material library file');
  if (v.libraries.length > 50) throw new Error('Too many libraries');
  const seen = new Set<string>();
  const libraries = v.libraries.map((l, i): Library => {
    if (!isObj(l) || !Array.isArray(l.materials)) throw new Error(`Library ${i + 1} is damaged`);
    const name = text(l.name, `Library ${i + 1}: name`).trim();
    if (!name || seen.has(name)) throw new Error(`Library ${i + 1}: needs its own name`);
    seen.add(name);
    if (l.materials.length > LIMIT.materials) throw new Error(`Library "${name}" has too many materials`);
    let total = 0;
    const materials = l.materials.map((m, j): LibraryMaterial => {
      if (!isObj(m) || !Array.isArray(m.entries)) throw new Error(`Material ${j + 1} in "${name}" is damaged`);
      total += m.entries.length;
      if (total > LIMIT.entries) throw new Error(`Library "${name}" has too many entries`);
      const mn = text(m.name, `Material ${j + 1} in "${name}": name`).trim();
      return { name: mn, entries: m.entries.map((e, k) => readEntry(e, `"${mn}" entry ${k + 1}`)) };
    });
    return { name, materials };
  });
  return { v: 1, libraries };
}

// ---------- changes (pure: they return new objects) ----------

export const entryFromLayer = (layer: Layer, name: string, thickness: number | null, group: string): LibraryEntry => ({
  name, thickness, group: thickness === null ? group : '',
  mode: layer.mode === 'tool' ? 'cut' : layer.mode,
  speed: layer.speed, power: layer.power, minPower: layer.minPower, passes: layer.passes, air: layer.air,
  ...(layer.mode === 'engrave' ? { interval: layer.interval, overscan: layer.overscan } : {}),
});

/** The layer_set arguments that make a layer follow an entry */
export const layerPatch = (e: LibraryEntry) => ({
  mode: e.mode, speed: e.speed, power: e.power, minPower: e.minPower, passes: e.passes, air: e.air,
  ...(e.interval === undefined ? {} : { interval: e.interval }),
  ...(e.overscan === undefined ? {} : { overscan: e.overscan }),
});

/** Add an entry under a material (the material is made when new). A same-named entry in the same group is replaced. */
export function putEntry(lib: Library, material: string, entry: LibraryEntry): Library {
  const mats = lib.materials.some((m) => m.name === material) ? lib.materials : [...lib.materials, { name: material, entries: [] }];
  return {
    ...lib,
    materials: mats.map((m) => {
      if (m.name !== material) return m;
      const same = (e: LibraryEntry) => e.name === entry.name && groupOf(e) === groupOf(entry);
      return { ...m, entries: m.entries.some(same) ? m.entries.map((e) => (same(e) ? entry : e)) : [...m.entries, entry] };
    }),
  };
}

/** A name that is not taken yet in the material's group: "Cutout", "Cutout copy", "Cutout copy 2" ... */
export function freeName(m: LibraryMaterial | undefined, base: string, group: string): string {
  const taken = new Set((m?.entries ?? []).filter((e) => groupOf(e) === group).map((e) => e.name));
  if (!taken.has(base)) return base;
  let n = 1;
  for (;;) { const c = n === 1 ? `${base} copy` : `${base} copy ${n}`; if (!taken.has(c)) return c; n++; }
}

// ---------- LightBurn .clb import ----------

const unescapeXml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const attrs = (tag: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([A-Za-z_][\w-]*)="([^"]*)"/g)) out[m[1]] = unescapeXml(m[2]);
  return out;
};

/**
 * Reads a LightBurn material library (.clb). Only what this program uses is taken (mode, speed, powers, passes, air, interval,
 * overscan); LightBurn's other fields (tabs, dot time, priority ...) are left out. Throws a plain message when it is not a library.
 */
export function importClb(xml: string, fallbackName = 'Imported'): Library {
  const head = /<LightBurnLibrary\b([^>]*)>/.exec(xml);
  if (!head) throw new Error('This is not a LightBurn material library (.clb)');
  const name = attrs(head[1]).DisplayName?.trim() || fallbackName;
  const materials: LibraryMaterial[] = [];
  for (const mm of xml.matchAll(/<Material\b([^>]*)>([\s\S]*?)<\/Material>/g)) {
    const entries: LibraryEntry[] = [];
    for (const em of mm[2].matchAll(/<Entry\b([^>]*)>([\s\S]*?)<\/Entry>/g)) {
      const ea = attrs(em[1]);
      const cs = /<CutSetting\b([^>]*)>([\s\S]*?)<\/CutSetting>/.exec(em[2]);
      if (!cs) continue;
      const kind = attrs(cs[1]).type;
      const val: Record<string, number> = {};
      for (const vm of cs[2].matchAll(/<(\w+)\s+Value="([^"]*)"\s*\/>/g)) { const n = Number(vm[2]); if (Number.isFinite(n)) val[vm[1]] = n; }
      const thick = Number(ea.Thickness);
      const thickness = Number.isFinite(thick) && thick > 0 ? thick : null;
      const power = Math.min(100, Math.max(0, val.maxPower ?? 0));
      const entry: LibraryEntry = {
        name: (ea.Desc ?? '').trim() || 'Settings',
        thickness, group: thickness === null ? (ea.NoThickTitle ?? '').trim() : '',
        mode: kind === 'Scan' ? 'engrave' : thickness !== null ? 'cut' : 'score',
        speed: Math.min(100000, Math.max(0.001, val.speed ?? 10)),
        power,
        minPower: Math.min(power, Math.max(0, val.minPower ?? power)),
        passes: Math.max(1, Math.min(999, Math.round(val.numPasses ?? 1))),
        air: val.runBlower === 1,
        ...(val.interval !== undefined ? { interval: Math.min(10, Math.max(0.01, val.interval)) } : {}),
        ...(val.overscan !== undefined ? { overscan: Math.min(50, Math.max(0, val.overscan)) } : {}),
      };
      entries.push(entry);
    }
    materials.push({ name: (attrs(mm[1]).name ?? '').trim() || 'Material', entries });
  }
  if (!materials.length) throw new Error('That library has no materials');
  return { name, materials };
}
