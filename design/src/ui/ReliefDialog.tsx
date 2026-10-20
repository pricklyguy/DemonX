import { useEffect, useMemo, useRef, useState } from 'react';
import { cellsToBase64, parseStl, rasterizeStl, reliefShade, UP_AXES, type Mesh, type Relief, type StlRaster, type UpAxis } from '../core/relief';
import { workRect, type Doc } from '../core/types';
import { NumField } from './NumField';

const UP_NAME: Record<UpAxis, string> = { '+z': 'Z is up (the usual)', '-z': 'Turn it over (Z is down)', '+y': 'Y is up', '-y': 'Y is down', '+x': 'X is up', '-x': 'X is down' };
const MAX_FILE = 120 * 1024 * 1024;
const hexRgb = (hex: string): [number, number, number] => { const v = parseInt(hex.replace('#', ''), 16); return Number.isFinite(v) ? [(v >> 16) & 255, (v >> 8) & 255, v & 255] : [201, 164, 108]; };

/** Import an STL file as a 3D shape to carve: pick the file, which way is up, units, size and place, see it shaded, then add it to the job. */
export function ReliefDialog({ doc, colour, onCreate, onClose }: {
  doc: Doc;
  colour: string;
  onCreate: (args: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  const [mesh, setMesh] = useState<Mesh | null>(null);
  const [fileName, setFileName] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [up, setUp] = useState<UpAxis>('+z');
  const [unit, setUnit] = useState<'mm' | 'in'>('mm');
  const [width, setWidth] = useState<number | null>(null);
  const [depth, setDepth] = useState<number | null>(null);
  const [x, setX] = useState<number | null>(null);
  const [y, setY] = useState<number | null>(null);
  const [prev, setPrev] = useState<StlRaster | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const cancel = useRef(onClose);
  cancel.current = onClose;
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); cancel.current(); } };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, []);

  const rect = workRect(doc.workspace);
  const unitMm = unit === 'in' ? 25.4 : 1;

  const choose = async (f: File | undefined) => {
    if (file.current) file.current.value = '';
    if (!f) return;
    if (f.size > MAX_FILE) { setErr('That file is over 120 MB'); return; }
    setBusy('Reading the file…'); setErr('');
    await new Promise((r) => setTimeout(r, 20));
    try {
      const m = parseStl(await f.arrayBuffer());
      setMesh(m); setFileName(f.name.replace(/\.stl$/i, '')); setWidth(null); setDepth(null); setX(null); setY(null);
    } catch (e) {
      setMesh(null); setErr((e as Error).message);
    }
    setBusy('');
  };

  // a small shaded look at it whenever the way up or the units change
  useEffect(() => {
    if (!mesh) { setPrev(null); return; }
    const t = setTimeout(() => {
      try { setPrev(rasterizeStl(mesh, { up, unitMm, maxSide: 160 })); setErr(''); } catch (e) { setPrev(null); setErr((e as Error).message); }
    }, 150);
    return () => clearTimeout(t);
  }, [mesh, up, unitMm]);

  const natW = prev?.width ?? 0, natL = prev?.height ?? 0, natD = prev?.depth ?? 0;
  const matW = rect ? rect.maxX - rect.minX : 300;
  const w = width ?? (natW ? Math.min(natW, matW) : 0);
  const scale = natW ? w / natW : 1;
  const h = natL * scale;
  const d = depth ?? natD * scale;
  const thickness = doc.workspace.kind === 'cnc' ? doc.workspace.thickness : 0;
  const px = x ?? (rect ? rect.minX + (rect.maxX - rect.minX - w) / 2 : 0);
  const py = y ?? (rect ? rect.minY + (rect.maxY - rect.minY - h) / 2 : 0);

  useEffect(() => {
    const c = canvas.current;
    if (!c || !prev) return;
    c.width = prev.w; c.height = prev.h;
    const r: Relief = { id: 1, name: '', w: prev.w, h: prev.h, data: '', x: 0, y: 0, width: w || 1, depth: d || 1, visible: true };
    c.getContext('2d')!.putImageData(new ImageData(reliefShade(r, prev.cells, hexRgb(colour)) as unknown as Uint8ClampedArray<ArrayBuffer>, prev.w, prev.h), 0, 0);
  }, [prev, w, d, colour]);

  const go = async () => {
    if (!mesh) return;
    setBusy('Making the 3D shape…');
    await new Promise((r) => setTimeout(r, 30));
    try {
      const full = rasterizeStl(mesh, { up, unitMm, maxSide: 800 });
      onCreate({ name: fileName || '3D shape', w: full.w, h: full.h, data: cellsToBase64(full.cells), x: px, y: py, width: w, depth: d });
    } catch (e) { setErr((e as Error).message); }
    setBusy('');
  };
  const round = (v: number) => Math.round(v * 100) / 100;
  const ok = !!mesh && !!prev && w > 0 && d > 0 && !busy;
  const tooTall = thickness > 0 && d > thickness + 1e-6;
  return (
    <div className="drawer-back">
      <div className="drawer" role="dialog" aria-modal="true" aria-label="Import STL">
        <h2>Import STL</h2>
        <div className="dbody">
          <fieldset className="dsec"><legend>File</legend>
            <button className="btn small" onClick={() => file.current?.click()}>{mesh ? 'Choose another file…' : 'Choose an STL file…'}</button>
            <input ref={file} type="file" accept=".stl,model/stl,application/sla,application/octet-stream" hidden aria-label="STL file" onChange={(e) => choose(e.target.files?.[0])} />
            {busy && <span className="small muted" role="status">{busy}</span>}
            {err && <span className="warn small">{err}</span>}
            {mesh && <span className="small muted">{fileName}: {mesh.count.toLocaleString()} triangles.</span>}
          </fieldset>
          {mesh && (
            <>
              <fieldset className="dsec"><legend>Which way is up</legend>
                <select aria-label="Which way is up" value={up} onChange={(e) => setUp(e.target.value as UpAxis)}>
                  {UP_AXES.map((a) => <option key={a} value={a}>{UP_NAME[a]}</option>)}
                </select>
                <div role="radiogroup" aria-label="Units of the file">
                  {([['mm', 'The file is in millimetres'], ['in', 'The file is in inches']] as const).map(([v, l]) => (
                    <label key={v} className="radio"><input type="radio" name="stl-unit" checked={unit === v} onChange={() => { setUnit(v); setWidth(null); setDepth(null); }} /> {l}</label>
                  ))}
                </div>
                {prev && <canvas ref={canvas} aria-label="Shaded preview" style={{ width: '100%', maxHeight: 180, objectFit: 'contain', background: '#222', borderRadius: 6 }} />}
                {prev && <span className="small muted">As it comes: {round(natW)} × {round(natL)} mm across, {round(natD)} mm high.</span>}
              </fieldset>
              <fieldset className="dsec"><legend>Size</legend>
                <label className="line">Width <span><NumField label="Model width" value={round(w)} min={0.5} step={5} onCommit={(v) => { setWidth(v); setDepth(null); }} /> <small>mm</small></span></label>
                <label className="line">Length <span className="mono small">{round(h)} mm</span></label>
                <label className="line">Height (depth to carve) <span><NumField label="Model height" value={round(d)} min={0.1} step={1} onCommit={setDepth} /> <small>mm</small></span></label>
                <span className="small muted">Changing the width scales all three evenly. Typing a height stretches or squashes it up and down.</span>
                {tooTall && <span className="warn small">Taller than the {thickness} mm material.</span>}
                {rect && (px < rect.minX - 1e-6 || py < rect.minY - 1e-6 || px + w > rect.maxX + 1e-6 || py + h > rect.maxY + 1e-6) && <span className="warn small">Reaches outside the material.</span>}
              </fieldset>
              <fieldset className="dsec"><legend>Place</legend>
                <label className="line">Left edge (X) <span><NumField label="Model X" value={round(px)} step={5} onCommit={setX} /> <small>mm</small></span></label>
                <label className="line">Bottom edge (Y) <span><NumField label="Model Y" value={round(py)} step={5} onCommit={setY} /> <small>mm</small></span></label>
                <span className="small muted">The top of the model is cut at the top of the material (Z 0).</span>
              </fieldset>
            </>
          )}
        </div>
        <div className="dfoot">
          <button className="btn primary" disabled={!ok} onClick={go}>Add to job</button>
          <button className="btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
