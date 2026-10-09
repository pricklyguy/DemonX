import { createContext, useContext, useEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import GridLayout, { WidthProvider, type Layout } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import {
  COLS, MIN_SIZE, PANEL_IDS, PANEL_TITLES, PRESETS, applyGridChange, applyMine, applyPreset, presetState, sanitize, saveMine,
  setLocked, stackOrder, toggleCollapsed, toggleHidden, undoPreset, visibleIds, type Item, type LayoutState, type PanelId, type PresetId,
} from '../../shared/layout';

const Grid = WidthProvider(GridLayout);
const STORAGE_KEY = 'demonx.layout.v1';
/** Below this width there is no room for a grid: panels stack in one column */
const NARROW_PX = 720;
const ROW_HEIGHT = 18;
const GAP = 6;

interface Ctx {
  state: LayoutState;
  narrow: boolean;
  /** Merge the positions the grid reports after a drag, resize or compaction */
  applyGrid: (items: Item[]) => void;
  toggleCollapse: (id: PanelId) => void;
  toggleHide: (id: PanelId) => void;
  preset: (id: PresetId) => void;
  /** Save the current arrangement as "My layout" / go to it / undo the last preset click */
  saveMine: () => void;
  goMine: () => void;
  undo: () => void;
  reset: () => void;
  lock: (locked: boolean) => void;
}

const LayoutCtx = createContext<Ctx | null>(null);
export const useLayout = () => useContext(LayoutCtx)!;

function load(): LayoutState {
  try { return sanitize(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')); } catch { return presetState('all'); }
}

function useNarrow(): boolean {
  const q = `(max-width: ${NARROW_PX}px)`;
  const [narrow, setNarrow] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const on = () => setNarrow(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [q]);
  return narrow;
}

/** Holds the layout, saves it in this browser, and shares it with the panels and the menu. */
export function LayoutProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<LayoutState>(load);
  const narrow = useNarrow();

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* private mode etc: the layout just won't persist */ }
  }, [state]);

  const value = useMemo<Ctx>(() => ({
    state, narrow,
    applyGrid: (items) => setState((s) => applyGridChange(s, items)),
    toggleCollapse: (id) => setState((s) => toggleCollapsed(s, id)),
    toggleHide: (id) => setState((s) => toggleHidden(s, id)),
    preset: (id) => setState((s) => applyPreset(s, id)),
    saveMine: () => setState((s) => saveMine(s)),
    goMine: () => setState((s) => applyMine(s)),
    undo: () => setState((s) => undoPreset(s)),
    reset: () => setState((s) => applyPreset(s, 'all')),
    lock: (locked) => setState((s) => setLocked(s, locked)),
  }), [state, narrow]);

  return <LayoutCtx.Provider value={value}>{children}</LayoutCtx.Provider>;
}

/**
 * A panel in the dock. The title bar is the drag handle (double-click, or the arrow, collapses it),
 * and the body scrolls inside the panel, so content is never cut off when a panel is made small.
 */
export function Panel({ id, title, children, className = '' }: { id: PanelId; title: string; children: ReactNode; className?: string }) {
  const L = useLayout();
  const open = L.state.collapsed[id] === undefined;
  // The drag handling takes over the mouse, so the title bar never gets a 'dblclick' event.
  // Two quick presses in the same place (mouse or finger) collapse it instead.
  const lastPress = useRef({ t: 0, x: 0, y: 0 });
  const onPress = (e: PointerEvent) => {
    if ((e.target as HTMLElement).closest('.chev')) return;
    const p = lastPress.current, now = performance.now();
    if (now - p.t < 450 && Math.hypot(e.clientX - p.x, e.clientY - p.y) < 12) { L.toggleCollapse(id); lastPress.current = { t: 0, x: 0, y: 0 }; }
    else lastPress.current = { t: now, x: e.clientX, y: e.clientY };
  };
  return (
    <section className={`panel ${className} ${open ? '' : 'collapsed'}`} data-panel={id}>
      <h2 className="panel-handle" onPointerDown={onPress}>
        <span>{title}</span>
        <button className="chev" aria-label={`${open ? 'Collapse' : 'Expand'} ${title}`} aria-expanded={open} onClick={() => L.toggleCollapse(id)}>{open ? '▾' : '▸'}</button>
      </h2>
      {open && <div className="body">{children}</div>}
    </section>
  );
}
/** The panels, on a snapping grid
 (or stacked in one column on a narrow screen). */
export function Dock({ panels }: { panels: Record<PanelId, ReactNode> }) {
  const { state, narrow, applyGrid } = useLayout();
  const visible = visibleIds(state);

  if (narrow) {
    return (
      <main className="stack">
        {stackOrder(state).map((id) => <div className="stack-item" key={id}>{panels[id]}</div>)}
      </main>
    );
  }

  const layout: Layout[] = state.items.filter((it) => visible.includes(it.i)).map((it) => ({
    ...it, minW: MIN_SIZE[it.i].w, minH: MIN_SIZE[it.i].h,
    isResizable: state.collapsed[it.i] === undefined && !state.locked,
  }));

  return (
    <Grid
      className={`dock ${state.locked ? 'locked' : ''}`}
      layout={layout}
      cols={COLS}
      rowHeight={ROW_HEIGHT}
      margin={[GAP, GAP]}
      containerPadding={[8, 8]}
      compactType="vertical"
      draggableHandle=".panel-handle"
      draggableCancel=".chev"
      isDraggable={!state.locked}
      isResizable={!state.locked}
      resizeHandles={['se']}
      onLayoutChange={(l) => applyGrid(l.map(({ i, x, y, w, h }) => ({ i: i as PanelId, x, y, w, h })))}
    >
      {visible.map((id) => <div key={id}>{panels[id]}</div>)}
    </Grid>
  );
}

/** The Layout page of Settings: presets, show/hide panels, lock, reset. */
export function LayoutSettings() {
  const L = useLayout();
  return (
    <div className="layout-menu">
      {(
        <div className="menu-pop">
          <div className="menu-h">Layouts</div>
          {L.state.mine && (
            <button className={`menu-item ${L.state.preset === 'mine' ? 'on' : ''}`} onClick={() => L.goMine()} title="The layout you saved with Save as My layout">
              <b>My layout</b><span className="muted small">The arrangement you saved yourself</span>
            </button>
          )}
          {(Object.keys(PRESETS) as PresetId[]).map((id) => (
            <button key={id} className={`menu-item ${L.state.preset === id ? 'on' : ''}`} onClick={() => L.preset(id)} title={PRESETS[id].hint}>
              <b>{PRESETS[id].label}</b><span className="muted small">{PRESETS[id].hint}</span>
            </button>
          ))}
          <div className="row wrap">
            <button className="btn small" onClick={() => L.saveMine()} title="Keep this arrangement so you can always come back to it">Save as My layout</button>
            {L.state.previous && <button className="btn small" onClick={() => L.undo()} title="Go back to the layout you had before the last preset">↩ Undo last preset</button>}
          </div>
          <div className="menu-h">Panels</div>
          <div className="menu-panels">
            {PANEL_IDS.map((id) => (
              <label key={id} className="chk"><input type="checkbox" checked={!L.state.hidden.includes(id)} onChange={() => L.toggleHide(id)} />{PANEL_TITLES[id]}</label>
            ))}
          </div>
          <div className="menu-h">Arrange</div>
          {!L.narrow && <label className="chk"><input type="checkbox" checked={L.state.locked} onChange={(e) => L.lock(e.target.checked)} />Lock layout (no accidental drags)</label>}
          {L.narrow && <div className="muted small">Panels are stacked on a narrow screen. Presets and Panels still apply.</div>}
          <button className="btn small" onClick={() => L.reset()} title="Back to the All panels arrangement (you can undo this)">Reset layout</button>
        </div>
      )}
    </div>
  );
}
