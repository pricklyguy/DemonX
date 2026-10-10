import { useEffect, useState } from 'react';
import { COLOR_KEYS, buildVars, sanitizeOverrides, type ColorKey, type Mode, type Overrides } from '../../shared/colors';

// The colours chosen for this browser, one set for the dark theme and one for the light, kept in localStorage and
// applied as CSS variables on the page (they override the ones in styles.css). Nothing chosen means the built-in look.

const KEY = 'colors';
type Saved = Record<Mode, Overrides>;
const ALL_VARS = ['--accent', '--accent-text', '--bg', '--panel', '--panel2', '--line', '--text', '--muted', '--amber', '--cyan', '--danger', '--ok'];

function load(): Saved {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return { dark: sanitizeOverrides(raw?.dark), light: sanitizeOverrides(raw?.light) };
  } catch { return { dark: {}, light: {} }; }
}

export interface Colors {
  /** What is chosen for the current theme */
  chosen: Overrides;
  set: (key: ColorKey, value: string | undefined) => void;
  /** Several at once (a preset) */
  setMany: (values: Overrides) => void;
  reset: () => void;
}

export function useColors(mode: Mode): Colors {
  const [saved, setSaved] = useState<Saved>(load);
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
    setMany: (values) => update((o) => ({ ...o, ...values })),
    reset: () => update(() => ({})),
  };
}

export { COLOR_KEYS };

export type Density = 'comfortable' | 'compact';

/** Comfortable (the default) or compact spacing, kept per browser and applied as data-density on the page */
export function useDensity(): [Density, (d: Density) => void] {
  const [d, setD] = useState<Density>(() => {
    try { return localStorage.getItem('density') === 'compact' ? 'compact' : 'comfortable'; } catch { return 'comfortable'; }
  });
  useEffect(() => {
    document.documentElement.dataset.density = d;
    try { localStorage.setItem('density', d); } catch { /* not saved in private mode */ }
  }, [d]);
  return [d, setD];
}
