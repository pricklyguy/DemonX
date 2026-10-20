import { useEffect, useRef, useState } from 'react';
import type { Anchor } from '../core/geom';
import type { Machine } from '../core/types';
import { Icon } from './icons';
import { NumField } from './NumField';
import { saveDevices, useDevices } from './devices';
import { DATUM_CHOICES, loadCanvasSetups, loadCncSetups, loadLastJob, saveCanvasSetups, saveCncSetups, saveLastJob, type CanvasSetup, type CncSetup, type LastJob } from './setups';

const POSITION_NAMES: Record<string, string> = { tl: 'top-left', tc: 'top-centre', tr: 'top-right', ml: 'left-middle', c: 'centre', mr: 'right-middle', bl: 'bottom-left', bc: 'bottom-centre', br: 'bottom-right' };
const GRID: Anchor[] = ['tl', 'tc', 'tr', 'ml', 'c', 'mr', 'bl', 'bc', 'br'];

type Kind = 'laser' | 'cnc' | 'canvas';
type Picked = { kind: 'laser'; item: Machine } | { kind: 'cnc'; item: CncSetup } | { kind: 'canvas'; item: CanvasSetup };

/** The arguments for `new_project` from a saved setup */
function argsOf(p: Picked): Record<string, unknown> {
  if (p.kind === 'laser') return { kind: 'laser', width: p.item.width, height: p.item.height, machine: { name: p.item.name, sMax: p.item.sMax, rapid: p.item.rapid, ...(p.item.origin ? { origin: p.item.origin } : {}) } };
  if (p.kind === 'cnc') return { kind: 'cnc', width: p.item.width, height: p.item.height, thickness: p.item.thickness, datum: p.item.datum, zZero: p.item.zZero, sides: p.item.sides };
  return { kind: 'canvas', width: p.item.width, height: p.item.height };
}

/**
 * The New design dialog: the setups you have saved (lasers, CNC, canvases), each kind in a list that opens and closes, and Setup new job,
 * where you give the size, say what the design is for and, if you like, save it. Nothing here is a made-up placeholder: only lasers that
 * were added and setups that were saved are listed.
 */
export function NewDesignDialog({ onApply, onCancel, replaces = false }: { onApply: (args: Record<string, unknown>) => void; onCancel: () => void; /** There is a drawing with shapes in it now: starting a new design replaces it (undo brings it back) */ replaces?: boolean }) {
  const lasers = useDevices();
  const [cncList, setCncList] = useState<CncSetup[]>(loadCncSetups);
  const [canvasList, setCanvasList] = useState<CanvasSetup[]>(loadCanvasSetups);
  const total = lasers.length + cncList.length + canvasList.length;
  const [screen, setScreen] = useState<'choose' | 'job'>('choose');
  const [picked, setPicked] = useState<Picked | null>(null);
  // a kind's list is open from the start when there are only a few setups in all
  const [open, setOpen] = useState<Record<Kind, boolean>>(() => ({ laser: total <= 6, cnc: total <= 6, canvas: total <= 6 }));
  const [sure, setSure] = useState<string | null>(null);

  const cancel = useRef(onCancel);
  cancel.current = onCancel;
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); if (screen === 'job') setScreen('choose'); else cancel.current(); } };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [screen]);

  const isPicked = (kind: Kind, name: string) => picked?.kind === kind && picked.item.name === name;
  const remove = (kind: Kind, name: string) => {
    const key = kind + ':' + name;
    if (sure !== key) { setSure(key); return; }
    setSure(null);
    if (kind === 'laser') saveDevices(lasers.filter((d) => d.name !== name));
    else if (kind === 'cnc') { const n = cncList.filter((d) => d.name !== name); setCncList(n); saveCncSetups(n); }
    else { const n = canvasList.filter((d) => d.name !== name); setCanvasList(n); saveCanvasSetups(n); }
    if (isPicked(kind, name)) setPicked(null);
  };

  const group = <T extends { name: string }>(kind: Kind, title: string, list: T[], detail: (i: T) => string) => list.length === 0 ? null : (
    <section className="nd-group" key={kind} aria-label={title}>
      <button className="nd-head" aria-expanded={open[kind]} onClick={() => setOpen({ ...open, [kind]: !open[kind] })}>
        <span className={'nd-chev' + (open[kind] ? ' open' : '')}><Icon name="chevron" size={16} /></span>
        <span className="nd-icon"><Icon name={'job-' + kind} size={22} /></span>
        <span className="nd-title">{title}</span>
        <span className="muted">({list.length})</span>
      </button>
      {open[kind] && (
        <ul className="nd-list">
          {list.map((item) => (
            <li key={item.name} className={isPicked(kind, item.name) ? 'on' : ''}>
              <button className="nd-item" aria-pressed={isPicked(kind, item.name)} aria-label={`Setup ${item.name}`}
                onClick={() => setPicked({ kind, item } as unknown as Picked)} onDoubleClick={() => onApply(argsOf({ kind, item } as unknown as Picked))}>
                <span>{item.name}</span><small className="muted">{detail(item)}</small>
              </button>
              <button className="btn small" onClick={() => remove(kind, item.name)} aria-label={`Remove setup ${item.name}`} onBlur={() => setSure(null)}>{sure === kind + ':' + item.name ? 'Sure?' : '✕'}</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );

  if (screen === 'job') {
    return <NewJob replaces={replaces} onBack={() => setScreen('choose')} onCancel={onCancel} onApply={(args) => { setCncList(loadCncSetups()); setCanvasList(loadCanvasSetups()); onApply(args); }} lasers={lasers} cncList={cncList} canvasList={canvasList} />;
  }

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal nd-modal" role="dialog" aria-modal="true" aria-label="New design">
        <h2>New design</h2>
        <p className="small muted">{total ? 'Choose a saved setup, or set up a new job.' : 'Set up a new job to start your design. Setups you save will be listed here.'}</p>
        <button className="nd-new" onClick={() => setScreen('job')} aria-label="Setup new job">
          <span className="nd-plus"><Icon name="plus" size={26} /></span>
          <span><b>Setup new job</b><br /><small className="muted">Enter the size and the kind of job (CNC, laser or canvas only).</small></span>
          <span className="nd-chev"><Icon name="chevron" size={18} /></span>
        </button>
        {group('laser', 'Saved laser setups', lasers, (d) => `${d.width} × ${d.height} mm`)}
        {group('cnc', 'Saved CNC setups', cncList, (d) => `${d.width} × ${d.height} × ${d.thickness} mm`)}
        {group('canvas', 'Saved canvas setups', canvasList, (d) => `${d.width} × ${d.height} mm`)}
        {replaces && <p className="warn small">This replaces the drawing you have now. Ctrl+Z brings it back.</p>}
        <div className="row end">
          <button className="btn" onClick={onCancel}>Cancel</button>
          <button className="btn primary" disabled={!picked} onClick={() => picked && onApply(argsOf(picked))}>Open</button>
        </div>
      </div>
    </div>
  );
}

/** Setup new job: the size, what the design is for, the extras of a CNC job, and saving it. */
function NewJob({ replaces, onBack, onCancel, onApply, lasers, cncList, canvasList }: { replaces: boolean; onBack: () => void; onCancel: () => void; onApply: (args: Record<string, unknown>) => void; lasers: Machine[]; cncList: CncSetup[]; canvasList: CanvasSetup[] }) {
  const [j, setJ] = useState<LastJob>(loadLastJob);
  const [sMax, setSMax] = useState(1000);
  const [rapid, setRapid] = useState(100);
  const [save, setSave] = useState(false);
  const [name, setName] = useState('');
  const set = (p: Partial<LastJob>) => setJ((v) => ({ ...v, ...p }));
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => { first.current?.focus(); }, []);

  const needThickness = j.type === 'cnc';
  const valid = j.width > 0 && j.height > 0 && (!needThickness || j.thickness > 0) && (!save || name.trim().length > 0) && (j.type !== 'laser' || (sMax > 0 && rapid > 0));
  const clash = save && name.trim() && (j.type === 'laser' ? lasers : j.type === 'cnc' ? cncList : canvasList).some((d) => d.name === name.trim());

  const create = () => {
    if (!valid) return;
    saveLastJob(j);
    const nm = name.trim();
    if (j.type === 'laser') {
      const machine: Machine = { name: save ? nm : 'Laser', width: j.width, height: j.height, sMax, rapid };
      if (save) saveDevices([...lasers.filter((d) => d.name !== nm), machine]);
      onApply({ kind: 'laser', width: j.width, height: j.height, thickness: j.thickness > 0 ? j.thickness : 0, machine: { name: machine.name, sMax, rapid } });
    } else if (j.type === 'cnc') {
      if (save) saveCncSetups([...cncList.filter((d) => d.name !== nm), { name: nm, width: j.width, height: j.height, thickness: j.thickness, datum: j.datum, zZero: j.zZero, sides: j.sides }]);
      onApply({ kind: 'cnc', width: j.width, height: j.height, thickness: j.thickness, datum: j.datum, zZero: j.zZero, sides: j.sides });
    } else {
      if (save) saveCanvasSetups([...canvasList.filter((d) => d.name !== nm), { name: nm, width: j.width, height: j.height }]);
      onApply({ kind: 'canvas', width: j.width, height: j.height });
    }
  };

  const types: { id: Kind; title: string; text: string }[] = [
    { id: 'cnc', title: 'CNC', text: 'Create toolpaths for a CNC machine.' },
    { id: 'laser', title: 'Laser', text: 'Create artwork for a laser machine.' },
    { id: 'canvas', title: 'Canvas only', text: 'Just design, without machine output.' },
  ];

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal nd-modal" role="dialog" aria-modal="true" aria-label="Setup new job">
        <h2 className="nd-back"><button className="btn small" onClick={onBack} aria-label="Back to the setups" title="Back"><Icon name="back" size={16} /></button> Setup new job</h2>
        <p className="small muted">Set up the work area for a new design.</p>
        <div className="group">
          <div className="fields">
            <label>Width (X) <NumField label="Work area width" value={j.width} min={1} max={100000} step={10} onCommit={(v) => set({ width: v })} /><small>mm</small></label>
            <label>Height (Y) <NumField label="Work area height" value={j.height} min={1} max={100000} step={10} onCommit={(v) => set({ height: v })} /><small>mm</small></label>
          </div>
        </div>
        <div className="group" role="radiogroup" aria-label="Job type">
          <h3 className="sub">Job type</h3>
          {types.map((t) => (
            <label key={t.id} className={'nd-type' + (j.type === t.id ? ' on' : '')}>
              <input type="radio" name="job-type" checked={j.type === t.id} onChange={() => set({ type: t.id })} aria-label={t.title} />
              <span className="nd-icon"><Icon name={'job-' + t.id} size={24} /></span>
              <span><b>{t.title}</b><br /><small className="muted">{t.text}</small></span>
            </label>
          ))}
        </div>
        {j.type !== 'canvas' && (
          <div className="group">
            <label>Thickness (Z){j.type === 'cnc' ? <span className="req" title="Required"> *</span> : <span className="muted"> (optional)</span>}
              <NumField label="Material thickness" value={j.thickness} min={j.type === 'cnc' ? 0.01 : 0} max={10000} step={1} onCommit={(v) => set({ thickness: v })} /><small>mm</small>
            </label>
            <p className="muted small">{j.type === 'cnc' ? 'Required for CNC: it sets how deep the cuts go.' : 'Optional for a laser: leave it 0 when it does not matter.'}</p>
          </div>
        )}
        {j.type === 'cnc' && (
          <div className="group">
            <div className="row wrap" role="radiogroup" aria-label="Sides">
              <span className="muted small">Cut from</span>
              <label className="inline"><input type="radio" name="sides" checked={j.sides === 1} onChange={() => set({ sides: 1 })} /> Single sided</label>
              <label className="inline"><input type="radio" name="sides" checked={j.sides === 2} onChange={() => set({ sides: 2 })} /> Double sided</label>
            </div>
            <div className="row wrap" role="radiogroup" aria-label="Z zero position">
              <span className="muted small">Z zero</span>
              <label className="inline"><input type="radio" name="zz" checked={j.zZero === 'surface'} onChange={() => set({ zZero: 'surface' })} /> Material surface</label>
              <label className="inline"><input type="radio" name="zz" checked={j.zZero === 'bed'} onChange={() => set({ zZero: 'bed' })} /> Machine bed</label>
            </div>
            <div className="row wrap">
              <span className="muted small">XY datum (where 0,0 is on the material)</span>
              <div className="anchors nd-datum" role="radiogroup" aria-label="XY datum position">
                {GRID.map((a) => {
                  const ok = DATUM_CHOICES.includes(a);
                  return <button key={a} type="button" role="radio" aria-checked={j.datum === a} aria-disabled={!ok} disabled={!ok} aria-label={`datum ${a}`} title={ok ? POSITION_NAMES[a] : 'Not offered: pick a corner or the centre'} className={'dot' + (j.datum === a ? ' on' : '') + (ok ? '' : ' off')} onClick={() => ok && set({ datum: a })} />;
                })}
              </div>
            </div>
          </div>
        )}
        {j.type === 'laser' && (
          <details className="more">
            <summary className="small">Laser details (S max, rapid speed)</summary>
            <div className="fields">
              <label>S max <NumField label="S max" value={sMax} min={1} step={1} onCommit={setSMax} /><small>$30</small></label>
              <label>Rapid <NumField label="Rapid speed" value={rapid} min={1} step={10} onCommit={setRapid} /><small>mm/s</small></label>
            </div>
          </details>
        )}
        <div className="group">
          <label className="inline"><input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} aria-label="Save this setup" /> <b>Save this setup</b> <span className="muted small">to use again later</span></label>
          {save && (
            <label className="inline">Setup name <input ref={first} value={name} onChange={(e) => setName(e.target.value)} aria-label="Setup name" placeholder={j.type === 'laser' ? 'e.g. CO2 laser 600 × 400' : j.type === 'cnc' ? 'e.g. Cabinet sign blank' : 'e.g. Sign 24 × 24'} maxLength={60} /></label>
          )}
          {clash && <p className="small muted">A saved setup called "{name.trim()}" exists; saving replaces it.</p>}
        </div>
        {replaces && <p className="warn small">This replaces the drawing you have now. Ctrl+Z brings it back.</p>}
        <div className="row end">
          <button className="btn" onClick={onBack}>Back</button>
          <button className="btn primary" disabled={!valid} onClick={create}>Create job</button>
        </div>
      </div>
    </div>
  );
}
