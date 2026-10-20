// The small part of opentype.js that Design uses.
declare module 'opentype.js' {
  export interface Glyph { index: number; advanceWidth?: number; getPath(x: number, y: number, fontSize: number): { commands: unknown[] } }
  export interface Font {
    unitsPerEm: number;
    ascender: number;
    tables: unknown;
    charToGlyph(ch: string): Glyph;
    getKerningValue(a: Glyph, b: Glyph): number;
  }
  export function parse(buffer: ArrayBuffer): Font;
}
