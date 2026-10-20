import { useEffect, useRef, useState } from 'react';
import type { MaintTask, RunRecord } from '../../shared/protocol';
import type { Machine } from './useMachine';

// Settings > Stats & maintenance: how much the machine has run, the recent jobs, and maintenance tasks that come due
// after so many hours of running time. The server keeps all of it (server/src/stats.ts), so every browser sees the same.

export const hoursText = (h: number) => {
  const abs = Math.abs(h);
  if (abs < 1 / 60) return `${Math.round(abs * 3600)} s`;
  if (abs < 1) return `${Math.round(abs * 60)} min`;
  return `${abs < 10 ? abs.toFixed(1) : Math.round(abs)} h`;
};
const clock = (ms: number) => {
  const s = Math.round(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h} h ${m} min` : m ? `${m} min ${s % 60} s` : `${s} s`;
};
const RESULT: Record<RunRecord['result'], string> = { done: 'Finished', stopped: 'Stopped', error: 'Error' };

export function StatsPage({ m }: { m: Machine }) {
  const st = m.stats;
  const [editing, setEditing] = useState<{ id?: string; name: string; everyHours: string } | null>(null);
  const [setting, setSetting] = useState<string | null>(null);
  const [error, setError] = useState('');
  const seen = useRef(m.replies.statsResult?.n ?? 0);
  useEffect(() => {
    const r = m.replies.statsResult;
    if (!r || r.n === seen.current) return;
    seen.current = r.n;
    if (r.data.ok) { setEditing(null); setSetting(null); setError(''); } else setError(r.data.message ?? 'Not saved');
  }, [m.replies.statsResult]);
  const busy = m.job.state === 'running' || m.job.state === 'paused';
  const due = st.tasks.filter((t) => t.due).length;

  return (
    <div className="camform">
      <div className="muted small">Running time counts only while a job is running (pauses and idle time do not). Kept on the DemonX computer, so every browser shows the same.</div>

      <div className="menu-h">Machine</div>
      <div className="statgrid">
        <div><b>{hoursText(st.totalHours)}</b><span className="muted small">total running time</span></div>
        <div><b>{st.jobs}</b><span className="muted small">jobs run</span></div>
        <div><b>{st.done}</b><span className="muted small">finished</span></div>
        <div><b>{st.stopped + st.errors}</b><span className="muted small">stopped or failed</span></div>
      </div>
      {setting === null
        ? <div className="row"><button type="button" className="btn small" disabled={busy} title="For a machine that has run before DemonX" onClick={() => setSetting(String(Math.round(st.totalHours * 10) / 10))}>Set total hours…</button></div>
        : (
          <div className="row wrap">
            <label className="chk">Total running hours <input type="number" min={0} step="0.1" value={setting} onChange={(e) => setSetting(e.target.value)} style={{ maxWidth: 110 }} /></label>
            <button type="button" className="btn small primary" onClick={() => m.send({ type: 'statsSetHours', hours: Number(setting) })}>Save</button>
            <button type="button" className="btn small" onClick={() => { setSetting(null); setError(''); }}>Cancel</button>
          </div>
        )}

      <div className="menu-h">Maintenance{due > 0 && <span className="duepill">{due} due</span>}</div>
      {st.tasks.length === 0 && <div className="muted small">No tasks yet.</div>}
      <div className="macros">
        {st.tasks.map((t) => <TaskRow key={t.id} t={t} busy={busy} onDone={() => m.send({ type: 'maintServiced', id: t.id })}
          onEdit={() => { setEditing({ id: t.id, name: t.name, everyHours: String(t.everyHours) }); setError(''); }} />)}
      </div>
      {editing ? (
        <div className="macroform">
          <label><span>Task</span><input value={editing.name} maxLength={60} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></label>
          <label><span>Every (running hours)</span><input type="number" min={0.5} step="0.5" value={editing.everyHours} onChange={(e) => setEditing({ ...editing, everyHours: e.target.value })} style={{ maxWidth: 110 }} /></label>
          {error && <div className="err">{error}</div>}
          <div className="row wrap">
            <button type="button" className="btn primary" onClick={() => m.send({ type: 'maintSave', task: { id: editing.id, name: editing.name, everyHours: Number(editing.everyHours) } })}>Save</button>
            <button type="button" className="btn" onClick={() => { setEditing(null); setError(''); }}>Cancel</button>
            {editing.id && <button type="button" className="btn danger" onClick={() => { if (confirm(`Delete "${editing.name}"?`)) { m.send({ type: 'maintDelete', id: editing.id! }); setEditing(null); } }}>Delete</button>}
          </div>
        </div>
      ) : (
        <div className="row"><button type="button" className="btn" onClick={() => { setEditing({ name: '', everyHours: '20' }); setError(''); }}>+ Add a task</button></div>
      )}
      {error && !editing && <div className="err">{error}</div>}

      <div className="menu-h">Recent jobs</div>
      {st.recent.length === 0 && <div className="muted small">Nothing has run yet. Jobs appear here when they finish or are stopped.</div>}
      <table className="ext statlist">
        <tbody>
          {st.recent.slice(0, 15).map((r) => (
            <tr key={r.id}>
              <td title={r.name} className="runname">{r.name}</td>
              <td className={r.result === 'done' ? '' : 'muted'}>{RESULT[r.result]}</td>
              <td>{clock(r.runMs)}</td>
              <td className="muted small">{new Date(r.startedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TaskRow({ t, busy, onDone, onEdit }: { t: MaintTask; busy: boolean; onDone: () => void; onEdit: () => void }) {
  const left = t.due ? `${hoursText(t.dueInHours)} overdue` : `due in ${hoursText(t.dueInHours)}`;
  const last = t.doneAt ? `last done ${new Date(t.doneAt).toLocaleDateString()}` : `${hoursText(t.sinceHours)} since the start`;
  return (
    <div className={`row maint ${t.due ? 'due' : ''}`}>
      <div className="maint-text">
        <b>{t.name}</b>
        <span className="muted small">every {hoursText(t.everyHours)} · {last}</span>
      </div>
      <span className={t.due ? 'duepill' : 'muted small'}>{left}</span>
      <button type="button" className="btn small" disabled={busy} title="Done just now: count the hours again from zero" onClick={onDone}>Done</button>
      <button type="button" className="btn small ghost" aria-label={`Edit ${t.name}`} onClick={onEdit}>Edit</button>
    </div>
  );
}
