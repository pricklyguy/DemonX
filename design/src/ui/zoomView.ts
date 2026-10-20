import { useEffect, useRef, type RefObject } from 'react';

/** How a drawing is zoomed and moved on a small canvas: screen = world * k + (ox, oy), in the canvas's own pixels */
export interface View { k: number; ox: number; oy: number }
export const HOME: View = { k: 1, ox: 0, oy: 0 };
const MAX_ZOOM = 80;

/** Zoom by `factor` keeping the point (px, py) of the canvas where it is, like the wheel in LightBurn or VCarve */
export function zoomAt(v: View, px: number, py: number, factor: number): View {
  const k = Math.max(1, Math.min(MAX_ZOOM, v.k * factor));
  if (k === 1) return HOME;
  const f = k / v.k;
  return { k, ox: px - (px - v.ox) * f, oy: py - (py - v.oy) * f };
}

/** Wheel zooms around the pointer, dragging moves the picture, a double click goes back to the whole job */
/** `inPixels`: the canvas is drawn in its own pixels but shown at another size (CSS), so the pointer is converted to canvas pixels */
export function useZoomPan(ref: RefObject<HTMLCanvasElement | null>, view: View, setView: (v: View) => void, inPixels = false) {
  const cur = useRef(view);
  cur.current = view;
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const pos = (e: MouseEvent) => {
      const r = c.getBoundingClientRect();
      const kx = inPixels && r.width ? c.width / r.width : 1, ky = inPixels && r.height ? c.height / r.height : 1;
      return [(e.clientX - r.left) * kx, (e.clientY - r.top) * ky] as const;
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const [x, y] = pos(e);
      setView(zoomAt(cur.current, x, y, Math.exp(-e.deltaY * 0.0015)));
    };
    let drag: { x: number; y: number } | null = null;
    const down = (e: MouseEvent) => { if (e.button === 0) { const [x, y] = pos(e); drag = { x, y }; c.style.cursor = 'grabbing'; } };
    const move = (e: MouseEvent) => {
      if (!drag) return;
      const [x, y] = pos(e);
      const v = cur.current;
      if (v.k > 1) setView({ k: v.k, ox: v.ox + x - drag.x, oy: v.oy + y - drag.y });
      drag = { x, y };
    };
    const up = () => { drag = null; c.style.cursor = ''; };
    const dbl = () => setView(HOME);
    c.addEventListener('wheel', wheel, { passive: false });
    c.addEventListener('mousedown', down);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    c.addEventListener('dblclick', dbl);
    return () => {
      c.removeEventListener('wheel', wheel);
      c.removeEventListener('mousedown', down);
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      c.removeEventListener('dblclick', dbl);
    };
  }, [ref, setView, inPixels]);
}
