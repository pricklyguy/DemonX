import { useEffect, useState } from 'react';
import { ACTIONS, DEFAULT_KEYS, keyLabel, type KeyAction } from '../../shared/keys';
import { isModifierCode, type KeysState } from './keyboard';

// Settings > Keyboard (this browser only)

export function KeyboardPage({ keys }: { keys: KeysState }) {
  const [picking, setPicking] = useState<KeyAction | null>(null);
  const [note, setNote] = useState('');

  useEffect(() => {
    keys.capturing.current = picking !== null;
    if (!picking) return;
    const on = (e: KeyboardEvent) => {
      if (isModifierCode(e.code)) return;                  // wait for the real key
      e.preventDefault(); e.stopPropagation();
      const took = keys.setKey(picking, e.code);
      const label = (id: KeyAction) => ACTIONS.find((a) => a.id === id)!.label;
      setNote(took ? `${keyLabel(e.code)} was used for "${label(took)}", which now has no key.` : '');
      setPicking(null);
    };
    window.addEventListener('keydown', on, true);
    return () => { window.removeEventListener('keydown', on, true); keys.capturing.current = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picking]);

  return (
    <div className="camform">
      <div className="muted small">Jog and a few safe actions from the keyboard, in this browser only. A quick tap moves one step (the step in the Jog panel); holding a key keeps the machine moving until you let go.</div>
      <label className="chk"><input type="checkbox" checked={keys.enabled} onChange={(e) => keys.setEnabled(e.target.checked)} />Use keyboard shortcuts in this browser</label>

      <div className="menu-h">Keys</div>
      <table className="ext keytable">
        <tbody>
          {ACTIONS.map((a) => (
            <tr key={a.id}>
              <td><b>{a.label}</b><div className="muted small">{a.hint}</div></td>
              <td>{picking === a.id ? <span className="muted">press a key…</span> : <kbd>{keyLabel(keys.bindings[a.id])}</kbd>}</td>
              <td className="row">
                {picking === a.id
                  ? <button type="button" className="btn small" onClick={() => setPicking(null)}>Cancel</button>
                  : <button type="button" className="btn small" onClick={() => { setNote(''); setPicking(a.id); }}>Change</button>}
                <button type="button" className="btn small ghost" disabled={!keys.bindings[a.id]} onClick={() => { keys.setKey(a.id, ''); setNote(''); }}>Clear</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {note && <div className="muted small">{note}</div>}
      <div className="row">
        <button type="button" className="btn" disabled={ACTIONS.every((a) => keys.bindings[a.id] === DEFAULT_KEYS[a.id])} onClick={() => { keys.reset(); setNote(''); }}>Back to the default keys</button>
      </div>

      <div className="menu-h">Safety</div>
      <ul className="small" style={{ margin: 0, paddingLeft: '1.2em' }}>
        <li>Shortcuts do nothing while you are typing in a box, and not with Ctrl, Alt or Cmd held.</li>
        <li>A jog key moves the machine only while it is held. The machine stops when you let go, when this page loses focus, or when DemonX stops hearing from this browser.</li>
        <li>One hold lasts at most 30 seconds, and Z moves at most 20 mm per hold. Let go and press again to continue.</li>
        <li>Shortcuts need the PIN like any other control, and do not work during a job (Feed hold and Stop jogging still do).</li>
        <li>There is no shortcut for Start, Resume, Unlock or Home on purpose.</li>
      </ul>
    </div>
  );
}
