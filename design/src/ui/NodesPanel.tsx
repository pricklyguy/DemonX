import type { NodeRef } from '../core/nodes';
import type { Doc } from '../core/types';

type Run = (id: string, args: unknown, echo?: boolean) => boolean;

/** Buttons for the Nodes tool: what can be done to the points picked on the selected path. */
export function NodesPanel({ doc, selection, nodeSel, setNodeSel, corner, run }: {
  doc: Doc;
  selection: number[];
  nodeSel: NodeRef[];
  setNodeSel: (n: NodeRef[]) => void;
  corner: { radius: number; style: string };
  run: Run;
}) {
  const shape = selection.length === 1 ? doc.shapes.find((s) => s.id === selection[0]) : undefined;
  const path = shape && shape.kind === 'path' ? shape : null;
  const circle = shape && shape.kind === 'circle' ? shape : null;
  const count = path ? path.rings.reduce((n, r) => n + r.length, 0) : 0;
  const one = nodeSel.length === 1 ? nodeSel[0] : null;
  const id = path?.id;

  return (
    <section className="panel">
      <h2><span>Nodes</span></h2>
      <div className="body nodes">
        {!shape && <p className="muted small">Click a line or outline to show its points. Drag a point to move it, double-click a segment to add a point, Shift-click or drag a box to pick several, Delete removes the picked points.</p>}
        {circle && (
          <>
            <p className="muted small">A circle is one exact shape and has no points to move. Turn it into a path to edit it.</p>
            <button className="btn small" onClick={() => run('to_path', { ids: [circle.id] })}>Turn into a path</button>
          </>
        )}
        {selection.length > 1 && <p className="muted small">Select a single shape to edit its points.</p>}
        {path && (
          <>
            <div className="mono small">{count} points{nodeSel.length ? ` · ${nodeSel.length} picked` : ''} · {path.closed ? 'closed' : 'open'}</div>
            <div className="row wrap">
              <button className="btn small" disabled={nodeSel.length < 2} onClick={() => { if (!run('node_insert', { id, nodes: nodeSel })) return; setNodeSel([]); }} title="Put a point in the middle of each segment between two picked neighbours">Add between</button>
              <button className="btn small danger" disabled={!nodeSel.length} onClick={() => { if (run('nodes_delete', { id, nodes: nodeSel })) setNodeSel([]); }} title="Remove the picked points (Delete)">Delete points</button>
              <button className="btn small" disabled={!one} onClick={() => { if (run('node_break', { id, ring: one!.ring, i: one!.i })) setNodeSel([]); }} title="Cut open at the picked point; an open line is split in two there">Break here</button>
              <button className="btn small" onClick={() => { if (run('path_close', { id, closed: !path.closed })) setNodeSel([]); }} title={path.closed ? 'Make it an open line' : 'Join the ends into a closed outline'}>{path.closed ? 'Open path' : 'Close path'}</button>
            </div>
            <div className="row wrap">
              <button className="btn small" disabled={!nodeSel.length || !(corner.radius > 0)} onClick={() => run('fillet', { ids: [id], radius: corner.radius, style: corner.style, nodes: nodeSel })} title="Round (or scoop, or chamfer) only the picked corners, using the radius and style under Selection">Corners of picked points</button>
            </div>
            <p className="muted small">The first point is ringed: that is where the outline starts.</p>
          </>
        )}
      </div>
    </section>
  );
}
