import { fmt, measure } from '../core/measure';
import type { Pt } from '../core/types';

/**
 * The measuring tool's card: the distance between two points, the steps across and up, and the angle. Y counts the way the Y boxes
 * do (down the page on a laser design). Click two points, or drag from one to the other; the points jump to corners, centres and
 * crossings of shapes (Points) and to the grid (Grid) like the drawing tools do.
 */
export function MeasurePanel({ m, yTop, onClear, onClose }: { m: { a: Pt; b: Pt | null } | null; yTop: number | null; onClear: () => void; onClose: () => void }) {
  const r = m && m.b ? measure(m.a, m.b, yTop !== null) : null;
  const yOf = (p: Pt) => (yTop === null ? p[1] : yTop - p[1]);
  const copy = (text: string) => { try { void navigator.clipboard?.writeText(text); } catch { /* the number is on the screen anyway */ } };
  return (
    <section className="panel shape-float" role="group" aria-label="Measure">
      <h2><span>Measure</span></h2>
      <div className="body">
        {!m && <p className="muted small">Click the first point, then the second. Or drag from one to the other.</p>}
        {m && !m.b && <p className="muted small">Now click the second point.</p>}
        {m && (
          <div className="small mono" aria-label="Points">
            A  X {fmt(m.a[0], 3)}  Y {fmt(yOf(m.a), 3)}{m.b && <><br />B  X {fmt(m.b[0], 3)}  Y {fmt(yOf(m.b), 3)}</>}
          </div>
        )}
        {r && (
          <table className="small mono" aria-label="Measurement">
            <tbody>
              <tr><td>Distance</td><td aria-label="Distance">{fmt(r.distance, 3)} mm</td><td className="muted">{fmt(r.distance / 25.4, 4)} in</td></tr>
              <tr><td>ΔX</td><td aria-label="Across">{fmt(r.dx, 3)} mm</td><td className="muted">{fmt(r.dx / 25.4, 4)} in</td></tr>
              <tr><td>ΔY</td><td aria-label="Up">{fmt(r.dy, 3)} mm</td><td className="muted">{fmt(r.dy / 25.4, 4)} in</td></tr>
              <tr><td>Angle</td><td aria-label="Angle">{fmt(r.angle, 2)}°</td><td /></tr>
            </tbody>
          </table>
        )}
        <div className="row">
          <button className="btn" disabled={!r} onClick={() => r && copy(String(r.distance))} title="Copy the distance (mm) to the clipboard">Copy distance</button>
          <button className="btn" disabled={!m} onClick={onClear}>Clear</button>
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </section>
  );
}
