import { useEffect, useState } from 'react';
import type { Doc, Machine } from '../core/types';
import { LASER_PRESETS } from '../core/types';
import type { Laser } from './useLaser';
import { NumField } from './NumField';
import { setDeviceOrigin, allLasers, saveDevices, useDevices } from './devices';

type Run = (id: string, args: unknown, echo?: boolean) => boolean;

/** Settings > Laser setup: the lasers this computer knows (size, power scale) and the network lasers (Ruida) the server can reach */
export function LaserSetup({ doc, run, laser, onClose }: { doc: Doc; run: Run; laser: Laser; onClose: () => void }) {
  const saved = useDevices();
  const list = allLasers(saved);
  const builtIn = (name: string) => LASER_PRESETS.some((p) => p.name === name) && !saved.some((d) => d.name === name);
  const [draft, setDraft] = useState<Machine>({ name: '', width: 600, height: 400, sMax: 1000, rapid: 100 });
  const [netName, setNetName] = useState('');
  const [netHost, setNetHost] = useState('');
  const net = laser.ports.filter((p) => p.path.startsWith('ruida:'));
  const ruidaOffered = laser.ports.some((p) => p.path.startsWith('ruida'));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    if (laser.online) laser.send({ type: 'listPorts' });
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const add = () => {
    const name = draft.name.trim();
    if (!name || !(draft.width > 0 && draft.height > 0 && draft.sMax > 0)) return;
    saveDevices([...saved.filter((d) => d.name !== name), { ...draft, name }]);
    setDraft({ ...draft, name: '' });
  };
  const remove = (name: string) => saveDevices(saved.filter((d) => d.name !== name));

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide" role="dialog" aria-modal="true" aria-label="Laser setup">
        <h2>Laser setup</h2>

        <h3 className="sub">Lasers</h3>
        <p className="muted small">The work area is the laser's bed. S max is the controller's full-power value ($30 on GRBL). Pick the laser for this design on the Laser tab.</p>
        <div className="devtable" role="table" aria-label="Lasers">
          {list.map((d) => (
            <div key={d.name} role="row" className={'devrow' + (doc.machine.name === d.name ? ' active' : '')}>
              <span className="devname">{d.name}{doc.machine.name === d.name && <small className="ok"> · used by this design</small>}</span>
              <span className="mono small">{d.width} × {d.height} mm · S{d.sMax}</span>
              <span className="row small" role="radiogroup" aria-label={`0,0 of ${d.name}`}>
                {([['tl', 'Top-left'], ['bl', 'Bottom-left']] as const).map(([v, t]) => (
                  <label key={v} className="inline" title="Where 0,0 is: the rulers and the Y box start here"><input type="radio" name={`origin-${d.name}`} checked={(d.origin ?? 'tl') === v} onChange={() => { setDeviceOrigin(d, v); if (doc.machine.name === d.name) run('machine_set', { origin: v }, false); }} /> {t}</label>
                ))}
              </span>
              <button className="btn small" onClick={() => run('machine_set', { name: d.name, width: d.width, height: d.height, sMax: d.sMax, rapid: d.rapid, origin: d.origin ?? 'tl' }, false)} disabled={doc.machine.name === d.name}>Use</button>
              {builtIn(d.name) ? <span className="muted small">built in</span> : <button className="btn small danger" onClick={() => remove(d.name)} aria-label={`Remove ${d.name}`}>Remove</button>}
            </div>
          ))}
        </div>
        <div className="row wrap" role="group" aria-label="Add a laser">
          <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Name, e.g. Pronto 45" aria-label="New laser name" style={{ width: 170 }} />
          <label className="inline small">W <NumField label="New laser width" value={draft.width} min={1} step={10} onCommit={(v) => setDraft({ ...draft, width: v })} width={70} /></label>
          <label className="inline small">H <NumField label="New laser height" value={draft.height} min={1} step={10} onCommit={(v) => setDraft({ ...draft, height: v })} width={70} /></label>
          <label className="inline small">S max <NumField label="New laser S max" value={draft.sMax} min={1} step={1} onCommit={(v) => setDraft({ ...draft, sMax: v })} width={70} /></label>
          <span className="row small" role="radiogroup" aria-label="0,0 of the new laser">
            {([['tl', 'Top-left'], ['bl', 'Bottom-left']] as const).map(([v, t]) => (
              <label key={v} className="inline"><input type="radio" name="new-origin" checked={(draft.origin ?? 'tl') === v} onChange={() => setDraft({ ...draft, origin: v })} /> {t}</label>
            ))}
          </span>
          <button className="btn small primary" disabled={!draft.name.trim()} onClick={add}>Add laser</button>
        </div>

        <h3 className="sub">Network lasers (Ruida)</h3>
        {!laser.online ? (
          <p className="muted small">These need the DemonX Design server (<code>npm run serve</code>).</p>
        ) : !ruidaOffered ? (
          <p className="muted small">Ruida support is off. Start the server with <code>DESIGN_RUIDA=1</code> to turn it on (it has only been tried on one machine).</p>
        ) : (
          <>
            {net.length === 0 && <p className="muted small">No Ruida laser added yet.</p>}
            <div className="devtable" role="table" aria-label="Ruida lasers">
              {net.map((p) => (
                <div key={p.path} role="row" className="devrow">
                  <span className="devname">{p.path.slice(6)}</span>
                  <span className="mono small">{/ at ([\d.]+)/.exec(p.description ?? '')?.[1] ?? ''}</span>
                  <span />
                  <button className="btn small danger" onClick={() => laser.send({ type: 'ruidaRemove', name: p.path.slice(6) })} aria-label={`Forget ${p.path.slice(6)}`}>Forget</button>
                </div>
              ))}
            </div>
            <div className="row wrap" role="group" aria-label="Add a Ruida laser">
              <input value={netName} onChange={(e) => setNetName(e.target.value)} placeholder="Name" aria-label="Ruida laser name" style={{ width: 130 }} maxLength={30} />
              <input value={netHost} onChange={(e) => setNetHost(e.target.value)} placeholder="Address, e.g. 192.168.1.50" aria-label="Ruida laser address" inputMode="decimal" style={{ width: 190 }} />
              <button className="btn small primary" disabled={!netName.trim() || !netHost.trim()} onClick={() => { laser.send({ type: 'ruidaAdd', name: netName.trim(), host: netHost.trim() }); setNetName(''); setNetHost(''); }}>Add Ruida laser</button>
            </div>
            <p className="muted small">The address is the one LightBurn shows for the laser. It must be on your own network and is kept on the computer running the server.</p>
            {laser.notice && !laser.notice.ok && <div className="warn small" role="alert">⚠ {laser.notice.message}</div>}
          </>
        )}

        <div className="row end"><button className="btn primary" onClick={onClose}>Done</button></div>
      </div>
    </div>
  );
}
