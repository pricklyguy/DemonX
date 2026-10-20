import { useEffect, useState } from 'react';
import { COLOR_KEYS, buildVars, parseHex, sanitizeOverrides, toHex, type ColorKey, type Mode, type Overrides } from '../../../shared/colors';

// The colour choices of DemonX (shared/colors.ts), kept for this browser: one set for the dark theme and one for the light.
// They are applied as CSS variables on the page and override the built-in ones in styles.css.

const KEY = 'design-colors';
const CANVAS_KEY = 'design-canvas-color';
type Saved = Record<Mode, Overrides>;
const ALL_VARS = ['--accent', '--accent-text', '--bg', '--panel', '--panel2', '--line', '--text', '--muted', '--amber', '--cyan', '--danger', '--ok'];

function load(): Saved {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return { dark: sanitizeOverrides(raw?.dark), light: sanitizeOverrides(raw?.light) };
  } catch { return { dark: {}, light: {} }; }
}

export interface Colors {
  chosen: Overrides;
  /** Background of the drawing area (the grid), separate from the page background; undefined = built-in */
  canvas: string | undefined;
  setCanvas: (v: string | undefined) => void;
  set: (key: ColorKey, value: string | undefined) => void;
  reset: () => void;
}

function loadCanvas(): Partial<Record<Mode, string>> {
  try {
    const raw = JSON.parse(localStorage.getItem(CANVAS_KEY) ?? '{}');
    const out: Partial<Record<Mode, string>> = {};
    for (const m of ['dark', 'light'] as const) { const rgb = parseHex(raw?.[m]); if (rgb) out[m] = toHex(rgb); }
    return out;
  } catch { return {}; }
}

export function useColors(mode: Mode): Colors {
  const [saved, setSaved] = useState<Saved>(load);
  const [canvasSaved, setCanvasSaved] = useState(loadCanvas);
  useEffect(() => {
    const root = document.documentElement.style;
    if (canvasSaved[mode]) root.setProperty('--canvas', canvasSaved[mode]!); else root.removeProperty('--canvas');
    try { localStorage.setItem(CANVAS_KEY, JSON.stringify(canvasSaved)); } catch { /* not saved in private mode */ }
  }, [canvasSaved, mode]);
  useEffect(() => {
    const root = document.documentElement.style;
    for (const v of ALL_VARS) root.removeProperty(v);
    for (const [k, v] of Object.entries(buildVars(mode, saved[mode]))) root.setProperty(k, v);
    try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch { /* not saved in private mode */ }
  }, [saved, mode]);
  const update = (f: (o: Overrides) => Overrides) => setSaved((s) => ({ ...s, [mode]: sanitizeOverrides(f(s[mode])) }));
  return {
    chosen: saved[mode],
    set: (key, value) => update((o) => { const n = { ...o }; if (value === undefined) delete n[key]; else n[key] = value; return n; }),
    canvas: canvasSaved[mode],
    setCanvas: (v) => setCanvasSaved((c) => { const n = { ...c }; if (v) n[mode] = v; else delete n[mode]; return n; }),
    reset: () => { update(() => ({})); setCanvasSaved((c) => { const n = { ...c }; delete n[mode]; return n; }); },
  };
}

export { COLOR_KEYS };
