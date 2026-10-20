import { useEffect, useMemo, useRef, useState } from 'react';
import { previewMoves, simFrame, type PMove, type SimFrame } from '../core/cncpreview';

const KEY = 'design-cnc-colours';
export interface CncColours { cut: string; rapid: string; material: string }
export const DEFAULT_COLOURS: CncColours = { cut: '#ffb000', rapid: '#8a8a8a', material: '#c9a46c' };
const HEX = /^#[0-9a-f]{6}$/i;
const read = (): CncColours => {
  try {
    const j = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return { cut: HEX.test(j.cut) ? j.cut : DEFAULT_COLOURS.cut, rapid: HEX.test(j.rapid) ? j.rapid : DEFAULT_COLOURS.rapid, material: HEX.test(j.material) ? j.material : DEFAULT_COLOURS.material };
  } catch { return { ...DEFAULT_COLOURS }; }
};

export type PreviewMode = 'off' | 'all' | 'selected';
/** The seconds the whole animation takes at 1x. */
const BASE_SECONDS = 20;
export const SIM_SPEEDS = [0.5, 1, 2, 5, 10];

export interface CncView {
  mode: PreviewMode;
  chosen: number[];
  colours: CncColours;
  setColours: (c: CncColours) => void;
  previewAll: () => void;
  previewSelected: () => void;
  reset: () => void;
  toggleChosen: (id: number) => void;
  moves: PMove[];
  sim: { t: number; playing: boolean; speed: number; frame: SimFrame | null };
  play: () => void;
  pause: () => void;
  seek: (t: number) => void;
  setSpeed: (s: number) => void;
}

/** What the CNC tab previews (all toolpaths, the chosen ones, or nothing), its colours, and the animated simulation. */
export function useCncView(built: { tp: { id: number }; result: { moves: import('../core/post').Move3[] } }[]): CncView {
  const [mode, setMode] = useState<PreviewMode>('all');
  const [chosen, setChosen] = useState<number[]>([]);
  const [colours, setColoursState] = useState<CncColours>(read);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const ids = mode === 'selected' ? chosen : null;
  const moves = useMemo(() => (mode === 'off' ? [] : previewMoves(built, ids)), [built, mode, ids?.join(',')]);   // eslint-disable-line react-hooks/exhaustive-deps
  const frame = useMemo(() => (t > 0 || playing ? simFrame(moves, t) : null), [moves, t, playing]);
  const raf = useRef(0);
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    const step = (now: number) => {
      const dt = (now - last) / 1000; last = now;
      setT((cur) => {
        const n = cur + (dt * speed) / BASE_SECONDS;
        if (n >= 1) { setPlaying(false); return 1; }
        return n;
      });
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [playing, speed]);
  // a changed design or a different set of toolpaths starts the animation over
  useEffect(() => { setT(0); setPlaying(false); }, [moves]);
  const stop = () => { setPlaying(false); setT(0); };
  return {
    mode, chosen, colours, moves,
    setColours: (c) => { setColoursState(c); try { localStorage.setItem(KEY, JSON.stringify(c)); } catch { /* storage blocked */ } },
    previewAll: () => { stop(); setMode('all'); },
    previewSelected: () => { stop(); setMode('selected'); },
    reset: () => { stop(); setMode('off'); },
    toggleChosen: (id) => setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id])),
    sim: { t, playing, speed, frame },
    play: () => { if (mode === 'off') setMode('all'); if (t >= 1) setT(0); setPlaying(true); },
    pause: () => setPlaying(false),
    seek: (v) => { setPlaying(false); setT(Math.min(1, Math.max(0, v))); },
    setSpeed,
  };
}
