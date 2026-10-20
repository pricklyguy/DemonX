import { useState } from 'react';
import type { Doc } from '../core/types';

type Run = (id: string, args: unknown, echo?: boolean) => boolean;

/** Renaming, deleting and reordering layers: the same in the header's layer list and in the Laser panel's table. */
export function useLayerTools(doc: Doc, run: Run, active: string, setActive: (n: string) => void) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);

  const startEdit = (name: string) => { setEditing(name); setDraft(name); };
  const commitRename = () => {
    const from = editing;
    const to = draft.trim();
    setEditing(null);
    if (from === null || !to || to === from) return;
    if (run('layer_rename', { name: from, to })) { if (active === from) setActive(to); }
  };
  const move = (name: string, direction: 'up' | 'down') => { run('layer_move', { name, direction }, false); };
  const askDelete = (name: string) => {
    if (doc.shapes.some((s) => s.layer === name) && doc.layers.length > 1) setDeleting(name);
    else run('layer_delete', { name }); // an empty layer goes at once; the last layer is refused with the reason
  };
  const doDelete = (name: string, moveTo: string | null) => {
    setDeleting(null);
    run('layer_delete', moveTo ? { name, moveTo } : { name, deleteShapes: true });
  };
  return { editing, draft, setDraft, startEdit, commitRename, cancelEdit: () => setEditing(null), move, askDelete, deleting, cancelDelete: () => setDeleting(null), doDelete };
}
export type LayerTools = ReturnType<typeof useLayerTools>;

/** The name of a layer: a button to make it active, or a text box while it is being renamed (Enter keeps it, Escape cancels) */
export function LayerName({ name, tools, onPick, title }: { name: string; tools: LayerTools; onPick: () => void; title?: string }) {
  if (tools.editing === name) {
    return (
      <input
        className="layer-edit" autoFocus value={tools.draft} maxLength={40} aria-label={`New name for ${name}`}
        onChange={(e) => tools.setDraft(e.target.value)} onBlur={tools.commitRename}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') tools.commitRename(); else if (e.key === 'Escape') tools.cancelEdit(); }}
      />
    );
  }
  return <button className="layer-name" onClick={onPick} onDoubleClick={() => tools.startEdit(name)} title={title ?? `${name} (double-click to rename)`}>{name}</button>;
}

/** Up, down, rename and delete for one layer */
export function LayerButtons({ doc, name, tools, labels }: { doc: Doc; name: string; tools: LayerTools; labels?: boolean }) {
  const i = doc.layers.findIndex((l) => l.name === name);
  return (
    <span className={'layer-tools' + (labels ? ' labelled' : '')}>
      <button className={labels ? 'btn small' : 'icon-btn'} aria-label={`Move ${name} up`} title="Move up: layers burn from the top of the list down" disabled={i <= 0} onClick={() => tools.move(name, 'up')}>▲{labels ? ' Up' : ''}</button>
      <button className={labels ? 'btn small' : 'icon-btn'} aria-label={`Move ${name} down`} title="Move down" disabled={i < 0 || i >= doc.layers.length - 1} onClick={() => tools.move(name, 'down')}>▼{labels ? ' Down' : ''}</button>
      <button className={labels ? 'btn small' : 'icon-btn'} aria-label={`Rename ${name}`} title="Rename (or double-click the name)" onClick={() => tools.startEdit(name)}>✎{labels ? ' Rename' : ''}</button>
      <button className={labels ? 'btn small danger' : 'icon-btn'} aria-label={`Delete ${name}`} title="Delete this layer" onClick={() => tools.askDelete(name)}>✕{labels ? ' Delete' : ''}</button>
    </span>
  );
}

/** Asked when a layer that has shapes on it is deleted: move them to another layer, or delete them too */
export function LayerDeleteDialog({ doc, tools }: { doc: Doc; tools: LayerTools }) {
  const name = tools.deleting;
  const others = doc.layers.filter((l) => l.name !== name);
  const [target, setTarget] = useState<string>('');
  if (!name) return null;
  const count = doc.shapes.filter((s) => s.layer === name).length;
  const dest = target && others.some((l) => l.name === target) ? target : others[0]?.name ?? '';
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && tools.cancelDelete()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={`Delete layer ${name}`}>
        <h2>Delete layer {name}?</h2>
        <p className="small">{count} shape{count === 1 ? ' is' : 's are'} on this layer.</p>
        <label className="inline small">Move {count === 1 ? 'it' : 'them'} to
          <select value={dest} aria-label="Move the shapes to layer" onChange={(e) => setTarget(e.target.value)}>
            {others.map((l) => <option key={l.name} value={l.name}>{l.name}</option>)}
          </select>
        </label>
        <div className="row end">
          <button className="btn" onClick={tools.cancelDelete}>Cancel</button>
          <button className="btn danger" onClick={() => tools.doDelete(name, null)}>Delete the layer and its shapes</button>
          <button className="btn primary" onClick={() => tools.doDelete(name, dest)}>Delete the layer, keep the shapes</button>
        </div>
      </div>
    </div>
  );
}

/** A small mark on a layer row: a number when there are shapes on it, an empty mark when it is empty (so it is safe to delete) */
export function LayerData({ doc, name }: { doc: Doc; name: string }) {
  let n = 0;
  for (const s of doc.shapes) if (s.layer === name) n++;
  return n
    ? <span className="ldata" title={`${n} shape${n === 1 ? '' : 's'} on this layer`} aria-label={`${n} shape${n === 1 ? '' : 's'} on ${name}`}>▣ {n}</span>
    : <span className="ldata empty" title="Nothing on this layer: it is safe to delete" aria-label={`${name} is empty`}>▢</span>;
}
