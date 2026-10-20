// Colour choices for the browser UI: parsing, mixing and checking colours, and turning a few chosen colours
// into the full set of CSS variables. Pure functions, used by the Appearance settings and by the tests.

export type Mode = 'dark' | 'light';
export type Rgb = [number, number, number];

/** The colours a person can change. Everything else is worked out from these. */
export const COLOR_KEYS = ['accent', 'bg', 'panel', 'text', 'amber', 'cyan', 'danger', 'ok'] as const;
export type ColorKey = (typeof COLOR_KEYS)[number];
export type Overrides = Partial<Record<ColorKey, string>>;

/** The built-in colours (kept in step with styles.css) */
export const DEFAULTS: Record<Mode, Record<ColorKey, string>> = {
  dark: { accent: '#6aa84f', bg: '#14130f', panel: '#1e1d17', text: '#ece8d8', amber: '#e0a030', cyan: '#2bb5c9', danger: '#d8503c', ok: '#4caf7a' },
  light: { accent: '#3f7d2c', bg: '#f4efe0', panel: '#fffdf6', text: '#26230f', amber: '#b87a10', cyan: '#0e8ea3', danger: '#c0392b', ok: '#2e8b57' },
};

export const LABELS: Record<ColorKey, string> = {
  accent: 'Accent (buttons, highlights)', bg: 'Page background', panel: 'Panels', text: 'Text',
  amber: 'Warning', cyan: 'Information / Home', danger: 'Stop / danger', ok: 'OK / go',
};

/** Accent presets, each with a version that reads well on dark and on light */
export const ACCENT_PRESETS: { name: string; dark: string; light: string }[] = [
  { name: 'Green', dark: '#6aa84f', light: '#3f7d2c' },
  { name: 'Blue', dark: '#4f8fe0', light: '#2a66b8' },
  { name: 'Teal', dark: '#2bb5a0', light: '#0e8a78' },
  { name: 'Orange', dark: '#e8883a', light: '#b85d14' },
  { name: 'Gold', dark: '#d6b13a', light: '#9a7a10' },
  { name: 'Red', dark: '#e0605a', light: '#b3342d' },
  { name: 'Purple', dark: '#a07ae0', light: '#6f45b8' },
];

export function parseHex(s: unknown): Rgb | undefined {
  if (typeof s !== 'string') return undefined;
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s.trim());
  if (!m) return undefined;
  const h = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
}

export const toHex = (c: Rgb): string => '#' + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');

/** t = 0 gives a, t = 1 gives b */
export const mix = (a: Rgb, b: Rgb, t: number): Rgb => [0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * t) as Rgb;

/** WCAG relative luminance */
export function luminance([r, g, b]: Rgb): number {
  const f = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** WCAG contrast ratio, 1 (none) to 21 (black on white) */
export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Dark or white text, whichever reads better on this colour */
export const readableOn = (bg: Rgb): string => (contrast(bg, [14, 14, 14]) >= contrast(bg, [255, 255, 255]) ? '#0e0e0e' : '#ffffff');

/** Keep only known colours with valid values (anything saved by hand or by an older version is repaired, not trusted) */
export function sanitizeOverrides(raw: unknown): Overrides {
  const out: Overrides = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const k of COLOR_KEYS) {
    const rgb = parseHex((raw as Record<string, unknown>)[k]);
    if (rgb) out[k] = toHex(rgb);
  }
  return out;
}

/** The CSS variables to set for a mode with these overrides. Empty when nothing is overridden. */
export function buildVars(mode: Mode, overrides: Overrides): Record<string, string> {
  const o = sanitizeOverrides(overrides);
  const d = DEFAULTS[mode];
  const vars: Record<string, string> = {};
  const rgb = (k: ColorKey) => parseHex(o[k] ?? d[k])!;
  if (o.accent) { vars['--accent'] = o.accent; vars['--accent-text'] = readableOn(rgb('accent')); }
  for (const k of ['amber', 'cyan', 'danger', 'ok'] as const) if (o[k]) vars[`--${k}`] = o[k]!;
  if (o.bg) vars['--bg'] = o.bg;
  if (o.panel || o.text) {
    // the surfaces between and around panels follow the panel and text colours, so a custom pair stays in proportion
    const panel = rgb('panel'), text = rgb('text');
    if (o.panel) { vars['--panel'] = o.panel; vars['--panel2'] = toHex(mix(panel, text, 0.07)); vars['--line'] = toHex(mix(panel, text, 0.17)); }
    if (o.text) vars['--text'] = o.text;
    vars['--muted'] = toHex(mix(text, panel, 0.38));
    if (o.text && !o.panel) { vars['--panel2'] = toHex(mix(panel, text, 0.07)); vars['--line'] = toHex(mix(panel, text, 0.17)); }
  }
  return vars;
}

/** What is wrong with the chosen colours, in words, or nothing */
export function problems(mode: Mode, overrides: Overrides): string[] {
  const o = sanitizeOverrides(overrides);
  const d = DEFAULTS[mode];
  const c = (k: ColorKey) => parseHex(o[k] ?? d[k])!;
  const out: string[] = [];
  if ((o.text || o.panel) && contrast(c('text'), c('panel')) < 4.5) out.push('The text is hard to read on the panels: pick a lighter or darker text colour.');
  if ((o.text || o.bg) && contrast(c('text'), c('bg')) < 4.5) out.push('The text is hard to read on the page background.');
  if ((o.accent || o.panel) && contrast(c('accent'), c('panel')) < 3) out.push('The accent colour is hard to see against the panels.');
  return out;
}
