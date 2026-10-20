import type { Relief } from './relief';
import type { CncData } from './cnc';
import type { FillMode } from './fill';
// The document model. Everything is millimetres, Y up (like the machine, not like a screen).
export type Pt = [number, number];

/** cut and score follow the outline (score is just meant for a light pass); engrave fills the inside with lines;
 * tool (LightBurn's T1 / T2) is never burned: its shapes only mark an area, and the job's start point is measured from the outermost shapes. */
export type LayerMode = 'cut' | 'engrave' | 'score' | 'tool';

export interface Layer {
  name: string;
  color: string; // #rrggbb
  mode: LayerMode;
  speed: number; // mm/s
  /** Maximum power, percent. */
  power: number;
  /** Minimum power, percent (0 to power). Ruida runs a line between the two as the head speeds up and slows down; GRBL ignores it. */
  minPower: number;
  passes: number;
  /** Show on screen. Separate from Output, as in LightBurn: a hidden layer still burns when Output is on. */
  visible: boolean;
  /** Include this layer in the job. */
  output: boolean;
  /** Air assist on while this layer burns (M8). */
  air: boolean;
  /** Engrave only: distance between fill lines, mm. */
  interval: number;
  /** Engrave only: which shapes are filled together (LightBurn's three choices), or let the program pick the quickest. */
  fillMode: FillMode;
  /** Engrave only: how far the head runs past each fill line so it is at full speed inside the shape, mm. */
  overscan: number;
}

export interface Machine {
  name: string;
  /** Usable area, mm. Used to warn when a job is too big. */
  width: number;
  height: number;
  /** The controller's maximum spindle/laser value ($30 in GRBL). Power % is turned into S0..sMax. */
  sMax: number;
  /** Rapid travel speed, mm/s, for the time estimate. */
  rapid: number;
  /** Where the page's 0,0 is for the rulers and the Y box: the top-left (most Ruida lasers) or the bottom-left. Default top-left. */
  origin?: 'tl' | 'bl';
}

/**
 * The size of the job before anything is drawn, so a design cannot quietly be too big for the machine or the stock.
 *  laser: the machine's work area, with 0,0 at its bottom-left.
 *  cnc:   the stock (material) size and thickness, with 0,0 at `datum` of the stock (as in VCarve's Job Setup).
 *  canvas: a page of a given size for a design that is not for a machine (drawn like a laser bed, 0,0 bottom left, no machine output).
 *  free:  no limit (a drawing that is not for one machine yet).
 */
export interface Workspace {
  kind: 'laser' | 'cnc' | 'canvas' | 'free';
  width: number;
  height: number;
  thickness: number;
  datum: import('./geom').Anchor;
  /** Where Z0 is: the top of the material or the machine bed. CNC only. */
  zZero: 'surface' | 'bed';
  /** CNC: cut from one side or both (the job is flipped to cut the second). Kept with the job; the toolpaths do not use it yet. */
  sides?: 1 | 2;
}

export const FREE_WORKSPACE: Workspace = { kind: 'free', width: 300, height: 180, thickness: 0, datum: 'bl', zZero: 'surface' };

/** Machines to start from. Edit the size in the setup dialog, or save your own. */
export const LASER_PRESETS: Machine[] = [
  { name: '3018 + laser head', width: 300, height: 180, sMax: 1000, rapid: 50 },
  { name: 'Small diode laser', width: 400, height: 400, sMax: 1000, rapid: 100 },
  { name: 'CO2 laser 600 x 400', width: 600, height: 400, sMax: 1000, rapid: 200 },
  { name: 'CO2 laser 1000 x 600 (Ruida)', width: 1000, height: 600, sMax: 1000, rapid: 300 },
];

export const MACHINE_3018_LASER: Machine = { name: '3018 + laser head', width: 300, height: 180, sMax: 1000, rapid: 50 };

/** One or more rings. A closed shape with several rings is filled even-odd, so a ring inside another is a hole. */
export interface PathShape {
  id: number;
  kind: 'path';
  layer: string;
  rings: Pt[][];
  closed: boolean;
  /** Shapes with the same group number move and are picked together */
  group?: number;
}

export interface CircleShape {
  id: number;
  kind: 'circle';
  layer: string;
  cx: number;
  cy: number;
  r: number;
  group?: number;
}

export type Shape = PathShape | CircleShape;

/** What a piece of text was made from, so it can be edited again. Its letters are the shapes whose `group` is `group`. */
export interface TextRecord {
  group: number;
  text: string;
  font: string;
  /** Capital-letter height, mm */
  height: number;
  align: 'left' | 'center' | 'right';
  spacing: number;
  lineSpacing: number;
  weld: boolean;
  /** Text bent into an arch (positive) or a smile (negative): the angle, degrees, the whole line turns through. 0 or absent: straight */
  bend?: number;
  /** Where the first baseline started when it was laid out, and the box the letters filled then (to follow the text when it is moved or resized) */
  x: number;
  y: number;
  box: { minX: number; minY: number; maxX: number; maxY: number };
  /** How many shapes it came out as (if the number changes, the letters have been edited by hand) */
  count: number;
  /** Set when the text runs along a line or outline: a copy of that curve, how far along it starts, and which side */
  curve?: { pts: Pt[]; closed: boolean; offset: number; flip: boolean };
}

export interface Doc {
  /** Pieces of text that can still be edited (see TextRecord) */
  texts?: TextRecord[];
  /** CNC tools and toolpaths; absent until the first one is made */
  cnc?: CncData;
  /** 3D shapes to carve (height grids, from an STL file) */
  reliefs?: Relief[];
  layers: Layer[];
  shapes: Shape[];
  nextId: number;
  machine: Machine;
  workspace: Workspace;
}

export const LAYER_COLORS = ['#000000', '#2bb5c9', '#d8503c', '#6aa84f', '#b07cd8', '#e8e8e8', '#e07aa0', '#7aa0e8'];

export function newLayer(name: string, index: number): Layer {
  return { name, color: LAYER_COLORS[index % LAYER_COLORS.length], mode: 'cut', speed: 10, power: 60, minPower: 60, passes: 1, visible: true, output: true, air: false, interval: 0.1, fillMode: 'all', overscan: 1 };
}

export function emptyDoc(): Doc {
  return { layers: [newLayer('Layer 1', 0)], shapes: [], nextId: 1, machine: { ...MACHINE_3018_LASER }, workspace: { ...FREE_WORKSPACE } };
}

/** A shape before it has been given an id (Omit does not distribute over a union, so spell it out). */
export type NewShape = Omit<PathShape, 'id'> | Omit<CircleShape, 'id'>;

/** The area the job may use, as a box in drawing coordinates, or null when there is no limit. */
export function workRect(ws: Workspace): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (ws.kind === 'free') return null;
  const datum = ws.kind === 'laser' || ws.kind === 'canvas' ? 'bl' : ws.datum;
  const x = datum.endsWith('l') ? 0 : datum.endsWith('r') ? -ws.width : -ws.width / 2;
  const y = datum.startsWith('b') ? 0 : datum.startsWith('t') ? -ws.height : -ws.height / 2;
  return { minX: x, minY: y, maxX: x + ws.width, maxY: y + ws.height };
}
