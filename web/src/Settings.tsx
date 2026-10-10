import { useEffect, useRef, useState } from 'react';
import { CameraSetup } from './CameraPanel';
import { LayoutSettings } from './Dock';
import { SpindleSetup } from './SpindlePanel';
import { ControllerSettings } from './ControllerSettings';
import { PcbSettings } from './PcbPanel';
import { AccessSettings } from './Access';
import { useUnits } from './units';
import { ACCENT_PRESETS, COLOR_KEYS, DEFAULTS, LABELS, problems, type ColorKey } from '../../shared/colors';
import type { Colors, Density } from './appearance';
import type { Machine } from './useMachine';
import { StatsPage } from './Stats';
import type { SettingsPage } from './settingsContext';

// The Settings drawer. Pages are grouped by who they affect: this browser only (layout, units,
// appearance) or the whole machine, shared by every browser (camera, Home Assistant, spindle).

const GROUPS: { title: string; hint: string; pages: { id: SettingsPage; label: string }[] }[] = [
  { title: 'This browser', hint: 'Only this browser: other computers and phones keep their own', pages: [
    { id: 'layout', label: 'Layout' }, { id: 'units', label: 'Units' }, { id: 'appearance', label: 'Appearance' } ] },
  { title: 'This machine', hint: 'Shared: every browser sees the same', pages: [
    { id: 'camera', label: 'Camera' }, { id: 'homeassistant', label: 'Home Assistant' }, { id: 'spindle', label: 'Spindle' }, { id: 'pcb', label: 'PCB mode' }, { id: 'controller', label: 'Controller' }, { id: 'stats', label: 'Stats & maintenance' }, { id: 'access', label: 'Access' } ] },
];

export function SettingsDrawer({ m, page, setPage, onClose, theme, setTheme, colors, density, setDensity }: {
  m: Machine; page: SettingsPage; setPage: (p: SettingsPage) => void; onClose: () => void; theme: string; setTheme: (t: 'dark' | 'light') => void; colors: Colors; density: Density; setDensity: (d: Density) => void;
}) {
  const [saved, setSaved] = useState(false);
  // sit just under the header, so HOLD / RESUME / RESET stay reachable while Settings is open
  // (the header scrolls away with the page: then the drawer simply starts at the top of the screen)
  const headerBottom = () => Math.max(0, Math.ceil(document.querySelector('.header')?.getBoundingClientRect().bottom ?? 0));
  const [top, setTop] = useState(headerBottom);   // measured before the first paint, so it never flashes at the top of the screen
  useEffect(() => {
    const place = () => setTop(headerBottom());
    window.addEventListener('resize', place); window.addEventListener('scroll', place, { passive: true });
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place); };
  }, []);
  const timer = useRef<number>();
  const flash = () => { setSaved(true); window.clearTimeout(timer.current); timer.current = window.setTimeout(() => setSaved(false), 2500); };
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('keydown', esc); window.clearTimeout(timer.current); };
  }, [onClose]);
  useEffect(() => setSaved(false), [page]);

  return (
    <aside className="settings" role="dialog" aria-label="Settings" style={{ top }}>
      <div className="settings-head">
        <b>⚙ Settings</b>
        {saved && <span className="ok-line small">✓ Saved</span>}
        <div className="spacer" />
        <button className="btn small" onClick={onClose} aria-label="Close settings">✕</button>
      </div>
      <nav className="settings-nav">
        {GROUPS.map((g) => (
          <div key={g.title} className="settings-group">
            <div className="menu-h" title={g.hint}>{g.title}</div>
            <div className="row wrap">
              {g.pages.map((p) => <button key={p.id} className={`btn small ${p.id === page ? 'primary' : ''}`} onClick={() => setPage(p.id)}>{p.label}</button>)}
            </div>
          </div>
        ))}
      </nav>
      <div className="settings-body" key={page}>
        {page === 'layout' && <LayoutSettings />}
        {page === 'units' && <UnitsPage />}
        {page === 'appearance' && <AppearancePage theme={theme as 'dark' | 'light'} setTheme={setTheme} colors={colors} density={density} setDensity={setDensity} />}
        {page === 'camera' && <CameraSetup m={m} onClose={onClose} onSaved={flash} onGoHa={() => setPage('homeassistant')} />}
        {page === 'homeassistant' && <HomeAssistantPage m={m} onSaved={flash} />}
        {page === 'spindle' && <SpindleSetup m={m} onClose={onClose} onSaved={flash} />}
        {page === 'controller' && <ControllerSettings m={m} />}
        {page === 'access' && <AccessSettings m={m} />}
        {page === 'stats' && <StatsPage m={m} />}
        {page === 'pcb' && <PcbSettings m={m} onSaved={flash} />}
      </div>
    </aside>
  );
}

function UnitsPage() {
  const u = useUnits();
  return (
    <div className="camform">
      <div className="muted small">How lengths and feeds are shown and typed in this browser. The machine and everything saved always use millimetres, so switching never changes a value.</div>
      <label className="chk"><input type="radio" name="units" checked={u.unit === 'mm'} onChange={() => u.setUnit('mm')} />Millimetres (mm, mm/min)</label>
      <label className="chk"><input type="radio" name="units" checked={u.unit === 'in'} onChange={() => u.setUnit('in')} />Inches (in, in/min)</label>
    </div>
  );
}

function AppearancePage({ theme, setTheme, colors, density, setDensity }: { theme: 'dark' | 'light'; setTheme: (t: 'dark' | 'light') => void; colors: Colors; density: Density; setDensity: (d: Density) => void }) {
  const defaults = DEFAULTS[theme];
  const warn = problems(theme, colors.chosen);
  const hex = (k: ColorKey) => colors.chosen[k] ?? defaults[k];
  const row = (k: ColorKey) => (
    <label key={k} className="color-row">
      <span>{LABELS[k]}</span>
      <input type="color" aria-label={LABELS[k]} value={hex(k)} onChange={(e) => colors.set(k, e.target.value)} />
      <code>{hex(k)}</code>
      <button type="button" className="btn small" disabled={!(k in colors.chosen)} title="Back to the built-in colour" onClick={() => colors.set(k, undefined)}>Reset</button>
    </label>
  );
  return (
    <div className="camform">
      <div className="muted small">Light or dark, and the colours, for this browser only. The dark and the light theme each keep their own colours.</div>
      <label className="chk"><input type="radio" name="theme" checked={theme === 'dark'} onChange={() => setTheme('dark')} />Dark</label>
      <label className="chk"><input type="radio" name="theme" checked={theme === 'light'} onChange={() => setTheme('light')} />Light</label>

      <div className="menu-h">Size of buttons and fields</div>
      <label className="chk"><input type="radio" name="density" checked={density === 'comfortable'} onChange={() => setDensity('comfortable')} />Comfortable (larger, easier to hit on a touch screen)</label>
      <label className="chk"><input type="radio" name="density" checked={density === 'compact'} onChange={() => setDensity('compact')} />Compact (smaller, more fits on screen)</label>

      <div className="menu-h">Accent colour</div>
      <div className="swatches" role="group" aria-label="Accent colour">
        {ACCENT_PRESETS.map((p) => {
          const c = theme === 'dark' ? p.dark : p.light;
          const on = hex('accent').toLowerCase() === c.toLowerCase();
          return <button key={p.name} type="button" className={`swatch ${on ? 'on' : ''}`} style={{ background: c }} title={p.name} aria-label={p.name} aria-pressed={on}
            onClick={() => (p.name === 'Green' ? colors.set('accent', undefined) : colors.set('accent', c))} />;
        })}
      </div>

      <details open={Object.keys(colors.chosen).some((k) => k !== 'accent')}>
        <summary className="muted small">Choose each colour</summary>
        <div className="color-rows">{COLOR_KEYS.map(row)}</div>
      </details>
      {warn.map((w) => <div key={w} className="warn-line">⚠ {w}</div>)}
      <div className="row wrap">
        <button type="button" className="btn small" disabled={!Object.keys(colors.chosen).length} onClick={colors.reset}>Reset to the built-in colours</button>
      </div>
    </div>
  );
}

/** Where DemonX finds Home Assistant. Used by the camera now, and by the integration later. */
function HomeAssistantPage({ m, onSaved }: { m: Machine; onSaved: () => void }) {
  const ha = m.config.homeAssistant;
  const [url, setUrl] = useState(ha.url);
  const [insecure, setInsecure] = useState(ha.insecureTls);
  const [share, setShare] = useState(ha.share);
  const [shareMsg, setShareMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const seenShare = useRef(m.replies.haShareResult?.n ?? 0);
  const sr = m.replies.haShareResult;
  useEffect(() => {
    if (!sr || sr.n === seenShare.current) return;
    seenShare.current = sr.n; setShareMsg({ ok: sr.data.ok, text: sr.data.message });
  }, [sr]);
  const [token, setToken] = useState('');
  const [clearToken, setClearToken] = useState(false);
  const [err, setErr] = useState('');
  const [testing, setTesting] = useState(false);
  const seenSave = useRef(m.replies.configResult?.n ?? 0);
  const seenList = useRef(m.replies.haCameras?.n ?? 0);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const cr = m.replies.configResult, hc = m.replies.haCameras;
  useEffect(() => {
    if (!cr || cr.n === seenSave.current) return;
    seenSave.current = cr.n;
    if (cr.data.ok) { setToken(''); setClearToken(false); onSaved(); } else setErr(cr.data.message ?? 'Not saved');
  }, [cr]);
  useEffect(() => {
    if (!hc || hc.n === seenList.current) return;
    seenList.current = hc.n; setTesting(false);
    setResult('error' in hc.data ? { ok: false, text: hc.data.error } : { ok: true, text: `Connected: ${hc.data.cameras.length} camera${hc.data.cameras.length === 1 ? '' : 's'} found` });
  }, [hc]);
  const hasToken = ha.hasToken && !clearToken;
  const change = { url, insecureTls: insecure, share, ...(token ? { token } : clearToken ? { token: '' } : {}) };
  return (
    <div className="camform">
      <div className="muted small">Used for Home Assistant cameras now, and for sharing the machine with Home Assistant later.</div>
      <label><span>Home Assistant address</span><input value={url} placeholder="http://homeassistant.local:8123" onChange={(e) => setUrl(e.target.value)} /><span /></label>
      <label>
        <span>Access token{hasToken && !token && <span className="muted small"> (saved)</span>}</span>
        <input type="password" autoComplete="new-password" value={token} placeholder={hasToken ? 'leave empty to keep' : ''} onChange={(e) => setToken(e.target.value)} />
        {hasToken && !token ? <button type="button" className="btn small" onClick={() => setClearToken(true)}>Remove</button> : <span />}
      </label>
      <div className="muted small">In Home Assistant: your profile, Security, Long-lived access tokens, Create token. It stays on the DemonX computer and is never sent to a browser.</div>
      <label className="chk"><input type="checkbox" checked={insecure} onChange={(e) => setInsecure(e.target.checked)} />Accept a self-signed certificate</label>
      <label className="chk"><input type="checkbox" checked={share} onChange={(e) => setShare(e.target.checked)} />Tell Home Assistant what the machine is doing</label>
      <div className="muted small">
        Fires events an automation can trigger on: <code>demonx_job_started</code>, <code>demonx_job_finished</code>, <code>demonx_job_failed</code>, <code>demonx_job_paused</code>, <code>demonx_job_stopped</code>, <code>demonx_alarm</code>, <code>demonx_probe_waiting</code>, <code>demonx_connected</code>. Save first, then press Send test.
      </div>
      {shareMsg && <div className={shareMsg.ok ? 'ok-line' : 'warn-line'}>{shareMsg.ok ? '✓ ' : '⚠ '}{shareMsg.text}</div>}
      {result && <div className={result.ok ? 'ok-line' : 'warn-line'}>{result.ok ? '✓ ' : '⚠ '}{result.text}</div>}
      {err && <div className="err">{err}</div>}
      <div className="row wrap">
        <button className="btn small" disabled={testing} title="Try these details (unsaved) by asking Home Assistant for its cameras"
          onClick={() => { setTesting(true); setResult(null); m.send({ type: 'haCameras', homeAssistant: change }); }}>{testing ? 'Testing…' : 'Test connection'}</button>
        <button className="btn small" title="Fire a demonx_test event, using the saved details" onClick={() => { setShareMsg(null); m.send({ type: 'haShareTest' }); }}>Send test</button>
        <button className="btn small primary" onClick={() => { setErr(''); m.send({ type: 'configSet', update: { homeAssistant: change } }); }}>Save</button>
      </div>
      <hr />
      <MqttSection m={m} onSaved={onSaved} />
    </div>
  );
}

/** The machine as a Home Assistant device, through the MQTT broker Home Assistant already uses */
function MqttSection({ m, onSaved }: { m: Machine; onSaved: () => void }) {
  const q = m.config.mqtt;
  const [enabled, setEnabled] = useState(q.enabled);
  const [host, setHost] = useState(q.host);
  const [port, setPort] = useState(String(q.port));
  const [user, setUser] = useState(q.user);
  const [password, setPassword] = useState('');
  const [clearPw, setClearPw] = useState(false);
  const [name, setName] = useState(q.name);
  const [err, setErr] = useState('');
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const seenSave = useRef(m.replies.configResult?.n ?? 0);
  const seenTest = useRef(m.replies.mqttResult?.n ?? 0);
  const pending = useRef(false);
  const cr = m.replies.configResult, tr = m.replies.mqttResult;
  useEffect(() => {
    if (!cr || cr.n === seenSave.current) return;
    seenSave.current = cr.n;
    if (!pending.current) return;
    pending.current = false;
    if (cr.data.ok) { setPassword(''); setClearPw(false); onSaved(); } else setErr(cr.data.message ?? 'Not saved');
  }, [cr]);
  useEffect(() => {
    if (!tr || tr.n === seenTest.current) return;
    seenTest.current = tr.n; setTesting(false); setResult({ ok: tr.data.ok, text: tr.data.message });
  }, [tr]);
  const hasPw = q.hasPassword && !clearPw;
  const change = { enabled, host, port: Number(port), user, name, ...(password ? { password } : clearPw ? { password: '' } : {}) };
  return (
    <div className="camform">
      <b>Home Assistant device (MQTT)</b>
      <div className="muted small">
        Shares the machine as a device with its own sensors (state, X Y Z, feed, spindle, job progress, elapsed and remaining time, alarm, hold...) and buttons for Home, Unlock, Reset, Feed Hold, Resume and Stop. It uses the MQTT broker Home Assistant already uses (the Mosquitto add-on); Home Assistant finds the device by itself. Nothing else can be controlled from there: no jogging, probing or starting a job.
      </div>
      <label className="chk"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />Share this machine through MQTT</label>
      <label><span>Device name</span><input value={name} placeholder="Cubiko" maxLength={30} onChange={(e) => setName(e.target.value)} /><span /></label>
      <div className="muted small">Becomes the start of every entity name in Home Assistant (a device called Cubiko gives sensor.cubiko_machine_state). Change it later and the old entities are removed.</div>
      <label><span>Broker address</span><input value={host} placeholder="10.20.30.50" onChange={(e) => setHost(e.target.value)} /><span /></label>
      <label><span>Port</span><input inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value)} /><span /></label>
      <label><span>User name</span><input autoComplete="off" value={user} onChange={(e) => setUser(e.target.value)} /><span /></label>
      <label>
        <span>Password{hasPw && !password && <span className="muted small"> (saved)</span>}</span>
        <input type="password" autoComplete="new-password" value={password} placeholder={hasPw ? 'leave empty to keep' : ''} onChange={(e) => setPassword(e.target.value)} />
        {hasPw && !password ? <button type="button" className="btn small" onClick={() => setClearPw(true)}>Remove</button> : <span />}
      </label>
      {result && <div className={result.ok ? 'ok-line' : 'warn-line'}>{result.ok ? '✓ ' : '⚠ '}{result.text}</div>}
      {err && <div className="err">{err}</div>}
      <div className="row wrap">
        <button className="btn small" disabled={testing} title="Try these details (unsaved) by connecting to the broker"
          onClick={() => { setTesting(true); setResult(null); m.send({ type: 'mqttTest', mqtt: { host, port: Number(port), user, ...(password ? { password } : clearPw ? { password: '' } : {}) } }); }}>{testing ? 'Testing…' : 'Test connection'}</button>
        <button className="btn small primary" onClick={() => { setErr(''); pending.current = true; m.send({ type: 'configSet', update: { mqtt: change } }); }}>Save</button>
      </div>
    </div>
  );
}
