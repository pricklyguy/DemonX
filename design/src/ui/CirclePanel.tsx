import { NumField } from './NumField';

export interface CircleSpec {
  /** Where the next circle goes, as the Y box shows it (a laser's Y counts down from the top) */
  x: number;
  y: number;
  mode: 'diameter' | 'radius';
  /** The diameter or the radius, in mm, as `mode` says */
  size: number;
}

export const DEFAULT_CIRCLE: CircleSpec = { x: 0, y: 0, mode: 'diameter', size: 10 };
export const circleRadius = (c: CircleSpec): number => (c.mode === 'diameter' ? c.size / 2 : c.size);

/**
 * Draw Circle, as in VCarve: pick Diameter or Radius and a size, then click on the drawing to put a circle of that size at every
 * click, or type the centre and press Create. Dragging on the drawing still sizes a circle by hand.
 */
export function CirclePanel({ spec, setSpec, onCreate, onClose }: { spec: CircleSpec; setSpec: (c: CircleSpec) => void; onCreate: () => void; onClose: () => void }) {
  return (
    <section className="panel shape-float" role="group" aria-label="Draw Circle">
      <h2><span>Draw Circle</span></h2>
      <div className="body">
        <div className="rhead small muted">Centre point</div>
        <div className="row">
          <label className="inline">X <NumField label="Circle centre X" value={spec.x} step={1} width={86} onCommit={(v) => setSpec({ ...spec, x: v })} /></label>
          <label className="inline">Y <NumField label="Circle centre Y" value={spec.y} step={1} width={86} onCommit={(v) => setSpec({ ...spec, y: v })} /></label>
        </div>
        <div className="row" role="radiogroup" aria-label="Size by">
          <label className="inline"><input type="radio" name="circle-size" checked={spec.mode === 'radius'} onChange={() => setSpec({ ...spec, mode: 'radius', size: spec.mode === 'radius' ? spec.size : Math.round((spec.size / 2) * 1000) / 1000 })} /> Radius</label>
          <label className="inline"><input type="radio" name="circle-size" checked={spec.mode === 'diameter'} onChange={() => setSpec({ ...spec, mode: 'diameter', size: spec.mode === 'diameter' ? spec.size : Math.round(spec.size * 2 * 1000) / 1000 })} /> Diameter</label>
        </div>
        <label className="inline">{spec.mode === 'diameter' ? 'D' : 'R'} <NumField label={spec.mode === 'diameter' ? 'Circle diameter' : 'Circle radius'} value={spec.size} min={0.001} step={1} width={86} onCommit={(v) => setSpec({ ...spec, size: v })} /> <small>mm</small></label>
        <p className="muted small">Click on the drawing to put a circle of this size there, again and again. Drag to size one by hand.</p>
        <div className="row">
          <button className="btn primary" onClick={onCreate}>Create</button>
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </section>
  );
}
