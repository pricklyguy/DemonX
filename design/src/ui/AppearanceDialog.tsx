import { useEffect, useRef } from 'react';
import { ACCENT_PRESETS, CANVAS_DEFAULTS, COLOR_KEYS, DEFAULTS, LABELS, type ColorKey } from '../../../shared/colors';
import type { Colors } from './appearance';
import { useHideNotes } from './prefs';

/** Light or dark and the colours: the same choices as the DemonX controller's Appearance settings. */
export function AppearanceDialog({ theme, setTheme, colors, onClose }: { theme: 'dark' | 'light'; setTheme: (t: 'dark' | 'light') => void; colors: Colors; onClose: () => void }) {
  const defaults = DEFAULTS[theme];
  const [hideNotes, setHideNotes] = useHideNotes();
  const hex = (k: ColorKey) => colors.chosen[k] ?? defaults[k];
  const cancel = useRef(onClose);
  cancel.current = onClose;
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); cancel.current(); } };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, []);
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Appearance">
        <h2>Appearance</h2>
        <p className="small muted">Light or dark, and the colours, for this browser. The dark and the light theme each keep their own colours. These are the same colour choices as DemonX, but set separately.</p>
        <div className="row">
          <label className="inline"><input type="radio" name="theme" checked={theme === 'dark'} onChange={() => setTheme('dark')} /> Dark</label>
          <label className="inline"><input type="radio" name="theme" checked={theme === 'light'} onChange={() => setTheme('light')} /> Light</label>
        </div>
        <label className="inline"><input type="checkbox" checked={hideNotes} onChange={(e) => setHideNotes(e.target.checked)} /> Hide the reminders and notes in the Laser panel (the warnings that stop a job stay)</label>
        <div className="menu-h small muted">Accent colour</div>
        <div className="swatches" role="group" aria-label="Accent colour">
          {ACCENT_PRESETS.map((p) => {
            const c = theme === 'dark' ? p.dark : p.light;
            const on = hex('accent').toLowerCase() === c.toLowerCase();
            return <button key={p.name} type="button" className={'swatch' + (on ? ' on' : '')} style={{ background: c }} title={p.name} aria-label={p.name} aria-pressed={on} onClick={() => (p.name === 'Green' ? colors.set('accent', undefined) : colors.set('accent', c))} />;
          })}
        </div>
        <label className="color-row">
          <span>Drawing area (the grid)</span>
          <input type="color" aria-label="Drawing area" value={colors.canvas ?? CANVAS_DEFAULTS[theme]} onChange={(e) => colors.setCanvas(e.target.value)} />
          <code>{colors.canvas ?? CANVAS_DEFAULTS[theme]}</code>
          <button type="button" className="btn small" disabled={!colors.canvas} onClick={() => colors.setCanvas(undefined)}>Reset</button>
        </label>
        <div className="color-rows">
          {COLOR_KEYS.map((k) => (
            <label key={k} className="color-row">
              <span>{LABELS[k]}</span>
              <input type="color" aria-label={LABELS[k]} value={hex(k)} onChange={(e) => colors.set(k, e.target.value)} />
              <code>{hex(k)}</code>
              <button type="button" className="btn small" disabled={!(k in colors.chosen)} onClick={() => colors.set(k, undefined)}>Reset</button>
            </label>
          ))}
        </div>
        <div className="row end">
          <button className="btn small" disabled={!Object.keys(colors.chosen).length && !colors.canvas} onClick={colors.reset}>Reset all to the built-in colours</button>
          <button className="btn primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
