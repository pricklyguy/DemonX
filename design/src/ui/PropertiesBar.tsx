import { useMemo } from 'react';
import type { Anchor } from '../core/geom';
import { anchorPoint, shapeBounds, unionBounds } from '../core/geom';
import type { Doc } from '../core/types';
import { NumField } from './NumField';

const ANCHORS: Anchor[] = ['tl', 'tc', 'tr', 'ml', 'c', 'mr', 'bl', 'bc', 'br'];

interface Props {
  doc: Doc;
  selection: number[];
  anchor: Anchor;
  setAnchor: (a: Anchor) => void;
  lock: boolean;
  setLock: (v: boolean) => void;
  run: (id: string, args: unknown, echo?: boolean) => boolean;
  /** When set, Y is measured down from this height (the top edge of the page) instead of up from 0, to match the ruler. */
  yTop?: number | null;
}

/** The row of boxes for the selected shapes: where they are, how big, and turning and flipping them. */
export function PropertiesBar({ doc, selection, anchor, setAnchor, lock, setLock, run, yTop = null }: Props) {
  const shapes = useMemo(() => selection.map((id) => doc.shapes.find((s) => s.id === id)).filter((s) => !!s), [selection, doc.shapes]);
  const b = unionBounds(shapes.map((s) => shapeBounds(s!)));
  const has = !!b && shapes.length > 0;
  const allCircles = has && shapes.every((s) => s!.kind === 'circle');
  const effLock = allCircles || lock; // stretching a circle would stop it being a circle
  const at = b ? anchorPoint(b, anchor) : null;
  const w = b ? b.maxX - b.minX : null;
  const h = b ? b.maxY - b.minY : null;
  const single = shapes.length === 1 && shapes[0]!.kind === 'circle' ? shapes[0]! : null;
  const ids = selection;

  const set = (patch: Record<string, unknown>) => run('set_bounds', { ids, anchor, ...patch }, false);

  return (
    <div className="propbar" role="group" aria-label="Selected shape">
      <label>X<NumField label="X position" value={at ? at[0] : null} disabled={!has} step={1} width={86} onCommit={(v) => set({ x: v })} /><small>mm</small></label>
      <label>Y<NumField label="Y position" value={at ? (yTop === null ? at[1] : yTop - at[1]) : null} disabled={!has} step={1} width={86} onCommit={(v) => set({ y: yTop === null ? v : yTop - v })} /><small>mm</small></label>
      <div className="anchors" role="radiogroup" aria-label="Which point of the selection X and Y refer to">
        {ANCHORS.map((a) => (
          <button key={a} role="radio" aria-checked={anchor === a} aria-label={`anchor ${a}`} className={'dot' + (anchor === a ? ' on' : '')} onClick={() => setAnchor(a)} title="X and Y (and resizing) use this point of the selection" />
        ))}
      </div>
      <label>Width<NumField label="Width" value={w} disabled={!has || (w ?? 0) < 1e-9} min={0.001} step={1} width={86} onCommit={(v) => set({ width: v, lock: effLock })} /><small>mm</small></label>
      <label>Height<NumField label="Height" value={h} disabled={!has || (h ?? 0) < 1e-9} min={0.001} step={1} width={86} onCommit={(v) => set({ height: v, lock: effLock })} /><small>mm</small></label>
      <button className={'btn small lock' + (effLock ? ' on' : '')} disabled={!has || allCircles} aria-pressed={effLock} onClick={() => setLock(!lock)} title={allCircles ? 'Circles always keep their proportions' : 'Keep the proportions when changing width or height'}>
        {effLock ? '🔒' : '🔓'}
      </button>
      {single && single.kind === 'circle' && (
        <label>Diameter<NumField label="Diameter" value={Math.round(single.r * 2 * 1e6) / 1e6} min={0.001} step={1} width={80} onCommit={(v) => run('set_bounds', { ids, anchor: 'c', width: v, lock: true }, false)} /><small>mm</small></label>
      )}
      <span className="sep" />
      <label>Rotate<NumField label="Rotate by degrees" value={0} disabled={!has} step={5} width={72} resetOnCommit onCommit={(v) => v !== 0 && run('rotate', { ids, angle: v })} /><small>°</small></label>
      <button className="btn small" disabled={!has} onClick={() => run('rotate', { ids, angle: 90 })} title="Turn 90° counter-clockwise">⟲ 90°</button>
      <button className="btn small" disabled={!has} onClick={() => run('rotate', { ids, angle: -90 })} title="Turn 90° clockwise">⟳ 90°</button>
      <button className="btn small" disabled={!has} onClick={() => run('mirror', { ids, axis: 'horizontal' })} title="Flip left to right">⇋ Flip</button>
      <button className="btn small" disabled={!has} onClick={() => run('mirror', { ids, axis: 'vertical' })} title="Flip top to bottom">⥮ Flip</button>
      {!has && <span className="muted small">Select a shape to edit it.</span>}
    </div>
  );
}
