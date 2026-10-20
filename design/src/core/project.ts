// The project file: everything in a design (shapes, layers with their laser settings, the machine, the job size) as one
// JSON file, so a design can be saved, reopened and sent to someone. Reading is strict: a damaged or odd file is refused
// with a message that says what is wrong, and the numbers are checked, so a bad file cannot put NaN or huge values into
// the drawing or the laser job.
import type { FillMode } from './fill';
import type { Doc, Layer, LayerMode, Machine, PathShape, Pt, Shape, TextRecord, Workspace } from './types';
import { FREE_WORKSPACE, MACHINE_3018_LASER } from './types';
import { parseRelief, MAX_RELIEFS } from './relief';
import { parseTaper, parseScan, parsePhoto, PROFILE_SIDES, TOOLPATH_KINDS, TOOL_KINDS, type CncData, type CncTool, type Toolpath } from './cnc';

export const PROJECT_FORMAT = 'demonx-design';
export const PROJECT_VERSION = 1;
export const PROJECT_EXTENSION = '.dxd';

export class ProjectError extends Error {}

const LIMITS = { layers: 200, shapes: 200_000, points: 5_000_000, name: 80, coord: 1e6 };
const MODES: LayerMode[] = ['cut', 'engrave', 'score', 'tool'];
const ANCHORS = ['tl', 'tc', 'tr', 'ml', 'c', 'mr', 'bl', 'bc', 'br'];

export function serializeProject(doc: Doc): string {
  // a record of editable text whose letters are gone (deleted, or grouped with other shapes) is not kept
  const groups = new Set(doc.shapes.map((s) => s.group));
  const out = doc.texts ? { ...doc, texts: doc.texts.filter((t) => groups.has(t.group)) } : doc;
  if (out.texts && !out.texts.length) delete out.texts;
  if (out.reliefs && !out.reliefs.length) { const { reliefs: _none, ...rest } = out; return JSON.stringify({ format: PROJECT_FORMAT, version: PROJECT_VERSION, doc: rest }, null, 1) + '\n'; }
  return JSON.stringify({ format: PROJECT_FORMAT, version: PROJECT_VERSION, doc: out }, null, 1) + '\n';
}

function readCnc(raw: unknown, shapes: Shape[]): CncData {
  if (!isObj(raw)) throw new ProjectError('The CNC settings are damaged');
  if (!Array.isArray(raw.tools) || raw.tools.length > 200 || !Array.isArray(raw.toolpaths) || raw.toolpaths.length > 5000) throw new ProjectError('The CNC tools or toolpaths are damaged');
  const text = (v: unknown, what: string, max = 120) => { if (typeof v !== 'string' || !v.trim() || v.length > max) throw new ProjectError(`${what} is not valid`); return v; };
  const tools: CncTool[] = raw.tools.map((t: unknown, i: number) => {
    const w = `Tool ${i + 1}`;
    if (!isObj(t) || !TOOL_KINDS.includes(t.kind as any)) throw new ProjectError(`${w} is damaged`);
    const kind = t.kind as CncTool['kind'];
    return {
      id: text(t.id, `${w}: id`, 60), name: text(t.name, `${w}: name`, 80), kind,
      diameter: num(t.diameter, `${w}: diameter`, 1e-6, 500), flutes: num(t.flutes, `${w}: flutes`, 1, 12), rpm: num(t.rpm, `${w}: rpm`, 1, 1e5),
      feed: num(t.feed, `${w}: feed`, 1e-6, 2e4), plunge: num(t.plunge, `${w}: plunge`, 1e-6, 2e4), stepdown: num(t.stepdown, `${w}: stepdown`, 1e-6, 500),
      stepover: num(t.stepover, `${w}: stepover`, 0, 100), ...(kind === 'vbit' ? { vAngle: num(t.vAngle, `${w}: angle`, 1, 179) } : {}),
      ...(t.taperAngle === undefined && t.maxDiameter === undefined ? {} : kind !== 'ball' ? (() => { throw new ProjectError(`${w}: only a ball nose can be tapered`); })() : (() => { try { return parseTaper({ diameter: t.diameter as number, taperAngle: t.taperAngle, maxDiameter: t.maxDiameter }) ?? {}; } catch (e) { throw new ProjectError(`${w}: ${(e as Error).message}`); } })()),
    };
  });
  if (new Set(tools.map((t) => t.id)).size !== tools.length) throw new ProjectError('Two tools have the same id');
  const ids = new Set(shapes.map((s) => s.id));
  const toolpaths: Toolpath[] = raw.toolpaths.map((t: unknown, i: number) => {
    const w = `Toolpath ${i + 1}`;
    if (!isObj(t) || !TOOLPATH_KINDS.includes(t.kind as any) || !PROFILE_SIDES.includes(t.side as any) || (t.direction !== 'climb' && t.direction !== 'conventional')) throw new ProjectError(`${w} is damaged`);
    if (!Array.isArray(t.shapeIds) || t.shapeIds.length > 200000 || !t.shapeIds.every((n) => Number.isInteger(n))) throw new ProjectError(`${w}: its shapes are damaged`);
    const toolId = text(t.toolId, `${w}: tool`, 60);
    if (!tools.some((x) => x.id === toolId)) throw new ProjectError(`${w} uses a tool that is not in the list`);
    return {
      id: num(t.id, `${w}: id`, 1, 1e9), name: text(t.name, `${w}: name`, 80), kind: t.kind as Toolpath['kind'], toolId,
      shapeIds: (t.shapeIds as number[]).filter((n) => ids.has(n)), side: t.side as Toolpath['side'], direction: t.direction,
      startDepth: num(t.startDepth, `${w}: start depth`, 0, 1e4), cutDepth: num(t.cutDepth, `${w}: cut depth`, 1e-6, 1e4), allowance: num(t.allowance, `${w}: allowance`, 0, 1e3),
      safeZ: num(t.safeZ, `${w}: safe Z`, 1e-6, 1e4), visible: typeof t.visible === 'boolean' ? t.visible : true,
      ...(t.kind === 'photo' ? { photo: (() => { try { return parsePhoto(t.photo); } catch (e) { throw new ProjectError(`${w}: ${(e as Error).message}`); } })() } : {}),
      ...(t.kind === 'finish3d' || t.kind === 'rough3d' ? { reliefId: num(t.reliefId, `${w}: 3D shape`, 1, 1e9), scan: (() => { try { return parseScan(t.scan); } catch (e) { throw new ProjectError(`${w}: ${(e as Error).message}`); } })() } : {}),
      ...(t.rampAngle === undefined ? {} : t.kind === 'rough3d' && typeof t.rampAngle === 'number' && t.rampAngle > 0 && t.rampAngle <= 45 ? { rampAngle: t.rampAngle } : (() => { throw new ProjectError(`${w}: the ramp angle is damaged`); })()),
      ...(t.mirror === undefined ? {} : t.mirror === true ? { mirror: true } : (() => { throw new ProjectError(`${w}: the mirror setting is damaged`); })()),
    };
  });
  const maxId = toolpaths.reduce((m, t) => Math.max(m, t.id), 0);
  const opt = (v: unknown, what: string) => (v === undefined ? undefined : text(v, what, 80));
  const machine = opt(raw.machine, 'The job machine'), material = opt(raw.material, 'The job material');
  return { ...(machine ? { machine } : {}), ...(material ? { material } : {}), tools, toolpaths, nextToolpathId: Math.max(maxId + 1, typeof raw.nextToolpathId === 'number' && Number.isInteger(raw.nextToolpathId) ? raw.nextToolpathId : 1), post: text(raw.post, 'The post processor name') };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown, what: string, min = -Infinity, max = Infinity): number => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new ProjectError(`${what} is not a valid number`);
  return v;
};
const bool = (v: unknown, what: string): boolean => {
  if (typeof v !== 'boolean') throw new ProjectError(`${what} must be true or false`);
  return v;
};

const FILL_MODES = ['all', 'groups', 'individual', 'auto'];
const fillMode = (v: unknown, what: string): FillMode => {
  if (typeof v !== 'string' || !FILL_MODES.includes(v)) throw new ProjectError(`${what} must be all, groups, individual or auto`);
  return v as FillMode;
};

function readLayer(v: unknown, i: number): Layer {
  if (!isObj(v)) throw new ProjectError(`Layer ${i + 1} is damaged`);
  const name = v.name;
  if (typeof name !== 'string' || !name.trim() || name.length > LIMITS.name) throw new ProjectError(`Layer ${i + 1} has no usable name`);
  const w = `Layer "${name}"`;
  if (typeof v.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(v.color)) throw new ProjectError(`${w}: colour must look like #rrggbb`);
  if (!MODES.includes(v.mode as LayerMode)) throw new ProjectError(`${w}: mode must be cut, engrave, score or tool`);
  const passes = num(v.passes, `${w}: passes`, 1, 999);
  if (!Number.isInteger(passes)) throw new ProjectError(`${w}: passes must be a whole number`);
  const power = num(v.power, `${w}: power`, 0, 100);
  const minPower = v.minPower === undefined ? power : num(v.minPower, `${w}: minimum power`, 0, 100);
  if (minPower > power) throw new ProjectError(`${w}: the minimum power is above the maximum`);
  return {
    name, color: v.color, mode: v.mode as LayerMode,
    speed: num(v.speed, `${w}: speed`, 0.001, 100000),
    power, minPower,
    passes,
    visible: bool(v.visible, `${w}: visible`),
    output: v.output === undefined ? true : bool(v.output, `${w}: output`),
    air: v.air === undefined ? false : bool(v.air, `${w}: air`),
    interval: v.interval === undefined ? 0.1 : num(v.interval, `${w}: interval`, 0.01, 10),
    fillMode: v.fillMode === undefined ? 'all' : fillMode(v.fillMode, `${w}: fill mode`),
    overscan: v.overscan === undefined ? 1 : num(v.overscan, `${w}: overscan`, 0, 50),
  };
}

function readPoint(v: unknown, where: string): Pt {
  if (!Array.isArray(v) || v.length !== 2) throw new ProjectError(`${where}: a point is damaged`);
  return [num(v[0], `${where}: X`, -LIMITS.coord, LIMITS.coord), num(v[1], `${where}: Y`, -LIMITS.coord, LIMITS.coord)];
}

function readMachine(v: unknown): Machine {
  if (v === undefined) return { ...MACHINE_3018_LASER };
  if (!isObj(v)) throw new ProjectError('The machine settings are damaged');
  if (typeof v.name !== 'string' || !v.name.trim() || v.name.length > LIMITS.name) throw new ProjectError('The machine has no usable name');
  return {
    name: v.name,
    width: num(v.width, 'Machine width', 1, 100000), height: num(v.height, 'Machine height', 1, 100000),
    sMax: num(v.sMax, 'Machine S max', 1, 100000), rapid: num(v.rapid, 'Machine rapid speed', 1, 5000),
    ...(v.origin === 'tl' || v.origin === 'bl' ? { origin: v.origin } : {}),
  };
}

function readWorkspace(v: unknown): Workspace {
  if (v === undefined) return { ...FREE_WORKSPACE };
  if (!isObj(v)) throw new ProjectError('The job size is damaged');
  if (!['laser', 'cnc', 'canvas', 'free'].includes(v.kind as string)) throw new ProjectError('The job type must be laser, cnc, canvas or free');
  if (!ANCHORS.includes(v.datum as string)) throw new ProjectError('The job datum is damaged');
  if (v.zZero !== 'surface' && v.zZero !== 'bed') throw new ProjectError('The Z zero setting is damaged');
  const ws: Workspace = {
    kind: v.kind as Workspace['kind'], datum: v.datum as Workspace['datum'], zZero: v.zZero,
    width: num(v.width, 'Job width', 1, 100000), height: num(v.height, 'Job height', 1, 100000), thickness: num(v.thickness, 'Job thickness', 0, 10000),
  };
  if (ws.kind === 'cnc' && !(ws.thickness > 0)) throw new ProjectError('A CNC job needs a material thickness');
  if (v.sides !== undefined && v.sides !== 1 && v.sides !== 2) throw new ProjectError('The CNC sides setting is damaged (it must be 1 or 2)');
  if (ws.kind === 'cnc' && (v.sides === 1 || v.sides === 2)) ws.sides = v.sides;
  return ws;
}

/** Read a project file's text. Throws ProjectError with a plain message when it is not a usable DemonX Design file. */
export function parseProject(text: string): Doc {
  if (text.length > 200 * 1024 * 1024) throw new ProjectError('This file is too big to be a design');
  let json: unknown;
  try { json = JSON.parse(text); } catch { throw new ProjectError('This is not a DemonX Design file (it is not readable JSON)'); }
  if (!isObj(json) || json.format !== PROJECT_FORMAT) throw new ProjectError('This is not a DemonX Design file');
  if (typeof json.version !== 'number' || !Number.isInteger(json.version) || json.version < 1) throw new ProjectError('This file has no valid version');
  if (json.version > PROJECT_VERSION) throw new ProjectError(`This file was made by a newer version of DemonX Design (file version ${json.version}, this one reads up to ${PROJECT_VERSION}). Update the app to open it.`);
  const d = json.doc;
  if (!isObj(d)) throw new ProjectError('The design inside the file is missing');

  if (!Array.isArray(d.layers) || d.layers.length < 1 || d.layers.length > LIMITS.layers) throw new ProjectError('The layers are damaged');
  const layers = d.layers.map(readLayer);
  if (new Set(layers.map((l) => l.name)).size !== layers.length) throw new ProjectError('Two layers have the same name');
  const layerNames = new Set(layers.map((l) => l.name));

  if (!Array.isArray(d.shapes) || d.shapes.length > LIMITS.shapes) throw new ProjectError('The shapes are damaged or there are too many');
  const ids = new Set<number>();
  let points = 0;
  const shapes: Shape[] = d.shapes.map((raw, i) => {
    const w = `Shape ${i + 1}`;
    if (!isObj(raw)) throw new ProjectError(`${w} is damaged`);
    const id = num(raw.id, `${w}: id`, 1, 1e9);
    if (!Number.isInteger(id) || ids.has(id)) throw new ProjectError(`${w} has a repeated or invalid id`);
    ids.add(id);
    if (typeof raw.layer !== 'string' || !layerNames.has(raw.layer)) throw new ProjectError(`${w} is on a layer that does not exist`);
    let group: number | undefined;
    if (raw.group !== undefined) {
      if (typeof raw.group !== 'number' || !Number.isInteger(raw.group) || raw.group < 1 || raw.group > 1e9) throw new ProjectError(`${w} has an invalid group`);
      group = raw.group;
    }
    const g = group === undefined ? {} : { group };
    if (raw.kind === 'circle') {
      return { ...g, id, kind: 'circle', layer: raw.layer, cx: num(raw.cx, `${w}: centre X`, -LIMITS.coord, LIMITS.coord), cy: num(raw.cy, `${w}: centre Y`, -LIMITS.coord, LIMITS.coord), r: num(raw.r, `${w}: radius`, 1e-6, LIMITS.coord) };
    }
    if (raw.kind !== 'path') throw new ProjectError(`${w} has an unknown type`);
    if (!Array.isArray(raw.rings) || raw.rings.length < 1 || raw.rings.length > 100000) throw new ProjectError(`${w}: its outlines are damaged`);
    const closed = bool(raw.closed, `${w}: closed`);
    const rings = raw.rings.map((ring: unknown, k: number) => {
      if (!Array.isArray(ring) || ring.length < (closed ? 3 : 2)) throw new ProjectError(`${w}: outline ${k + 1} has too few points`);
      points += ring.length;
      if (points > LIMITS.points) throw new ProjectError('The design has too many points to open');
      return ring.map((p) => readPoint(p, `${w}`));
    });
    return { ...g, id, kind: 'path', layer: raw.layer, rings, closed } satisfies PathShape;
  });

  const maxId = shapes.reduce((m, s) => Math.max(m, s.id, s.group ?? 0), 0);
  const nextId = typeof d.nextId === 'number' && Number.isInteger(d.nextId) && d.nextId > maxId ? d.nextId : maxId + 1;
  const doc: Doc = { layers, shapes, nextId, machine: readMachine(d.machine), workspace: readWorkspace(d.workspace) };
  if (d.cnc !== undefined) doc.cnc = readCnc(d.cnc, shapes);
  if (d.reliefs !== undefined) {
    if (!Array.isArray(d.reliefs) || d.reliefs.length > MAX_RELIEFS) throw new ProjectError('The 3D shapes are damaged');
    const reliefs = d.reliefs.map((r: unknown, i: number) => { try { return parseRelief(r); } catch (e) { throw new ProjectError(`3D shape ${i + 1}: ${(e as Error).message}`); } });
    if (new Set(reliefs.map((r) => r.id)).size !== reliefs.length) throw new ProjectError('Two 3D shapes have the same id');
    if (reliefs.length) doc.reliefs = reliefs;
  }
  if (d.texts !== undefined) {
    const texts = readTexts(d.texts, shapes);
    if (texts.length) doc.texts = texts;
  }
  return doc;
}

/** The records of editable text; one that does not fit its letters (or is damaged) is dropped, the letters stay as plain shapes. */
function readTexts(raw: unknown, shapes: Shape[]): TextRecord[] {
  if (!Array.isArray(raw)) return [];
  const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const out: TextRecord[] = [];
  for (const t of raw.slice(0, 5000)) {
    if (!t || typeof t !== 'object') continue;
    const r = t as Record<string, any>;
    const box = r.box;
    if (!Number.isInteger(r.group) || typeof r.text !== 'string' || typeof r.font !== 'string' || r.text.length > 2000 || r.font.length > 200) continue;
    if (![r.height, r.spacing, r.lineSpacing, r.x, r.y].every(fin) || r.height <= 0 || r.lineSpacing <= 0 || !['left', 'center', 'right'].includes(r.align)) continue;
    if (!box || ![box.minX, box.minY, box.maxX, box.maxY].every(fin) || !Number.isInteger(r.count)) continue;
    if (shapes.filter((s) => s.group === r.group).length !== r.count) continue;
    let curve: TextRecord['curve'];
    if (r.curve !== undefined) {
      const c = r.curve;
      if (!c || !Array.isArray(c.pts) || c.pts.length < 2 || c.pts.length > 20000 || !fin(c.offset) || typeof c.closed !== 'boolean') continue;
      const pts: Pt[] = [];
      for (const q of c.pts) { if (!Array.isArray(q) || !fin(q[0]) || !fin(q[1])) { pts.length = 0; break; } pts.push([q[0], q[1]]); }
      if (!pts.length) continue;
      curve = { pts, closed: c.closed, offset: c.offset, flip: !!c.flip };
    }
    const bend = fin(r.bend) && Math.abs(r.bend) <= 260 && Math.abs(r.bend) >= 0.5 ? r.bend : undefined;
    out.push({ group: r.group, text: r.text, font: r.font, height: r.height, align: r.align, spacing: r.spacing, lineSpacing: r.lineSpacing, weld: !!r.weld, ...(bend ? { bend } : {}), x: r.x, y: r.y, box: { minX: box.minX, minY: box.minY, maxX: box.maxX, maxY: box.maxY }, count: r.count, ...(curve ? { curve } : {}) });
  }
  return out;
}

/** A name for downloads and the title bar from a file name: no folder, no extension. */
export function projectName(fileName: string | null | undefined): string {
  if (!fileName) return 'Untitled';
  return fileName.replace(/^.*[\\/]/, '').replace(/\.(dxd|json)$/i, '') || 'Untitled';
}
