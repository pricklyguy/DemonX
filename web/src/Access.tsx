import { useEffect, useMemo, useState } from 'react';
import qrcode from 'qrcode-generator';
import type { Machine } from './useMachine';

// Sign-in for a machine that has a PIN, and the Settings page that sets it. The server decides who may do
// what; this only asks for the PIN and shows which side of the line this browser is on.

async function post(path: string, body: object): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (r.ok) return { ok: true };
    return { ok: false, error: j.error ? `${j.error}${j.retryAfterSec ? ` (${j.retryAfterSec} s)` : ''}` : `Failed (${r.status})` };
  } catch { return { ok: false, error: 'Could not reach the server' }; }
}

// The server closes every connection when access changes, and this browser reconnects with its new role
const reload = () => window.location.reload();

/** Ask the server to set the first PIN (with the setup code when not on the DemonX computer) or to run without one */
function useSetup() {
  const [pin, setPin] = useState('');
  const [again, setAgain] = useState('');
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async (path: string, body: object) => {
    setBusy(true); setErr('');
    const r = await post(path, body);
    setBusy(false);
    if (r.ok) reload(); else setErr(r.error ?? 'Failed');
  };
  const setFirstPin = (withCode: boolean) => (pin === again ? go('/api/auth/set-pin', withCode ? { pin, code } : { pin }) : void setErr('The two PINs are not the same'));
  return { pin, setPin, again, setAgain, code, setCode, err, busy, go, setFirstPin };
}

/** The strip under the header: sign in, set the first PIN, or explain why this browser can only watch */
export function ViewOnlyBar({ m }: { m: Machine }) {
  const [pin, setPin] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [remember, setRemember] = useState(true);
  const setup = useSetup();
  if (!m.online) return null;
  const { mode, operator, peer } = m.auth;

  if (mode === 'pin' && !operator) {
    const go = async () => {
      setBusy(true); setErr('');
      const r = await post('/api/auth/login', { pin, remember });
      setBusy(false);
      if (r.ok) reload(); else setErr(r.error ?? 'Not signed in');
    };
    return (
      <form className="viewonly row wrap" onSubmit={(e) => { e.preventDefault(); void go(); }}>
        <b>🔒 View only.</b>
        <span className="muted">Enter the PIN to control the machine.</span>
        <input type="password" autoComplete="current-password" aria-label="PIN" placeholder="PIN" value={pin} onChange={(e) => setPin(e.target.value)} />
        <button className="btn primary small" disabled={busy || !pin}>Sign in</button>
        <label className="chk" title="Stay signed in on this browser for 90 days, even after DemonX restarts. Do not tick it on a shared computer."><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />Remember this device</label>
        {err && <span className="err">{err}</span>}
      </form>
    );
  }

  if (mode === 'setup' && operator) {
    // the browser on the DemonX computer itself: set the first PIN here
    return (
      <form className="viewonly row wrap" onSubmit={(e) => { e.preventDefault(); void setup.setFirstPin(false); }}>
        <b>🔐 Set a PIN.</b>
        <span className="muted">Until you do, other devices can only watch the machine.</span>
        <input type="password" autoComplete="new-password" aria-label="New PIN" placeholder="PIN (4+ characters)" value={setup.pin} onChange={(e) => setup.setPin(e.target.value)} />
        <input type="password" autoComplete="new-password" aria-label="Repeat the PIN" placeholder="Repeat it" value={setup.again} onChange={(e) => setup.setAgain(e.target.value)} />
        <button className="btn primary small" disabled={setup.busy || !setup.pin}>Set PIN</button>
        <button type="button" className="btn small" disabled={setup.busy} title="Browsers on your home network can then control the machine without a PIN"
          onClick={() => { if (window.confirm('Run without a PIN? Any browser on your home network will be able to control the machine. (Browsers outside your network, and VPNs such as Tailscale, can still only watch.)')) void setup.go('/api/auth/open', {}); }}>Run without a PIN</button>
        {setup.err && <span className="err">{setup.err}</span>}
      </form>
    );
  }

  if (mode === 'setup') {
    // another device: the first PIN needs the setup code shown on the DemonX computer
    return (
      <form className="viewonly row wrap" onSubmit={(e) => { e.preventDefault(); void setup.setFirstPin(true); }}>
        <b>🔒 View only: this machine has no PIN yet.</b>
        <span className="muted">To set one from here, enter the setup code shown in the DemonX window on the DemonX computer (on a Raspberry Pi: run <code>pm2 logs demonx</code>).</span>
        <input inputMode="numeric" autoComplete="off" aria-label="Setup code" placeholder="Setup code" value={setup.code} onChange={(e) => setup.setCode(e.target.value)} />
        <input type="password" autoComplete="new-password" aria-label="New PIN" placeholder="Choose a PIN (4+)" value={setup.pin} onChange={(e) => setup.setPin(e.target.value)} />
        <input type="password" autoComplete="new-password" aria-label="Repeat the PIN" placeholder="Repeat it" value={setup.again} onChange={(e) => setup.setAgain(e.target.value)} />
        <button className="btn primary small" disabled={setup.busy || !setup.pin || !setup.code}>Set PIN</button>
        {setup.err && <span className="err">{setup.err}</span>}
      </form>
    );
  }

  if (mode === 'open' && !operator && peer === 'outside') {
    return (
      <div className="viewonly row wrap">
        <b>🔒 View only.</b>
        <span className="muted">You are outside the home network (or on a VPN such as Tailscale), and this machine has no PIN. Whoever runs DemonX can set one (Settings, Access, on the DemonX computer) to allow control from here.</span>
      </div>
    );
  }
  return null;
}

/** A QR code for an address: a phone camera opens it. Always dark on white with a quiet margin, so it scans in either theme. */
function Qr({ url }: { url: string }) {
  const svg = useMemo(() => {
    const q = qrcode(0, 'M');   // type 0: the smallest that fits
    q.addData(url);
    q.make();
    return q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  }, [url]);
  return <div className="qr" role="img" aria-label={`QR code for ${url}`} dangerouslySetInnerHTML={{ __html: svg }} />;
}

/** What kind of network an address is on, where it can be told from the number alone */
function kindOf(url: string): string {
  const ip = /\/\/([\d.]+):/.exec(url)?.[1] ?? '';
  const [a, b] = ip.split('.').map(Number);
  if (a === 100 && b >= 64 && b <= 127) return 'Tailscale or another VPN: works from your other devices on that VPN, also away from home';
  if (a === 192 && b === 168) return 'home or office network';
  if (a === 10) return 'home or office network';
  if (a === 172 && b >= 16 && b <= 31) return 'home or office network (or a virtual adapter)';
  return '';
}

/** Where a phone or another computer can open DemonX: this computer's network addresses */
export function OpenFromElsewhere({ m, heading = true }: { m: Machine; heading?: boolean }) {
  const [copied, setCopied] = useState('');
  const [picked, setPicked] = useState('');
  const shown = m.addresses.includes(picked) ? picked : m.addresses[0];
  const here = window.location.hostname;
  const isLocalName = here === 'localhost' || here === '127.0.0.1' || here === '[::1]';
  const copy = (u: string) => { void navigator.clipboard?.writeText(u).then(() => { setCopied(u); window.setTimeout(() => setCopied(''), 2000); }, () => undefined); };
  return (
    <div className="camform">
      {heading && <b>Open DemonX from a phone or another computer</b>}
      {m.addresses.length === 0
        ? <div className="muted small">This computer does not seem to be on a network. Connect it by cable or Wi-Fi, then reopen this page.</div>
        : <>
            <div className="muted small">Type one of these in that device's browser (it must be on the same network{isLocalName ? '' : ', as this computer'}). If the first does not work, try the next: a computer can have several network cards.</div>
            {m.addresses.map((u) => (
              <div className="row wrap" key={u}>
                <code>{u}</code>
                <button type="button" className="btn small" onClick={() => copy(u)}>{copied === u ? 'Copied' : 'Copy'}</button>
                {m.addresses.length > 1 && <button type="button" className={`btn small ${u === shown ? 'primary' : ''}`} aria-pressed={u === shown} onClick={() => setPicked(u)}>QR code</button>}
                {m.addresses.length > 1 && kindOf(u) && <span className="muted small addr-kind">{kindOf(u)}</span>}
              </div>
            ))}
            <div className="muted small">Or point a phone's camera at this code (it is for {shown}):</div>
            <Qr url={shown} />
          </>}
    </div>
  );
}

/** The header's phone button opens this: the address and QR code, for a quick scan from a phone */
export function PhoneDialog({ m, onClose }: { m: Machine; onClose: () => void }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);
  return (
    <div className="overlay phone-overlay" onClick={onClose}>
      <div className="dialog dlg-accent" role="dialog" aria-modal="true" aria-label="Open DemonX on a phone" onClick={(e) => e.stopPropagation()}>
        <div className="row"><div className="dlg-kind">Open DemonX on a phone</div><div className="spacer" /><button className="btn small" onClick={onClose} aria-label="Close">✕</button></div>
        <OpenFromElsewhere m={m} heading={false} />
        <div className="muted small">A phone controls the machine only after it enters the PIN (Settings, Access), once one is set.</div>
      </div>
    </div>
  );
}

/** Settings page: set, change or remove the PIN, and sign out */
export function AccessSettings({ m }: { m: Machine }) {
  const [pin, setPin] = useState('');
  const [again, setAgain] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const { required, operator, local, mode } = m.auth;

  const run = async (path: string, body: object) => {
    setBusy(true); setErr('');
    const r = await post(path, body);
    setBusy(false);
    if (r.ok) reload(); else setErr(r.error ?? 'Failed');
  };

  if (!operator) {
    return <><OpenFromElsewhere m={m} /><div className="warn-line">⚠ {mode === 'setup'
      ? 'This machine has no PIN yet. Set one with the bar at the top of the page (it needs the setup code shown on the DemonX computer).'
      : mode === 'pin' ? 'Sign in (the bar at the top of the page) to change who can control this machine.'
      : 'You are outside the home network, so this browser can only watch. Change this on the DemonX computer.'}</div></>;
  }
  return (
    <>
    <OpenFromElsewhere m={m} />
    <div className="camform">
      <div className="muted small">
        {mode === 'pin' && 'A PIN is set. A browser that has not entered it can watch the machine but not control it, change settings or download controller backups.'}
        {mode === 'open' && 'You chose to run without a PIN: any browser on your home network can control this machine, answer the probe dialogs and change its settings. Browsers outside your network, and VPNs such as Tailscale, can only watch. Set a PIN to require it everywhere.'}
        {mode === 'setup' && 'No PIN yet. Until one is set, other devices can only watch the machine. Set one now (or choose to run without one).'}
        {' '}The computer that runs DemonX never needs the PIN{local ? ' (this is it)' : ''}.
      </div>
      <label><span>{required ? 'New PIN' : 'PIN'}</span><input type="password" autoComplete="new-password" value={pin} placeholder="at least 4 characters" onChange={(e) => setPin(e.target.value)} /><span /></label>
      <label><span>Repeat it</span><input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} /><span /></label>
      {err && <div className="err">{err}</div>}
      <div className="row wrap">
        <button className="btn small primary" disabled={busy || !pin}
          onClick={() => (pin === again ? void run('/api/auth/set-pin', { pin }) : setErr('The two PINs are not the same'))}>{required ? 'Change PIN' : 'Set PIN'}</button>
        {required && !local && <button className="btn small" disabled={busy} onClick={() => void run('/api/auth/logout', {})}>Sign out</button>}
        {required && <button className="btn small danger" disabled={busy}
          onClick={() => { if (window.confirm('Remove the PIN? Any browser on your home network will be able to control the machine without one.')) void run('/api/auth/clear-pin', {}); }}>Remove PIN</button>}
        {mode === 'setup' && <button className="btn small" disabled={busy}
          onClick={() => { if (window.confirm('Run without a PIN? Any browser on your home network will be able to control the machine.')) void run('/api/auth/open', {}); }}>Run without a PIN</button>}
      </div>
      <div className="muted small">Forgot the PIN? On the computer that runs DemonX, run <code>npm run set-pin</code> (the Windows package has <code>Set PIN.bat</code>), or delete <code>data/auth.json</code> and restart DemonX.</div>
    </div>
    </>
  );
}
