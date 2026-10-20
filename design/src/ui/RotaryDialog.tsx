import { useEffect } from 'react';
import type { Laser } from './useLaser';
import { useRotary } from './rotaryStore';
import { NumField } from './NumField';
import { circumference, mmPerStep } from '../core/rotary';

/** Settings > Rotary setup: like LightBurn's Rotary Setup window. Kept per laser on the server. */
export function RotaryDialog({ laser, onClose }: { laser: Laser; onClose: () => void }) {
  const key = laser.state?.connection.connected ? laser.state.connection.target : '';
  const { setup, error, save } = useRotary(key);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const set = (p: Partial<typeof setup>) => save({ ...setup, ...p });
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Rotary setup">
        <h2>Rotary setup</h2>
        {!key ? (
          <p className="small">Connect to the laser first (Laser tab): the rotary settings belong to one laser.</p>
        ) : (
          <>
            <p className="small muted">For <b>{key}</b>. Kept on the computer that runs DemonX Design, so every computer sees the same settings.</p>
            <div className="menu-h small muted">Rotary type</div>
            <div className="row">
              <label className="inline"><input type="radio" name="rtype" checked={setup.type === 'chuck'} onChange={() => set({ type: 'chuck' })} /> Chuck</label>
              <label className="inline"><input type="radio" name="rtype" checked={setup.type === 'roller'} onChange={() => set({ type: 'roller' })} /> Roller</label>
            </div>
            <div className="menu-h small muted">Rotary axis</div>
            <div className="row">
              <label className="inline"><input type="radio" name="raxis" checked readOnly /> Y axis</label>
              <label className="inline muted"><input type="radio" name="raxis" disabled /> Z axis</label>
              <label className="inline muted"><input type="radio" name="raxis" disabled /> A axis</label>
            </div>
            <div className="layer-settings wide">
              <label>Steps per rotation <NumField label="Steps per rotation" value={setup.steps} min={1} max={10000000} step={100} onCommit={(v) => set({ steps: v })} /></label>
              <label>Object diameter <NumField label="Object diameter" value={setup.objectDiameter} min={0.1} max={5000} step={1} onCommit={(v) => set({ objectDiameter: v })} /><small>mm</small></label>
              {setup.type === 'roller' && <label>Roller diameter <NumField label="Roller diameter" value={setup.rollerDiameter} min={0.1} max={5000} step={1} onCommit={(v) => set({ rollerDiameter: v })} /><small>mm</small></label>}
              <label>Circumference <input aria-label="Circumference" readOnly value={circumference(setup).toFixed(3)} /><small>mm</small></label>
            </div>
            <p className="small muted">About {mmPerStep(setup).toFixed(4)} mm of the piece's surface per motor step. These are typed in by hand for now: reading them from the controller is not built yet.</p>
            <label className="inline"><input type="checkbox" checked={setup.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Enable rotary (also in the Laser panel)</label>
            <div className="notice danger" role="status"><span className="small"><b>Rotary jobs are not sent yet.</b> While rotary is on, Frame and Start are blocked: how the controller wants a rotary job (the Y scale, the switch to rotary mode) has to be confirmed from a LightBurn capture first. Switch it off to run a flat job.</span></div>
            {error && <div className="warn small" role="alert">⚠ {error}</div>}
          </>
        )}
        <div className="row end"><button className="btn primary" onClick={onClose}>Done</button></div>
      </div>
    </div>
  );
}
