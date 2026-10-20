import { parse, type Font } from 'opentype.js';
import { registerFont, type PathCmd, type TextFont } from './text';

/** Wrap a parsed font file (TrueType, OpenType or WOFF) as a TextFont. Ligatures and other substitutions are not applied. */
export function fontFromBuffer(name: string, buf: ArrayBuffer): TextFont {
  const f: Font = parse(buf);
  const upm = f.unitsPerEm;
  const cap = (f.tables as any)?.os2?.sCapHeight || Math.round(f.ascender * 0.7) || upm * 0.7;
  const cache = new Map<string, { advance: number; commands: PathCmd[] } | null>();
  return {
    name,
    unitsPerEm: upm,
    capHeight: cap,
    glyph(ch) {
      if (cache.has(ch)) return cache.get(ch)!;
      const g = f.charToGlyph(ch);
      let out: { advance: number; commands: PathCmd[] } | null = null;
      if (g && (g.index !== 0 || ch === ' ')) {
        const cmds = g.getPath(0, 0, upm).commands as any[];
        out = { advance: g.advanceWidth ?? 0, commands: cmds.map((c) => ({ ...c, y: c.y === undefined ? undefined : -c.y, y1: c.y1 === undefined ? undefined : -c.y1, y2: c.y2 === undefined ? undefined : -c.y2 })) };
      }
      cache.set(ch, out);
      return out;
    },
    kerning(a, b) {
      try { return f.getKerningValue(f.charToGlyph(a), f.charToGlyph(b)) || 0; } catch { return 0; }
    },
  };
}

export function loadFontBuffer(name: string, buf: ArrayBuffer): TextFont {
  const font = fontFromBuffer(name, buf);
  registerFont(font);
  return font;
}
