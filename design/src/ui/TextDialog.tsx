import { useEffect, useMemo, useRef, useState } from 'react';
import { fontNames, getFont, layoutText, type TextFont } from '../core/text';
import { BUILT_IN_FONTS, ensureFont, loadFontFile } from './fontCatalog';
import { NumField } from './NumField';
import { querySystemFonts, systemFontsAllowed, systemFontsSupport } from './systemFonts';

/** Editing text already in the drawing: its settings now, and the id of a line or outline picked with it to run the text along (if any). */
export interface EditText {
  text: string; font: string; height: number; align: 'left' | 'center' | 'right'; spacing: number; lineSpacing: number; weld: boolean;
  curve?: { offset: number; flip: boolean };
  curveId: number | null;
}

interface Props {
  at: [number, number];
  edit?: EditText;
  onApply: (args: Record<string, unknown>) => void;
  onCancel: () => void;
}

const STORE = 'design-text';
const defaults = { text: 'Hello', font: 'Roboto Bold', height: 20, align: 'left', spacing: 0, lineSpacing: 1, weld: false };

function load() {
  try { return { ...defaults, ...JSON.parse(localStorage.getItem(STORE) ?? '{}') }; } catch { return defaults; }
}

/** Type text, pick a font and size, see it, and put it into the drawing at the clicked point. */
export function TextDialog({ at, edit, onApply, onCancel }: Props) {
  const [v, setV] = useState(() => (edit ? { ...defaults, text: edit.text, font: edit.font, height: edit.height, align: edit.align, spacing: edit.spacing, lineSpacing: edit.lineSpacing, weld: edit.weld } : load()));
  const [onCurve, setOnCurve] = useState(!!edit?.curve || edit?.curveId != null);
  const [offset, setOffset] = useState(edit?.curve?.offset ?? 0);
  const [flip, setFlip] = useState(edit?.curve?.flip ?? false);
  const [x, setX] = useState(at[0]);
  const [y, setY] = useState(at[1]);
  const [font, setFont] = useState<TextFont | null>(getFont(v.font) ?? null);
  const [err, setErr] = useState('');
  const [, bump] = useState(0);
  const file = useRef<HTMLInputElement>(null);
  const [sysNames, setSysNames] = useState<string[]>([]);
  const sysSupport = useMemo(() => systemFontsSupport(), []);
  const loadSys = async () => { try { setSysNames(await querySystemFonts()); setErr(''); } catch (e) { setErr((e as Error).name === 'NotAllowedError' ? 'The browser was not allowed to list the fonts on this computer.' : (e as Error).message); } };
  // if the person has already said yes before, the list is there without asking again
  useEffect(() => { if (sysSupport.ok) void systemFontsAllowed().then((ok) => { if (ok) void loadSys(); }); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  const area = useRef<HTMLTextAreaElement>(null);

  const cancel = useRef(onCancel);
  cancel.current = onCancel;
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); cancel.current(); } };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, []);
  useEffect(() => { area.current?.focus(); area.current?.select(); }, []);

  useEffect(() => {
    let live = true;
    setErr('');
    ensureFont(v.font).then((f) => { if (live) setFont(f); }).catch((e) => { if (live) { setFont(null); setErr((e as Error).message); } });
    return () => { live = false; };
  }, [v.font]);

  const lay = useMemo(() => (font && v.text.trim() ? layoutText(font, v.text.slice(0, 500), 0, 0, { height: v.height, align: v.align, spacing: v.spacing, lineSpacing: v.lineSpacing }) : null), [font, v]);
  const view = useMemo(() => {
    if (!lay || !lay.glyphs.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const d = lay.glyphs.map((rings) => rings.map((r) => {
      for (const p of r) { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minY = Math.min(minY, -p[1]); maxY = Math.max(maxY, -p[1]); }
      return 'M' + r.map((p) => `${p[0].toFixed(2)} ${(-p[1]).toFixed(2)}`).join('L') + 'Z';
    }).join('')).join('');
    const pad = Math.max(maxX - minX, maxY - minY) * 0.04 + 1;
    return { d, box: `${minX - pad} ${minY - pad} ${maxX - minX + 2 * pad} ${maxY - minY + 2 * pad}` };
  }, [lay]);

  const set = (patch: Partial<typeof defaults>) => setV((p: typeof defaults) => ({ ...p, ...patch }));
  const sysSet = new Set(sysNames);
  const names = [...new Set([...Object.keys(BUILT_IN_FONTS), ...fontNames().filter((n) => !sysSet.has(n))])];
  const ready = !!font && v.text.trim().length > 0 && v.height > 0;
  const apply = () => {
    if (!ready) return;
    if (!edit) { try { localStorage.setItem(STORE, JSON.stringify(v)); } catch { /* it just will not be remembered */ } }
    if (edit) {
      onApply({ text: v.text, height: v.height, font: v.font, align: v.align, spacing: v.spacing, line_spacing: v.lineSpacing, weld: v.weld, ...(onCurve ? { offset, flip, ...(edit.curveId != null ? { curve: edit.curveId } : {}) } : { curve: null }) });
      return;
    }
    onApply({ text: v.text, x, y, height: v.height, font: v.font, align: v.align, spacing: v.spacing, line_spacing: v.lineSpacing, weld: v.weld });
  };

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={edit ? 'Edit text' : 'Text'}>
        <h2>{edit ? 'Edit text' : 'Text'}</h2>
        <textarea ref={area} aria-label="Text to draw" rows={3} value={v.text} maxLength={500} onChange={(e) => set({ text: e.target.value })}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); apply(); } }} />
        <div className="text-preview" aria-label="Preview">
          {view ? <svg viewBox={view.box} preserveAspectRatio="xMidYMid meet"><path d={view.d} fill="currentColor" fillRule="nonzero" /></svg> : <span className="muted small">{err || (font ? 'Nothing to show yet' : 'Loading the font…')}</span>}
        </div>
        <div className="group">
          <div className="fields">
            <label>Font
              <select aria-label="Font" value={v.font} onChange={(e) => set({ font: e.target.value })}>
                <optgroup label="Built in and loaded">{names.map((n) => <option key={n} value={n}>{n}</option>)}</optgroup>
                {sysNames.length > 0 && <optgroup label="On this computer">{sysNames.filter((n) => !names.includes(n)).map((n) => <option key={'sys-' + n} value={n}>{n}</option>)}</optgroup>}
                {!names.includes(v.font) && !sysSet.has(v.font) && <option value={v.font}>{v.font}</option>}
              </select>
            </label>
            <button className="btn small" disabled={!sysSupport.ok || sysNames.length > 0} title={sysSupport.ok ? 'List the fonts installed on this computer (the browser asks first)' : sysSupport.why} onClick={() => void loadSys()}>{sysNames.length ? `${sysNames.length} system fonts` : 'System fonts…'}</button>
            <button className="btn small" onClick={() => file.current?.click()} title="Use a .ttf, .otf or .woff file from your computer">Font file…</button>
            <input ref={file} type="file" accept=".ttf,.otf,.woff" hidden aria-label="Font file" onChange={async (e) => {
              const f = e.target.files?.[0]; e.target.value = '';
              if (!f) return;
              try { const loaded = await loadFontFile(f); setErr(''); set({ font: loaded.name }); bump((n) => n + 1); } catch (er) { setErr((er as Error).message); }
            }} />
          </div>
          <div className="fields">
            <label>Height <NumField label="Letter height" value={v.height} min={0.1} max={5000} step={1} onCommit={(n) => set({ height: n })} /><small>mm (capitals)</small></label>
            <label>Spacing <NumField label="Letter spacing" value={v.spacing} step={0.5} onCommit={(n) => set({ spacing: n })} /><small>mm</small></label>
            <label>Lines <NumField label="Line spacing" value={v.lineSpacing} min={0.1} step={0.1} onCommit={(n) => set({ lineSpacing: n })} /><small>×</small></label>
          </div>
          <div className="fields">
            <div className="seg" role="radiogroup" aria-label="Alignment">
              {(['left', 'center', 'right'] as const).map((a) => <button key={a} role="radio" aria-checked={v.align === a} className={'btn small' + (v.align === a ? ' primary' : '')} onClick={() => set({ align: a })}>{a}</button>)}
            </div>
            <label className="inline"><input type="checkbox" checked={v.weld} onChange={(e) => set({ weld: e.target.checked })} /> Join the letters into one shape</label>
          </div>
          {!edit && (
            <div className="fields">
              <label>At X <NumField label="Text X" value={x} step={1} onCommit={setX} /><small>mm</small></label>
              <label>Y <NumField label="Text Y" value={y} step={1} onCommit={setY} /><small>mm (baseline of the first line)</small></label>
            </div>
          )}
          {edit && (
            <div className="fields" role="group" aria-label="Along a curve">
              <label className="inline"><input type="checkbox" checked={onCurve} disabled={!edit.curve && edit.curveId == null} onChange={(e) => setOnCurve(e.target.checked)} /> Run along a curve</label>
              {!edit.curve && edit.curveId == null && <small className="muted">To put text on a curve, pick the text and a line or outline together (shift-click), then Edit text.</small>}
              {edit.curveId != null && <small className="muted">Along the line or outline you picked with it.</small>}
              {edit.curve && edit.curveId == null && <small className="muted">Along the curve it is on now.</small>}
              {onCurve && (
                <>
                  <label>Start <NumField label="Start along the curve" value={offset} step={1} onCommit={setOffset} /><small>mm along (the text start, middle or end follows Align)</small></label>
                  <label className="inline"><input type="checkbox" checked={flip} onChange={(e) => setFlip(e.target.checked)} /> Other side of the curve</label>
                </>
              )}
            </div>
          )}
          {!sysSupport.ok && <p className="small muted" role="note">System fonts: {sysSupport.why}</p>}
          {err && <p className="small" style={{ color: 'var(--danger, #e5534b)' }} role="alert">{err}</p>}
          <p className="small muted">The text becomes outlines, one shape per letter (picked together as a group), so it can be offset, cut, engraved or combined. {edit ? 'The preview shows it straight. ' : 'Pick it and press Edit text to change it later; Text to lines makes it plain outlines. '}Ligatures are not applied. Ctrl+Enter {edit ? 'applies' : 'places'} it.</p>
        </div>
        <div className="row end">
          <button className="btn" onClick={onCancel}>Cancel</button>
          <button className="btn primary" disabled={!ready} onClick={apply}>{edit ? 'Apply' : 'Place text'}</button>
        </div>
      </div>
    </div>
  );
}
