// Panel layout for the browser UI: which panels exist, where they sit on a 12-column
// grid, which are hidden or collapsed, and the presets. Pure data and functions, so it
// can be tested without a browser; the UI (web/src/Dock.tsx) only draws it.

export type PanelId =
  | 'connection' | 'position' | 'jog' | 'visualizer' | 'camera' | 'job' | 'probe' | 'autolevel' | 'overrides' | 'macros' | 'spindle' | 'pcb' | 'console';

export const PANEL_IDS: PanelId[] = [
  'connection', 'position', 'jog', 'visualizer', 'camera', 'job', 'probe', 'autolevel', 'overrides', 'macros', 'spindle', 'pcb', 'console',
];

export const PANEL_TITLES: Record<PanelId, string> = {
  connection: 'Connection', position: 'Position', jog: 'Jog', visualizer: 'Visualizer', camera: 'Camera', job: 'Job',
  probe: 'Probe', autolevel: 'Autolevel', overrides: 'Overrides', macros: 'Macros', spindle: 'Spindle', pcb: 'PCB mode', console: 'Console',
};

export const COLS = 12;
/** A collapsed panel shows just its title bar */
export const COLLAPSED_H = 2;
const MAX_H = 120;

/** Smallest a panel can be resized to (grid columns / rows) */
export const MIN_SIZE: Record<PanelId, { w: number; h: number }> = {
  connection: { w: 2, h: 4 }, position: { w: 3, h: 6 }, jog: { w: 3, h: 8 }, visualizer: { w: 3, h: 8 }, camera: { w: 3, h: 6 },
  job: { w: 3, h: 6 }, probe: { w: 3, h: 4 }, autolevel: { w: 3, h: 6 }, overrides: { w: 3, h: 4 }, macros: { w: 2, h: 4 }, spindle: { w: 3, h: 8 }, pcb: { w: 3, h: 6 }, console: { w: 3, h: 4 },
};

export interface Item { i: PanelId; x: number; y: number; w: number; h: number }
export type PresetId = 'all' | 'run' | 'setup';

/** An arrangement of panels, without the lock (which belongs to the browser, not to a layout) */
export interface Arrangement {
  items: Item[];
  hidden: PanelId[];
  /** Height a collapsed panel had before it was collapsed, so expanding restores it */
  collapsed: Partial<Record<PanelId, number>>;
}

export interface LayoutState extends Arrangement {
  /** Locked: no dragging or resizing (guards against accidental drags on a touchscreen) */
  locked: boolean;
  /** 'mine' is the saved personal layout, 'custom' is anything arranged by hand since */
  preset: PresetId | 'mine' | 'custom';
  /** The layout saved on purpose with "Save as My layout" */
  mine?: Arrangement;
  /** What the layout was just before a preset replaced it, so a preset click can be undone */
  previous?: Arrangement;
}

const item = (i: PanelId, x: number, y: number, w: number, h: number): Item => ({ i, x, y, w, h });

export const PRESETS: Record<PresetId, { label: string; hint: string; items: Item[]; hidden: PanelId[] }> = {
  all: {
    label: 'All panels', hint: 'Everything, controls on the left, visualizer in the middle',
    hidden: [],
    items: [
      item('connection', 0, 0, 3, 7), item('position', 0, 7, 3, 15), item('jog', 0, 22, 3, 20), item('overrides', 0, 42, 3, 8), item('macros', 0, 50, 3, 8),
      item('visualizer', 3, 0, 6, 24), item('console', 3, 24, 6, 13), item('camera', 3, 37, 6, 16),
      item('job', 9, 0, 3, 21), item('probe', 9, 21, 3, 9), item('autolevel', 9, 30, 3, 30), item('spindle', 9, 60, 3, 13), item('pcb', 9, 73, 3, 14),
    ],
  },
  run: {
    label: 'Run', hint: 'Big visualizer with position and job, for watching a cut',
    hidden: ['jog', 'probe', 'autolevel', 'macros', 'pcb'],
    items: [
      item('position', 0, 0, 3, 15), item('overrides', 0, 15, 3, 8), item('connection', 0, 23, 3, 7), item('camera', 0, 30, 3, 13),
      item('visualizer', 3, 0, 6, 28), item('console', 3, 28, 6, 10),
      item('job', 9, 0, 3, 21),
      item('spindle', 0, 43, 3, 13), item('jog', 0, 56, 3, 20), item('probe', 9, 40, 3, 9), item('autolevel', 9, 50, 3, 30), item('macros', 0, 76, 3, 8), item('pcb', 0, 84, 3, 14),
    ],
  },
  setup: {
    label: 'Setup', hint: 'Jog, probe and autolevel, for setting up a job',
    hidden: ['overrides', 'camera'],
    items: [
      item('connection', 0, 0, 3, 7), item('position', 0, 7, 3, 15), item('jog', 0, 22, 3, 20),
      item('visualizer', 3, 0, 5, 18), item('probe', 3, 18, 5, 9), item('console', 3, 27, 5, 12),
      item('job', 8, 0, 4, 21), item('autolevel', 8, 21, 4, 30), item('spindle', 8, 51, 4, 13), item('pcb', 8, 64, 4, 14),
      item('overrides', 0, 43, 3, 8), item('macros', 3, 39, 5, 8), item('camera', 3, 47, 5, 14),
    ],
  },
};

export const presetState = (id: PresetId, locked = false): LayoutState => ({
  items: PRESETS[id].items.map((x) => ({ ...x })),
  hidden: [...PRESETS[id].hidden],
  collapsed: {},
  locked,
  preset: id,
});

const isId = (v: unknown): v is PanelId => typeof v === 'string' && (PANEL_IDS as string[]).includes(v);
const int = (v: unknown, lo: number, hi: number): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : undefined;

/**
 * Turn whatever was saved in the browser into a valid layout. Anything damaged,
 * from an older version or hand-edited, is repaired or replaced by the default
 * rather than breaking the page.
 */
export function sanitize(raw: unknown): LayoutState {
  const base = presetState('all');
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Record<string, unknown>;

  const items: Item[] = [];
  const seen = new Set<PanelId>();
  const mentioned = new Set<PanelId>(); // in the save, even if its numbers were unusable
  for (const it of Array.isArray(r.items) ? r.items : []) {
    const o = it as Record<string, unknown>;
    if (isId(o?.i)) mentioned.add(o.i);
    if (!isId(o?.i) || seen.has(o.i)) continue;
    const min = MIN_SIZE[o.i];
    const w = int(o.w, min.w, COLS), h = int(o.h, COLLAPSED_H, MAX_H), x = int(o.x, 0, COLS - 1), y = int(o.y, 0, 10_000);
    if (w === undefined || h === undefined || x === undefined || y === undefined || x + w > COLS) continue;
    seen.add(o.i);
    items.push({ i: o.i, x, y, w, h });
  }
  // A damaged entry goes back where the default puts it. A panel that is not in the save at all was added
  // by a newer version: put it at the bottom, so it cannot land on top of the layout someone arranged.
  let bottom = items.reduce((m, x) => Math.max(m, x.y + x.h), 0);
  for (const d of base.items) {
    if (seen.has(d.i)) continue;
    if (mentioned.has(d.i)) items.push(d);
    else { items.push({ ...d, x: 0, y: bottom }); bottom += d.h; }
  }

  const hidden = (Array.isArray(r.hidden) ? r.hidden : []).filter(isId).filter((v, k, a) => a.indexOf(v) === k);
  const collapsed: LayoutState['collapsed'] = {};
  if (r.collapsed && typeof r.collapsed === 'object') {
    for (const [k, v] of Object.entries(r.collapsed as Record<string, unknown>)) {
      const h = int(v, COLLAPSED_H + 1, MAX_H);
      if (isId(k) && h !== undefined) collapsed[k] = h;
    }
  }
  // a collapsed panel is always drawn at the collapsed height
  for (const it of items) if (collapsed[it.i] !== undefined) it.h = COLLAPSED_H;

  const preset = r.preset === 'all' || r.preset === 'run' || r.preset === 'setup' || r.preset === 'mine' ? r.preset : 'custom';
  const out: LayoutState = { items, hidden, collapsed, locked: r.locked === true, preset };
  const mine = nested(r.mine), previous = nested(r.previous);
  if (mine) out.mine = mine;
  if (previous) out.previous = previous;
  if (out.preset === 'mine' && !out.mine) out.preset = 'custom';
  return out;
}

/** A saved arrangement inside the saved layout: repaired the same way, or dropped if it is not an object at all. */
function nested(raw: unknown): Arrangement | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const { items, hidden, collapsed } = sanitize({ ...(raw as object), mine: undefined, previous: undefined });
  return { items, hidden, collapsed };
}

export const visibleIds = (s: LayoutState): PanelId[] => PANEL_IDS.filter((id) => !s.hidden.includes(id));

/** Visible panels in reading order (top to bottom, then left to right): the order used when the screen is too narrow for a grid. */
export function stackOrder(s: LayoutState): PanelId[] {
  const pos = new Map(s.items.map((x) => [x.i, x]));
  return visibleIds(s).sort((a, b) => (pos.get(a)!.y - pos.get(b)!.y) || (pos.get(a)!.x - pos.get(b)!.x));
}

export function toggleHidden(s: LayoutState, id: PanelId): LayoutState {
  const hidden = s.hidden.includes(id) ? s.hidden.filter((h) => h !== id) : [...s.hidden, id];
  return { ...s, hidden, preset: 'custom' };
}

const arrangement = (s: Arrangement): Arrangement => ({
  items: s.items.map((x) => ({ ...x })), hidden: [...s.hidden], collapsed: { ...s.collapsed },
});

/**
 * Switch to a preset. If the layout in front of the user was arranged by hand (not a pristine
 * preset), keep it so the click can be undone; the saved "My layout" is never touched.
 */
export function applyPreset(s: LayoutState, id: PresetId): LayoutState {
  const handMade = s.preset === 'custom' || s.preset === 'mine';
  const next = presetState(id, s.locked);
  if (s.mine) next.mine = s.mine;
  next.previous = handMade ? arrangement(s) : s.previous;
  return next;
}

/** Save the arrangement as "My layout", the one a preset click can always come back to. */
export const saveMine = (s: LayoutState): LayoutState => ({ ...s, mine: arrangement(s), preset: 'mine' });

/** Go to the saved "My layout" (keeps the current one for undo if it was arranged by hand). */
export function applyMine(s: LayoutState): LayoutState {
  if (!s.mine) return s;
  const handMade = s.preset === 'custom';
  return { ...s, ...arrangement(s.mine), preset: 'mine', previous: handMade ? arrangement(s) : s.previous };
}

/** Undo the last preset (or My layout) switch. */
export function undoPreset(s: LayoutState): LayoutState {
  if (!s.previous) return s;
  const { previous, ...rest } = s;
  void previous;
  return { ...rest, ...arrangement(s.previous), preset: 'custom' };
}

export function toggleCollapsed(s: LayoutState, id: PanelId): LayoutState {
  const collapsed = { ...s.collapsed };
  const items = s.items.map((it) => {
    if (it.i !== id) return it;
    if (collapsed[id] !== undefined) { const h = collapsed[id]!; delete collapsed[id]; return { ...it, h }; }
    collapsed[id] = it.h;
    return { ...it, h: COLLAPSED_H };
  });
  return { ...s, items, collapsed, preset: 'custom' };
}

/**
 * Take the positions the grid reports after a drag, resize or compaction and merge them
 * back, leaving hidden panels where they were. Collapsed panels stay at title height.
 */
export function applyGridChange(s: LayoutState, reported: Item[]): LayoutState {
  const byId = new Map(reported.map((x) => [x.i, x]));
  let changed = false;
  const items = s.items.map((it) => {
    const g = byId.get(it.i);
    if (!g) return it;
    const h = s.collapsed[it.i] !== undefined ? COLLAPSED_H : g.h;
    const next = { i: it.i, x: g.x, y: g.y, w: g.w, h };
    if (next.x !== it.x || next.y !== it.y || next.w !== it.w || next.h !== it.h) changed = true;
    return next;
  });
  return changed ? { ...s, items, preset: 'custom' } : s;
}

export const setLocked = (s: LayoutState, locked: boolean): LayoutState => ({ ...s, locked });
