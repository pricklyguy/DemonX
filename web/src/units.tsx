import { createContext, useContext, useEffect, useState } from 'react';
import { makeUnits, toMm, fromMm, type Unit, type Units } from './unitsCore';

// Everything inside DemonX (the machine, saved settings, the server) is in millimetres.
// Inches exist only on screen: values are converted for display, and typed values are
// converted back before they are used or saved.

export { MM_PER_INCH, makeUnits, toMm, fromMm } from './unitsCore';
export type { Unit, Units } from './unitsCore';

const Ctx = createContext<Units>(makeUnits('mm'));
export const useUnits = () => useContext(Ctx);

const read = (): Unit => { try { return localStorage.getItem('units') === 'in' ? 'in' : 'mm'; } catch { return 'mm'; } };

/** Units are chosen per browser, like the theme and layout */
export function UnitsProvider({ children }: { children: React.ReactNode }) {
  const [unit, setUnit] = useState<Unit>(read);
  useEffect(() => { try { localStorage.setItem('units', unit); } catch { /* not saved in private mode */ } }, [unit]);
  return <Ctx.Provider value={makeUnits(unit, setUnit)}>{children}</Ctx.Provider>;
}

const clean = (n: number) => String(Math.round(n * 1e6) / 1e6);

/**
 * A number box whose value lives in millimetres but is typed in the chosen unit. It keeps what
 * is being typed as text, so "0." or "1.50" are not rewritten under the cursor.
 */
export function NumInput({ mm, onMm, kind, min, step = 'any' }: { mm: number; onMm: (mm: number) => void; kind: 'len' | 'feed' | 'raw'; min?: number; step?: string }) {
  const { unit } = useUnits();
  const [text, setText] = useState(() => clean(fromMm(mm, unit, kind)));
  // follow outside changes (another button, a switch of units), but leave alone what is being typed
  useEffect(() => {
    const typed = Number(text);
    if (text.trim() === '' || !Number.isFinite(typed) || Math.abs(toMm(typed, unit, kind) - mm) > 1e-6) setText(clean(fromMm(mm, unit, kind)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mm, unit, kind]);
  return (
    <input type="number" step={step} min={min === undefined ? undefined : fromMm(min, unit, kind)} value={text}
      onChange={(e) => { setText(e.target.value); const n = Number(e.target.value); if (e.target.value.trim() !== '' && Number.isFinite(n)) onMm(toMm(n, unit, kind)); }} />
  );
}
