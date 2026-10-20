import { useState } from 'react';
import { NumField } from './NumField';
import { AnchorGrid } from './AnchorGrid';
import { anchorName } from '../core/laser';
import type { Anchor, Bounds } from '../core/geom';

type Run = (id: string, args: unknown, echo?: boolean) => boolean;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/**
 * Move and resize the selection from one card, as in VCarve. Move shifts by a distance (repeatable). Resize takes a width and height in
 * mm or in percent; with the link on, changing one changes the other in proportion, with it off they are set apart. Nothing happens
 * until Resize is pressed. Remount it (key) when the selection changes so the boxes show the new size.
 */
export function MoveResize({ ids, box, allCircles, yTop, link, setLink, run, onDone }: { ids: number[]; box: Bounds; allCircles: boolean; yTop: number | null; link: boolean; setLink: (v: boolean) => void; run: Run; onDone: () => void }) {
  const w0 = box.maxX - box.minX, h0 = box.maxY - box.minY;
  const [dx, setDx] = useState(0), [dy, setDy] = useState(0);
  const [w, setW] = useState(r3(w0)), [h, setH] = useState(r3(h0));
  const [anchor, setAnchor] = useState<Anchor>('c');
  const flat = w0 < 1e-9 || h0 < 1e-9; // a straight line has one size only
  const linked = (link || allCircles) && !flat;
  const pct = (v: number, o: number) => (o > 1e-9 ? r3((v / o) * 100) : 100);
  const setWidth = (v: number) => { setW(v); if (linked) setH(r3((v / w0) * h0)); };
  const setHeight = (v: number) => { setH(v); if (linked) setW(r3((v / h0) * w0)); };
  const changed = (w0 >= 1e-9 && Math.abs(w - w0) > 5e-4) || (h0 >= 1e-9 && Math.abs(h - h0) > 5e-4);
  return (
    <div role="group" aria-label="Move and resize">
      <h3 title="Drag the title to move this card">Move and resize</h3>
      <div className="rhead small muted">Move by</div>
      <div className="row wrap">
        <label className="inline">X <NumField label="Move X distance" value={dx} step={1} width={72} onCommit={setDx} /></label>
        <label className="inline">Y <NumField label="Move Y distance" value={dy} step={1} width={72} onCommit={setDy} /></label>
        <small>mm</small>
        <button className="btn small" disabled={!dx && !dy} aria-label="Move the selection" onClick={() => run('move', { ids, dx, dy: yTop === null ? dy : -dy })}>Move</button>
      </div>
      <div className="rhead small muted">Resize</div>
      <div className="row">
        <AnchorGrid value={anchor} onChange={setAnchor} label="Keep" />
        <span className="small">The <b>{anchorName(anchor)}</b> stays where it is</span>
      </div>
      <div className="row wrap">
        <label className="inline">Width <NumField label="Resize width" value={w} disabled={w0 < 1e-9} min={0.001} step={1} width={78} onCommit={setWidth} /><small>mm</small></label>
        <label className="inline"><NumField label="Resize width percent" value={pct(w, w0)} disabled={w0 < 1e-9} min={0.1} step={5} width={62} onCommit={(v) => setWidth(r3((v / 100) * w0))} /><small>%</small></label>
      </div>
      <div className="row wrap">
        <label className="inline">Height <NumField label="Resize height" value={h} disabled={h0 < 1e-9} min={0.001} step={1} width={78} onCommit={setHeight} /><small>mm</small></label>
        <label className="inline"><NumField label="Resize height percent" value={pct(h, h0)} disabled={h0 < 1e-9} min={0.1} step={5} width={62} onCommit={(v) => setHeight(r3((v / 100) * h0))} /><small>%</small></label>
      </div>
      <div className="row wrap">
        <button className={'btn small lock' + (linked ? ' on' : '')} disabled={allCircles || flat} aria-pressed={linked} aria-label="Link X and Y" onClick={() => setLink(!link)} title={allCircles ? 'Circles always keep their proportions' : 'Linked: changing the width changes the height in proportion (and the other way round)'}>{linked ? '🔒 X and Y linked' : '🔓 X and Y apart'}</button>
        <button className="btn small primary" disabled={!changed} aria-label="Apply the new size" onClick={() => { if (run('set_bounds', { ids, anchor, ...(w0 >= 1e-9 ? { width: w } : {}), ...(h0 >= 1e-9 ? { height: h } : {}) })) onDone(); }}>Resize</button>
      </div>
    </div>
  );
}
