import { useEffect, useRef, useState } from 'react';
import { TOOL_KINDS, type CncTool, type ToolKind } from '../core/cnc';
import { NumField } from './NumField';

const KIND_LABEL: Record<ToolKind, string> = { flat: 'Flat end mill', ball: 'Ball nose', vbit: 'V-bit', drill: 'Drill' };
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'tool';

/** Add or change a tool in the library. */
export function ToolDialog({ tool, existingIds, inUse, onSave, onDelete, onClose }: {
  tool: CncTool | null;
  existingIds: string[];
  inUse: boolean;
  onSave: (t: CncTool) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const [t, setT] = useState<CncTool>(tool ?? { id: '', name: '', kind: 'flat', diameter: 6, flutes: 2, rpm: 16000, feed: 1200, plunge: 400, stepdown: 2, stepover: 40 });
  const set = (p: Partial<CncTool>) => setT((cur) => ({ ...cur, ...p }));
  const cancel = useRef(onClose);
  cancel.current = onClose;
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); cancel.current(); } };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, []);
  const ok = t.name.trim().length > 0;
  const save = () => {
    let id = t.id;
    if (!tool) { id = slug(t.name); let n = 2; while (existingIds.includes(id)) id = `${slug(t.name)}-${n++}`; }
    const out: CncTool = { ...t, id, name: t.name.trim(), stepover: t.kind === 'drill' ? 0 : t.stepover };
    if (out.kind !== 'vbit') delete out.vAngle; else out.vAngle = out.vAngle ?? 60;
    if (out.kind !== 'ball' || !out.taperAngle) { delete out.taperAngle; delete out.maxDiameter; } else out.maxDiameter = Math.max(out.maxDiameter ?? 0, out.diameter + 0.1);
    onSave(out);
  };
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={tool ? 'Edit tool' : 'New tool'}>
        <h2>{tool ? 'Edit tool' : 'New tool'}</h2>
        <div className="group">
          <label className="stack">Name <input aria-label="Tool name" value={t.name} onChange={(e) => set({ name: e.target.value })} autoFocus={!tool} /></label>
          <div className="fields">
            <label>Type
              <select aria-label="Tool type" value={t.kind} onChange={(e) => set({ kind: e.target.value as ToolKind })}>
                {TOOL_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
              </select>
            </label>
            <label>Diameter <NumField label="Tool diameter" value={t.diameter} min={0.01} step={0.5} onCommit={(v) => set({ diameter: v })} /><small>mm</small></label>
            {t.kind === 'vbit' && <label>Angle <NumField label="V-bit angle" value={t.vAngle ?? 60} min={1} max={179} step={5} onCommit={(v) => set({ vAngle: v })} /><small>° included</small></label>}
            {t.kind === 'ball' && <label className="line"><input type="checkbox" checked={!!t.taperAngle} aria-label="Tapered" onChange={(e) => set(e.target.checked ? { taperAngle: 10, maxDiameter: Math.max(t.diameter * 4, t.diameter + 1) } : { taperAngle: undefined, maxDiameter: undefined })} /> Tapered (the diameter is the ball at the tip)</label>}
            {t.kind === 'ball' && !!t.taperAngle && <label>Taper <NumField label="Taper angle" value={t.taperAngle} min={0.5} max={60} step={1} onCommit={(v) => set({ taperAngle: v })} /><small>° included</small></label>}
            {t.kind === 'ball' && !!t.taperAngle && <label>Largest diameter <NumField label="Largest diameter" value={t.maxDiameter ?? t.diameter * 4} min={0.1} step={0.5} onCommit={(v) => set({ maxDiameter: v })} /><small>mm at the top of the taper</small></label>}
            <label>Flutes <NumField label="Flutes" value={t.flutes} min={1} max={12} step={1} onCommit={(v) => set({ flutes: Math.round(v) })} /></label>
            <label>Spindle <NumField label="Spindle speed" value={t.rpm} min={1} step={1000} onCommit={(v) => set({ rpm: v })} /><small>rpm</small></label>
            <label>Feed <NumField label="Cutting feed" value={t.feed} min={1} step={50} onCommit={(v) => set({ feed: v })} /><small>mm/min</small></label>
            <label>Plunge <NumField label="Plunge feed" value={t.plunge} min={1} step={50} onCommit={(v) => set({ plunge: v })} /><small>mm/min</small></label>
            <label>Stepdown <NumField label="Stepdown" value={t.stepdown} min={0.01} step={0.5} onCommit={(v) => set({ stepdown: v })} /><small>mm per pass</small></label>
            {t.kind !== 'drill' && <label>Stepover <NumField label="Stepover" value={t.stepover} min={1} max={100} step={5} onCommit={(v) => set({ stepover: v })} /><small>% of diameter</small></label>}
          </div>
        </div>
        <div className="row end">
          {tool && <button className="btn danger" disabled={inUse} title={inUse ? 'A toolpath uses this tool' : 'Remove this tool'} onClick={() => onDelete(tool.id)}>Delete</button>}
          <span className="spacer" />
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!ok} onClick={save}>{tool ? 'Save' : 'Add tool'}</button>
        </div>
      </div>
    </div>
  );
}
