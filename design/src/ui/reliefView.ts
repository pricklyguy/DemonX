import { useMemo } from 'react';
import { reliefCells, reliefHeightMm, reliefShade, type Relief } from '../core/relief';

export interface ReliefPicture { img: HTMLCanvasElement; x: number; y: number; width: number; height: number }

const hexRgb = (hex: string): [number, number, number] => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const v = m ? parseInt(m[1], 16) : 0xc9a46c;
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};

/** The shaded pictures of the visible 3D shapes, made again only when a shape or the colour changes. */
export function useReliefPictures(reliefs: Relief[] | undefined, colour: string): ReliefPicture[] {
  return useMemo(() => (reliefs ?? []).filter((r) => r.visible).map((r) => {
    const img = document.createElement('canvas');
    img.width = r.w; img.height = r.h;
    const ctx = img.getContext('2d')!;
    const px = reliefShade(r, reliefCells(r), hexRgb(colour));
    ctx.putImageData(new ImageData(px as unknown as Uint8ClampedArray<ArrayBuffer>, r.w, r.h), 0, 0);
    return { img, x: r.x, y: r.y, width: r.width, height: reliefHeightMm(r) };
  }), [reliefs, colour]);
}
