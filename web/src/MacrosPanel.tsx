import { useEffect, useRef, useState } from 'react';
import type { Macro } from '../../shared/protocol';
import { Panel } from './Dock';
import type { Machine } from './useMachine';

const HELP = `One G-code command per line. ; and ( ) start comments.
%wait waits for the machine to stop moving before the next line.
[xmin] [xmax] [ymin] [ymax] [zmin] [zmax] are filled in from the loaded G-code file.
Probing (G38) is not allowed here: use the Probe panel, which asks the safety questions.`;

export function MacrosPanel({ m }: { m: Machine }) {
  return (
    <Panel id="macros" title="Macros">
      <Macros m={m} />
    </Panel>
  );
}

function Macros({ m }: { m: Machine }) {
  const [editing, setEditing] = useState<{ id?: string; name: string; content: string } | null>(null);
  const [error, setError] = useState('');
  const seen = useRef(m.replies.macroResult?.n ?? 0);
  useEffect(() => {
    const r = m.replies.macroResult;
    if (!r || r.n === seen.current) return;
    seen.current = r.n;
    if (r.data.ok) { setEditing(null); setError(''); } else setError(r.data.message ?? 'Not saved');
  }, [m.replies.macroResult]);

  const busy = m.job.state === 'running' || m.job.state === 'paused' || m.probe.phase !== 'idle';
  const canRun = m.connection.connected && m.status.state === 'Idle' && !busy;

  if (editing) {
    return (
      <div className="macroform">
        <label><span>Name</span><input value={editing.name} maxLength={40} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></label>
        <textarea spellCheck={false} rows={10} value={editing.content} placeholder="G90&#10;G0 X0 Y90" onChange={(e) => setEditing({ ...editing, content: e.target.value })} />
        <div className="muted small" style={{ whiteSpace: 'pre-line' }}>{HELP}</div>
        {error && <div className="err">{error}</div>}
        <div className="row wrap">
          <button className="btn small primary" onClick={() => { setError(''); m.send({ type: 'macroSave', macro: editing }); }}>Save</button>
          <button className="btn small" onClick={() => { setEditing(null); setError(''); }}>Cancel</button>
          {editing.id && (
            <button className="btn small danger" onClick={() => { if (window.confirm(`Delete the macro "${editing.name}"?`)) { m.send({ type: 'macroDelete', id: editing.id! }); setEditing(null); } }}>Delete</button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="macros">
      {m.macros.length === 0 && <div className="muted small">No macros yet. Add one for a move or sequence you repeat.</div>}
      {m.macros.map((x: Macro) => (
        <div className="row macro-row" key={x.id}>
          <button className="btn macro-run" disabled={!canRun} title={x.content} onClick={() => m.send({ type: 'macroRun', id: x.id })}>▶ {x.name}</button>
          <button className="btn small" aria-label={`Edit ${x.name}`} title="Edit" onClick={() => { setError(''); setEditing({ ...x }); }}>✎</button>
        </div>
      ))}
      <div className="row"><button className="btn small" onClick={() => { setError(''); setEditing({ name: '', content: '' }); }}>+ New macro</button></div>
      {!canRun && m.macros.length > 0 && <div className="muted small">{busy ? 'Not while a job or probe is running.' : 'Connect and wait for the machine to be Idle to run a macro.'}</div>}
    </div>
  );
}
