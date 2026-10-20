import { NumField } from './NumField';
import type { ShapeSpec } from '../core/shapes';

export interface ShapeState {
  /** The centre of the next shape, as the Y box shows it (a laser's Y counts down from the top) */
  x: number;
  y: number;
  /** Whether the size fields are diameters or radii (Diameter is the default, as in the circle panel) */
  mode: 'diameter' | 'radius';
}
export const DEFAULT_SHAPE_STATE: ShapeState = { x: 0, y: 0, mode: 'diameter' };

const TITLES = { ellipse: 'Draw Ellipse', polygon: 'Draw Polygon', star: 'Draw Star', arc: 'Draw Arc' } as const;
const HINTS = {
  ellipse: 'Click on the drawing to put an ellipse of this size there, again and again. Drag to draw one by hand.',
  polygon: 'Click to put the polygon there, again and again. Drag outwards from the centre to size one by hand.',
  star: 'Click to put the star there, again and again. Drag outwards from the centre to size one by hand.',
  arc: 'Click to put the arc there, again and again. Arcs run anticlockwise from the start angle to the end angle. Drag outwards from the centre to size one by hand.',
} as const;

/**
 * The card for the ellipse, polygon, star and arc tools: the numbers of the shape, then a click on the drawing puts it down
 * (again at every click), or type the centre and press Create. Dragging on the drawing still sizes one by hand.
 */
export function ShapePanel({ spec, setSpec, at, setAt, onCreate, onClose }: { spec: ShapeSpec; setSpec: (s: ShapeSpec) => void; at: ShapeState; setAt: (a: ShapeState) => void; onCreate: () => void; onClose: () => void }) {
  const title = TITLES[spec.kind];
  const k = spec.kind;
  // sizes given by radius are shown as diameters unless the owner picks Radius
  const sized = k === 'polygon' || k === 'star' || k === 'arc';
  const shown = (r: number) => Math.round((at.mode === 'diameter' ? r * 2 : r) * 1000) / 1000;
  const stored = (v: number) => (at.mode === 'diameter' ? v / 2 : v);
  const sizeLabel = (what: string) => `${what} ${at.mode === 'diameter' ? 'diameter' : 'radius'}`;
  return (
    <section className="panel shape-float" role="group" aria-label={title}>
      <h2><span>{title}</span></h2>
      <div className="body">
        <div className="rhead small muted">Centre point</div>
        <div className="row">
          <label className="inline">X <NumField label={`${k} centre X`} value={at.x} step={1} width={86} onCommit={(v) => setAt({ ...at, x: v })} /></label>
          <label className="inline">Y <NumField label={`${k} centre Y`} value={at.y} step={1} width={86} onCommit={(v) => setAt({ ...at, y: v })} /></label>
        </div>
        {sized && (
          <div className="row" role="radiogroup" aria-label="Size by">
            <label className="inline"><input type="radio" name="shape-size" checked={at.mode === 'radius'} onChange={() => setAt({ ...at, mode: 'radius' })} /> Radius</label>
            <label className="inline"><input type="radio" name="shape-size" checked={at.mode === 'diameter'} onChange={() => setAt({ ...at, mode: 'diameter' })} /> Diameter</label>
          </div>
        )}
        {spec.kind === 'ellipse' && (
          <div className="row">
            <label className="inline">Width <NumField label="Ellipse width" value={spec.w} min={0.001} step={1} width={80} onCommit={(v) => setSpec({ ...spec, w: v })} /></label>
            <label className="inline">Height <NumField label="Ellipse height" value={spec.h} min={0.001} step={1} width={80} onCommit={(v) => setSpec({ ...spec, h: v })} /></label>
          </div>
        )}
        {spec.kind === 'polygon' && (
          <>
            <label className="inline">Sides <NumField label="Polygon sides" value={spec.sides} min={3} max={200} step={1} width={70} onCommit={(v) => setSpec({ ...spec, sides: Math.round(v) })} /></label>
            <label className="inline">Size <NumField label={sizeLabel('Polygon')} value={shown(spec.r)} min={0.001} step={1} width={86} onCommit={(v) => setSpec({ ...spec, r: stored(v) })} /> <small>mm, corner to corner</small></label>
          </>
        )}
        {spec.kind === 'star' && (
          <>
            <label className="inline">Points <NumField label="Star points" value={spec.points} min={3} max={200} step={1} width={70} onCommit={(v) => setSpec({ ...spec, points: Math.round(v) })} /></label>
            <label className="inline">Size <NumField label={sizeLabel('Star')} value={shown(spec.r)} min={0.001} step={1} width={86} onCommit={(v) => setSpec({ ...spec, r: stored(v) })} /> <small>mm, tip to tip</small></label>
            <label className="inline">Inner <NumField label="Star inner size" value={Math.round(spec.inner * 100)} min={1} max={99} step={5} width={70} onCommit={(v) => setSpec({ ...spec, inner: Math.min(0.99, Math.max(0.01, v / 100)) })} /> <small>% of the outer</small></label>
          </>
        )}
        {spec.kind === 'arc' && (
          <>
            <label className="inline">Size <NumField label={sizeLabel('Arc')} value={shown(spec.r)} min={0.001} step={1} width={86} onCommit={(v) => setSpec({ ...spec, r: stored(v) })} /> <small>mm</small></label>
            <div className="row">
              <label className="inline">Start <NumField label="Arc start angle" value={spec.start} step={15} width={70} onCommit={(v) => setSpec({ ...spec, start: v })} /> <small>°</small></label>
              <label className="inline">End <NumField label="Arc end angle" value={spec.end} step={15} width={70} onCommit={(v) => setSpec({ ...spec, end: v })} /> <small>°</small></label>
            </div>
          </>
        )}
        <p className="muted small">{HINTS[k]}</p>
        <div className="row">
          <button className="btn primary" onClick={onCreate}>Create</button>
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </section>
  );
}
