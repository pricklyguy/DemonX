import { ColorField } from './ColorField';
import { useEffect, useRef, useState } from 'react';
import type { Doc } from '../core/types';
import { LayerButtons, LayerData, LayerDeleteDialog, LayerName, useLayerTools } from './LayerTools';

type Run = (id: string, args: unknown, echo?: boolean) => boolean;

/** The active layer, shown in the header. Click to see every layer, pick one, hide or recolour it, or make a new one. */
export function LayerPicker({ doc, active, setActive, run }: { doc: Doc; active: string; setActive: (n: string) => void; run: Run }) {
  const [open, setOpen] = useState(false);
  const [fresh, setFresh] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const cur = doc.layers.find((l) => l.name === active) ?? doc.layers[0];
  const tools = useLayerTools(doc, run, active, setActive);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node) && !tools.deleting) setOpen(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  const add = (e: React.FormEvent) => {
    e.preventDefault();
    const nm = fresh.trim();
    if (!nm) return;
    if (run('layer_set', { name: nm })) { setActive(nm); setFresh(''); setOpen(false); }
  };

  return (
    <div className="layerpick" ref={box} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } }}>
      <button className="btn layer-btn" aria-haspopup="listbox" aria-expanded={open} aria-label={`Active layer: ${cur?.name}`} title="The layer new shapes are drawn on. Click to choose another or make a new one." onClick={() => setOpen(!open)}>
        <i className="swatch-dot" style={{ background: cur?.color }} />
        <span>{cur?.name}</span> ▾
      </button>
      {open && (
        <div className="menu layermenu" role="listbox" aria-label="Layers">
          {doc.layers.map((l) => (
            <div key={l.name} className={'layer-row' + (l.name === active ? ' active' : '')} role="option" aria-selected={l.name === active}>
              <input type="checkbox" checked={l.visible} title="Show / hide" aria-label={`Show ${l.name}`} onChange={(e) => run('layer_set', { name: l.name, visible: e.target.checked }, false)} />
              <ColorField value={l.color} label={`${l.name} colour`} onChange={(hex) => run('layer_set', { name: l.name, color: hex }, false)} />
              <LayerName name={l.name} tools={tools} onPick={() => { setActive(l.name); setOpen(false); }} />
              <LayerData doc={doc} name={l.name} />
              <LayerButtons doc={doc} name={l.name} tools={tools} />
            </div>
          ))}
          <form className="row newlayer" onSubmit={add}>
            <input value={fresh} onChange={(e) => setFresh(e.target.value)} placeholder="New layer…" aria-label="New layer name" autoComplete="off" />
            <button className="btn small" type="submit" disabled={!fresh.trim()}>Add</button>
          </form>
        </div>
      )}
      <LayerDeleteDialog doc={doc} tools={tools} />
    </div>
  );
}
