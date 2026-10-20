import type { Doc } from './types';
import { shapeBounds, unionBounds, shapeClosed } from './geom';

const r = (v: number) => String(Math.round(v * 1000) / 1000);
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

/** SVG in millimetres (width/height carry the unit, one user unit = 1 mm). Y is flipped so the picture matches the screen. */
export function exportSvg(doc: Doc): string {
  const b = unionBounds(doc.shapes.map(shapeBounds)) ?? { minX: 0, minY: 0, maxX: 10, maxY: 10 };
  const m = 1;
  const w = b.maxX - b.minX + 2 * m;
  const h = b.maxY - b.minY + 2 * m;
  const out: string[] = [];
  out.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${r(w)}mm" height="${r(h)}mm" viewBox="${r(b.minX - m)} ${r(-b.maxY - m)} ${r(w)} ${r(h)}">`);
  out.push(`<g transform="scale(1,-1)" fill="none" stroke-width="0.1" stroke-linejoin="round">`);
  for (const layer of doc.layers) {
    const shapes = doc.shapes.filter((s) => s.layer === layer.name);
    if (!shapes.length) continue;
    out.push(`<g id="${esc(layer.name)}" stroke="${esc(layer.color)}" data-mode="${layer.mode}" data-speed="${layer.speed}" data-power="${layer.power}" data-passes="${layer.passes}" data-output="${layer.output}" data-air="${layer.air}" data-interval="${layer.interval}">`);
    for (const s of shapes) {
      if (s.kind === 'circle') {
        out.push(`<circle cx="${r(s.cx)}" cy="${r(s.cy)}" r="${r(s.r)}"/>`);
        continue;
      }
      const d = s.rings
        .filter((ring) => ring.length > 1)
        .map((ring) => 'M' + ring.map(([x, y]) => `${r(x)} ${r(y)}`).join('L') + (shapeClosed(s) ? 'Z' : ''))
        .join('');
      out.push(`<path fill-rule="evenodd" d="${d}"/>`);
    }
    out.push(`</g>`);
  }
  out.push(`</g>`, `</svg>`);
  return out.join('\n') + '\n';
}

