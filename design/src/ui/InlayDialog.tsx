import { useEffect, useRef, useState } from 'react';
import type { CncData } from '../core/cnc';
import type { Doc } from '../core/types';
import { NumField } from './NumField';
import { ToolField } from './toolPicker';

/** Set up an inlay from the selected closed shapes: the V-carved pocket, the plug and (optionally) the plug's cut-out. */
export function InlayDialog({ doc, cnc, selection, onCreate, onClose }: {
  doc: Doc;
  cnc: CncData;
  selection: number[];
  onCreate: (args: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  const vbits = cnc.tools.filter((t) => t.kind === 'vbit');
  const cutters = cnc.tools.filter((t) => t.kind === 'flat' || t.kind === 'ball');
  const thickness = doc.workspace.kind === 'cnc' ? doc.workspace.thickness : 0;
  const [vbitId, setVbit] = useState(vbits[0]?.id ?? '');
  const [depth, setDepth] = useState(3);
  const [gap, setGap] = useState(0.1);
  const [mirror, setMirror] = useState(true);
  const [cutOut, setCutOut] = useState(true);
  const [cutterId, setCutter] = useState(cutters[0]?.id ?? '');
  const [plugThick, setPlugThick] = useState(thickness > 0 ? thickness : 12);
  const [direction, setDirection] = useState<'climb' | 'conventional'>('climb');
  const [safeZ, setSafeZ] = useState(5);
  const cancel = useRef(onClose);
  cancel.current = onClose;
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); cancel.current(); } };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, []);
  const vb = vbits.find((t) => t.id === vbitId);
  const reach = vb?.vAngle ? vb.diameter / 2 / Math.tan((vb.vAngle * Math.PI) / 360) : 0;
  const ok = !!vb && depth > 0 && depth <= reach + 1e-9 && selection.length > 0 && (!cutOut || !!cutterId);
  const go = () => onCreate({
    ids: selection, vbitId, depth, gap, mirror, direction, safeZ,
    ...(cutOut ? { cutterId, through: plugThick + 0.3 } : {}),
  });
  return (
    <div className="drawer-back">
      <div className="drawer" role="dialog" aria-modal="true" aria-label="Inlay toolpaths">
        <h2>Inlay toolpaths</h2>
        <div className="dbody">
          <fieldset className="dsec"><legend>V-bit</legend>
            {vbits.length === 0 && <span className="warn small">There is no V-bit in this job yet. Choose one from the library, or add one in the tool list.</span>}
            <ToolField label="V-bit" value={vbitId} tools={vbits} accept={(k) => k === 'vbit'} onChange={setVbit} />
            {vb && <span className="small muted">Goes up to {reach.toFixed(2)} mm deep.</span>}
          </fieldset>
          <fieldset className="dsec"><legend>Pocket</legend>
            <label className="line">Pocket depth <span><NumField label="Pocket depth" value={depth} min={0.1} step={0.5} onCommit={setDepth} /> <small>mm</small></span></label>
            <label className="line">Glue gap <span><NumField label="Glue gap" value={gap} min={0} step={0.05} onCommit={setGap} /> <small>mm</small></span></label>
            <span className="small muted">The pocket is the shape grown by the gap, so the plug fits with that much room all round.</span>
          </fieldset>
          <fieldset className="dsec"><legend>Plug</legend>
            <label className="radio"><input type="checkbox" checked={mirror} onChange={(e) => setMirror(e.target.checked)} /> Mirror the plug (it is turned over)</label>
            <label className="radio"><input type="checkbox" checked={cutOut} onChange={(e) => setCutOut(e.target.checked)} /> Also cut the plug out</label>
            {cutOut && (
              <>
                <ToolField label="Cut-out tool" value={cutterId} tools={cutters} accept={(k) => k === 'flat' || k === 'ball'} onChange={setCutter} />
                <label className="line">Plug material thickness <span><NumField label="Plug material thickness" value={plugThick} min={0.1} step={1} onCommit={setPlugThick} /> <small>mm</small></span></label>
              </>
            )}
            <span className="small muted">Cut the plug from its own board in the same place, then turn it over to fit the pocket.</span>
          </fieldset>
          <fieldset className="dsec" role="radiogroup" aria-label="Cutting direction"><legend>Direction</legend>
            {([['climb', 'Climb'], ['conventional', 'Conventional']] as const).map(([v, l]) => (
              <label key={v} className="radio"><input type="radio" name="inlay-dir" checked={direction === v} onChange={() => setDirection(v)} /> {l}</label>
            ))}
          </fieldset>
          <fieldset className="dsec"><legend>Safe Z</legend>
            <label className="line">Safe height <span><NumField label="Safe height" value={safeZ} min={0.5} step={1} onCommit={setSafeZ} /> <small>mm above top</small></span></label>
          </fieldset>
          <fieldset className="dsec"><legend>Vector selection</legend>
            <span className="small">{selection.length} shape{selection.length === 1 ? '' : 's'} selected (closed shapes only)</span>
          </fieldset>
        </div>
        <div className="dfoot">
          <button className="btn primary" disabled={!ok} onClick={go}>Calculate</button>
          <button className="btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
