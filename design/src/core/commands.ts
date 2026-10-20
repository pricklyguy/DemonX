// Every edit is a command: a name plus plain JSON arguments. The toolbar, the keyboard, the command console and
// (later) scripts and AI/MCP tools all go through `execute`, so they can never disagree about what an action does.
import type { Doc, Layer, LayerMode, NewShape, PathShape, Pt, Shape, TextRecord } from './types';
import { emptyDoc, newLayer, workRect } from './types';
import { booleanOp, mergeRings, offsetShape, unionRings, type BooleanOp, type JoinType } from './clip';
import { importDxf } from './dxf';
import { buildLaserJob, formatTime } from './laser';
import { planTrim } from './trim';
import { MAX_RELIEFS, parseRelief, type Relief } from './relief';
import { parseTaper, parsePhoto, parseScan, PROFILE_SIDES, TOOLPATH_KINDS, TOOL_KINDS, defaultCnc, type CncData, type CncTool, type Toolpath, type ToolpathKind } from './cnc';
import { BUILT_IN_POSTS, PostError, parsePost } from './post';
import { CNC_CANVAS_NOTE, generateFiles } from './cncjob';
import { CORNER_STYLES, JOIN_MODES, NodeError, extendToMeet, filletLines, joinPaths, type JoinMode, breakAt, deleteNodes, filletPath, insertMidpoints, insertNode, moveNodes, setClosed, type CornerStyle, type NodeRef } from './nodes';
import { MAX_BEND, MAX_TEXT, arcCurve, caretSegment, fontNames, getFont, layoutText, placeOnCurve } from './text';
import { anchorOf, buildGuide, findMatches, nearestOnGuide, numberStrokes, pointOnGuide, templateAnchor } from './gadgets';
import { ALIGN_EDGES, alignOffsets, distributeOffsets, type AlignEdge } from './align';
import { fitShape } from './fit';
import { DEFAULTS as VALIDATE_DEFAULTS, validate } from './validate';
import { ProjectError, parseProject, serializeProject } from './project';
import { circleRing, anchorPoint, mirrorMatrix, rotateAbout, scaleAbout, pointInRing, shapeBounds, shapeClosed, transformShape, translateShape, unionBounds, shapeRings, convexHull, type Anchor, type Bounds, type Matrix } from './geom';

export class CommandError extends Error {}

export interface CommandResult {
  doc: Doc;
  /** Shapes the command made (the UI selects them). */
  ids?: number[];
  message: string;
  /** Extra output for commands that read rather than edit. */
  data?: unknown;
}

export interface CommandSpec {
  params: string;
  help: string;
  run(doc: Doc, args: any): CommandResult;
}

// ---- argument helpers ---------------------------------------------------------------------------------------

function numArg(args: any, key: string, opts: { positive?: boolean; optional?: boolean; fallback?: number } = {}): number {
  const v = args?.[key];
  if (v === undefined && opts.fallback !== undefined) return opts.fallback;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new CommandError(`"${key}" must be a number`);
  if (opts.positive && v <= 0) throw new CommandError(`"${key}" must be greater than 0`);
  return v;
}

function idsArg(doc: Doc, args: any): Shape[] {
  const ids = args?.ids;
  if (!Array.isArray(ids) || !ids.length) throw new CommandError('Select at least one shape first');
  return ids.map((id: number) => {
    const s = doc.shapes.find((x) => x.id === id);
    if (!s) throw new CommandError(`There is no shape ${id}`);
    return s;
  });
}

function layerArg(doc: Doc, args: any, fallback?: string): string {
  const name = args?.layer ?? fallback ?? doc.layers[0]?.name;
  if (!name || !doc.layers.some((l) => l.name === name)) throw new CommandError(`There is no layer "${name}"`);
  return name;
}

/**
 * Add shapes. With `carryTexts` (copies of shapes already in the design) a copy of a whole piece of text stays editable text:
 * it gets a record of its own, moved to where the copy is.
 */
function addShapes(doc: Doc, shapes: NewShape[], carryTexts = false): { doc: Doc; ids: number[] } {
  let next = doc.nextId;
  const ids: number[] = [];
  const added = shapes.map((s) => {
    ids.push(next);
    return { ...s, id: next++ } as Shape;
  });
  // copies of grouped shapes stay grouped together, but in a group of their own
  const fresh = new Map<number, number>();
  for (const sh of added) {
    if (sh.group === undefined) continue;
    if (!fresh.has(sh.group)) fresh.set(sh.group, next++);
    sh.group = fresh.get(sh.group);
  }
  let texts = doc.texts;
  if (carryTexts && doc.texts?.length) {
    const made: TextRecord[] = [];
    for (const [key, group] of fresh) {
      const rec = doc.texts.find((t) => t.group === key % 10_000_000);
      const mine = added.filter((x) => x.group === group);
      if (!rec || mine.length !== rec.count) continue;
      const b = unionBounds(mine.map((x) => shapeBounds(x)!));
      if (!b) continue;
      const dx = b.minX - rec.box.minX, dy = b.minY - rec.box.minY;
      made.push({ ...rec, group, x: rec.x + dx, y: rec.y + dy, box: { minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY }, ...(rec.curve ? { curve: { ...rec.curve, pts: rec.curve.pts.map((q): Pt => [q[0] + dx, q[1] + dy]) } } : {}) });
    }
    if (made.length) texts = [...doc.texts, ...made];
  }
  return { doc: { ...doc, shapes: [...doc.shapes, ...added], nextId: next, ...(texts ? { texts } : {}) }, ids };
}

const MAX_COPIES = 5000;

function intArg(args: any, key: string): number {
  const v = numArg(args, key);
  if (!Number.isInteger(v) || v < 1) throw new CommandError(`"${key}" must be a whole number, 1 or more`);
  return v;
}

function stripId(s: Shape): NewShape {
  const { id: _id, ...rest } = s as any;
  return rest as NewShape;
}

/** Check one shape that came from a clipboard or a script; only the known fields are kept. */
function cleanShape(raw: any): Shape {
  const layer = typeof raw?.layer === 'string' && raw.layer ? raw.layer : 'Layer 1';
  const fin = (n: any) => typeof n === 'number' && Number.isFinite(n);
  const group = Number.isInteger(raw?.group) && raw.group >= 1 && raw.group < 1e9 ? { group: raw.group as number } : {};
  if (raw?.kind === 'circle') {
    if (!fin(raw.cx) || !fin(raw.cy) || !fin(raw.r) || raw.r <= 0) throw new CommandError('A copied circle is not valid');
    return { ...group, id: 0, kind: 'circle', layer, cx: raw.cx, cy: raw.cy, r: raw.r };
  }
  if (raw?.kind === 'path' && Array.isArray(raw.rings) && raw.rings.length
    && raw.rings.every((r: any) => Array.isArray(r) && r.length >= 2 && r.every((p: any) => Array.isArray(p) && fin(p[0]) && fin(p[1])))) {
    return { ...group, id: 0, kind: 'path', layer, rings: raw.rings.map((r: any) => r.map((p: any) => [p[0], p[1]] as Pt)), closed: raw.closed !== false };
  }
  throw new CommandError('A copied shape is not valid');
}

/** The layer called `name`, added to the design when it is not there yet. */
function ensureLayer(doc: Doc, name: unknown, fallback: string, patch: Partial<Layer> = {}): { doc: Doc; name: string } {
  const n = typeof name === 'string' && name.trim() ? name.trim() : fallback;
  if (doc.layers.some((l) => l.name === n)) return { doc, name: n };
  return { doc: { ...doc, layers: [...doc.layers, { ...newLayer(n, doc.layers.length), ...patch }] }, name: n };
}

function shapesByIds(doc: Doc, ids: unknown, what: string): Shape[] {
  if (!Array.isArray(ids) || !ids.length) throw new CommandError(`${what}: nothing given`);
  return ids.map((id: number) => {
    const s = doc.shapes.find((x) => x.id === id);
    if (!s) throw new CommandError(`There is no shape ${id}`);
    return s;
  });
}

function styleArg(a: any): CornerStyle {
  const st = a?.style ?? 'round';
  if (!CORNER_STYLES.includes(st)) throw new CommandError('"style" must be one of ' + CORNER_STYLES.join(', '));
  return st;
}

/** Run a node operation, turning its own errors into command errors. */
function wrapNodes<T>(f: () => T): T {
  try { return f(); } catch (e) { if (e instanceof NodeError) throw new CommandError(e.message); throw e; }
}

function pathArg(doc: Doc, a: any): PathShape {
  const s = doc.shapes.find((x) => x.id === a?.id);
  if (!s) throw new CommandError('Pick a shape first');
  if (s.kind !== 'path') throw new CommandError('Only lines and outlines have nodes. Use to_path to turn a circle into one');
  return s;
}

function nodesArg(a: any): NodeRef[] {
  const n = a?.nodes;
  if (!Array.isArray(n) || !n.length || !n.every((x: any) => Number.isInteger(x?.ring) && Number.isInteger(x?.i))) throw new CommandError('"nodes" must be a list like [{"ring":0,"i":2}]');
  return n;
}

const swap = (doc: Doc, s: Shape): Doc => ({ ...doc, shapes: doc.shapes.map((x) => (x.id === s.id ? s : x)) });

/** Each copy of a grouped shape gets a group key of its own (addShapes turns the keys into real groups). */
function tagCopy<T extends Shape>(s: T, k: number): T {
  return s.group === undefined ? s : { ...s, group: s.group + k * 10_000_000 };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function ringsToShape(rings: Pt[][], layer: string): Omit<PathShape, 'id'> {
  return { kind: 'path', layer, rings, closed: true };
}


// ---- transforms ---------------------------------------------------------------------------------------------

const ANCHORS = ['tl', 'tc', 'tr', 'ml', 'c', 'mr', 'bl', 'bc', 'br'];


interface TextParams { text: string; font: string; height: number; align: 'left' | 'center' | 'right'; spacing: number; lineSpacing: number; weld: boolean; bend: number }

/** The text settings from the arguments, any that are missing taken from `base` (the text being edited). */
function textParams(a: any, base: TextRecord | undefined): TextParams {
  const text = a.text === undefined ? base?.text : a.text;
  if (typeof text !== 'string' || !text.trim()) throw new CommandError('Type some text first');
  if (text.length > MAX_TEXT) throw new CommandError(`That is more than ${MAX_TEXT} characters`);
  const height = a.height === undefined ? (base?.height ?? numArg(a, 'height', { positive: true })) : numArg(a, 'height', { positive: true });
  if (height > 5000) throw new CommandError('That text height is over 5 m');
  const font = a.font ?? base?.font ?? fontNames()[0];
  if (font === undefined || !getFont(font)) throw new CommandError(`The font "${font}" is not loaded` + (fontNames().length ? ` (loaded: ${fontNames().join(', ')})` : ''));
  const align = a.align ?? base?.align ?? 'left';
  if (!['left', 'center', 'right'].includes(align)) throw new CommandError('"align" must be left, center or right');
  const spacing = a.spacing === undefined ? (base?.spacing ?? 0) : numArg(a, 'spacing');
  const lineSpacing = a.line_spacing === undefined ? (base?.lineSpacing ?? 1) : numArg(a, 'line_spacing', { positive: true });
  let bend = a.bend === undefined ? (base?.bend ?? 0) : numArg(a, 'bend');
  if (Math.abs(bend) > MAX_BEND) throw new CommandError(`"bend" must be between -${MAX_BEND} and ${MAX_BEND} degrees`);
  if (Math.abs(bend) < 0.5) bend = 0;
  return { text, font, height, align, spacing, lineSpacing, weld: a.weld === undefined ? (base?.weld ?? false) : !!a.weld, bend };
}

/** The letters of a piece of text as one list of ring-sets per shape (merged, holes kept), straight or along a curve. */
function layOutText(p: TextParams, x: number, y: number, curve: TextRecord['curve'] | undefined): { shapes: Pt[][][]; width: number; note: string } {
  const font = getFont(p.font)!;
  const bent = !curve && p.bend !== 0;
  const lay = layoutText(font, p.text, curve || bent ? 0 : x, curve || bent ? 0 : y, { height: p.height, align: p.align, spacing: p.spacing, lineSpacing: p.lineSpacing });
  if (!lay.glyphs.length) throw new CommandError('Nothing to draw: ' + (lay.missing.length ? `this font has none of those characters (${lay.missing.join(' ')})` : 'only spaces'));
  let glyphs = lay.glyphs;
  let dropped = 0;
  if (curve) ({ glyphs, dropped } = placeOnCurve(lay, curve, p.align));
  else if (bent) {
    // bent into an arch or a smile: the middle of the line sits where a straight line's middle would
    const L = Math.max(lay.width, 1e-6);
    const apexX = x + (p.align === 'center' ? 0 : p.align === 'right' ? -L / 2 : L / 2);
    ({ glyphs, dropped } = placeOnCurve(lay, arcCurve(L, p.bend), p.align));
    glyphs = glyphs.map((rings) => rings.map((r) => r.map((q): Pt => [q[0] + apexX, q[1] + y])));
  }
  const groups = p.weld ? [glyphs.flat()] : glyphs;
  const shapes: Pt[][][] = [];
  for (const rings of groups) {
    const merged = mergeRings(rings);
    if (merged.length) shapes.push(merged);
  }
  if (!shapes.length) throw new CommandError('The text came out empty; try a bigger height');
  const note = (lay.missing.length ? `; this font has no ${lay.missing.map((c) => `"${c}"`).join(' ')}` : '') + (dropped ? `; ${plural(dropped, 'letter')} did not fit on the curve` : '');
  return { shapes, width: lay.width, note };
}

/** The doc with a record for this text, its box taken from the shapes it came out as. */
function withText(doc: Doc, group: number, p: TextParams, x: number, y: number, curve: TextRecord['curve'] | undefined, members: Shape[]): Doc {
  const b = unionBounds(members.map((m) => shapeBounds(m)!))!;
  const { bend, ...rest } = p;
  const rec: TextRecord = { group, ...rest, ...(bend ? { bend } : {}), x, y, box: { minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY }, count: members.length, ...(curve ? { curve } : {}) };
  return { ...doc, texts: [...(doc.texts ?? []).filter((t) => t.group !== group), rec] };
}

/** The letters of some text as it is being typed, for the live preview on the drawing, and where the text cursor is. Never throws. */
export function previewText(o: { text: string; font: string; height: number; align: 'left' | 'center' | 'right'; spacing: number; lineSpacing: number; weld: boolean; bend: number }, x: number, y: number, caret: number): { shapes: Pt[][][]; caret: [Pt, Pt] | null } {
  const font = getFont(o.font);
  // the cursor is shown even when the font is not here (some other loaded font gives its size), so the click is seen to have started something
  const cf = font ?? getFont(fontNames()[0] ?? '');
  if (!(o.height > 0) || !cf) return { shapes: [], caret: null };
  let shapes: Pt[][][] = [];
  try { if (font && o.text.trim()) shapes = layOutText({ ...o, text: o.text.slice(0, MAX_TEXT), bend: Math.abs(o.bend) < 0.5 ? 0 : Math.max(-MAX_BEND, Math.min(MAX_BEND, o.bend)) }, x, y, undefined).shapes; } catch { /* nothing to show yet */ }
  const c = caretSegment(cf, o.text, caret, { height: o.height, align: o.align, spacing: o.spacing, lineSpacing: o.lineSpacing, x, y, bend: Math.abs(o.bend) < 0.5 ? 0 : o.bend });
  return { shapes, caret: c };
}

/** The width of a piece of text laid out straight (what a bend is measured along), mm. */
export function textWidth(rec: { text: string; font: string; height: number; align: 'left' | 'center' | 'right'; spacing: number; lineSpacing: number }): number {
  const font = getFont(rec.font);
  if (!font) return 0;
  return layoutText(font, rec.text, 0, 0, { height: rec.height, align: rec.align, spacing: rec.spacing, lineSpacing: rec.lineSpacing }).width;
}

/** How much a piece of text has been scaled since it was laid out (1 when it was only moved, or turned and so laid level again on edit). */
function textScale(rec: TextRecord, members: Shape[]): { sc: number; b: Bounds; reset: boolean } {
  const b = unionBounds(members.map((m) => shapeBounds(m)!))!;
  const w0 = rec.box.maxX - rec.box.minX, h0 = rec.box.maxY - rec.box.minY;
  if (w0 > 1e-9 && h0 > 1e-9) {
    const sx = (b.maxX - b.minX) / w0, sy = (b.maxY - b.minY) / h0;
    if (Math.abs(sx - sy) <= 0.02 * sx) return { sc: sx, b, reset: false };
    return { sc: 1, b, reset: true };
  }
  return { sc: 1, b, reset: false };
}

/** For the Text dialog: the settings of the one piece of editable text among the shapes (as they are now, with any resizing counted), or null. */
export function textInfo(doc: Doc, ids: number[]): { rec: TextRecord; height: number; spacing: number; /** where the first baseline starts now */ x: number; y: number; /** the box the letters fill now */ box: Bounds; /** the picked shapes that are not part of the text */ others: number[]; members: number[] } | null {
  const picked = ids.map((id) => doc.shapes.find((s) => s.id === id)).filter((s): s is Shape => !!s);
  const recs = (doc.texts ?? []).filter((t) => picked.some((s) => s.group === t.group));
  if (recs.length !== 1) return null;
  const rec = recs[0];
  const members = doc.shapes.filter((s) => s.group === rec.group);
  if (members.length !== rec.count) return null;
  const { sc, b } = textScale(rec, members);
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  return { rec, height: r3(rec.height * sc), spacing: r3(rec.spacing * sc), x: b.minX - (rec.box.minX - rec.x) * sc, y: b.minY - (rec.box.minY - rec.y) * sc, box: b, others: picked.filter((s) => s.group !== rec.group).map((s) => s.id), members: members.map((m) => m.id) };
}

/** The one piece of editable text the selected shapes belong to, and all its letters. */
function textOf(doc: Doc, a: any): { rec: TextRecord; members: Shape[] } {
  const list = idsArg(doc, a);
  const recs = (doc.texts ?? []).filter((t) => list.some((s) => s.group === t.group));
  if (!recs.length) throw new CommandError('Pick a piece of text that was typed with the Text tool (text turned to lines cannot be edited)');
  if (recs.length > 1) throw new CommandError('Pick one piece of text at a time');
  const rec = recs[0];
  const members = doc.shapes.filter((s) => s.group === rec.group);
  if (members.length !== rec.count) throw new CommandError('The letters of this text have been changed by hand, so it cannot be edited as text any more; turn it to lines or undo');
  return { rec, members };
}

/** What aligning and spacing work on: each group counts as one object (all its shapes, even ones not picked), every other shape is its own. */
interface Unit { members: Shape[]; box: Bounds }
function unitsOf(doc: Doc, list: Shape[]): Unit[] {
  const out: Unit[] = [];
  const seen = new Set<number>();
  for (const s of list) {
    if (seen.has(s.id)) continue;
    const members = s.group === undefined ? [s] : doc.shapes.filter((x) => x.group === s.group);
    members.forEach((m) => seen.add(m.id));
    const box = unionBounds(members.map((m) => shapeBounds(m)).filter((b): b is Bounds => !!b));
    if (!box) continue;
    out.push({ members, box });
  }
  return out;
}
function moveUnits(doc: Doc, units: Unit[], offs: Array<[number, number]>, message: string): { doc: Doc; ids: number[]; message: string } {
  const by = new Map<number, [number, number]>();
  units.forEach((u, i) => u.members.forEach((m) => by.set(m.id, offs[i])));
  return { doc: { ...doc, shapes: doc.shapes.map((s) => { const o = by.get(s.id); return o && (o[0] || o[1]) ? translateShape(s, o[0], o[1]) : s; }) }, ids: [...by.keys()], message };
}

function selectionBounds(list: Shape[]): Bounds {
  const b = unionBounds(list.map((s) => shapeBounds(s)!));
  if (!b) throw new CommandError('Nothing to measure');
  return b;
}

function pivotArg(a: any, b: Bounds): [number, number] {
  if (a?.about === undefined) return [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];
  const p = a.about;
  if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) throw new CommandError('"about" must be an [x, y] point');
  return [p[0], p[1]];
}

function applyMatrix(doc: Doc, list: Shape[], m: Matrix, message: string): CommandResult {
  const set = new Set(list.map((s) => s.id));
  return { doc: { ...doc, shapes: doc.shapes.map((s) => (set.has(s.id) ? transformShape(s, m) : s)) }, ids: [...set], message };
}

const MIN_SIZE = 0.001;

// ---- the commands -------------------------------------------------------------------------------------------

/** Two shapes with the same signature are the same drawing in the same place on the same layer */
function shapeSignature(s: { kind: string; layer: string } & Record<string, any>): string {
  if (s.kind === 'circle') return `c|${s.layer}|${s.cx.toFixed(3)},${s.cy.toFixed(3)},${s.r.toFixed(3)}`;
  const rings: [number, number][][] = s.rings ?? [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, n = 0;
  for (const r of rings) for (const p of r) { n++; if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0]; if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1]; }
  return `p|${s.layer}|${s.closed ? 1 : 0}|${rings.length}|${n}|${minX.toFixed(3)},${minY.toFixed(3)},${maxX.toFixed(3)},${maxY.toFixed(3)}`;
}

export const COMMANDS: Record<string, CommandSpec> = {
  add_rect: {
    params: '{x, y, w, h, layer?, radius?, style?: "round"|"cove"|"chamfer"}  corner at x,y; w and h may be negative; radius rounds the corners (round = outside, cove = inside scoop)',
    help: 'Draw a rectangle',
    run(doc, a) {
      const x = numArg(a, 'x'), y = numArg(a, 'y'), w = numArg(a, 'w'), h = numArg(a, 'h');
      if (w === 0 || h === 0) throw new CommandError('A rectangle needs a width and a height');
      const ring: Pt[] = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
      let shape: Omit<PathShape, 'id'> = { kind: 'path', layer: layerArg(doc, a), rings: [ring], closed: true };
      let note = '';
      if (a.radius !== undefined && numArg(a, 'radius') !== 0) {
        const style = styleArg(a);
        const f = wrapNodes(() => filletPath({ ...shape, id: 0 }, numArg(a, 'radius', { positive: true }), style));
        shape = { ...shape, rings: f.shape.rings };
        note = ` with ${style === 'cove' ? 'inside' : style === 'chamfer' ? 'chamfered' : 'rounded'} corners${f.capped ? ' (radius limited to half the shorter side)' : ''}`;
      }
      const r = addShapes(doc, [shape]);
      return { ...r, message: `Rectangle ${Math.abs(w)} × ${Math.abs(h)} mm${note}` };
    },
  },
  add_circle: {
    params: '{cx, cy, r, layer?}',
    help: 'Draw a circle',
    run(doc, a) {
      const r = addShapes(doc, [{ kind: 'circle', layer: layerArg(doc, a), cx: numArg(a, 'cx'), cy: numArg(a, 'cy'), r: numArg(a, 'r', { positive: true }) }]);
      return { ...r, message: `Circle, radius ${a.r} mm` };
    },
  },
  add_path: {
    params: '{points: [[x,y],...], closed?: true, layer?}',
    help: 'Draw a polygon or a polyline',
    run(doc, a) {
      const pts = a?.points;
      if (!Array.isArray(pts) || pts.length < 2 || !pts.every((p: any) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))) {
        throw new CommandError('"points" must be a list of at least two [x, y] pairs');
      }
      const closed = a.closed !== false;
      if (closed && pts.length < 3) throw new CommandError('A closed shape needs at least three points');
      const r = addShapes(doc, [{ kind: 'path', layer: layerArg(doc, a), rings: [pts.map((p: Pt) => [p[0], p[1]] as Pt)], closed }]);
      return { ...r, message: closed ? `Polygon, ${pts.length} points` : `Line, ${pts.length} points` };
    },
  },
  move: {
    params: '{ids, dx, dy}',
    help: 'Move shapes',
    run(doc, a) {
      const list = idsArg(doc, a);
      const dx = numArg(a, 'dx'), dy = numArg(a, 'dy');
      const set = new Set(list.map((s) => s.id));
      return { doc: { ...doc, shapes: doc.shapes.map((s) => (set.has(s.id) ? translateShape(s, dx, dy) : s)) }, ids: [...set], message: `Moved ${plural(set.size, 'shape')} by ${dx}, ${dy} mm` };
    },
  },

  scale: {
    params: '{ids, sx, sy?, about?: [x,y]}  factors; sy defaults to sx; about defaults to the middle of the selection',
    help: 'Resize shapes by a factor',
    run(doc, a) {
      const list = idsArg(doc, a);
      const sx = numArg(a, 'sx');
      const sy = a.sy === undefined ? sx : numArg(a, 'sy');
      if (Math.abs(sx) < 1e-6 || Math.abs(sy) < 1e-6) throw new CommandError('The scale factor cannot be 0');
      const m = scaleAbout(sx, sy, pivotArg(a, selectionBounds(list)));
      return applyMatrix(doc, list, m, `Scaled ${plural(list.length, 'shape')} × ${Math.round(sx * 1e4) / 1e4}` + (sy !== sx ? `, × ${Math.round(sy * 1e4) / 1e4}` : ''));
    },
  },
  rotate: {
    params: '{ids, angle, about?: [x,y]}  degrees, counter-clockwise; about defaults to the middle of the selection',
    help: 'Rotate shapes',
    run(doc, a) {
      const list = idsArg(doc, a);
      const angle = numArg(a, 'angle');
      return applyMatrix(doc, list, rotateAbout(angle, pivotArg(a, selectionBounds(list))), `Rotated ${plural(list.length, 'shape')} by ${angle}°`);
    },
  },
  mirror: {
    params: '{ids, axis: "horizontal"|"vertical", about?: [x,y]}  horizontal flips left to right',
    help: 'Flip shapes',
    run(doc, a) {
      const list = idsArg(doc, a);
      if (a.axis !== 'horizontal' && a.axis !== 'vertical') throw new CommandError('"axis" must be horizontal or vertical');
      const m = mirrorMatrix(a.axis, pivotArg(a, selectionBounds(list)));
      return applyMatrix(doc, list, m, `Flipped ${plural(list.length, 'shape')} ${a.axis === 'horizontal' ? 'left to right' : 'top to bottom'}`);
    },
  },
  set_bounds: {
    params: '{ids, x?, y?, width?, height?, lock?: false, anchor?: "c"|"tl"|"tc"|"tr"|"ml"|"mr"|"bl"|"bc"|"br"}  the box around the selection; x,y place the anchor point, size is kept about it',
    help: 'Set the position or size of the selection (like the X, Y, Width, Height boxes)',
    run(doc, a) {
      const list = idsArg(doc, a);
      const anchor = (a.anchor ?? 'c') as Anchor;
      if (!ANCHORS.includes(anchor)) throw new CommandError('"anchor" must be one of ' + ANCHORS.join(', '));
      const b = selectionBounds(list);
      const bw = b.maxX - b.minX;
      const bh = b.maxY - b.minY;
      let sx = 1, sy = 1;
      if (a.width !== undefined) {
        const w = numArg(a, 'width', { positive: true });
        if (w < MIN_SIZE) throw new CommandError('The width must be at least 0.001 mm');
        if (bw < 1e-9) throw new CommandError('This selection has no width to change (it is a vertical line)');
        sx = w / bw;
      }
      if (a.height !== undefined) {
        const h = numArg(a, 'height', { positive: true });
        if (h < MIN_SIZE) throw new CommandError('The height must be at least 0.001 mm');
        if (bh < 1e-9) throw new CommandError('This selection has no height to change (it is a horizontal line)');
        sy = h / bh;
      }
      if (a.lock) {
        if (a.width !== undefined) sy = sx;
        else if (a.height !== undefined) sx = sy;
      }
      const at = anchorPoint(b, anchor);
      let m = scaleAbout(sx, sy, at);
      if (a.x !== undefined || a.y !== undefined) {
        const tx = a.x === undefined ? 0 : numArg(a, 'x') - at[0];
        const ty = a.y === undefined ? 0 : numArg(a, 'y') - at[1];
        m = [m[0], m[1], m[2], m[3], m[4] + tx, m[5] + ty];
      }
      return applyMatrix(doc, list, m, 'Selection updated');
    },
  },
  align: {
    params: '{ids, edge: "left"|"hcenter"|"right"|"top"|"vcenter"|"bottom"|"center", to?: "selection"|"work"|"first"}',
    help: 'Line shapes up on one edge or centre ("center" is both centres). "to":"work" uses the work area, "first" the first shape picked (it stays); the default is the box around the selection. A group counts as one object',
    run(doc, a) {
      const units = unitsOf(doc, idsArg(doc, a));
      if (!ALIGN_EDGES.includes(a.edge)) throw new CommandError('"edge" must be one of ' + ALIGN_EDGES.join(', '));
      const to = a.to ?? (units.length > 1 ? 'selection' : 'work');
      let frame: Bounds | null;
      if (to === 'work') {
        const w = workRect(doc.workspace);
        frame = w ? { minX: w.minX, minY: w.minY, maxX: w.maxX, maxY: w.maxY } : null;
        if (!frame) throw new CommandError('This design has no work area to align to');
      } else if (to === 'selection' || to === 'first') {
        if (units.length < 2) throw new CommandError('Select at least two objects to align them to each other');
        frame = to === 'first' ? units[0].box : unionBounds(units.map((u) => u.box))!;
      } else throw new CommandError('"to" must be "selection", "work" or "first"');
      const offs = alignOffsets(units.map((u) => u.box), a.edge as AlignEdge, frame);
      return moveUnits(doc, units, offs, `Aligned ${plural(units.length, 'object')} (${a.edge})`);
    },
  },
  distribute: {
    params: '{ids, axis: "x"|"y", mode?: "gaps"|"centers", gap?: mm}',
    help: 'Space objects evenly; the outermost two stay put. "gaps" equalises the space between them, "centers" their centres. With "gap" the space between neighbours is that many mm (the first stays). A group counts as one object',
    run(doc, a) {
      const units = unitsOf(doc, idsArg(doc, a));
      if (a.axis !== 'x' && a.axis !== 'y') throw new CommandError('"axis" must be "x" or "y"');
      const mode = a.mode ?? 'gaps';
      if (mode !== 'gaps' && mode !== 'centers') throw new CommandError('"mode" must be "gaps" or "centers"');
      const gap = a.gap === undefined ? undefined : numArg(a, 'gap');
      if (gap === undefined && units.length < 3) throw new CommandError('Select at least three objects to space them evenly');
      if (gap !== undefined && units.length < 2) throw new CommandError('Select at least two objects to set the space between them');
      const offs = distributeOffsets(units.map((u) => u.box), a.axis, mode, gap);
      return moveUnits(doc, units, offs, gap === undefined ? `Spaced ${plural(units.length, 'object')} evenly along ${a.axis.toUpperCase()}` : `Spaced ${plural(units.length, 'object')} ${gap} mm apart along ${a.axis.toUpperCase()}`);
    },
  },
  duplicate: {
    params: '{ids, dx?, dy?}  copies are offset by dx, dy (default 5, -5 mm) and become the selection',
    help: 'Make a copy of the shapes next to the originals',
    run(doc, a) {
      const list = idsArg(doc, a);
      const dx = a.dx === undefined ? 5 : numArg(a, 'dx'), dy = a.dy === undefined ? -5 : numArg(a, 'dy');
      const r = addShapes(doc, list.map((s) => stripId(translateShape(s, dx, dy))), true);
      return { ...r, message: `Duplicated ${plural(list.length, 'shape')}` };
    },
  },
  paste: {
    params: '{shapes: [shape,...], dx?, dy?}  shapes as copied from this or another design; layers that do not exist here are added',
    help: 'Put copied shapes into the design (the Ctrl+V of the app uses this)',
    run(doc, a) {
      const src = a?.shapes;
      if (!Array.isArray(src) || !src.length) throw new CommandError('There is nothing to paste');
      if (src.length > MAX_COPIES) throw new CommandError('That is too many shapes to paste at once');
      const dx = a.dx === undefined ? 0 : numArg(a, 'dx'), dy = a.dy === undefined ? 0 : numArg(a, 'dy');
      let layers = doc.layers;
      const items: NewShape[] = src.map((raw: any) => {
        const s = cleanShape(raw);
        if (!layers.some((l) => l.name === s.layer)) layers = [...layers, newLayer(s.layer, layers.length)];
        return stripId(translateShape(s as Shape, dx, dy));
      });
      const r = addShapes({ ...doc, layers }, items);
      return { ...r, message: `Pasted ${plural(items.length, 'shape')}` };
    },
  },
  array: {
    params: '{ids, kind: "grid", cols, rows, dx, dy}  or  {ids, kind: "circular", count, angle?: 360, cx?, cy?, rotate?: true}',
    help: 'Repeat shapes. Grid: cols x rows copies spaced dx, dy apart (start to start). Circular: count shapes around a centre',
    run(doc, a) {
      const list = idsArg(doc, a);
      const copies: Shape[] = [];
      if (a.kind === 'grid') {
        const cols = intArg(a, 'cols'), rows = intArg(a, 'rows');
        if (cols * rows > MAX_COPIES) throw new CommandError(`That makes ${cols * rows} shapes per original; the limit is ${MAX_COPIES}`);
        if (cols * rows * list.length > MAX_COPIES) throw new CommandError(`That makes too many shapes (limit ${MAX_COPIES})`);
        const dx = numArg(a, 'dx'), dy = numArg(a, 'dy');
        if (cols * rows < 2) throw new CommandError('A grid needs at least two places');
        if ((cols > 1 && Math.abs(dx) < 1e-9) && (rows <= 1 || Math.abs(dy) < 1e-9)) throw new CommandError('The spacing is 0, so the copies would sit on top of each other');
        for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
          if (!r && !c) continue;
          for (const s of list) copies.push(tagCopy(translateShape(s, c * dx, r * dy), r * cols + c));
        }
      } else if (a.kind === 'circular') {
        const count = intArg(a, 'count');
        if (count < 2) throw new CommandError('"count" must be at least 2 (it includes the original)');
        if (count * list.length > MAX_COPIES) throw new CommandError(`That makes too many shapes (limit ${MAX_COPIES})`);
        const angle = a.angle === undefined ? 360 : numArg(a, 'angle');
        if (Math.abs(angle) < 1e-9) throw new CommandError('"angle" cannot be 0');
        const b = selectionBounds(list);
        const pivot: Pt = [a.cx === undefined ? (b.minX + b.maxX) / 2 : numArg(a, 'cx'), a.cy === undefined ? (b.minY + b.maxY) / 2 : numArg(a, 'cy')];
        const turn = a.rotate !== false;
        // a full circle spreads count shapes around; a part circle puts the last copy at the far end
        const step = Math.abs(Math.abs(angle) - 360) < 1e-9 ? angle / count : angle / (count - 1);
        for (let k = 1; k < count; k++) {
          const m = rotateAbout(step * k, pivot);
          for (const s of list) {
            if (turn) copies.push(tagCopy(transformShape(s, m), k));
            else {
              const sb = shapeBounds(s)!;
              const c: Pt = [(sb.minX + sb.maxX) / 2, (sb.minY + sb.maxY) / 2];
              const q = rotateAbout(step * k, pivot);
              const nx = q[0] * c[0] + q[2] * c[1] + q[4], ny = q[1] * c[0] + q[3] * c[1] + q[5];
              copies.push(tagCopy(translateShape(s, nx - c[0], ny - c[1]), k));
            }
          }
        }
      } else throw new CommandError('"kind" must be "grid" or "circular"');
      const r = addShapes(doc, copies.map(stripId), true);
      return { doc: r.doc, ids: [...list.map((s) => s.id), ...r.ids], message: `Array: ${plural(copies.length, 'copy')} added` };
    },
  },
  rotate_each: {
    params: '{ids, angle}  degrees, counter-clockwise',
    help: 'Turn every selected shape about its own centre (not about the whole selection)',
    run(doc, a) {
      const list = idsArg(doc, a);
      const angle = numArg(a, 'angle');
      const by = new Map(list.map((s) => [s.id, transformShape(s, rotateAbout(angle, anchorOf(s)))] as const));
      return { doc: { ...doc, shapes: doc.shapes.map((s) => by.get(s.id) ?? s) }, ids: list.map((s) => s.id), message: `Turned ${plural(list.length, 'shape')} by ${angle}° each about its own centre` };
    },
  },
  marker_copy: {
    params: '{ids, x, y, layer?: "Sharpie Path"}  where the pen/marker sits relative to the spindle, in mm',
    help: 'Copy shapes onto a Sharpie Path layer, shifted the opposite way so a pen beside the tool draws them in the right place',
    run(doc, a) {
      const list = idsArg(doc, a);
      const x = numArg(a, 'x'), y = numArg(a, 'y');
      if (x === 0 && y === 0) throw new CommandError('The marker offset is 0, 0, so there is nothing to shift');
      const L = ensureLayer(doc, a.layer, 'Sharpie Path', { color: '#c050ff' });
      const r = addShapes(L.doc, list.map((s) => ({ ...stripId(translateShape(s, -x, -y)), layer: L.name }) as NewShape));
      return { ...r, message: `Copied ${plural(list.length, 'shape')} to "${L.name}", shifted ${-x}, ${-y} mm` };
    },
  },
  replace_with: {
    params: '{targets: [ids], template: [ids], keep_template?: false, backup?: false}',
    help: 'Put a copy of the template shapes on every target, centred on it (the template is held by its first circle, else its middle). The copies take each target\'s layer',
    run(doc, a) {
      const targets = shapesByIds(doc, a?.targets, 'Targets');
      const tpl = shapesByIds(doc, a?.template, 'Template');
      const tplIds = new Set(tpl.map((s) => s.id));
      if (targets.some((t) => tplIds.has(t.id))) throw new CommandError('The template cannot also be one of the targets');
      const hold = templateAnchor(tpl);
      let work = doc;
      let backupName = '';
      if (a.backup) {
        const B = ensureLayer(work, 'Replaced (backup)', 'Replaced (backup)', { visible: false, output: false });
        work = B.doc; backupName = B.name;
      }
      const made: NewShape[] = [];
      for (const [ti, t] of targets.entries()) {
        const at = anchorOf(t);
        for (const sh of tpl) made.push({ ...stripId(tagCopy(translateShape(sh, at[0] - hold[0], at[1] - hold[1]), ti)), layer: t.layer } as NewShape);
      }
      const gone = new Set(targets.map((t) => t.id));
      if (!a.keep_template) tpl.forEach((t) => gone.add(t.id));
      const shapes = work.shapes.flatMap((sh) => (gone.has(sh.id) ? (a.backup && targets.some((t) => t.id === sh.id) ? [{ ...sh, layer: backupName }] : []) : [sh]));
      const r = addShapes({ ...work, shapes }, made);
      return { ...r, message: `Replaced ${plural(targets.length, 'target')} with ${plural(tpl.length, 'template shape')} each` };
    },
  },
  nudge_to_guide: {
    params: '{ids, guide, distribute?: false}  moves each shape\'s centre to the nearest point of the guide line/outline',
    help: 'Snap shapes onto a guide curve; with distribute they are then spaced evenly between the first and last along it',
    run(doc, a) {
      const list = idsArg(doc, a).filter((s) => s.id !== a.guide);
      const guideShape = doc.shapes.find((s) => s.id === a.guide);
      if (!guideShape) throw new CommandError('Say which shape is the guide');
      if (!list.length) throw new CommandError('Select at least one shape to move besides the guide');
      const g = buildGuide(guideShape);
      if (!g) throw new CommandError('The guide needs to be a line, arc or outline with some length');
      const items = list.map((s) => ({ s, at: anchorOf(s), d: 0 }));
      items.forEach((it) => { it.d = nearestOnGuide(g, it.at); });
      if (a.distribute && items.length >= 2) {
        items.sort((p, q) => p.d - q.d);
        const lo = items[0].d, hi = items[items.length - 1].d;
        items.forEach((it, i) => { it.d = lo + ((hi - lo) * i) / (items.length - 1); });
      }
      const by = new Map(items.map((it) => { const to = pointOnGuide(g, it.d); return [it.s.id, translateShape(it.s, to[0] - it.at[0], to[1] - it.at[1])] as const; }));
      return { doc: { ...doc, shapes: doc.shapes.map((s) => by.get(s.id) ?? s) }, ids: list.map((s) => s.id), message: `Moved ${plural(list.length, 'shape')} onto the guide${a.distribute ? ' and spaced them evenly' : ''}` };
    },
  },
  count_matching: {
    params: '{ids, reference?}  reference defaults to the last id; matches are the same size however placed, turned or started',
    help: 'Count the selected shapes that are the same as the reference one, and select them. Reports copies lying exactly on top of each other',
    run(doc, a) {
      const list = idsArg(doc, a);
      const refId = a.reference ?? list[list.length - 1].id;
      const ref = doc.shapes.find((s) => s.id === refId);
      if (!ref) throw new CommandError('There is no reference shape');
      const m = findMatches(ref, list);
      const dup = m.overlapping.length;
      return { doc, ids: m.matches, data: { reference: refId, count: m.matches.length, ids: m.matches, overlapping: m.overlapping }, message: `${plural(m.matches.length, 'shape')} match the reference${dup ? `, ${dup} of them lying exactly on top of another` : ''}` };
    },
  },
  auto_number: {
    params: '{ids (in order), start?: 1, height?: 6, layer?: "Pixel Numbers", wiring?: true, wiring_layer?: "Pixel Wiring", nodes?: true, node_radius?: 1.5, node_layer?: "Pixel Nodes", join_from?: [x,y]}',
    help: 'Stamp 1, 2, 3 … at each shape in the order given, with an optional wiring path through them and a marker circle at each. Returns the next number and the last point so a later run can carry on',
    run(doc, a) {
      const list = idsArg(doc, a);
      if (list.length > 2000) throw new CommandError('That is more than 2000 shapes; number them in smaller batches');
      const start = a.start === undefined ? 1 : numArg(a, 'start');
      if (!Number.isInteger(start) || start < 0) throw new CommandError('"start" must be a whole number, 0 or more');
      const height = a.height === undefined ? 6 : numArg(a, 'height', { positive: true });
      const wiring = a.wiring !== false, nodes = a.nodes !== false;
      const nodeR = a.node_radius === undefined ? 1.5 : numArg(a, 'node_radius', { positive: true });
      let work = doc;
      const N = ensureLayer(work, a.layer, 'Pixel Numbers', { color: '#ffd23f' }); work = N.doc;
      const W = ensureLayer(work, a.wiring_layer, 'Pixel Wiring', { color: '#3fa7ff' }); if (wiring) work = W.doc;
      const C = ensureLayer(work, a.node_layer, 'Pixel Nodes', { color: '#ff5d5d' }); if (nodes) work = C.doc;
      const anchors = list.map(anchorOf);
      const out: NewShape[] = [];
      anchors.forEach((p, i) => {
        out.push({ kind: 'path', layer: N.name, rings: numberStrokes(start + i, p[0], p[1], height), closed: false } as NewShape);
      });
      if (wiring) {
        const line: Pt[] = [];
        if (a.join_from !== undefined) {
          const j = a.join_from;
          if (!Array.isArray(j) || j.length !== 2 || !j.every((v: any) => typeof v === 'number' && Number.isFinite(v))) throw new CommandError('"join_from" must be [x, y]');
          line.push([j[0], j[1]]);
        }
        anchors.forEach((p) => line.push([p[0], p[1]]));
        if (line.length >= 2) out.push({ kind: 'path', layer: W.name, rings: [line], closed: false } as NewShape);
      }
      if (nodes) anchors.forEach((p) => out.push({ kind: 'circle', layer: C.name, cx: p[0], cy: p[1], r: nodeR } as NewShape));
      const r = addShapes(work, out);
      const last = anchors[anchors.length - 1];
      return { ...r, data: { next: start + list.length, last }, message: `Numbered ${plural(list.length, 'shape')} ${start} to ${start + list.length - 1}` };
    },
  },
  add_text: {
    params: '{text, x, y, height, font?, align?: "left"|"center"|"right", spacing?: 0, line_spacing?: 1, weld?: false, layer?}  x, y is the start of the first baseline; height is the capital-letter height in mm',
    help: 'Put text into the drawing as vector outlines (one shape per letter, holes kept), grouped, and still editable with edit_text until it is turned to lines. The font must be loaded; use the Text tool or load_font. New lines start a new row',
    run(doc, a) {
      const p = textParams(a, undefined);
      const x = numArg(a, 'x'), y = numArg(a, 'y');
      const layer = layerArg(doc, a);
      const t = layOutText(p, x, y, undefined);
      const r = addShapes(doc, t.shapes.map((rings) => ({ kind: 'path', layer, rings, closed: true, group: 1 } as NewShape)));
      const group = (r.doc.shapes.find((s) => s.id === r.ids[0]) as Shape).group!;
      return { ...r, doc: withText(r.doc, group, p, x, y, undefined, r.doc.shapes.filter((s) => s.group === group)), message: `Text "${p.text.length > 24 ? p.text.slice(0, 24) + '…' : p.text.replace(/\n/g, ' ')}" as ${plural(t.shapes.length, 'shape')}, ${t.width.toFixed(1)} mm wide${t.note}` };
    },
  },
  edit_text: {
    params: '{ids, text?, font?, height?, align?, spacing?, line_spacing?, weld?, curve?: shapeId|null, offset?: mm, flip?: false}  one piece of text made by add_text; curve puts the text along that line or outline (a copy is taken), null takes it off again',
    help: 'Change a piece of text: the words, font, size, spacing, or run it along a curve. It keeps its place, and follows if it was moved or resized (a rotated one is laid level again)',
    run(doc, a) {
      const { rec, members } = textOf(doc, a);
      const p = textParams(a, rec);
      const { sc, b, reset } = textScale(rec, members);
      const note = reset ? '; it had been turned or stretched, so it is laid level again' : '';
      const tx = (q: Pt): Pt => [b.minX + (q[0] - rec.box.minX) * sc, b.minY + (q[1] - rec.box.minY) * sc];
      const x = b.minX - (rec.box.minX - rec.x) * sc, y = b.minY - (rec.box.minY - rec.y) * sc;
      if (a.height === undefined) p.height = rec.height * sc;
      p.spacing = a.spacing === undefined ? rec.spacing * sc : p.spacing;
      // the curve: kept (moved and scaled with the text), replaced, or taken off
      let curve: TextRecord['curve'] | undefined = rec.curve ? { ...rec.curve, pts: rec.curve.pts.map(tx), offset: rec.curve.offset * sc } : undefined;
      if (a.curve === null) curve = undefined;
      else if (a.curve !== undefined) {
        const src = doc.shapes.find((s) => s.id === a.curve);
        if (!src) throw new CommandError(`There is no shape ${a.curve} to run the text along`);
        if (src.group === rec.group) throw new CommandError('The text cannot run along itself');
        const ring = shapeRings(src)[0];
        if (!ring || ring.length < 2) throw new CommandError('That shape has no line to run the text along');
        curve = { pts: ring.map((q): Pt => [q[0], q[1]]), closed: shapeClosed(src), offset: 0, flip: false };
      }
      // bending and running along a picked curve are two ways of doing the same thing: the last one asked for wins
      if (a.bend !== undefined && a.curve === undefined && p.bend !== 0) curve = undefined;
      if (curve) p.bend = 0;
      if (curve) {
        if (a.offset !== undefined) curve = { ...curve, offset: numArg(a, 'offset') };
        if (a.flip !== undefined) curve = { ...curve, flip: !!a.flip };
        if (curve.pts.length > 20000) throw new CommandError('That curve has too many points');
      }
      const t = layOutText(p, x, y, curve);
      if (curve && !t.shapes.length) throw new CommandError('No letter fits on that curve (it is shorter than the text, or the start is off its end)');
      const layer = a.layer === undefined ? members[0].layer : layerArg(doc, a);
      const gone = new Set(members.map((m) => m.id));
      let next = doc.nextId;
      const made = t.shapes.map((rings) => ({ id: next++, kind: 'path', layer, rings, closed: true, group: rec.group }) as Shape);
      const base = { ...doc, shapes: [...doc.shapes.filter((s) => !gone.has(s.id)), ...made], nextId: next, texts: (doc.texts ?? []).filter((t2) => t2.group !== rec.group) };
      return { doc: withText(base, rec.group, p, x, y, curve, made), ids: made.map((m) => m.id), message: `Text "${p.text.length > 24 ? p.text.slice(0, 24) + '…' : p.text.replace(/\n/g, ' ')}" changed` + (curve ? ', along a curve' : '') + t.note + note };
    },
  },
  text_to_lines: {
    params: '{ids}',
    help: 'Turn text into plain outlines: the letters stay as they are (ungrouped) but the words, font and size can no longer be edited',
    run(doc, a) {
      const list = idsArg(doc, a);
      const groups = new Set((doc.texts ?? []).filter((t) => list.some((s) => s.group === t.group)).map((t) => t.group));
      if (!groups.size) throw new CommandError('None of the selected shapes is editable text');
      return {
        doc: {
          ...doc,
          texts: (doc.texts ?? []).filter((t) => !groups.has(t.group)),
          shapes: doc.shapes.map((s) => { if (s.group === undefined || !groups.has(s.group)) return s; const { group: _g, ...rest } = s as any; return rest as Shape; }),
        },
        ids: doc.shapes.filter((s) => s.group !== undefined && groups.has(s.group)).map((s) => s.id),
        message: `${plural(groups.size, 'piece')} of text turned into lines`,
      };
    },
  },
  group: {
    params: '{ids}',
    help: 'Tie shapes together so they are picked, moved and copied as one',
    run(doc, a) {
      const list = idsArg(doc, a);
      if (list.length < 2) throw new CommandError('Select at least two shapes to group');
      const g = doc.nextId;
      const set = new Set(list.map((s) => s.id));
      return { doc: { ...doc, nextId: g + 1, shapes: doc.shapes.map((s) => (set.has(s.id) ? { ...s, group: g } : s)) }, ids: list.map((s) => s.id), message: `Grouped ${plural(list.length, 'shape')}` };
    },
  },
  ungroup: {
    params: '{ids}',
    help: 'Split the groups that the shapes belong to',
    run(doc, a) {
      const list = idsArg(doc, a);
      const groups = new Set(list.map((s) => s.group).filter((g): g is number => g !== undefined));
      if (!groups.size) throw new CommandError('None of the selected shapes is grouped');
      const freed: number[] = [];
      const shapes = doc.shapes.map((s) => {
        if (s.group === undefined || !groups.has(s.group)) return s;
        freed.push(s.id);
        const { group: _g, ...rest } = s as any;
        return rest as Shape;
      });
      return { doc: { ...doc, shapes }, ids: freed, message: `Ungrouped ${plural(groups.size, 'group')}` };
    },
  },
  join: {
    params: '{ids, mode?: "line"|"curve"|"move"}  open lines to join into one; a single line has its own ends joined (closed)',
    help: 'Join open lines: with a straight line, with a smooth curve, or by moving the two end points together',
    run(doc, a) {
      const list = idsArg(doc, a);
      const mode = (a.mode ?? 'line') as JoinMode;
      if (!JOIN_MODES.includes(mode)) throw new CommandError('"mode" must be one of ' + JOIN_MODES.join(', '));
      const paths = list.filter((s): s is PathShape => s.kind === 'path');
      if (paths.length !== list.length) throw new CommandError('Circles cannot be joined; only open lines');
      const merged = wrapNodes(() => joinPaths(paths, mode));
      const gone = new Set(paths.map((s) => s.id));
      const shapes = doc.shapes.flatMap((s) => (s.id === paths[0].id ? [merged] : gone.has(s.id) ? [] : [s]));
      return { doc: { ...doc, shapes }, ids: [merged.id], message: paths.length === 1 ? 'Closed the line' : `Joined ${plural(paths.length, 'line')} into one` };
    },
  },
  extend: {
    params: '{ids: [a, b]}  two open lines',
    help: 'Extend two open lines along their last segments until they meet (the ends that need the least extending are used)',
    run(doc, a) {
      const list = idsArg(doc, a);
      const paths = list.filter((s): s is PathShape => s.kind === 'path');
      if (list.length !== 2 || paths.length !== 2) throw new CommandError('Pick exactly two open lines to extend to where they meet');
      const r = wrapNodes(() => extendToMeet(paths[0], paths[1]));
      const by = new Map<number, PathShape>([[paths[0].id, r.a], [paths[1].id, r.b]]);
      return { doc: { ...doc, shapes: doc.shapes.map((s) => by.get(s.id) ?? s) }, ids: list.map((s) => s.id), message: `Extended the lines to meet at ${Math.round(r.point[0] * 1000) / 1000}, ${Math.round(r.point[1] * 1000) / 1000}` };
    },
  },
  cnc_tool_set: {
    params: '{tool: {id, name, kind: "flat"|"ball"|"vbit"|"drill", diameter, flutes, rpm, feed, plunge, stepdown, stepover, vAngle?, taperAngle? and maxDiameter? (a tapered ball nose: diameter is the ball at the tip)}}',
    help: 'Add a tool to the CNC library, or replace the one with the same id',
    run(doc, a) {
      const t = a?.tool;
      if (!t || typeof t.id !== 'string' || !t.id || t.id.length > 60 || typeof t.name !== 'string' || !t.name.trim()) throw new CommandError('A tool needs an id and a name');
      if (!TOOL_KINDS.includes(t.kind)) throw new CommandError('"kind" must be one of ' + TOOL_KINDS.join(', '));
      const pos = (k: string, max: number) => { const v = t[k]; if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > max) throw new CommandError(`"${k}" must be a number above 0 (at most ${max})`); return v; };
      const tool: CncTool = {
        id: t.id, name: t.name.trim().slice(0, 80), kind: t.kind, diameter: pos('diameter', 500), flutes: Math.round(pos('flutes', 12)),
        rpm: pos('rpm', 100000), feed: pos('feed', 20000), plunge: pos('plunge', 20000), stepdown: pos('stepdown', 500),
        stepover: t.kind === 'drill' ? 0 : pos('stepover', 100),
        ...(t.kind === 'vbit' ? { vAngle: pos('vAngle', 179) } : {}),
      };
      if (t.taperAngle !== undefined || t.maxDiameter !== undefined) {
        if (t.kind !== 'ball') throw new CommandError('Only a ball nose can be tapered');
        try { Object.assign(tool, parseTaper({ diameter: tool.diameter, taperAngle: t.taperAngle, maxDiameter: t.maxDiameter })); } catch (e) { throw new CommandError((e as Error).message); }
      }
      const cnc = doc.cnc ?? defaultCnc();
      const has = cnc.tools.some((x) => x.id === tool.id);
      const tools = has ? cnc.tools.map((x) => (x.id === tool.id ? tool : x)) : [...cnc.tools, tool];
      if (tools.length > 200) throw new CommandError('That is too many tools');
      return { doc: { ...doc, cnc: { ...cnc, tools } }, message: `${has ? 'Updated' : 'Added'} tool ${tool.name}` };
    },
  },
  cnc_tool_delete: {
    params: '{id}',
    help: 'Remove a tool (not while a toolpath uses it)',
    run(doc, a) {
      const cnc = doc.cnc ?? defaultCnc();
      if (!cnc.tools.some((t) => t.id === a?.id)) throw new CommandError('There is no such tool');
      if (cnc.toolpaths.some((tp) => tp.toolId === a.id)) throw new CommandError('A toolpath uses this tool. Delete or change that toolpath first');
      return { doc: { ...doc, cnc: { ...cnc, tools: cnc.tools.filter((t) => t.id !== a.id) } }, message: 'Tool removed' };
    },
  },
  cnc_toolpath_add: {
    params: '{kind: "profile"|"pocket"|"drill"|"engrave"|"vcarve"|"plug"|"photo"|"finish3d"|"rough3d", reliefId and scan {dir: "x"|"y", stepoverMm} for finish3d and rough3d, rampAngle? 0-45 degrees for rough3d (ramp into each cut instead of plunging), toolId, ids (not needed for a photo or a 3D toolpath), photo: {w, h, data: base64 grey pixels, x, y, width, mode: "lines"|"dots", spacing, dir: "x"|"y", invert}, cutDepth, name?, side?: "outside"|"inside"|"on", direction?: "climb"|"conventional", startDepth?: 0, allowance?: 0, safeZ?: 5}',
    help: 'Make a toolpath from shapes with a tool, cutting down to cutDepth mm below the top of the material',
    run(doc, a) {
      if (doc.workspace.kind === 'canvas') throw new CommandError(CNC_CANVAS_NOTE);
      const cnc = doc.cnc ?? defaultCnc();
      if (!TOOLPATH_KINDS.includes(a?.kind)) throw new CommandError('"kind" must be one of ' + TOOLPATH_KINDS.join(', '));
      if (!cnc.tools.some((t) => t.id === a.toolId)) throw new CommandError(`There is no tool "${a.toolId}"`);
      const shapes = a.kind === 'photo' || a.kind === 'finish3d' || a.kind === 'rough3d' ? [] : idsArg(doc, a);
      let reliefId: number | undefined, scan;
      let reliefDepth = 0;
      if (a.kind === 'finish3d' || a.kind === 'rough3d') {
        const rel = (doc.reliefs ?? []).find((r) => r.id === a.reliefId);
        if (!rel) throw new CommandError('Import a 3D shape first (3D shapes, Import STL), then choose it');
        reliefId = rel.id; reliefDepth = rel.depth;
        try { scan = parseScan(a.scan); } catch (e) { throw new CommandError((e as Error).message); }
      }
      let photo;
      if (a.kind === 'photo') { try { photo = parsePhoto(a.photo); } catch (e) { throw new CommandError((e as Error).message); } }
      let rampAngle: number | undefined;
      if (a.rampAngle !== undefined) {
        if (a.kind !== 'rough3d') throw new CommandError('Only a 3D roughing toolpath has a ramp angle');
        if (typeof a.rampAngle !== 'number' || !Number.isFinite(a.rampAngle) || a.rampAngle < 0 || a.rampAngle > 45) throw new CommandError('The ramp angle must be 0 to 45 degrees');
        if (a.rampAngle > 0) rampAngle = a.rampAngle;
      }
      const cut = a.kind === 'finish3d' || a.kind === 'rough3d' ? reliefDepth : numArg(a, 'cutDepth', { positive: true });
      const start = a.kind === 'finish3d' || a.kind === 'rough3d' ? 0 : a.startDepth === undefined ? 0 : numArg(a, 'startDepth');
      if (start < 0 || start >= cut) throw new CommandError('The start depth must be 0 or more and less than the cut depth');
      const side = a.side ?? 'outside';
      if (!PROFILE_SIDES.includes(side)) throw new CommandError('"side" must be outside, inside or on');
      const direction = a.direction ?? 'climb';
      if (direction !== 'climb' && direction !== 'conventional') throw new CommandError('"direction" must be climb or conventional');
      const allowance = a.allowance === undefined ? 0 : numArg(a, 'allowance');
      if (allowance < 0) throw new CommandError('The allowance cannot be negative');
      const safeZ = a.safeZ === undefined ? 5 : numArg(a, 'safeZ', { positive: true });
      if (cnc.toolpaths.length >= 5000) throw new CommandError('That is too many toolpaths');
      const kindName = a.kind === 'profile' ? 'Profile' : a.kind === 'pocket' ? 'Pocket' : a.kind === 'engrave' ? 'Engraving' : a.kind === 'vcarve' ? 'V-carve' : a.kind === 'plug' ? 'Plug' : a.kind === 'photo' ? 'Photo' : a.kind === 'finish3d' ? '3D finishing' : a.kind === 'rough3d' ? '3D roughing' : 'Drill';
      const tp: Toolpath = {
        id: cnc.nextToolpathId, name: typeof a.name === 'string' && a.name.trim() ? a.name.trim().slice(0, 80) : `${kindName} ${cnc.nextToolpathId}`,
        kind: a.kind as ToolpathKind, toolId: a.toolId, shapeIds: shapes.map((s) => s.id), side, direction, startDepth: start, cutDepth: cut, allowance, safeZ, visible: true,
        ...(a.mirror === true ? { mirror: true } : {}),
        ...(photo ? { photo } : {}),
        ...(reliefId !== undefined ? { reliefId, scan } : {}),
        ...(rampAngle ? { rampAngle } : {}),
      };
      return { doc: { ...doc, cnc: { ...cnc, toolpaths: [...cnc.toolpaths, tp], nextToolpathId: cnc.nextToolpathId + 1 } }, message: `Toolpath "${tp.name}" added` };
    },
  },
  relief_add: {
    params: '{name?, w, h, data: base64 Uint16 heights, x, y, width, depth}',
    help: 'Add a 3D shape (a height grid made from an STL file) to carve',
    run(doc, a) {
      if (doc.workspace.kind === 'canvas') throw new CommandError(CNC_CANVAS_NOTE);
      const list = doc.reliefs ?? [];
      if (list.length >= MAX_RELIEFS) throw new CommandError(`A job can hold ${MAX_RELIEFS} 3D shapes`);
      const id = list.reduce((m, r) => Math.max(m, r.id), 0) + 1;
      let r: Relief;
      try { r = parseRelief({ ...a, id, name: typeof a?.name === 'string' && a.name.trim() ? a.name : `3D shape ${id}`, visible: true }); } catch (e) { throw new CommandError((e as Error).message); }
      return { doc: { ...doc, reliefs: [...list, r] }, message: `3D shape "${r.name}" added` };
    },
  },
  relief_update: {
    params: '{id, name?, x?, y?, width?, depth?, visible?}',
    help: 'Move, resize, rename or hide a 3D shape (width scales it evenly; depth is its height)',
    run(doc, a) {
      const cur = (doc.reliefs ?? []).find((r) => r.id === a?.id);
      if (!cur) throw new CommandError('There is no such 3D shape');
      let next: Relief;
      try { next = parseRelief({ ...cur, ...Object.fromEntries(['name', 'x', 'y', 'width', 'depth', 'visible'].filter((k) => a[k] !== undefined).map((k) => [k, a[k]])) }); } catch (e) { throw new CommandError((e as Error).message); }
      return { doc: { ...doc, reliefs: doc.reliefs!.map((r) => (r.id === cur.id ? next : r)) }, message: `3D shape "${next.name}" updated` };
    },
  },
  relief_delete: {
    params: '{id}',
    help: 'Remove a 3D shape',
    run(doc, a) {
      if (!(doc.reliefs ?? []).some((r) => r.id === a?.id)) throw new CommandError('There is no such 3D shape');
      if ((doc.cnc?.toolpaths ?? []).some((t) => t.reliefId === a.id)) throw new CommandError('A toolpath cuts this 3D shape. Delete that toolpath first');
      const reliefs = doc.reliefs!.filter((r) => r.id !== a.id);
      const { reliefs: _old, ...rest } = doc;
      return { doc: reliefs.length ? { ...rest, reliefs } : rest, message: '3D shape removed' };
    },
  },
  cnc_inlay_add: {
    params: '{ids, vbitId, depth, gap?: 0.1, mirror?: true, cutterId?: an end mill, through?: depth of the plug cut-out, direction?, safeZ?}',
    help: 'Make the toolpaths of an inlay from closed shapes: a V-carved pocket (grown by the glue gap), the plug (a chamfer cut inside the outline, mirrored by default as it is turned over) and, with cutterId, the cut-out of the plug',
    run(doc, a) {
      if (doc.workspace.kind === 'canvas') throw new CommandError(CNC_CANVAS_NOTE);
      const depth = numArg(a, 'depth', { positive: true });
      const gap = a.gap === undefined ? 0.1 : numArg(a, 'gap');
      if (gap < 0) throw new CommandError('The gap cannot be negative');
      const common = { ids: a.ids, direction: a.direction, safeZ: a.safeZ };
      let d = COMMANDS.cnc_toolpath_add.run(doc, { ...common, kind: 'vcarve', toolId: a.vbitId, cutDepth: depth, allowance: gap, name: `Inlay pocket ${(doc.cnc ?? defaultCnc()).nextToolpathId}` }).doc;
      const mirror = a.mirror !== false;
      d = COMMANDS.cnc_toolpath_add.run(d, { ...common, kind: 'plug', toolId: a.vbitId, cutDepth: depth, mirror, name: `Inlay plug ${(d.cnc ?? defaultCnc()).nextToolpathId}` }).doc;
      if (a.cutterId !== undefined) {
        const through = a.through === undefined ? numArg(a, 'depth', { positive: true }) + 0.3 : numArg(a, 'through', { positive: true });
        d = COMMANDS.cnc_toolpath_add.run(d, { ...common, kind: 'profile', side: 'outside', toolId: a.cutterId, cutDepth: through, mirror, name: `Inlay plug cut-out ${(d.cnc ?? defaultCnc()).nextToolpathId}` }).doc;
      }
      return { doc: d, message: 'Inlay toolpaths added' };
    },
  },
  cnc_toolpath_update: {
    params: '{id, ...fields to change: name, toolId, side, direction, startDepth, cutDepth, allowance, safeZ, visible, mirror, reliefId and scan {dir, stepoverMm} (3D toolpaths), photo (the settings to change; the picture stays unless data, w and h are given), ids}',
    help: 'Change a toolpath',
    run(doc, a) {
      const cnc = doc.cnc ?? defaultCnc();
      const cur = cnc.toolpaths.find((t) => t.id === a?.id);
      if (!cur) throw new CommandError('There is no such toolpath');
      const next: Toolpath = { ...cur };
      if (a.name !== undefined) { if (typeof a.name !== 'string' || !a.name.trim()) throw new CommandError('The name cannot be empty'); next.name = a.name.trim().slice(0, 80); }
      if (a.toolId !== undefined) { if (!cnc.tools.some((t) => t.id === a.toolId)) throw new CommandError(`There is no tool "${a.toolId}"`); next.toolId = a.toolId; }
      if (a.side !== undefined) { if (!PROFILE_SIDES.includes(a.side)) throw new CommandError('"side" must be outside, inside or on'); next.side = a.side; }
      if (a.direction !== undefined) { if (a.direction !== 'climb' && a.direction !== 'conventional') throw new CommandError('"direction" must be climb or conventional'); next.direction = a.direction; }
      if (a.startDepth !== undefined) next.startDepth = numArg(a, 'startDepth');
      if (a.cutDepth !== undefined) next.cutDepth = numArg(a, 'cutDepth', { positive: true });
      if (a.allowance !== undefined) next.allowance = numArg(a, 'allowance');
      if (a.safeZ !== undefined) next.safeZ = numArg(a, 'safeZ', { positive: true });
      if (a.visible !== undefined) next.visible = !!a.visible;
      if (a.mirror !== undefined) { if (a.mirror) next.mirror = true; else delete next.mirror; }
      if (a.rampAngle !== undefined) {
        if (cur.kind !== 'rough3d') throw new CommandError('Only a 3D roughing toolpath has a ramp angle');
        if (typeof a.rampAngle !== 'number' || !Number.isFinite(a.rampAngle) || a.rampAngle < 0 || a.rampAngle > 45) throw new CommandError('The ramp angle must be 0 to 45 degrees');
        if (a.rampAngle > 0) next.rampAngle = a.rampAngle; else delete next.rampAngle;
      }
      if (a.scan !== undefined || a.reliefId !== undefined) {
        if (cur.kind !== 'finish3d' && cur.kind !== 'rough3d') throw new CommandError('Only a 3D toolpath has a 3D shape and line settings');
        if (a.reliefId !== undefined) {
          const rel = (doc.reliefs ?? []).find((r) => r.id === a.reliefId);
          if (!rel) throw new CommandError('There is no such 3D shape');
          next.reliefId = rel.id; next.cutDepth = rel.depth;
        }
        if (a.scan !== undefined) { try { next.scan = parseScan({ ...cur.scan, ...a.scan }); } catch (e) { throw new CommandError((e as Error).message); } }
      }
      if (a.photo !== undefined) {
        if (cur.kind !== 'photo' || !cur.photo) throw new CommandError('Only a photo toolpath has a picture');
        try { next.photo = parsePhoto({ ...cur.photo, ...a.photo }); } catch (e) { throw new CommandError((e as Error).message); }
      }
      if (a.ids !== undefined) next.shapeIds = idsArg(doc, a).map((s) => s.id);
      if (next.startDepth < 0 || next.startDepth >= next.cutDepth) throw new CommandError('The start depth must be 0 or more and less than the cut depth');
      if (next.allowance < 0) throw new CommandError('The allowance cannot be negative');
      return { doc: { ...doc, cnc: { ...cnc, toolpaths: cnc.toolpaths.map((t) => (t.id === cur.id ? next : t)) } }, message: `Toolpath "${next.name}" updated` };
    },
  },
  cnc_toolpath_delete: {
    params: '{id}',
    help: 'Remove a toolpath',
    run(doc, a) {
      const cnc = doc.cnc ?? defaultCnc();
      if (!cnc.toolpaths.some((t) => t.id === a?.id)) throw new CommandError('There is no such toolpath');
      return { doc: { ...doc, cnc: { ...cnc, toolpaths: cnc.toolpaths.filter((t) => t.id !== a.id) } }, message: 'Toolpath removed' };
    },
  },
  cnc_job_set: {
    params: '{machine?: name or "" for any, material?: name or "" for any}',
    help: 'Choose the machine and the material of the job; the tool library offers its recipes for them',
    run(doc, a) {
      const cnc = doc.cnc ?? defaultCnc();
      const next = { ...cnc };
      for (const k of ['machine', 'material'] as const) {
        if (a?.[k] === undefined) continue;
        if (a[k] !== null && (typeof a[k] !== 'string' || a[k].length > 80)) throw new CommandError(`"${k}" must be a name`);
        if (a[k]) next[k] = a[k].trim(); else delete next[k];
      }
      return { doc: { ...doc, cnc: next }, message: `Machine: ${next.machine ?? 'any'}, material: ${next.material ?? 'any'}` };
    },
  },
  cnc_post_set: {
    params: '{name}',
    help: 'Choose the post processor used to write G-code',
    run(doc, a) {
      if (typeof a?.name !== 'string' || !a.name.trim() || a.name.length > 120) throw new CommandError('Give the name of a post processor');
      const cnc = doc.cnc ?? defaultCnc();
      return { doc: { ...doc, cnc: { ...cnc, post: a.name.trim() } }, message: `Post processor: ${a.name.trim()}` };
    },
  },
  cnc_gcode: {
    params: '{post?: name of a built-in post, postText?: the text of a .pp file, only?: [toolpath ids], homeX?: 0, homeY?: 0}',
    help: 'Write the G-code, one file per tool. Returns the files (it does not change the design)',
    run(doc, a) {
      if (doc.workspace.kind === 'canvas') throw new CommandError(CNC_CANVAS_NOTE);
      const cnc = doc.cnc ?? defaultCnc();
      let post;
      try {
        post = typeof a?.postText === 'string' ? parsePost(a.postText) : BUILT_IN_POSTS.find((p) => p.name === (a?.post ?? cnc.post)) ?? BUILT_IN_POSTS[0];
      } catch (e) { if (e instanceof PostError) throw new CommandError(e.message); throw e; }
      const files = generateFiles(doc, post, { only: Array.isArray(a?.only) ? a.only : undefined, home: { x: a?.homeX ?? 0, y: a?.homeY ?? 0 } });
      if (!files.length) throw new CommandError('There is nothing to write: make a toolpath first');
      return { doc, data: { post: post.name, extension: post.extension, files: files.map((f) => ({ tool: f.tool.name, toolId: f.tool.id, toolpaths: f.toolpaths.map((t) => t.name), lines: f.stats.lines, cutMm: Math.round(f.stats.cutLength), seconds: Math.round(f.stats.seconds), warnings: f.warnings, gcode: f.gcode })) }, message: `${files.length} G-code file${files.length === 1 ? '' : 's'} (one per tool) with ${post.name}` };
    },
  },
  to_path: {
    params: '{ids}',
    help: 'Turn circles into closed paths made of many short lines, so their points can be edited',
    run(doc, a) {
      const list = idsArg(doc, a).filter((s) => s.kind === 'circle');
      if (!list.length) throw new CommandError('None of the selected shapes is a circle');
      const by = new Map(list.map((c: any) => [c.id, { id: c.id, kind: 'path', layer: c.layer, closed: true, rings: [circleRing(c.cx, c.cy, c.r)] } as PathShape] as const));
      return { doc: { ...doc, shapes: doc.shapes.map((s) => by.get(s.id) ?? s) }, ids: list.map((s) => s.id), message: `${plural(list.length, 'circle')} turned into paths` };
    },
  },
  nodes_move: {
    params: '{id, nodes: [{ring, i}], dx, dy}',
    help: 'Move points of a path',
    run(doc, a) {
      const s = pathArg(doc, a);
      const dx = numArg(a, 'dx'), dy = numArg(a, 'dy');
      const moved = wrapNodes(() => moveNodes(s, nodesArg(a), dx, dy));
      return { doc: swap(doc, moved), ids: [s.id], message: `Moved ${plural(nodesArg(a).length, 'node')} by ${dx}, ${dy} mm` };
    },
  },
  node_insert: {
    params: '{id, ring, after, x?, y?}  or  {id, nodes: [...]} to put a node in the middle of every segment between two picked nodes',
    help: 'Add a point to a path',
    run(doc, a) {
      const s = pathArg(doc, a);
      if (a.nodes !== undefined) {
        const r = wrapNodes(() => insertMidpoints(s, nodesArg(a)));
        return { doc: swap(doc, r.shape), ids: [s.id], data: { added: r.added }, message: `Added ${plural(r.added.length, 'node')}` };
      }
      const at: Pt | undefined = a.x !== undefined && a.y !== undefined ? [numArg(a, 'x'), numArg(a, 'y')] : undefined;
      const r = wrapNodes(() => insertNode(s, a.ring ?? 0, numArg(a, 'after'), at));
      return { doc: swap(doc, r.shape), ids: [s.id], data: { added: [{ ring: a.ring ?? 0, i: r.index }] }, message: 'Added a node' };
    },
  },
  nodes_delete: {
    params: '{id, nodes: [{ring, i}]}',
    help: 'Remove points from a path (the neighbours are joined by a straight line)',
    run(doc, a) {
      const s = pathArg(doc, a);
      const nodes = nodesArg(a);
      return { doc: swap(doc, wrapNodes(() => deleteNodes(s, nodes))), ids: [s.id], message: `Removed ${plural(nodes.length, 'node')}` };
    },
  },
  node_break: {
    params: '{id, ring?: 0, i}',
    help: 'Cut a path open at a node (an open line is split in two there)',
    run(doc, a) {
      const s = pathArg(doc, a);
      const parts = wrapNodes(() => breakAt(s, a.ring ?? 0, numArg(a, 'i')));
      let next = doc.nextId;
      const made = parts.map((p, k) => (k === 0 ? p : { ...p, id: next++ }));
      const shapes = doc.shapes.flatMap((x) => (x.id === s.id ? made : [x]));
      return { doc: { ...doc, shapes, nextId: next }, ids: made.map((m) => m.id), message: parts.length > 1 ? 'Split the line in two' : 'Opened the outline' };
    },
  },
  path_close: {
    params: '{id, closed?: true}',
    help: 'Close a line into an outline (or open an outline with closed: false)',
    run(doc, a) {
      const s = pathArg(doc, a);
      const closed = a.closed !== false;
      return { doc: swap(doc, wrapNodes(() => setClosed(s, closed))), ids: [s.id], message: closed ? 'Closed the path' : 'Opened the path' };
    },
  },
  fillet: {
    params: '{ids, radius, style?: "round"|"cove"|"chamfer", nodes?: [{ring, i}]}  nodes limits it to some corners of one path',
    help: 'Round the corners of paths (round = normal outside rounding, cove = inside scoop centred on the corner, chamfer = straight cut). Limited to half of each side',
    run(doc, a) {
      const list = idsArg(doc, a).filter((s) => s.kind === 'path') as PathShape[];
      if (!list.length) throw new CommandError('Only paths have corners; use to_path on a circle first');
      const radius = numArg(a, 'radius', { positive: true });
      const style = styleArg(a);
      const only = a.nodes !== undefined ? nodesArg(a) : undefined;
      if (only && list.length !== 1) throw new CommandError('"nodes" works on one path at a time');
      let corners = 0, capped = 0;
      const by = new Map<number, Shape>();
      let skipped = 0;
      for (const s of list) {
        try {
          const f = filletPath(s, radius, style, only);
          corners += f.corners; capped += f.capped; by.set(s.id, f.shape);
        } catch (e) {
          if (e instanceof NodeError && list.length > 1) { skipped++; continue; }
          if (e instanceof NodeError) throw new CommandError(e.message);
          throw e;
        }
      }
      if (!by.size) throw new CommandError('There is no corner to work on');
      const word = style === 'round' ? 'Rounded' : style === 'cove' ? 'Scooped' : 'Chamfered';
      return { doc: { ...doc, shapes: doc.shapes.map((s) => by.get(s.id) ?? s) }, ids: [...by.keys()], message: `${word} ${plural(corners, 'corner')}` + (capped ? `; ${capped} limited to half of the side` : '') + (skipped ? `; ${skipped} shapes had no corners` : '') };
    },
  },
  add_traced: {
    params: '{shapes: [[ring, hole, ...], ...], layer?, dx?, dy?}  each shape is a list of closed rings [[x,y],...] (the first is the outline, the others holes); they are added as a group',
    help: 'Add the outlines made by tracing a bitmap (the Import bitmap dialog uses this)',
    run(doc, a) {
      const src = a?.shapes;
      if (!Array.isArray(src) || !src.length) throw new CommandError('There is nothing to add');
      if (src.length > 20000) throw new CommandError('That is too many shapes (limit 20,000)');
      const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
      const dx = a.dx === undefined ? 0 : numArg(a, 'dx'), dy = a.dy === undefined ? 0 : numArg(a, 'dy');
      let points = 0;
      const items: NewShape[] = src.map((rings: unknown) => {
        if (!Array.isArray(rings) || !rings.length) throw new CommandError('A traced shape has no outline');
        return {
          kind: 'path' as const, layer: layerArg(doc, a), closed: true, ...(src.length > 1 ? { group: 1 } : {}),
          rings: rings.map((r: unknown) => {
            if (!Array.isArray(r) || r.length < 3 || !r.every((p) => Array.isArray(p) && fin(p[0]) && fin(p[1]))) throw new CommandError('A traced outline is not valid');
            points += r.length;
            if (points > 600_000) throw new CommandError('That is too many points (limit 600,000): trace it smoother, or smaller');
            return r.map((p: number[]): Pt => [p[0] + dx, p[1] + dy]);
          }),
        };
      });
      const r = addShapes(doc, items);
      return { ...r, message: `Traced ${plural(items.length, 'shape')}, ${points} points` };
    },
  },
  fit_curves: {
    params: '{ids, tolerance?: 0.05, corner?: 40}  tolerance is how far (mm) the new curve may stray from the old points; a turn sharper than corner degrees stays a sharp corner',
    help: 'Fit smooth curves to lines made of many small segments (a traced or imported outline): fewer points, no jaggies, sharp corners kept',
    run(doc, a) {
      const list = idsArg(doc, a).filter((s): s is PathShape => s.kind === 'path');
      if (!list.length) throw new CommandError('Only lines and outlines can be fitted; a circle is already a perfect curve');
      const tolerance = a.tolerance === undefined ? 0.05 : numArg(a, 'tolerance', { positive: true });
      const corner = a.corner === undefined ? 40 : numArg(a, 'corner');
      if (tolerance > 100) throw new CommandError('That tolerance is over 100 mm');
      if (!(corner > 0 && corner < 180)) throw new CommandError('"corner" must be between 0 and 180 degrees');
      let before = 0, after = 0;
      const by = new Map<number, PathShape>();
      for (const s of list) {
        const f = fitShape(s, { tolerance, cornerAngle: corner });
        before += s.rings.reduce((n, r) => n + r.length, 0);
        after += f.rings.reduce((n, r) => n + r.length, 0);
        by.set(s.id, f);
      }
      return { doc: { ...doc, shapes: doc.shapes.map((s) => by.get(s.id) ?? s) }, ids: [...by.keys()], message: `Fitted curves to ${plural(by.size, 'shape')}: ${before} points to ${after}` };
    },
  },
  validate_fix: {
    params: '{ids?}  the picked shapes, or all of them',
    help: 'Put right what is safe to put right before cutting: close lines whose ends nearly meet, drop points sitting on top of each other, delete shapes too small to cut and identical copies drawn on top of each other. Crossings and open lines are only reported (the Check card)',
    run(doc, a) {
      const scope = a?.ids === undefined ? undefined : idsArg(doc, a).map((s) => s.id);
      let shapes = doc.shapes;
      const counts = { tiny: 0, closed: 0, deleted: 0, duplicates: 0 };
      const fixes = validate(doc, scope).filter((i) => i.fixable);
      if (!fixes.length) throw new CommandError('Nothing here can be fixed automatically (open lines and crossings need a decision)');
      const ofCode = (code: string) => new Set(fixes.filter((i) => i.code === code).flatMap((i) => i.ids));
      const tiny = ofCode('tiny'), almost = ofCode('almost-closed'), degenerate = ofCode('degenerate'), dup = ofCode('duplicate');
      const near = (p: Pt, q: Pt) => Math.hypot(p[0] - q[0], p[1] - q[1]) < VALIDATE_DEFAULTS.tiny;
      shapes = shapes.flatMap((s): Shape[] => {
        if (degenerate.has(s.id) || dup.has(s.id)) { if (degenerate.has(s.id)) counts.deleted++; else counts.duplicates++; return []; }
        if (s.kind !== 'path') return [s];
        let out: PathShape = s;
        if (tiny.has(s.id)) {
          const rings = s.rings.map((r) => {
            const kept = r.filter((p, i) => i === 0 || !near(p, r[i - 1]));
            if (s.closed && kept.length > 1 && near(kept[kept.length - 1], kept[0])) kept.pop();
            return kept;
          });
          counts.tiny++;
          out = { ...out, rings };
        }
        if (almost.has(s.id)) {
          const r = out.rings[0].map((p): Pt => [p[0], p[1]]);
          if (r.length > 3) r.pop();   // the end that was nearly on the start is the start: the shape closes there
          counts.closed++;
          out = { ...out, rings: [r], closed: true };
        }
        return [out];
      });
      const bits = [counts.closed && `closed ${plural(counts.closed, 'line')}`, counts.tiny && `cleaned the points of ${plural(counts.tiny, 'shape')}`, counts.deleted && `deleted ${plural(counts.deleted, 'shape')} too small to cut`, counts.duplicates && `deleted ${plural(counts.duplicates, 'duplicate')}`].filter(Boolean);
      return { doc: { ...doc, shapes }, message: bits.join(', ').replace(/^./, (c) => c.toUpperCase()) };
    },
  },
  fillet_lines: {
    params: '{ids: [a, b], ends: ["start"|"end", "start"|"end"], radius, style?: "round"|"cove"|"chamfer"}  two separate open lines, the end of each that should meet',
    help: 'Round the corner between two open lines in one step: they are extended (or cut back) to where they meet, joined, and the corner rounded',
    run(doc, a) {
      const list = idsArg(doc, a);
      const paths = list.filter((s): s is PathShape => s.kind === 'path');
      if (list.length !== 2 || paths.length !== 2 || paths[0].id === paths[1].id) throw new CommandError('Pick two different open lines');
      const ends = a.ends;
      if (!Array.isArray(ends) || ends.length !== 2 || !ends.every((e: unknown) => e === 'start' || e === 'end')) throw new CommandError('"ends" must be two of "start" or "end"');
      const radius = numArg(a, 'radius', { positive: true });
      const style = styleArg(a);
      const f = wrapNodes(() => filletLines(paths[0], ends[0], paths[1], ends[1], radius, style));
      const gone = new Set([paths[1].id]);
      const shapes = doc.shapes.flatMap((s) => (s.id === paths[0].id ? [f.shape] : gone.has(s.id) ? [] : [s]));
      const word = style === 'round' ? 'Rounded' : style === 'cove' ? 'Scooped' : 'Chamfered';
      return { doc: { ...doc, shapes }, ids: [paths[0].id], message: `${word} the corner between two lines, now one line` + (f.capped ? '; limited to half of the side' : '') };
    },
  },
  delete: {
    params: '{ids}',
    help: 'Delete shapes',
    run(doc, a) {
      const set = new Set(idsArg(doc, a).map((s) => s.id));
      return { doc: { ...doc, shapes: doc.shapes.filter((s) => !set.has(s.id)) }, message: `Deleted ${plural(set.size, 'shape')}` };
    },
  },
  set_layer: {
    params: '{ids, layer, create?: false}  create adds the layer when it does not exist yet',
    help: 'Move shapes to another layer',
    run(doc0, a) {
      const list = idsArg(doc0, a);
      const made = a.create ? ensureLayer(doc0, a.layer, '') : { doc: doc0, name: '' };
      const doc = made.doc;
      const layer = layerArg(doc, { layer: a.layer }, undefined);
      const set = new Set(list.map((s) => s.id));
      return { doc: { ...doc, shapes: doc.shapes.map((s) => (set.has(s.id) ? { ...s, layer } : s)) }, ids: [...set], message: `${plural(set.size, 'shape')} now on ${layer}` };
    },
  },
  remove_duplicates: {
    params: '{}  removes shapes that lie exactly on top of an identical shape on the same layer (the first one stays)',
    help: 'Remove duplicate shapes',
    run(doc) {
      const seen = new Set<string>();
      const keep = doc.shapes.filter((s) => { const k = shapeSignature(s as never); if (seen.has(k)) return false; seen.add(k); return true; });
      const removed = doc.shapes.length - keep.length;
      if (!removed) return { doc, message: 'No duplicate shapes found' };
      return { doc: { ...doc, shapes: keep }, message: `Removed ${plural(removed, 'duplicate shape')}` };
    },
  },
  copy_to_layer: {
    params: '{ids, layer, create?: false}  the originals stay where they are; the copies go on the layer and are selected',
    help: 'Copy shapes onto another layer (a new layer when create is true)',
    run(doc0, a) {
      const list = idsArg(doc0, a);
      const made = a.create ? ensureLayer(doc0, a.layer, '') : { doc: doc0, name: '' };
      const layer = layerArg(made.doc, { layer: a.layer }, undefined);
      const r = addShapes(made.doc, list.map((s) => ({ ...stripId(s), layer }) as NewShape), true);
      return { ...r, message: `Copied ${plural(list.length, 'shape')} to ${layer}` };
    },
  },
  boolean: {
    params: '{op: "union"|"difference"|"intersection", ids, keep?: false, layer?}  difference = the first id minus the rest',
    help: 'Combine closed shapes',
    run(doc, a) {
      const op = a?.op as BooleanOp;
      if (!['union', 'difference', 'intersection'].includes(op)) throw new CommandError('"op" must be union, difference or intersection');
      const list = idsArg(doc, a);
      const closed = list.filter(shapeClosed);
      if (closed.length < 2) throw new CommandError('Select at least two closed shapes (open lines cannot be combined)');
      const skipped = list.length - closed.length;
      const rings = booleanOp(op, closed);
      if (!rings.length) throw new CommandError(op === 'intersection' ? 'The shapes do not overlap, so nothing is left' : 'Nothing is left of the shapes');
      const layer = a.layer ? layerArg(doc, a) : closed[0].layer;
      const base = a.keep ? doc : { ...doc, shapes: doc.shapes.filter((s) => !closed.includes(s)) };
      const r = addShapes(base, [ringsToShape(rings, layer)]);
      const verb = op === 'union' ? 'Joined' : op === 'difference' ? 'Subtracted' : 'Intersected';
      return { ...r, message: `${verb} ${plural(closed.length, 'shape')}` + (skipped ? ` (${plural(skipped, 'open line')} left out)` : '') };
    },
  },
  boundary: {
    params: '{ids, mode?: "all"|"each"|"hull", distance?: 0, join?: "round"|"miter"|"square", keep?: true, layer?}  mode all: one outline round each group of shapes that touch or overlap; each: one round every shape; hull: one convex outline round everything. distance (mm, 0 or more) is the gap left all round',
    help: 'Draw a vector round the selected shapes (Boundary Create). Open lines are enclosed by their convex outline; holes are ignored',
    run(doc, a) {
      const list = idsArg(doc, a);
      const mode = a.mode ?? 'all';
      if (!['all', 'each', 'hull'].includes(mode)) throw new CommandError('"mode" must be all, each or hull');
      const distance = a.distance === undefined ? 0 : numArg(a, 'distance');
      if (distance < 0) throw new CommandError('The gap cannot be negative');
      if (distance > 5000) throw new CommandError('That gap is over 5 m');
      const join = (a.join ?? 'round') as JoinType;
      if (!['round', 'miter', 'square'].includes(join)) throw new CommandError('"join" must be round, miter or square');
      const layer = a.layer ? layerArg(doc, a) : list[0].layer;
      const outerOf = (rings: Pt[][]) => rings.filter((r) => !rings.some((o) => o !== r && pointInRing(r[0], o)));
      const tmp = (rings: Pt[][]): PathShape => ({ id: 0, kind: 'path', layer, rings, closed: true });
      const pointsOf = (shapes: Shape[]) => shapes.flatMap((s) => shapeRings(s).flat());
      // the outer rings of a region, grown by the gap
      const grow = (rings: Pt[][]): Pt[][] => (distance === 0 ? outerOf(rings) : outerOf(offsetShape(tmp(rings), distance, join)));
      const rings: Pt[][] = [];
      if (mode === 'hull') {
        const h = convexHull(pointsOf(list));
        if (h.length < 3) throw new CommandError('The shapes are all on one line, so there is nothing to put an outline round');
        rings.push(...grow([h]));
      } else if (mode === 'each') {
        for (const s of list) {
          const base = shapeClosed(s) ? outerOf(shapeRings(s)) : (() => { const h = convexHull(pointsOf([s])); return h.length >= 3 ? [h] : []; })();
          for (const r of base) rings.push(...grow([r]));
        }
      } else {
        const items: Shape[] = [];
        for (const s of list) {
          if (shapeClosed(s)) items.push(s);
          else { const h = convexHull(pointsOf([s])); if (h.length >= 3) items.push(tmp([h])); }
        }
        if (!items.length) throw new CommandError('Those lines are straight, so there is nothing to put an outline round');
        const merged = items.length === 1 ? shapeRings(items[0]) : unionRings(items);
        for (const r of outerOf(merged)) rings.push(...grow([r]));
      }
      if (!rings.length) throw new CommandError('No outline could be made');
      const made = rings.map((r) => ringsToShape([r], layer) as NewShape);
      const base = a.keep === false ? { ...doc, shapes: doc.shapes.filter((s) => !list.includes(s)) } : doc;
      const r = addShapes(base, made);
      return { ...r, message: `${plural(made.length, 'outline')} made round ${plural(list.length, 'shape')}` + (distance ? `, ${distance} mm out` : '') };
    },
  },
  offset: {
    params: '{ids, distance, direction?: "outward"|"inward"|"both", join?: "round"|"miter"|"square", keep?: true, outerOnly?: false, select?: true, layer?}  distance in mm; with no direction a negative distance shrinks',
    help: 'Grow or shrink shapes (kerf, inset, outline)',
    run(doc, a) {
      const list = idsArg(doc, a);
      const distance = numArg(a, 'distance');
      if (distance === 0) throw new CommandError('The offset distance cannot be 0');
      const join = (a.join ?? 'round') as JoinType;
      if (!['round', 'miter', 'square'].includes(join)) throw new CommandError('"join" must be round, miter or square');
      if (a.direction !== undefined && !['outward', 'inward', 'both'].includes(a.direction)) throw new CommandError('"direction" must be outward, inward or both');
      // a direction makes the distance a size; without one the sign says which way, as before
      const dists = a.direction === 'both' ? [Math.abs(distance), -Math.abs(distance)] : a.direction === 'inward' ? [-Math.abs(distance)] : a.direction === 'outward' ? [Math.abs(distance)] : [distance];
      const made: NewShape[] = [];
      let empty = 0;
      for (const s of list) {
        for (const d of dists) {
          if (!shapeClosed(s) && d < 0 && a.direction === 'both') continue; // an open line has no inside: only its outward half
          let rings = offsetShape(s, d, join);
          // "outer shapes only": drop the holes the offset leaves (a ring inside another ring)
          if (a.outerOnly === true) rings = rings.filter((r) => !rings.some((o) => o !== r && pointInRing(r[0], o)));
          if (!rings.length) { empty++; continue; }
          made.push(ringsToShape(rings, a.layer ? layerArg(doc, a) : s.layer));
        }
      }
      if (!made.length) throw new CommandError('Nothing is left after shrinking by that much');
      const keep = a.keep !== false;
      const base = keep ? doc : { ...doc, shapes: doc.shapes.filter((s) => !list.includes(s)) };
      const r = addShapes(base, made);
      const message = `Offset ${plural(made.length, 'shape')} by ${Math.abs(distance)} mm` + (empty ? ` (${plural(empty, 'shape')} vanished)` : '');
      return a.select === false ? { doc: r.doc, message } : { ...r, message };
    },
  },
  layer_set: {
    params: '{name, color?, mode?: "cut"|"engrave"|"score"|"tool", speed?, power? (maximum), minPower?, passes?, visible?, output?, air?, interval?, overscan?, fillMode?: "all"|"groups"|"individual"|"auto"}  creates the layer if it is new',
    help: 'Create or change a layer',
    run(doc, a) {
      const name = typeof a?.name === 'string' ? a.name.trim() : '';
      if (!name) throw new CommandError('A layer needs a name');
      const modes: LayerMode[] = ['cut', 'engrave', 'score', 'tool'];
      if (a.mode !== undefined && !modes.includes(a.mode)) throw new CommandError('"mode" must be cut, engrave, score or tool');
      if (a.color !== undefined && !/^#[0-9a-f]{6}$/i.test(a.color)) throw new CommandError('"color" must look like #rrggbb');
      if (a.speed !== undefined && !(a.speed > 0)) throw new CommandError('"speed" must be greater than 0');
      if (a.power !== undefined && !(a.power >= 0 && a.power <= 100)) throw new CommandError('"power" must be 0 to 100');
      if (a.minPower !== undefined && !(a.minPower >= 0 && a.minPower <= 100)) throw new CommandError('"minPower" must be 0 to 100');
      if (a.passes !== undefined && !(Number.isInteger(a.passes) && a.passes >= 1)) throw new CommandError('"passes" must be a whole number, 1 or more');
      if (a.fillMode !== undefined && !['all', 'groups', 'individual', 'auto'].includes(a.fillMode)) throw new CommandError('"fillMode" must be all, groups, individual or auto');
      if (a.interval !== undefined && !(a.interval >= 0.01 && a.interval <= 10)) throw new CommandError('"interval" must be 0.01 to 10 mm');
      if (a.overscan !== undefined && !(a.overscan >= 0 && a.overscan <= 50)) throw new CommandError('"overscan" must be 0 to 50 mm');
      for (const k of ['visible', 'output', 'air'] as const) if (a[k] !== undefined && typeof a[k] !== 'boolean') throw new CommandError(`"${k}" must be true or false`);
      const exists = doc.layers.some((l) => l.name === name);
      const patch: Partial<Layer> = {};
      for (const k of ['color', 'mode', 'speed', 'power', 'minPower', 'passes', 'visible', 'output', 'air', 'interval', 'fillMode', 'overscan'] as const) if (a[k] !== undefined) (patch as any)[k] = a[k];
      const before = doc.layers.find((l) => l.name === name) ?? newLayer(name, doc.layers.length);
      // the minimum never sits above the maximum: lowering the maximum drags it down, and a new layer starts with both equal
      if (patch.power !== undefined && patch.minPower === undefined) patch.minPower = before.minPower === before.power ? patch.power : Math.min(before.minPower, patch.power);
      if (patch.minPower !== undefined && patch.minPower > (patch.power ?? before.power)) throw new CommandError('"minPower" cannot be above the maximum power');
      const layers = exists ? doc.layers.map((l) => (l.name === name ? { ...l, ...patch } : l)) : [...doc.layers, { ...before, ...patch }];
      return { doc: { ...doc, layers }, message: exists ? `Layer ${name} updated` : `Layer ${name} added` };
    },
  },
  layer_rename: {
    params: '{name, to}',
    help: 'Rename a layer (the shapes on it follow)',
    run(doc, a) {
      const name = typeof a?.name === 'string' ? a.name : '';
      const to = typeof a?.to === 'string' ? a.to.trim() : '';
      if (!doc.layers.some((l) => l.name === name)) throw new CommandError(`There is no layer called "${name}"`);
      if (!to) throw new CommandError('The new name cannot be empty');
      if (to.length > 40) throw new CommandError('A layer name is at most 40 characters');
      if (to === name) return { doc, message: 'The name is unchanged' };
      if (doc.layers.some((l) => l.name === to)) throw new CommandError(`There is already a layer called "${to}"`);
      return {
        doc: { ...doc, layers: doc.layers.map((l) => (l.name === name ? { ...l, name: to } : l)), shapes: doc.shapes.map((s) => (s.layer === name ? { ...s, layer: to } : s)) },
        message: `Layer ${name} is now ${to}`,
      };
    },
  },
  layer_delete: {
    params: '{name, moveTo?: layer name, deleteShapes?: true}  a layer with shapes on it needs moveTo (they go to that layer) or deleteShapes',
    help: 'Delete a layer',
    run(doc, a) {
      const name = typeof a?.name === 'string' ? a.name : '';
      if (!doc.layers.some((l) => l.name === name)) throw new CommandError(`There is no layer called "${name}"`);
      if (doc.layers.length <= 1) throw new CommandError('A design needs at least one layer');
      const onIt = doc.shapes.filter((s) => s.layer === name);
      let shapes = doc.shapes;
      let how = '';
      if (onIt.length) {
        if (typeof a.moveTo === 'string') {
          if (a.moveTo === name || !doc.layers.some((l) => l.name === a.moveTo)) throw new CommandError('"moveTo" must be another existing layer');
          shapes = doc.shapes.map((s) => (s.layer === name ? { ...s, layer: a.moveTo } : s));
          how = `, ${plural(onIt.length, 'shape')} moved to ${a.moveTo}`;
        } else if (a.deleteShapes === true) {
          shapes = doc.shapes.filter((s) => s.layer !== name);
          how = `, ${plural(onIt.length, 'shape')} deleted`;
        } else {
          throw new CommandError(`${plural(onIt.length, 'shape')} ${onIt.length === 1 ? 'is' : 'are'} on layer ${name}: say where they go ("moveTo") or "deleteShapes": true`);
        }
      }
      return { doc: { ...doc, layers: doc.layers.filter((l) => l.name !== name), shapes }, message: `Layer ${name} deleted${how}` };
    },
  },
  layer_move: {
    params: '{name, direction: "up"|"down"|"top"|"bottom"}  layers burn from the top of the list down, so engraving usually goes above cutting',
    help: 'Move a layer up or down the list (the order the layers burn in)',
    run(doc, a) {
      const i = doc.layers.findIndex((l) => l.name === a?.name);
      if (i < 0) throw new CommandError(`There is no layer called "${a?.name}"`);
      const to = a.direction === 'up' ? i - 1 : a.direction === 'down' ? i + 1 : a.direction === 'top' ? 0 : a.direction === 'bottom' ? doc.layers.length - 1 : NaN;
      if (Number.isNaN(to)) throw new CommandError('"direction" must be up, down, top or bottom');
      if (to < 0 || to >= doc.layers.length || to === i) return { doc, message: `Layer ${a.name} is already ${a.direction === 'up' || a.direction === 'top' ? 'first' : 'last'}` };
      const layers = [...doc.layers];
      const [l] = layers.splice(i, 1);
      layers.splice(to, 0, l);
      return { doc: { ...doc, layers }, message: `Layer ${a.name} moved ${a.direction}` };
    },
  },
  workspace_set: {
    params: '{kind?: "laser"|"cnc"|"free", width?, height?, thickness?, datum?: "bl"|"c"|..., zZero?: "surface"|"bed", machine?: {name?, sMax?, rapid?}}  the size of the job (CNC stock or laser area). Keeps the shapes; anything outside the new area is only flagged.',
    help: 'Set the job size (like VCarve Job Setup or choosing a LightBurn device)',
    run(doc, a) {
      if (a?.machine !== undefined) {
        if (typeof a.machine !== 'object' || a.machine === null) throw new CommandError('"machine" must be an object');
        doc = COMMANDS.machine_set.run(doc, { name: a.machine.name, sMax: a.machine.sMax, rapid: a.machine.rapid, ...(a.machine.origin ? { origin: a.machine.origin } : {}) }).doc;
      }
      const ws = { ...doc.workspace };
      if (a?.kind !== undefined) {
        if (!['laser', 'cnc', 'canvas', 'free'].includes(a.kind)) throw new CommandError('"kind" must be laser, cnc, canvas or free');
        ws.kind = a.kind;
      }
      for (const [k, min, max] of [['width', 1, 100000], ['height', 1, 100000], ['thickness', 0, 10000]] as const) {
        if (a?.[k] === undefined) continue;
        if (typeof a[k] !== 'number' || !(a[k] >= min && a[k] <= max)) throw new CommandError(`"${k}" must be a number from ${min} to ${max}`);
        ws[k] = a[k];
      }
      if (a?.datum !== undefined) {
        if (!ANCHORS.includes(a.datum)) throw new CommandError('"datum" must be one of ' + ANCHORS.join(', '));
        ws.datum = a.datum;
      }
      if (a?.zZero !== undefined) {
        if (a.zZero !== 'surface' && a.zZero !== 'bed') throw new CommandError('"zZero" must be surface or bed');
        ws.zZero = a.zZero;
      }
      if (a?.sides !== undefined) {
        if (a.sides !== 1 && a.sides !== 2) throw new CommandError('"sides" must be 1 or 2');
        ws.sides = a.sides;
      }
      if (ws.kind !== 'cnc') delete ws.sides;
      if (ws.kind === 'cnc' && !(ws.thickness > 0)) throw new CommandError('A CNC job needs a material thickness greater than 0');
      const machine = ws.kind === 'laser' ? { ...doc.machine, width: ws.width, height: ws.height } : doc.machine;
      const label = ws.kind === 'free' ? 'no size limit' : `${ws.width} × ${ws.height} mm` + (ws.kind === 'cnc' ? `, ${ws.thickness} mm thick${ws.sides === 2 ? ', two sides' : ''}` : ws.kind === 'laser' && ws.thickness > 0 ? `, ${ws.thickness} mm material` : '');
      return { doc: { ...doc, workspace: ws, machine }, message: `Job: ${ws.kind}, ${label}` };
    },
  },
  new_project: {
    params: '{kind, width?, height?, thickness?, datum?, zZero?, machine?: {name?, sMax?, rapid?}}  starts an empty drawing for this job. Undo brings the old one back.',
    help: 'Start a new drawing for a laser, a CNC job, or no limit',
    run(_doc, a) {
      return COMMANDS.workspace_set.run(emptyDoc(), a);
    },
  },
  machine_set: {
    params: '{name?, width?, height?, sMax?, rapid?, origin?: "tl"|"bl"}  the machine the job is for: bed size in mm, the controller\'s max S value ($30), rapid speed in mm/s',
    help: 'Set the machine the laser job is made for',
    run(doc, a) {
      const m = { ...doc.machine };
      if (a?.name !== undefined) { if (typeof a.name !== 'string' || !a.name.trim()) throw new CommandError('"name" must be text'); m.name = a.name.trim(); }
      if (a?.origin !== undefined) { if (a.origin !== 'tl' && a.origin !== 'bl') throw new CommandError('"origin" must be tl or bl'); m.origin = a.origin; }
      for (const [k, min, max] of [['width', 1, 100000], ['height', 1, 100000], ['sMax', 1, 100000], ['rapid', 1, 5000]] as const) {
        if (a?.[k] === undefined) continue;
        if (typeof a[k] !== 'number' || !(a[k] >= min && a[k] <= max)) throw new CommandError(`"${k}" must be a number from ${min} to ${max}`);
        m[k] = a[k];
      }
      const workspace = doc.workspace.kind === 'laser' ? { ...doc.workspace, width: m.width, height: m.height } : doc.workspace;
      return { doc: { ...doc, machine: m, workspace }, message: `Machine: ${m.name}, ${m.width} × ${m.height} mm, S max ${m.sMax}` };
    },
  },
  laser_gcode: {
    params: '{only?: [ids], anchor?: "bl"|"c"|...}  builds the GRBL laser job and returns it (gcode, stats). Changes nothing.',
    help: 'Make the laser G-code for the layers that have Output on',
    run(doc, a) {
      const only = a?.only === undefined ? undefined : Array.isArray(a.only) ? (a.only as number[]) : null;
      if (only === null) throw new CommandError('"only" must be a list of shape ids');
      const anchor = (a?.anchor ?? 'bl') as Anchor;
      if (!ANCHORS.includes(anchor)) throw new CommandError('"anchor" must be one of ' + ANCHORS.join(', '));
      const job = buildLaserJob(doc, { onlyIds: only, anchor });
      return { doc, message: job.empty ? 'Nothing to burn: ' + job.stats.warnings.join(' ') : `${job.gcode.split('\n').length} lines, about ${formatTime(job.stats.seconds)}`, data: { gcode: job.gcode, stats: job.stats } };
    },
  },
  import_dxf: {
    params: '{text}  the contents of a DXF file (or {parsed}, the result of importDxf, when the page has already read it elsewhere)',
    help: 'Add the drawing in a DXF file',
    run(doc, a) {
      const parsed = a?.parsed as ReturnType<typeof importDxf> | undefined;
      if (!parsed && typeof a?.text !== 'string') throw new CommandError('"text" must be the DXF file contents');
      const imp = parsed && Array.isArray(parsed.shapes) && Array.isArray(parsed.layers) ? parsed : importDxf(a.text);
      let layers = doc.layers;
      for (const l of imp.layers) if (!layers.some((x) => x.name === l.name)) layers = [...layers, l];
      // importing the same file twice (a slow first try, a second click) must not stack a second copy on the first
      const have = new Set(doc.shapes.map(shapeSignature));
      const fresh: NewShape[] = [];
      let repeats = 0;
      for (const sh of imp.shapes) {
        const sig = shapeSignature(sh);
        if (have.has(sig)) repeats++;
        else { have.add(sig); fresh.push(sh); }
      }
      const r = addShapes({ ...doc, layers }, fresh);
      const notes = [...(repeats ? [`${plural(repeats, 'shape')} already in the drawing, not added again`] : []), ...imp.warnings];
      return { ...r, message: `Imported ${plural(fresh.length, 'shape')}` + (notes.length ? '. ' + notes.join('; ') : '') };
    },
  },
  open_project: {
    params: '{text}  the contents of a project (.dxd) file. Replaces the drawing; undo brings the old one back.',
    help: 'Open a saved design',
    run(_doc, a) {
      if (typeof a?.text !== 'string') throw new CommandError('"text" must be the project file contents');
      try {
        const doc = parseProject(a.text);
        return { doc, message: `Opened a design with ${plural(doc.shapes.length, 'shape')} on ${plural(doc.layers.length, 'layer')}` };
      } catch (e) {
        if (e instanceof ProjectError) throw new CommandError(e.message);
        throw e;
      }
    },
  },
  export_project: {
    params: '{}  returns the project file text. Changes nothing.',
    help: 'Get the design as a project file',
    run(doc) {
      return { doc, message: 'Project file made', data: { text: serializeProject(doc) } };
    },
  },
  trim: {
    params: '{x, y, tol?}  the point on a line or outline to cut away (between the two crossings around it); tol is how close in mm (default 0.5)',
    help: 'Cut away the piece of a line or outline between crossings (scissors)',
    run(doc, a) {
      const x = numArg(a, 'x'), y = numArg(a, 'y');
      const tol = a?.tol === undefined ? 0.5 : numArg(a, 'tol', { positive: true });
      const r = planTrim(doc.shapes, doc.layers, [x, y], tol);
      if (!r.ok) throw new CommandError(r.reason);
      const plan = r.plan;
      const target = doc.shapes.find((s) => s.id === plan.shapeId)!;
      // the trimmed outline goes; any other outlines of the same shape stay as they were
      const others = target.kind === 'path' ? target.rings.filter((_, i) => i !== plan.ringIndex) : [];
      const replaced: Shape[] = doc.shapes.flatMap((s) => (s.id !== target.id ? [s] : others.length && target.kind === 'path' ? [{ ...target, rings: others }] : []));
      const base: Doc = { ...doc, shapes: replaced };
      const made = addShapes(base, plan.keep.map((pts) => ({ kind: 'path' as const, layer: target.layer, rings: [pts], closed: false })));
      let len = 0;
      for (let i = 1; i < plan.remove.length; i++) len += Math.hypot(plan.remove[i][0] - plan.remove[i - 1][0], plan.remove[i][1] - plan.remove[i - 1][1]);
      return { doc: made.doc, ids: made.ids, message: `Trimmed away ${Math.round(len * 100) / 100} mm` + (made.ids.length ? `, ${plural(made.ids.length, 'piece')} left` : '') };
    },
  },
  inspect: {
    params: '{}',
    help: 'List the layers and shapes',
    run(doc) {
      const data = {
        layers: doc.layers,
        shapes: doc.shapes.map((s) => (s.kind === 'circle' ? { id: s.id, kind: 'circle', layer: s.layer, cx: s.cx, cy: s.cy, r: s.r } : { id: s.id, kind: 'path', layer: s.layer, closed: s.closed, rings: s.rings.length, points: s.rings.reduce((n, r) => n + r.length, 0) })),
      };
      return { doc, message: `${plural(doc.layers.length, 'layer')}, ${plural(doc.shapes.length, 'shape')}`, data };
    },
  },
};

export function execute(doc: Doc, id: string, args: unknown): CommandResult {
  const spec = COMMANDS[id];
  if (!spec) throw new CommandError(`Unknown command "${id}". Type help for the list.`);
  return spec.run(doc, args ?? {});
}

export function listCommands(): { id: string; params: string; help: string }[] {
  return Object.entries(COMMANDS).map(([id, c]) => ({ id, params: c.params, help: c.help }));
}

/**
 * The console's input: either JSON ({"cmd":"add_rect","args":{...}}) or a short typed form such as
 * `rect 0 0 50 30`, `circle 10 10 5`, `offset 2`, `union`. Typed forms that act on the selection take its ids.
 */
export function parseLine(line: string, selection: number[]): { id: string; args: any } {
  const text = line.trim();
  if (text.startsWith('{')) {
    let j: any;
    try { j = JSON.parse(text); } catch { throw new CommandError('That is not valid JSON'); }
    if (typeof j.cmd !== 'string') throw new CommandError('JSON commands look like {"cmd":"add_rect","args":{...}}');
    return { id: j.cmd, args: j.args ?? {} };
  }
  const [word, ...rest] = text.split(/\s+/);
  const n = rest.map(Number);
  const need = (count: number, usage: string) => {
    if (n.length < count || n.slice(0, count).some((v) => !Number.isFinite(v))) throw new CommandError(`Usage: ${usage}`);
  };
  switch (word.toLowerCase()) {
    case 'rect': need(4, 'rect x y w h'); return { id: 'add_rect', args: { x: n[0], y: n[1], w: n[2], h: n[3] } };
    case 'circle': need(3, 'circle cx cy r'); return { id: 'add_circle', args: { cx: n[0], cy: n[1], r: n[2] } };
    case 'dup': case 'duplicate': return { id: 'duplicate', args: { ids: selection, ...(n.length >= 2 ? { dx: n[0], dy: n[1] } : {}) } };
    case 'grid': need(4, 'grid cols rows dx dy'); return { id: 'array', args: { ids: selection, kind: 'grid', cols: n[0], rows: n[1], dx: n[2], dy: n[3] } };
    case 'circular': need(1, 'circular count [angle]'); return { id: 'array', args: { ids: selection, kind: 'circular', count: n[0], ...(n.length > 1 ? { angle: n[1] } : {}) } };
    case 'move': need(2, 'move dx dy'); return { id: 'move', args: { ids: selection, dx: n[0], dy: n[1] } };
    case 'offset': need(1, 'offset distance_mm'); return { id: 'offset', args: { ids: selection, distance: n[0] } };
    case 'union': return { id: 'boolean', args: { op: 'union', ids: selection } };
    case 'diff': case 'subtract': return { id: 'boolean', args: { op: 'difference', ids: selection } };
    case 'inter': case 'intersect': return { id: 'boolean', args: { op: 'intersection', ids: selection } };
    case 'del': case 'delete': return { id: 'delete', args: { ids: selection } };
    case 'inspect': return { id: 'inspect', args: {} };
    default: return { id: word, args: {} };
  }
}
