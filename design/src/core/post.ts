/**
 * Post processors: how moves become G-code. A post is a text file in the same simple layout many CAM programs use
 * (VAR lines say how numbers are written, "begin BLOCK" lines start the templates). Two ship with the app; your own
 * .pp files can be loaded. Numbers are millimetres.
 */

import { BRANDED_POSTS } from './brandedPosts';

export interface PostVar { prefix: string; always: boolean; decimals: number }

export interface PostDef {
  name: string;
  extension: string;
  lineEnding: string;
  /** keyed by the token name used in templates: N S F X Y Z I J XH YH ZH */
  vars: Record<string, PostVar>;
  blocks: Record<string, string[]>;
}

export class PostError extends Error {}

const BLOCKS = ['HEADER', 'FOOTER', 'RAPID_MOVE', 'FIRST_FEED_MOVE', 'FEED_MOVE', 'DWELL_MOVE'];

/** Read a post processor file. Unknown settings are ignored; a missing basic block is an error. */
export function parsePost(text: string): PostDef {
  const def: PostDef = { name: '', extension: 'gcode', lineEnding: '\n', vars: {}, blocks: {} };
  let block: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('+')) continue;
    const begin = /^begin\s+([A-Z_]+)/i.exec(line);
    if (begin) { block = begin[1].toUpperCase(); def.blocks[block] = def.blocks[block] ?? []; continue; }
    if (block) {
      const q = /^"(.*)"\s*$/.exec(line);
      if (q) def.blocks[block].push(q[1]);
      continue;
    }
    const kv = /^([A-Z_]+)\s*=\s*"?([^"]*)"?\s*$/.exec(line);
    if (kv) {
      const [, k, v] = kv;
      if (k === 'POST_NAME') def.name = v.replace(/\s*\(\*\.[^)]*\)\s*$/, '').trim();
      else if (k === 'FILE_EXTENSION') def.extension = v.trim().replace(/^\./, '') || 'gcode';
      else if (k === 'LINE_ENDING') def.lineEnding = v.replace(/\[(\d+)\]/g, (_, n) => String.fromCharCode(Number(n)));
      else if (k === 'UNITS' && v.trim().toUpperCase() !== 'MM') throw new PostError('Only millimetre post processors can be used');
      continue;
    }
    const v = /^VAR\s+([A-Z_0-9]+)\s*=\s*\[([^\]]*)\]/i.exec(line);
    if (v) {
      const [code, mode, prefix, fmt] = v[2].split('|');
      if (code && fmt !== undefined) {
        const dec = Number((fmt.split('.')[1] ?? '0'));
        def.vars[code.trim()] = { prefix: prefix ?? '', always: (mode ?? 'A').trim().toUpperCase() === 'A', decimals: Number.isFinite(dec) ? dec : 3 };
      }
    }
  }
  if (!def.name) throw new PostError('The post processor has no POST_NAME');
  for (const b of ['HEADER', 'FOOTER', 'RAPID_MOVE', 'FEED_MOVE']) if (!def.blocks[b]) throw new PostError(`The post processor has no ${b} block`);
  if (!def.blocks.FIRST_FEED_MOVE) def.blocks.FIRST_FEED_MOVE = def.blocks.FEED_MOVE;
  for (const b of Object.keys(def.blocks)) if (!BLOCKS.includes(b) && !/ARC|TOOLCHANGE/.test(b)) { /* unused blocks are kept but never written */ }
  return def;
}

const GENERIC_VARS = `VAR SPINDLE_SPEED = [S|A|S|1.0]
VAR FEED_RATE = [F|C|F|1.1]
VAR X_POSITION = [X|C|X|1.3]
VAR Y_POSITION = [Y|C|Y|1.3]
VAR Z_POSITION = [Z|C|Z|1.3]
VAR X_HOME_POSITION = [XH|A|X|1.3]
VAR Y_HOME_POSITION = [YH|A|Y|1.3]
VAR Z_HOME_POSITION = [ZH|A|Z|1.3]`;

const MOVES = `begin RAPID_MOVE
  "G0[X][Y][Z]"
begin FIRST_FEED_MOVE
  "G1[X][Y][Z][F]"
begin FEED_MOVE
  "G1[X][Y][Z]"
begin DWELL_MOVE
  "G4 P[DWELL]"`;

/** Plain GRBL / Grbl-style output: spindle on, a short pause to reach speed, spindle off and home at the end. */
export const GRBL_POST = `+ Generic GRBL, millimetres
POST_NAME = "GRBL (mm) (*.gcode)"
FILE_EXTENSION = "gcode"
UNITS = "MM"
LINE_ENDING = "[10]"
${GENERIC_VARS}
begin HEADER
  "G17"
  "G21"
  "G90"
  "G0[ZH]"
  "G0[XH][YH]"
  "[S]M3"
  "G4 P3"
${MOVES}
begin FOOTER
  "M5"
  "G0[ZH]"
  "G0[XH][YH]"
  "M2"
`;

/** Same, with the vacuum (M7 / M9) switched on and off around the job. */
export const GRBL_VACUUM_POST = `+ GRBL with vacuum on M7 and off at the end
POST_NAME = "GRBL with vacuum (mm) (*.gcode)"
FILE_EXTENSION = "gcode"
UNITS = "MM"
LINE_ENDING = "[10]"
${GENERIC_VARS}
begin HEADER
  "M7"
  "G17"
  "G21"
  "G90"
  "G0[ZH]"
  "G0[XH][YH]"
  "[S]M3"
  "G4 P5"
${MOVES}
begin FOOTER
  "M5"
  "G0[ZH]"
  "G0[XH][YH]"
  "M9"
  "M2"
`;

export const BUILT_IN_POSTS: PostDef[] = [parsePost(GRBL_POST), parsePost(GRBL_VACUUM_POST), ...BRANDED_POSTS.map(parsePost)];

export interface Move3 {
  kind: 'rapid' | 'cut' | 'plunge';
  x: number;
  y: number;
  z: number;
}

export interface PostRun {
  rpm: number;
  feed: number;
  plunge: number;
  /** Where the machine goes at the start and the end */
  home: { x: number; y: number; z: number };
  /** Lines written first as comments (tool name etc.) */
  comments?: string[];
}

const fmt = (v: number, d: number) => (Math.abs(v) < 0.5 * 10 ** -d ? 0 : v).toFixed(d);

/** Write the moves as G-code with the post's templates. */
export function emitGcode(post: PostDef, moves: Move3[], run: PostRun): string {
  const out: string[] = [];
  const last: Record<string, string> = {};
  const word = (code: string, value: number | undefined, force = false): string => {
    if (value === undefined) return '';
    const v = post.vars[code] ?? { prefix: code, always: false, decimals: 3 };
    const text = fmt(value, v.decimals);
    if (!v.always && !force && last[code] === text) return '';
    last[code] = text;
    return v.prefix + text;
  };
  const line = (template: string, values: Record<string, number | undefined>, forceCoords = false) => {
    let had = 0, empty = 0;
    const s = template.replace(/\[([A-Z]+)\]/g, (_, code: string) => {
      if (!(code in values) && !['X', 'Y', 'Z', 'I', 'J', 'F', 'S', 'XH', 'YH', 'ZH'].includes(code)) return '';
      const isCoord = ['X', 'Y', 'Z', 'I', 'J'].includes(code);
      if (isCoord) had++;
      const w = word(code, values[code], forceCoords);
      if (isCoord && !w) empty++;
      return w;
    });
    if (had > 0 && empty === had) return; // nothing to move to
    const t = s.trimEnd();
    if (t) out.push(t);
  };
  for (const c of run.comments ?? []) out.push(`( ${c.replace(/[()]/g, '')} )`);
  const home = { XH: run.home.x, YH: run.home.y, ZH: run.home.z, S: run.rpm };
  for (const t of post.blocks.HEADER) line(t, home, true);
  let lastF = NaN;
  for (const m of moves) {
    const pos = { X: m.x, Y: m.y, Z: m.z };
    if (m.kind === 'rapid') { for (const t of post.blocks.RAPID_MOVE) line(t, pos); continue; }
    const f = m.kind === 'plunge' ? run.plunge : run.feed;
    const block = f !== lastF ? post.blocks.FIRST_FEED_MOVE : post.blocks.FEED_MOVE;
    for (const t of block) line(t, { ...pos, F: f });
    lastF = f;
  }
  for (const t of post.blocks.FOOTER) line(t, home, true);
  return out.join(post.lineEnding || '\n') + (post.lineEnding || '\n');
}
