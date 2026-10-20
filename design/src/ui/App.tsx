import { Suspense, lazy, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, type Tool } from './Canvas';
import { useDesign } from './useDesign';
import { NumField } from './NumField';
import { isTyping } from './typing';
import { actionFor, specOf } from '../core/shortcuts';
import { getBindings } from './shortcutStore';
import { ShortcutsDialog } from './ShortcutsDialog';
import { PropertiesBar } from './PropertiesBar';
import { ArrayDialog } from './ArrayDialog';
import { LayerPicker } from './LayerPicker';
import { GadgetDialog, type GadgetKind, type GadgetMemory } from './GadgetDialog';
import { AppearanceDialog } from './AppearanceDialog';
import { LaserSetup } from './LaserSetup';
import { useColors } from './appearance';
import { ToolBar, TOOLS, type CornerState, type OffsetState } from './ToolBar';
import { Icon } from './icons';
import { NodesPanel } from './NodesPanel';
import type { NodeRef } from '../core/nodes';
const TraceDialog = lazy(() => import('./TraceDialog').then((m) => ({ default: m.TraceDialog })));
const TextDialog = lazy(() => import('./TextDialog').then((m) => ({ default: m.TextDialog })));
import { previewText, textInfo, textWidth } from '../core/commands';
import { getFont } from '../core/text';
import { LiveTextBar, type LiveSettings } from './LiveTextBar';
import { BUILT_IN_FONTS, ensureFont } from './fontCatalog';
import { isSystemFont } from './systemFonts';
const ensureFontLazy = async (name: string) => (await import('./fontCatalog')).ensureFont(name);
import { JobPanel, LaserLayers } from './LaserPanels';
import { MaterialLibrary } from './MaterialLibrary';
import { JobPreview } from './JobPreview';
import { SideBox } from './SideBox';
import { AccessDialog } from './AccessDialog';
import { CameraCard, CameraSetup } from './CameraCard';
import { JobMonitor, type MonitorJob } from './JobMonitor';
import { clock, estimateMoves, planToMoves } from '../core/jobEstimate';
import { useCncView } from './cncView';
import { useReliefPictures } from './reliefView';
import { CncPanel, type CustomPost } from './CncPanel';
import { ToolDialog } from './ToolDialog';
import { ToolpathDialog } from './ToolpathDialog';
import { InlayDialog } from './InlayDialog';
import { ToolDatabase } from './ToolDatabase';
import { ToolPickProvider, type ToolPickContext } from './toolPicker';
import { ReliefDialog } from './ReliefDialog';
import { useToolLibrary } from './toolLibStore';
import { PhotoDialog } from './PhotoDialog';
import { Finish3dDialog } from './Finish3dDialog';
import { buildAll, cncOf, generateFiles } from '../core/cncjob';
import { BUILT_IN_POSTS, parsePost, type PostDef } from '../core/post';
import type { CncTool, Toolpath, ToolpathKind } from '../core/cnc';
import type { Move } from '../core/laser';
import { NewDesignDialog } from './NewDesignDialog';
import { JobSetup } from './JobSetup';
import { ContextMenu, DropMenu, type MenuItem } from './Menu';
import { canPick, download, pickOpenHandle, pickSaveHandle, writeHandle, type HandleLike } from './files';
import { LaserControl } from './LaserControl';
import { useLaser } from './useLaser';
import { anchorName, buildLaserJob, jobOrigin, type OrderOptions } from '../core/laser';
import { useJobs } from './useJobs';
import { MeasurePanel } from './MeasurePanel';
import { FilletPanel, DEFAULT_FILLET, type FilletSpec } from './FilletPanel';
import { ShapePanel, DEFAULT_SHAPE_STATE, type ShapeState } from './ShapePanel';
import { DEFAULT_SHAPES, buildShape, shapeValid, type ShapeSpec } from '../core/shapes';
import { CirclePanel, DEFAULT_CIRCLE, circleRadius, type CircleSpec } from './CirclePanel';
import { RectPanel, DEFAULT_RECT, type RectSpec } from './RectPanel';
import { RotaryDialog } from './RotaryDialog';
import { onClipChange, readClip, writeClip } from './clipboard';
import { PositionsPanel } from './PositionsPanel';
import { readDxf } from './readDxf';
import { planBox, serializePlan } from '../../server/src/ruida/plan';
import { listCommands } from '../core/commands';
import { exportDxf } from '../core/dxf';
import { exportSvg } from '../core/svg';
import { buildExample } from '../core/example';
import { shapeArea, shapeBounds, shapeClosed, unionBounds, rectOrigin, type Anchor, type Bounds } from '../core/geom';
import type { Doc, LayerMode, Pt, Shape } from '../core/types';
import { ProjectError, PROJECT_EXTENSION, parseProject, projectName, serializeProject } from '../core/project';
import { emptyDoc, workRect } from '../core/types';

type Panel = 'laser' | 'cnc' | null;

/** What the Laser panel shows while the Laser tab is not open */

export function App() {
  const d = useDesign();
  const { doc, selection, setSelection, run } = d;
  const [tool, setTool] = useState<Tool>('select');
  const [snap, setSnap] = useState(true);
  const [objectSnap, setObjectSnap] = useState(true);
  // Draw Circle: the size is remembered in this browser, the place is not
  const [circleSpec, setCircleSpecState] = useState<CircleSpec>(() => {
    try { const v = JSON.parse(localStorage.getItem('design-circle') ?? ''); if ((v.mode === 'radius' || v.mode === 'diameter') && v.size > 0) return { ...DEFAULT_CIRCLE, mode: v.mode, size: v.size }; } catch { /* no saved size */ }
    return DEFAULT_CIRCLE;
  });
  const [rectSpec, setRectSpecState] = useState<RectSpec>(() => {
    try { const v = JSON.parse(localStorage.getItem('design-rect') ?? ''); if (v.w > 0 && v.h > 0 && typeof v.anchor === 'string') return { ...DEFAULT_RECT, w: v.w, h: v.h, anchor: v.anchor }; } catch { /* no saved size */ }
    return DEFAULT_RECT;
  });
  const setRectSpec = (r: RectSpec) => { setRectSpecState(r); try { localStorage.setItem('design-rect', JSON.stringify({ w: r.w, h: r.h, anchor: r.anchor })); } catch { /* not remembered */ } };
  const setCircleSpec = (c: CircleSpec) => { setCircleSpecState(c); try { localStorage.setItem('design-circle', JSON.stringify({ mode: c.mode, size: c.size })); } catch { /* not remembered */ } };
  // the ellipse, polygon, star and arc cards: the numbers are remembered in this browser, the place is not
  const [shapeSpecs, setShapeSpecsState] = useState<typeof DEFAULT_SHAPES>(() => {
    try {
      const v = JSON.parse(localStorage.getItem('design-shapes') ?? '');
      const out: typeof DEFAULT_SHAPES = { ...DEFAULT_SHAPES };
      for (const k of Object.keys(DEFAULT_SHAPES) as (keyof typeof DEFAULT_SHAPES)[]) {
        const c = { ...DEFAULT_SHAPES[k], ...(v?.specs?.[k] ?? {}), kind: k } as ShapeSpec;
        if (shapeValid(c)) (out as Record<string, ShapeSpec>)[k] = c;
      }
      return out;
    } catch { return DEFAULT_SHAPES; }
  });
  const [shapeAt, setShapeAtState] = useState<ShapeState>(() => {
    try { const v = JSON.parse(localStorage.getItem('design-shapes') ?? ''); if (v?.mode === 'radius') return { ...DEFAULT_SHAPE_STATE, mode: 'radius' }; } catch { /* no saved choice */ }
    return DEFAULT_SHAPE_STATE;
  });
  const saveShapes = (specs: typeof DEFAULT_SHAPES, at: ShapeState) => { try { localStorage.setItem('design-shapes', JSON.stringify({ specs, mode: at.mode })); } catch { /* not remembered */ } };
  const shapeTool = tool === 'ellipse' || tool === 'polygon' || tool === 'star' || tool === 'arc' ? tool : null;
  const [anchor, setAnchor] = useState<Anchor>('c');
  // Design, Laser and CNC are three separate pages (tabs). Design has the drawing tools; Laser and CNC show the drawing
  // beside their own panel. `panel` is null on the Design tab.
  const [panel, setPanel] = useState<Panel>(null);
  const mode = panel ?? 'design';
  const goTab = (t: 'design' | 'laser' | 'cnc') => { setPanel(t === 'design' ? null : t); setFitSignal((n) => n + 1); };
  // where the job sits relative to the head / work zero, remembered separately for GRBL and Ruida; both start at top-left, like LightBurn (a Ruida head is usually parked at the rear-left corner)
  const [anchors, setAnchors] = useState<{ grbl: Anchor; ruida: Anchor }>(() => {
    const ok = (a: unknown): a is Anchor => typeof a === 'string' && ['tl', 'tc', 'tr', 'ml', 'c', 'mr', 'bl', 'bc', 'br'].includes(a);
    try { const v = JSON.parse(localStorage.getItem('design.jobAnchors2') ?? ''); if (ok(v?.grbl) && ok(v?.ruida)) return v; } catch { /* no saved choice */ }
    return { grbl: 'tl', ruida: 'tl' };
  });
  const [onlySelected, setOnlySelected] = useState(false);
  const [preview, setPreview] = useState(true);
  const [startFrom, setStartFrom] = useState<'user' | 'absolute'>('user');
  // the size of the job is asked for first, like VCarve's Job Setup
  const [laserOpened, setLaserOpened] = useState(false);
  const [dialog, setDialog] = useState<'new' | 'edit' | null>('new');
  const [lock, setLock] = useState(false);
  const [activeLayer, setActiveLayer] = useState('Layer 1');
  const [fitSignal, setFitSignal] = useState(0);
  const [cursor, setCursor] = useState<{ p: Pt | null; scale: number; step: number; label?: string }>({ p: null, scale: 5, step: 1 });
  const [offset, setOffset] = useState<OffsetState>({ distance: 1, direction: 'outward', join: 'round', keep: true, outerOnly: true, select: true });
  const [newLayer, setNewLayer] = useState('');
  const [ctx, setCtx] = useState<{ x: number; y: number } | null>(null);
  const [gadget, setGadget] = useState<GadgetKind | null>(null);
  const [gmem, setGmem] = useState<GadgetMemory>({ template: [], bridge: null, nextNumber: 1 });
  const [appearance, setAppearance] = useState(false);
  const [laserSetup, setLaserSetup] = useState(false);
  const [rotaryOpen, setRotaryOpen] = useState(false);
  const [accessOpen, setAccessOpen] = useState(false);
  const [cameraSetup, setCameraSetup] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  // the live monitor follows the job as it was when Start was pressed, so editing the design meanwhile cannot confuse it
  const [monitor, setMonitor] = useState<MonitorJob | null>(null);
  const [monitorShown, setMonitorShown] = useState(false);
  const [monitorFocus, setMonitorFocus] = useState({ key: 'monitor', n: 0 });
  // closing the card sends the monitor to its tab in the Laser box
  const closeMonitorCard = () => { setMonitorShown(false); setMonitorFocus((f) => ({ key: 'monitor', n: f.n + 1 })); };
  const [layerAsk, setLayerAsk] = useState<'copy' | 'move' | null>(null);
  const [layerAskName, setLayerAskName] = useState('');
  const [nameAsk, setNameAsk] = useState<string | null>(null);
  const [cmdOpen, setCmdOpen] = useState(false);
  // CNC: posts you loaded (kept in this browser), the home position written into the G-code, and the dialogs
  const [posts, setPostsState] = useState<CustomPost[]>(() => {
    try { const v = JSON.parse(localStorage.getItem('design-posts') ?? '[]'); return Array.isArray(v) ? v.filter((p) => p && typeof p.name === 'string' && typeof p.text === 'string') : []; } catch { return []; }
  });
  const setPosts = (p: CustomPost[]) => { setPostsState(p); try { localStorage.setItem('design-posts', JSON.stringify(p)); } catch { /* it just will not be remembered */ } };
  const [home, setHome] = useState({ x: 0, y: 0 });
  const [inlayDialog, setInlayDialog] = useState(false);
  const [libOpen, setLibOpen] = useState(false);
  const [stlOpen, setStlOpen] = useState(false);
  const toolLib = useToolLibrary();
  const jobCnc = cncOf(doc);
  const [tpDialog, setTpDialog] = useState<{ kind: ToolpathKind; existing: Toolpath | null } | null>(null);
  const [toolDialog, setToolDialog] = useState<{ tool: CncTool | null } | null>(null);
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    try { return localStorage.getItem('design-theme') === 'light' ? 'light' : 'dark'; } catch { return 'dark'; }
  });
  const colors = useColors(theme);
  const fileRef = useRef<HTMLInputElement>(null);
  const openRef = useRef<HTMLInputElement>(null);
  // Which file this design is, and what was last saved: any change after that makes it "unsaved"
  const [fileName, setFileName] = useState<string | null>(null);
  const handleRef = useRef<HandleLike | null>(null);
  const [savedDoc, setSavedDoc] = useState<Doc>(doc);
  const dirty = doc !== savedDoc;
  const [banner, setBanner] = useState<{ kind: 'err' | 'ok'; text: string } | null>(null);
  const [asking, setAsking] = useState<{ done: (r: 'save' | 'discard' | 'cancel') => void } | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const [line, setLine] = useState('');

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('design-theme', theme); } catch { /* private mode */ }
  }, [theme]);

  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight }); }, [d.log]);

  // keep a valid active layer if one is removed or renamed
  useEffect(() => {
    if (!doc.layers.some((l) => l.name === activeLayer) && doc.layers[0]) setActiveLayer(doc.layers[0].name);
  }, [doc.layers, activeLayer]);


  const selectionNow = useRef<number[]>(selection);
  selectionNow.current = selection;
  // The same commands, for scripts and AI tools to call. (Later this is what an MCP bridge talks to.)
  useEffect(() => {
    (window as any).demonxDesign = {
      run: (id: string, args: unknown) => run(id, args),
      doc: () => d.getDoc(),
      selection: () => selectionNow.current,
      commands: listCommands,
      /** Fonts load asynchronously; call this once before run('add_text', { font }) from a script. */
      loadFont: async (name: string) => { await ensureFontLazy(name); return true; },
    };
  }, [run]);

  // picked points belong to the shape and tool they were picked in
  useEffect(() => { setNodeSel([]); }, [selection.join(","), tool]);

  const selShapes = useMemo(() => selection.map((id) => doc.shapes.find((s) => s.id === id)).filter((s) => !!s), [selection, doc.shapes]);
  const selBounds = unionBounds(selShapes.map((s) => shapeBounds(s!)));
  const selArea = selShapes.reduce((a, s) => a + (s ? shapeArea(s) : 0), 0);
  const closedCount = selShapes.filter((s) => s && shapeClosed(s)).length;
  const layer = doc.layers.find((l) => l.name === activeLayer);

  const name = projectName(fileName);

  // when the browser cannot offer its own Save As window (see below), the name is asked for here
  const nameWait = useRef<((v: string | null) => void) | null>(null);
  const askName = (): Promise<string | null> => new Promise((resolve) => { nameWait.current = resolve; setNameAsk(name); });
  const closeNameAsk = (v: string | null) => { setNameAsk(null); const w = nameWait.current; nameWait.current = null; if (w) w(v); else if (v) void saveAs(v); };

  const saveAs = async (as?: string): Promise<boolean> => {
    const snapshot = d.getDoc();
    const text = serializeProject(snapshot);
    let chosen = as;
    if (!chosen && !canPick()) { chosen = (await askName()) ?? undefined; if (!chosen) return false; }
    const base = chosen ? chosen.replace(/\.(dxd|json)$/i, '').replace(/[\\/:*?"<>|]+/g, '-').trim() : '';
    const suggested = (base || name) + PROJECT_EXTENSION;
    let how = 'Saved.';
    try {
      if (canPick()) {
        const h = await pickSaveHandle(suggested);
        if (!h) return false;
        await writeHandle(h, text);
        handleRef.current = h;
        setFileName(h.name);
      } else {
        download(suggested, text, 'application/json');
        handleRef.current = null;
        setFileName(suggested);
        // browsers only offer a Save As window (a name and a folder) on a secure address: https, or this very computer (localhost)
        how = `Saved to your Downloads folder as ${suggested}. This page is not on a secure address, so the browser cannot ask where to save. Open DemonX Design on https:// (see the README), or allow this address in Chrome: chrome://flags/#unsafely-treat-insecure-origin-as-secure.`;
      }
    } catch (e) {
      setBanner({ kind: 'err', text: 'Could not save the file: ' + (e as Error).message });
      return false;
    }
    setSavedDoc(snapshot);
    setBanner({ kind: 'ok', text: how });
    return true;
  };

  const save = async (): Promise<boolean> => {
    const h = handleRef.current;
    if (!h) return !canPick() && fileName ? saveAs(fileName) : saveAs();
    const snapshot = d.getDoc();
    try { await writeHandle(h, serializeProject(snapshot)); } catch (e) { setBanner({ kind: 'err', text: 'Could not save the file: ' + (e as Error).message }); return false; }
    setSavedDoc(snapshot);
    setBanner({ kind: 'ok', text: `Saved ${h.name}.` });
    return true;
  };

  /** Before anything that would throw the current design away: offer to save it. Resolves true to carry on. */
  const confirmDiscard = (): Promise<boolean> => {
    if (d.getDoc() === savedDoc) return Promise.resolve(true);
    return new Promise((resolve) => {
      setAsking({
        done: async (r) => {
          setAsking(null);
          if (r === 'cancel') return resolve(false);
          if (r === 'save') return resolve(await save());
          resolve(true);
        },
      });
    });
  };

  const loadProject = (text: string, fileLabel: string, handle: HandleLike | null) => {
    let opened: Doc;
    try { opened = parseProject(text); } catch (e) {
      setBanner({ kind: 'err', text: `Could not open ${fileLabel}: ${e instanceof ProjectError ? e.message : (e as Error).message}` });
      return;
    }
    d.replaceDoc(opened, `Opened ${fileLabel}`);
    handleRef.current = handle;
    setFileName(fileLabel);
    setSavedDoc(d.getDoc());
    setBanner(null);
    setActiveLayer(opened.layers[0].name);
    setFitSignal((n) => n + 1);
    setPanel(null);
  };

  const openProject = async () => {
    if (!(await confirmDiscard())) return;
    try {
      if (canPick()) {
        const h = await pickOpenHandle();
        if (!h) return;
        const f = await h.getFile();
        if (f.size > 200 * 1024 * 1024) return setBanner({ kind: 'err', text: 'That file is too big to be a design.' });
        loadProject(await f.text(), h.name, h);
      } else openRef.current?.click();
    } catch (e) {
      setBanner({ kind: 'err', text: 'Could not open the file: ' + (e as Error).message });
    }
  };

  // copy / cut / paste / duplicate: the clipboard is shared with the other tabs of this browser (see clipboard.ts); it does not reach other programs
  const clip = useRef<{ stamp: number; shapes: unknown[]; pastes: number } | null>(null);
  const [hasClip, setHasClip] = useState(() => !!readClip());
  useEffect(() => onClipChange(() => setHasClip(!!clip.current || !!readClip())), []);
  const [nodeSel, setNodeSel] = useState<NodeRef[]>([]);
  const [corner, setCorner] = useState<CornerState>({ radius: 5, style: 'round', onNew: false });
  const [textAt, setTextAt] = useState<[number, number] | null>(null);
  const [editingText, setEditingText] = useState(false);
  // the Fillet card says what the last click did: only what happened since the tool was picked
  const filletLogStart = useRef(0);
  useEffect(() => { if (tool === 'fillet') filletLogStart.current = d.log.length; /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [tool]);
  const [bitmapFile, setBitmapFile] = useState<File | null>(null);
  const [showKeys, setShowKeys] = useState(false);
  const bitmapRef = useRef<HTMLInputElement>(null);
  const [filletSpec, setFilletSpecState] = useState<FilletSpec>(() => {
    try { const v = JSON.parse(localStorage.getItem('design-fillet') ?? ''); if (v.radius > 0 && ['round', 'cove', 'chamfer'].includes(v.style)) return { radius: v.radius, style: v.style }; } catch { /* no saved choice */ }
    return DEFAULT_FILLET;
  });
  const setFilletSpec = (f: FilletSpec) => { setFilletSpecState(f); try { localStorage.setItem('design-fillet', JSON.stringify(f)); } catch { /* not remembered */ } };
  const [measureM, setMeasureM] = useState<{ a: [number, number]; b: [number, number] | null } | null>(null);
  const [measureClear, setMeasureClear] = useState(0);
  const selTextInfo = useMemo(() => textInfo(doc, selection), [doc, selection]);
  // text typed on the drawing: where it starts, what it says and its settings. `edit` is the group of text already in the drawing when it is being edited
  const [liveText, setLiveText] = useState<{ at: [number, number]; edit: { group: number; ids: number[] } | null; caret: number; s: LiveSettings } | null>(null);
  const liveInput = useRef<HTMLTextAreaElement>(null);
  const [fontTick, setFontTick] = useState(0);
  const [fontError, setFontError] = useState('');
  const textDefaults = (): LiveSettings => {
    const base: LiveSettings = { text: '', font: 'Roboto Bold', height: 20, align: 'left', spacing: 0, lineSpacing: 1, weld: false, bend: 0 };
    try {
      const v = JSON.parse(localStorage.getItem('design-text') ?? '{}');
      // a font that is not here now (a font file loaded last time, a system font not asked for yet) would draw nothing: use the usual one
      const known = typeof v.font === 'string' && (v.font in BUILT_IN_FONTS || !!getFont(v.font) || isSystemFont(v.font));
      return { ...base, font: known ? v.font : base.font, height: v.height > 0 ? v.height : base.height, align: ['left', 'center', 'right'].includes(v.align) ? v.align : base.align, spacing: Number.isFinite(v.spacing) ? v.spacing : 0, lineSpacing: v.lineSpacing > 0 ? v.lineSpacing : 1, weld: !!v.weld }; } catch { return base; }
  };
  const startLiveNew = (at: [number, number]) => { setLiveText({ at, edit: null, caret: 0, s: textDefaults() }); setSelection([]); setTool('text'); };
  const startLiveEdit = (ids: number[]) => {
    const info = textInfo(doc, ids);
    if (!info) return false;
    setLiveText({ at: [info.x, info.y], edit: { group: info.rec.group, ids: info.members }, caret: info.rec.text.length, s: { text: info.rec.text, font: info.rec.font, height: info.height, align: info.rec.align, spacing: info.spacing, lineSpacing: info.rec.lineSpacing, weld: info.rec.weld, bend: info.rec.bend ?? 0 } });
    setSelection([]);
    return true;
  };
  const commitLive = () => {
    const l = liveText;
    if (!l) return;
    setLiveText(null);
    setTool('select');
    if (!l.s.text.trim()) return;
    try { localStorage.setItem('design-text', JSON.stringify({ font: l.s.font, height: l.s.height, align: l.s.align, spacing: l.s.spacing, lineSpacing: l.s.lineSpacing, weld: l.s.weld })); } catch { /* it just will not be remembered */ }
    const a = { text: l.s.text, font: l.s.font, height: l.s.height, align: l.s.align, spacing: l.s.spacing, line_spacing: l.s.lineSpacing, weld: l.s.weld, bend: l.s.bend };
    // the font has to be in before the letters can be made (it nearly always is: the preview needed it)
    const place = () => { if (l.edit) run('edit_text', { ...a, ids: l.edit.ids }); else run('add_text', { ...a, x: l.at[0], y: l.at[1], layer: activeLayer }); };
    if (getFont(l.s.font)) place(); else ensureFont(l.s.font).then(place).catch((e) => d.say('err', `The font ${l.s.font} could not be loaded: ${(e as Error).message}`));
  };
  const cancelLive = () => { setLiveText(null); if (liveText && !liveText.edit) setTool('select'); };
  // Ctrl+Enter places the text and Escape drops it wherever the keyboard focus is: in the typing, or in a box of the bar above (which is
  // let go first, so a number typed there and not yet confirmed still counts)
  const liveActions = useRef({ commit: commitLive, cancel: cancelLive });
  liveActions.current = { commit: commitLive, cancel: cancelLive };
  useEffect(() => {
    if (!liveText) return;
    const k = (e: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"]')) return;
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault(); e.stopPropagation();
        (document.activeElement as HTMLElement | null)?.blur?.();
        setTimeout(() => liveActions.current.commit(), 0);
      } else if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation();
        liveActions.current.cancel();
      }
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [!!liveText]);
  // the font has to be loaded before the letters can be drawn
  useEffect(() => {
    if (!liveText) return;
    let on = true;
    setFontError('');
    ensureFont(liveText.s.font).then(() => { if (on) setFontTick((n) => n + 1); }).catch((e) => { if (on) setFontError(`The font ${liveText.s.font} is not available here (${(e as Error).message}). Pick another font above.`); });
    return () => { on = false; };
  }, [liveText?.s.font]);
  // the click that started the text takes the focus after it (a canvas cannot hold it), so it is asked for again a moment later
  useEffect(() => {
    if (!liveText) return;
    const toEnd = () => { const l = liveInput.current; if (!l) return; l.focus(); l.setSelectionRange(l.value.length, l.value.length); };
    toEnd();
    const t = setTimeout(toEnd, 60);
    return () => clearTimeout(t);
  }, [!!liveText]);
  const livePreview = useMemo(() => (liveText ? previewText(liveText.s, liveText.at[0], liveText.at[1], liveText.caret) : null), [liveText, fontTick]);
  // while one piece of text is typed over, the old one is not drawn
  const hidden = useMemo(() => (liveText?.edit ? new Set(liveText.edit.ids) : null), [liveText?.edit]);
  const canvasDoc = useMemo(() => (hidden ? { ...doc, shapes: doc.shapes.filter((s) => !hidden.has(s.id)) } : doc), [doc, hidden]);
  const textHandle = useMemo(() => {
    if (!selTextInfo || selTextInfo.others.length || liveText || selection.length !== selTextInfo.members.length) return null;
    try { return { ids: selTextInfo.members, box: selTextInfo.box, bend: selTextInfo.rec.bend ?? 0, length: textWidth({ ...selTextInfo.rec, height: selTextInfo.height, spacing: selTextInfo.spacing }) }; } catch { return null; }
  }, [selTextInfo, liveText, selection]);
  const onDoubleClickAt = (p: Pt) => {
    // a double-click on a piece of text (inside the box it fills) edits it where it stands
    let best: { ids: number[]; area: number } | null = null;
    for (const t of doc.texts ?? []) {
      const members = doc.shapes.filter((s) => s.group === t.group);
      if (members.length !== t.count) continue;
      const b = unionBounds(members.map((m) => shapeBounds(m)!));
      if (!b) continue;
      const pad = 2;
      if (p[0] >= b.minX - pad && p[0] <= b.maxX + pad && p[1] >= b.minY - pad && p[1] <= b.maxY + pad) {
        const area = (b.maxX - b.minX) * (b.maxY - b.minY);
        if (!best || area < best.area) best = { ids: members.map((m) => m.id), area };
      }
    }
    if (best) startLiveEdit(best.ids);
  };
  const [arrayOpen, setArraying] = useState(false);
  const arraying = arrayOpen && selection.length > 0;
  useEffect(() => { if (arrayOpen && !selection.length) setArraying(false); }, [arrayOpen, selection.length]);
  const copySel = (): boolean => {
    const cur = d.getDoc();
    const shapes = d.selection.map((id) => cur.shapes.find((s) => s.id === id)).filter((s) => !!s);
    if (!shapes.length) return false;
    const copy = JSON.parse(JSON.stringify(shapes)) as unknown[];
    const stamp = Date.now() + Math.random();
    clip.current = { stamp, shapes: copy, pastes: 0 };
    setHasClip(true);
    const shared = writeClip({ stamp, shapes: copy });
    d.say('ok', `Copied ${shapes.length} shape${shapes.length === 1 ? '' : 's'}` + (shared ? ' (you can paste them in your other tabs too)' : ' (too big to share with other tabs: paste works in this tab only)'));
    return true;
  };
  const cutSel = () => { if (copySel()) run('delete', { ids: d.selection }, false); };
  const pasteClip = () => {
    // a copy made in another tab is newer than ours: take it. It lands where it was (it is another design), and pasting again steps it aside
    const other = readClip();
    if (other && other.stamp !== clip.current?.stamp && other.stamp > (clip.current?.stamp ?? 0)) clip.current = { stamp: other.stamp, shapes: other.shapes, pastes: -1 };
    const c = clip.current;
    if (!c) return;
    c.pastes += 1;
    // pasted with the keys while the pointer is over the drawing: the middle of what was copied goes under the pointer
    const round3 = (v: number) => Math.round(v * 1000) / 1000;
    const here = cursor.p;
    const box = here ? unionBounds(c.shapes.map((s: any) => shapeBounds(s)).filter(Boolean) as Bounds[]) : null;
    if (here && box) { run('paste', { shapes: c.shapes, dx: round3(here[0] - (box.minX + box.maxX) / 2), dy: round3(here[1] - (box.minY + box.maxY) / 2) }); return; }
    run('paste', { shapes: c.shapes, dx: 5 * c.pastes, dy: -5 * c.pastes });
  };
  const dupSel = () => { if (d.selection.length) run('duplicate', { ids: d.selection }); };

  const newDesign = async () => { if (await confirmDiscard()) setDialog('new'); };

  // keys: undo / redo, and Save / Open (which also work while a number box has focus)
  const groupSel = (ungroup: boolean) => { if (d.selection.length) run(ungroup ? 'ungroup' : 'group', { ids: d.selection }); };
  const actions = useRef({ save, saveAs, openProject, copySel, cutSel, pasteClip, dupSel, group: groupSel });
  actions.current = { save, saveAs, openProject, copySel, cutSel, pasteClip, dupSel, group: groupSel };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const act = actionFor(specOf(e), getBindings());
      if (!act) return;
      if (act === 'file.saveAs') { e.preventDefault(); void actions.current.saveAs(); return; }
      if (act === 'file.save') { e.preventDefault(); void actions.current.save(); return; }
      if (act === 'file.open') { e.preventDefault(); void actions.current.openProject(); return; }
      if (isTyping(e.target)) return;
      if (act === 'edit.undo') { e.preventDefault(); d.undo(); }
      else if (act === 'edit.copy') { e.preventDefault(); actions.current.copySel(); }
      else if (act === 'edit.cut') { e.preventDefault(); actions.current.cutSel(); }
      else if (act === 'edit.paste') { e.preventDefault(); actions.current.pasteClip(); }
      else if (act === 'edit.duplicate') { e.preventDefault(); actions.current.dupSel(); }
      else if (act === 'edit.group') { e.preventDefault(); actions.current.group(false); }
      else if (act === 'edit.ungroup') { e.preventDefault(); actions.current.group(true); }
      else if (act === 'edit.redo') { e.preventDefault(); d.redo(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [d.undo, d.redo]);

  // the browser warns before the tab is closed with unsaved changes; the title shows it too
  useEffect(() => {
    document.title = `${dirty ? '● ' : ''}${name} · DemonX Design`;
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, name]);

  const onImport = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) { d.say('err', 'That file is over 20 MB, which is too big to import here.'); return; }
    const text = await file.text();
    d.say('info', 'Reading the DXF…');
    try {
      const parsed = await readDxf(text);
      if (run('import_dxf', { parsed })) setFitSignal((n) => n + 1);
    } catch (e) {
      d.say('err', e instanceof Error ? e.message : 'Could not read this DXF');
    }
    if (fileRef.current) fileRef.current.value = '';
  };

  const doBoolean = (op: string) => run('boolean', { op, ids: selection });
  const hint = TOOLS.find((t) => t.id === tool)?.hint ?? 'Pan (H). Or hold Space, or drag with the middle mouse button. The wheel zooms. Press V to go back to Select.';

  // the laser job is rebuilt whenever the drawing, the layers or the options change
  useEffect(() => { if (panel === 'laser') setLaserOpened(true); }, [panel]);
  const laser = useLaser(laserOpened);
  const monitorLive = laser.state?.kind === 'ruida' ? { jobState: laser.state.job.state, elapsedMs: laser.state.job.elapsedMs ?? 0, head: laser.state.status.wpos ? { x: laser.state.status.wpos.x, y: laser.state.status.wpos.y } : null } : null;
  const anchorKey = laser.state?.kind === 'ruida' ? 'ruida' : 'grbl';
  const jobAnchor = anchors[anchorKey];
  const setJobAnchor = (a: Anchor) => setAnchors((cur) => {
    const next = { ...cur, [anchorKey]: a };
    try { localStorage.setItem('design.jobAnchors2', JSON.stringify(next)); } catch { /* private window: the choice lasts until the page is closed */ }
    return next;
  });
  // the cut optimizer's switches, remembered in this browser
  const [order, setOrderState] = useState<OrderOptions>(() => {
    try { const o = JSON.parse(localStorage.getItem('design-cut-order') ?? '{}'); return { innerFirst: o.innerFirst !== false, reduceTravel: o.reduceTravel !== false }; } catch { return { innerFirst: true, reduceTravel: true }; }
  });
  const setOrder = (o: OrderOptions) => { setOrderState(o); try { localStorage.setItem('design-cut-order', JSON.stringify(o)); } catch { /* not remembered */ } };
  // The job is only built while the Laser tab is open (a big drawing, thousands of letter and QR pieces, takes a moment to work out),
  // and from the drawing as it was an instant ago, so typing and dragging stay quick.
  const laserTab = panel === 'laser';
  const jobDoc = useDeferredValue(doc);
  // the same job as a Ruida plan, only built while a Ruida controller is connected
  const ruidaConnected = laser.state?.kind === 'ruida';
  useEffect(() => { if (ruidaConnected) setStartFrom('user'); }, [ruidaConnected]);
  // worked out in a worker (see useJobs): editing stays smooth however big the drawing is, and `jobStale` says a newer job is on its way
  const jobInput = useMemo(
    () => (laserTab ? { doc: jobDoc, onlyIds: onlySelected && selection.length ? selection : undefined, anchor: jobAnchor, startFrom: ruidaConnected ? ('user' as const) : startFrom, order, ruida: ruidaConnected } : null),
    [laserTab, jobDoc, onlySelected, selection, jobAnchor, startFrom, order, ruidaConnected],
  );
  const { out: jobs, stale: jobStale, error: jobError } = useJobs(jobInput);
  const job = jobs.job, ruidaJob = jobs.ruida, est = jobs.est;
  const liveMoves = ruidaConnected ? ruidaJob.moves : job.moves;
  const work = useMemo(() => workRect(doc.workspace), [doc.workspace]);
  // a laser's page counts Y down from its top edge (when its setup says the origin is top-left): the ruler, the Y box and the
  // cursor readout all use this, so the numbers on screen are the ones the laser works with. CNC and free designs count up from the bottom.
  const yTop = panel !== 'cnc' && doc.workspace.kind === 'laser' && (doc.machine.origin ?? 'tl') === 'tl' && work ? work.maxY : null;
  // the green square: where the job starts, from the whole design (not only the layers that burn)
  const originMark = useMemo(() => (startFrom === 'absolute' && !ruidaConnected ? ([0, 0] as [number, number]) : jobOrigin(doc, { onlyIds: onlySelected && selection.length ? selection : undefined, anchor: jobAnchor })), [doc, onlySelected, selection, jobAnchor, startFrom, ruidaConnected]);
  // Ruida: where the job is placed from. Frame works in all three ways; Start only from the current position (a job sent the other ways has not been captured yet)
  const [rStart, setRStart] = useState<'current' | 'absolute' | 'origin'>(() => { try { const v = localStorage.getItem('design-ruida-start'); return v === 'absolute' || v === 'origin' ? v : 'current'; } catch { return 'current'; } });
  const setRStartMode = (m: 'current' | 'absolute' | 'origin') => { setRStart(m); try { localStorage.setItem('design-ruida-start', m); } catch { /* not remembered */ } };
  // the job's start point where it sits in the design, as the machine counts it: from the rear-left corner, Y toward the front
  const absoluteStart = useMemo(() => (ruidaConnected && work && originMark ? { x: Math.round((originMark[0] - work.minX) * 1000) / 1000, y: Math.round((work.maxY - originMark[1]) * 1000) / 1000 } : null), [ruidaConnected, work, originMark]);
  // CNC toolpaths are built only while the CNC panel is open
  const cncBuilt = useMemo(() => (panel === 'cnc' ? buildAll(doc) : []), [doc, panel]);
  const postDef: PostDef = useMemo(() => {
    const name = cncOf(doc).post;
    const mine = posts.find((p) => p.name === name);
    if (mine) { try { return parsePost(mine.text); } catch { /* fall through to the built-in */ } }
    return BUILT_IN_POSTS.find((p) => p.name === name) ?? BUILT_IN_POSTS[0];
  }, [doc.cnc, posts]);
  const cncFiles = useMemo(() => (panel === 'cnc' ? generateFiles(doc, postDef, { home }, cncBuilt) : []), [doc, postDef, home, cncBuilt, panel]);
  const cncView = useCncView(cncBuilt);
  const reliefPics = useReliefPictures(doc.reliefs, cncView.colours.material);
  const cncFull: Move[] = useMemo(() => cncView.moves.map((m) => {
    const burn = m.kind !== 'rapid';
    return { x0: m.x0, y0: m.y0, x1: m.x1, y1: m.y1, burn, layer: '', color: burn ? cncView.colours.cut : cncView.colours.rapid };
  }), [cncView.moves, cncView.colours]);
  const simFr = cncView.sim.frame;
  const cncOverlay: Move[] = useMemo(() => {
    if (!simFr) return cncFull;
    const part = simFr.partial;
    return part ? [...cncFull.slice(0, simFr.done), { x0: part.x0, y0: part.y0, x1: part.x1, y1: part.y1, burn: part.kind !== 'rapid', layer: '', color: part.kind !== 'rapid' ? cncView.colours.cut : cncView.colours.rapid }] : cncFull.slice(0, simFr.done);
  }, [cncFull, simFr, cncView.colours]);
  const savePreviewImage = () => {
    const c = document.querySelector('canvas.design-canvas') as HTMLCanvasElement | null;
    if (!c) { d.say('err', 'There is no drawing to save a picture of'); return; }
    c.toBlob((b) => {
      if (!b) { d.say('err', 'Could not make the picture'); return; }
      const url = URL.createObjectURL(b);
      const a = document.createElement('a');
      a.href = url; a.download = `${name}_preview.png`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      d.say('ok', `Saved ${name}_preview.png`);
    }, 'image/png');
  };
  const saveToolFile = (f: { tool: CncTool; gcode: string }, ext: string) => {
    const slug = f.tool.name.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '');
    download(`${name}_${slug}.${ext}`, f.gcode, 'text/plain');
    d.say('ok', `Saved ${name}_${slug}.${ext}`);
  };
  const outside = useMemo(() => {
    if (!work) return 0;
    const eps = 1e-6;
    return doc.shapes.filter((s) => {
      const b = shapeBounds(s);
      return b && (b.minX < work.minX - eps || b.minY < work.minY - eps || b.maxX > work.maxX + eps || b.maxY > work.maxY + eps);
    }).length;
  }, [doc.shapes, work]);
  const ws = doc.workspace;
  const jobSummary = ws.kind === 'free' ? 'No size limit' : `${ws.width} × ${ws.height}${ws.kind === 'cnc' ? ` × ${ws.thickness}` : ''} mm${ws.kind === 'canvas' ? ' (canvas)' : ''}`;
  const applyJob = (args: Record<string, unknown>) => {
    const ok = dialog === 'new' ? run('new_project', args) : run('workspace_set', args);
    if (!ok) return;
    setDialog(null);
    setFitSignal((n) => n + 1);
    if (dialog === 'new') {
      setPanel(null); // a new file always opens in the design view
      handleRef.current = null;
      setFileName(null);
      setSavedDoc(d.getDoc());
    }
  };
  const saveGcode = () => {
    // from the Design tab (File menu) the job is worked out now, since it is not kept up to date there
    const j = laserTab ? job : buildLaserJob(doc, { onlyIds: onlySelected && selection.length ? selection : undefined, anchor: jobAnchor, startFrom, order });
    if (j.empty) return;
    download(name + '.gcode', j.gcode, 'text/plain');
    d.say('ok', `Saved ${name}.gcode (${j.gcode.split('\n').length - 1} lines)`);
  };

  const settingsItems: MenuItem[] = [
    { label: 'Laser setup…', onClick: () => setLaserSetup(true) },
    { label: 'Rotary setup…', onClick: () => setRotaryOpen(true) },
    { label: 'Access (PIN)…', onClick: () => setAccessOpen(true) },
    { label: 'Camera…', onClick: () => setCameraSetup(true) },
    { label: 'CNC settings… (later)', disabled: true, onClick: () => undefined },
    'separator',
    { label: 'Appearance…', onClick: () => setAppearance(true) },
    { label: 'Toolbar… (later)', disabled: true, onClick: () => undefined },
    { label: 'Keyboard shortcuts… (later)', disabled: true, onClick: () => undefined },
  ];
  const fileItems: MenuItem[] = [
    { label: 'New design…', onClick: newDesign },
    { label: 'Open…', shortcut: 'Ctrl+O', onClick: openProject },
    { label: 'Open the example part', onClick: () => { d.replaceDoc(buildExample(doc), 'Example part added'); setFitSignal((n) => n + 1); } },
    'separator',
    { label: 'Save', shortcut: 'Ctrl+S', onClick: () => void save() },
    { label: 'Save as…', shortcut: 'Ctrl+Shift+S', onClick: () => void saveAs() },
    'separator',
    { label: 'Import DXF…', onClick: () => fileRef.current?.click() },
    { label: 'Export DXF', disabled: !doc.shapes.length, onClick: () => download(name + '.dxf', exportDxf(doc), 'application/dxf') },
    { label: 'Export SVG', disabled: !doc.shapes.length, onClick: () => download(name + '.svg', exportSvg(doc), 'image/svg+xml') },
    { label: 'Save laser G-code…', disabled: doc.shapes.length === 0, onClick: saveGcode },
    'separator',
  ];

  const n = selection.length;
  const hasGroup = selShapes.some((s) => s && s.group !== undefined);
  const openLines = selShapes.filter((s) => s && s.kind === 'path' && !s.closed).length;
  const hasTemplate = gmem.template.some((id) => doc.shapes.some((s) => s.id === id));

  const gadgetItems: MenuItem[] = [
    { label: 'Rotate each…', disabled: !n, onClick: () => setGadget('rotate') },
    { label: 'Sharpie Path Offset…', disabled: !n, onClick: () => setGadget('marker') },
    'separator',
    { label: `Set template from selection${hasTemplate ? ` (${gmem.template.length} set)` : ''}`, disabled: !n, onClick: () => { setGmem({ ...gmem, template: [...selection] }); d.say('ok', `Template set: ${n} shape${n === 1 ? '' : 's'}`); } },
    { label: 'Replace with template…', disabled: !hasTemplate || !n, onClick: () => setGadget('replace') },
    'separator',
    { label: 'Nudge to guide…', disabled: n < 2, onClick: () => setGadget('nudge') },
    { label: 'Count matching', disabled: n < 2, onClick: () => run('count_matching', { ids: selection, reference: selection[n - 1] }) },
    { label: 'Auto number…', disabled: !n, onClick: () => setGadget('number') },
  ];

  const layerItems = (verb: 'copy' | 'move'): MenuItem[] => [
    ...doc.layers.map((l) => ({
      label: l.name,
      checked: selShapes.length > 0 && selShapes.every((s) => s && s.layer === l.name),
      onClick: () => run(verb === 'copy' ? 'copy_to_layer' : 'set_layer', { ids: selection, layer: l.name }),
    })),
    'separator' as const,
    { label: 'New layer…', onClick: () => { setLayerAskName(''); setLayerAsk(verb); } },
  ];

  const ctxItems: MenuItem[] = [
    { label: 'Undo', shortcut: 'Ctrl+Z', disabled: !d.canUndo, onClick: d.undo },
    { label: 'Redo', shortcut: 'Ctrl+Y', disabled: !d.canRedo, onClick: d.redo },
    'separator',
    { label: 'Cut', shortcut: 'Ctrl+X', disabled: !n, onClick: cutSel },
    { label: 'Copy', shortcut: 'Ctrl+C', disabled: !n, onClick: copySel },
    { label: 'Paste', shortcut: 'Ctrl+V', disabled: !hasClip, onClick: pasteClip },
    { label: 'Duplicate', shortcut: 'Ctrl+D', disabled: !n, onClick: dupSel },
    { label: 'Delete', shortcut: 'Del', disabled: !n, onClick: () => run('delete', { ids: selection }) },
    { label: 'Remove duplicate shapes', disabled: doc.shapes.length < 2, onClick: () => run('remove_duplicates', {}) },
    'separator',
    {
      label: 'Selection',
      children: [
        { label: 'Select all', shortcut: 'Ctrl+A', disabled: !doc.shapes.length, onClick: () => setSelection(doc.shapes.map((x) => x.id)) },
        { label: 'Select all open vectors', disabled: !doc.shapes.some((x) => x.kind === 'path' && !x.closed), onClick: () => setSelection(doc.shapes.filter((x) => x.kind === 'path' && !x.closed).map((x) => x.id)) },
        { label: 'Select none', shortcut: 'Esc', disabled: !n, onClick: () => setSelection([]) },
        { label: 'Invert selection', disabled: !doc.shapes.length, onClick: () => setSelection(doc.shapes.map((x) => x.id).filter((id) => !selection.includes(id))) },
        { label: 'Select everything on this layer', disabled: !n, onClick: () => { const ls = new Set(selShapes.map((x) => x!.layer)); setSelection(doc.shapes.filter((x) => ls.has(x.layer)).map((x) => x.id)); } },
      ],
    },
    { label: 'Activate layer of selection', disabled: !n, onClick: () => { const first = selShapes[0]; if (first) setActiveLayer(first.layer); } },
    'separator',
    { label: 'Group objects', shortcut: 'Ctrl+G', disabled: n < 2, onClick: () => groupSel(false) },
    { label: 'Ungroup objects', shortcut: 'Ctrl+Shift+G', disabled: !hasGroup, onClick: () => groupSel(true) },
    'separator',
    {
      label: 'Join / Close vectors',
      disabled: openLines === 0,
      children: [
        { label: 'With a line', onClick: () => run('join', { ids: selection, mode: 'line' }) },
        { label: 'With a smooth curve', onClick: () => run('join', { ids: selection, mode: 'curve' }) },
        { label: 'Move end points', onClick: () => run('join', { ids: selection, mode: 'move' }) },
      ],
    },
    { label: tool === 'nodes' ? 'Select mode' : 'Node edit mode', shortcut: tool === 'nodes' ? 'V' : 'N', onClick: () => setTool(tool === 'nodes' ? 'select' : 'nodes') },
    { label: 'Array…', disabled: !n, onClick: () => setArraying(true) },
    'separator',
    { label: 'Copy to layer', disabled: !n, children: layerItems('copy') },
    { label: 'Move to layer', disabled: !n, children: layerItems('move') },
  ];

  const summary = selShapes.length
    ? `${selShapes.length} shape${selShapes.length > 1 ? 's' : ''}${selBounds ? ` · ${(selBounds.maxX - selBounds.minX).toFixed(2)} × ${(selBounds.maxY - selBounds.minY).toFixed(2)} mm` : ''}${selArea > 0 ? ` · ${selArea.toFixed(1)} mm²` : ''}${hasGroup ? ' · grouped' : ''}`
    : '';

  // only the Design tab draws: the other pages can select and move, and the drawing tools' keys do nothing there
  useEffect(() => { if (panel && tool !== 'select' && tool !== 'pan') setTool('select'); }, [panel, tool]);
  const askLayer = (e: React.FormEvent) => {
    e.preventDefault();
    const nm = layerAskName.trim();
    if (!nm || !layerAsk) return;
    if (run(layerAsk === 'copy' ? 'copy_to_layer' : 'set_layer', { ids: selection, layer: nm, create: true })) { setActiveLayer(nm); setLayerAsk(null); }
  };

  const pickCtx: ToolPickContext = {
    lib: toolLib, machine: jobCnc.machine ?? '', material: jobCnc.material ?? '',
    setFilters: (f) => { run('cnc_job_set', f, false); },
    addTool: (tool) => run('cnc_tool_set', { tool }),
    say: d.say,
  };

  return (
    <ToolPickProvider value={pickCtx}>
    <div className="app">
      <header className="header">
        <div className="brand" aria-label="DemonX Design">
          <img src="/dx-mark.png" alt="" className="brand-mark" width="66" height="40" />
          <img src="/design-wordmark.png" alt="DemonX Design" className="brand-name" width="152" height="28" />
        </div>
        <DropMenu label="File" items={fileItems} />
        <DropMenu label="Gadgets" items={gadgetItems} />
        <DropMenu label="Settings" items={settingsItems} />
        <button className="btn setup-btn" onClick={() => setDialog('edit')} title="Change the size of the job (laser work area or CNC material)">⚙ {jobSummary}</button>
        <button className="docname" title={fileName ? `${fileName} (click to rename or save a copy)` : 'Not saved yet. Click to name it and save'} onClick={() => setNameAsk(name)}>{dirty && <span className="dot" title="Unsaved changes">● </span>}<b>{name}</b></button>
        <LayerPicker doc={doc} active={activeLayer} setActive={setActiveLayer} run={run} />
        <div className="spacer" />
        <button className="btn" onClick={d.undo} disabled={!d.canUndo} title="Undo (Ctrl+Z)" aria-label="Undo">↶</button>
        <button className="btn" onClick={d.redo} disabled={!d.canRedo} title="Redo (Ctrl+Y)" aria-label="Redo">↷</button>
        <button className="btn" onClick={() => setFitSignal((n) => n + 1)} title="Fit the drawing in view (F)">Fit</button>
        {panel === 'laser' && <button className="btn primary" disabled={job.empty || jobStale} onClick={saveGcode}>Save G-code</button>}
        <button className="btn ghost" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} title="Light or dark">{theme === 'dark' ? '☀' : '☾'}</button>
      </header>
      <nav className="tabbar" role="tablist" aria-label="Design, Laser or CNC">
        <button role="tab" aria-selected={!panel} className={'maintab' + (!panel ? ' on' : '')} onClick={() => goTab('design')} title="Draw and arrange the design: shapes, layers, the work area">Design</button>
        <button role="tab" aria-selected={panel === 'laser'} className={'maintab' + (panel === 'laser' ? ' on' : '')} onClick={() => goTab('laser')} title="Laser: layer settings, the job, and the laser's controls">Laser</button>
        <button role="tab" aria-selected={panel === 'cnc'} className={'maintab' + (panel === 'cnc' ? ' on' : '')} onClick={() => goTab('cnc')} title="CNC: toolpaths and post processors">CNC</button>
              {panel === 'laser' && (
          <span className="tabbar-actions">
            <button className="btn small" disabled={ruidaConnected ? !est.at.length : job.empty} onClick={() => setPreviewOpen(true)} title="See the burn path and the time before sending it">Preview…</button>
            <span className="mono small" title="Estimated time">{est.at.length ? clock(est.totalSeconds) : ''}</span>
          </span>
        )}
      </nav>
      <input ref={bitmapRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/bmp" hidden aria-label="Bitmap file" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) setBitmapFile(f); }} />
      <input ref={fileRef} type="file" accept=".dxf" hidden onChange={(e) => onImport(e.target.files?.[0])} />
      <input ref={openRef} type="file" accept=".dxd,.json" hidden onChange={async (e) => {
        const f = e.target.files?.[0];
        if (openRef.current) openRef.current.value = '';
        if (f) loadProject(await f.text(), f.name, null);
      }} />
      {banner && (
        <div className={'banner ' + banner.kind} role={banner.kind === 'err' ? 'alert' : 'status'}>
          <span>{banner.text}</span>
          <button className="btn small" onClick={() => setBanner(null)}>Dismiss</button>
        </div>
      )}

      {liveText && <LiveTextBar s={liveText.s} set={(patch) => setLiveText((l) => (l ? { ...l, s: { ...l.s, ...patch } } : l))} editing={!!liveText.edit} onDone={commitLive} onCancel={cancelLive} refocus={() => setTimeout(() => liveInput.current?.focus(), 0)} problem={fontError} />}   {/* later, not at once: the Enter that confirmed a box would otherwise be typed into the text as a new line */}
      {panel !== 'cnc' && !liveText && <PropertiesBar doc={doc} selection={selection} anchor={anchor} setAnchor={setAnchor} lock={lock} setLock={setLock} run={run} yTop={yTop} />}

      <main className={'work ' + (panel ? 'tab-side' : 'tab-design')}>
        {!panel && <ToolBar yTop={yTop} doc={doc} onSelect={setSelection} canEditText={!!selTextInfo} onEditText={() => { if (selTextInfo && !selTextInfo.others.length) startLiveEdit(selection); else setEditingText(true); }}
          tool={tool} setTool={setTool} selection={selection} selShapes={selShapes as Shape[]} closedCount={closedCount} hasClip={hasClip} hasWork={doc.workspace.kind !== 'free'} run={run}
          copy={copySel} cut={cutSel} paste={pasteClip} duplicate={dupSel} openArray={() => setArraying(true)}
          offset={offset} setOffset={setOffset} corner={corner} setCorner={setCorner} snap={snap} setSnap={setSnap} objectSnap={objectSnap} setObjectSnap={setObjectSnap}
          onNew={() => void newDesign()} onOpen={() => void openProject()} onSave={() => void save()} onImport={() => fileRef.current?.click()} onBitmap={() => bitmapRef.current?.click()} onSettings={() => setShowKeys(true)}
        />}

        <div className="stage" onPointerUp={(e) => { if (liveText && (e.target as HTMLElement).tagName === 'CANVAS') setTimeout(() => liveInput.current?.focus(), 0); }} onPointerDownCapture={(e) => { if (liveText && (e.target as HTMLElement).tagName === 'CANVAS') commitLive(); }}>
          {liveText && (
            <textarea ref={liveInput} className="live-text-input" aria-label="Type the text here" value={liveText.s.text} maxLength={2000} spellCheck={false}
              onChange={(e) => { const v = e.target.value, c = e.target.selectionStart; setLiveText((l) => (l ? { ...l, s: { ...l.s, text: v }, caret: c } : l)); }}
              onSelect={(e) => { const c = e.currentTarget.selectionStart; setLiveText((l) => (l && l.caret !== c ? { ...l, caret: c } : l)); }} />
          )}
          {tool === 'circle' && !panel && <CirclePanel spec={circleSpec} setSpec={setCircleSpec} onClose={() => setTool('select')} onCreate={() => run('add_circle', { cx: circleSpec.x, cy: yTop === null ? circleSpec.y : yTop - circleSpec.y, r: circleRadius(circleSpec), layer: activeLayer })} />}
          {shapeTool && !panel && <ShapePanel spec={shapeSpecs[shapeTool]} setSpec={(sp) => { const n = { ...shapeSpecs, [shapeTool]: sp } as typeof DEFAULT_SHAPES; setShapeSpecsState(n); saveShapes(n, shapeAt); }} at={shapeAt} setAt={(a) => { setShapeAtState(a); saveShapes(shapeSpecs, a); }} onClose={() => setTool('select')} onCreate={() => { const sp = shapeSpecs[shapeTool]; if (!shapeValid(sp)) return; const { pts, closed } = buildShape(sp, shapeAt.x, yTop === null ? shapeAt.y : yTop - shapeAt.y); run('add_path', { points: pts.map((q) => [Math.round(q[0] * 1000) / 1000, Math.round(q[1] * 1000) / 1000]), closed, layer: activeLayer }); }} />}
          {tool === 'fillet' && !panel && <FilletPanel spec={filletSpec} setSpec={setFilletSpec} onClose={() => setTool('select')} said={d.log.length > filletLogStart.current && ['ok', 'err'].includes(d.log[d.log.length - 1].kind) ? d.log[d.log.length - 1] : null} />}
          {tool === 'measure' && !panel && <MeasurePanel m={measureM} yTop={yTop} onClear={() => { setMeasureM(null); setMeasureClear((n) => n + 1); }} onClose={() => setTool('select')} />}
          {tool === 'rect' && !panel && <RectPanel spec={rectSpec} setSpec={setRectSpec} onClose={() => setTool('select')} onCreate={() => { const [rx, ry] = rectOrigin(rectSpec, rectSpec.x, yTop === null ? rectSpec.y : yTop - rectSpec.y); run('add_rect', { x: rx, y: ry, w: rectSpec.w, h: rectSpec.h, layer: activeLayer, ...(corner.onNew && corner.radius > 0 ? { radius: corner.radius, style: corner.style } : {}) }); }} />}
          {tool === 'nodes' && <div className="nodes-float"><NodesPanel doc={doc} selection={selection} nodeSel={nodeSel} setNodeSel={setNodeSel} corner={corner} run={run} /></div>}
          <Canvas onContext={(x, y) => setCtx({ x, y })} nodeSel={nodeSel} setNodeSel={setNodeSel} rectCorner={corner.onNew ? corner : { radius: 0, style: 'round' }} onText={(p) => startLiveNew([Math.round(p[0] * 1000) / 1000, Math.round(p[1] * 1000) / 1000])} liveText={livePreview} textHandle={textHandle} onDoubleClickAt={onDoubleClickAt} doc={canvasDoc} selection={selection} setSelection={setSelection} tool={tool} setTool={setTool} snap={snap} objectSnap={objectSnap} activeLayer={activeLayer} run={run} fitSignal={fitSignal} work={work} rulerFromTop={yTop !== null} originMark={panel === 'laser' ? originMark : null} circleRadius={tool === 'circle' && !panel ? circleRadius(circleSpec) : null} rectSpec={tool === 'rect' && !panel ? rectSpec : null} shapeSpec={shapeTool && !panel ? shapeSpecs[shapeTool] : null} onMeasure={setMeasureM} clearSignal={measureClear} filletSpec={tool === 'fillet' && !panel ? filletSpec : null} sizeMode={tool === 'circle' ? circleSpec.mode : shapeAt.mode} onPlaced={(p) => { const place = { x: Math.round(p[0] * 1000) / 1000, y: Math.round((yTop === null ? p[1] : yTop - p[1]) * 1000) / 1000 }; if (tool === 'rect') setRectSpecState((r) => ({ ...r, ...place })); else if (shapeTool) setShapeAtState((a) => ({ ...a, ...place })); else setCircleSpecState((c) => ({ ...c, ...place })); }} headMark={panel === 'laser' && ruidaConnected && work && laser.state?.status.wpos ? [work.minX + laser.state.status.wpos.x, work.maxY - laser.state.status.wpos.y] : panel === 'cnc' && simFr ? [simFr.x, simFr.y] : null} dimOff={panel === 'laser'} overlay={panel === 'laser' && preview && !job.empty ? job.moves : panel === 'cnc' && cncOverlay.length ? cncOverlay : null} materialColor={panel === 'cnc' ? cncView.colours.material : null} reliefs={panel === 'cnc' ? reliefPics : undefined} onCursor={(p, scale, step, label) => setCursor({ p, scale, step, label })} />
          {(
            <div className="cmd-drawer" role="region" aria-label="Command line panel" hidden={!cmdOpen}>
              <div className="log" ref={logRef} aria-live="polite">
                {d.log.map((l, i) => <div key={i} className={'log-' + l.kind}>{l.kind === 'in' ? '› ' : ''}{l.text}</div>)}
              </div>
              <form className="row" onSubmit={(e) => { e.preventDefault(); d.runLine(line); setLine(''); }}>
                <input className="mono" value={line} onChange={(e) => setLine(e.target.value)} placeholder="rect 0 0 50 30   ·   help" aria-label="Command line" spellCheck={false} autoComplete="off" />
              </form>
            </div>
          )}
          <div className="statusbar">
            <button className="chev" aria-expanded={cmdOpen} title="Show or hide the command line and its log" onClick={() => setCmdOpen(!cmdOpen)}>{cmdOpen ? '⌄' : '⌃'} Command line</button>
            <span className="mono">{cursor.p ? `X ${cursor.p[0].toFixed(2)}  Y ${(yTop === null ? cursor.p[1] : yTop - cursor.p[1]).toFixed(2)} mm` : 'X –  Y – mm'}</span>
            {cursor.label && <span className="snap-label">⌖ {cursor.label}</span>}
            {summary && <span className="mono sel-summary">{summary}</span>}
            <span className="muted">{snap && cursor.step ? `snap ${cursor.step} mm` : 'snap off'} · {cursor.scale.toFixed(1)} px/mm</span>
            {outside > 0 && <span className="chip-warn" role="status">⚠ {outside} shape{outside > 1 ? 's' : ''} outside the {ws.kind === 'laser' ? 'work area' : 'material'}</span>}
            <span className="muted hint" title={hint}>{hint}</span>
          </div>
        </div>

        {panel && <aside className={'side' + (panel === 'laser' ? ' two' : '')} aria-label={panel === 'laser' ? 'Laser tools' : 'CNC tools'}>
          {panel === 'laser' && (
            <>
              <SideBox id="laser-top" label="Layers and job" tabs={[
                { key: 'layers', label: 'Layers', node: <LaserLayers doc={doc} active={activeLayer} setActive={setActiveLayer} run={run} /> },
                { key: 'job', label: 'Job', node: <JobPanel ruida={ruidaConnected} doc={doc} job={job} anchor={jobAnchor} setAnchor={setJobAnchor} startFrom={startFrom} setStartFrom={setStartFrom} onSetup={() => setDialog('edit')} onLaserSetup={() => setLaserSetup(true)} onlySelected={onlySelected} setOnlySelected={setOnlySelected} hasSelection={selection.length > 0} preview={preview} setPreview={setPreview} run={run} onSave={saveGcode} order={order} setOrder={setOrder} est={est} info={ruidaConnected ? ruidaJob.info ?? [] : job.stats.info ?? []} onPreview={() => setPreviewOpen(true)} /> },
                { key: 'positions', label: 'Positions', node: <PositionsPanel laser={laser} /> },
              ]} />
              <SideBox id="laser-bottom" label="Laser" focus={monitorFocus} tabs={[
                { key: 'laser', label: 'Laser', node: <LaserControl laser={laser} doc={doc} job={job} ruida={ruidaJob} stale={jobStale} jobError={jobError} startFrom={startFrom} startMode={rStart} setStartMode={setRStartMode} absoluteStart={absoluteStart} anchor={jobAnchor} setAnchor={setJobAnchor} run={run} onStarted={(head) => { setMonitor({ moves: liveMoves, est, start: head }); setMonitorShown(true); }} onMonitor={monitor ? () => setMonitorShown(true) : undefined} onAccess={() => setAccessOpen(true)} /> },
                { key: 'monitor', label: 'Monitor', node: monitor && monitorLive
                  ? (monitorShown ? <p className="muted small" style={{ padding: 10 }}>The monitor is open as a card over the drawing. Close it there (✕ to tab) to see it here.</p>
                    : <JobMonitor docked job={monitor} onClose={() => setMonitorShown(true)} onStop={() => laser.send({ type: 'stop' })} live={monitorLive} />)
                  : <p className="muted small" style={{ padding: 10 }}>No job has been started yet. When one starts, its path, progress and time show here (and in a card over the drawing, which you can close to this tab).</p> },
                { key: 'library', label: 'Library', node: <MaterialLibrary doc={doc} active={activeLayer} run={run} /> },
                { key: 'camera', label: 'Camera', node: <CameraCard onSetup={() => setCameraSetup(true)} /> },
              ]} />
            </>
          )}
          {panel === 'cnc' && (
            <CncPanel doc={doc} run={run} selection={selection} onSetup={() => setDialog('edit')} files={cncFiles} posts={posts} setPosts={setPosts} post={postDef} home={home} setHome={setHome}
              view={cncView} savePreview={savePreviewImage} newToolpath={(k) => setTpDialog({ kind: k, existing: null })} newInlay={() => setInlayDialog(true)} openLibrary={() => setLibOpen(true)} importStl={() => setStlOpen(true)} editToolpath={(tp) => setTpDialog({ kind: tp.kind, existing: tp })}
              editTool={(t) => setToolDialog({ tool: t })} saveFile={saveToolFile} say={d.say} />
          )}
        </aside>}
      </main>
      {stlOpen && <ReliefDialog doc={doc} colour={cncView.colours.material} onCreate={(a) => { if (run('relief_add', a)) setStlOpen(false); }} onClose={() => setStlOpen(false)} />}
      {libOpen && <ToolDatabase mode="manage" lib={toolLib} machine={pickCtx.machine} material={pickCtx.material} setFilters={pickCtx.setFilters} jobTools={cncOf(doc).tools} onUse={(tool) => run('cnc_tool_set', { tool })} onClose={() => setLibOpen(false)} say={d.say} />}
      {inlayDialog && <InlayDialog doc={doc} cnc={cncOf(doc)} selection={selection} onCreate={(a) => { if (run('cnc_inlay_add', a)) setInlayDialog(false); }} onClose={() => setInlayDialog(false)} />}
      {tpDialog && tpDialog.kind === 'photo' && <PhotoDialog doc={doc} cnc={cncOf(doc)} existing={tpDialog.existing}
        onCreate={(a) => { if (run('cnc_toolpath_add', a)) setTpDialog(null); }} onUpdate={(a) => { if (run('cnc_toolpath_update', a)) setTpDialog(null); }} onClose={() => setTpDialog(null)} />}
      {tpDialog && (tpDialog.kind === 'finish3d' || tpDialog.kind === 'rough3d') && <Finish3dDialog doc={doc} cnc={cncOf(doc)} kind={tpDialog.kind} existing={tpDialog.existing}
        onCreate={(a) => { if (run('cnc_toolpath_add', a)) setTpDialog(null); }} onUpdate={(a) => { if (run('cnc_toolpath_update', a)) setTpDialog(null); }} onClose={() => setTpDialog(null)} />}
      {tpDialog && tpDialog.kind !== 'photo' && tpDialog.kind !== 'finish3d' && tpDialog.kind !== 'rough3d' && <ToolpathDialog doc={doc} cnc={cncOf(doc)} kind={tpDialog.kind} existing={tpDialog.existing} selection={selection}
        onCreate={(a) => { if (run('cnc_toolpath_add', a)) setTpDialog(null); }} onUpdate={(a) => { if (run('cnc_toolpath_update', a)) setTpDialog(null); }} onClose={() => setTpDialog(null)} />}
      {toolDialog && <ToolDialog tool={toolDialog.tool} existingIds={cncOf(doc).tools.map((t) => t.id)} inUse={!!toolDialog.tool && cncOf(doc).toolpaths.some((tp) => tp.toolId === toolDialog.tool!.id)}
        onSave={(t) => { if (run('cnc_tool_set', { tool: t })) setToolDialog(null); }} onDelete={(id) => { if (run('cnc_tool_delete', { id })) setToolDialog(null); }} onClose={() => setToolDialog(null)} />}
      {ctx && <ContextMenu x={ctx.x} y={ctx.y} items={ctxItems} onClose={() => setCtx(null)} />}
      {gadget && <GadgetDialog kind={gadget} doc={doc} selection={selection} memory={gmem} setMemory={setGmem} run={run} onClose={() => setGadget(null)} />}
      {nameAsk !== null && (
        <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && closeNameAsk(null)}>
          <form className="modal" role="dialog" aria-modal="true" aria-label="Name and save" onSubmit={(e) => { e.preventDefault(); if (nameAsk.trim()) closeNameAsk(nameAsk); }}>
            <h2>Name and save</h2>
            <p className="small muted">{fileName ? 'Save this design under a new name.' : 'Give this design a name, then choose where to keep it.'}</p>
            <input autoFocus value={nameAsk} onChange={(e) => setNameAsk(e.target.value)} aria-label="Design name" onFocus={(e) => e.currentTarget.select()} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); closeNameAsk(null); } }} />
            <div className="row end">
              <button type="button" className="btn" onClick={() => closeNameAsk(null)}>Cancel</button>
              <button type="submit" className="btn primary" disabled={!nameAsk.trim()}>Save</button>
            </div>
          </form>
        </div>
      )}
      {monitor && monitorShown && laser.state?.kind === 'ruida' && (
        <JobMonitor job={monitor} onClose={closeMonitorCard} onStop={() => laser.send({ type: 'stop' })} live={monitorLive!} />
      )}
      <span hidden data-jobs={laserTab ? (jobStale ? 'busy' : 'ready') : 'off'} />
      {previewOpen && <JobPreview moves={liveMoves} est={est} onClose={() => setPreviewOpen(false)} />}
      {cameraSetup && <CameraSetup onClose={() => setCameraSetup(false)} onSaved={() => undefined} />}
      {accessOpen && <AccessDialog laser={laser} onClose={() => setAccessOpen(false)} />}
      {rotaryOpen && <RotaryDialog laser={laser} onClose={() => setRotaryOpen(false)} />}
      {laserSetup && <LaserSetup doc={doc} run={run} laser={laser} onClose={() => setLaserSetup(false)} />}
      {appearance && <AppearanceDialog theme={theme} setTheme={setTheme} colors={colors} onClose={() => setAppearance(false)} />}
      {layerAsk && (
        <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && setLayerAsk(null)}>
          <form className="modal" role="dialog" aria-modal="true" aria-label="New layer" onSubmit={askLayer}>
            <h2>New layer</h2>
            <p className="small muted">{layerAsk === 'copy' ? 'Copies the selected shapes to a new layer.' : 'Moves the selected shapes to a new layer.'}</p>
            <input autoFocus value={layerAskName} onChange={(e) => setLayerAskName(e.target.value)} placeholder="Layer name" aria-label="Layer name" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setLayerAsk(null); } }} />
            <div className="row end">
              <button type="button" className="btn" onClick={() => setLayerAsk(null)}>Cancel</button>
              <button type="submit" className="btn primary" disabled={!layerAskName.trim()}>{layerAsk === 'copy' ? 'Copy' : 'Move'}</button>
            </div>
          </form>
        </div>
      )}
      {showKeys && <ShortcutsDialog onClose={() => setShowKeys(false)} />}
      {bitmapFile && <Suspense fallback={null}><TraceDialog file={bitmapFile} onApply={(shapes) => { setBitmapFile(null); run('add_traced', { shapes, layer: activeLayer }); }} onCancel={() => setBitmapFile(null)} /></Suspense>}
      {editingText && selTextInfo && <Suspense fallback={null}><TextDialog at={[0, 0]} edit={{ text: selTextInfo.rec.text, font: selTextInfo.rec.font, height: selTextInfo.height, align: selTextInfo.rec.align, spacing: selTextInfo.spacing, lineSpacing: selTextInfo.rec.lineSpacing, weld: selTextInfo.rec.weld, ...(selTextInfo.rec.curve ? { curve: { offset: selTextInfo.rec.curve.offset, flip: selTextInfo.rec.curve.flip } } : {}), curveId: selTextInfo.others.length === 1 ? selTextInfo.others[0] : null }} onApply={(a) => { setEditingText(false); run('edit_text', { ...a, ids: selection }); }} onCancel={() => setEditingText(false)} /></Suspense>}
      {textAt && <Suspense fallback={null}><TextDialog at={textAt} onApply={(a) => { setTextAt(null); setTool('select'); run('add_text', { ...a, layer: activeLayer }); }} onCancel={() => setTextAt(null)} /></Suspense>}
      {arraying && selection.length > 0 && <ArrayDialog count={selection.length} centre={selBounds ? [(selBounds.minX + selBounds.maxX) / 2, (selBounds.minY + selBounds.maxY) / 2] : null} onApply={(a) => { setArraying(false); run('array', { ids: selection, ...a }); }} onCancel={() => setArraying(false)} />}
      {asking && (
        <div className="modal-back">
          <div className="modal" role="dialog" aria-modal="true" aria-label="Unsaved changes">
            <h2>Save your changes?</h2>
            <p className="small">{name} has changes that are not saved. If you carry on without saving they are lost.</p>
            <div className="row end">
              <button className="btn" onClick={() => asking.done('cancel')}>Cancel</button>
              <button className="btn danger" onClick={() => asking.done('discard')}>Don't save</button>
              <button className="btn primary" autoFocus onClick={() => asking.done('save')}>Save</button>
            </div>
          </div>
        </div>
      )}
      {dialog === 'new' && <NewDesignDialog replaces={doc.shapes.length > 0} onApply={applyJob} onCancel={() => setDialog(null)} />}
      {dialog === 'edit' && <JobSetup mode="edit" doc={doc} onApply={applyJob} onCancel={() => setDialog(null)} />}
    </div>
    </ToolPickProvider>
  );
}
