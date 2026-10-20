import { NumField } from './NumField';

export interface FilletSpec { radius: number; style: 'round' | 'cove' | 'chamfer' }
export const DEFAULT_FILLET: FilletSpec = { radius: 3, style: 'round' };

/**
 * The Fillet tool's card: a radius and a style. Click a corner of a shape to round it. To round the corner between two separate lines,
 * click the end of one and then the end of the other: they are extended (or cut back) to meet, joined, and rounded in one go.
 */
export function FilletPanel({ spec, setSpec, onClose, said }: { spec: FilletSpec; setSpec: (f: FilletSpec) => void; onClose: () => void; /** What the last click did (or why nothing changed), in the program's words */ said?: { kind: string; text: string } | null }) {
  return (
    <section className="panel shape-float" role="group" aria-label="Fillet">
      <h2><span>Fillet</span></h2>
      <div className="body">
        <label className="inline">Radius <NumField label="Fillet radius" value={spec.radius} min={0.001} step={0.5} width={86} onCommit={(v) => setSpec({ ...spec, radius: v })} /> <small>mm</small></label>
        <div className="row" role="radiogroup" aria-label="Fillet style">
          <label className="inline"><input type="radio" name="fillet-style" checked={spec.style === 'round'} onChange={() => setSpec({ ...spec, style: 'round' })} /> Round</label>
          <label className="inline"><input type="radio" name="fillet-style" checked={spec.style === 'cove'} onChange={() => setSpec({ ...spec, style: 'cove' })} title="An inside scoop centred on the corner, for a square part to drop into a round-cornered pocket" /> Scoop</label>
          <label className="inline"><input type="radio" name="fillet-style" checked={spec.style === 'chamfer'} onChange={() => setSpec({ ...spec, style: 'chamfer' })} /> Chamfer</label>
        </div>
        <p className="muted small">Click a corner to round it. For two separate lines, click the end of one, then the end of the other: they are extended or cut back to meet, joined and rounded in one step.</p>
        {said && <p className="small" role="status" aria-label="Last fillet" style={{ color: said.kind === 'err' ? 'var(--danger, #e5534b)' : undefined }}>{said.text}</p>}
        <div className="row"><button className="btn" onClick={onClose}>Close</button></div>
      </div>
    </section>
  );
}
