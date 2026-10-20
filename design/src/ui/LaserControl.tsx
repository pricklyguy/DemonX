import { useHideNotes } from './prefs';
import { useJogSettings } from './jogSettings';
import { useRotary } from './rotaryStore';
import { usePositions } from './positionsStore';
import { AnchorGrid } from './AnchorGrid';
import type { Anchor } from '../core/geom';
import { useEffect, useMemo, useState } from 'react';
import type { LaserJob, Move } from '../core/laser';
import { formatTime } from '../core/laser';
import { fingerprint } from '../core/hash';
import type { Doc } from '../core/types';
import type { Laser } from './useLaser';
import { NumField } from './NumField';
import { reach, reachText, type Box } from '../../server/src/ruida/plan';


/** The same job as a Ruida plan (text for the server), built by the app when a Ruida controller is connected */
export interface RuidaJobInfo { /** the plan as moves, for the preview and the time */ moves: Move[]; text: string; empty: boolean; warnings: string[]; info?: string[]; box: Box | null; /** the job's box plus the tool layers' (T1/T2), for the reach warning */ reachBox?: Box | null; /** one line per layer, for the Start confirmation */ summary: string[] }

interface Props {
  laser: Laser;
  doc: Doc;
  job: LaserJob;
  ruida: RuidaJobInfo;
  /** a newer job is still being worked out: nothing may be sent from the one shown */
  stale?: boolean;
  jobError?: string | null;
  startFrom: 'user' | 'absolute';
  /** Ruida: where the job is placed from: the head (Current position), the design's own place on the machine (Absolute coordinates), or a saved starred position (User origin) */
  startMode: 'current' | 'absolute' | 'origin';
  setStartMode: (m: 'current' | 'absolute' | 'origin') => void;
  /** The job's start point on the machine for Absolute coordinates (mm from the rear-left corner), when there is a job */
  absoluteStart: { x: number; y: number } | null;
  anchor: Anchor;
  setAnchor: (a: Anchor) => void;
  run: (id: string, args: unknown, echo?: boolean) => boolean;
  /** Start was pressed: where the head was at that moment (Ruida), so the monitor can follow the job */
  onStarted?: (head: { x: number; y: number }) => void;
  /** Open the live monitor of the job that is running */
  onMonitor?: () => void;
  /** Open Settings > Access (sign in with the PIN) */
  onAccess?: () => void;
}

const portLabel = (path: string, description?: string) =>
  path === 'simulator' ? 'Simulator (no machine)'
  : path === 'ruida-sim' ? 'Simulated Ruida (no machine)'
  : path.startsWith('ruida:') ? `Ruida · ${path.slice(6)}${/ at ([\d.]+)/.exec(description ?? '')?.[1] ? ' · ' + /(?: at )([\d.]+)/.exec(description ?? '')![1] : ''} (not tried on hardware)`
  : `${path}${description ? ` · ${description}` : ''}`;

/** Connect to the laser, move it, send the job, frame it and run it. The server enforces the safety rules; this shows them. */
export function LaserControl({ laser, doc, job, ruida, stale = false, jobError = null, startFrom, startMode, setStartMode, absoluteStart, anchor, setAnchor, run, onStarted, onMonitor, onAccess }: Props) {
  const { online, state, ports, send, notice } = laser;
  const [port, setPort] = useState('simulator');
  const { speed } = useJogSettings();
  const rotaryKey = state?.connection.connected ? state.connection.target : '';
  const rotary = useRotary(rotaryKey);
  const positions = usePositions();
  const [confirm, setConfirm] = useState(false);
  const [unverifiedOk, setUnverifiedOk] = useState(false);
  // adding a network laser (Ruida): name and address, kept on the server's computer
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('Pronto');
  const [newHost, setNewHost] = useState('');
  const [select, setSelect] = useState<string | null>(null);

  const [hideNotes] = useHideNotes();
  const [homeArmed, setHomeArmed] = useState(false);
  useEffect(() => { if (!homeArmed) return; const id = setTimeout(() => setHomeArmed(false), 4000); return () => clearTimeout(id); }, [homeArmed]);
  const connected = !!state?.connection.connected;
  const jobState = state?.job.state ?? 'none';
  const running = jobState === 'running' || jobState === 'paused';
  const machineState = state?.status.state ?? 'Disconnected';
  const idle = machineState === 'Idle';
  const isRuida = state?.kind === 'ruida';
  const rotaryBlocks = isRuida && rotary.setup.enabled;
  const caps = state?.capabilities;
  // can the job fit from where the head is? The server checks again; this says so before a button is pressed
  const userOrigin = positions.data.sets[rotaryKey]?.find((p) => p.origin) ?? null;
  const needOrigin = isRuida && startMode !== 'current';
  const origin = needOrigin ? (startMode === 'absolute' ? absoluteStart : userOrigin ? { x: userOrigin.x, y: userOrigin.y } : null) : null;
  const originMissing = needOrigin && !origin;
  const base = origin ?? (state?.status.wpos ? { x: state.status.wpos.x, y: state.status.wpos.y } : null);
  const over = isRuida && (ruida.reachBox ?? ruida.box) && state?.workArea && base
    ? reachText(reach((ruida.reachBox ?? ruida.box)!, base, state.workArea.width, state.workArea.height))
    : '';
  const jobEmpty = isRuida ? ruida.empty : job.empty;
  const hash = useMemo(() => (isRuida ? (ruida.empty ? '' : fingerprint(ruida.text)) : job.empty ? '' : fingerprint(job.gcode)), [isRuida, ruida, job]);
  const onMachine = state?.loaded ?? null;
  // GRBL: the job must be sent first. Ruida: Frame and Start check and send the current job themselves.
  const matches = !stale && !rotaryBlocks && (isRuida ? !jobEmpty : !!onMachine && onMachine.hash === hash);
  const mode = state?.laser.mode ?? 'unknown';
  const sMax = state?.laser.sMax ?? null;

  useEffect(() => { if (ports.length && !ports.some((p) => p.path === port)) setPort(ports[0].path); }, [ports, port]);
  // after a controller is added, pick it as soon as the list shows it
  useEffect(() => { if (select && ports.some((p) => p.path === select)) { setPort(select); setSelect(null); } }, [ports, select]);
  const ruidaOffered = ports.some((p) => p.path.startsWith('ruida'));
  const savedPorts = ports.filter((p) => p.path.startsWith('ruida:'));

  if (!online) {
    return (
      <section className="panel">
        <h2><span>Laser control</span></h2>
        <div className="body">
          <div className="notice">
            <span className="small">Laser control needs the DemonX Design server, which talks to the laser for the app. In the <code>design</code> folder run <code>npm run build</code> then <code>npm run serve</code>, and open <code>http://localhost:8090</code>. (While developing: <code>npm run dev:server</code>.)</span>
          </div>
          <p className="muted small">Designing, previewing and Save G-code work without it.</p>
        </div>
      </section>
    );
  }

  const pos = state?.status.wpos;
  const fmt = (v: number | undefined) => (v === undefined ? '–' : v.toFixed(2));
  const progress = state && state.job.totalLines ? Math.min(1, state.job.doneLines / state.job.totalLines) : 0;

  return (
    <section className="panel">
      <h2><span>Laser control</span></h2>
      <div className="body">
        {laser.role && !laser.role.operator && (
          <div className="warn small" role="status">
            You can only watch from this browser. {laser.role.mode === 'pin' ? 'Sign in with the PIN to control the laser.' : 'No PIN is set yet: set one on the computer that runs DemonX Design.'}{' '}
            {onAccess && <button className="btn small" onClick={onAccess}>Access…</button>}
          </div>
        )}
        {!connected ? (
          <>
            <div className="row">
              <select value={port} aria-label="Port" onChange={(e) => setPort(e.target.value)}>
                {ports.map((p) => <option key={p.path} value={p.path}>{portLabel(p.path, p.description)}</option>)}
              </select>
              <button className="btn small" onClick={() => send({ type: 'listPorts' })} title="Look for ports again">↻</button>
            </div>
            {ruidaOffered && !adding && (
              <div className="row wrap">
                <button className="btn small" onClick={() => setAdding(true)}>＋ Add a Ruida laser…</button>
                {port.startsWith('ruida:') && <button className="btn small" onClick={() => send({ type: 'ruidaRemove', name: port.slice(6) })} title="Forget this laser's address (on this computer)">Forget {port.slice(6)}</button>}
                {savedPorts.length === 0 && <span className="muted small">No Ruida laser added yet.</span>}
              </div>
            )}
            {ruidaOffered && adding && (
              <div className="notice" role="group" aria-label="Add a Ruida laser">
                <div className="row wrap">
                  <label className="inline small">Name <input aria-label="Laser name" value={newName} maxLength={30} onChange={(e) => setNewName(e.target.value)} style={{ width: 110 }} /></label>
                  <label className="inline small">Address <input aria-label="Laser address" value={newHost} placeholder="192.168.1.50" inputMode="decimal" onChange={(e) => setNewHost(e.target.value)} style={{ width: 130 }} /></label>
                </div>
                <span className="small muted">Use the address LightBurn shows for this laser (Devices). It must be on your own network. It is kept on this computer only.</span>
                <div className="row wrap">
                  <button className="btn small primary" disabled={!newName.trim() || !newHost.trim()} onClick={() => { send({ type: 'ruidaAdd', name: newName.trim(), host: newHost.trim() }); setSelect('ruida:' + newName.trim()); setAdding(false); }}>Save</button>
                  <button className="btn small" onClick={() => setAdding(false)}>Cancel</button>
                </div>
              </div>
            )}
            <button className="btn primary" onClick={() => send({ type: 'connect', target: port })}>Connect</button>
            <p className="muted small">Close other programs that use the same port (DemonX CNC, LightBurn, a sender). A port can only be used by one program at a time.</p>
          </>
        ) : (
          <>
            <div className="row wrap">
              <span className={'pill state-' + machineState}>{machineState}</span>
              <span className="muted small">{state!.connection.target}{state!.connection.firmware ? ` · ${state!.connection.firmware.replace(/^Grbl /, 'Grbl ').slice(0, 40)}` : ''}</span>
              <span className="spacer" />
              <button className="btn small" disabled={running} onClick={() => send({ type: 'disconnect' })}>Disconnect</button>
            </div>
            <div className="mono small pos" aria-label="Position">X {fmt(pos?.x)} · Y {fmt(pos?.y)} mm <span className="muted" title="Counted from the rear-left corner of the machine, like LightBurn">({isRuida ? 'rear-left' : 'work'})</span></div>

            {isRuida && !hideNotes && (
              <div className="notice" role="status">
                <span className="small"><b>Ruida support has not been tried on a real machine.</b> Watch it, hand on the emergency stop. The job starts where the head is{startFrom === 'absolute' ? '; "Absolute coordinates" is ignored for Ruida' : ''}.</span>
              </div>
            )}
            {isRuida && over && !running && (
              <div className="notice danger" role="status">
                <span className="small"><b>The job does not fit from here.</b> From the head's position it would run {over}. Move the head (the arrows), or change the job's start point with the nine-dot picker in the Laser job panel (top-left puts the job in front of and to the right of the head).</span>
              </div>
            )}
            {isRuida && !hideNotes && ruida.warnings.length > 0 && <div className="small warn" role="status">{ruida.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}</div>}

            {!isRuida && mode === 'on' && <div className="small ok" role="status">✓ Laser mode is on ($32=1){sMax !== null ? ` · full power = S${sMax}` : ''}</div>}
            {!isRuida && mode === 'off' && (
              <div className="notice danger" role="alert">
                <span className="small"><b>Laser mode is off ($32=0).</b> In that mode the laser stays lit while the head is still. DemonX Design will not start a job until it is on.</span>
                <button className="btn small" disabled={!idle || running} onClick={() => send({ type: 'enableLaserMode' })}>Turn on laser mode ($32=1)</button>
              </div>
            )}
            {!isRuida && mode === 'unknown' && (
              <div className="notice" role="status">
                <span className="small">{state?.laser.note ?? 'Checking laser mode…'}</span>
                <button className="btn small" disabled={running} onClick={() => send({ type: 'checkLaser' })}>Check again</button>
              </div>
            )}
            {sMax !== null && sMax !== doc.machine.sMax && (
              <div className="notice" role="status">
                <span className="small">The controller's full power is S{sMax} ($30) but the machine setting here is S{doc.machine.sMax}. The job would use the wrong power.</span>
                <button className="btn small" onClick={() => run('machine_set', { sMax }, true)}>Use S{sMax}</button>
              </div>
            )}

            {isRuida && machineState === 'Alarm' && (
              <div className="notice danger" role="alert">
                <span className="small"><b>The controller is not answering.</b> If a job was running, Stop was sent. Check the machine itself (and the network cable) before doing anything else.</span>
              </div>
            )}
            {!isRuida && machineState === 'Alarm' && (
              <div className="notice danger" role="alert">
                <span className="small"><b>Alarm.</b> The machine stopped. Find out why (limit switch, reset during a move) before unlocking.</span>
                <button className="btn small" onClick={() => send({ type: 'unlock' })}>Unlock ($X)</button>
              </div>
            )}

            {!isRuida && (
              <div className="row wrap">
                <button className="btn small" disabled={running || !idle} onClick={() => send({ type: 'setOrigin' })} title="Make the head's position X0 Y0 (work zero)">Set work zero here</button>
                <button className="btn small" disabled={running} onClick={() => send({ type: 'home' })}>Home</button>
                <button className="btn small" onClick={() => send({ type: 'unlock' })}>Unlock</button>
                <button className="btn small danger" onClick={() => send({ type: 'reset' })} title="Soft reset: stops everything and switches the laser off">Reset</button>
              </div>
            )}

            <div className="jobbox">
              <div className="bigbtns" role="group" aria-label="Run the job">
                {caps?.pause !== false && (jobState === 'paused'
                  ? <button className="btn big" aria-label="Resume" onClick={() => send({ type: 'resume' })}><i>▶</i>Resume</button>
                  : <button className="btn big" aria-label="Pause" disabled={jobState !== 'running'} onClick={() => send({ type: 'pause' })}><i>⏸</i>Pause</button>)}
                <button className="btn big danger" aria-label="Stop" disabled={!connected} onClick={() => send({ type: 'stop' })} title={isRuida ? 'Tells the controller to stop (three times): the laser goes off, and the controller takes the head back to where the job started' : 'Feed hold, then reset: the laser goes off'}><i>⏹</i>Stop</button>
                <button className="btn big primary" aria-label="Start…" disabled={!matches || !idle || running || mode === 'off' || !!over || needOrigin} onClick={() => { setUnverifiedOk(false); setConfirm(true); }} title={!matches ? (isRuida ? 'Nothing to burn yet' : 'Send the job first') : over ? 'The job does not fit from where the head is' : mode === 'off' ? 'Turn on laser mode first' : 'Start burning'}><i>▶</i>Start…</button>
                <button className="btn big" aria-label="Frame" disabled={!matches || !idle || running || !!over || originMissing} onClick={() => send(isRuida ? { type: 'frame', feed: speed, name: 'laser-job', content: ruida.text, ...(origin ? { origin } : {}) } : { type: 'frame', feed: speed })} title={over ? 'The job does not fit from where the head is' : 'Trace the outline of the job with the laser OFF'}><i>⬚</i>Frame</button>
                {isRuida && <button className="btn big" aria-label="Trace a circle" disabled={!matches || !idle || running || !!over || originMissing} onClick={() => send({ type: 'frame', feed: speed, name: 'laser-job', content: ruida.text, shape: 'circle', ...(origin ? { origin } : {}) })} title={over ? 'The job does not fit from where the head is' : 'Trace a circle round the job with the laser OFF'}><i>◯</i>Frame</button>}
                {caps?.home && isRuida && <button className={'btn big' + (homeArmed ? ' primary' : '')} aria-label="Home" disabled={!idle || running} onClick={() => { if (!homeArmed) { setHomeArmed(true); return; } setHomeArmed(false); send({ type: 'home' }); }} title="Send the head to the machine's home (it seeks its limits, then stops at 0, 0). Press twice."><i>⌂</i>{homeArmed ? 'Press again' : 'Home'}</button>}
                {!isRuida && <button className="btn big" aria-label="Send job" disabled={jobEmpty || running || stale} onClick={() => send({ type: 'loadJob', name: 'laser-job', content: job.gcode })} title="Check the job and put it on the laser (nothing moves yet)"><i>⇪</i>Send</button>}
              </div>
              {isRuida && (
                <div className="row wrap startfrom">
                  <label className="inline small">Start from
                    <select aria-label="Start from" value={startMode} onChange={(e) => setStartMode(e.target.value as 'current' | 'absolute' | 'origin')}>
                      <option value="current">Current position</option>
                      <option value="absolute">Absolute coordinates (frame only)</option>
                      <option value="origin">User origin (frame only)</option>
                    </select>
                  </label>
                  <span className="small muted">Job origin</span>
                  <AnchorGrid value={anchor} onChange={setAnchor} label="Job origin" />
                  <label className="inline small" title="The rotary attachment is fitted (set it up in Settings, Rotary setup)"><input type="checkbox" checked={rotary.setup.enabled} onChange={(e) => rotary.save({ ...rotary.setup, enabled: e.target.checked })} /> Rotary</label>
                </div>
              )}
              {needOrigin && (
                <div className="notice" role="status">
                  <span className="small">
                    {originMissing
                      ? (startMode === 'absolute' ? 'Nothing to place yet.' : <><b>No job origin.</b> Star a saved position (☆) in the Move window to use it as the User origin.</>)
                      : <>Frames from X {origin!.x} · Y {origin!.y} mm (the job's start point, {startMode === 'absolute' ? 'where it sits in the design' : 'your User origin'}); the head goes there, round the box, and back to where it was. <b>Start is not available in this mode yet:</b> it needs a capture of a job sent this way.</>}
                  </span>
                </div>
              )}
              {rotaryBlocks && <div className="notice danger" role="status"><span className="small"><b>Rotary is on: jobs are not sent yet.</b> Frame and Start wait until how the controller wants a rotary job is confirmed. Untick Rotary to run a flat job.</span></div>}
              {isRuida ? (
                <span className="small">{jobEmpty ? 'Nothing to burn yet.' : <>Ready. Nothing is sent to the laser until you press Start; Frame and Start check the job first.</>}</span>
              ) : !onMachine ? (
                <span className="muted small">No job on the laser yet.</span>
              ) : (
                <span className="small">On the laser: <b>{onMachine.name}</b> · {onMachine.lines} lines {matches ? <span className="ok">· matches the design</span> : <span className="warn">· the design has changed since: send it again</span>}</span>
              )}
              {running && isRuida && <div className="small mono" role="status">Running · {formatTime((state!.job.elapsedMs ?? 0) / 1000)} (the controller does not report progress) {onMonitor && <button className="btn small" onClick={onMonitor}>Monitor</button>}</div>}
              {running && !isRuida && (
                <>
                  <div className="bar" aria-label="Progress"><div style={{ width: `${Math.round(progress * 100)}%` }} /></div>
                  <div className="small mono">{Math.round(progress * 100)}% · {state!.job.doneLines}/{state!.job.totalLines} lines · {formatTime((state!.job.elapsedMs ?? 0) / 1000)}</div>
                </>
              )}
              {stale && <div className="muted small" role="status">Working out the job… (Frame and Start wait for it)</div>}
              {jobError && !stale && <div className="warn small" role="alert">⚠ {jobError}</div>}
              {notice && !notice.ok && <div className="warn small" role="alert">⚠ {notice.message}</div>}
              {jobState === 'done' && <div className="small ok" role="status">✓ Job complete in {formatTime((state!.job.elapsedMs ?? 0) / 1000)}</div>}
              {jobState === 'error' && <div className="small warn" role="alert">⚠ {state!.job.error ?? 'The job stopped with an error.'}</div>}
            </div>
          </>
        )}
        {!connected && notice && !notice.ok && <div className="warn small" role="alert">⚠ {notice.message}</div>}
        {laser.log.length > 0 && (
          <details>
            <summary className="small muted">Machine log</summary>
            <div className="log small">{laser.log.slice(-25).map((l, i) => <div key={i} className={'log-' + (l.kind === 'tx' ? 'in' : l.kind === 'err' ? 'err' : l.kind === 'sys' ? 'ok' : 'info')}>{l.kind === 'tx' ? '› ' : ''}{l.text}</div>)}</div>
          </details>
        )}
      </div>

      {confirm && (
        <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && setConfirm(false)}>
          <div className="modal" role="dialog" aria-modal="true" aria-label="Start the laser job">
            <h2>Start burning?</h2>
            <ul className="checks">
              <li>Eye protection is on, and the laser's cover or shield is in place.</li>
              <li>The material is in place and in focus, and work zero is where you want it.</li>
              <li>Nothing is in the way of the head, and nothing flammable is near the beam.</li>
              <li>You will stay and watch it. <b>Stop</b> switches the laser off.</li>
            </ul>
            {isRuida && (
              <>
                <p className="small"><b>What will happen</b> (the laser fires if its power supply is on):</p>
                <ul className="checks">{ruida.summary.map((l, i) => <li key={i}>{l}</li>)}</ul>
                <ul className="checks">
                  <li>The water chiller is running and the air and exhaust are on. The controller's own water check is switched off, so nothing else will stop the job if the water stops.</li>
                  <li>Layers with Air on use high air pressure; the others low. When the job ends, or you press Stop, the head goes back to where the job started.</li>
                  <li>This Ruida support has had only a few short real runs.</li>
                </ul>
              </>
            )}
            <p className="small muted">{onMachine?.name ?? 'laser-job'} · {job.stats.layers} layer{job.stats.layers === 1 ? '' : 's'} · about {formatTime(job.stats.seconds)}</p>
            {!isRuida && mode === 'unknown' && (
              <label className="inline small"><input type="checkbox" checked={unverifiedOk} onChange={(e) => setUnverifiedOk(e.target.checked)} /> I have checked that laser mode is on in the controller (it could not be read).</label>
            )}
            <div className="row end">
              <button className="btn" onClick={() => setConfirm(false)}>Cancel</button>
              <button className="btn primary" disabled={stale || (!isRuida && mode === 'unknown' && !unverifiedOk)} onClick={() => { send(isRuida ? { type: 'start', hash, name: 'laser-job', content: ruida.text } : { type: 'start', hash, acknowledgeUnverified: unverifiedOk }); if (isRuida && state?.status.wpos) onStarted?.({ x: state.status.wpos.x, y: state.status.wpos.y }); setConfirm(false); }}>Start burning</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
