import { useEffect, useRef, useState } from 'react';
import type { CncData, Toolpath } from '../core/cnc';
import { reliefHeightMm } from '../core/relief';
import type { Doc } from '../core/types';
import { NumField } from './NumField';
import { ToolField } from './toolPicker';

/** Set up a 3D finishing or roughing toolpath: which 3D shape, which tool, which way the lines run and how far apart (or change an existing one). */
export function Finish3dDialog({ doc, cnc, kind, existing, onCreate, onUpdate, onClose }: {
  doc: Doc;
  kind: 'finish3d' | 'rough3d';
  cnc: CncData;
  existing: Toolpath | null;
  onCreate: (args: Record<string, unknown>) => void;
  onUpdate: (args: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  const reliefs = doc.reliefs ?? [];
  const tools = cnc.tools.filter((t) => t.kind !== 'drill');
  const [reliefId, setRelief] = useState(existing?.reliefId ?? reliefs[0]?.id ?? 0);
  const rough = kind === 'rough3d';
  const [toolId, setTool] = useState(existing?.toolId ?? tools.find((t) => t.kind === (rough ? 'flat' : 'ball'))?.id ?? tools[0]?.id ?? '');
  const tool = tools.find((t) => t.id === toolId);
  const defaultStep = (t: typeof tool) => (t ? Math.round(((t.diameter * Math.max(t.stepover, 1)) / 100) * 1000) / 1000 : 0.5);
  const [dir, setDir] = useState<'x' | 'y'>(existing?.scan?.dir ?? 'x');
  const [step, setStep] = useState<number | null>(existing?.scan?.stepoverMm ?? null);
  const [cross, setCross] = useState(existing?.scan?.cross ?? false);
  const [allowance, setAllowance] = useState(existing?.allowance ?? (rough ? 0.5 : 0));
  const [ramp, setRamp] = useState<number>(existing ? existing.rampAngle ?? 0 : rough ? 3 : 0);
  const [safeZ, setSafeZ] = useState(existing?.safeZ ?? 5);
  const [name, setName] = useState('');
  const cancel = useRef(onClose);
  cancel.current = onClose;
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); cancel.current(); } };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, []);
  const relief = reliefs.find((r) => r.id === reliefId);
  const stepover = step ?? defaultStep(tool);
  const across = relief ? (dir === 'x' ? reliefHeightMm(relief) : relief.width) : 0;
  const lines = stepover > 0 ? Math.ceil(across / stepover) + 1 : 0;
  const ok = !!relief && !!tool && stepover >= 0.02 && allowance >= 0;
  const go = () => {
    const body = { toolId, reliefId, scan: { dir, stepoverMm: stepover, ...(rough ? {} : { cross }) }, allowance, safeZ, ...(rough ? { rampAngle: ramp } : {}), ...(name.trim() ? { name: name.trim() } : {}) };
    if (existing) onUpdate({ id: existing.id, ...body });
    else onCreate({ kind, ...body });
  };
  const round = (v: number) => Math.round(v * 1000) / 1000;
  return (
    <div className="drawer-back">
      <div className="drawer" role="dialog" aria-modal="true" aria-label={existing ? 'Edit toolpath' : rough ? '3D roughing toolpath' : '3D finishing toolpath'}>
        <h2>{existing ? 'Edit toolpath' : rough ? '3D roughing toolpath' : '3D finishing toolpath'}</h2>
        <div className="dbody">
          <fieldset className="dsec"><legend>3D shape</legend>
            <select aria-label="3D shape" value={reliefId} onChange={(e) => setRelief(Number(e.target.value))}>
              {reliefs.map((r) => <option key={r.id} value={r.id}>{r.name} ({round(r.width)} × {round(reliefHeightMm(r))} × {round(r.depth)} mm)</option>)}
            </select>
          </fieldset>
          <fieldset className="dsec"><legend>Tool</legend>
            <ToolField label="Tool" value={toolId} tools={tools} accept={(k) => k !== 'drill'} onChange={(id) => { setTool(id); setStep(null); }} />
            {!rough && tool && tool.kind !== 'ball' && <span className="small muted">A ball nose follows a curved surface best.</span>}
            {rough && tool && <span className="small muted">Cuts down in steps of {tool.stepdown} mm (the tool's step-down).</span>}
          </fieldset>
          <fieldset className="dsec" role="radiogroup" aria-label="Line direction"><legend>Lines</legend>
            {([['x', 'Along X'], ['y', 'Along Y']] as const).map(([v, l]) => (
              <label key={v} className="radio"><input type="radio" name="f3-dir" checked={dir === v} onChange={() => setDir(v)} /> {l}</label>
            ))}
            <label className="line">Stepover <span><NumField label="Stepover" value={round(stepover)} min={0.02} step={0.1} onCommit={setStep} /> <small>mm</small></span></label>
            {!rough && <label className="radio"><input type="checkbox" checked={cross} onChange={(e) => setCross(e.target.checked)} /> Add a second pass at right angles</label>}
            <span className="small muted">{cross && !rough ? lines * 2 : lines} lines{rough ? ' on each level' : ''}. {rough ? 'A bigger stepover is quicker.' : 'A smaller stepover gives a smoother surface and a longer cut.'}</span>
          </fieldset>
          {rough && (
            <fieldset className="dsec" role="radiogroup" aria-label="How each cut starts"><legend>Entry</legend>
              <label className="radio"><input type="radio" name="f3-entry" checked={ramp === 0} onChange={() => setRamp(0)} /> Plunge straight down</label>
              <label className="radio"><input type="radio" name="f3-entry" checked={ramp > 0} onChange={() => setRamp(ramp > 0 ? ramp : 3)} /> Ramp in along the line</label>
              {ramp > 0 && <label className="line">Ramp angle <span><NumField label="Ramp angle" value={ramp} min={0.5} step={0.5} onCommit={(v) => setRamp(Math.min(45, Math.max(0.5, v)))} /> <small>degrees</small></span></label>}
              <span className="small muted">{ramp > 0 ? 'Goes down along the first part of each cut (back and forth on a short one). Kinder to an end mill that does not cut with its centre.' : 'Quickest, and hard on an end mill that does not cut with its centre.'}</span>
            </fieldset>
          )}
          <fieldset className="dsec"><legend>Material left</legend>
            <label className="line">Allowance <span><NumField label="Allowance" value={allowance} min={0} step={0.1} onCommit={setAllowance} /> <small>mm</small></span></label>
            <span className="small muted">{rough ? 'Left on the surface for the finishing pass.' : '0 cuts to the surface. A little leaves material for a later pass.'}</span>
          </fieldset>
          <fieldset className="dsec"><legend>Safe Z</legend>
            <label className="line">Safe height <span><NumField label="Safe height" value={safeZ} min={0.5} step={1} onCommit={setSafeZ} /> <small>mm above top</small></span></label>
            <span className="small muted">The top of the shape is cut at Z 0, the top of the material.</span>
          </fieldset>
          <fieldset className="dsec"><legend>Name</legend>
            <input aria-label="Toolpath name" value={name} placeholder={existing?.name ?? 'Automatic'} onChange={(e) => setName(e.target.value)} />
          </fieldset>
        </div>
        <div className="dfoot">
          <button className="btn primary" disabled={!ok} onClick={go}>{existing ? 'Save' : 'Calculate'}</button>
          <button className="btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
