import { useEffect, useRef, useState } from 'react';
import { Panel } from './Dock';
import { loadAlForm, loadProbeForm, toSettings } from './probeForms';
import { useSettings } from './settingsContext';
import { NumInput, useUnits } from './units';
import type { Machine } from './useMachine';

// PCB mode: the machine set up for circuit boards on the fixture. The fixture position and the safe height are machine
// coordinates (they never change once the machine is homed). While it is on, normal Home is off and PCB Home takes its place.

export function PcbPanel({ m }: { m: Machine }) {
  return (
    <Panel id="pcb" title="PCB mode" className="pcb">
      <Pcb m={m} />
    </Panel>
  );
}

function Pcb({ m }: { m: Machine }) {
  const u = useUnits();
  const settings = useSettings();
  const pcb = m.config.pcb;
  const [err, setErr] = useState('');
  const seen = useRef(m.replies.configResult?.n ?? 0);
  const r = m.replies.configResult;
  useEffect(() => {
    if (!r || r.n === seen.current) return;
    seen.current = r.n;
    if (!r.data.ok) setErr(r.data.message ?? 'Not changed');
  }, [r]);
  const setMode = (enabled: boolean) => { setErr(''); m.send({ type: 'configSet', update: { pcb: { enabled } } }); };

  const busy = m.job.state === 'running' || m.job.state === 'paused' || m.probe.phase !== 'idle';
  const idle = m.connection.connected && m.status.state === 'Idle' && !busy;
  const hm = m.heightmap, j = m.job;

  if (!pcb.enabled) {
    return (
      <div className="pcbp">
        <div className="muted small">
          For circuit boards on the fixture: PCB Home goes to the same spot every time, then probe, autolevel and cut. While it is on, the normal Home is turned off.
        </div>
        {!pcb.configured
          ? <button className="btn" onClick={() => settings.open('pcb')}>Set up the fixture…</button>
          : <div className="row wrap">
              <button className="btn primary" onClick={() => setMode(true)}>Turn PCB mode on</button>
              <span className="muted small">Fixture X {u.len(pcb.x, 2)}, Y {u.len(pcb.y, 2)}, safe Z {u.len(pcb.safeZ, 2)} {u.lenUnit} (machine)</span>
            </div>}
        {err && <div className="warn-line">{err}</div>}
        {m.connection.connected && m.connection.homeReminder && <div className="muted small">Home the machine first: the fixture position is in machine coordinates.</div>}
      </div>
    );
  }

  const step = (done: boolean, text: React.ReactNode, action?: React.ReactNode) => (
    <div className="pcb-step"><span className={done ? 'ok-line' : 'muted'}>{done ? '✓' : '○'}</span><span className="pcb-text">{text}</span>{action}</div>
  );
  const scan = () => m.send({ type: 'probeStart', kind: 'autolevel', settings: toSettings(loadProbeForm(), 'pcb'), autolevel: { ...loadAlForm() } });

  return (
    <div className="pcbp">
      <div className="pcb-on">PCB MODE IS ON <span className="small">normal Home is off</span></div>
      <button className="btn pcb-home" disabled={!idle || !!m.connection.homeReminder}
        title={m.connection.homeReminder ? 'Home the machine first (turn PCB mode off, press Home, then turn it back on)' : 'Raise to the safe height, go to the fixture, and make that work X0 Y0'}
        onClick={() => m.send({ type: 'pcbHome' })}>
        ⌂ PCB Home <span className="small">(machine X {u.len(pcb.x, 2)}, Y {u.len(pcb.y, 2)})</span>
      </button>
      {m.connection.homeReminder && m.connection.connected && <div className="warn-line small">The machine has not been homed since connecting: turn PCB mode off, press Home, then turn it on again.</div>}
      <div className="pcb-steps">
        {step(!!m.connection.pcbHomed, 'Work X0 Y0 at the fixture (PCB Home)')}
        {step(!!m.connection.pcbZSet, 'Set Z0 on the board', <button className="btn small" disabled={!idle} onClick={() => m.send({ type: 'probeStart', kind: 'pcb', settings: toSettings(loadProbeForm(), 'pcb') })}>◎ PCB Z probe</button>)}
        {step(!!hm, hm ? `Height map ${hm.cols} × ${hm.rows} points` : 'Scan the board surface (autolevel)', <button className="btn small" disabled={!idle} onClick={scan}>Scan</button>)}
        {step(j.state !== 'none', j.state !== 'none' ? `G-code: ${j.name}` : 'Open the G-code (Job panel)')}
        {step(!!j.leveled || !!j.alreadyLeveled, j.leveled || j.alreadyLeveled ? 'G-code autolevelled' : 'Apply the height map to the G-code',
          <button className="btn small" disabled={!hm || j.state === 'none' || busy || !!j.alreadyLeveled} onClick={() => m.send({ type: 'jobLevel' })}>Apply</button>)}
      </div>
      <div className="muted small">The probe settings and the scan area are the ones in the Probe and Autolevel panels.</div>
      {err && <div className="warn-line">{err}</div>}
      <div className="row wrap">
        <button className="btn small" onClick={() => settings.open('pcb')}>⚙ Fixture</button>
        <button className="btn small" disabled={m.job.state === 'running'} onClick={() => setMode(false)}>Turn PCB mode off</button>
      </div>
    </div>
  );
}

/** Settings > PCB mode: where the fixture is and how high is safe. Entered by hand or captured from where the tool is now. */
export function PcbSettings({ m, onSaved }: { m: Machine; onSaved: () => void }) {
  const u = useUnits();
  const pcb = m.config.pcb;
  const [x, setX] = useState(pcb.x), [y, setY] = useState(pcb.y), [z, setZ] = useState(pcb.safeZ);
  const [err, setErr] = useState('');
  const seen = useRef(m.replies.configResult?.n ?? 0);
  const r = m.replies.configResult;
  useEffect(() => {
    if (!r || r.n === seen.current) return;
    seen.current = r.n;
    if (r.data.ok) onSaved(); else setErr(r.data.message ?? 'Not saved');
  }, [r]);
  const mp = m.status.mpos, here = m.connection.connected;
  const round = (n: number) => Math.round(n * 1000) / 1000;
  return (
    <div className="camform">
      <div className="muted small">
        For circuit boards on a fixture bolted to the wasteboard. These are <b>machine</b> positions: they never change once the machine is homed, so a board goes back to exactly the same place.
        Move the tool to the fixture's zero corner, then Capture.
      </div>
      <label><span>Fixture X</span><NumInput mm={x} onMm={setX} kind="len" /><span className="muted small">{u.lenUnit} (machine)</span></label>
      <label><span>Fixture Y</span><NumInput mm={y} onMm={setY} kind="len" /><span className="muted small">{u.lenUnit} (machine)</span></label>
      <div className="row wrap">
        <button type="button" className="btn small" disabled={!here} title="Use where the tool is now (the small machine position in the Position panel)" onClick={() => { setX(round(mp.x)); setY(round(mp.y)); }}>📍 Capture X and Y from the tool</button>
      </div>
      <label><span>Safe Z</span><NumInput mm={z} onMm={setZ} kind="len" /><span className="muted small">{u.lenUnit} (machine)</span></label>
      <div className="row wrap">
        <button type="button" className="btn small" disabled={!here} title="Use the tool's current height" onClick={() => setZ(round(mp.z))}>📍 Capture Z from the tool</button>
      </div>
      <div className="muted small">
        Safe Z is the height the tool is lifted to before it moves across to the fixture: it must clear your tallest clamp.
        Machine Z is usually 0 or negative, with 0 at the top. The tool is only ever raised to it, never lowered.
      </div>
      {z > 0 && <div className="warn-line">A machine Z above 0 is usually out of reach. Check it.</div>}
      {err && <div className="err">{err}</div>}
      <div className="row wrap">
        <button className="btn small primary" onClick={() => { setErr(''); m.send({ type: 'configSet', update: { pcb: { x, y, safeZ: z } } }); }}>Save</button>
        <span className="muted small">{pcb.configured ? 'Saved on the machine: every browser uses it.' : 'Not set up yet.'}</span>
      </div>
      <div className="muted small">Turn PCB mode on from the PCB mode panel or the header button.</div>
    </div>
  );
}
