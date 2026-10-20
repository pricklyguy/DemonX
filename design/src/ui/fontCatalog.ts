import { getFont, type TextFont } from '../core/text';
import { loadFontBuffer } from '../core/fonts';
import { isSystemFont, loadSystemFont } from './systemFonts';
import robotoRegular from '@fontsource/roboto/files/roboto-latin-400-normal.woff?url';
import robotoBold from '@fontsource/roboto/files/roboto-latin-700-normal.woff?url';
import robotoMono from '@fontsource/roboto-mono/files/roboto-mono-latin-400-normal.woff?url';
import oswald from '@fontsource/oswald/files/oswald-latin-400-normal.woff?url';
import bebas from '@fontsource/bebas-neue/files/bebas-neue-latin-400-normal.woff?url';
import pacifico from '@fontsource/pacifico/files/pacifico-latin-400-normal.woff?url';

/** Fonts that ship with the app (SIL Open Font Licence, via Fontsource). Each is fetched the first time it is used. */
export const BUILT_IN_FONTS: Record<string, string> = {
  'Roboto Bold': robotoBold,
  Roboto: robotoRegular,
  'Roboto Mono': robotoMono,
  Oswald: oswald,
  'Bebas Neue': bebas,
  Pacifico: pacifico,
};

export async function ensureFont(name: string): Promise<TextFont> {
  const have = getFont(name);
  if (have) return have;
  if (isSystemFont(name)) return loadSystemFont(name);
  const url = BUILT_IN_FONTS[name];
  if (!url) throw new Error(`There is no font called ${name}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load the font ${name}`);
  return loadFontBuffer(name, await res.arrayBuffer());
}

/** A font file the user picked (.ttf, .otf or .woff). It is named after the file and lives until the page is closed. */
export async function loadFontFile(file: File): Promise<TextFont> {
  if (file.size > 20 * 1024 * 1024) throw new Error('That font file is over 20 MB');
  const name = file.name.replace(/\.(ttf|otf|woff)$/i, '');
  try {
    return loadFontBuffer(name, await file.arrayBuffer());
  } catch {
    throw new Error('Could not read that font. Use a .ttf, .otf or .woff file (not .woff2).');
  }
}
