import { useEffect, useRef, useState } from 'react';
import { Viewer, type ViewPreset, type ViewerColors } from './viewer';
import { Dock, LayoutProvider, Panel } from './Dock';
import { SettingsDrawer } from './Settings';
import { PhoneDialog, ViewOnlyBar } from './Access';
import { SettingsContext, useSettings, type SettingsPage } from './settingsContext';
import { useColors, useDensity } from './appearance';
import { useGamepad, type PadState } from './gamepad';
import { useKeyboard } from './keyboard';
import { jogGesture, stopAllJogging, useHoldJog } from './holdJog';
import { CameraPanel } from './CameraPanel';
import { MacrosPanel } from './MacrosPanel';
import { SpindlePanel } from './SpindlePanel';
import { PcbPanel } from './PcbPanel';
import { NumInput, UnitsProvider, useUnits, MM_PER_INCH } from './units';
import type { PanelId } from '../../shared/layout';
import { analyzeProgram } from '../../shared/toolpath';
import type { Machine } from './useMachine';
import { useMachine } from './useMachine';
import { AL_DEFAULTS, PROBE_DEFAULTS, loadAlForm, loadProbeForm, toSettings, type AlForm, type ProbeForm } from './probeForms';
import type { AutolevelParams, Box3, Extents, HeightMap, JogAxis, ProbeKind, ProbeSettings } from '../../shared/protocol';

const savedNum = (key: string, fallback: number) => Number(localStorage.getItem(key)) || fallback;
const fmtTime = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

export function App() {
  const m = useMachine();
  const [theme, setTheme] = useState<'dark' | 'light'>(() => (localStorage.getItem('theme') as 'dark' | 'light') ?? 'dark');
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('theme', theme);
  }, [theme]);

  // The mouse wheel must scroll the page, never change a number it happens to be over: let go of a focused number box when the wheel turns
  useEffect(() => {
    const off = (e: WheelEvent) => { const t = e.target; if (t instanceof HTMLInputElement && t.type === 'number' && document.activeElement === t) t.blur(); };
    document.addEventListener('wheel', off, { passive: true });
    return () => document.removeEventListener('wheel', off);
  }, []);

  const [settings, setSettings] = useState<{ page: SettingsPage } | null>(null);
  const openSettings = (page?: SettingsPage) => setSettings((s) => ({ page: page ?? s?.page ?? 'layout' }));

  const colors = useColors(theme);
  const [density, setDensity] = useDensity();
  useHoldJog(m);
  const pad = useGamepad(m);
  const keys = useKeyboard(m);

  const panels: Record<PanelId, React.ReactNode> = {
    connection: <ConnectPanel m={m} />,
    position: <DroPanel m={m} />,
    jog: <JogPanel m={m} />,
    visualizer: <VisualizerPanel m={m} />,
    camera: <CameraPanel m={m} />,
    job: <JobPanel m={m} />,
    probe: <ProbePanel m={m} />,
    autolevel: <AutolevelPanel m={m} />,
    overrides: <OverridePanel m={m} />,
    macros: <MacrosPanel m={m} />,
    spindle: <SpindlePanel m={m} />,
    pcb: <PcbPanel m={m} />,
    console: <ConsolePanel m={m} />,
  };

  return (
    <UnitsProvider><LayoutProvider><SettingsContext.Provider value={{ open: openSettings }}>
      <div className="app">
        <Header m={m} pad={pad} theme={theme} setTheme={setTheme} onSettings={() => (settings ? setSettings(null) : openSettings())} settingsOpen={!!settings} />
        <ViewOnlyBar m={m} />
        <Dock panels={panels} />
        <ProbeDialog m={m} />
        {settings && <SettingsDrawer m={m} page={settings.page} setPage={(page) => setSettings({ page })} onClose={() => setSettings(null)} theme={theme} setTheme={setTheme} colors={colors} density={density} setDensity={setDensity} pad={pad} keys={keys} />}
      </div>
    </SettingsContext.Provider></LayoutProvider></UnitsProvider>
  );
}

function Header({ m, pad, theme, setTheme, onSettings, settingsOpen }: { m: Machine; pad: PadState; theme: string; setTheme: (t: 'dark' | 'light') => void; onSettings: () => void; settingsOpen: boolean }) {
  const s = m.status.state;
  const u = useUnits();
  const settings = useSettings();
  const [phone, setPhone] = useState(false);
  return (
    <header className="header">
      <img src="/logo.png" alt="Prickly Guy Creations" className="logo" />
      <div className="brand"><b>DemonX</b><span>CNC Controller</span></div>
      <div className={`state state-${s}`}>{m.online ? s : 'Server offline'}</div>
      <div className="spacer" />
      <div className="muted">{m.clients} client{m.clients === 1 ? '' : 's'}</div>
      <button className="btn warn" onClick={() => m.send({ type: 'hold' })} disabled={!m.connection.connected}>HOLD</button>
      <button className="btn ok" onClick={() => m.send({ type: 'resume' })} disabled={!m.connection.connected}>RESUME</button>
      <button className="btn danger" onClick={() => m.send({ type: 'reset' })} disabled={!m.connection.connected}>RESET</button>
      <button className={`btn ${m.config.pcb.enabled ? 'warn' : 'ghost'}`} aria-pressed={m.config.pcb.enabled}
        title={m.config.pcb.enabled ? 'PCB mode is on: click to turn it off and go back to normal operation' : m.config.pcb.configured ? 'Turn PCB mode on' : 'Set up PCB mode'}
        onClick={() => (m.config.pcb.enabled ? m.send({ type: 'configSet', update: { pcb: { enabled: false } } }) : m.config.pcb.configured ? m.send({ type: 'configSet', update: { pcb: { enabled: true } } }) : settings.open('pcb'))}>
        {m.config.pcb.enabled ? '▣ PCB MODE ON ✕' : '▣ PCB'}
      </button>
      {pad.enabled && pad.name && <span className={`padbadge ${pad.armed ? 'on' : ''}`} title={pad.armed ? 'Gamepad armed: the sticks move the machine. B stops, Back disarms.' : 'Gamepad connected but not armed: press Start with the sticks centred'}>🎮 {pad.armed ? 'armed' : 'press Start'}</span>}
      <button className="btn ghost" title="Open DemonX on a phone or another computer: address and QR code" aria-label="Open DemonX on a phone" onClick={() => setPhone(true)}>📱</button>
      <button className={`btn ghost ${settingsOpen ? 'on' : ''}`} aria-expanded={settingsOpen} onClick={onSettings}>⚙ Settings{m.stats.tasks.some((t) => t.due) && <span className="duedot" title="A maintenance task is due (Settings > Stats & maintenance)" aria-label="Maintenance due"> ●</span>}</button>
      <button className="btn ghost" title="Show lengths in millimetres or inches (this browser only; the machine always works in mm)" onClick={() => u.setUnit(u.unit === 'mm' ? 'in' : 'mm')}>{u.unit === 'mm' ? 'mm' : 'inch'}</button>
      <button className="btn ghost" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? '☀ Light' : '☾ Dark'}</button>
      {phone && <PhoneDialog m={m} onClose={() => setPhone(false)} />}
    </header>
  );
}

const OTHER = '__other';

function ConnectPanel({ m }: { m: Machine }) {
  const [target, setTarget] = useState(localStorage.getItem('target') ?? '');
  const [baud, setBaud] = useState(115200);
  const c = m.connection;
  const [custom, setCustom] = useState(false);
  const known = target === 'simulator' || m.ports.some((p) => p.path === target);
  // a saved port that is not plugged in now is shown for editing instead of silently disappearing
  const pick = custom ? OTHER : target === '' ? '' : known ? target : OTHER;
  return (
    <Panel id="connection" title="Connection">
      {c.connected ? (
        <>
          <div className="row"><span className="muted">Connected to</span> <b>{c.target}</b></div>
          {c.firmware && <div className="muted small">{c.firmware}</div>}
          <button className="btn danger" onClick={() => m.send({ type: 'disconnect' })}>Disconnect</button>
        </>
      ) : (
        <>
          <div className="row">
            <select value={pick} aria-label="Serial port" onChange={(e) => { const o = e.target.value === OTHER; setCustom(o); setTarget(o ? '' : e.target.value); }}>
              <option value="" disabled>Choose a port…</option>
              <option value="simulator">Simulator (no hardware)</option>
              {m.ports.map((p) => <option key={p.path} value={p.path}>{p.path}{(p.manufacturer ?? p.description) ? ` (${p.manufacturer ?? p.description})` : ''}</option>)}
              <option value={OTHER}>Other (type it)…</option>
            </select>
            <select value={baud} onChange={(e) => setBaud(Number(e.target.value))}>
              {[115200, 250000, 57600, 9600].map((b) => <option key={b}>{b}</option>)}
            </select>
          </div>
          {pick === OTHER && <input value={target} autoFocus={target === ''} placeholder="Port name (COM3, /dev/ttyUSB0)" aria-label="Port name" onChange={(e) => setTarget(e.target.value)} />}
          <div className="row">
            <button className="btn" onClick={() => m.send({ type: 'listPorts' })}>Refresh ports</button>
            <button className="btn primary" disabled={!target || !m.online} onClick={() => { localStorage.setItem('target', target); m.send({ type: 'connect', target, baud }); }}>Connect</button>
          </div>
          <div className="muted small">Ports listed are on the server, not this computer. Pick "Simulator" to try the UI without a machine.</div>
        </>
      )}
    </Panel>
  );
}

function DroPanel({ m }: { m: Machine }) {
  const u = useUnits();
  const { wpos, mpos } = m.status;
  const off = !m.connection.connected;
  const axes: { a: JogAxis; k: 'x' | 'y' | 'z' }[] = [{ a: 'X', k: 'x' }, { a: 'Y', k: 'y' }, { a: 'Z', k: 'z' }];
  return (
    <Panel id="position" title="Position" className="dro">
      <div className="dro-grid">
      {axes.map(({ a, k }) => (
        <div className="dro-row" key={a}>
          <span className="axis">{a}</span>
          <span className="wpos">{u.len(wpos[k], 2)}</span>
          <span className="mpos">{u.len(mpos[k], 2)}</span>
          <button className="btn small" disabled={off} onClick={() => m.send({ type: 'zero', axes: [a] })}>Zero</button>
        </div>
      ))}
      </div>
      <div className="row">
        <button className="btn" disabled={off} onClick={() => m.send({ type: 'zero', axes: ['X', 'Y'] })}>Zero XY</button>
        <button className="btn" disabled={off} onClick={() => m.send({ type: 'zero', axes: ['X', 'Y', 'Z'] })}>Zero All</button>
        <button className={`btn home ${m.connection.homeReminder && !m.config.pcb.enabled ? 'pulse' : ''}`} disabled={off || m.config.pcb.enabled}
          title={m.config.pcb.enabled ? 'PCB mode is on: turn it off to home the machine' : m.connection.homeReminder ? 'Just connected: home the machine, or press Unlock if you do not want to' : ''}
          onClick={() => m.send({ type: 'home' })}>Home</button>
        <button className="btn warn" disabled={off} onClick={() => m.send({ type: 'unlock' })}>Unlock</button>
      </div>
      <div className="row">
        {/* Same feeds as the jog panel; Z stays slow so there is time to react */}
        <button className="btn" disabled={off} onClick={() => m.send({ type: 'goto', target: 'z0', feed: savedNum('jogZFeed', 300) })}>Go to Z0</button>
        <button className="btn" disabled={off} onClick={() => m.send({ type: 'goto', target: 'xy0', feed: savedNum('jogFeedXY', 3000) })}>Go to XY0</button>
        <button className="btn frame" disabled={off || m.status.state !== 'Idle' || !m.job.extents?.all || m.job.state === 'running' || m.job.state === 'paused'}
          title={m.job.extents?.all ? 'Trace the outline of the loaded G-code (all its moves) 5 mm above the current height, then return here' : 'Load a G-code file first'}
          onClick={() => m.send({ type: 'frame', feed: savedNum('jogFeedXY', 3000), zFeed: savedNum('jogZFeed', 300) })}>Frame</button>
      </div>
      <div className="muted small">Large = work position · small = machine position · Feed {u.feed(m.status.feed)} {u.feedUnit} · Spindle {Math.round(m.status.spindle)}</div>
    </Panel>
  );
}

// Jog step lists, in the unit shown on screen. Z stops at the 20 mm cap the server enforces anyway.
const STEPS = {
  mm: { xy: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500], z: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20] },
  in: { xy: [0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 4, 10, 20], z: [0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5] },
};
const MAX_Z_JOG = 20; // mm, also enforced on the server

/** Persist a small per-browser setting (jog step, feed). */
function useSaved(key: string, initial: number): [number, (n: number) => void] {
  const [v, setV] = useState(() => {
    const n = Number(localStorage.getItem(key));
    return n > 0 ? n : initial;
  });
  return [v, (n) => { setV(n); localStorage.setItem(key, String(n)); }];
}

// Defined at module level on purpose: a component defined inside another
// component gets a new identity on every render, which remounts the button
// and swallows clicks whenever a status update lands mid-click.
function JogBtn({ label, disabled, onJog, className = '' }: { label: string; disabled: boolean; onJog: () => void; className?: string }) {
  return <button className={`btn jog ${className}`} disabled={disabled} onClick={onJog}>{label}</button>;
}

/**
 * A jog button that you can tap (one step) or hold (keeps moving until you let go). The press is followed even if the finger or
 * mouse slides off the button, and a cancelled touch lets go. Enter or Space on the focused button is a tap.
 */
function HoldBtn({ label, id, dir, disabled }: { label: string; id: string; dir: { x: number; y: number; z: number }; disabled: boolean }) {
  return (
    <button className="btn jog" disabled={disabled} aria-label={label}
      onPointerDown={(e) => { if (e.pointerType === 'mouse' && e.button !== 0) return; try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* not capturable */ } jogGesture.down(id, dir); }}
      onPointerUp={() => jogGesture.up(id)}
      onPointerCancel={() => jogGesture.cancel(id)}
      onLostPointerCapture={() => jogGesture.cancel(id)}
      onContextMenu={(e) => e.preventDefault()}
      onClick={(e) => { if (e.detail === 0) { jogGesture.down(id, dir); jogGesture.up(id); } }}>{label}</button>
  );
}

/** The entry of a step list (in the unit on screen) closest to a step kept in mm */
function nearestStep(list: number[], unit: 'mm' | 'in', mm: number): number {
  let best = 0;
  list.forEach((s, i) => { if (Math.abs(Math.log((s * (unit === 'in' ? MM_PER_INCH : 1)) / mm)) < Math.abs(Math.log((list[best] * (unit === 'in' ? MM_PER_INCH : 1)) / mm))) best = i; });
  return best;
}

/** [-] [step v] [+]: big buttons to step through the list, and the readout is a dropdown to jump anywhere in it */
function StepPicker({ label, list, mm, onMm, className = '' }: { label: string; list: number[]; mm: number; onMm: (mm: number) => void; className?: string }) {
  const u = useUnits();
  const k = u.unit === 'in' ? MM_PER_INCH : 1;
  const i = nearestStep(list, u.unit, mm);
  const go = (n: number) => onMm(list[Math.max(0, Math.min(list.length - 1, n))] * k);
  return (
    <div className={`row steprow ${className}`}>
      <span className="muted lbl">{label}</span>
      <button className="btn" disabled={i === 0} onClick={() => go(i - 1)} aria-label="Smaller step">−</button>
      <select value={i} onChange={(e) => go(Number(e.target.value))} aria-label={label}>
        {list.map((s, n) => <option key={s} value={n}>{s} {u.lenUnit}</option>)}
      </select>
      <button className="btn" disabled={i === list.length - 1} onClick={() => go(i + 1)} aria-label="Larger step">+</button>
    </div>
  );
}

function JogPanel({ m }: { m: Machine }) {
  const u = useUnits();
  const lists = STEPS[u.unit];
  const [step, setStep] = useSaved('jogStep', 1);
  const [feed, setFeed] = useSaved('jogFeedXY', 3000);
  const [zStep, setZStep] = useSaved('jogZStep', 1);
  const [zFeed, setZFeed] = useSaved('jogZFeed', 300);
  // the step in use must be exactly what the picker shows: when the unit changes (or an old saved step is
  // not in the list) move to the nearest entry, e.g. 100 mm becomes 4 in
  useEffect(() => {
    const k = u.unit === 'in' ? MM_PER_INCH : 1;
    const xi = nearestStep(lists.xy, u.unit, step), zi = nearestStep(lists.z, u.unit, zStep);
    if (Math.abs(lists.xy[xi] * k - step) > 1e-9) setStep(lists.xy[xi] * k);
    if (Math.abs(lists.z[zi] * k - zStep) > 1e-9) setZStep(lists.z[zi] * k);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [u.unit]);
  // the keyboard's "smaller / larger step" keys
  useEffect(() => {
    const on = (e: Event) => {
      const dir = (e as CustomEvent<number>).detail;
      const k = u.unit === 'in' ? MM_PER_INCH : 1;
      const n = Math.max(0, Math.min(lists.xy.length - 1, nearestStep(lists.xy, u.unit, step) + dir));
      setStep(lists.xy[n] * k);
    };
    window.addEventListener('demonx:jogstep', on);
    return () => window.removeEventListener('demonx:jogstep', on);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [u.unit, step]);
  const off = !m.connection.connected || m.job.state === 'running';
  return (
    <Panel id="jog" title="Jog">
      <div className="jogwrap">
        <div className="pad">
          <HoldBtn label="↖" id="pad:nw" dir={{ x: -1, y: 1, z: 0 }} disabled={off} /><HoldBtn label="Y+" id="pad:n" dir={{ x: 0, y: 1, z: 0 }} disabled={off} /><HoldBtn label="↗" id="pad:ne" dir={{ x: 1, y: 1, z: 0 }} disabled={off} />
          <HoldBtn label="X−" id="pad:w" dir={{ x: -1, y: 0, z: 0 }} disabled={off} /><JogBtn label="■" className="stopjog" disabled={off} onJog={() => { stopAllJogging(); m.send({ type: 'jogCancel' }); }} /><HoldBtn label="X+" id="pad:e" dir={{ x: 1, y: 0, z: 0 }} disabled={off} />
          <HoldBtn label="↙" id="pad:sw" dir={{ x: -1, y: -1, z: 0 }} disabled={off} /><HoldBtn label="Y−" id="pad:s" dir={{ x: 0, y: -1, z: 0 }} disabled={off} /><HoldBtn label="↘" id="pad:se" dir={{ x: 1, y: -1, z: 0 }} disabled={off} />
        </div>
        <div className="zpad">
          <HoldBtn label="Z+" id="pad:zu" dir={{ x: 0, y: 0, z: 1 }} disabled={off} />
          <HoldBtn label="Z−" id="pad:zd" dir={{ x: 0, y: 0, z: -1 }} disabled={off} />
        </div>
      </div>
      <StepPicker label="XY step" list={lists.xy} mm={step} onMm={setStep} />
      <div className="row">
        <span className="muted lbl">XY feed</span>
        <NumInput mm={feed} onMm={(v) => v > 0 && setFeed(v)} kind="feed" /> <span className="muted">{u.feedUnit}</span>
      </div>
      <StepPicker label="Z step" list={lists.z} mm={zStep} onMm={setZStep} className="zrow" />
      <div className="row">
        <span className="muted lbl">Z feed</span>
        <NumInput mm={zFeed} onMm={(v) => v > 0 && setZFeed(v)} kind="feed" /> <span className="muted">{u.feedUnit}</span>
      </div>
      <div className="muted small">Tap a button for one step; hold it to keep moving until you let go. Z moves at most {u.len(MAX_Z_JOG, 2)} {u.lenUnit} per tap or hold.</div>
    </Panel>
  );
}

/**
 * Is a height map relevant to this program? Only when the whole program sits inside the
 * scanned area (a wood job on a big stock, or a board somewhere else, does not),
 * so the "not applied" warning stays quiet for jobs that never needed one.
 */
function mapFitsProgram(map: HeightMap, b?: { minX: number; maxX: number; minY: number; maxY: number }): boolean {
  if (!b) return false;
  const tol = 2;
  return b.minX >= map.minX - tol && b.maxX <= map.maxX + tol && b.minY >= map.minY - tol && b.maxY <= map.maxY + tol;
}

/** Min / max / size of each axis for the loaded program, at a glance. */
function ExtentsTable({ e }: { e?: Extents }) {
  const u = useUnits();
  const box = e?.cut ?? e?.all;
  if (!e || !box) return null;
  const rows: { a: string; lo: number; hi: number }[] = [
    { a: 'X', lo: box.minX, hi: box.maxX }, { a: 'Y', lo: box.minY, hi: box.maxY }, { a: 'Z', lo: box.minZ, hi: box.maxZ },
  ];
  const f = (n: number) => u.len(n);
  const range = (b: Box3, lo: 'minX' | 'minY' | 'minZ', hi: 'maxX' | 'maxY' | 'maxZ') => `${f(b[lo])} to ${f(b[hi])}`;
  // Only worth a second line when rapids reach somewhere the cutting does not
  const rapidsDiffer = !!e.all && !!e.cut && (['X', 'Y', 'Z'] as const).some((a) => {
    const lo = `min${a}` as 'minX', hi = `max${a}` as 'maxX';
    return Math.abs(e.all![lo] - e.cut![lo]) > 0.0005 || Math.abs(e.all![hi] - e.cut![hi]) > 0.0005;
  });
  return (
    <div>
      <table className="ext">
        <thead><tr><th>{e.cut ? 'Cutting' : 'Moves'}</th><th>Min</th><th>Max</th><th>Size</th></tr></thead>
        <tbody>
          {rows.map((r) => <tr key={r.a}><th>{r.a}</th><td>{f(r.lo)}</td><td>{f(r.hi)}</td><td>{f(r.hi - r.lo)}</td></tr>)}
        </tbody>
      </table>
      {rapidsDiffer && e.all && (
        <div className="muted small">Including rapids: X {range(e.all, 'minX', 'maxX')} · Y {range(e.all, 'minY', 'maxY')} · Z {range(e.all, 'minZ', 'maxZ')}</div>
      )}
    </div>
  );
}

function JobPanel({ m }: { m: Machine }) {
  const u = useUnits();
  const j = m.job;
  const file = useRef<HTMLInputElement>(null);
  const pct = j.totalLines ? Math.round((j.doneLines / j.totalLines) * 100) : 0;
  const running = j.state === 'running' || j.state === 'paused';
  const load = async (f: File) => m.send({ type: 'jobLoad', name: f.name, content: await f.text() });
  return (
    <Panel id="job" title="Job" className="job">
      <div className="row">
        <input ref={file} type="file" accept=".nc,.gcode,.gc,.ngc,.tap,.txt,.cnc" hidden onChange={(e) => e.target.files?.[0] && load(e.target.files[0])} />
        <button className="btn" disabled={running} onClick={() => file.current?.click()}>Open G-code…</button>
        <b>{j.name || 'No file loaded'}</b>
      </div>
      <ExtentsTable e={j.extents} />
      {j.leveled
        ? <div className="badge badge-ok">AUTOLEVELLED · Z corrected {u.len(j.leveled.minDelta, 2)} to {u.len(j.leveled.maxDelta, 2)} {u.lenUnit}</div>
        : j.alreadyLeveled
          ? <div className="badge badge-ok" title="Do not level it again: the correction would be applied twice">
              ALREADY AUTOLEVELLED (from the file){j.alreadyLeveled.info ? `: ${j.alreadyLeveled.info}` : ''}
            </div>
          : m.heightmap && j.state !== 'none' && mapFitsProgram(m.heightmap, j.bounds) &&
            <div className="badge badge-warn">A height map exists for this area but is NOT applied to this program</div>}
      <div className="bar"><div style={{ width: `${pct}%` }} /></div>
      <div className="row muted small">
        <span>{j.state.toUpperCase()}</span><span>{j.doneLines}/{j.totalLines} lines ({pct}%)</span><span>{fmtTime(j.elapsedMs)}</span>
      </div>
      {j.error && <div className="err">{j.error}</div>}
      <div className="row">
        <button className="btn primary" disabled={!m.connection.connected || running || j.state === 'none'} onClick={() => m.send({ type: 'jobStart' })}>Start</button>
        <button className="btn warn" disabled={j.state !== 'running'} onClick={() => m.send({ type: 'jobPause' })}>Pause</button>
        <button className="btn ok" disabled={j.state !== 'paused'} onClick={() => m.send({ type: 'jobResume' })}>Resume</button>
        <button className="btn danger" disabled={!running} onClick={() => m.send({ type: 'jobStop' })}>Stop</button>
      </div>
    </Panel>
  );
}

function OverridePanel({ m }: { m: Machine }) {
  const off = !m.connection.connected;
  const row = (label: string, kind: 'feed' | 'spindle', value: number) => (
    <div className="row" key={kind}>
      <span className="ovlabel">{label} <b>{value}%</b></span>
      <button className="btn small" disabled={off} onClick={() => m.send({ type: 'override', kind, action: 'minus10' })}>−10</button>
      <button className="btn small" disabled={off} onClick={() => m.send({ type: 'override', kind, action: 'minus1' })}>−1</button>
      <button className="btn small" disabled={off} onClick={() => m.send({ type: 'override', kind, action: 'reset' })}>100</button>
      <button className="btn small" disabled={off} onClick={() => m.send({ type: 'override', kind, action: 'plus1' })}>+1</button>
      <button className="btn small" disabled={off} onClick={() => m.send({ type: 'override', kind, action: 'plus10' })}>+10</button>
    </div>
  );
  return (
    <Panel id="overrides" title="Overrides">
      {row('Feed', 'feed', m.status.ov.feed)}
      {row('Spindle', 'spindle', m.status.ov.spindle)}
      <div className="row">
        <span className="ovlabel">Rapid <b>{m.status.ov.rapid}%</b></span>
        {(['reset', 'half', 'quarter'] as const).map((a) => (
          <button key={a} className="btn small" disabled={off} onClick={() => m.send({ type: 'override', kind: 'rapid', action: a })}>{a === 'reset' ? '100' : a === 'half' ? '50' : '25'}</button>
        ))}
      </div>
    </Panel>
  );
}

function ConsolePanel({ m }: { m: Machine }) {
  const [cmd, setCmd] = useState('');
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { box.current?.scrollTo(0, box.current.scrollHeight); }, [m.log]);
  return (
    <Panel id="console" title="Console" className="console">
      <div className="log" ref={box}>
        {m.log.map((l, i) => <div key={i} className={`log-${l.kind}`}>{l.kind === 'tx' ? '> ' : ''}{l.text}</div>)}
      </div>
      <form className="row" onSubmit={(e) => { e.preventDefault(); if (cmd) { m.send({ type: 'send', line: cmd }); setCmd(''); } }}>
        <input value={cmd} placeholder="Send command (e.g. $$ or G0 X0)" onChange={(e) => setCmd(e.target.value)} disabled={!m.connection.connected} />
        <button className="btn" disabled={!m.connection.connected}>Send</button>
      </form>
    </Panel>
  );
}

// ---------------- Probing ----------------

const PROBE_FIELDS: { key: keyof ProbeForm; label: string; unit: 'mm' | 'mm/min' }[] = [
  { key: 'plateZ_z', label: 'Z plate height', unit: 'mm' },
  { key: 'plateZ_xyz', label: 'XYZ block height', unit: 'mm' },
  { key: 'plateX', label: 'XYZ block wall X', unit: 'mm' },
  { key: 'plateY', label: 'XYZ block wall Y', unit: 'mm' },
  { key: 'endmill', label: 'Endmill diameter', unit: 'mm' },
  { key: 'feedFast', label: 'Fast feed', unit: 'mm/min' },
  { key: 'feedFine', label: 'Fine feed', unit: 'mm/min' },
  { key: 'maxZ', label: 'Max Z travel', unit: 'mm' },
  { key: 'maxXY', label: 'Max XY travel', unit: 'mm' },
  { key: 'retract', label: 'Retract between passes', unit: 'mm' },
  { key: 'clearance_z', label: 'Z probe: end height', unit: 'mm' },
  { key: 'clearance_pcb', label: 'PCB probe: end height', unit: 'mm' },
  { key: 'clearance_xyz', label: 'XYZ probe: end height', unit: 'mm' },
];

function useProbeForm(): [ProbeForm, (k: keyof ProbeForm, v: number) => void] {
  const [f, setF] = useState<ProbeForm>(loadProbeForm);
  const set = (k: keyof ProbeForm, v: number) => {
    const next = { ...f, [k]: v };
    setF(next);
    localStorage.setItem('probeForm', JSON.stringify(next));
  };
  return [f, set];
}

function ProbePanel({ m }: { m: Machine }) {
  const u = useUnits();
  const [form, setForm] = useProbeForm();
  const busy = m.probe.phase !== 'idle';
  const ready = m.connection.connected && m.status.state === 'Idle' && !busy && m.job.state !== 'running' && m.job.state !== 'paused';
  const start = (kind: ProbeKind) => m.send({ type: 'probeStart', kind, settings: toSettings(form, kind) });
  return (
    <Panel id="probe" title="Probe">
      <div className="row">
        <button className="btn" disabled={!ready} onClick={() => start('z')}>▼ Z probe</button>
        <button className="btn" disabled={!ready} onClick={() => start('xyz')}>⊕ XYZ</button>
        <button className="btn" disabled={!ready} onClick={() => start('pcb')}>◎ PCB Z</button>
      </div>
      <div className="muted small">
        Each probe asks you to confirm the probe is connected before it moves, and to confirm it is removed before anything else can run.
      </div>
      <details>
        <summary className="muted small">Probe settings</summary>
        <div className="pform">
          {PROBE_FIELDS.map((fld) => (
            <label key={fld.key}>
              <span>{fld.label}</span>
              <NumInput mm={form[fld.key]} onMm={(v) => setForm(fld.key, v)} kind={fld.unit === 'mm' ? 'len' : 'feed'} />
              <span className="muted">{fld.unit === 'mm' ? u.lenUnit : u.feedUnit}</span>
            </label>
          ))}
        </div>
      </details>
    </Panel>
  );
}

const REMOVE_TEXT: Record<ProbeKind, string> = {
  z: 'Remove the probe clip from the bit and take the plate off the work surface.',
  pcb: 'Remove the ground clip from the bit.',
  xyz: 'Remove the probe clip from the bit and take the touch block off the work surface.',
  autolevel: 'Remove the ground clip from the bit before cutting.',
};

function ProbeDialog({ m }: { m: Machine }) {
  const p = m.probe;
  const u = useUnits();
  if (p.phase === 'idle') return null;
  const triggered = m.status.pins.includes('P');
  const confirm = () => m.send({ type: 'probeConfirm', id: p.id, phase: p.phase });
  const results = p.result && Object.entries(p.result).map(([k, v]) => `${k.toUpperCase()} ${u.len(v as number)}`).join('   ');

  return (
    <div className="overlay">
      <div className={`dialog ${p.phase === 'confirmRemove' ? (p.success ? 'dlg-amber' : 'dlg-red') : 'dlg-amber'}`} role="alertdialog" aria-modal="true">
        <div className="dlg-kind">{p.title}</div>

        {p.phase === 'confirmConnect' && (
          <>
            <h3>{p.kind === 'pcb' || p.kind === 'autolevel' ? 'IS YOUR GROUND CONNECTED?' : 'IS THE PROBE CONNECTED?'}</h3>
            <ul>{p.checklist?.map((c) => <li key={c}>{c}</li>)}</ul>
            <div className={`pin ${triggered ? 'pin-on' : ''}`}>
              Probe input: <b>{triggered ? 'TRIGGERED' : 'OPEN'}</b>
              <span className="small"> Touch the bit to the {p.kind === 'pcb' || p.kind === 'autolevel' ? 'board' : 'plate'} to test the connection: it should read TRIGGERED, then OPEN again when released.</span>
            </div>
            <div className="row end">
              <button className="btn" onClick={() => m.send({ type: 'probeCancel', id: p.id })}>Cancel</button>
              <button className="btn primary" onClick={confirm}>Yes, it is connected. Start probing</button>
            </div>
          </>
        )}

        {p.phase === 'running' && (
          <>
            <h3>PROBING…</h3>
            <div className="dlg-step">{p.step}</div>
            {p.progress && <div className="bar"><div style={{ width: `${Math.round((p.progress.current / p.progress.total) * 100)}%` }} /></div>}
            {results && <div className="mono">{results}</div>}
            <div className="muted small">Keep your hand near the stop button. The machine is moving.</div>
            <div className="row end">
              <button className="btn danger" onClick={() => m.send({ type: 'probeCancel', id: p.id })}>STOP</button>
            </div>
          </>
        )}

        {p.phase === 'confirmRemove' && (
          <>
            {p.success
              ? <div className="ok-line">Probing complete{results ? `: ${results}` : ''}</div>
              : <div className="err">Probe failed: {p.error}</div>}
            <h3>REMOVE THE PROBE NOW</h3>
            <div>{p.kind && REMOVE_TEXT[p.kind]}</div>
            {!p.success && <div className="muted small">If the machine is in alarm after you confirm, use Unlock to clear it, then check your position before continuing.</div>}
            <div className="row end">
              <button className="btn primary" onClick={confirm}>Probe removed. Continue</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------- Autolevel ----------------

const AL_FIELDS: { key: keyof AlForm; label: string; unit: 'mm' | ''; step?: string }[] = [
  { key: 'minX', label: 'X from', unit: 'mm' }, { key: 'maxX', label: 'X to', unit: 'mm' },
  { key: 'minY', label: 'Y from', unit: 'mm' }, { key: 'maxY', label: 'Y to', unit: 'mm' },
  { key: 'cols', label: 'Points in X', unit: '', step: '1' }, { key: 'rows', label: 'Points in Y', unit: '', step: '1' },
  { key: 'safeZ', label: 'Travel height above Z0', unit: 'mm' }, { key: 'depth', label: 'Max probe depth below Z0', unit: 'mm' },
  { key: 'endZ', label: 'Raise to after the scan', unit: 'mm' },
];

function HeatGrid({ map }: { map: HeightMap }) {
  const u = useUnits();
  const flat = map.z.flat();
  const lo = Math.min(...flat), hi = Math.max(...flat), span = hi - lo || 1;
  const rows = [...Array(map.rows).keys()].reverse(); // Y increases upward, like the machine
  return (
    <div className="heat" style={{ gridTemplateColumns: `repeat(${map.cols}, 1fr)` }}>
      {rows.flatMap((j) => [...Array(map.cols).keys()].map((i) => {
        const z = map.z[j][i];
        const t = (z - lo) / span;
        const x = map.minX + ((map.maxX - map.minX) * i) / (map.cols - 1);
        const y = map.minY + ((map.maxY - map.minY) * j) / (map.rows - 1);
        return (
          <div key={`${i}-${j}`} className="cell" title={`X${u.len(x, 1)} Y${u.len(y, 1)}  ${u.len(z)} ${u.lenUnit}`}
            style={{ background: `color-mix(in srgb, var(--accent) ${Math.round(t * 100)}%, var(--panel2))`, color: t > 0.55 ? 'var(--accent-text)' : 'var(--text)' }}>
            {u.len(z, 2)}
          </div>
        );
      }))}
    </div>
  );
}

function AutolevelPanel({ m }: { m: Machine }) {
  const u = useUnits();
  const [form, setForm] = useState<AlForm>(loadAlForm);
  const [loadErr, setLoadErr] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const set = (k: keyof AlForm, v: number) => {
    const next = { ...form, [k]: v };
    setForm(next);
    localStorage.setItem('alForm', JSON.stringify(next));
  };
  const j = m.job;
  const jobBusy = j.state === 'running' || j.state === 'paused';
  const ready = m.connection.connected && m.status.state === 'Idle' && m.probe.phase === 'idle' && !jobBusy;
  const hm = m.heightmap;
  const flat = hm?.z.flat() ?? [];
  const useBounds = () => {
    if (!j.bounds) return;
    const b = j.bounds, r = (n: number) => Math.round(n * 100) / 100;
    const next = { ...form, minX: r(b.minX), maxX: r(b.maxX), minY: r(b.minY), maxY: r(b.maxY) };
    setForm(next);
    localStorage.setItem('alForm', JSON.stringify(next));
  };
  const scan = () => {
    const a: AutolevelParams = { ...form };
    m.send({ type: 'probeStart', kind: 'autolevel', settings: toSettings(loadProbeForm(), 'pcb'), autolevel: a });
  };
  const load = async (f: File) => {
    try { m.send({ type: 'heightmapLoad', map: JSON.parse(await f.text()) }); setLoadErr(''); } catch { setLoadErr('That file is not a height map (invalid JSON)'); }
  };
  const points = form.cols * form.rows;

  return (
    <Panel id="autolevel" title="Autolevel" className="autolevel">
      <div className="muted small">
        Scan the board surface, then apply the height map to your G-code. The result is a new levelled program you can inspect, download and run.
      </div>
      <details open={!hm}>
        <summary className="muted small">1. Scan settings ({points} points)</summary>
        <div className="pform">
          {AL_FIELDS.map((f) => (
            <label key={f.key}>
              <span>{f.label}</span>
              <NumInput mm={form[f.key]} onMm={(v) => set(f.key, v)} kind={f.unit === 'mm' ? 'len' : 'raw'} step={f.step} />
              <span className="muted">{f.unit === 'mm' ? u.lenUnit : ''}</span>
            </label>
          ))}
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn small" disabled={!j.bounds} onClick={useBounds} title={j.bounds ? '' : 'Load a G-code file first'}>Use loaded G-code area</button>
        </div>
      </details>
      <div className="row">
        <button className="btn primary" disabled={!ready} onClick={scan}>Start scan</button>
        <span className="muted small">Work zero must be on the board surface.</span>
      </div>

      {hm && (
        <>
          <div className="muted small">
            2. Height map: {hm.cols} × {hm.rows} points, {new Date(hm.scannedAt).toLocaleString()}.
            Surface varies <b>{u.len(Math.max(...flat) - Math.min(...flat))} {u.lenUnit}</b> (low {u.len(Math.min(...flat))}, high {u.len(Math.max(...flat))}).
          </div>
          <HeatGrid map={hm} />
          <div className="row wrap">
            <a className="btn small" href="/api/heightmap.json" download="heightmap.json">Download</a>
            <button className="btn small" onClick={() => file.current?.click()}>Load…</button>
            <button className="btn small" onClick={() => m.send({ type: 'heightmapClear' })}>Clear</button>
          </div>
        </>
      )}
      {!hm && (
        <div className="row wrap">
          {m.heightmapSaved && (
            <button className="btn small" title="Only if this is the same board in the same position" onClick={() => m.send({ type: 'heightmapRestore' })}>
              Restore last scan ({m.heightmapSaved.cols} × {m.heightmapSaved.rows}, {new Date(m.heightmapSaved.scannedAt).toLocaleString()})
            </button>
          )}
          <button className="btn small" onClick={() => file.current?.click()}>Load a saved height map…</button>
        </div>
      )}
      <input ref={file} type="file" accept=".json,application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) load(f); e.target.value = ''; }} />
      {loadErr && <div className="err">{loadErr}</div>}

      <div className="row wrap">
        <button className="btn primary" disabled={!hm || j.state === 'none' || jobBusy || m.probe.phase !== 'idle' || !!j.alreadyLeveled}
          title={j.alreadyLeveled ? 'This file is already autolevelled' : ''} onClick={() => m.send({ type: 'jobLevel' })}>
          3. Apply to G-code
        </button>
        <button className="btn" disabled={!j.leveled || jobBusy} onClick={() => m.send({ type: 'jobRevert' })}>Use original</button>
        {j.leveled && <a className="btn" href="/api/job.nc" download>Download levelled G-code</a>}
      </div>
      {j.alreadyLeveled && !j.leveled && <div className="muted small">This file is already autolevelled, so it can be run as it is. To level it again, load the original program.</div>}
      {j.levelError && <div className="err">Not applied: {j.levelError}</div>}
      {j.leveled && (
        <div className="lvl">
          <div><b>{j.name}</b>: {j.leveled.linesBefore} → {j.leveled.linesAfter} lines. Z corrected by {u.len(j.leveled.minDelta)} to {u.len(j.leveled.maxDelta)} {u.lenUnit}.</div>
          {j.bounds && <div className="muted small">Program area X {u.len(j.bounds.minX, 1)} to {u.len(j.bounds.maxX, 1)}, Y {u.len(j.bounds.minY, 1)} to {u.len(j.bounds.maxY, 1)} {u.lenUnit}</div>}
          {j.leveled.warnings.map((w) => <div key={w} className="warn-line">⚠ {w}</div>)}
        </div>
      )}
    </Panel>
  );
}

// ---------------- Visualizer ----------------

function readColors(): ViewerColors {
  const css = getComputedStyle(document.documentElement);
  const v = (n: string) => css.getPropertyValue(n).trim();
  return { bg: v('--bg'), grid: v('--line'), cut: v('--accent'), done: v('--cyan'), rapid: v('--amber'), tool: v('--danger'), box: v('--muted'), map: '#a78bfa' };
}

const VIEWS: { id: ViewPreset; label: string; title: string }[] = [
  { id: 'default', label: 'Front', title: 'Straight on, tilted slightly down (X right, Y up)' },
  { id: 'top', label: 'Top', title: 'Looking straight down (X right, Y up)' },
  { id: 'right', label: 'Side', title: 'From the right-hand side, looking along X (Y across the screen)' },
  { id: 'front', label: 'End', title: 'From the front of the machine, looking along Y (X across the screen)' },
  { id: 'iso', label: 'Iso', title: 'Three-quarter view' },
];

function VisualizerPanel({ m }: { m: Machine }) {
  return (
    <Panel id="visualizer" title="Visualizer" className="viz">
      <Visualizer m={m} />
    </Panel>
  );
}

function Visualizer({ m }: { m: Machine }) {
  const u = useUnits();
  const box = useRef<HTMLDivElement>(null);
  const viewer = useRef<Viewer | null>(null);
  const loadId = useRef(0);
  const [err, setErr] = useState('');
  const [view, setView] = useState<ViewPreset>('default');
  const [zScale, setZScale] = useState(1);
  const [show, setShow] = useState({ rapids: true, map: true, tool: true, box: true });
  const [stats, setStats] = useState('');
  const [toolOut, setToolOut] = useState(false);
  const latest = useRef({ view, show });
  latest.current = { view, show };

  useEffect(() => {
    let v: Viewer;
    try { v = new Viewer(box.current!); } catch (e) { setErr(`3D view is not available in this browser: ${(e as Error).message}`); return; }
    viewer.current = v;
    v.onViewChange = () => setToolOut(v.toolInView() === false);
    v.setColors(readColors());
    v.setView('default');
    // follow the light/dark theme switch
    const mo = new MutationObserver(() => v.setColors(readColors()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] });   // (style: custom colours are set as variables there)
    return () => { mo.disconnect(); v.dispose(); viewer.current = null; };
  }, []);

  // (re)load the toolpath whenever the program that will run changes
  const key = `${m.job.name}|${m.job.totalLines}|${m.job.leveled?.scannedAt ?? ''}`;
  useEffect(() => {
    const v = viewer.current;
    if (!v) return;
    const id = ++loadId.current;
    if (!m.job.name || m.job.state === 'none') { v.setToolpath(null); setStats(''); return; }
    fetch('/api/job.nc').then((r) => r.text()).then((text) => {
      if (id !== loadId.current) return; // a newer program was loaded meanwhile
      const t0 = performance.now();
      const tp = analyzeProgram(text.split('\n'));
      v.setToolpath(tp);
      v.setView(view);
      setStats(`${(tp.cut.length / 6).toLocaleString()} cutting + ${(tp.rapid.length / 6).toLocaleString()} rapid segments (${Math.round(performance.now() - t0)} ms)`);
    }).catch(() => setStats('Could not load the program for the 3D view'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => { viewer.current?.setProgress(m.job.doneLines); }, [m.job.doneLines, key]);
  useEffect(() => {
    const v = viewer.current;
    v?.setTool(m.connection.connected ? m.status.wpos : null);
    if (v) setToolOut(v.toolInView() === false);
  }, [m.status.wpos, m.connection.connected, show.tool]);
  useEffect(() => { viewer.current?.setHeightMap(m.heightmap); }, [m.heightmap]);
  useEffect(() => { viewer.current?.setVisible(show); }, [show]);
  useEffect(() => { viewer.current?.setZScale(zScale); viewer.current?.setView(view); }, [zScale]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (p: ViewPreset) => { setView(p); viewer.current?.setView(p); };
  const toggle = (k: keyof typeof show) => setShow((s) => ({ ...s, [k]: !s[k] }));

  return (
    <>
      <div className="viz-bar">
      <div className="row wrap viz-views">
        {VIEWS.map((v) => <button key={v.id} title={v.title} className={`btn small ${view === v.id ? 'primary' : ''}`} onClick={() => pick(v.id)}>{v.label}</button>)}
        <button className="btn small" title="Frame the program and the tool together" onClick={() => viewer.current?.fitAll(view)}>Fit all</button>
      </div>
      <div className="row wrap viz-opts">
        <label className="muted small">Z stretch&nbsp;
          <select value={zScale} onChange={(e) => setZScale(Number(e.target.value))}>
            {[1, 2, 5, 10, 25, 50, 100].map((z) => <option key={z} value={z}>{z}×</option>)}
          </select>
        </label>
        {([
          ['rapids', 'Rapids', !!m.job.name, 'load a G-code file'],
          ['map', 'Height map', !!m.heightmap, 'no height map: scan or load one'],
          ['tool', 'Tool', m.connection.connected, 'not connected to the machine'],
          ['box', 'Size box', !!m.job.name, 'load a G-code file'],
        ] as const).map(([k, label, available, why]) => (
          <label key={k} className="muted small chk" title={available ? '' : `Nothing to show: ${why}`}>
            <input type="checkbox" checked={show[k]} onChange={() => toggle(k)} />{label}
            {!available && <i className="none"> (none)</i>}
          </label>
        ))}
      </div>
      </div>
      {err ? <div className="err">{err}</div> : (
        <div className="viz-wrap">
          <div className="viz-canvas" ref={box} />
          {/* an overlay, not part of the text below: a message that changes the height of the view changes what is in view, and it flickered */}
          {toolOut && (
            <div className="viz-warn" role="status">
              <span>⚠ The tool is outside this view (X {u.len(m.status.wpos.x, 1)}, Y {u.len(m.status.wpos.y, 1)}, Z {u.len(m.status.wpos.z, 1)})</span>
              <button className="btn small" onClick={() => viewer.current?.fitAll(view)}>Fit all</button>
            </div>
          )}
        </div>
      )}
      <div className="muted small">
        {m.job.name ? stats : 'Load a G-code file to see its toolpath.'} Left-drag rotates, wheel zooms, middle or right-drag pans.
        <span className="legend"> <i style={{ background: 'var(--accent)' }} /> to cut <i style={{ background: 'var(--cyan)' }} /> done <i style={{ background: 'var(--amber)' }} /> rapid <i style={{ background: 'var(--danger)' }} /> tool <i style={{ background: '#a78bfa' }} /> height map</span>
      </div>
    </>
  );
}
