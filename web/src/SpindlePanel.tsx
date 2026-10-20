import { useEffect, useRef, useState } from 'react';
import { SPINDLE_COMMANDS, type SpindleCommand } from '../../shared/protocol';
import { Panel } from './Dock';
import type { Machine } from './useMachine';
import { useSettings } from './settingsContext';

const NAMES: Record<SpindleCommand, { label: string; what: string }> = {
  M3: { label: 'Spindle on', what: 'M3: spindle clockwise' },
  M4: { label: 'Spindle CCW', what: 'M4: spindle counter-clockwise' },
  M5: { label: 'Off', what: 'M5: spindle off' },
  M7: { label: 'Mist / vacuum on', what: 'M7: mist coolant (often used for a vacuum)' },
  M8: { label: 'Flood on', what: 'M8: flood coolant' },
  M9: { label: 'Coolant off', what: 'M9: coolant / vacuum off' },
};
const rpmText = (n: number) => n.toLocaleString('en-US');

export function SpindlePanel({ m }: { m: Machine }) {
  return (
    <Panel id="spindle" title="Spindle">
      <Spindle m={m} />
    </Panel>
  );
}

function Spindle({ m }: { m: Machine }) {
  const cfg = m.config.spindle;
  const acc = m.status.accessories;
  const settings = useSettings();
  const [rpm, setRpm] = useState(() => { const n = Number(localStorage.getItem('spindleRpm')); return n > 0 ? n : 10000; });
  // the chosen speed must be one of the listed ones (the list can change in the setup)
  const i = nearest(cfg.speeds, rpm);
  const chosen = cfg.speeds[i];
  useEffect(() => { try { localStorage.setItem('spindleRpm', String(chosen)); } catch { /* not saved in private mode */ } }, [chosen]);

  const on = acc.includes('S') || acc.includes('C');
  const dir: SpindleCommand = acc.includes('C') ? 'M4' : 'M3';
  const connected = m.connection.connected;
  const blocked = m.job.state === 'running' || m.job.state === 'paused' || m.probe.phase !== 'idle';
  const can = connected && !blocked;
  const send = (command: SpindleCommand) => m.send({ type: 'spindle', command, ...(command === 'M3' || command === 'M4' ? { rpm: chosen } : {}) });

  const status = !connected ? 'Not connected'
    : [on ? (acc.includes('C') ? 'Spindle on, counter-clockwise' : 'Spindle on, clockwise') : 'Spindle off',
      acc.includes('M') ? 'mist / vacuum on' : '', acc.includes('F') ? 'flood on' : ''].filter(Boolean).join(' · ');

  return (
    <div className="spindle">
      <div className="spindle-read">
        <div className={`spindle-rpm ${on ? 'on' : ''}`}>{rpmText(Math.round(m.status.spindle))}<span className="muted small"> RPM</span></div>
        <div className={`small ${on ? 'ok-line' : 'muted'}`}>{status}</div>
      </div>

      <div className="row steprow">
        <span className="muted lbl">Set RPM</span>
        <button className="btn" disabled={i === 0} onClick={() => setRpm(cfg.speeds[i - 1])} aria-label="Slower">−</button>
        <select value={i} onChange={(e) => setRpm(cfg.speeds[Number(e.target.value)])} aria-label="Set RPM">
          {cfg.speeds.map((s, n) => <option key={s} value={n}>{rpmText(s)} RPM</option>)}
        </select>
        <button className="btn" disabled={i === cfg.speeds.length - 1} onClick={() => setRpm(cfg.speeds[i + 1])} aria-label="Faster">+</button>
      </div>

      <div className="row wrap">
        {SPINDLE_COMMANDS.filter((c) => cfg.commands.includes(c)).map((c) => (
          <button key={c} className={`btn ${c === 'M5' ? 'danger' : c === 'M3' || c === 'M4' ? 'primary' : ''}`} disabled={!can} title={NAMES[c].what} onClick={() => send(c)}>
            {NAMES[c].label} ({c})
          </button>
        ))}
        {on && Math.round(m.status.spindle) !== chosen && (
          <button className="btn" disabled={!can} title="The spindle is running at a different speed: change it now" onClick={() => send(dir)}>↑ Apply {rpmText(chosen)}</button>
        )}
      </div>
      {!can && connected && <div className="muted small">Not while a job or probe is running. Hold or Reset stops everything.</div>}

      <div className="row"><button className="btn small" title="Choose the buttons and speeds" onClick={() => settings.open('spindle')}>⚙ Setup</button></div>
    </div>
  );
}

function nearest(list: number[], v: number): number {
  let best = 0;
  list.forEach((s, i) => { if (Math.abs(s - v) < Math.abs(list[best] - v)) best = i; });
  return best;
}

/** The spindle form. Lives in Settings. */
export function SpindleSetup({ m, onClose, onSaved }: { m: Machine; onClose: () => void; onSaved: () => void }) {
  const cfg = m.config.spindle;
  const [cmds, setCmds] = useState<SpindleCommand[]>(cfg.commands);
  const [speeds, setSpeeds] = useState(cfg.speeds.join(', '));
  const [max, setMax] = useState(String(cfg.maxRpm));
  const [err, setErr] = useState('');
  const seen = useRef(m.replies.configResult?.n ?? 0);
  const r = m.replies.configResult;
  useEffect(() => {
    if (!r || r.n === seen.current) return;
    seen.current = r.n;
    if (r.data.ok) onSaved(); else setErr(r.data.message ?? 'Not saved');
  }, [r]);
  const toggle = (c: SpindleCommand) => setCmds((x) => (x.includes(c) ? x.filter((y) => y !== c) : [...x, c]));
  const save = () => {
    const list = speeds.split(/[\s,;]+/).filter(Boolean).map(Number);
    if (list.some((n) => !Number.isFinite(n))) return setErr('Speeds are numbers separated by commas');
    setErr('');
    m.send({ type: 'configSet', update: { spindle: { commands: cmds, speeds: list, maxRpm: Number(max) } } });
  };
  return (
    <div className="camform">
      <div className="muted small">Which buttons the Spindle panel shows. Off (M5) is always there. This is for the whole machine: every browser sees the same buttons.</div>
      {SPINDLE_COMMANDS.filter((c) => c !== 'M5').map((c) => (
        <label key={c} className="chk"><input type="checkbox" checked={cmds.includes(c)} onChange={() => toggle(c)} />{c}: {NAMES[c].what.slice(4)}</label>
      ))}
      <label><span>Speeds (RPM)</span><input value={speeds} onChange={(e) => setSpeeds(e.target.value)} /><span /></label>
      <label><span>Highest RPM</span><input type="number" value={max} onChange={(e) => setMax(e.target.value)} /><span className="muted small">never sent above this</span></label>
      {err && <div className="err">{err}</div>}
      <div className="row wrap">
        <button className="btn small primary" onClick={save}>Save</button>
        <button className="btn small" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}
