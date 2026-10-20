import { useEffect, useMemo, useRef, useState } from 'react';
import { NumField } from './NumField';
import { autoThreshold, binarize, despeckle, grey, traceBitmap, type Bitmap } from '../core/trace';
import type { Pt } from '../core/types';

const MAX_SIDE = 1600;   // a bigger picture is shrunk to this many pixels along its longer side before tracing

interface Props {
  file: File;
  onApply: (shapes: Pt[][][]) => void;
  onCancel: () => void;
}

/** Import a bitmap: pick the brightness cut and a size, see the black and white that will be traced, then trace it into outlines. */
export function TraceDialog({ file, onApply, onCancel }: Props) {
  const [img, setImg] = useState<Bitmap | null>(null);
  const [err, setErr] = useState('');
  const [level, setLevel] = useState(128);
  const [invert, setInvert] = useState(false);
  const [specks, setSpecks] = useState(4);
  const [width, setWidth] = useState(100);
  const [smooth, setSmooth] = useState(1);
  const [corner, setCorner] = useState(55);
  const [busy, setBusy] = useState(false);
  const prev = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); onCancel(); } };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [onCancel]);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const bmp = await createImageBitmap(file);
        const k = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
        const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const ctx = c.getContext('2d', { willReadFrequently: true })!;
        ctx.drawImage(bmp, 0, 0, w, h);
        const data = ctx.getImageData(0, 0, w, h);
        if (!live) return;
        const b: Bitmap = { width: w, height: h, data: data.data };
        setImg(b);
        setLevel(autoThreshold(grey(b)));
      } catch {
        if (live) setErr('That file could not be read as a picture (PNG, JPEG, GIF, WebP and BMP work).');
      }
    })();
    return () => { live = false; };
  }, [file]);

  const g = useMemo(() => (img ? grey(img) : null), [img]);
  // the black and white that will be traced, drawn small (the whole picture, shrunk to the preview)
  useEffect(() => {
    if (!img || !g || !prev.current) return;
    const t = setTimeout(() => {
      const bin = despeckle(binarize(g, level, invert), img.width, img.height, specks);
      const c = prev.current!;
      const k = Math.min(1, 520 / img.width, 360 / img.height);
      c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
      const out = c.getContext('2d')!.createImageData(c.width, c.height);
      for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
        const v = bin[Math.min(img.height - 1, Math.floor(y / k)) * img.width + Math.min(img.width - 1, Math.floor(x / k))] ? 20 : 240;
        const i = (y * c.width + x) * 4;
        out.data[i] = out.data[i + 1] = out.data[i + 2] = v; out.data[i + 3] = 255;
      }
      c.getContext('2d')!.putImageData(out, 0, 0);
    }, 80);
    return () => clearTimeout(t);
  }, [img, g, level, invert, specks]);

  const go = () => {
    if (!img) return;
    setBusy(true); setErr('');
    // let the button show "Tracing…" before the work starts
    setTimeout(() => {
      try {
        const t = traceBitmap(img, { threshold: level, invert, minArea: specks, width, smooth, corner });
        onApply(t.shapes);
      } catch (e) {
        setErr((e as Error).message);
        setBusy(false);
      }
    }, 30);
  };

  const height = img ? Math.round((width * img.height) / img.width * 10) / 10 : 0;
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Import bitmap">
        <h2>Import bitmap</h2>
        <div className="text-preview" aria-label="Black and white preview">
          {img ? <canvas ref={prev} style={{ maxWidth: '100%', background: '#fff' }} /> : <span className="muted small">{err || 'Loading the picture…'}</span>}
        </div>
        <div className="group">
          <div className="fields">
            <label>Threshold <input type="range" aria-label="Threshold" min={0} max={255} value={level} onChange={(e) => setLevel(Number(e.target.value))} /> <small>{level}</small></label>
            <button className="btn small" disabled={!g} onClick={() => g && setLevel(autoThreshold(g))}>Auto</button>
            <label className="inline"><input type="checkbox" checked={invert} onChange={(e) => setInvert(e.target.checked)} /> Trace the light parts</label>
          </div>
          <div className="fields">
            <label>Width <NumField label="Traced width" value={width} min={1} max={5000} step={10} onCommit={setWidth} /><small>mm (height {height} mm)</small></label>
            <label>Specks <NumField label="Remove specks" value={specks} min={0} max={10000} step={1} onCommit={(v) => setSpecks(Math.round(v))} /><small>pixels or smaller are dropped</small></label>
          </div>
          <div className="fields">
            <label>Smoothing <NumField label="Smoothing" value={smooth} min={0} max={10} step={0.25} onCommit={setSmooth} /><small>pixels (0 keeps the pixel steps)</small></label>
            <label>Corners <NumField label="Corner angle" value={corner} min={10} max={170} step={5} onCommit={setCorner} /><small>° or sharper stay corners</small></label>
          </div>
          {err && img && <p className="small" style={{ color: 'var(--danger, #e5534b)' }} role="alert">{err}</p>}
          <p className="small muted">Black in the preview is what becomes outlines (an outline round each blob and round each hole). The result is placed with its lower left corner at 0, 0; move it where you want it.</p>
        </div>
        <div className="row end">
          <button className="btn" onClick={onCancel}>Cancel</button>
          <button className="btn primary" disabled={!img || busy} onClick={go}>{busy ? 'Tracing…' : 'Trace'}</button>
        </div>
      </div>
    </div>
  );
}
