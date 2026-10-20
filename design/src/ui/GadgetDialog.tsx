import { useEffect, useRef, useState } from 'react';
import { anchorOf } from '../core/gadgets';
import type { Doc } from '../core/types';
import { NumField } from './NumField';

type Run = (id: string, args: unknown, echo?: boolean) => boolean;

export type GadgetKind = 'rotate' | 'marker' | 'replace' | 'nudge' | 'number';

export interface GadgetMemory {
  template: number[];
  bridge: [number, number] | null;
  nextNumber: number;
}

const TITLES: Record<GadgetKind, string> = {
  rotate: 'Rotate each',
  marker: 'Sharpie Path Offset',
  replace: 'Replace with template',
  nudge: 'Nudge to guide',
  number: 'Auto number',
};

/** The set-up box for one of the workflow tools carried over from the VCarve gadgets. Opens from the Gadgets menu. */
export function GadgetDialog({ kind, doc, selection, memory, setMemory, run, onClose }: {
  kind: GadgetKind;
  doc: Doc;
  selection: number[];
  memory: GadgetMemory;
  setMemory: (m: GadgetMemory) => void;
  run: Run;
  onClose: () => void;
}) {
  const n = selection.length;
  const last = n ? selection[n - 1] : null;
  const [angle, setAngle] = useState(45);
  // where the pen sits is remembered between uses (default: 0 across, 58 mm below the spindle)
  const [marker, setMarkerState] = useState(() => {
    try { const v = JSON.parse(localStorage.getItem('design-sharpie') ?? 'null'); if (v && Number.isFinite(v.x) && Number.isFinite(v.y)) return { x: v.x as number, y: v.y as number }; } catch { /* use the default */ }
    return { x: 0, y: -58 };
  });
  const setMarker = (m: { x: number; y: number }) => { setMarkerState(m); try { localStorage.setItem('design-sharpie', JSON.stringify(m)); } catch { /* it just will not be remembered */ } };
  const [keepTpl, setKeepTpl] = useState(false);
  const [backup, setBackup] = useState(true);
  const [spread, setSpread] = useState(false);
  const [num, setNum] = useState({ start: memory.nextNumber, height: 6, wiring: true, nodes: true, nodeR: 1.5, continueRun: !!memory.bridge });
  const tpl = memory.template.filter((id) => doc.shapes.some((s) => s.id === id));

  const cancel = useRef(onClose);
  cancel.current = onClose;
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); cancel.current(); } };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, []);

  let help = '';
  let ok = false;
  let go: () => boolean = () => false;
  let body: React.ReactNode = null;

  if (kind === 'rotate') {
    help = 'Turns every selected shape about its own centre (not about the whole selection).';
    ok = n > 0;
    go = () => run('rotate_each', { ids: selection, angle });
    body = <label className="inline">Angle <NumField label="Angle for rotate each" value={angle} step={5} width={80} onCommit={setAngle} /><small>° counter-clockwise</small></label>;
  } else if (kind === 'marker') {
    help = 'Copies the selection to a "Sharpie Path" layer, shifted the opposite way, so a pen mounted beside the spindle draws it in the right place. Enter where the pen sits relative to the spindle; it is remembered for next time.';
    ok = n > 0 && !(marker.x === 0 && marker.y === 0);
    go = () => run('marker_copy', { ids: selection, x: marker.x, y: marker.y });
    body = (
      <div className="fields">
        <label>Pen X <NumField label="Pen X" value={marker.x} step={1} onCommit={(v) => setMarker({ ...marker, x: v })} /><small>mm</small></label>
        <label>Pen Y <NumField label="Pen Y" value={marker.y} step={1} onCommit={(v) => setMarker({ ...marker, y: v })} /><small>mm</small></label>
      </div>
    );
  } else if (kind === 'replace') {
    const targets = selection.filter((id) => !tpl.includes(id));
    help = `Puts a copy of the template (${tpl.length} shape${tpl.length === 1 ? '' : 's'}) on every selected shape, centred on it. The template is held by its first circle, or by its middle if it has none. The copies go on each target's layer.`;
    ok = tpl.length > 0 && targets.length > 0;
    go = () => run('replace_with', { targets, template: tpl, keep_template: keepTpl, backup });
    body = (
      <>
        <p className="small">{targets.length} target{targets.length === 1 ? '' : 's'} selected.{!tpl.length && ' Choose Gadgets → Set template from selection first.'}</p>
        <label className="inline"><input type="checkbox" checked={keepTpl} onChange={(e) => setKeepTpl(e.target.checked)} /> Keep the template</label>
        <label className="inline"><input type="checkbox" checked={backup} onChange={(e) => setBackup(e.target.checked)} /> Back up the replaced shapes on a hidden layer</label>
      </>
    );
  } else if (kind === 'nudge') {
    help = 'Moves the centre of each selected shape to the nearest point of the guide. Select the shapes first, then Shift-click the guide line or outline LAST.';
    ok = n >= 2;
    go = () => run('nudge_to_guide', { ids: selection.slice(0, -1), guide: last, distribute: spread });
    body = <label className="inline"><input type="checkbox" checked={spread} onChange={(e) => setSpread(e.target.checked)} /> Then space them evenly between the first and last along the guide</label>;
  } else {
    help = 'Stamps 1, 2, 3 … on each selected shape in the order you Shift-clicked them, with seven-segment digits (one shape per number).';
    ok = n > 0;
    go = () => {
      const args: Record<string, unknown> = { ids: selection, start: num.start, height: num.height, wiring: num.wiring, nodes: num.nodes, node_radius: num.nodeR };
      if (memory.bridge && num.wiring && num.continueRun) args.join_from = memory.bridge;
      if (!run('auto_number', args)) return false;
      const lastShape = doc.shapes.find((s) => s.id === last);
      setMemory({ ...memory, bridge: lastShape ? anchorOf(lastShape) : memory.bridge, nextNumber: num.start + n });
      return true;
    };
    body = (
      <>
        <div className="fields">
          <label>Start at <NumField label="Start number" value={num.start} min={0} step={1} onCommit={(v) => Number.isInteger(v) && setNum({ ...num, start: v })} /></label>
          <label>Digit height <NumField label="Digit height" value={num.height} min={0.5} step={0.5} onCommit={(v) => setNum({ ...num, height: v })} /><small>mm</small></label>
          <label>Marker circle radius <NumField label="Marker circle radius" value={num.nodeR} min={0.1} step={0.1} onCommit={(v) => setNum({ ...num, nodeR: v })} /><small>mm</small></label>
        </div>
        <label className="inline"><input type="checkbox" checked={num.wiring} onChange={(e) => setNum({ ...num, wiring: e.target.checked })} /> Draw a wiring path through them in order</label>
        <label className="inline"><input type="checkbox" checked={num.nodes} onChange={(e) => setNum({ ...num, nodes: e.target.checked })} /> Put a marker circle at each</label>
        {memory.bridge && <label className="inline"><input type="checkbox" checked={num.continueRun} onChange={(e) => setNum({ ...num, continueRun: e.target.checked })} /> Continue the wiring path from where the last run ended</label>}
      </>
    );
  }

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={TITLES[kind]}>
        <h2>{TITLES[kind]}</h2>
        <p className="small muted">{help}</p>
        <div className="group">{body}</div>
        <div className="row end">
          <span className="muted small">{n} selected</span>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!ok} onClick={() => { if (go()) onClose(); }}>{kind === 'number' ? 'Number them' : 'Run'}</button>
        </div>
      </div>
    </div>
  );
}
