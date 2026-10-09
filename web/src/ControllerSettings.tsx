import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AXIS_FIELDS, GRBL_SETTINGS, isReadOnlyKey, sameValue,
  type MachineSettings, type SettingChange, type SettingValue,
} from '../../shared/machine-settings';
import type { Machine } from './useMachine';

// Settings > Controller: the machine's own settings. FluidNC keeps them in a config file (a change is tried live
// first, then saved on purpose); classic GRBL keeps its $ settings itself. Values are the controller's, so in mm.

type Confirm = null | 'apply' | 'save' | 'restart';

export function ControllerSettings({ m }: { m: Machine }) {
  const snap = m.replies.machineSettings?.data;
  const result = m.replies.machineSettingsResult;
  const [edits, setEdits] = useState<Record<string, SettingValue>>({});
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [filter, setFilter] = useState('');
  const thenSave = useRef(false);   // "Apply, then save": after the apply succeeds, go on to the save question
  const seenSnap = useRef(0), seenResult = useRef(m.replies.machineSettingsResult?.n ?? 0);

  const ready = m.connection.connected && m.job.state !== 'running' && m.job.state !== 'paused' && (m.status.state === 'Idle' || m.status.state === 'Alarm');
  const read = () => { setBusy(true); setNote(null); m.send({ type: 'settingsRead' }); };
  useEffect(() => { if (ready && !snap) read(); }, [ready]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (m.replies.machineSettings && m.replies.machineSettings.n !== seenSnap.current) { seenSnap.current = m.replies.machineSettings.n; setBusy(false); setEdits({}); } }, [m.replies.machineSettings]);
  useEffect(() => {
    if (!result || result.n === seenResult.current) return;
    seenResult.current = result.n; setBusy(false); setConfirm(null);
    setNote({ ok: result.data.ok, text: result.data.message });
    if (thenSave.current && result.data.ok) setConfirm('save');
    thenSave.current = false;
  }, [result]);

  if (!m.connection.connected) return <div className="muted">Connect to the machine to see its settings.</div>;
  if (!snap) {
    return (
      <div className="camform">
        {note && <div className={note.ok ? 'ok-line' : 'warn-line'}>{note.text}</div>}
        {busy ? <div className="muted">Reading the settings…</div> : <button className="btn small" disabled={!ready} onClick={read}>Read the settings</button>}
        {!ready && <div className="muted small">The machine must be Idle, with no job running.</div>}
      </div>
    );
  }

  const fluid = snap.kind === 'fluidnc';
  const value = (k: string) => (k in edits ? edits[k] : snap.values[k]);
  const edited = Object.entries(edits).filter(([k, v]) => !sameValue(snap.values[k], v));
  const changes: SettingChange[] = edited.map(([key, value]) => ({ key, value }));
  const set = (k: string, v: SettingValue) => setEdits((e) => ({ ...e, [k]: v }));
  const unsaved = new Set(snap.unsaved ?? []);
  const send = (msg: Parameters<Machine['send']>[0]) => { setBusy(true); setNote(null); m.send(msg); };

  return (
    <div className="ctl">
      <div className="row wrap">
        <b>{fluid ? 'FluidNC' : 'GRBL'}</b>
        {fluid && snap.file && <span className="muted small">config {snap.file}</span>}
        <span className="muted small">read {new Date(snap.readAt).toLocaleTimeString()}</span>
        <div className="spacer" />
        <button className="btn small" disabled={!ready || busy} onClick={read}>↻ Read again</button>
      </div>
      {!ready && <div className="muted small">The machine must be Idle, with no job running, to change settings.</div>}
      {note && <div className={note.ok ? 'ok-line' : 'warn-line'}>{note.ok ? '✓ ' : '⚠ '}{note.text}</div>}
      <div className="muted small">Values are the machine's own, in millimetres, whatever units the screen uses.</div>

      {fluid && unsaved.size > 0 && (
        <div className="ctl-unsaved">
          <b>{unsaved.size} change{unsaved.size === 1 ? ' is' : 's are'} applied but not saved.</b> They work now and are lost when the controller restarts.
          <div className="muted small">{[...unsaved].map((k) => `${label(k)}: ${String(snap.values[k])} (file: ${snap.saved && k in snap.saved ? String(snap.saved[k]) : 'not set'})`).join(' · ')}</div>
          <div className="row wrap" style={{ marginTop: 6 }}>
            <button className="btn small primary" disabled={!ready || busy} onClick={() => setConfirm('save')}>Save to the controller…</button>
          </div>
        </div>
      )}

      {confirm === 'save' && (
        <Confirm title="Save to the controller?" busy={busy} onYes={() => send({ type: 'settingsSave' })} onNo={() => setConfirm(null)} yes="Save">
          The running settings are written to <code>{snap.file}</code> and checked by reading them back. The old file stays on the controller as a
          <code> .backup.yaml</code> and a copy is kept here. FluidNC writes the file itself, so <b>its comments and order change</b>.
          A restart is needed only for settings that take effect at start-up.
        </Confirm>
      )}
      {confirm === 'restart' && (
        <Confirm title="Restart the controller?" busy={busy} onYes={() => send({ type: 'controllerRestart' })} onNo={() => setConfirm(null)} yes="Restart">
          It reloads its saved config, so changes that were applied but not saved are lost. Only restart while the machine is stopped.
        </Confirm>
      )}

      {fluid ? <AxesTable snap={snap} value={value} set={set} edits={edits} unsaved={unsaved} /> : <GrblTable snap={snap} value={value} set={set} edits={edits} />}

      {fluid && <OtherSettings snap={snap} value={value} set={set} edits={edits} unsaved={unsaved} filter={filter} setFilter={setFilter} />}

      <div className="ctl-bar">
        <span className="muted small">{changes.length ? `${changes.length} edit${changes.length === 1 ? '' : 's'} not sent yet` : 'No edits'}</span>
        <div className="spacer" />
        <button className="btn small" disabled={!changes.length || busy} onClick={() => setEdits({})}>Discard edits</button>
        <button className="btn small primary" disabled={!changes.length || !ready || busy} onClick={() => setConfirm('apply')}>Apply…</button>
      </div>
      {confirm === 'apply' && (
        <Confirm title={`Send ${changes.length} change${changes.length === 1 ? '' : 's'} to the controller?`} busy={busy}
          onYes={() => { thenSave.current = false; send({ type: 'settingsApply', changes }); }} onNo={() => setConfirm(null)} yes="Apply now"
          also={fluid ? { label: 'Apply, then save…', run: () => { thenSave.current = true; send({ type: 'settingsApply', changes }); } } : undefined}>
          <table className="ext"><tbody>
            {changes.map((c) => <tr key={c.key}><th>{label(c.key)}</th><td>{String(snap.values[c.key])}</td><td>→</td><td><b>{String(c.value)}</b></td></tr>)}
          </tbody></table>
          {fluid
            ? <div className="muted small">They take effect at once. They are <b>not saved</b> until you save, so you can try them first: a restart puts the old ones back.</div>
            : <div className="muted small">GRBL stores these itself, so they are permanent.</div>}
        </Confirm>
      )}

      <Diagnostics snap={snap} />

      {fluid && (
        <div className="row wrap">
          <button className="btn small" disabled={!ready || busy} onClick={() => setConfirm('restart')}>Restart controller…</button>
          {(snap.backups?.length ?? 0) > 0 && (
            <details className="muted small">
              <summary>Kept config files ({snap.backups!.length})</summary>
              {snap.backups!.map((b) => <div key={b}><a href={`/api/fluidnc-backup/${b}`} download>{b}</a></div>)}
              <div>Every save keeps the previous file here. To go back, upload one with the FluidNC web page (Files).</div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

function label(key: string): string {
  const a = /^axes\/([^/]+)\/(.+)$/.exec(key);
  if (a && AXIS_FIELDS[a[2]]) return `${a[1].toUpperCase()} ${AXIS_FIELDS[a[2]].label.toLowerCase()}`;
  const g = /^\$(\d+)$/.exec(key);
  if (g && GRBL_SETTINGS[Number(g[1])]) return `${key} ${GRBL_SETTINGS[Number(g[1])].label}`;
  return key;
}

function Confirm({ title, children, yes, onYes, onNo, busy, also }: { title: string; children: React.ReactNode; yes: string; onYes: () => void; onNo: () => void; busy: boolean; also?: { label: string; run: () => void } }) {
  return (
    <div className="ctl-confirm" role="alertdialog" aria-label={title}>
      <b>{title}</b>
      <div className="small">{children}</div>
      <div className="row wrap">
        <button className="btn small primary" disabled={busy} onClick={onYes}>{busy ? '…' : yes}</button>
        {also && <button className="btn small" disabled={busy} onClick={also.run}>{also.label}</button>}
        <button className="btn small" disabled={busy} onClick={onNo}>Cancel</button>
      </div>
    </div>
  );
}

interface TableProps { snap: MachineSettings; value: (k: string) => SettingValue | undefined; set: (k: string, v: SettingValue) => void; edits: Record<string, SettingValue> }

/** One column per axis (X, Y, Z…), one row per setting you adjust per axis */
function AxesTable({ snap, value, set, edits, unsaved }: TableProps & { unsaved: Set<string> }) {
  // an axis is any name under axes/ that has settings of its own (axes/x/…), whatever its case
  const axes = useMemo(() => [...new Set(Object.keys(snap.values).map((k) => /^axes\/([^/]+)\/[^/]+/.exec(k)?.[1]).filter(Boolean) as string[])].sort(), [snap]);
  return (
    <div className="ctl-axes">
      {axes.length === 0 && <div className="warn-line">No axes were found in this controller's settings. Open Diagnostics at the bottom and send what it shows.</div>}
      <table className="ext">
        <thead><tr><th>Per axis</th>{axes.map((a) => <th key={a}>{a.toUpperCase()}</th>)}</tr></thead>
        <tbody>
          {Object.entries(AXIS_FIELDS).map(([f, spec]) => (
            <tr key={f}>
              <th title={spec.hint}>{spec.label}{spec.unit && <span className="muted small"> {spec.unit}</span>}</th>
              {axes.map((a) => {
                const key = `axes/${a}/${f}`;
                if (!(key in snap.values)) return <td key={a} className="muted">–</td>;
                return <td key={a}><Cell k={key} snap={snap} value={value(key)} set={set} changed={key in edits && !sameValue(snap.values[key], edits[key])} unsaved={unsaved.has(key)} kind={spec.kind} /></td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="muted small">Hover a name for what it does. Too-high acceleration on a leadscrew axis loses steps: lower it here, try it, then save.</div>
    </div>
  );
}

function Cell({ k, snap, value, set, changed, unsaved, kind }: { k: string; snap: MachineSettings; value: SettingValue | undefined; set: (k: string, v: SettingValue) => void; changed: boolean; unsaved: boolean; kind: 'number' | 'int' | 'bool' | 'text' }) {
  const cls = `${changed ? 'edited' : ''} ${unsaved ? 'unsaved' : ''}`;
  const savedNote = unsaved && snap.saved && k in snap.saved ? `Applied, not saved. The saved file says ${snap.saved[k]}` : unsaved ? 'Applied, not saved' : undefined;
  if (kind === 'bool') return <input type="checkbox" className={cls} title={savedNote} checked={value === true} onChange={(e) => set(k, e.target.checked)} />;
  return <NumberBox cls={cls} title={savedNote} value={value as number | string} onChange={(v) => set(k, v)} />;
}

/** Keeps what is typed as text (so "1." survives) and reports numbers */
function NumberBox({ value, onChange, cls, title }: { value: number | string; onChange: (v: SettingValue) => void; cls: string; title?: string }) {
  const [text, setText] = useState(String(value));
  useEffect(() => { if (!sameValue(Number(text), Number(value)) || text.trim() === '') setText(String(value)); }, [value]);   // eslint-disable-line react-hooks/exhaustive-deps
  return <input type="number" step="any" className={cls} title={title} value={text} onChange={(e) => { setText(e.target.value); if (e.target.value.trim() !== '') onChange(Number(e.target.value)); }} />;
}

/** Everything else in the config, by section. Wiring (pins, drivers) is shown but locked. */
function OtherSettings({ snap, value, set, edits, unsaved, filter, setFilter }: TableProps & { unsaved: Set<string>; filter: string; setFilter: (f: string) => void }) {
  const shownInMatrix = (k: string) => { const m = /^axes\/[^/]+\/(.+)$/.exec(k); return !!m && m[1] in AXIS_FIELDS; };
  const keys = Object.keys(snap.values).filter((k) => !shownInMatrix(k) && (!filter || k.toLowerCase().includes(filter.toLowerCase()))).sort();
  const groups = new Map<string, string[]>();
  for (const k of keys) { const g = k.split('/')[0]; groups.set(g, [...(groups.get(g) ?? []), k]); }
  return (
    <details className="ctl-other" open={!!filter}>
      <summary>All other settings ({keys.length})</summary>
      <input placeholder="Search, e.g. coolant or homing" value={filter} onChange={(e) => setFilter(e.target.value)} />
      <div className="muted small">🔒 is wired to the hardware (pins, drivers): change it in the config file.</div>
      {[...groups].map(([g, ks]) => (
        <div key={g}>
          <div className="menu-h">{g}</div>
          {ks.map((k) => {
            const v = value(k), locked = isReadOnlyKey(k), changed = k in edits && !sameValue(snap.values[k], edits[k]);
            return (
              <label key={k} className="ctl-row">
                <span className="small" title={k}>{k.slice(g.length + 1) || k}{locked && ' 🔒'}</span>
                {locked ? <code>{String(v)}</code>
                  : typeof snap.values[k] === 'boolean' ? <input type="checkbox" className={unsaved.has(k) ? 'unsaved' : ''} checked={v === true} onChange={(e) => set(k, e.target.checked)} />
                  : typeof snap.values[k] === 'number' ? <NumberBox cls={`${changed ? 'edited' : ''} ${unsaved.has(k) ? 'unsaved' : ''}`} value={v as number} onChange={(x) => set(k, x)} />
                  : <input className={`${changed ? 'edited' : ''} ${unsaved.has(k) ? 'unsaved' : ''}`} value={String(v)} onChange={(e) => set(k, e.target.value)} />}
              </label>
            );
          })}
        </div>
      ))}
    </details>
  );
}

function GrblTable({ snap, value, set, edits }: TableProps) {
  const keys = Object.keys(snap.values).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  return (
    <div className="ctl-grbl">
      {keys.map((k) => {
        const spec = GRBL_SETTINGS[Number(k.slice(1))];
        const changed = k in edits && !sameValue(snap.values[k], edits[k]);
        return (
          <label key={k} className="ctl-row" title={spec?.hint}>
            <span className="small"><b>{k}</b> {spec?.label ?? 'Setting'}{spec?.unit && <span className="muted"> ({spec.unit})</span>}</span>
            <NumberBox cls={changed ? 'edited' : ''} value={value(k) as number} onChange={(v) => set(k, v)} />
          </label>
        );
      })}
    </div>
  );
}

/** What was read, as plain text to copy: for when a table does not look like the machine */
function Diagnostics({ snap }: { snap: MachineSettings }) {
  const text = useMemo(() => {
    const keys = Object.keys(snap.values);
    const lines = [`kind=${snap.kind} file=${snap.file ?? '-'} values=${keys.length} saved=${snap.saved ? Object.keys(snap.saved).length : '-'} unsaved=${(snap.unsaved ?? []).join(',') || '-'}`];
    for (const k of snap.unsaved ?? []) lines.push(`DIFF ${k}: running=${JSON.stringify(snap.values[k])} file=${JSON.stringify(snap.saved?.[k])}`);
    lines.push(...keys.filter((k) => k.startsWith('axes/')).slice(0, 80).map((k) => `${k}=${JSON.stringify(snap.values[k])}`));
    return lines.join('\n');
  }, [snap]);
  return (
    <details className="muted small">
      <summary>Diagnostics</summary>
      <textarea readOnly rows={8} value={text} onFocus={(e) => e.currentTarget.select()} style={{ width: '100%', fontFamily: 'monospace' }} />
    </details>
  );
}
