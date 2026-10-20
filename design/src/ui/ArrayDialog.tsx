import { useEffect, useRef, useState } from 'react';
import { NumField } from './NumField';

interface Props {
  count: number;
  /** Centre of the selection, offered as the middle of a circular array. */
  centre: [number, number] | null;
  onApply: (args: Record<string, unknown>) => void;
  onCancel: () => void;
}

/** Repeat the selection in a grid or around a centre. */
export function ArrayDialog({ count, centre, onApply, onCancel }: Props) {
  const [kind, setKind] = useState<'grid' | 'circular'>('grid');
  const [cols, setCols] = useState(3);
  const [rows, setRows] = useState(2);
  const [dx, setDx] = useState(20);
  const [dy, setDy] = useState(20);
  const [n, setN] = useState(6);
  const [angle, setAngle] = useState(360);
  const [cx, setCx] = useState(centre ? centre[0] : 0);
  const [cy, setCy] = useState(centre ? centre[1] : 0);
  const [turn, setTurn] = useState(true);

  const cancel = useRef(onCancel);
  cancel.current = onCancel;
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); cancel.current(); } };
    window.addEventListener('keydown', k, true); // first in line, so the canvas does not also clear the selection
    return () => window.removeEventListener('keydown', k, true);
  }, []);

  const total = kind === 'grid' ? cols * rows : n;
  const apply = () => onApply(kind === 'grid' ? { kind, cols, rows, dx, dy } : { kind, count: n, angle, cx, cy, rotate: turn });

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Array">
        <h2>Array</h2>
        <p className="small muted">Repeat the {count} selected shape{count === 1 ? '' : 's'}. The originals stay where they are.</p>
        <div className="kinds" role="radiogroup" aria-label="Kind of array">
          {([['grid', 'Grid', 'rows and columns'], ['circular', 'Circular', 'around a centre']] as const).map(([k, label, sub]) => (
            <button key={k} role="radio" aria-checked={kind === k} className={'kind' + (kind === k ? ' on' : '')} onClick={() => setKind(k)}>
              <b>{label}</b><small>{sub}</small>
            </button>
          ))}
        </div>
        {kind === 'grid' ? (
          <div className="group">
            <div className="fields">
              <label>Columns <NumField label="Columns" value={cols} min={1} max={500} step={1} onCommit={(v) => setCols(Math.round(v))} /></label>
              <label>Rows <NumField label="Rows" value={rows} min={1} max={500} step={1} onCommit={(v) => setRows(Math.round(v))} /></label>
              <label>Spacing X <NumField label="Spacing X" value={dx} step={1} onCommit={setDx} /><small>mm</small></label>
              <label>Spacing Y <NumField label="Spacing Y" value={dy} step={1} onCommit={setDy} /><small>mm</small></label>
            </div>
            <p className="small muted">Spacing is from one copy to the next (start to start). Negative goes left or down.</p>
          </div>
        ) : (
          <div className="group">
            <div className="fields">
              <label>Count <NumField label="Count" value={n} min={2} max={2000} step={1} onCommit={(v) => setN(Math.round(v))} /></label>
              <label>Angle <NumField label="Angle" value={angle} step={15} onCommit={setAngle} /><small>°</small></label>
              <label>Centre X <NumField label="Centre X" value={cx} step={1} onCommit={setCx} /><small>mm</small></label>
              <label>Centre Y <NumField label="Centre Y" value={cy} step={1} onCommit={setCy} /><small>mm</small></label>
            </div>
            <label className="inline"><input type="checkbox" checked={turn} onChange={(e) => setTurn(e.target.checked)} /> Turn the copies as they go round</label>
            <p className="small muted">Count includes the original. 360° spreads them all the way round; less than that ends at the last angle.</p>
          </div>
        )}
        <div className="row end">
          <span className="muted small">{total} place{total === 1 ? '' : 's'}</span>
          <button className="btn" onClick={onCancel}>Cancel</button>
          <button className="btn primary" disabled={total < 2} onClick={apply}>Make array</button>
        </div>
      </div>
    </div>
  );
}
