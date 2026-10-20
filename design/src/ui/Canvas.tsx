import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { Doc, Pt, Shape } from '../core/types';
import type { Move } from '../core/laser';
import { isTyping } from './typing';
import { actionFor, specOf } from '../core/shortcuts';
import { bendForSag, bendSag } from '../core/text';
import { execute } from '../core/commands';
import { getBindings } from './shortcutStore';
import type { NodeRef } from '../core/nodes';
import { planTrim, type TrimPlan } from '../core/trim';
import { SNAP_LABEL, findSnap, selectionCenter, type SnapHit, type SnapKind } from '../core/snap';
import { fmt, measure as measureOf } from '../core/measure';
import { nudgeStep } from '../core/nudge';
import { buildShape, fromDrag, shapeValid, type ShapeSpec } from '../core/shapes';
import { anchorPoint, rectOrigin as rectCornerAt, distToShapeOutline, scaleAbout, shapeBounds, shapeClosed, shapeRings, transformShape, unionBounds, type Anchor, type Bounds, type Matrix } from '../core/geom';

export type Tool = 'select' | 'rect' | 'circle' | 'ellipse' | 'polygon' | 'star' | 'arc' | 'measure' | 'fillet' | 'path' | 'trim' | 'text' | 'nodes' | 'pan';

interface View {
  cx: number; // world point at the centre of the canvas
  cy: number;
  scale: number; // pixels per mm
}

type Handle = Exclude<Anchor, 'c'>;
const OPPOSITE: Record<Handle, Handle> = { tl: 'br', tc: 'bc', tr: 'bl', ml: 'mr', mr: 'ml', bl: 'tr', bc: 'tc', br: 'tl' };
const HANDLE_CURSOR: Record<Handle, string> = { tl: 'nwse-resize', br: 'nwse-resize', tr: 'nesw-resize', bl: 'nesw-resize', tc: 'ns-resize', bc: 'ns-resize', ml: 'ew-resize', mr: 'ew-resize' };
const HANDLES = Object.keys(OPPOSITE) as Handle[];
const HANDLE_SIZE = 8; // px, drawn; the grab area is a little bigger

type Drag =
  | { kind: 'pan'; x: number; y: number; right: boolean; moved: boolean }
  | { kind: 'move'; start: Pt; cur: Pt; ids: number[] }
  | { kind: 'scale'; handle: Handle; anchor: Pt; origin: Pt; cur: Pt; ids: number[]; uniform: boolean; free: boolean }
  | { kind: 'box'; start: Pt; cur: Pt; additive: boolean; nodes?: boolean }
  | { kind: 'node'; id: number; start: Pt; cur: Pt; nodes: NodeRef[] }
  | { kind: 'rect' | 'circle' | 'shape' | 'measure'; start: Pt; cur: Pt }
  | { kind: 'bend'; ids: number[]; start: Pt; cur: Pt; bend0: number; length: number; preview?: Pt[][][] };

interface Props {
  doc: Doc;
  selection: number[];
  setSelection: (ids: number[]) => void;
  tool: Tool;
  /** Points of the selected path picked with the Nodes tool */
  nodeSel: NodeRef[];
  setNodeSel: (n: NodeRef[]) => void;
  /** Corner rounding applied to rectangles as they are drawn (radius 0 = none) */
  rectCorner: { radius: number; style: string };
  /** Right-click in the Select or Nodes tool: where, in window pixels */
  onContext: (x: number, y: number) => void;
  /** The Text tool was clicked at this point of the drawing */
  onText: (p: Pt) => void;
  setTool: (t: Tool) => void;
  snap: boolean;
  /** Jump to the ends, middles, centres and crossings of existing shapes, with a marker */
  objectSnap: boolean;
  activeLayer: string;
  run: (id: string, args: unknown) => boolean;
  fitSignal: number;
  /** Moves of a laser job to draw over the shapes (which are then dimmed). */
  overlay?: Move[] | null;
  /** Fill of the work area (the CNC tab's material colour) */
  materialColor?: string | null;
  /** Shaded pictures of 3D shapes, drawn on the work area (the CNC tab) */
  reliefs?: { img: CanvasImageSource; x: number; y: number; width: number; height: number }[];
  /** Where the laser's head is, in the drawing's coordinates (laser mode only) */
  headMark?: Pt | null;
  /** With the Draw Circle panel open: the radius to put down where the drawing is clicked (a drag still sizes the circle by hand) */
  circleRadius?: number | null;
  /** With the Draw Rectangle panel open: the size and the point of the rectangle that a click on the drawing sets down */
  rectSpec?: { w: number; h: number; anchor: import('../core/geom').Anchor } | null;
  /** With the ellipse, polygon, star or arc card open: the shape that a click sets down (a drag still draws one by hand) */
  shapeSpec?: ShapeSpec | null;
  /** The measuring tool's two points (B is null until it is set), or null when there is no measurement; sent up so the card can show it */
  onMeasure?: (m: { a: Pt; b: Pt | null } | null) => void;
  /** Text being typed on the drawing: its letters, and the text cursor (two points) */
  liveText?: { shapes: Pt[][][]; caret: [Pt, Pt] | null } | null;
  /** One piece of editable text is picked: the curve handle goes on it (ids, the box it fills, its bend now, its width when straight) */
  textHandle?: { ids: number[]; box: Bounds; bend: number; length: number } | null;
  /** A double-click with the Select tool, at this point of the drawing */
  onDoubleClickAt?: (p: Pt) => void;
  /** Changes when the card's Clear button is pressed */
  clearSignal?: number;
  /** With the Fillet tool: the radius and style a click on a corner (or on the ends of two lines) rounds with */
  filletSpec?: { radius: number; style: string } | null;
  /** Whether the size readout while drawing a circle, polygon, star or arc says diameter (Ø) or radius (r) */
  sizeMode?: 'diameter' | 'radius';
  /** A shape was put down by a click at this point (the panel shows it) */
  onPlaced?: (p: Pt) => void;
  /** The job's work area (laser bed or CNC stock), drawn as the page. Null means no limit. */
  work?: Bounds | null;
  /** Left ruler counts down from the top edge of the page (a laser's home is top-left); otherwise up from the bottom (a CNC's). */
  rulerFromTop?: boolean;
  /** Where the laser job starts (the head, or work zero): drawn as a small green square, like LightBurn */
  originMark?: Pt | null;
  /** Laser view: layers with Output off are drawn faint */
  dimOff?: boolean;
  onCursor: (p: Pt | null, scale: number, step: number, snapLabel?: string) => void;
}

function drawSnapMarker(ctx: CanvasRenderingContext2D, x: number, y: number, kind: SnapKind, color: string, outline: string) {
  const r = 6;
  ctx.lineWidth = 2;
  ctx.strokeStyle = color;
  ctx.beginPath();
  if (kind === 'endpoint') ctx.rect(x - r, y - r, 2 * r, 2 * r);
  else if (kind === 'center') { ctx.arc(x, y, r, 0, Math.PI * 2); }
  else if (kind === 'midpoint') { ctx.moveTo(x, y - r); ctx.lineTo(x + r, y + r); ctx.lineTo(x - r, y + r); ctx.closePath(); }
  else { ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r); ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r); }
  ctx.stroke();
  ctx.font = '11px system-ui, sans-serif';
  const label = SNAP_LABEL[kind];
  ctx.lineWidth = 3;
  ctx.strokeStyle = outline;
  ctx.strokeText(label, x + r + 4, y - r - 2);
  ctx.fillStyle = color;
  ctx.fillText(label, x + r + 4, y - r - 2);
}

/** A grid step that keeps lines about 12 to 60 px apart at this zoom. */
export function gridStep(scale: number): number {
  for (const s of [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 25, 50, 100, 250, 500, 1000]) if (s * scale >= 12) return s;
  return 1000;
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** Thickness of the rulers along the four edges, px */
const RULER = 18;

/** Scale factors for a handle drag: the pointer position against where the handle started, about the opposite handle. */
function scaleFactors(d: Extract<Drag, { kind: 'scale' }>): [number, number] {
  const dx = d.origin[0] - d.anchor[0];
  const dy = d.origin[1] - d.anchor[1];
  const clamp = (f: number) => Math.max(0.01, f); // dragging past the other side stops at a sliver instead of flipping
  let fx = dx ? clamp((d.cur[0] - d.anchor[0]) / dx) : 1;
  let fy = dy ? clamp((d.cur[1] - d.anchor[1]) / dy) : 1;
  if (d.uniform && !d.free) {
    const f = dx && dy ? Math.max(fx, fy) : dx ? fx : fy;
    fx = fy = f;
  }
  return [fx, fy];
}

export function Canvas({ doc, selection, setSelection, onText, onContext, nodeSel, setNodeSel, rectCorner, tool, setTool, snap, objectSnap, activeLayer, run, fitSignal, overlay, materialColor, reliefs, headMark, circleRadius, rectSpec, shapeSpec, onMeasure, clearSignal, filletSpec, liveText, textHandle, onDoubleClickAt, sizeMode = 'diameter', onPlaced, work, rulerFromTop, originMark, dimOff, onCursor }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const view = useRef<View>({ cx: 50, cy: 30, scale: 5 });
  const drag = useRef<Drag | null>(null);
  const poly = useRef<Pt[]>([]);
  const hover = useRef<Pt | null>(null);
  // the Fillet tool: the corner or line end under the cursor, and the line end waiting for a second one
  const filletHover = useRef<{ pt: Pt; kind: 'corner' | 'end' } | null>(null);
  const filletPending = useRef<{ id: number; end: 'start' | 'end'; pt: Pt } | null>(null);
  // the measuring tool: A, B, and whether it is waiting for the second click
  const meas = useRef<{ a: Pt | null; b: Pt | null; waiting: boolean }>({ a: null, b: null, waiting: false });
  const setMeas = (a: Pt | null, b: Pt | null, waiting: boolean) => { meas.current = { a, b, waiting }; onMeasureRef.current?.(a ? { a, b } : null); };
  const onMeasureRef = useRef(onMeasure); onMeasureRef.current = onMeasure;
  const space = useRef(false);
  const hoverCursor = useRef<string | null>(null);
  const size = useRef({ w: 0, h: 0, dpr: 1 });
  const [, bump] = useReducer((n: number) => n + 1, 0);
  // Pictures of the parts of the drawing that are expensive to draw (the shapes, the laser job's path), reused while only the
  // selection or the cursor changes. A pan or zoom moves and scales the picture; it is drawn sharp again a moment after it stops.
  type Pic = { keys: unknown[]; canvas: HTMLCanvasElement; cx: number; cy: number; scale: number; w: number; h: number; dpr: number; colours: string };
  const shCache = useRef<Pic | null>(null);
  const ovCache = useRef<Pic | null>(null);
  const picRebuild = useRef(false);
  const picTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (picTimer.current) clearTimeout(picTimer.current); }, []);
  const drawPicture = (slot: { current: Pic | null }, keys: unknown[], colours: string, w: number, h: number, dpr: number, v: View, build: (g: CanvasRenderingContext2D) => void) => {
    if (w < 1 || h < 1) return; // not laid out yet
    const ctx = ref.current!.getContext('2d')!;
    let c = slot.current;
    const same = !!c && c.w === w && c.h === h && c.dpr === dpr && c.colours === colours && c.keys.length === keys.length && c.keys.every((k, i) => k === keys[i]);
    const exact = same && c!.cx === v.cx && c!.cy === v.cy && c!.scale === v.scale;
    if (!same || (!exact && picRebuild.current)) {
      const off = c && same ? c.canvas : document.createElement('canvas');
      off.width = Math.round(w * dpr); off.height = Math.round(h * dpr);
      const g = off.getContext('2d')!;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      build(g);
      c = { keys, canvas: off, cx: v.cx, cy: v.cy, scale: v.scale, w, h, dpr, colours };
      slot.current = c;
    }
    c = slot.current!;
    ctx.save();
    if (c.cx === v.cx && c.cy === v.cy && c.scale === v.scale) {
      ctx.drawImage(c.canvas, 0, 0, w, h);
    } else {
      const r = v.scale / c.scale;
      ctx.transform(r, 0, 0, r, w / 2 - r * (w / 2) + (c.cx - v.cx) * v.scale, h / 2 - r * (h / 2) - (c.cy - v.cy) * v.scale);
      ctx.drawImage(c.canvas, 0, 0, w, h);
      if (picTimer.current) clearTimeout(picTimer.current);
      picTimer.current = setTimeout(() => { picRebuild.current = true; bump(); }, 150);
    }
    ctx.restore();
  };

  // latest props for the event handlers, which are attached once
  useEffect(() => {
    (window as any).demonxDesignView = () => ({ ...view.current, ...size.current });
  }, []);

  const live = useRef({ doc, selection, tool, snap, objectSnap, activeLayer, work, nodeSel, rectCorner, circleRadius, rectSpec, shapeSpec, onMeasure, filletSpec, textHandle, onDoubleClickAt, onPlaced });
  live.current = { doc, selection, tool, snap, objectSnap, activeLayer, work, nodeSel, rectCorner, circleRadius, rectSpec, shapeSpec, onMeasure, filletSpec, textHandle, onDoubleClickAt, onPlaced };
  const snapHit = useRef<SnapHit | null>(null);
  /** The piece the Trim tool would cut away at the cursor */
  const trimPlan = useRef<TrimPlan | null>(null);

  const toWorld = (px: number, py: number): Pt => {
    const v = view.current;
    return [v.cx + (px - size.current.w / 2) / v.scale, v.cy - (py - size.current.h / 2) / v.scale];
  };
  const toScreen = (x: number, y: number): Pt => {
    const v = view.current;
    return [size.current.w / 2 + (x - v.cx) * v.scale, size.current.h / 2 - (y - v.cy) * v.scale];
  };
  const snapPt = (p: Pt): Pt => {
    if (!live.current.snap) return [round3(p[0]), round3(p[1])];
    const step = gridStep(view.current.scale);
    return [round3(Math.round(p[0] / step) * step), round3(Math.round(p[1] / step) * step)];
  };

  /** How close (in pixels) the cursor must be to a point of a shape to jump to it */
  const SNAP_PX = 10;
  const TRIM_PX = 8;
  /**
   * The point a click or drag lands on: an end, middle, centre or crossing of an existing shape when one is near the
   * cursor (and remembered for the marker), otherwise the grid. `exclude` keeps the shapes being moved from snapping to
   * themselves.
   */
  const snapAll = (raw: Pt, exclude?: Set<number>): Pt => {
    snapHit.current = null;
    const l = live.current;
    if (l.objectSnap) {
      const hit = findSnap(l.doc.shapes, raw, SNAP_PX / view.current.scale, { layers: l.doc.layers, exclude, selection: l.selection });
      if (hit) { snapHit.current = hit; return [round3(hit.pt[0]), round3(hit.pt[1])]; }
    }
    return snapPt(raw);
  };

  const selectionBox = (): Bounds | null => {
    const { doc, selection } = live.current;
    const set = new Set(selection);
    return unionBounds(doc.shapes.filter((s) => set.has(s.id)).map(shapeBounds));
  };
  const handleAt = (px: number, py: number): Handle | null => {
    if (live.current.tool !== 'select' || !live.current.selection.length) return null;
    const b = selectionBox();
    if (!b) return null;
    for (const h of HANDLES) {
      const [x, y] = anchorPoint(b, h);
      const [sx, sy] = toScreen(x, y);
      if (Math.abs(sx - px) <= HANDLE_SIZE && Math.abs(sy - py) <= HANDLE_SIZE) return h;
    }
    return null;
  };

  const fit = useCallback(() => {
    // the work area (the page) and anything drawn outside it, so nothing is hidden
    const b = unionBounds([...live.current.doc.shapes.map(shapeBounds), live.current.work ?? null]);
    const { w, h } = size.current;
    if (!b || !w) return;
    // a tool panel open over the drawing covers its right-hand side: fit into what is left, and leave room for the rulers
    const side = document.querySelector('aside.side');
    const mine = ref.current?.getBoundingClientRect();
    const covered = side && mine ? Math.max(0, Math.min(w * 0.5, mine.right - side.getBoundingClientRect().left)) : 0;
    const availW = Math.max(50, w - covered - 2 * RULER);
    const availH = Math.max(50, h - 2 * RULER);
    const bw = Math.max(b.maxX - b.minX, 1);
    const bh = Math.max(b.maxY - b.minY, 1);
    const scale = Math.min((availW * 0.94) / bw, (availH * 0.94) / bh, 200);
    view.current = { cx: (b.minX + b.maxX) / 2 + covered / 2 / scale, cy: (b.minY + b.maxY) / 2, scale };
    bump();
  }, []);

  useEffect(() => {
    if (fitSignal) fit();
  }, [fitSignal, fit]);

  /** The one selected path whose points the Nodes tool shows */
  const nodeShape = () => {
    const { doc, selection } = live.current;
    const sh = selection.length === 1 ? doc.shapes.find((x) => x.id === selection[0]) : undefined;
    return sh && sh.kind === 'path' ? sh : null;
  };
  const NODE_PX = 9;
  const nodeAt = (px: number, py: number): NodeRef | null => {
    const sh = nodeShape();
    if (!sh) return null;
    let best: NodeRef | null = null, bd = NODE_PX;
    sh.rings.forEach((r, ri) => r.forEach((p, i) => {
      const [sx, sy] = toScreen(p[0], p[1]);
      const dd = Math.hypot(sx - px, sy - py);
      if (dd <= bd) { bd = dd; best = { ring: ri, i }; }
    }));
    return best;
  };
  /** The segment of the selected path nearest the cursor, and the point on it */
  const segmentAt = (px: number, py: number): { ring: number; after: number; pt: Pt } | null => {
    const sh = nodeShape();
    if (!sh) return null;
    let best: { ring: number; after: number; pt: Pt } | null = null, bd = NODE_PX;
    sh.rings.forEach((r, ri) => {
      const n = sh.closed ? r.length : r.length - 1;
      for (let i = 0; i < n; i++) {
        const a = toScreen(r[i][0], r[i][1]), b = toScreen(r[(i + 1) % r.length][0], r[(i + 1) % r.length][1]);
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const l2 = dx * dx + dy * dy;
        const t = l2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / l2));
        const dd = Math.hypot(a[0] + t * dx - px, a[1] + t * dy - py);
        if (dd <= bd) { bd = dd; best = { ring: ri, after: i, pt: toWorld(a[0] + t * dx, a[1] + t * dy) }; }
      }
    });
    return best;
  };

  const onTextRef = useRef(onText);
  onTextRef.current = onText;
  const onContextRef = useRef(onContext);
  onContextRef.current = onContext;

  /** Everything that is grouped with these shapes joins the pick */
  const withGroups = (ids: number[]): number[] => {
    const shapes = live.current.doc.shapes;
    const groups = new Set(ids.map((id) => shapes.find((s) => s.id === id)?.group).filter((g): g is number => g !== undefined));
    if (!groups.size) return ids;
    return [...new Set([...ids, ...shapes.filter((s) => s.group !== undefined && groups.has(s.group)).map((s) => s.id)])];
  };

  /** The bend the curve handle is dragged to: how far it has been pulled up or down, turned into degrees for this text's width */
  const bendOf = (d: Extract<Drag, { kind: 'bend' }>): number => {
    const b = bendForSag(d.length, bendSag(d.length, d.bend0) + (d.cur[1] - d.start[1]));
    return Math.abs(b) < 1 ? 0 : Math.round(b * 10) / 10;
  };
  const handleAtScreen = (px: number, py: number): boolean => {
    const th = live.current.textHandle;
    if (!th) return false;
    const [hx, hy] = toScreen((th.box.minX + th.box.maxX) / 2, th.box.maxY);
    return Math.abs(px - hx) <= 10 && Math.abs(py - (hy - 22)) <= 10;
  };

  /** The corner or line end near a screen point: the shape under it and which point of it. Ends are only offered for a single open line. */
  const pickCorner = (px: number, py: number): { id: number; ring: number; i: number; kind: 'corner' | 'end'; end?: 'start' | 'end'; pt: Pt } | null => {
    const id = hitTest(toWorld(px, py));
    if (id === null) return null;
    const sh = live.current.doc.shapes.find((x) => x.id === id);
    if (!sh || sh.kind !== 'path') return null;
    let best: { ring: number; i: number; d: number } | null = null;
    sh.rings.forEach((r, ri) => r.forEach((q, i) => {
      const [sx, sy] = toScreen(q[0], q[1]);
      const d = Math.hypot(sx - px, sy - py);
      if (d <= 10 && (!best || d < best.d)) best = { ring: ri, i, d };
    }));
    if (!best) return null;
    const { ring, i } = best as { ring: number; i: number };
    const r = sh.rings[ring];
    const pt: Pt = [r[i][0], r[i][1]];
    const isEnd = !sh.closed && (i === 0 || i === r.length - 1);
    if (isEnd) return sh.rings.length === 1 ? { id, ring, i, kind: 'end', end: i === 0 ? 'start' : 'end', pt } : null;
    return r.length >= 3 ? { id, ring, i, kind: 'corner', pt } : null;
  };

  const hitTest = (p: Pt): number | null => {
    const { doc } = live.current;
    const tol = 6 / view.current.scale;
    const visible = new Set(doc.layers.filter((l) => l.visible).map((l) => l.name));
    // Shapes are only lines on screen (nothing is filled), so a shape is picked by its line, topmost first. The empty space inside
    // a shape is empty: a drag that starts there is a selection box, so shapes inside another shape can be boxed in or moved on their own.
    for (let i = doc.shapes.length - 1; i >= 0; i--) {
      const s = doc.shapes[i];
      if (visible.has(s.layer) && distToShapeOutline(p, s) <= tol) return s.id;
    }
    return null;
  };

  const finishPoly = (closed: boolean) => {
    const pts = poly.current;
    poly.current = [];
    bump();
    if (pts.length < (closed ? 3 : 2)) return;
    run('add_path', { points: pts, closed, layer: live.current.activeLayer });
  };

  // ---- drawing -----------------------------------------------------------------------------------------------
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const css = getComputedStyle(canvas);
    const col = (name: string) => css.getPropertyValue(name).trim() || '#888';
    const { w, h, dpr } = size.current;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = col('--canvas');
    ctx.fillRect(0, 0, w, h);

    const v = view.current;
    // the work area is the "page": lighter than the space around it
    if (work) {
      const [bx0, by0] = toScreen(work.minX, work.maxY);
      const [bx1, by1] = toScreen(work.maxX, work.minY);
      ctx.fillStyle = materialColor ?? col('--panel');
      ctx.fillRect(bx0, by0, bx1 - bx0, by1 - by0);
    }
    // 3D shapes, shaded, on the page
    for (const rp of reliefs ?? []) {
      const [rx0, ry0] = toScreen(rp.x, rp.y + rp.height);
      const [rx1, ry1] = toScreen(rp.x + rp.width, rp.y);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(rp.img, rx0, ry0, rx1 - rx0, ry1 - ry0);
    }
    // grid and axes are drawn on the page only: outside it is plain, so the page reads as the size of the job
    if (work) {
      const [cx0, cy0] = toScreen(work.minX, work.maxY);
      const [cx1, cy1] = toScreen(work.maxX, work.minY);
      ctx.save();
      ctx.beginPath(); ctx.rect(cx0, cy0, cx1 - cx0, cy1 - cy0); ctx.clip();
    }
    const step = gridStep(v.scale);
    const [wx0, wy1] = toWorld(0, 0);
    const [wx1, wy0] = toWorld(w, h);
    ctx.lineWidth = 1;
    if (snap) for (let i = Math.floor(wx0 / step); i <= Math.ceil(wx1 / step); i++) {
      const x = Math.round(toScreen(i * step, 0)[0]) + 0.5;
      ctx.strokeStyle = i % 10 === 0 ? col('--line') : col('--panel2');
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    if (snap) for (let j = Math.floor(wy0 / step); j <= Math.ceil(wy1 / step); j++) {
      const y = Math.round(toScreen(0, j * step)[1]) + 0.5;
      ctx.strokeStyle = j % 10 === 0 ? col('--line') : col('--panel2');
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
    // origin axes
    const [ox, oy] = toScreen(0, 0);
    ctx.strokeStyle = col('--muted');
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(ox, 0); ctx.lineTo(ox, h); ctx.moveTo(0, oy); ctx.lineTo(w, oy); ctx.stroke();
    if (work) ctx.restore();

    if (work) {
      const [bx0, by0] = toScreen(work.minX, work.maxY);
      const [bx1, by1] = toScreen(work.maxX, work.minY);
      ctx.strokeStyle = col('--accent');
      ctx.lineWidth = 2;
      ctx.strokeRect(bx0, by0, bx1 - bx0, by1 - by0);
      ctx.fillStyle = col('--accent');
      ctx.font = '12px ui-monospace, Menlo, Consolas, monospace';
      ctx.fillText(`${round3(work.maxX - work.minX)} × ${round3(work.maxY - work.minY)} mm`, bx0 + 6, by0 - 6);
    }

    const layerColor = new Map(doc.layers.map((l) => [l.name, l.color]));
    const luma = (hex: string) => { const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim()); if (!m) return 255; const v = parseInt(m[1], 16); return 0.299 * (v >> 16) + 0.587 * ((v >> 8) & 255) + 0.114 * (v & 255); };
    const darkCanvas = luma(col('--canvas')) < 110;
    const visible = new Set(doc.layers.filter((l) => l.visible).map((l) => l.name));
    const outputOff = new Set(dimOff ? doc.layers.filter((l) => !l.output).map((l) => l.name) : []);
    const sel = new Set(selection);
    // while dragging, the selected shapes are drawn as they would end up
    let preview: Matrix | null = null;
    const dr = drag.current;
    if (dr?.kind === 'move') preview = [1, 0, 0, 1, dr.cur[0] - dr.start[0], dr.cur[1] - dr.start[1]];
    else if (dr?.kind === 'scale') { const [fx, fy] = scaleFactors(dr); preview = scaleAbout(fx, fy, dr.anchor); }

    const trace = (s: Shape, g: CanvasRenderingContext2D = ctx) => {
      const shape = preview && sel.has(s.id) ? transformShape(s, preview) : s;
      g.beginPath();
      if (shape.kind === 'circle') {
        const [sx, sy] = toScreen(shape.cx, shape.cy);
        g.arc(sx, sy, shape.r * v.scale, 0, Math.PI * 2);
        return;
      }
      for (const ring of shapeRings(shape)) {
        ring.forEach(([x, y], i) => {
          const [sx, sy] = toScreen(x, y);
          if (i) g.lineTo(sx, sy);
          else g.moveTo(sx, sy);
        });
        if (shapeClosed(shape)) g.closePath();
      }
    };

    const shapeAlpha = overlay && overlay.length ? 0.3 : 1;
    const strokeShapes = (g: CanvasRenderingContext2D, withSelection: boolean) => {
      for (const s of doc.shapes) {
        if (!visible.has(s.layer)) continue;
        const color = layerColor.get(s.layer) ?? '#ccc';
        const faint = outputOff.has(s.layer) ? 0.35 : 1;
        g.globalAlpha = shapeAlpha * faint;
        trace(s, g);
        // shapes are only ever their line (no fill), as in the other design programs; a near-black line on the dark
        // drawing area would vanish, so it gets a pale halo
        if (darkCanvas && luma(color) < 60) {
          g.strokeStyle = 'rgba(255,255,255,0.6)';
          g.lineWidth = 3.5;
          g.stroke();
        }
        g.strokeStyle = color;
        g.lineWidth = 1.5;
        g.globalAlpha = shapeAlpha * faint;
        g.stroke();
        g.globalAlpha = 1;
        if (withSelection && sel.has(s.id)) {
          trace(s, g);
          g.strokeStyle = col('--text');
          g.lineWidth = 2.5;
          g.setLineDash([6, 4]);
          g.stroke();
          g.setLineDash([]);
        }
      }
    };
    if (preview) {
      strokeShapes(ctx, true);
    } else {
      // a big drawing (thousands of letters or traced pieces) is drawn once into a picture, which is reused while only the
      // selection or the cursor changes, and moved and scaled while the view is panned or zoomed
      drawPicture(shCache, [doc.shapes, doc.layers, shapeAlpha, dimOff, darkCanvas], col('--canvas') + [...layerColor].join('|'), w, h, dpr, v, (g) => strokeShapes(g, false));
      for (const s of doc.shapes) {
        if (!sel.has(s.id) || !visible.has(s.layer)) continue;
        trace(s);
        ctx.strokeStyle = col('--text');
        ctx.lineWidth = 2.5;
        ctx.setLineDash([6, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // the laser job's path: burning moves in the layer's colour, travel moves thin and grey. A big job has tens of thousands of
    // moves, so it is drawn once into a picture and that is reused while only the selection or the cursor changes; while the
    // view is being panned or zoomed the picture is moved and scaled, and drawn sharp again a moment after it stops.
    if (overlay && overlay.length) {
      const colours = [col('--muted'), ...[...layerColor].map(([n, c]) => n + c)].join('|');
      drawPicture(ovCache, [overlay], colours, w, h, dpr, v, (g) => {
        g.lineWidth = 1;
        g.strokeStyle = overlay.find((mv) => !mv.burn && mv.color)?.color ?? col('--muted');
        g.globalAlpha = 0.4;
        g.beginPath();
        for (const mv of overlay) {
          if (mv.burn) continue;
          const [ax, ay] = toScreen(mv.x0, mv.y0), [bx, by] = toScreen(mv.x1, mv.y1);
          g.moveTo(ax, ay); g.lineTo(bx, by);
        }
        g.stroke();
        g.globalAlpha = 1;
        g.lineWidth = 1.4;
        const byLayer = new Map<string, Move[]>();
        for (const mv of overlay) if (mv.burn) { const k = mv.color ?? mv.layer; (byLayer.get(k) ?? byLayer.set(k, []).get(k)!).push(mv); }
        for (const [name, list] of byLayer) {
          g.strokeStyle = name.startsWith('#') ? name : layerColor.get(name) ?? '#fff';
          g.beginPath();
          for (const mv of list) {
            const [ax, ay] = toScreen(mv.x0, mv.y0), [bx, by] = toScreen(mv.x1, mv.y1);
            g.moveTo(ax, ay); g.lineTo(bx, by);
          }
          g.stroke();
        }
      });
    }

    picRebuild.current = false;

    // where the laser's head is now
    if (headMark) {
      const [hx, hy] = toScreen(headMark[0], headMark[1]);
      ctx.save();
      ctx.strokeStyle = col('--danger'); ctx.fillStyle = col('--danger'); ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(hx, hy, 7, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(hx - 13, hy); ctx.lineTo(hx + 13, hy); ctx.moveTo(hx, hy - 13); ctx.lineTo(hx, hy + 13); ctx.stroke();
      ctx.beginPath(); ctx.arc(hx, hy, 2, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    // the box and square handles around the selection
    const box = !drag.current || drag.current.kind === 'pan' ? selectionBox() : null;
    if (box && tool === 'select') {
      const [x0, y0] = toScreen(box.minX, box.maxY);
      const [x1, y1] = toScreen(box.maxX, box.minY);
      ctx.strokeStyle = col('--cyan');
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      ctx.setLineDash([]);
      ctx.fillStyle = col('--bg');
      ctx.lineWidth = 1.5;
      for (const h of HANDLES) {
        const [wx, wy] = anchorPoint(box, h);
        const [sx, sy] = toScreen(wx, wy);
        ctx.fillRect(sx - HANDLE_SIZE / 2, sy - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
        ctx.strokeRect(sx - HANDLE_SIZE / 2, sy - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
      }
    }

    // the centre of the selection: the point to align by (it can be snapped to, too)
    if (selection.length && !(drag.current && (drag.current.kind === 'move' || drag.current.kind === 'scale'))) {
      const c = selectionCenter(doc.shapes.filter((s) => sel.has(s.id)));
      if (c) {
        const [cx, cy] = toScreen(c[0], c[1]);
        ctx.strokeStyle = col('--cyan');
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(cx - 6, cy); ctx.lineTo(cx + 6, cy); ctx.moveTo(cx, cy - 6); ctx.lineTo(cx, cy + 6);
        ctx.stroke();
        ctx.beginPath(); ctx.arc(cx, cy, 3.5, 0, Math.PI * 2); ctx.stroke();
      }
    }

    // rubber bands
    const d = drag.current;
    ctx.strokeStyle = col('--accent');
    ctx.fillStyle = col('--accent');
    ctx.lineWidth = 1.5;
    if (d && (d.kind === 'rect' || d.kind === 'box')) {
      const [ax, ay] = toScreen(d.start[0], d.start[1]);
      const [bx, by] = toScreen(d.cur[0], d.cur[1]);
      if (d.kind === 'box') {
        ctx.setLineDash([5, 4]);
        ctx.globalAlpha = 0.12; ctx.fillRect(ax, ay, bx - ax, by - ay); ctx.globalAlpha = 1;
      }
      ctx.strokeRect(ax, ay, bx - ax, by - ay);
      ctx.setLineDash([]);
    }
    if (d && d.kind === 'circle') {
      const [cx, cy] = toScreen(d.start[0], d.start[1]);
      const r = Math.hypot(d.cur[0] - d.start[0], d.cur[1] - d.start[1]) * v.scale;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    }
    // the ellipse, polygon, star or arc being dragged, or the one the card describes following the cursor
    if (shapeSpec && tool === shapeSpec.kind) {
      let sp: ShapeSpec | null = null, gx = 0, gy = 0;
      if (d && d.kind === 'shape') { const f = fromDrag(shapeSpec, d.start, d.cur); sp = f.spec; gx = f.cx; gy = f.cy; }
      else if (!d && hover.current) { sp = shapeSpec; gx = hover.current[0]; gy = hover.current[1]; }
      if (sp && shapeValid(sp)) {
        const { pts, closed } = buildShape(sp, gx, gy);
        ctx.save();
        ctx.strokeStyle = col('--accent'); ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]); ctx.globalAlpha = 0.9;
        ctx.beginPath();
        pts.forEach(([x, y], i) => { const [sx, sy] = toScreen(x, y); if (i) ctx.lineTo(sx, sy); else ctx.moveTo(sx, sy); });
        if (closed) ctx.closePath();
        ctx.stroke();
        ctx.restore();
      }
    }
    // the rectangle the panel describes, following the cursor
    if (tool === 'rect' && rectSpec && rectSpec.w > 0 && rectSpec.h > 0 && !d && hover.current) {
      const [gx, gy] = rectCornerAt(rectSpec, hover.current[0], hover.current[1]);
      const [ax, ay] = toScreen(gx, gy + rectSpec.h), [bx, by] = toScreen(gx + rectSpec.w, gy);
      ctx.save();
      ctx.strokeStyle = col('--accent'); ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]); ctx.globalAlpha = 0.9;
      ctx.strokeRect(ax, ay, bx - ax, by - ay);
      ctx.restore();
    }
    // the circle the panel describes, following the cursor
    if (tool === 'circle' && circleRadius && circleRadius > 0 && !d && hover.current) {
      const [gx, gy] = toScreen(hover.current[0], hover.current[1]);
      ctx.save();
      ctx.strokeStyle = col('--accent'); ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]); ctx.globalAlpha = 0.9;
      ctx.beginPath(); ctx.arc(gx, gy, circleRadius * v.scale, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }
    if (poly.current.length) {
      const pts = [...poly.current, ...(hover.current ? [hover.current] : [])];
      ctx.beginPath();
      pts.forEach(([x, y], i) => {
        const [sx, sy] = toScreen(x, y);
        if (i) ctx.lineTo(sx, sy);
        else ctx.moveTo(sx, sy);
      });
      ctx.stroke();
      for (const [x, y] of poly.current) {
        const [sx, sy] = toScreen(x, y);
        ctx.beginPath(); ctx.arc(sx, sy, 3, 0, Math.PI * 2); ctx.fill();
      }
      if (poly.current.length >= 3) {
        const [fx, fy] = toScreen(poly.current[0][0], poly.current[0][1]);
        ctx.beginPath(); ctx.arc(fx, fy, 8, 0, Math.PI * 2); ctx.stroke();
      }
    }
    // Trim: the piece that would be cut away, and where the outline is crossed
    if (tool === 'trim' && trimPlan.current) {
      const plan = trimPlan.current;
      ctx.strokeStyle = col('--amber');
      ctx.lineWidth = 1.5;
      for (const c of plan.cuts) {
        const [cx, cy] = toScreen(c[0], c[1]);
        ctx.beginPath(); ctx.arc(cx, cy, 3.5, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.strokeStyle = col('--danger');
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.beginPath();
      plan.remove.forEach(([x, y], i) => { const [sx, sy] = toScreen(x, y); if (i) ctx.lineTo(sx, sy); else ctx.moveTo(sx, sy); });
      ctx.stroke();
      ctx.lineCap = 'butt';
    }

    // Nodes: the points of the selected path, the ones picked, and the move in progress
    if (tool === 'nodes') {
      const sh = nodeShape();
      if (sh) {
        const dn = d && d.kind === 'node' ? d : null;
        const picked = new Set(nodeSel.map((n) => `${n.ring}:${n.i}`));
        const off: Pt = dn ? [dn.cur[0] - dn.start[0], dn.cur[1] - dn.start[1]] : [0, 0];
        if (dn) {
          ctx.strokeStyle = col('--amber');
          ctx.lineWidth = 1.5;
          ctx.setLineDash([5, 4]);
          for (const r of sh.rings) {
            ctx.beginPath();
            r.forEach((p, i) => { const mv = picked.has(`${sh.rings.indexOf(r)}:${i}`); const [sx, sy] = toScreen(p[0] + (mv ? off[0] : 0), p[1] + (mv ? off[1] : 0)); if (i) ctx.lineTo(sx, sy); else ctx.moveTo(sx, sy); });
            if (sh.closed) ctx.closePath();
            ctx.stroke();
          }
          ctx.setLineDash([]);
        }
        sh.rings.forEach((r, ri) => r.forEach((p, i) => {
          const on = picked.has(`${ri}:${i}`);
          const [sx, sy] = toScreen(p[0] + (dn && on ? off[0] : 0), p[1] + (dn && on ? off[1] : 0));
          ctx.fillStyle = on ? col('--amber') : col('--bg');
          ctx.strokeStyle = on ? col('--amber') : col('--cyan');
          ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.rect(sx - 3.5, sy - 3.5, 7, 7); ctx.fill(); ctx.stroke();
          if (i === 0) { ctx.beginPath(); ctx.arc(sx, sy, 7, 0, Math.PI * 2); ctx.stroke(); } // the first point is ringed: that is where the outline starts
        }));
      }
    }

    // what the cursor is about to land on
    const hit = snapHit.current;
    const drawing = tool === 'rect' || tool === 'circle' || tool === 'path' || tool === 'ellipse' || tool === 'polygon' || tool === 'star' || tool === 'arc' || tool === 'measure';
    if (hit && (d ? d.kind !== 'pan' && d.kind !== 'box' : drawing)) {
      const [mx, my] = toScreen(hit.pt[0], hit.pt[1]);
      drawSnapMarker(ctx, mx, my, hit.kind, col('--amber'), col('--bg'));
    }

    // text being typed: the letters as they will be, and the blinking cursor
    if (liveText) {
      ctx.save();
      ctx.strokeStyle = col('--accent'); ctx.fillStyle = col('--accent'); ctx.lineWidth = 1.5;
      for (const rings of liveText.shapes) {
        ctx.beginPath();
        for (const r of rings) { r.forEach(([x, y], i) => { const [sx, sy] = toScreen(x, y); if (i) ctx.lineTo(sx, sy); else ctx.moveTo(sx, sy); }); ctx.closePath(); }
        ctx.globalAlpha = 0.18; ctx.fill('evenodd'); ctx.globalAlpha = 1; ctx.stroke();
      }
      if (liveText.caret && Date.now() % 1000 < 620) {
        const [a1x, a1y] = toScreen(liveText.caret[0][0], liveText.caret[0][1]), [b1x, b1y] = toScreen(liveText.caret[1][0], liveText.caret[1][1]);
        ctx.strokeStyle = col('--text'); ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(a1x, a1y); ctx.lineTo(b1x, b1y); ctx.stroke();
      }
      ctx.restore();
    }
    // the curve handle of a picked piece of text (and the bent text while it is dragged)
    if (textHandle && tool === 'select') {
      const dd = drag.current;
      ctx.save();
      if (dd && dd.kind === 'bend' && dd.preview) {
        ctx.strokeStyle = col('--accent'); ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]);
        for (const rings of dd.preview) { ctx.beginPath(); for (const r of rings) { r.forEach(([x, y], i) => { const [sx, sy] = toScreen(x, y); if (i) ctx.lineTo(sx, sy); else ctx.moveTo(sx, sy); }); ctx.closePath(); } ctx.stroke(); }
        ctx.setLineDash([]);
      }
      const [hx, hy] = toScreen((textHandle.box.minX + textHandle.box.maxX) / 2, textHandle.box.maxY);
      ctx.fillStyle = col('--bg'); ctx.strokeStyle = col('--amber'); ctx.lineWidth = 2;
      ctx.fillRect(hx - 7, hy - 29, 14, 14); ctx.strokeRect(hx - 7, hy - 29, 14, 14);
      ctx.beginPath(); ctx.arc(hx, hy - 20, 4, Math.PI, 2 * Math.PI); ctx.stroke();
      ctx.font = '11px ui-monospace, Menlo, Consolas, monospace'; ctx.fillStyle = col('--amber');
      ctx.fillText(dd && dd.kind === 'bend' ? `curve ${Math.round(bendOf(dd) * 10) / 10}°` : 'curve', hx + 12, hy - 18);
      ctx.restore();
    }
    // the Fillet tool: the corner or line end it would pick, and the line end already picked
    if (tool === 'fillet') {
      ctx.save();
      const mark = (pt: Pt, color: string, filled: boolean) => {
        const [mx, my] = toScreen(pt[0], pt[1]);
        ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(mx, my, 7, 0, Math.PI * 2);
        if (filled) { ctx.globalAlpha = 0.35; ctx.fill(); ctx.globalAlpha = 1; }
        ctx.stroke();
      };
      const h = filletHover.current;
      if (h) mark(h.pt, h.kind === 'corner' ? col('--accent') : col('--amber'), false);
      if (filletPending.current) mark(filletPending.current.pt, col('--amber'), true);
      ctx.restore();
    }
    // the measuring tool: a line from A to B (or to the cursor) with its length, the steps across and up, and the angle
    if (tool === 'measure') {
      const m = meas.current;
      const end: Pt | null = m.b ?? (d && d.kind === 'measure' ? d.cur : m.waiting ? hover.current : null);
      if (m.a) {
        const [ax, ay] = toScreen(m.a[0], m.a[1]);
        ctx.save();
        ctx.strokeStyle = col('--amber'); ctx.fillStyle = col('--amber'); ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(ax, ay, 4, 0, Math.PI * 2); ctx.fill();
        if (end) {
          const [bx, by] = toScreen(end[0], end[1]);
          ctx.setLineDash([6, 4]);
          ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
          ctx.setLineDash([]);
          ctx.beginPath(); ctx.arc(bx, by, 4, 0, Math.PI * 2); ctx.fill();
          // the right-angle steps, faint
          ctx.globalAlpha = 0.35; ctx.setLineDash([2, 3]);
          ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, ay); ctx.lineTo(bx, by); ctx.stroke();
          ctx.restore(); ctx.save();
          const r = measureOf(m.a, end, rulerFromTop);
          const l1 = `${fmt(r.distance, 2)} mm`, l2 = `ΔX ${fmt(r.dx, 2)}  ΔY ${fmt(r.dy, 2)}  ∠ ${fmt(r.angle, 1)}°`;
          ctx.font = '12px ui-monospace, Menlo, Consolas, monospace';
          const w = Math.max(ctx.measureText(l1).width, ctx.measureText(l2).width) + 12;
          const lx = Math.min(Math.max((ax + bx) / 2 + 10, 4), size.current.w - w - 4), ly = Math.min(Math.max((ay + by) / 2 - 12, 20), size.current.h - 40);
          ctx.fillStyle = col('--bg'); ctx.globalAlpha = 0.85; ctx.fillRect(lx - 4, ly - 14, w, 34);
          ctx.globalAlpha = 1; ctx.fillStyle = col('--amber'); ctx.fillText(l1, lx, ly); ctx.fillStyle = col('--text'); ctx.fillText(l2, lx, ly + 15);
        }
        ctx.restore();
      }
    }
    // size readout while dragging a new shape
    if (d && d.kind === 'shape' && shapeSpec) {
      const f = fromDrag(shapeSpec, d.start, d.cur).spec;
      const label = f.kind === 'ellipse' ? `${f.w} × ${f.h} mm` : f.kind === 'polygon' || f.kind === 'star' || f.kind === 'arc' ? (sizeMode === 'diameter' ? `Ø ${round3(f.r * 2)} mm` : `r ${f.r} mm`) : '';
      const [lx, ly] = toScreen(d.cur[0], d.cur[1]);
      ctx.font = '12px ui-monospace, Menlo, Consolas, monospace';
      ctx.fillStyle = col('--text');
      ctx.fillText(label, lx + 12, ly - 8);
    }
    if (d && (d.kind === 'rect' || d.kind === 'circle')) {
      const label = d.kind === 'rect'
        ? `${round3(Math.abs(d.cur[0] - d.start[0]))} × ${round3(Math.abs(d.cur[1] - d.start[1]))} mm`
        : (() => { const rr = Math.hypot(d.cur[0] - d.start[0], d.cur[1] - d.start[1]); return sizeMode === 'diameter' ? `Ø ${round3(rr * 2)} mm` : `r ${round3(rr)} mm`; })();
      const [lx, ly] = toScreen(d.cur[0], d.cur[1]);
      ctx.font = '12px ui-monospace, Menlo, Consolas, monospace';
      ctx.fillStyle = col('--text');
      ctx.fillText(label, lx + 12, ly - 8);
    }

    // where the laser job starts: a small green square, which does not move when a layer's Output is switched off
    if (originMark) {
      const [mx, my] = toScreen(originMark[0], originMark[1]);
      ctx.fillStyle = '#3fbf5f';
      ctx.fillRect(mx - 4, my - 4, 8, 8);
      ctx.strokeStyle = col('--bg');
      ctx.lineWidth = 1;
      ctx.strokeRect(mx - 4.5, my - 4.5, 9, 9);
    }

    // rulers along all four edges, in millimetres of the drawing
    {
      const majors = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
      const major = majors.find((m) => m * v.scale >= 70) ?? 5000;
      const minor = major / 5;
      ctx.save();
      ctx.fillStyle = col('--panel2');
      ctx.fillRect(0, 0, w, RULER); ctx.fillRect(0, h - RULER, w, RULER);
      ctx.fillRect(0, 0, RULER, h); ctx.fillRect(w - RULER, 0, RULER, h);
      ctx.strokeStyle = col('--line');
      ctx.lineWidth = 1;
      ctx.strokeRect(RULER + 0.5, RULER + 0.5, w - 2 * RULER - 1, h - 2 * RULER - 1);
      ctx.fillStyle = col('--muted');
      ctx.strokeStyle = col('--muted');
      ctx.font = '10px ui-monospace, Menlo, Consolas, monospace';
      ctx.textBaseline = 'middle';
      const num = (x: number) => String(Number(x.toFixed(3)));
      ctx.beginPath();
      for (let i = Math.floor(wx0 / minor); i <= Math.ceil(wx1 / minor); i++) {
        const sx = Math.round(toScreen(i * minor, 0)[0]) + 0.5;
        if (sx < RULER || sx > w - RULER) continue;
        const t = i % 5 === 0 ? 9 : 4;
        ctx.moveTo(sx, RULER); ctx.lineTo(sx, RULER - t);
        ctx.moveTo(sx, h - RULER); ctx.lineTo(sx, h - RULER + t);
      }
      // the left ruler: from the bottom edge up, or (laser) from the top edge down
      const yTop = work ? work.maxY : 0;
      const yAt = (j: number, step: number) => (rulerFromTop ? yTop - j * step : j * step);
      const yRange = (step: number): [number, number] => (rulerFromTop ? [Math.floor((yTop - wy1) / step), Math.ceil((yTop - wy0) / step)] : [Math.floor(wy0 / step), Math.ceil(wy1 / step)]);
      {
        const [j0, j1] = yRange(minor);
        for (let j = j0; j <= j1; j++) {
          const sy = Math.round(toScreen(0, yAt(j, minor))[1]) + 0.5;
          if (sy < RULER || sy > h - RULER) continue;
          const t = j % 5 === 0 ? 9 : 4;
          ctx.moveTo(RULER, sy); ctx.lineTo(RULER - t, sy);
          ctx.moveTo(w - RULER, sy); ctx.lineTo(w - RULER + t, sy);
        }
      }
      ctx.stroke();
      for (let i = Math.ceil(wx0 / major); i <= Math.floor(wx1 / major); i++) {
        const sx = toScreen(i * major, 0)[0];
        if (sx < RULER + 14 || sx > w - RULER - 14) continue;
        const label = num(i * major);
        ctx.textAlign = 'left';
        ctx.fillText(label, sx + 3, RULER / 2 - 2);
        ctx.fillText(label, sx + 3, h - RULER / 2 + 2);
      }
      {
        const [j0, j1] = yRange(major);
        for (let j = j0; j <= j1; j++) {
          const sy = toScreen(0, yAt(j, major))[1];
          if (sy < RULER + 14 || sy > h - RULER - 14) continue;
          const label = num(j * major);
          ctx.textAlign = 'left';
          for (const x of [RULER / 2 - 2, w - RULER / 2 + 2]) {
            ctx.save(); ctx.translate(x, sy - 3); ctx.rotate(-Math.PI / 2); ctx.fillText(label, 0, 0); ctx.restore();
          }
        }
      }
      // the cursor
      if (hover.current) {
        const [cx, cy] = toScreen(hover.current[0], hover.current[1]);
        ctx.strokeStyle = col('--accent');
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        if (cx > RULER && cx < w - RULER) { ctx.moveTo(cx, 0); ctx.lineTo(cx, RULER); ctx.moveTo(cx, h - RULER); ctx.lineTo(cx, h); }
        if (cy > RULER && cy < h - RULER) { ctx.moveTo(0, cy); ctx.lineTo(RULER, cy); ctx.moveTo(w - RULER, cy); ctx.lineTo(w, cy); }
        ctx.stroke();
      }
      ctx.restore();
    }
  });

  // ---- sizing, wheel and keys (attached once) ----------------------------------------------------------------
  useEffect(() => {
    const canvas = ref.current!;
    const resize = () => {
      const r = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const first = size.current.w === 0;
      size.current = { w: r.width, h: r.height, dpr };
      canvas.width = Math.max(1, Math.round(r.width * dpr));
      canvas.height = Math.max(1, Math.round(r.height * dpr));
      if (first) fit();
      bump();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    // repaint when the theme or a colour changes (the page sets those as an attribute and style variables)
    const mo = new MutationObserver(() => bump());
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] });

    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      const before = toWorld(px, py);
      const factor = Math.exp(-e.deltaY * 0.0015);
      view.current.scale = Math.min(2000, Math.max(0.2, view.current.scale * factor));
      const after = toWorld(px, py);
      view.current.cx += before[0] - after[0];
      view.current.cy += before[1] - after[1];
      bump();
    };
    canvas.addEventListener('wheel', wheel, { passive: false });

    const keydown = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      if (e.code === 'Space') { space.current = true; e.preventDefault(); return; }
      // the keys the owner may have changed (Settings, keyboard shortcuts); Copy, Paste, Undo and the file keys live in the app so the buttons and keys share one path
      const act = actionFor(specOf(e), getBindings());
      if (act === 'edit.selectAll') { e.preventDefault(); setSelection(live.current.doc.shapes.map((s) => s.id)); return; }
      if (e.ctrlKey || e.metaKey) {
        if (act?.startsWith('tool.')) { e.preventDefault(); setTool(act.slice(5) as Tool); }
        else if (act === 'view.fit') { e.preventDefault(); fit(); }
        return;
      }
      if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') && live.current.selection.length && !drag.current && live.current.tool !== 'nodes') {
        // arrow keys nudge the selection; the step follows the zoom (about 3 screen pixels), Shift is ten times that, Alt a tenth
        e.preventDefault();
        const step = nudgeStep(view.current.scale) * (e.shiftKey ? 10 : e.altKey ? 0.1 : 1);
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowDown' ? -step : e.key === 'ArrowUp' ? step : 0;
        run('move', { ids: live.current.selection, dx: round3(dx), dy: round3(dy) });
        return;
      }
      if (act?.startsWith('tool.')) { setTool(act.slice(5) as Tool); return; }
      if (act === 'view.fit') { fit(); return; }
      if (act === 'edit.delete') {
        if (live.current.tool === 'nodes' && live.current.nodeSel.length) {
          if (run('nodes_delete', { id: live.current.selection[0], nodes: live.current.nodeSel })) setNodeSel([]);
        } else if (live.current.selection.length) run('delete', { ids: live.current.selection });
        return;
      }
      switch (e.key) {
        case 'Escape':
          drag.current = null; poly.current = [];
          if (live.current.tool === 'measure') { setMeas(null, null, false); bump(); break; }
          if (live.current.tool === 'fillet') { filletPending.current = null; bump(); break; }
          if (live.current.tool === 'nodes' && live.current.nodeSel.length) setNodeSel([]); else setSelection([]);
          bump(); break;
        case 'Enter': if (poly.current.length) finishPoly(false); break;
      }
    };
    const keyup = (e: KeyboardEvent) => { if (e.code === 'Space') space.current = false; };
    window.addEventListener('keydown', keydown);
    window.addEventListener('keyup', keyup);
    return () => {
      ro.disconnect();
      mo.disconnect();
      canvas.removeEventListener('wheel', wheel);
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('keyup', keyup);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { if (clearSignal !== undefined && meas.current.a) { setMeas(null, null, false); bump(); } }, [clearSignal]);

  // the text cursor blinks
  useEffect(() => { if (!liveText) return; const t = setInterval(() => bump(), 300); return () => clearInterval(t); }, [!!liveText]);

  // changing tool abandons a half-drawn polygon
  useEffect(() => {
    if (tool !== 'path') poly.current = [];
    if (tool !== 'measure' && meas.current.a) setMeas(null, null, false);
    if (tool !== 'fillet') { filletPending.current = null; filletHover.current = null; }
    drag.current = null;
    bump();
  }, [tool]);

  // ---- pointer -----------------------------------------------------------------------------------------------
  const local = (e: React.PointerEvent | React.MouseEvent): [number, number] => {
    const r = ref.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const [px, py] = local(e);
    const { w: cw, h: ch } = size.current;
    if (px < RULER || py < RULER || px > cw - RULER || py > ch - RULER) { if (e.button === 1 || e.button === 2) e.preventDefault(); return; } // the rulers
    ref.current!.setPointerCapture(e.pointerId);
    const t = live.current.tool;
    if (e.button === 1 || e.button === 2 || t === 'pan' || space.current) {
      drag.current = { kind: 'pan', x: px, y: py, right: e.button === 2, moved: false };
      return;
    }
    if (e.button !== 0) return;
    const raw = toWorld(px, py);
    if (t === 'trim') {
      run('trim', { x: raw[0], y: raw[1], tol: TRIM_PX / view.current.scale });
      trimPlan.current = null;
      bump();
      return;
    }
    if (t === 'text') { onTextRef.current(snapAll(raw)); return; }
    if (t === 'fillet') {
      const spec = live.current.filletSpec;
      const hit = pickCorner(px, py);
      if (!spec || !hit) { filletPending.current = null; bump(); return; }
      if (hit.kind === 'corner') {
        filletPending.current = null;
        run('fillet', { ids: [hit.id], radius: spec.radius, style: spec.style, nodes: [{ ring: hit.ring, i: hit.i }] });
      } else {
        const pend = filletPending.current;
        if (!pend) filletPending.current = { id: hit.id, end: hit.end!, pt: hit.pt };
        else if (pend.id === hit.id) filletPending.current = null;   // the same line again: start over
        else {
          filletPending.current = null;
          run('fillet_lines', { ids: [pend.id, hit.id], ends: [pend.end, hit.end], radius: spec.radius, style: spec.style });
        }
      }
      bump();
      return;
    }
    if (t === 'measure') {
      const q = snapAll(raw);
      const m = meas.current;
      if (m.a && !m.b && m.waiting) { setMeas(m.a, q, false); }   // the second click of click, click
      else { setMeas(q, null, false); drag.current = { kind: 'measure', start: q, cur: q }; }
      bump();
      return;
    }
    if (t === 'nodes') {
      const hitNode = nodeAt(px, py);
      const sh = nodeShape();
      if (hitNode && sh) {
        const cur = live.current.nodeSel;
        const has = cur.some((n) => n.ring === hitNode.ring && n.i === hitNode.i);
        let next = cur;
        if (e.shiftKey || e.ctrlKey || e.metaKey) next = has ? cur.filter((n) => !(n.ring === hitNode.ring && n.i === hitNode.i)) : [...cur, hitNode];
        else if (!has) next = [hitNode];
        setNodeSel(next);
        if (next.some((n) => n.ring === hitNode.ring && n.i === hitNode.i)) {
          const at = sh.rings[hitNode.ring][hitNode.i];
          drag.current = { kind: 'node', id: sh.id, start: [at[0], at[1]], cur: [at[0], at[1]], nodes: next };
        }
      } else {
        const hit = hitTest(raw);
        if (hit !== null && !(sh && sh.id === hit)) { setSelection([hit]); setNodeSel([]); }
        else drag.current = { kind: 'box', start: raw, cur: raw, additive: e.shiftKey || e.ctrlKey || e.metaKey, nodes: true };
      }
      bump();
      return;
    }
    if (t === 'select' && handleAtScreen(px, py)) {
      const th = live.current.textHandle!;
      drag.current = { kind: 'bend', ids: th.ids, start: raw, cur: raw, bend0: th.bend, length: th.length };
      bump();
      return;
    }
    const p = t === 'select' ? snapPt(raw) : snapAll(raw);
    if (t === 'select') {
      const grabbed = handleAt(px, py);
      if (grabbed) {
        const b = selectionBox()!;
        const sel = live.current.selection;
        const allCircles = live.current.doc.shapes.filter((s) => sel.includes(s.id)).every((s) => s.kind === 'circle');
        const isCorner = grabbed === 'tl' || grabbed === 'tr' || grabbed === 'bl' || grabbed === 'br';
        drag.current = { kind: 'scale', handle: grabbed, anchor: anchorPoint(b, OPPOSITE[grabbed]), origin: anchorPoint(b, grabbed), cur: anchorPoint(b, grabbed), ids: sel, uniform: allCircles || isCorner, free: e.shiftKey };
        bump();
        return;
      }
      const sel = live.current.selection;
      let hit = hitTest(raw);
      if (hit === null && sel.length) {
        // the centre mark of the selection is a handle: hold the shapes by it to move them by their centre
        const sb = selectionBox();
        if (sb) { const [cx, cy] = toScreen((sb.minX + sb.maxX) / 2, (sb.minY + sb.maxY) / 2); if (Math.hypot(cx - px, cy - py) <= 10) hit = sel[0]; }
      }
      if (hit !== null) {
        let next = sel;
        const members = withGroups([hit]);
        if (e.shiftKey || e.ctrlKey || e.metaKey) next = sel.includes(hit) ? sel.filter((id) => !members.includes(id)) : [...new Set([...sel, ...members])];
        else if (!sel.includes(hit)) next = members;
        setSelection(next);
        if (next.includes(hit)) {
          // Hold the shapes by one of their own points when the cursor is on one (a corner or the centre), so that exact
          // point can be put on another shape's corner or centre.
          let ref = p;
          if (live.current.objectSnap) {
            const own = findSnap(live.current.doc.shapes, raw, SNAP_PX / view.current.scale, { layers: live.current.doc.layers, only: new Set(next), selection: next });
            if (own) ref = [round3(own.pt[0]), round3(own.pt[1])];
          }
          drag.current = { kind: 'move', start: ref, cur: ref, ids: next };
        }
      } else {
        drag.current = { kind: 'box', start: raw, cur: raw, additive: e.shiftKey || e.ctrlKey || e.metaKey };
      }
    } else if (t === 'rect' || t === 'circle') {
      drag.current = { kind: t, start: p, cur: p };
    } else if ((t === 'ellipse' || t === 'polygon' || t === 'star' || t === 'arc') && live.current.shapeSpec) {
      drag.current = { kind: 'shape', start: p, cur: p };
    } else if (t === 'path') {
      const pts = poly.current;
      if (pts.length >= 3) {
        const [fx, fy] = toScreen(pts[0][0], pts[0][1]);
        if (Math.hypot(fx - px, fy - py) < 10) { finishPoly(true); return; }
      }
      if (!pts.length || pts[pts.length - 1][0] !== p[0] || pts[pts.length - 1][1] !== p[1]) pts.push(p);
    }
    bump();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const [px, py] = local(e);
    const raw = toWorld(px, py);
    const d = drag.current;
    // while drawing or dragging the cursor jumps to points of existing shapes (never to the shapes being moved themselves)
    const wantsPoints = d ? d.kind !== 'pan' && d.kind !== 'box' : live.current.tool !== 'select' && live.current.tool !== 'pan' && live.current.tool !== 'trim' && live.current.tool !== 'nodes' && live.current.tool !== 'fillet';
    if (live.current.tool === 'fillet' && !d) {
      const h = pickCorner(px, py);
      filletHover.current = h ? { pt: h.pt, kind: h.kind } : null;
    } else filletHover.current = null;
    if (live.current.tool === 'trim' && !d) {
      const r = planTrim(live.current.doc.shapes, live.current.doc.layers, raw, TRIM_PX / view.current.scale);
      trimPlan.current = r.ok ? r.plan : null;
    } else trimPlan.current = null;
    let p: Pt;
    if (wantsPoints) p = snapAll(raw, d && (d.kind === 'move' || d.kind === 'scale') ? new Set(d.ids) : d && d.kind === 'node' ? new Set([d.id]) : undefined);
    else { snapHit.current = null; p = snapPt(raw); }
    hover.current = p;
    onCursor(p, view.current.scale, live.current.snap ? gridStep(view.current.scale) : 0, snapHit.current ? SNAP_LABEL[snapHit.current.kind] : undefined);
    if (!d) {
      const h = handleAt(px, py);
      hoverCursor.current = h ? HANDLE_CURSOR[h] : null;
    }
    if (d?.kind === 'pan') {
      if (Math.hypot(px - d.x, py - d.y) > 3) d.moved = true;
      if (d.moved || !d.right) {
        view.current.cx -= (px - d.x) / view.current.scale;
        view.current.cy += (py - d.y) / view.current.scale;
        d.x = px; d.y = py;
      }
    } else if (d?.kind === 'scale') {
      d.cur = p;
      d.free = e.shiftKey;
    } else if (d?.kind === 'bend') {
      d.cur = raw;
      const b = bendOf(d);
      try {
        const r = execute(live.current.doc, 'edit_text', { ids: d.ids, bend: b });
        d.preview = r.doc.shapes.filter((x) => r.ids?.includes(x.id)).map((x) => (x.kind === 'path' ? x.rings : []));
      } catch { d.preview = undefined; }
    } else if (d?.kind === 'box') {
      d.cur = raw;
    } else if (d) {
      d.cur = p;
    }
    bump();
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (ref.current?.hasPointerCapture(e.pointerId)) ref.current.releasePointerCapture(e.pointerId);
    if (!d) return;
    if (d.kind === 'bend') {
      const b = bendOf(d);
      if (Math.abs(b - d.bend0) >= 0.05) run('edit_text', { ids: d.ids, bend: b });
      bump();
      return;
    }
    if (d.kind === 'measure') {
      // a drag measures at once; a plain click sets A and waits for B
      if (Math.hypot(d.cur[0] - d.start[0], d.cur[1] - d.start[1]) * view.current.scale < 4) setMeas(d.start, null, true);
      else setMeas(d.start, d.cur, false);
      bump();
      return;
    }
    if (d.kind === 'pan') {
      // A right-click (no drag) ends the current tool and goes back to Select, like LightBurn.
      if (d.right && !d.moved && (live.current.tool === 'select' || live.current.tool === 'nodes')) {
        const [qx, qy] = local(e);
        const under = hitTest(toWorld(qx, qy));
        if (under !== null && !live.current.selection.includes(under)) setSelection(live.current.tool === 'nodes' ? [under] : withGroups([under]));
        onContextRef.current(e.clientX, e.clientY);
      } else if (d.right && !d.moved && live.current.tool !== 'select') {
        if (live.current.tool === 'path' && poly.current.length >= 2) finishPoly(false);
        poly.current = [];
        setTool('select');
      }
    } else if (d.kind === 'scale') {
      const [fx, fy] = scaleFactors(d);
      if (Math.abs(fx - 1) > 1e-9 || Math.abs(fy - 1) > 1e-9) run('scale', { ids: d.ids, sx: Math.round(fx * 1e6) / 1e6, sy: Math.round(fy * 1e6) / 1e6, about: d.anchor });
    } else if (d.kind === 'move') {
      const dx = round3(d.cur[0] - d.start[0]);
      const dy = round3(d.cur[1] - d.start[1]);
      if (dx || dy) run('move', { ids: d.ids, dx, dy });
    } else if (d.kind === 'rect') {
      const w = round3(d.cur[0] - d.start[0]);
      const h = round3(d.cur[1] - d.start[1]);
      const fixed = live.current.rectSpec;
      if (fixed && fixed.w > 0 && fixed.h > 0 && Math.hypot(w, h) * view.current.scale < 4) {
        // a click, not a drag: the rectangle the panel describes goes down here, the chosen point of it on the click
        const [rx, ry] = rectCornerAt(fixed, d.start[0], d.start[1]);
        if (run('add_rect', { x: rx, y: ry, w: fixed.w, h: fixed.h, layer: live.current.activeLayer, ...(live.current.rectCorner.radius > 0 ? { radius: live.current.rectCorner.radius, style: live.current.rectCorner.style } : {}) })) live.current.onPlaced?.([d.start[0], d.start[1]]);
      } else if (w && h) run('add_rect', { x: d.start[0], y: d.start[1], w, h, layer: live.current.activeLayer, ...(live.current.rectCorner.radius > 0 ? { radius: live.current.rectCorner.radius, style: live.current.rectCorner.style } : {}) });
    } else if (d.kind === 'shape') {
      const base = live.current.shapeSpec;
      if (base) {
        const f = fromDrag(base, d.start, d.cur);
        const moved = Math.hypot(d.cur[0] - d.start[0], d.cur[1] - d.start[1]) * view.current.scale;
        // a click puts the card's shape here; a drag draws one by hand (an ellipse in the box, the others out from the centre)
        const spec = moved < 4 ? base : f.spec;
        const [cx, cy] = moved < 4 ? d.start : [f.cx, f.cy];
        if (shapeValid(spec)) {
          const { pts, closed } = buildShape(spec, cx, cy);
          if (run('add_path', { points: pts.map((q) => [round3(q[0]), round3(q[1])]), closed, layer: live.current.activeLayer }) && moved < 4) live.current.onPlaced?.([d.start[0], d.start[1]]);
        }
      }
    } else if (d.kind === 'circle') {
      const r = round3(Math.hypot(d.cur[0] - d.start[0], d.cur[1] - d.start[1]));
      const fixed = live.current.circleRadius;
      if (fixed && fixed > 0 && r * view.current.scale < 4) {
        // a click, not a drag: the circle the panel describes goes down here (and again at every further click)
        if (run('add_circle', { cx: d.start[0], cy: d.start[1], r: fixed, layer: live.current.activeLayer })) live.current.onPlaced?.([d.start[0], d.start[1]]);
      } else if (r > 0) run('add_circle', { cx: d.start[0], cy: d.start[1], r, layer: live.current.activeLayer });
    } else if (d.kind === 'node') {
      const dx = round3(d.cur[0] - d.start[0]);
      const dy = round3(d.cur[1] - d.start[1]);
      if (dx || dy) run('nodes_move', { id: d.id, nodes: d.nodes, dx, dy });
    } else if (d.kind === 'box' && d.nodes) {
      const sh = nodeShape();
      const x0 = Math.min(d.start[0], d.cur[0]), x1 = Math.max(d.start[0], d.cur[0]), y0 = Math.min(d.start[1], d.cur[1]), y1 = Math.max(d.start[1], d.cur[1]);
      const tiny = (x1 - x0) * view.current.scale < 4 && (y1 - y0) * view.current.scale < 4;
      if (tiny) { if (!d.additive) { setNodeSel([]); if (!sh) setSelection([]); } }
      else if (sh) {
        const inside: NodeRef[] = [];
        sh.rings.forEach((r, ri) => r.forEach((p, i) => { if (p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1) inside.push({ ring: ri, i }); }));
        const keep = d.additive ? live.current.nodeSel.filter((n) => !inside.some((m) => m.ring === n.ring && m.i === n.i)) : [];
        setNodeSel([...keep, ...inside]);
      }
    } else if (d.kind === 'box') {
      const box: Bounds = { minX: Math.min(d.start[0], d.cur[0]), maxX: Math.max(d.start[0], d.cur[0]), minY: Math.min(d.start[1], d.cur[1]), maxY: Math.max(d.start[1], d.cur[1]) };
      const tiny = (box.maxX - box.minX) * view.current.scale < 4 && (box.maxY - box.minY) * view.current.scale < 4;
      if (tiny) {
        // a click in empty space clears the selection (a shape is only picked by its line or by a box drawn round it)
        if (!d.additive) setSelection([]);
      } else {
        const visible = new Set(live.current.doc.layers.filter((l) => l.visible).map((l) => l.name));
        const inside = live.current.doc.shapes
          .filter((s) => {
            const b = shapeBounds(s);
            return visible.has(s.layer) && b && b.minX >= box.minX && b.maxX <= box.maxX && b.minY >= box.minY && b.maxY <= box.maxY;
          })
          .map((s) => s.id);
        setSelection(withGroups(d.additive ? [...new Set([...live.current.selection, ...inside])] : inside));
      }
    }
    bump();
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    if (live.current.tool === 'select' && live.current.onDoubleClickAt) {
      const r0 = ref.current!.getBoundingClientRect();
      live.current.onDoubleClickAt(toWorld(e.clientX - r0.left, e.clientY - r0.top));
      return;
    }
    if (live.current.tool === 'nodes') {
      const r = ref.current!.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      const sh = nodeShape();
      if (!sh || nodeAt(px, py)) return;
      const seg = segmentAt(px, py);
      if (seg && run('node_insert', { id: sh.id, ring: seg.ring, after: seg.after, x: round3(seg.pt[0]), y: round3(seg.pt[1]) })) setNodeSel([{ ring: seg.ring, i: seg.after + 1 }]);
      return;
    }
    if (live.current.tool !== 'path' || !poly.current.length) return;
    // the two clicks of the double-click each added a point at the same spot
    const pts = poly.current;
    if (pts.length > 1) {
      const a = pts[pts.length - 1], b = pts[pts.length - 2];
      if (a[0] === b[0] && a[1] === b[1]) pts.pop();
    }
    finishPoly(false);
  };

  const cursor = hoverCursor.current ?? (tool === 'pan' ? 'grab' : tool === 'select' ? 'default' : 'crosshair');
  return (
    <canvas
      ref={ref}
      className="design-canvas"
      style={{ cursor }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => { hover.current = null; filletHover.current = null; snapHit.current = null; trimPlan.current = null; hoverCursor.current = null; onCursor(null, view.current.scale, 0); bump(); }}
      onDoubleClick={onDoubleClick}
      onContextMenu={(e) => e.preventDefault()}
      aria-label="Drawing area"
    />
  );
}
