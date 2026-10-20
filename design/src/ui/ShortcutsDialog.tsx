import { useEffect, useState } from 'react';
import { ACTIONS, RESERVED, defaults, isValidSpec, label, labelOf, specOf } from '../core/shortcuts';
import { resetAll, resetKey, setKey, useBindings } from './shortcutStore';

/** The keyboard shortcuts, each with a button that takes the next key you press. */
export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const b = useBindings();
  const [capturing, setCapturing] = useState<string | null>(null);
  const [note, setNote] = useState('');

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      e.stopImmediatePropagation();
      if (!capturing) { if (e.key === 'Escape') { e.preventDefault(); onClose(); } return; }
      e.preventDefault();
      if (e.key === 'Escape') { setCapturing(null); setNote(''); return; }
      const spec = specOf(e);
      if (!spec) return;   // a modifier on its own: wait for the key that goes with it
      const key = spec.split('+').pop()!;
      if (RESERVED.includes(key) || !isValidSpec(spec)) { setNote(`${label(spec) || e.key} is kept for something fixed (Escape, Enter, Space, the arrows). Try another key.`); return; }
      if (['f5', 'f12'].includes(key) || spec === 'ctrl+w' || spec === 'ctrl+t' || spec === 'ctrl+r') { setNote(`${label(spec)} belongs to the browser. Try another key.`); return; }
      const took = setKey(capturing, spec);
      setNote(took ? `${label(spec)} was ${labelOf(took)}'s: ${labelOf(took)} now has no key.` : '');
      setCapturing(null);
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [capturing, onClose]);

  const d = defaults();
  const groups = ['Tools', 'Edit', 'File', 'View'] as const;
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
        <h2>Keyboard shortcuts</h2>
        <p className="small muted">Press a key's button, then the key (with Ctrl, Alt or Shift if you like). Escape, Enter, Space and the arrow keys are fixed: Escape cancels, Space pans, the arrows move the picked shapes (Shift for ten times as far, Alt for a tenth). Kept in this browser.</p>
        <div className="keys-list">
          {groups.map((g) => (
            <section key={g} aria-label={g}>
              <h3>{g}</h3>
              {ACTIONS.filter((a) => a.group === g).map((a) => (
                <div className="keys-row" key={a.id}>
                  <span>{a.label}</span>
                  <button className={'btn small key' + (capturing === a.id ? ' primary' : '')} aria-label={`Key for ${a.label}`} onClick={() => { setCapturing(capturing === a.id ? null : a.id); setNote(''); }}>
                    {capturing === a.id ? 'Press a key…' : label(b[a.id]) || 'none'}
                  </button>
                  <button className="btn small" disabled={b[a.id] === d[a.id]} onClick={() => { resetKey(a.id); setNote(''); }} aria-label={`Reset ${a.label}`} title={`Back to ${label(d[a.id]) || 'none'}`}>↺</button>
                  {a.fixed && <small className="muted">also {a.fixed.map(label).join(', ')}</small>}
                </div>
              ))}
            </section>
          ))}
        </div>
        {note && <p className="small" role="status">{note}</p>}
        <div className="row end">
          <button className="btn" onClick={() => { resetAll(); setNote(''); }}>Reset all</button>
          <button className="btn primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
