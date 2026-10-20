import { useEffect, useRef, useState } from 'react';
import { base64ToBytes, bytesToBase64, PHOTO_MAX_SIDE, type CncData, type Toolpath } from '../core/cnc';
import { grey } from '../core/trace';
import { workRect, type Doc } from '../core/types';
import { NumField } from './NumField';
import { ToolField } from './toolPicker';

interface Pic { w: number; h: number; gray: Uint8Array }

/** Set up a photo toolpath: pick a picture, say how big and where, lines or dots, how deep (or change an existing one). */
export function PhotoDialog({ doc, cnc, existing, onCreate, onUpdate, onClose }: {
  doc: Doc;
  cnc: CncData;
  existing: Toolpath | null;
  onCreate: (args: Record<string, unknown>) => void;
  onUpdate: (args: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  const ph = existing?.photo;
  const tools = cnc.tools.filter((t) => t.kind !== 'drill');
  const rect = workRect(doc.workspace);
  const [pic, setPic] = useState<Pic | null>(ph ? { w: ph.w, h: ph.h, gray: base64ToBytes(ph.data) } : null);
  const [fresh, setFresh] = useState(false);   // a picture chosen now, not the one the toolpath already has
  const [err, setErr] = useState('');
  const [toolId, setToolId] = useState(existing?.toolId ?? tools.find((t) => t.kind === 'vbit')?.id ?? tools[0]?.id ?? '');
  const [width, setWidth] = useState(ph?.width ?? Math.min(100, rect ? rect.maxX - rect.minX : 100));
  const [x, setX] = useState<number | null>(ph?.x ?? null);
  const [y, setY] = useState<number | null>(ph?.y ?? null);
  const [mode, setMode] = useState<'lines' | 'dots'>(ph?.mode ?? 'lines');
  const [dir, setDir] = useState<'x' | 'y'>(ph?.dir ?? 'x');
  const [spacing, setSpacing] = useState(ph?.spacing ?? 0.5);
  const [invert, setInvert] = useState(ph?.invert ?? false);
  const [depth, setDepth] = useState(existing?.cutDepth ?? 1.5);
  const [safeZ, setSafeZ] = useState(existing?.safeZ ?? 5);
  const [name, setName] = useState('');
  const prev = useRef<HTMLCanvasElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const cancel = useRef(onClose);
  cancel.current = onClose;
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); cancel.current(); } };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, []);

  const height = pic ? (width * pic.h) / pic.w : 0;
  // where it goes: the middle of the material until the person says otherwise
  const px = x ?? (rect ? rect.minX + (rect.maxX - rect.minX - width) / 2 : 0);
  const py = y ?? (rect ? rect.minY + (rect.maxY - rect.minY - height) / 2 : 0);

  const choose = async (f: File | undefined) => {
    if (file.current) file.current.value = '';
    if (!f) return;
    try {
      const bmp = await createImageBitmap(f);
      const k = Math.min(1, PHOTO_MAX_SIDE / Math.max(bmp.width, bmp.height));
      const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(bmp, 0, 0, w, h);
      const d = ctx.getImageData(0, 0, w, h);
      setPic({ w, h, gray: grey({ width: w, height: h, data: d.data }) });
      setFresh(true);
      setErr('');
      setX(null); setY(null);
    } catch {
      setErr('That file could not be read as a picture (PNG, JPEG, GIF, WebP and BMP work).');
    }
  };

  // the picture as the cut will see it: dark is deep (or the other way when inverted)
  useEffect(() => {
    const c = prev.current;
    if (!c || !pic) return;
    c.width = pic.w; c.height = pic.h;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(pic.w, pic.h);
    for (let i = 0; i < pic.gray.length; i++) {
      const v = invert ? 255 - pic.gray[i] : pic.gray[i];
      img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }, [pic, invert]);

  const tool = tools.find((t) => t.id === toolId);
  const ok = !!pic && !!tool && depth > 0 && width > 0 && spacing >= 0.05;
  const go = () => {
    if (!pic) return;
    const photo: Record<string, unknown> = { x: px, y: py, width, mode, spacing, dir, invert };
    if (!existing || fresh) Object.assign(photo, { w: pic.w, h: pic.h, data: bytesToBase64(pic.gray) });
    if (existing) onUpdate({ id: existing.id, toolId, cutDepth: depth, safeZ, photo, ...(name.trim() ? { name: name.trim() } : {}) });
    else onCreate({ kind: 'photo', toolId, cutDepth: depth, safeZ, photo, ...(name.trim() ? { name: name.trim() } : {}) });
  };
  const round = (v: number) => Math.round(v * 1000) / 1000;
  return (
    <div className="drawer-back">
      <div className="drawer" role="dialog" aria-modal="true" aria-label={existing ? 'Edit toolpath' : 'Photo toolpath'}>
        <h2>{existing ? 'Edit toolpath' : 'Photo toolpath'}</h2>
        <div className="dbody">
          <fieldset className="dsec"><legend>Picture</legend>
            <button className="btn small" onClick={() => file.current?.click()}>{pic ? 'Choose another picture…' : 'Choose a picture…'}</button>
            <input ref={file} type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/bmp" hidden aria-label="Picture file" onChange={(e) => choose(e.target.files?.[0])} />
            {err && <span className="warn small">{err}</span>}
            {pic && <canvas ref={prev} aria-label="Picture preview" style={{ width: '100%', maxHeight: 160, objectFit: 'contain', background: '#fff', borderRadius: 6 }} />}
            {pic && <span className="small muted">{pic.w} × {pic.h} pixels{pic.w === PHOTO_MAX_SIDE || pic.h === PHOTO_MAX_SIDE ? ' (shrunk to fit)' : ''}. Dark is deep{invert ? ' only when Invert is off' : ''}.</span>}
          </fieldset>
          <fieldset className="dsec"><legend>Size and place</legend>
            <label className="line">Width <span><NumField label="Picture width" value={round(width)} min={1} step={10} onCommit={setWidth} /> <small>mm</small></span></label>
            <label className="line">Height <span className="mono small">{pic ? round(height) : '–'} mm</span></label>
            <label className="line">Left edge (X) <span><NumField label="Picture X" value={round(px)} step={5} onCommit={setX} /> <small>mm</small></span></label>
            <label className="line">Bottom edge (Y) <span><NumField label="Picture Y" value={round(py)} step={5} onCommit={setY} /> <small>mm</small></span></label>
          </fieldset>
          <fieldset className="dsec"><legend>Tool</legend>
            <ToolField label="Tool" value={toolId} tools={tools} accept={(k) => k !== 'drill'} onChange={setToolId} />
          </fieldset>
          <fieldset className="dsec" role="radiogroup" aria-label="Photo style"><legend>Style</legend>
            {([['lines', 'Lines (the depth follows the picture)'], ['dots', 'Dots (a hole as deep as it is dark)']] as const).map(([v, l]) => (
              <label key={v} className="radio"><input type="radio" name="ph-mode" checked={mode === v} onChange={() => setMode(v)} /> {l}</label>
            ))}
            {mode === 'lines' && (
              <div role="radiogroup" aria-label="Line direction">
                {([['x', 'Lines along X'], ['y', 'Lines along Y']] as const).map(([v, l]) => (
                  <label key={v} className="radio"><input type="radio" name="ph-dir" checked={dir === v} onChange={() => setDir(v)} /> {l}</label>
                ))}
              </div>
            )}
            <label className="line">{mode === 'lines' ? 'Line spacing' : 'Dot spacing'} <span><NumField label="Spacing" value={spacing} min={0.05} step={0.1} onCommit={setSpacing} /> <small>mm</small></span></label>
            <label className="radio"><input type="checkbox" checked={invert} onChange={(e) => setInvert(e.target.checked)} /> Invert (light is deep)</label>
          </fieldset>
          <fieldset className="dsec"><legend>Depth</legend>
            <label className="line">Deepest cut (C) <span><NumField label="Cut depth" value={depth} min={0.01} step={0.5} onCommit={setDepth} /> <small>mm</small></span></label>
            <label className="line">Safe height <span><NumField label="Safe height" value={safeZ} min={0.5} step={1} onCommit={setSafeZ} /> <small>mm above top</small></span></label>
          </fieldset>
          <fieldset className="dsec"><legend>Name</legend>
            <input aria-label="Toolpath name" value={name} placeholder={existing?.name ?? 'Automatic'} onChange={(e) => setName(e.target.value)} />
          </fieldset>
        </div>
        <div className="dfoot">
          <button className="btn primary" disabled={!ok} onClick={go}>{existing ? 'Save' : 'Calculate'}</button>
          <button className="btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
