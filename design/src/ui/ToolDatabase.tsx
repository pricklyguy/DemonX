import { useEffect, useMemo, useRef, useState } from 'react';
import type { CncTool, ToolKind } from '../core/cnc';
import { fingerprint } from '../core/hash';
import { bestRecipe, fitsJob, geometryGaps, geometryOk, isApproved, LIB_KINDS, libraryFilters, mergeLibraries, parseToolLibrary, toJobTool, type LibKind, type LibRecipe, type LibTool, type ToolLibrary } from '../core/toollib';
import { NumField } from './NumField';
import { saveToolLibrary } from './toolLibStore';

const KIND_NAME: Record<LibKind, string> = { flat: 'End mill', ball: 'Ball nose', vbit: 'V-bit', drill: 'Drill', other: 'Other (not cut by Design)' };
const STATUSES = ['Approved', 'Testing Required', 'Unapproved'];
const UNITS_KEY = 'design-library-units';
const MM = 25.4;
const readUnits = (): 'mm' | 'in' => { try { return localStorage.getItem(UNITS_KEY) === 'in' ? 'in' : 'mm'; } catch { return 'mm'; } };

type Ov = Partial<Pick<LibRecipe, 'rpm' | 'feed' | 'plunge' | 'passDepth' | 'stepoverMm'>>;

/**
 * The tool database: a big window to find a cutter, see and fix what the library knows about it, and see and change its cutting
 * recipe for the job's machine and material. `manage` is the library on its own; `pick` is for choosing the tool of a toolpath,
 * where the numbers can be changed for this cut only.
 */
export function ToolDatabase({ mode, lib, machine, material, setFilters, accept, jobTools, onUse, onClose, say }: {
  mode: 'manage' | 'pick';
  lib: ToolLibrary;
  machine: string;
  material: string;
  setFilters: (f: { machine?: string; material?: string }) => void;
  /** The kinds of cutter the toolpath can use (pick mode); anything when absent */
  accept?: (kind: ToolKind) => boolean;
  jobTools: CncTool[];
  /** Put the cutter in the job (and, in pick mode, choose it for the toolpath). Returns whether the job took it. */
  onUse: (tool: CncTool) => boolean;
  onClose: () => void;
  say: (kind: 'ok' | 'err' | 'info', text: string) => void;
}) {
  const pick = mode === 'pick';
  const { machines, materials } = useMemo(() => libraryFilters(lib, machine), [lib, machine]);
  const [q, setQ] = useState('');
  const [readyOnly, setReadyOnly] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const [ri, setRi] = useState(0);
  const [ov, setOv] = useState<Ov>({});
  const [units, setUnitsState] = useState<'mm' | 'in'>(readUnits);
  const [sure, setSure] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const cancel = useRef(onClose);
  cancel.current = onClose;
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); cancel.current(); } };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, []);
  const setUnits = (u: 'mm' | 'in') => { setUnitsState(u); try { localStorage.setItem(UNITS_KEY, u); } catch { /* not remembered */ } };
  const inch = units === 'in';
  const L = (mm: number) => (inch ? mm / MM : mm);           // a length or a feed, for the screen
  const fromL = (v: number) => (inch ? v * MM : v);          // and back to millimetres
  const dec = inch ? 5 : 3;
  const lu = inch ? 'in' : 'mm';
  const fu = inch ? 'in/min' : 'mm/min';

  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const usable = (t: LibTool) => !pick || !accept || (t.kind && t.kind !== 'other' && accept(t.kind as ToolKind));
  const shown = lib.tools.filter((t) => {
    if (!fitsJob(t, machine, material)) return false;
    if (readyOnly && !geometryOk(t)) return false;
    if (pick && !showAll && !(geometryOk(t) && usable(t))) return false;
    const hay = `${t.name} ${t.part ?? ''} ${t.manufacturer ?? ''} ${t.notes ?? ''}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  const groups = useMemo(() => {
    const m = new Map<string, LibTool[]>();
    for (const t of shown) (m.get(t.manufacturer ?? 'Other') ?? m.set(t.manufacturer ?? 'Other', []).get(t.manufacturer ?? 'Other')!).push(t);
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [shown]);
  const tool = lib.tools.find((t) => t.id === sel) ?? null;
  const recipes = tool ? tool.recipes.filter((r) => (!machine || r.machine === machine) && (!material || r.material === material)) : [];
  const best = tool ? bestRecipe(tool, machine, material) : undefined;
  const bestIdx = best ? Math.max(0, recipes.indexOf(best)) : 0;
  useEffect(() => { setRi(bestIdx); setOv({}); setSure(false); }, [sel, machine, material]);   // eslint-disable-line react-hooks/exhaustive-deps
  const recipe = recipes[Math.min(ri, Math.max(0, recipes.length - 1))];
  const shownR: LibRecipe | undefined = recipe ? { ...recipe, ...ov } : undefined;

  const update = async (id: string, patch: Partial<LibTool>) => {
    const err = await saveToolLibrary({ v: 1, tools: lib.tools.map((t) => (t.id === id ? { ...t, ...patch } : t)) });
    if (err) say('err', err);
  };
  const updateRecipe = async (t: LibTool, r: LibRecipe, patch: Partial<LibRecipe>) => {
    await update(t.id, { recipes: t.recipes.map((x) => (x === r ? { ...x, ...patch } : x)) });
  };
  const setNumber = (key: keyof Ov, v: number | undefined) => {
    if (!tool || !recipe) return;
    if (pick) setOv((o) => ({ ...o, [key]: v }));
    else void updateRecipe(tool, recipe, { [key]: v });
  };
  const addRecipe = async () => {
    if (!tool || !machine || !material) return;
    await update(tool.id, { recipes: [...tool.recipes, { machine, material, status: 'Testing Required' }] });
    setRi(recipes.length);
  };
  const removeRecipe = async () => { if (tool && recipe) await update(tool.id, { recipes: tool.recipes.filter((x) => x !== recipe) }); };
  const newTool = async () => {
    let n = lib.tools.length + 1, id = `U-${String(n).padStart(3, '0')}`;
    while (lib.tools.some((t) => t.id === id)) id = `U-${String(++n).padStart(3, '0')}`;
    const t: LibTool = { id, name: 'New tool', kind: null, recipes: [] };
    const err = await saveToolLibrary({ v: 1, tools: [...lib.tools, t] });
    if (err) say('err', err); else { setSel(id); setReadyOnly(false); setQ(''); }
  };
  const deleteTool = async () => {
    if (!tool) return;
    if (!sure) { setSure(true); return; }
    const err = await saveToolLibrary({ v: 1, tools: lib.tools.filter((t) => t.id !== tool.id) });
    if (err) say('err', err); else { setSel(null); setSure(false); }
  };
  const importFile = async (f: File | undefined) => {
    if (file.current) file.current.value = '';
    if (!f) return;
    if (f.size > 2 * 1024 * 1024) { say('err', 'That file is over 2 MB'); return; }
    try {
      const add = parseToolLibrary(JSON.parse(await f.text()));
      const { lib: merged, added, replaced } = mergeLibraries(lib, add);
      const err = await saveToolLibrary(merged);
      say(err ? 'err' : 'ok', err || `Loaded ${add.tools.length} tools (${added} new, ${replaced} replaced)`);
    } catch (e) { say('err', e instanceof SyntaxError ? 'That is not a JSON file' : (e as Error).message); }
  };
  const exportFile = () => {
    const a = document.createElement('a');
    const url = URL.createObjectURL(new Blob([JSON.stringify(lib, null, 1) + '\n'], { type: 'application/json' }));
    a.href = url; a.download = 'tool-library.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const use = () => {
    if (!tool) return;
    try {
      const custom = Object.values(ov).some((v) => v !== undefined);
      const base = shownR ?? (custom ? ({ machine: machine || 'any', material: material || 'any', status: 'Custom' } as LibRecipe) : undefined);
      const r = base && custom ? { ...base, ...ov } : base;
      const jt = toJobTool(tool, r);
      if (custom) { jt.id = `${jt.id}-c${fingerprint(JSON.stringify(ov)).slice(0, 6)}`.slice(0, 60); jt.name = `${jt.name} (this cut)`.slice(0, 80); }
      if (onUse(jt)) { say('ok', `${jobTools.some((t) => t.id === jt.id) ? 'Updated' : 'Added'} ${jt.name} in this job`); if (pick) onClose(); }
    } catch (e) { say('err', (e as Error).message); }
  };
  const ready = !!tool && geometryOk(tool);
  const canUse = ready && !!tool && (!pick || usable(tool));
  const gaps = tool ? geometryGaps(tool) : [];
  const dia = tool?.diameter ?? 0;
  const stepPct = shownR?.stepoverMm && dia ? (shownR.stepoverMm / dia) * 100 : 0;
  const R = (v: number) => Math.round(v * 1000) / 1000;

  const num = (label: string, value: number | undefined, key: keyof Ov, opts: { len?: boolean; min?: number; step?: number; unit: string }) => (
    <label className="tdb-field">{label}
      <span><NumField label={label} value={value === undefined ? null : opts.len ? L(value) : value} decimals={opts.len ? dec : 3} min={opts.min ?? 0} step={opts.step ?? 1} width={92} disabled={!recipe}
        onCommit={(v) => setNumber(key, v > 0 ? (opts.len ? fromL(v) : v) : undefined)} /> <small>{opts.unit}</small></span>
    </label>
  );

  return (
    <div className="modal-back" style={{ zIndex: pick ? 60 : 50 }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="tdb" role="dialog" aria-modal="true" aria-label={pick ? 'Choose a tool' : 'Tool library'}>
        <div className="tdb-head">
          <h2>{pick ? 'Choose a tool' : 'Tool library'}</h2>
          <label className="inline small">Material <select aria-label="Material" value={material} onChange={(e) => setFilters({ material: e.target.value })}><option value="">Any</option>{materials.map((m) => <option key={m} value={m}>{m}</option>)}</select></label>
          <label className="inline small">Machine <select aria-label="Machine" value={machine} onChange={(e) => setFilters({ machine: e.target.value, material: '' })}><option value="">Any</option>{machines.map((m) => <option key={m} value={m}>{m}</option>)}</select></label>
          <input aria-label="Search tools" placeholder="Search by name, part number or maker" value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 220 }} />
          <div className="seg" role="radiogroup" aria-label="Units">
            {(['mm', 'in'] as const).map((u) => <button key={u} role="radio" aria-checked={units === u} className={'btn small' + (units === u ? ' primary' : '')} onClick={() => setUnits(u)}>{u === 'mm' ? 'Millimetres' : 'Inches'}</button>)}
          </div>
        </div>
        <div className="tdb-body">
          <div className="tdb-list" aria-label="Tools">
            <div className="tdb-filters">
              <label className="radio small"><input type="checkbox" checked={readyOnly} onChange={(e) => setReadyOnly(e.target.checked)} /> Only tools ready for a job</label>
              {pick && <label className="radio small"><input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show tools this toolpath cannot use</label>}
              <span className="small muted" aria-live="polite">{shown.length} of {lib.tools.length} tools. {lib.tools.filter(geometryOk).length} are ready for a job.</span>
            </div>
            {lib.tools.length === 0 && <p className="muted small" style={{ padding: 8 }}>The library is empty. Load a library file below.</p>}
            {groups.map(([maker, list]) => (
              <div key={maker} className="tdb-group">
                <div className="tdb-maker">{maker}</div>
                {list.map((t) => (
                  <button key={t.id} className={'tdb-item' + (sel === t.id ? ' on' : '')} aria-pressed={sel === t.id} aria-label={`${t.name}${geometryOk(t) ? '' : ', geometry missing'}`} onClick={() => setSel(t.id)} onDoubleClick={() => { if (pick && sel === t.id && canUse) use(); }}>
                    <span className="nm">{t.name}</span>
                    <span className="sub">{t.kind ? KIND_NAME[t.kind].split(' (')[0] : 'Kind not set'}{t.diameter ? ` · ⌀ ${R(L(t.diameter))} ${lu}` : ''}{t.vAngle ? ` · ${t.vAngle}°` : ''}{t.taper ? ` · tapered ${t.taper}°` : ''}</span>
                    {!geometryOk(t) && <span className="warn small">Needs: {geometryGaps(t).join(', ')}</span>}
                  </button>
                ))}
              </div>
            ))}
          </div>
          <div className="tdb-detail">
            {!tool ? <p className="muted">Pick a tool on the left to see it and its cutting recipe{pick ? ', then Select' : ''}.</p> : (
              <>
                <h3>{tool.name}</h3>
                <p className="small muted">{[tool.manufacturer, tool.part, tool.ownership, tool.priority].filter(Boolean).join(' · ')}{tool.notes ? ` — ${tool.notes}` : ''}</p>
                {!ready && <p className="warn small">Needs: {gaps.join(', ')}. Fill it in below{pick ? ' (this changes the library)' : ''}.</p>}
                <section className="tdb-sec"><h4>Geometry</h4>
                  <div className="tdb-grid">
                    <label className="tdb-field">Name <input aria-label={`Name of ${tool.name}`} defaultValue={tool.name} key={tool.id + tool.name} onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== tool.name) void update(tool.id, { name: v }); }} /></label>
                    <label className="tdb-field">Kind <select aria-label={`Kind of ${tool.name}`} value={tool.kind ?? ''} onChange={(e) => update(tool.id, { kind: (e.target.value || null) as LibKind | null })}><option value="">Not set</option>{LIB_KINDS.map((k) => <option key={k} value={k}>{KIND_NAME[k]}</option>)}</select></label>
                    <label className="tdb-field">Diameter <span><NumField label={`Diameter of ${tool.name}`} value={tool.diameter === undefined ? null : L(tool.diameter)} decimals={dec} min={0} step={inch ? 0.01 : 0.1} width={92} onCommit={(v) => update(tool.id, { diameter: v > 0 ? fromL(v) : undefined })} /> <small>{lu}{tool.kind === 'ball' && tool.taper ? ' at the tip' : ''}</small></span></label>
                    {tool.kind === 'vbit' && <label className="tdb-field">Angle <span><NumField label={`Angle of ${tool.name}`} value={tool.vAngle ?? null} min={0} step={1} width={72} onCommit={(v) => update(tool.id, { vAngle: v > 0 ? v : undefined })} /> <small>° included</small></span></label>}
                    {tool.kind === 'ball' && <label className="tdb-field">Taper <span><NumField label={`Taper of ${tool.name}`} value={tool.taper ?? 0} min={0} step={1} width={72} onCommit={(v) => update(tool.id, v > 0 ? { taper: v } : { taper: undefined, maxDiameter: undefined })} /> <small>° (0 is a plain ball)</small></span></label>}
                    {tool.kind === 'ball' && !!tool.taper && <label className="tdb-field">Largest diameter <span><NumField label={`Largest diameter of ${tool.name}`} value={tool.maxDiameter === undefined ? null : L(tool.maxDiameter)} decimals={dec} min={0} step={inch ? 0.01 : 0.5} width={92} onCommit={(v) => update(tool.id, { maxDiameter: v > 0 ? fromL(v) : undefined })} /> <small>{lu}</small></span></label>}
                    <label className="tdb-field">Flutes <span><NumField label={`Flutes of ${tool.name}`} value={tool.flutes ?? null} min={0} step={1} width={72} onCommit={(v) => update(tool.id, { flutes: v > 0 ? Math.round(v) : undefined })} /></span></label>
                  </div>
                </section>
                <section className="tdb-sec"><h4>Cutting parameters{pick ? ' for this cut' : ''}</h4>
                  <div className="row wrap small">
                    <span className="muted">{machine || 'Any machine'} · {material || 'any material'}</span>
                    {recipes.length > 1 && <select aria-label="Recipe" value={Math.min(ri, recipes.length - 1)} onChange={(e) => { setRi(Number(e.target.value)); setOv({}); }}>{recipes.map((r, i) => <option key={i} value={i}>{r.machine} · {r.material} · {r.status}</option>)}</select>}
                    {recipe && <label className="inline small">Status <select aria-label="Recipe status" value={recipe.status} onChange={(e) => updateRecipe(tool, recipe, { status: e.target.value })} disabled={pick}>{[...new Set([...STATUSES, recipe.status])].map((x) => <option key={x} value={x}>{x}</option>)}</select></label>}
                    {recipe && <span className={isApproved(recipe) ? 'ok' : 'warn'}>{isApproved(recipe) ? 'Approved' : 'Check these numbers before cutting'}</span>}
                  </div>
                  {!recipe ? (
                    <p className="small muted">No recipe for {machine || 'any machine'}{material ? ` and ${material}` : ''}. {machine && material ? '' : 'Choose a machine and a material at the top to add one. '}{pick ? 'It will be used with cautious speeds: check them.' : ''}
                      {machine && material && <> <button className="btn small" onClick={addRecipe}>Add a recipe for {machine} · {material}</button></>}</p>
                  ) : (
                    <div className="tdb-grid">
                      {num('Spindle speed', shownR!.rpm, 'rpm', { unit: 'rpm', min: 1, step: 1000 })}
                      {num('Feed rate', shownR!.feed === undefined ? undefined : shownR!.feed, 'feed', { len: true, unit: fu, step: inch ? 1 : 50 })}
                      {num('Plunge rate', shownR!.plunge, 'plunge', { len: true, unit: fu, step: inch ? 1 : 50 })}
                      {num('Pass depth', shownR!.passDepth, 'passDepth', { len: true, unit: lu, step: inch ? 0.01 : 0.25 })}
                      {num('Stepover', shownR!.stepoverMm, 'stepoverMm', { len: true, unit: lu, step: inch ? 0.01 : 0.1 })}
                      <div className="tdb-field">Stepover as a percent <span className="mono small">{stepPct ? `${Math.round(stepPct * 10) / 10} % of the diameter` : '–'}</span></div>
                      {shownR!.notes && <p className="small muted" style={{ gridColumn: '1 / -1' }}>{shownR!.notes}</p>}
                    </div>
                  )}
                  {pick && Object.values(ov).some((v) => v !== undefined) && (
                    <div className="row wrap small"><span className="warn">Changed for this cut only.</span>{recipe && <button className="btn small" onClick={async () => { await updateRecipe(tool, recipe, ov); setOv({}); }}>Save these numbers to the library</button>}</div>
                  )}
                  {!pick && recipe && <div className="row"><button className="btn small" onClick={removeRecipe}>Remove this recipe</button></div>}
                </section>
                {!pick && <div className="row"><button className="btn primary" disabled={!ready} onClick={use} title={ready ? 'Put this cutter in the job with this recipe' : 'Fill in what is missing first'}>Add to job{recipe ? ' with this recipe' : ' (no recipe)'}</button></div>}
              </>
            )}
          </div>
        </div>
        <div className="tdb-foot">
          <button className="btn small" onClick={newTool}>+ New tool</button>
          <button className="btn small danger" disabled={!tool} onClick={deleteTool}>{sure ? 'Sure? Delete it' : 'Delete tool'}</button>
          <span className="spacer" />
          <button className="btn small" onClick={() => file.current?.click()} title="Load a tool library file. Tools with the same id are replaced.">Load library file…</button>
          <input ref={file} type="file" accept=".json,application/json" hidden aria-label="Tool library file" onChange={(e) => importFile(e.target.files?.[0])} />
          <button className="btn small" onClick={exportFile} disabled={!lib.tools.length}>Save a copy</button>
          {pick && <button className="btn primary" disabled={!canUse} onClick={use} title={!tool ? 'Pick a tool first' : !ready ? 'Fill in what is missing first' : !canUse ? 'This toolpath cannot use that kind of cutter' : 'Use this cutter for the toolpath'}>Select</button>}
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
