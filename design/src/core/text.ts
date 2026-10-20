/**
 * Text as vector outlines. The font is reached through a small interface, so this file knows nothing about font
 * file formats; `fonts.ts` adapts real font files to it. Everything here is millimetres with Y pointing up.
 */
import type { Pt } from './types';

export interface PathCmd { type: 'M' | 'L' | 'Q' | 'C' | 'Z'; x?: number; y?: number; x1?: number; y1?: number; x2?: number; y2?: number }

export interface TextFont {
  name: string;
  unitsPerEm: number;
  /** Height of a capital letter in font units (what the "text height" box refers to). */
  capHeight: number;
  /** One character: how far it advances and its outline in font units (Y up). null when the font has no such character. */
  glyph(ch: string): { advance: number; commands: PathCmd[] } | null;
  /** Kerning between two characters, font units. */
  kerning(a: string, b: string): number;
}

const registry = new Map<string, TextFont>();
export const registerFont = (f: TextFont) => { registry.set(f.name, f); };
export const getFont = (name: string): TextFont | undefined => registry.get(name);
export const fontNames = (): string[] => [...registry.keys()];

export const MAX_TEXT = 2000;
const SEGMENT_MM = 0.3; // curves are cut into pieces about this long (a 1 mm radius is off by about 0.01 mm)

function curve(pts: Pt[], len: number, at: (t: number) => Pt) {
  const n = Math.max(3, Math.min(40, Math.ceil(len / SEGMENT_MM)));
  for (let i = 1; i <= n; i++) pts.push(at(i / n));
}

/** A glyph outline as closed rings, curves flattened, moved by (ox, oy) and scaled by s. */
function glyphRings(cmds: PathCmd[], s: number, ox: number, oy: number): Pt[][] {
  const rings: Pt[][] = [];
  let cur: Pt[] = [];
  let p: Pt = [0, 0];
  const P = (x: number, y: number): Pt => [ox + x * s, oy + y * s];
  const flush = () => { if (cur.length >= 3) rings.push(cur); cur = []; };
  for (const c of cmds) {
    if (c.type === 'M') { flush(); p = P(c.x!, c.y!); cur = [p]; }
    else if (c.type === 'L') { p = P(c.x!, c.y!); cur.push(p); }
    else if (c.type === 'Q') {
      const a = p, b = P(c.x1!, c.y1!), e = P(c.x!, c.y!);
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) + Math.hypot(e[0] - b[0], e[1] - b[1]);
      curve(cur, len, (t) => [(1 - t) * (1 - t) * a[0] + 2 * (1 - t) * t * b[0] + t * t * e[0], (1 - t) * (1 - t) * a[1] + 2 * (1 - t) * t * b[1] + t * t * e[1]]);
      p = e;
    } else if (c.type === 'C') {
      const a = p, b = P(c.x1!, c.y1!), d = P(c.x2!, c.y2!), e = P(c.x!, c.y!);
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) + Math.hypot(d[0] - b[0], d[1] - b[1]) + Math.hypot(e[0] - d[0], e[1] - d[1]);
      curve(cur, len, (t) => {
        const u = 1 - t;
        return [u * u * u * a[0] + 3 * u * u * t * b[0] + 3 * u * t * t * d[0] + t * t * t * e[0], u * u * u * a[1] + 3 * u * u * t * b[1] + 3 * u * t * t * d[1] + t * t * t * e[1]];
      });
      p = e;
    } else flush();
  }
  flush();
  // a ring that ends where it began does not need the point twice
  return rings.map((r) => (r.length > 3 && Math.hypot(r[0][0] - r[r.length - 1][0], r[0][1] - r[r.length - 1][1]) < 1e-9 ? r.slice(0, -1) : r));
}

export interface TextOptions {
  height: number;
  align?: 'left' | 'center' | 'right';
  /** Extra space after every letter, mm. */
  spacing?: number;
  /** 1 = the font's normal line pitch. */
  lineSpacing?: number;
}

export interface TextLayout {
  /** One entry per drawn character, in reading order: its rings. */
  glyphs: Pt[][][];
  /** For each glyph: the middle of its advance along the baseline (x) */
  centers: number[];
  missing: string[];
  width: number;
}

/** Lay the text out with its first baseline starting at (x, y). */
export function layoutText(font: TextFont, text: string, x: number, y: number, o: TextOptions): TextLayout {
  const s = o.height / font.capHeight; // mm per font unit
  const extra = (o.spacing ?? 0) / s;   // in font units
  const pitch = font.unitsPerEm * 1.2 * (o.lineSpacing ?? 1) * s;
  const glyphs: Pt[][][] = [];
  const centers: number[] = [];
  const missing = new Set<string>();
  let widest = 0;
  text.replace(/\t/g, ' ').split(/\r?\n/).forEach((line, li) => {
    const chars = [...line];
    const placed: { ch: string; pen: number; g: NonNullable<ReturnType<TextFont['glyph']>> }[] = [];
    let pen = 0;
    chars.forEach((ch, i) => {
      const g = font.glyph(ch);
      if (!g) { missing.add(ch); return; }
      if (placed.length) pen += font.kerning(placed[placed.length - 1].ch, ch);
      placed.push({ ch, pen, g });
      pen += g.advance + (i < chars.length - 1 ? extra : 0);
    });
    const w = pen * s;
    widest = Math.max(widest, w);
    const shift = o.align === 'center' ? -w / 2 : o.align === 'right' ? -w : 0;
    const by = y - li * pitch;
    for (const { pen: px, g } of placed) {
      const rings = glyphRings(g.commands, s, x + shift + px * s, by);
      if (rings.length) { glyphs.push(rings); centers.push(x + shift + (px + g.advance / 2) * s); }
    }
  });
  return { glyphs, centers, missing: [...missing], width: widest };
}

/** A polyline measured by length: where a distance along it lands, and which way it points there. */
function curveAt(pts: Pt[], closed: boolean) {
  const path = closed ? [...pts, pts[0]] : pts;
  const cum = [0];
  for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]));
  const len = cum[cum.length - 1];
  const at = (s0: number): { p: Pt; angle: number } | null => {
    let s = s0;
    if (closed) s = ((s % len) + len) % len;
    else {
      // a flattened arc is a hair shorter than the true arc its text was measured along: the last letter still belongs on it
      const tol = len * 0.002 + 1e-6;
      if (s < -tol || s > len + tol) return null;
      s = Math.min(len, Math.max(0, s));
    }
    let i = 1;
    while (i < path.length - 1 && cum[i] < s) i++;
    const seg = cum[i] - cum[i - 1];
    const t = seg > 1e-12 ? Math.min(1, Math.max(0, (s - cum[i - 1]) / seg)) : 0;
    const a = path[i - 1], b = path[i];
    return { p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], angle: Math.atan2(b[1] - a[1], b[0] - a[0]) };
  };
  return { len, at };
}

/**
 * Lay a text layout (made with its first baseline at 0, 0) along a curve: each letter is turned to the curve and stood on it, whole
 * (not bent). `align` says where on the curve the text starts: its start, its middle or its end; `offset` moves it along from there.
 * Letters that fall off the end of an open curve are dropped and counted.
 */
export function placeOnCurve(lay: TextLayout, curve: { pts: Pt[]; closed: boolean; offset: number; flip: boolean }, align: 'left' | 'center' | 'right'): { glyphs: Pt[][][]; dropped: number } {
  // text stands on the left of the way the curve runs; a closed outline is taken clockwise so that is the outside of it (flip: the inside)
  let dir = curve.pts;
  if (curve.closed) {
    let area = 0;
    for (let i = 0; i < dir.length; i++) { const p = dir[i], q = dir[(i + 1) % dir.length]; area += p[0] * q[1] - q[0] * p[1]; }
    if (area > 0) dir = [...dir].reverse();
  }
  const pts = curve.flip ? [...dir].reverse() : dir;
  const c = curveAt(pts, curve.closed);
  const base = (align === 'left' ? 0 : align === 'center' ? c.len / 2 : c.len) + curve.offset;
  const glyphs: Pt[][][] = [];
  let dropped = 0;
  lay.glyphs.forEach((rings, i) => {
    const cx = lay.centers[i];
    const f = c.at(base + cx);
    if (!f) { dropped++; return; }
    const cos = Math.cos(f.angle), sin = Math.sin(f.angle);
    glyphs.push(rings.map((r) => r.map((q): Pt => {
      const lx = q[0] - cx, ly = q[1];
      return [f.p[0] + lx * cos - ly * sin, f.p[1] + lx * sin + ly * cos];
    })));
  });
  return { glyphs, dropped };
}

/** An arc of the given length turning through `bend` degrees (positive: an arch, the text on top of it; negative: a smile), its middle at 0, 0. */
export function arcCurve(length: number, bend: number): { pts: Pt[]; closed: false; offset: 0; flip: false } {
  const phi = (Math.abs(bend) * Math.PI) / 180;
  const R = length / phi;
  const n = Math.min(720, Math.max(8, Math.ceil(phi / Math.max(2 * Math.acos(Math.max(0, 1 - 0.005 / R)), 1e-3))));
  const pts: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    if (bend > 0) { const a = Math.PI / 2 + phi / 2 - phi * t; pts.push([R * Math.cos(a), R * Math.sin(a) - R]); }
    else { const a = -Math.PI / 2 - phi / 2 + phi * t; pts.push([R * Math.cos(a), R * Math.sin(a) + R]); }
  }
  return { pts, closed: false, offset: 0, flip: false };
}

/** Most the bend can be: past about 260 degrees a bigger turn makes the text sag less, not more, so the handle would run backwards */
export const MAX_BEND = 260;

/**
 * How far the ends of a line of the given length drop below its middle (arch) when it is bent through `bend` degrees: the "sag" the curve
 * handle moves by. Signed like the bend.
 */
export function bendSag(length: number, bend: number): number {
  const phi = (Math.abs(bend) * Math.PI) / 180;
  if (phi < 1e-9) return 0;
  return Math.sign(bend) * (length * (1 - Math.cos(phi / 2))) / phi;
}

/** The bend (degrees) that gives this sag for a line of this length; the other way round of `bendSag`. Limited to +-MAX_BEND. */
export function bendForSag(length: number, sag: number): number {
  const target = Math.abs(sag);
  if (target < 1e-9 || length <= 0) return 0;
  let lo = 0, hi = MAX_BEND;
  if (target >= Math.abs(bendSag(length, MAX_BEND))) return Math.sign(sag) * MAX_BEND;
  for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (Math.abs(bendSag(length, mid)) < target) lo = mid; else hi = mid; }
  return Math.sign(sag) * Math.round(((lo + hi) / 2) * 100) / 100;
}

/**
 * The text cursor: a short vertical line at the place after the first `index` characters of the text, as two points (bottom, top of a capital).
 * `bend` and `curve` put it on the bent or curved text the same way the letters are placed.
 */
export function caretSegment(font: TextFont, text: string, index: number, o: TextOptions & { x: number; y: number; bend?: number; curve?: { pts: Pt[]; closed: boolean; offset: number; flip: boolean } }): [Pt, Pt] {
  const s = o.height / font.capHeight;
  const extra = (o.spacing ?? 0) / s;
  const pitch = font.unitsPerEm * 1.2 * (o.lineSpacing ?? 1) * s;
  const lines = text.replace(/\t/g, ' ').replace(/\r\n/g, '\n').split('\n');
  // which line the index falls on, and how many characters of it come before
  let rest = Math.max(0, Math.min(index, text.length)), li = 0;
  while (li < lines.length - 1 && rest > [...lines[li]].length) { rest -= [...lines[li]].length + 1; li++; }
  const penAfter = (line: string, k: number): number => {
    const chars = [...line];
    let pen = 0, prev: string | undefined;
    for (let i = 0; i < Math.min(k, chars.length); i++) {
      const g = font.glyph(chars[i]);
      if (!g) continue;
      if (prev !== undefined) pen += font.kerning(prev, chars[i]);
      pen += g.advance + (i < chars.length - 1 ? extra : 0);
      prev = chars[i];
    }
    return pen;
  };
  const lineWidth = (line: string) => penAfter(line, [...line].length) * s;
  const widest = Math.max(...lines.map(lineWidth), 1e-6);
  const w = lineWidth(lines[li]);
  const shift = o.align === 'center' ? -w / 2 : o.align === 'right' ? -w : 0;
  const bx = shift + penAfter(lines[li], rest) * s;
  const by = -li * pitch;
  const bottom: Pt = [bx, by], top: Pt = [bx, by + o.height * 1.15];
  const fake = { glyphs: [[[[bottom[0], bottom[1]], [top[0], top[1]]] as Pt[]]], centers: [bx], missing: [] as string[], width: widest };
  if (o.curve) {
    const r = placeOnCurve(fake, o.curve, o.align ?? 'left');
    if (r.glyphs.length) return [r.glyphs[0][0][0], r.glyphs[0][0][1]];
  } else if (o.bend) {
    const r = placeOnCurve(fake, arcCurve(widest, o.bend), o.align ?? 'left');
    const apexX = o.x + (o.align === 'center' ? 0 : o.align === 'right' ? -widest / 2 : widest / 2);
    if (r.glyphs.length) return [[r.glyphs[0][0][0][0] + apexX, r.glyphs[0][0][0][1] + o.y], [r.glyphs[0][0][1][0] + apexX, r.glyphs[0][0][1][1] + o.y]];
  }
  return [[bottom[0] + o.x, bottom[1] + o.y], [top[0] + o.x, top[1] + o.y]];
}
