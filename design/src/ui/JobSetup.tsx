import { useEffect, useRef, useState } from 'react';
import type { Anchor } from '../core/geom';
import type { Doc, Machine, Workspace } from '../core/types';
import { LASER_PRESETS } from '../core/types';
import { NumField } from './NumField';
import { saveDevices, useDevices } from './devices';

interface CncSetup { name: string; width: number; height: number; thickness: number; datum: Anchor; zZero: Workspace['zZero']; sides?: 1 | 2 }

const STORE_LAST = 'design-last-work-area';
const STORE_CNC = 'design-cnc-setups';
const CNC_DEFAULT: CncSetup = { name: 'Custom', width: 600, height: 400, thickness: 18, datum: 'bl', zZero: 'surface' };
const DATUMS: Anchor[] = ['tl', 'tc', 'tr', 'ml', 'c', 'mr', 'bl', 'bc', 'br'];

function loadCnc(): CncSetup[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_CNC) ?? '[]');
    return Array.isArray(raw) ? raw.filter((d) => d && typeof d.name === 'string' && d.width > 0 && d.height > 0 && d.thickness > 0) : [];
  } catch { return []; }
}
function saveCnc(list: CncSetup[]) { try { localStorage.setItem(STORE_CNC, JSON.stringify(list)); } catch { /* it just will not be remembered */ } }
function lastChoice(): string { try { return localStorage.getItem(STORE_LAST) ?? 'cnc:Custom'; } catch { return 'cnc:Custom'; } }

export interface JobSetupProps {
  mode: 'new' | 'edit';
  doc: Doc;
  onApply: (args: Record<string, unknown>) => void;
  onCancel: () => void;
}

/**
 * The work area, chosen before drawing (like VCarve's Job Setup): a stored laser or CNC setup, or a size you type, or no
 * limit. It does not decide whether the design is for a laser or a router: the Laser and CNC tabs do their own setup.
 */
export function JobSetup({ mode, doc, onApply, onCancel }: JobSetupProps) {
  const editing = mode === 'edit';
  const savedLasers = useDevices();
  const lasers = savedLasers;   // only lasers that were added: no made-up built-in ones
  const [cncList, setCncList] = useState<CncSetup[]>(loadCnc);

  // what is chosen: 'free', 'laser:<name>' or 'cnc:<name>' ("Custom" is a size typed in)
  const ws = doc.workspace;
  const initial = editing ? (ws.kind === 'free' ? 'free' : ws.kind === 'canvas' ? 'canvas' : ws.kind === 'laser' ? 'laser:' + doc.machine.name : 'cnc:Custom') : lastChoice();
  const [choice, setChoice] = useState(initial);
  const kind: 'free' | 'laser' | 'cnc' | 'canvas' = choice === 'free' ? 'free' : choice === 'canvas' ? 'canvas' : choice.startsWith('laser:') ? 'laser' : 'cnc';
  const [canvas, setCanvas] = useState({ width: ws.kind === 'canvas' ? ws.width : 600, height: ws.kind === 'canvas' ? ws.height : 400 });
  const [laser, setLaser] = useState<Machine>(() => editing && ws.kind === 'laser' ? { ...doc.machine } : lasers.find((d) => 'laser:' + d.name === initial) ?? { ...LASER_PRESETS[0] });
  const [cnc, setCnc] = useState<CncSetup>(() => editing && ws.kind === 'cnc'
    ? { name: 'Custom', width: ws.width, height: ws.height, thickness: ws.thickness, datum: ws.datum, zZero: ws.zZero, sides: ws.sides ?? 1 }
    : cncList.find((d) => 'cnc:' + d.name === initial) ?? { ...CNC_DEFAULT });
  const [saveName, setSaveName] = useState('');
  const firstRef = useRef<HTMLSelectElement>(null);

  const cancel = useRef(onCancel);
  cancel.current = onCancel;
  useEffect(() => {
    firstRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') cancel.current(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const pick = (value: string) => {
    setChoice(value);
    if (value.startsWith('laser:')) { const d = lasers.find((x) => 'laser:' + x.name === value); if (d) setLaser({ ...d }); }
    else if (value.startsWith('cnc:')) { const d = value === 'cnc:Custom' ? null : cncList.find((x) => 'cnc:' + x.name === value); if (d) setCnc({ ...d }); }
  };
  /** Typing a size makes it a custom one, so a stored laser or setup is never altered by accident */
  const sized = (patch: { width?: number; height?: number }) => {
    if (kind === 'canvas') setCanvas({ ...canvas, ...patch });
    else if (kind === 'laser') { setLaser({ ...laser, ...patch, name: 'Custom' }); setChoice('laser:Custom'); }
    else { setCnc({ ...cnc, ...patch, name: 'Custom' }); setChoice('cnc:Custom'); }
  };
  const width = kind === 'laser' ? laser.width : kind === 'canvas' ? canvas.width : cnc.width;
  const height = kind === 'laser' ? laser.height : kind === 'canvas' ? canvas.height : cnc.height;
  const valid = kind === 'free' || (kind === 'canvas' ? canvas.width > 0 && canvas.height > 0 : kind === 'laser' ? laser.width > 0 && laser.height > 0 && laser.sMax > 0 : cnc.width > 0 && cnc.height > 0 && cnc.thickness > 0);

  const apply = () => {
    if (!valid) return;
    try { localStorage.setItem(STORE_LAST, choice); } catch { /* ignore */ }
    if (kind === 'laser') onApply({ kind, width: laser.width, height: laser.height, machine: { name: laser.name, sMax: laser.sMax, rapid: laser.rapid, ...(laser.origin ? { origin: laser.origin } : {}) } });
    else if (kind === 'cnc') onApply({ kind, width: cnc.width, height: cnc.height, thickness: cnc.thickness, datum: cnc.datum, zZero: cnc.zZero, sides: cnc.sides === 2 ? 2 : 1 });
    else if (kind === 'canvas') onApply({ kind, width: canvas.width, height: canvas.height });
    else onApply({ kind });
  };

  const isCustom = choice === 'laser:Custom' || choice === 'cnc:Custom';
  const saveAs = () => {
    const name = saveName.trim();
    if (!name) return;
    if (kind === 'laser') {
      saveDevices([...savedLasers.filter((d) => d.name !== name), { ...laser, name }]);
      setLaser({ ...laser, name }); setChoice('laser:' + name);
    } else if (kind === 'cnc') {
      const next = [...cncList.filter((d) => d.name !== name), { ...cnc, name }];
      setCncList(next); saveCnc(next); setCnc({ ...cnc, name }); setChoice('cnc:' + name);
    }
    setSaveName('');
  };
  const removeStored = () => {
    if (kind === 'laser' && savedLasers.some((d) => d.name === laser.name)) { saveDevices(savedLasers.filter((d) => d.name !== laser.name)); pick('cnc:Custom'); }
    else if (kind === 'cnc' && cncList.some((d) => d.name === cnc.name)) { const next = cncList.filter((d) => d.name !== cnc.name); setCncList(next); saveCnc(next); pick('cnc:Custom'); }
  };
  const storedChosen = (kind === 'laser' && savedLasers.some((d) => d.name === laser.name)) || (kind === 'cnc' && cncList.some((d) => d.name === cnc.name));

  const hasShapes = doc.shapes.length > 0;
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={editing ? 'Job setup' : 'New design'}>
        <h2>{editing ? 'Work area' : 'New design'}</h2>
        <label className="inline">Start from
          <select ref={firstRef} value={choice} aria-label="Start from" onChange={(e) => pick(e.target.value)}>
            <option value="cnc:Custom">Custom size</option>
            {choice === 'laser:Custom' && <option value="laser:Custom">Custom laser ({laser.width} × {laser.height})</option>}
            <optgroup label="Lasers">
              {lasers.map((d) => <option key={d.name} value={'laser:' + d.name}>{d.name} ({d.width} × {d.height})</option>)}
            </optgroup>
            {cncList.length > 0 && (
              <optgroup label="CNC setups">
                {cncList.map((d) => <option key={d.name} value={'cnc:' + d.name}>{d.name} ({d.width} × {d.height} × {d.thickness})</option>)}
              </optgroup>
            )}
            <option value="canvas">Canvas only (design without a machine)</option>
            <option value="free">No size limit</option>
          </select>
        </label>

        {kind !== 'free' ? (
          <div className="group">
            <div className="fields">
              <label>Width (X) <NumField label="Work area width" value={width} min={1} step={10} onCommit={(v) => sized({ width: v })} /><small>mm</small></label>
              <label>Height (Y) <NumField label="Work area height" value={height} min={1} step={10} onCommit={(v) => sized({ height: v })} /><small>mm</small></label>
              {kind === 'laser' && <label>S max <NumField label="S max" value={laser.sMax} min={1} step={1} onCommit={(v) => { setLaser({ ...laser, sMax: v, name: 'Custom' }); setChoice('laser:Custom'); }} /><small>$30</small></label>}
              {kind === 'cnc' && <label>Thickness (Z) <NumField label="Material thickness" value={cnc.thickness} min={0.01} step={1} onCommit={(v) => setCnc({ ...cnc, thickness: v, name: 'Custom' })} /><small>mm</small></label>}
            </div>
            {kind === 'cnc' && (
              <details className="more">
                <summary className="small">Material details for the CNC tab (Z zero, XY datum)</summary>
                <div className="row wrap" role="radiogroup" aria-label="Sides">
                  <span className="muted small">Cut from</span>
                  <label className="inline"><input type="radio" name="sides-edit" checked={(cnc.sides ?? 1) === 1} onChange={() => setCnc({ ...cnc, sides: 1, name: 'Custom' })} /> Single sided</label>
                  <label className="inline"><input type="radio" name="sides-edit" checked={cnc.sides === 2} onChange={() => setCnc({ ...cnc, sides: 2, name: 'Custom' })} /> Double sided</label>
                </div>
                <div className="row wrap" role="radiogroup" aria-label="Z zero position">
                  <span className="muted small">Z zero</span>
                  <label className="inline"><input type="radio" name="zz" checked={cnc.zZero === 'surface'} onChange={() => setCnc({ ...cnc, zZero: 'surface', name: 'Custom' })} /> Material surface</label>
                  <label className="inline"><input type="radio" name="zz" checked={cnc.zZero === 'bed'} onChange={() => setCnc({ ...cnc, zZero: 'bed', name: 'Custom' })} /> Machine bed</label>
                </div>
                <div className="row wrap">
                  <span className="muted small">XY datum (where 0,0 is on the material)</span>
                  <div className="anchors" role="radiogroup" aria-label="XY datum position">
                    {DATUMS.map((a) => (
                      <button key={a} role="radio" aria-checked={cnc.datum === a} aria-label={`datum ${a}`} className={'dot' + (cnc.datum === a ? ' on' : '')} onClick={() => setCnc({ ...cnc, datum: a, name: 'Custom' })} />
                    ))}
                  </div>
                </div>
              </details>
            )}
            <div className="row wrap">
              {isCustom && (
                <>
                  <input value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder={kind === 'laser' ? 'Save this laser as…' : 'Save this setup as…'} aria-label="Name to save under" />
                  <button className="btn small" disabled={!saveName.trim()} onClick={saveAs}>Save</button>
                </>
              )}
              {storedChosen && <button className="btn small danger" onClick={removeStored}>Remove this {kind === 'laser' ? 'laser' : 'setup'}</button>}
            </div>
            <p className="muted small">The work area is drawn as the page, with 0,0 at its {kind === 'laser' ? 'bottom-left corner' : 'datum'}. Sizes are in millimetres. Lasers can be managed in Settings, Laser setup.</p>
          </div>
        ) : (
          <div className="group"><p className="small">No size limit. Use this for a drawing that is not tied to one machine yet. You can set a size later.</p></div>
        )}

        {!editing && hasShapes && <p className="warn small">This replaces the drawing you have now. Ctrl+Z brings it back.</p>}
        {editing && hasShapes && kind !== 'free' && <p className="muted small">Your shapes stay as they are. Anything outside the new size is flagged, not moved.</p>}

        <div className="row end">
          <button className="btn" onClick={onCancel}>{editing ? 'Cancel' : 'Skip (no size limit)'}</button>
          <button className="btn primary" disabled={!valid} onClick={apply}>OK</button>
        </div>
      </div>
    </div>
  );
}
