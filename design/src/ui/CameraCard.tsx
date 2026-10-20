import { useEffect, useRef, useState } from 'react';

export interface CameraStatus { configured: boolean; entity: string; from: 'cnc' | 'own' | 'none'; haUrl: string; hasToken: boolean }

export async function fetchCameraStatus(): Promise<CameraStatus | null> {
  try { const r = await fetch('/api/camera/status', { cache: 'no-store' }); return r.ok ? await r.json() : null; } catch { return null; }
}

/** One picture from the camera, renewed every couple of seconds while it is on screen: a general idea of what is going on, not video */
export function CameraImage({ every = 2000, paused = false }: { every?: number; paused?: boolean }) {
  const [src, setSrc] = useState('');
  const [err, setErr] = useState('');
  const last = useRef('');
  useEffect(() => {
    if (paused) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (document.visibilityState === 'visible') {
        try {
          const r = await fetch('/api/camera.jpg', { cache: 'no-store' });
          if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `The server answered ${r.status}`);
          const url = URL.createObjectURL(await r.blob());
          if (!live) { URL.revokeObjectURL(url); return; }
          if (last.current) URL.revokeObjectURL(last.current);
          last.current = url; setSrc(url); setErr('');
        } catch (e) { if (live) setErr((e as Error).message); }
      }
      if (live) timer = setTimeout(tick, every);
    };
    void tick();
    return () => { live = false; clearTimeout(timer); if (last.current) { URL.revokeObjectURL(last.current); last.current = ''; } };
  }, [every, paused]);
  return err && !src ? <div className="warn small" role="alert">{err}</div> : (
    <div className="camera-pic">
      {src && <img src={src} alt="The laser enclosure" />}
      {err && <div className="warn small" role="alert">{err}</div>}
    </div>
  );
}

/** The Camera tab of the Laser box */
export function CameraCard({ onSetup }: { onSetup: () => void }) {
  const [status, setStatus] = useState<CameraStatus | null | undefined>(undefined);
  const [paused, setPaused] = useState(false);
  useEffect(() => { void fetchCameraStatus().then(setStatus); }, []);
  return (
    <section className="panel">
      <h2><span>Camera</span></h2>
      <div className="body">
        {status === undefined ? <p className="muted small">Looking for the camera…</p>
          : !status?.configured ? (
            <>
              <p className="muted small">{status ? 'No camera is set up yet.' : 'The DemonX Design server did not answer.'}</p>
              <button className="btn" onClick={onSetup}>Set up the camera…</button>
            </>
          ) : (
            <>
              <CameraImage paused={paused} />
              <div className="row wrap">
                <button className="btn small" onClick={() => setPaused(!paused)}>{paused ? 'Resume' : 'Pause picture'}</button>
                <button className="btn small" onClick={onSetup}>Camera setup…</button>
                <span className="muted small">{status.entity}</span>
              </div>
              <p className="muted small">A new picture every two seconds, enough to see how a long job is going.</p>
            </>
          )}
      </div>
    </section>
  );
}

/** Settings > Camera */
export function CameraSetup({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [status, setStatus] = useState<CameraStatus | null | undefined>(undefined);
  const [entity, setEntity] = useState('');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [msg, setMsg] = useState('');
  useEffect(() => { void fetchCameraStatus().then((s) => { setStatus(s); if (s) { setEntity(s.entity); setUrl(s.haUrl); } }); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const save = async () => {
    try {
      const r = await fetch('/api/camera/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entity, ...(status?.from === 'cnc' ? {} : { url, token }) }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? 'Not saved');
      setStatus(j); setToken(''); setMsg('Saved.'); onSaved();
    } catch (e) { setMsg((e as Error).message); }
  };
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Camera setup">
        <h2>Camera</h2>
        {status === undefined ? <p className="muted small">Loading…</p> : (
          <>
            <p className="muted small">A Home Assistant camera, shown as a picture every two seconds. The access token stays on the server and is never sent to a browser.</p>
            {status?.from === 'cnc'
              ? <p className="small">Home Assistant: <b>{status.haUrl}</b>, from DemonX CNC's saved setup.</p>
              : (
                <>
                  <label className="inline small">Home Assistant address <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://192.168.1.10:8123" aria-label="Home Assistant address" style={{ width: 260 }} /></label>
                  <label className="inline small">Access token <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={status?.hasToken ? 'saved (type a new one to replace it)' : 'Profile, Security, Long-lived access tokens'} aria-label="Access token" style={{ width: 260 }} /></label>
                </>
              )}
            <label className="inline small">Camera <input value={entity} onChange={(e) => setEntity(e.target.value.trim())} placeholder="camera.test_mainstream" aria-label="Camera name" style={{ width: 260 }} /></label>
          </>
        )}
        {msg && <div className="small" role="status">{msg}</div>}
        <div className="row end">
          <button className="btn" onClick={onClose}>Close</button>
          <button className="btn primary" onClick={save} disabled={status === undefined}>Save</button>
        </div>
      </div>
    </div>
  );
}
