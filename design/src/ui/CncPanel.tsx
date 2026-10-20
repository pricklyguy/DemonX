import { useRef, useState } from 'react';
import type { CncTool, Toolpath, ToolpathKind } from '../core/cnc';
import { CNC_CANVAS_NOTE, cncOf, type GcodeFile } from '../core/cncjob';
import { formatTime } from '../core/laser';
import { anchorName } from '../core/laser';
import { BUILT_IN_POSTS, parsePost, PostError, type PostDef } from '../core/post';
import type { Doc } from '../core/types';
import { reliefHeightMm } from '../core/relief';
import { Icon } from './icons';
import { useToolPick } from './toolPicker';
import { libraryFilters } from '../core/toollib';
import { SIM_SPEEDS, type CncView } from './cncView';
import { NumField } from './NumField';

/** The toolpath picker: an icon each, with the name as hover text. Only the ones DemonX Design can make are on. */
const OPS: { id: string; kind?: ToolpathKind; special?: 'inlay'; noSelection?: boolean; needsRelief?: boolean; label: string; hint: string }[] = [
  { id: 'profile', kind: 'profile', label: 'Profile toolpath', hint: 'Cut around, inside or along the selected shapes' },
  { id: 'pocket', kind: 'pocket', label: 'Pocket toolpath', hint: 'Clear out the inside of the selected closed shapes' },
  { id: 'drill', kind: 'drill', label: 'Drill toolpath', hint: 'Drill at the middle of each selected shape' },
  { id: 'engrave', kind: 'engrave', label: 'Engraving toolpath', hint: 'Follow the selected lines and outlines, open or closed, at a shallow depth' },
  { id: 'inlay', special: 'inlay', label: 'Inlay toolpath', hint: 'Matching pocket and plug for an inlay' },
  { id: 'vcarve', kind: 'vcarve', label: 'V-bit toolpath', hint: 'Carve with a V-bit, deeper where the shape is wider' },
  { id: 'photo', kind: 'photo', noSelection: true, label: 'Photo toolpath', hint: 'Engrave a picture as dots or lines' },
  { id: 'rough3d', kind: 'rough3d', noSelection: true, needsRelief: true, label: '3D roughing toolpath', hint: 'Clear most of the material from a 3D shape' },
  { id: 'finish3d', kind: 'finish3d', noSelection: true, needsRelief: true, label: '3D finishing toolpath', hint: 'Cut the final surface of a 3D shape' },
];

type Run = (id: string, args: unknown, echo?: boolean) => boolean;

export interface CustomPost { name: string; text: string }

/** CNC: the job, the toolpaths, the tools and the G-code (one file per tool). */
export function CncPanel({ doc, run, selection, onSetup, files, posts, setPosts, post, home, setHome, view, savePreview, newToolpath, newInlay, openLibrary, importStl, editToolpath, editTool, saveFile, say }: {
  doc: Doc;
  run: Run;
  selection: number[];
  onSetup: () => void;
  files: GcodeFile[];
  posts: CustomPost[];
  setPosts: (p: CustomPost[]) => void;
  post: PostDef;
  home: { x: number; y: number };
  setHome: (h: { x: number; y: number }) => void;
  view: CncView;
  savePreview: () => void;
  newToolpath: (k: ToolpathKind) => void;
  newInlay: () => void;
  openLibrary: () => void;
  importStl: () => void;
  editToolpath: (tp: Toolpath) => void;
  editTool: (t: CncTool | null) => void;
  saveFile: (f: GcodeFile, ext: string) => void;
  say: (kind: 'ok' | 'err' | 'info', text: string) => void;
}) {
  const ws = doc.workspace;
  const cnc = cncOf(doc);
  // a canvas has no machine: nothing is made for one until the design is made a CNC job
  const canvas = ws.kind === 'canvas';
  const [thick, setThick] = useState(18);
  const pick = useToolPick();
  const filters = pick ? libraryFilters(pick.lib, pick.machine) : { machines: [], materials: [] };
  const ppRef = useRef<HTMLInputElement>(null);
  const names = [...BUILT_IN_POSTS.map((p) => p.name), ...posts.map((p) => p.name)];
  const n = selection.length;
  const warnings = files.flatMap((f) => f.warnings);

  const importPost = async (file: File | undefined) => {
    if (ppRef.current) ppRef.current.value = '';
    if (!file) return;
    if (file.size > 1_000_000) { say('err', 'That post processor file is over 1 MB'); return; }
    try {
      const text = await file.text();
      const def = parsePost(text);
      if (BUILT_IN_POSTS.some((b) => b.name === def.name)) { say('err', `"${def.name}" is the name of a built-in post. Rename it in the file first.`); return; }
      setPosts([...posts.filter((p) => p.name !== def.name), { name: def.name, text }]);
      run('cnc_post_set', { name: def.name }, false);
      say('ok', `Loaded post processor ${def.name}`);
    } catch (e) {
      say('err', e instanceof PostError ? e.message : 'Could not read that post processor: ' + (e as Error).message);
    }
  };

  return (
    <>
      <section className="panel">
        <h2><span>Job</span></h2>
        <div className="body">
          {canvas ? (
            <div className="notice" role="group" aria-label="This design is a canvas">
              <span className="small">This design is a canvas (no machine). No toolpaths or G-code are made until you make it a CNC job. Your drawing stays exactly as it is.</span>
              <div className="row wrap">
                <label className="inline small">Thickness (Z) <NumField label="Material thickness for the CNC job" value={thick} min={0.01} step={1} width={70} onCommit={setThick} /><small>mm</small></label>
                <button className="btn small primary" disabled={!(thick > 0)} onClick={() => run('workspace_set', { kind: 'cnc', width: ws.width, height: ws.height, thickness: thick, datum: 'bl', zZero: 'surface', sides: 1 })}>Make it a CNC job</button>
              </div>
            </div>
          ) : ws.kind !== 'cnc' ? (
            <div className="notice">
              <span className="small">This project is not set up for CNC, so there is no material size to check against.</span>
              <button className="btn small" onClick={onSetup}>Set up a CNC job…</button>
            </div>
          ) : (
            <>
              <div className="mono small">{ws.width} × {ws.height} × {ws.thickness} mm · {ws.sides === 2 ? 'double sided' : 'single sided'}</div>
              <div className="small muted">Z zero at the {ws.zZero === 'surface' ? 'material surface' : 'machine bed'} · XY datum {anchorName(ws.datum)}</div>
              <button className="btn small" onClick={onSetup}>Job setup…</button>
              {pick && (pick.lib.tools.length === 0 ? <p className="muted small">Load your tool library (the Library icon) to choose the machine and material and pick tools with their cutting recipes.</p> : (
                <>
                  <label className="stack small">Machine <select aria-label="Job machine" value={pick.machine} onChange={(e) => pick.setFilters({ machine: e.target.value, material: '' })}><option value="">Any</option>{filters.machines.map((m) => <option key={m} value={m}>{m}</option>)}</select></label>
                  <label className="stack small">Material <select aria-label="Job material" value={pick.material} onChange={(e) => pick.setFilters({ material: e.target.value })}><option value="">Any</option>{filters.materials.map((m) => <option key={m} value={m}>{m}</option>)}</select></label>
                </>
              ))}
            </>
          )}
        </div>
      </section>

      <section className="panel">
        <h2><span>Toolpaths</span></h2>
        <div className="body">
          <div className="tp-ops" role="toolbar" aria-label="Toolpath operations">
            {OPS.map((o) => (
              <button key={o.id} className="tp-op" aria-label={o.label} title={o.kind || o.special ? o.hint + (o.needsRelief && !(doc.reliefs ?? []).length ? ' (import a 3D shape first)' : n || o.noSelection ? '' : ' (select shapes first)') : o.label.replace(' toolpath', '') + ': ' + o.hint + ' (coming)'}
                disabled={!(o.kind || o.special) || (!n && !o.noSelection) || canvas || (!!o.needsRelief && !(doc.reliefs ?? []).length)} onClick={() => (o.special ? newInlay() : o.kind && newToolpath(o.kind))}><Icon name={'tp-' + o.id} size={26} /></button>
            ))}
            <button className="tp-op" aria-label="Tool library" title="Tool library: your cutters and their cutting recipes" onClick={openLibrary}><Icon name="tp-library" size={26} /></button>
          </div>
          {canvas ? <p className="warn small">{CNC_CANVAS_NOTE}</p> : !n && <p className="muted small">Select shapes in the drawing, then pick the kind of toolpath.</p>}
          {cnc.toolpaths.length === 0 ? <p className="muted small">No toolpaths yet.</p> : cnc.toolpaths.map((tp) => {
            const tool = cnc.tools.find((t) => t.id === tp.toolId);
            return (
              <div key={tp.id} className="tprow">
                <input type="checkbox" checked={tp.visible} aria-label={`Include ${tp.name}`} title="Show in the preview and write to the G-code" onChange={(e) => run('cnc_toolpath_update', { id: tp.id, visible: e.target.checked }, false)} />
                <button className={'nm linkbtn' + (view.chosen.includes(tp.id) ? ' on' : '')} aria-pressed={view.chosen.includes(tp.id)} title="Click to choose it for Preview selected" onClick={() => view.toggleChosen(tp.id)}>{tp.name}</button>
                <button className="iconbtn" aria-label={`Edit ${tp.name}`} title="Edit" onClick={() => editToolpath(tp)}>✎</button>
                <button className="iconbtn" aria-label={`Delete ${tp.name}`} title="Delete" onClick={() => run('cnc_toolpath_delete', { id: tp.id })}>✕</button>
                <span className="sub">{tp.kind}{tp.kind === 'profile' ? ` ${tp.side}` : ''} · {tool?.name ?? '?'} · {tp.startDepth}–{tp.cutDepth} mm · {tp.photo ? `${tp.photo.width} mm wide, ${tp.photo.mode}` : tp.scan ? `${(doc.reliefs ?? []).find((r) => r.id === tp.reliefId)?.name ?? '3D shape gone'}, lines along ${tp.scan.dir.toUpperCase()} ${tp.scan.stepoverMm} mm apart` : `${tp.shapeIds.length} shape${tp.shapeIds.length === 1 ? '' : 's'}`}</span>
              </div>
            );
          })}
        </div>
      </section>

      <section className="panel">
        <h2><span>3D shapes</span></h2>
        <div className="body">
          <button className="btn small" disabled={canvas} onClick={importStl} title={canvas ? CNC_CANVAS_NOTE : 'Bring in a 3D model (an STL file) to carve'}>Import STL…</button>
          {(doc.reliefs ?? []).length === 0 ? <p className="muted small">No 3D shapes yet. They will be cut by the 3D roughing and 3D finishing toolpaths (coming).</p> : (doc.reliefs ?? []).map((r) => (
            <div key={r.id} className="libtool">
              <div className="tprow" style={{ gridTemplateColumns: '22px minmax(0, 1fr) auto' }}>
                <input type="checkbox" checked={r.visible} aria-label={`Show ${r.name}`} title="Show it on the drawing" onChange={(e) => run('relief_update', { id: r.id, visible: e.target.checked }, false)} />
                <span className="nm" title={r.name}>{r.name}</span>
                <button className="iconbtn" aria-label={`Delete ${r.name}`} title="Remove this 3D shape" onClick={() => run('relief_delete', { id: r.id })}>✕</button>
                <span className="sub" style={{ gridColumn: '1 / -1' }}>{Math.round(r.width * 100) / 100} × {Math.round(reliefHeightMm(r) * 100) / 100} × {Math.round(r.depth * 100) / 100} mm</span>
              </div>
              <div className="row wrap" style={{ padding: '0 8px 6px' }}>
                <label className="inline small">X <NumField label={`X of ${r.name}`} value={Math.round(r.x * 100) / 100} step={5} width={60} onCommit={(v) => run('relief_update', { id: r.id, x: v }, false)} /></label>
                <label className="inline small">Y <NumField label={`Y of ${r.name}`} value={Math.round(r.y * 100) / 100} step={5} width={60} onCommit={(v) => run('relief_update', { id: r.id, y: v }, false)} /></label>
                <label className="inline small">Width <NumField label={`Width of ${r.name}`} value={Math.round(r.width * 100) / 100} min={0.5} step={5} width={64} onCommit={(v) => run('relief_update', { id: r.id, width: v }, false)} /></label>
                <label className="inline small">Height <NumField label={`Height of ${r.name}`} value={Math.round(r.depth * 100) / 100} min={0.1} step={1} width={60} onCommit={(v) => run('relief_update', { id: r.id, depth: v }, false)} /></label>
              </div>
            </div>
          ))}
        </div>
      </section>
      <section className="panel">
        <h2><span>Preview</span></h2>
        <div className="body">
          <div className="tp-ops pv" role="toolbar" aria-label="Preview">
            <button className={'tp-op' + (view.mode === 'all' ? ' on' : '')} aria-label="Preview all" aria-pressed={view.mode === 'all'} title="Preview all toolpaths" onClick={view.previewAll}><Icon name="pv-all" size={24} /></button>
            <button className={'tp-op' + (view.mode === 'selected' ? ' on' : '')} aria-label="Preview selected" aria-pressed={view.mode === 'selected'} disabled={!view.chosen.length} title={view.chosen.length ? 'Preview only the toolpaths you clicked in the list' : 'Click toolpaths in the list first'} onClick={view.previewSelected}><Icon name="pv-sel" size={24} /></button>
            <button className="tp-op" aria-label="Reset preview" title="Reset preview: hide the toolpaths and stop the simulation" onClick={view.reset}><Icon name="pv-reset" size={24} /></button>
            <button className="tp-op" aria-label="Save preview image" title="Save a picture of the drawing as it is now (PNG)" onClick={savePreview}><Icon name="pv-save" size={24} /></button>
            <button className={'tp-op' + (view.sim.playing ? ' on' : '')} aria-label={view.sim.playing ? 'Pause simulation' : 'Simulate'} title={view.sim.playing ? 'Pause the simulation' : 'Simulate: watch the tool cut'} disabled={!cnc.toolpaths.length} onClick={view.sim.playing ? view.pause : view.play}><Icon name={view.sim.playing ? 'pv-pause' : 'pv-play'} size={24} /></button>
          </div>
          <div className="row wrap">
            <input type="range" min={0} max={1000} value={Math.round(view.sim.t * 1000)} aria-label="Simulation position" onChange={(e) => view.seek(Number(e.target.value) / 1000)} style={{ flex: 1 }} disabled={!view.moves.length} />
            <select aria-label="Simulation speed" value={view.sim.speed} onChange={(e) => view.setSpeed(Number(e.target.value))}>
              {SIM_SPEEDS.map((v) => <option key={v} value={v}>{v}×</option>)}
            </select>
          </div>
          <div className="mono small" aria-live="off">{view.sim.frame ? `Z ${view.sim.frame.z.toFixed(2)} mm · ${Math.round(view.sim.t * 100)}%` : view.mode === 'off' ? 'Preview is off' : `${view.moves.length} moves shown`}</div>
          <div className="row wrap">
            <label className="inline small">Cut <input type="color" aria-label="Toolpath cut colour" value={view.colours.cut} onChange={(e) => view.setColours({ ...view.colours, cut: e.target.value })} /></label>
            <label className="inline small">Travel <input type="color" aria-label="Toolpath travel colour" value={view.colours.rapid} onChange={(e) => view.setColours({ ...view.colours, rapid: e.target.value })} /></label>
            <label className="inline small">Material <input type="color" aria-label="Material colour" value={view.colours.material} onChange={(e) => view.setColours({ ...view.colours, material: e.target.value })} /></label>
          </div>
        </div>
      </section>

      <section className="panel">
        <h2><span>G-code</span></h2>
        <div className="body">
          <label className="stack">Post processor
            <select aria-label="Post processor" value={post.name} onChange={(e) => run('cnc_post_set', { name: e.target.value }, false)}>
              {names.map((nm) => <option key={nm} value={nm}>{nm}</option>)}
            </select>
          </label>
          <div className="row wrap">
            <button className="btn small" onClick={() => ppRef.current?.click()} title="Load a post processor (.pp) from your computer. It is kept in this browser.">Load a .pp file…</button>
            <input ref={ppRef} type="file" accept=".pp,.txt" hidden aria-label="Post processor file" onChange={(e) => importPost(e.target.files?.[0])} />
          </div>
          <div className="row wrap">
            <label className="inline small">Home X <NumField label="Home X" value={home.x} step={10} width={64} onCommit={(v) => setHome({ ...home, x: v })} /></label>
            <label className="inline small">Y <NumField label="Home Y" value={home.y} step={10} width={64} onCommit={(v) => setHome({ ...home, y: v })} /><small>mm</small></label>
          </div>
          {files.length === 0 ? <p className="muted small">Make a toolpath to see its G-code here.</p> : files.map((f) => (
            <div key={f.tool.id} className="jobbox">
              <b className="small">{f.tool.name}</b>
              <div className="mono small">{f.toolpaths.map((t) => t.name).join(', ')}</div>
              <div className="mono small">{f.stats.lines} lines · cut {Math.round(f.stats.cutLength)} mm · est. {formatTime(f.stats.seconds)}</div>
              <button className="btn small primary" onClick={() => saveFile(f, post.extension)}>Save G-code for this tool</button>
            </div>
          ))}
          {warnings.map((w, i) => <div key={i} className="warn small">⚠ {w}</div>)}
          <button className="btn small" disabled title="Sending the file straight to DemonX CNC is the next step">Send to DemonX CNC (coming next)</button>
          <p className="muted small">One file per tool, so you change the bit between files. The first move of each file starts from the home position above.</p>
        </div>
      </section>
      <section className="panel" id="cnc-tools">
        <h2><span>Tools in this job</span></h2>
        <div className="body">
          {cnc.tools.map((t) => (
            <div key={t.id} className="tprow" style={{ gridTemplateColumns: 'minmax(0, 1fr) auto' }}>
              <span className="nm" title={t.name}>{t.name}</span>
              <button className="iconbtn" aria-label={`Edit tool ${t.name}`} title="Edit" onClick={() => editTool(t)}>✎</button>
              <span className="sub" style={{ gridColumn: '1 / -1' }}>⌀ {t.diameter} mm · {t.rpm} rpm · feed {t.feed} · plunge {t.plunge} · {t.stepdown} mm/pass</span>
            </div>
          ))}
          <div className="row wrap">
            <button className="btn small" onClick={openLibrary} title="Pick cutters from your tool library, with their cutting recipes">+ From the library…</button>
            <button className="btn small" onClick={() => editTool(null)}>+ New tool</button>
          </div>
        </div>
      </section>

    </>
  );
}
