import { useState } from 'react';
import { fontNames } from '../core/text';
import { BUILT_IN_FONTS } from './fontCatalog';
import { NumField } from './NumField';
import { querySystemFonts, systemFontNames, systemFontsSupport } from './systemFonts';

/** What is being typed on the drawing: the settings of the text, shown (and changed) in the bar above the drawing. */
export interface LiveSettings {
  text: string; font: string; height: number; align: 'left' | 'center' | 'right'; spacing: number; lineSpacing: number; weld: boolean; bend: number;
}

/**
 * The bar above the drawing while text is typed on it: font, height, alignment, spacing, curve and whether the letters are joined,
 * with Done and Cancel. Changing a box here keeps the typing going (`refocus` puts the cursor back).
 */
export function LiveTextBar({ s, set, editing, onDone, onCancel, refocus, problem }: { s: LiveSettings; set: (p: Partial<LiveSettings>) => void; editing: boolean; onDone: () => void; onCancel: () => void; refocus: () => void; /** Why nothing can be drawn (the font could not be loaded) */ problem?: string }) {
  const [sys, setSys] = useState<string[]>(() => systemFontNames());
  const support = systemFontsSupport();
  const [err, setErr] = useState('');
  const builtin = [...new Set([...Object.keys(BUILT_IN_FONTS), ...fontNames().filter((n) => !sys.includes(n))])];
  const change = (p: Partial<LiveSettings>) => { set(p); refocus(); };
  return (
    <div className="propbar live-text-bar" role="group" aria-label="Text on the drawing" onBlur={(e) => { if (!e.relatedTarget) refocus(); }} title="Type on the drawing. Enter starts a new line. Ctrl+Enter or a click on the drawing places it, Escape leaves it.">
      <label>Font
        <select aria-label="Font" value={s.font} onChange={(e) => change({ font: e.target.value })}>
          <optgroup label="Built in and loaded">{builtin.map((n) => <option key={n} value={n}>{n}</option>)}</optgroup>
          {sys.length > 0 && <optgroup label="On this computer">{sys.filter((n) => !builtin.includes(n)).map((n) => <option key={'s-' + n} value={n}>{n}</option>)}</optgroup>}
          {!builtin.includes(s.font) && !sys.includes(s.font) && <option value={s.font}>{s.font}</option>}
        </select>
      </label>
      <button className="btn small" disabled={!support.ok || sys.length > 0} title={support.ok ? 'List the fonts installed on this computer (the browser asks first)' : support.why}
        onClick={async () => { try { setSys(await querySystemFonts()); setErr(''); } catch (e) { setErr((e as Error).name === 'NotAllowedError' ? 'The browser was not allowed to list the fonts on this computer.' : (e as Error).message); } refocus(); }}>
        {sys.length ? `${sys.length} system fonts` : 'System fonts…'}
      </button>
      <label>Height<NumField label="Letter height" value={s.height} min={0.1} max={5000} step={1} width={72} onCommit={(v) => change({ height: v })} /><small>mm</small></label>
      <div className="seg" role="radiogroup" aria-label="Alignment">
        {(['left', 'center', 'right'] as const).map((a) => <button key={a} role="radio" aria-checked={s.align === a} className={'btn small' + (s.align === a ? ' primary' : '')} onClick={() => change({ align: a })}>{a}</button>)}
      </div>
      <label>Spacing<NumField label="Letter spacing" value={s.spacing} step={0.5} width={64} onCommit={(v) => change({ spacing: v })} /><small>mm</small></label>
      <label>Lines<NumField label="Line spacing" value={s.lineSpacing} min={0.1} step={0.1} width={60} onCommit={(v) => change({ lineSpacing: v })} /><small>×</small></label>
      <label>Curve<NumField label="Curve" value={s.bend} min={-260} max={260} step={10} width={64} onCommit={(v) => change({ bend: v })} /><small>°</small></label>
      <label className="inline"><input type="checkbox" checked={s.weld} onChange={(e) => change({ weld: e.target.checked })} /> Welded</label>
      <span className="sep" />
      <button className="btn small primary" onClick={onDone} title="Put the text in the drawing (Ctrl+Enter, or click on the drawing)">{editing ? 'Done' : 'Place'}</button>
      <button className="btn small" onClick={onCancel} title="Leave it as it was (Escape)">Cancel</button>
      {(problem || err) && <span className="small" role="alert" style={{ color: 'var(--danger, #e5534b)' }}>{problem || err}</span>}
    </div>
  );
}
