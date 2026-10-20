import { useEffect, useState } from 'react';
import type { Laser } from './useLaser';

async function post(path: string, body: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    return r.ok ? { ok: true } : { ok: false, error: j.error ?? 'Not allowed' };
  } catch { return { ok: false, error: 'Could not reach the DemonX Design server' }; }
}

/** Settings > Access: sign in with the PIN to control the laser from another computer, or set the PIN on the computer that runs the server. */
export function AccessDialog({ laser, onClose }: { laser: Laser; onClose: () => void }) {
  const role = laser.role;
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [code, setCode] = useState('');
  const [remember, setRemember] = useState(true);
  const [msg, setMsg] = useState('');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const done = (r: { ok: boolean; error?: string }, text: string) => { setMsg(r.ok ? text : r.error ?? 'Something went wrong'); if (r.ok) { setPin(''); setPin2(''); } };
  const mode = role?.mode ?? 'setup';
  const operator = !!role?.operator;
  const local = role?.peer === 'local';

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Access">
        <h2>Access</h2>
        {!laser.online || !role ? <p className="muted small">Not connected to the DemonX Design server.</p> : (
          <>
            <p className="small">
              {operator ? <b>You can control the laser from this browser.</b> : <b>This browser can only watch.</b>}{' '}
              {local ? 'It is on the computer that runs the server.' : role.peer === 'lan' ? 'It is on the home network.' : ''}
            </p>
            {mode === 'pin' && !operator && (
              <form className="row wrap" onSubmit={async (e) => { e.preventDefault(); done(await post('/api/auth/login', { pin, remember }), 'Signed in.'); }}>
                <input type="password" autoFocus value={pin} onChange={(e) => setPin(e.target.value)} aria-label="PIN" placeholder="PIN" />
                <label className="inline small"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Remember this device</label>
                <button className="btn primary" type="submit" disabled={pin.length < 4}>Sign in</button>
              </form>
            )}
            {mode === 'pin' && operator && !local && <div className="row"><button className="btn" onClick={async () => done(await post('/api/auth/logout', {}), 'Signed out.')}>Sign out</button></div>}
            {mode !== 'pin' && <p className="muted small">No PIN is set, so other computers can only watch. {local ? 'Set one here to let them control the laser.' : 'Set the first PIN on the computer that runs the server, or enter the setup code it prints.'}</p>}
            {mode !== 'pin' ? (
              <form className="devtable" onSubmit={async (e) => { e.preventDefault(); if (pin !== pin2) { setMsg('The two PINs are not the same.'); return; } done(await post('/api/auth/set-pin', { pin, code }), 'PIN set. You are signed in.'); }}>
                <label className="inline small">New PIN <input type="password" value={pin} onChange={(e) => setPin(e.target.value)} aria-label="New PIN" /></label>
                <label className="inline small">Again <input type="password" value={pin2} onChange={(e) => setPin2(e.target.value)} aria-label="New PIN again" /></label>
                {!local && <label className="inline small">Setup code <input value={code} onChange={(e) => setCode(e.target.value)} aria-label="Setup code" placeholder="1234-5678" /></label>}
                <div className="row"><button className="btn primary" type="submit" disabled={pin.length < 4}>Set PIN</button></div>
              </form>
            ) : null}
            {mode === 'pin' && operator && (
              <details>
                <summary className="small">Change or remove the PIN</summary>
                <form className="devtable" onSubmit={async (e) => { e.preventDefault(); if (pin !== pin2) { setMsg('The two PINs are not the same.'); return; } done(await post('/api/auth/set-pin', { pin }), 'PIN changed. Other browsers are signed out.'); }}>
                  <label className="inline small">New PIN <input type="password" value={pin} onChange={(e) => setPin(e.target.value)} aria-label="New PIN" /></label>
                  <label className="inline small">Again <input type="password" value={pin2} onChange={(e) => setPin2(e.target.value)} aria-label="New PIN again" /></label>
                  <div className="row"><button className="btn" type="submit" disabled={pin.length < 4}>Change PIN</button>
                    <button className="btn danger" type="button" onClick={async () => { if (window.confirm('Remove the PIN? Other computers will only be able to watch.')) done(await post('/api/auth/clear-pin', {}), 'PIN removed.'); }}>Remove PIN</button></div>
                </form>
              </details>
            )}
          </>
        )}
        {msg && <div className="small" role="status">{msg}</div>}
        <div className="row end"><button className="btn primary" onClick={onClose}>Done</button></div>
      </div>
    </div>
  );
}
