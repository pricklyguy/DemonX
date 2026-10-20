import { NumField } from './NumField';
import { AnchorGrid } from './AnchorGrid';
import { anchorName } from '../core/laser';
import type { Anchor } from '../core/geom';

export interface RectSpec {
  /** Where the chosen point of the rectangle goes, as the Y box shows it (a laser's Y counts down from the top) */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Which point of the rectangle the X and Y (and a click on the drawing) are */
  anchor: Anchor;
}

export const DEFAULT_RECT: RectSpec = { x: 0, y: 0, w: 20, h: 10, anchor: 'c' };

/** Draw Rectangle, as in VCarve: a width and a height, which point of the rectangle you place, then click on the drawing (again and again) or type the place and Create. Dragging still draws one by hand. */
export function RectPanel({ spec, setSpec, onCreate, onClose }: { spec: RectSpec; setSpec: (r: RectSpec) => void; onCreate: () => void; onClose: () => void }) {
  return (
    <section className="panel shape-float" role="group" aria-label="Draw Rectangle">
      <h2><span>Draw Rectangle</span></h2>
      <div className="body">
        <div className="row">
          <label className="inline">Width <NumField label="Rectangle width" value={spec.w} min={0.001} step={1} width={78} onCommit={(v) => setSpec({ ...spec, w: v })} /></label>
          <label className="inline">Height <NumField label="Rectangle height" value={spec.h} min={0.001} step={1} width={78} onCommit={(v) => setSpec({ ...spec, h: v })} /></label>
          <small>mm</small>
        </div>
        <div className="row">
          <AnchorGrid value={spec.anchor} onChange={(a) => setSpec({ ...spec, anchor: a })} label="Point" />
          <span className="small">The <b>{anchorName(spec.anchor)}</b> of the rectangle goes at the point below</span>
        </div>
        <div className="row">
          <label className="inline">X <NumField label="Rectangle point X" value={spec.x} step={1} width={86} onCommit={(v) => setSpec({ ...spec, x: v })} /></label>
          <label className="inline">Y <NumField label="Rectangle point Y" value={spec.y} step={1} width={86} onCommit={(v) => setSpec({ ...spec, y: v })} /></label>
        </div>
        <p className="muted small">Click on the drawing to put a rectangle of this size there, again and again. Drag to draw one by hand.</p>
        <div className="row">
          <button className="btn primary" onClick={onCreate}>Create</button>
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </section>
  );
}
