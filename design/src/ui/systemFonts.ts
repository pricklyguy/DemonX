import { loadFontBuffer } from '../core/fonts';
import type { TextFont } from '../core/text';

/**
 * The fonts installed on the computer the browser runs on, through the browser's Local Font Access feature (Chrome and Edge, and only on a
 * page opened as localhost or over https, after the person allows it). The page never sees the fonts until they say yes.
 */
interface LocalFont { family: string; fullName: string; postscriptName: string; style: string; blob(): Promise<Blob> }

const fonts = new Map<string, LocalFont>();

/** Is the feature there at all? A short reason when it is not (shown to the person). */
export function systemFontsSupport(): { ok: true } | { ok: false; why: string } {
  const w = window as unknown as { queryLocalFonts?: unknown; isSecureContext: boolean };
  if (typeof w.queryLocalFonts !== 'function') return { ok: false, why: 'This browser cannot list the fonts on the computer (use Chrome or Edge).' };
  if (!w.isSecureContext) return { ok: false, why: 'Chrome and Edge only list the fonts of a page opened as localhost or over https; this page is neither. Use a font file, or serve Design over https (DESIGN_TLS_CERT and DESIGN_TLS_KEY).' };
  return { ok: true };
}

/** Ask for the list of installed fonts (the browser asks the person the first time). Returns the names, sorted. */
export async function querySystemFonts(): Promise<string[]> {
  const list = await (window as unknown as { queryLocalFonts(): Promise<LocalFont[]> }).queryLocalFonts();
  fonts.clear();
  for (const f of list) if (f.fullName && !fonts.has(f.fullName)) fonts.set(f.fullName, f);
  return [...fonts.keys()].sort((a, b) => a.localeCompare(b));
}

/** Has the person already allowed it (so the list can be read without asking again)? */
export async function systemFontsAllowed(): Promise<boolean> {
  try {
    const s = await navigator.permissions.query({ name: 'local-fonts' as PermissionName });
    return s.state === 'granted';
  } catch { return false; }
}

/** The names of the installed fonts the person has already asked for (empty until they have) */
export const systemFontNames = (): string[] => [...fonts.keys()].sort((a, b) => a.localeCompare(b));

export const isSystemFont = (name: string) => fonts.has(name);

/** Read one installed font into the text maker. */
export async function loadSystemFont(name: string): Promise<TextFont> {
  const f = fonts.get(name);
  if (!f) throw new Error(`There is no font called ${name}`);
  const buf = await (await f.blob()).arrayBuffer();
  if (buf.byteLength > 30 * 1024 * 1024) throw new Error('That font file is over 30 MB');
  try {
    return loadFontBuffer(name, buf);
  } catch {
    throw new Error(`${name} could not be read (font collections and some formats are not supported). Pick another font.`);
  }
}
