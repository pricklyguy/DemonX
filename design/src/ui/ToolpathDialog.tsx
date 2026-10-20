import { useEffect, useRef, useState } from 'react';
import type { CncData, ProfileSide, Toolpath, ToolpathKind } from '../core/cnc';
import type { Doc } from '../core/types';
import { NumField } from './NumField';
import { ToolField } from './toolPicker';

interface Form { name: string; toolId: string; side: ProfileSide; direction: 'climb' | 'conventional'; startDepth: number; cutDepth: number; allowance: number; safeZ: number; mirror: boolean }

const TITLE: Record<ToolpathKind, string> = { profile: 'Profile toolpath', pocket: 'Pocket toolpath', drill: 'Drill toolpath', engrave: 'Engraving toolpath', vcarve: 'V-bit toolpath', plug: 'Inlay plug toolpath', photo: 'Photo toolpath', finish3d: '3D finishing toolpath', rough3d: '3D roughing toolpath' };

/** Set up a toolpath for the selected shapes (or change an existing one). */
export function ToolpathDialog({ doc, cnc, kind, existing, selection, onCreate, onUpdate, onClose }: {
  doc: Doc;
  cnc: CncData;
  kind: ToolpathKind;
  existing: Toolpath | null;
  selection: number[];
  onCreate: (args: Record<string, unknown>) => void;
  onUpdate: (args: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  const thickness = doc.workspace.kind === 'cnc' ? doc.workspace.thickness : 0;
  const tools = kind === 'engrave' ? cnc.tools.filter((t) => t.kind !== 'drill') : kind === 'vcarve' || kind === 'plug' ? cnc.tools.filter((t) => t.kind === 'vbit') : cnc.tools;
  const firstTool = (kind === 'engrave' ? tools.find((t) => t.kind === 'vbit') ?? tools.find((t) => t.kind === 'ball') : kind === 'vcarve' || kind === 'plug' ? tools[0] : undefined) ?? tools.find((t) => (kind === 'drill' ? t.kind === 'drill' : t.kind !== 'drill')) ?? cnc.tools[0];
  const [f, setF] = useState<Form>(() => existing
    ? { name: '', toolId: existing.toolId, side: existing.side, direction: existing.direction, startDepth: existing.startDepth, cutDepth: existing.cutDepth, allowance: existing.allowance, safeZ: existing.safeZ, mirror: existing.mirror === true }
    : { name: '', toolId: firstTool?.id ?? '', side: 'outside', direction: 'climb', startDepth: 0, cutDepth: kind === 'engrave' ? 1 : thickness > 0 ? Math.min(6, thickness) : 6, allowance: 0, safeZ: 5, mirror: kind === 'plug' });
  const [useSel, setUseSel] = useState(!existing);
  const set = (p: Partial<typeof f>) => setF((cur) => ({ ...cur, ...p }));
  const cancel = useRef(onClose);
  cancel.current = onClose;
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); cancel.current(); } };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, []);
  const tool = cnc.tools.find((t) => t.id === f.toolId);
  const nShapes = useSel ? selection.length : existing?.shapeIds.length ?? 0;
  const ok = !!tool && f.cutDepth > f.startDepth && nShapes > 0;
  const go = () => {
    const body: Record<string, unknown> = { toolId: f.toolId, side: f.side, direction: f.direction, startDepth: f.startDepth, cutDepth: f.cutDepth, allowance: f.allowance, safeZ: f.safeZ, ...(existing || kind === 'plug' ? { mirror: f.mirror } : {}) };
    if (f.name.trim()) body.name = f.name.trim();
    if (existing) onUpdate({ id: existing.id, ...body, ...(useSel ? { ids: selection } : {}) });
    else onCreate({ kind, ...body, ids: selection });
  };
  const passes = tool && f.cutDepth > f.startDepth ? Math.ceil((f.cutDepth - f.startDepth) / tool.stepdown - 1e-9) : 0;
  return (
    <div className="drawer-back">
      <div className="drawer" role="dialog" aria-modal="true" aria-label={existing ? 'Edit toolpath' : TITLE[kind]}>
        <h2>{existing ? 'Edit toolpath' : TITLE[kind]}</h2>
        <div className="dbody">
          <fieldset className="dsec"><legend>Cutting depths</legend>
            <label className="line">Start depth (D) <span><NumField label="Start depth" value={f.startDepth} min={0} step={1} onCommit={(v) => set({ startDepth: v })} /> <small>mm</small></span></label>
            <label className="line">{kind === 'vcarve' ? 'Max depth (C)' : kind === 'plug' ? 'Plug depth (C)' : 'Cut depth (C)'} <span><NumField label="Cut depth" value={f.cutDepth} min={0.01} step={1} onCommit={(v) => set({ cutDepth: v })} /> <small>mm</small></span></label>
            {thickness > 0 && <button className="btn small" onClick={() => set({ cutDepth: thickness + 0.3 })} title="Cut through the material, a little into the spoilboard">Through the {thickness} mm material</button>}
          </fieldset>
          <fieldset className="dsec"><legend>Tool</legend>
            <ToolField label="Tool" value={f.toolId} tools={tools} accept={(k) => (kind === 'drill' ? k === 'drill' : kind === 'vcarve' || kind === 'plug' ? k === 'vbit' : k !== 'drill')} onChange={(id) => set({ toolId: id })} />
            {passes > 0 && tool && <span className="small muted">Passes: {passes} (at most {tool.stepdown} mm each)</span>}
          </fieldset>
          {kind === 'profile' && (
            <fieldset className="dsec" role="radiogroup" aria-label="Cut side"><legend>Machine vectors</legend>
              {([['outside', 'Outside'], ['inside', 'Inside'], ['on', 'On the line']] as const).map(([v, l]) => (
                <label key={v} className="radio"><input type="radio" name="tp-side" checked={f.side === v} onChange={() => set({ side: v })} /> {l}</label>
              ))}
            </fieldset>
          )}
          {kind !== 'drill' && (
            <fieldset className="dsec" role="radiogroup" aria-label="Cutting direction"><legend>Direction</legend>
              {([['climb', 'Climb'], ['conventional', 'Conventional']] as const).map(([v, l]) => (
                <label key={v} className="radio"><input type="radio" name="tp-dir" checked={f.direction === v} onChange={() => set({ direction: v })} /> {l}</label>
              ))}
              {kind !== 'engrave' && kind !== 'plug' && <label className="line">{kind === 'vcarve' ? 'Grow the shape (glue gap)' : 'Allowance offset'} <span><NumField label="Allowance" value={f.allowance} min={0} step={0.1} onCommit={(v) => set({ allowance: v })} /> <small>mm</small></span></label>}
              {kind === 'vcarve' && <span className="small muted">Carves closed shapes: the bit goes deeper where the shape is wider, down to the max depth. It needs a V-bit (add one in the tool list if there is none).</span>}
              {kind === 'plug' && <span className="small muted">A chamfer cut round the inside of the outline, to fit a V-carved pocket of the same depth.</span>}
              {kind === 'plug' && <label className="radio"><input type="checkbox" checked={f.mirror} onChange={(e) => set({ mirror: e.target.checked })} /> Mirror it (the plug is turned over)</label>}
              {kind === 'engrave' && <span className="small muted">Closed shapes run counter-clockwise for climb, clockwise for conventional. Lines are followed as drawn, nearest first.</span>}
            </fieldset>
          )}
          <fieldset className="dsec"><legend>Safe Z</legend>
            <label className="line">Safe height <span><NumField label="Safe height" value={f.safeZ} min={0.5} step={1} onCommit={(v) => set({ safeZ: v })} /> <small>mm above top</small></span></label>
          </fieldset>
          <fieldset className="dsec"><legend>Vector selection</legend>
            <label className="radio">
              <input type="checkbox" checked={useSel} disabled={!existing} onChange={(e) => setUseSel(e.target.checked)} />
              {existing ? ` Use the ${selection.length} shape${selection.length === 1 ? '' : 's'} selected now instead of the ${existing.shapeIds.length} it has` : ` ${selection.length} shape${selection.length === 1 ? '' : 's'} selected`}
            </label>
            {kind === 'profile' && <span className="small muted">Several shapes at once are cut smallest first, so holes are cut before the outline around them.</span>}
          </fieldset>
          <fieldset className="dsec"><legend>Name</legend>
            <input aria-label="Toolpath name" value={f.name} placeholder={existing?.name ?? 'Automatic'} onChange={(e) => set({ name: e.target.value })} />
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
