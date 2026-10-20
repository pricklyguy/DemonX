import { useEffect, useMemo, useRef, useState } from 'react';
import type { Move } from '../core/laser';
import { clock, type Estimate } from '../core/jobEstimate';
import { HOME, useZoomPan, type View } from './zoomView';

const PLAY_SECONDS = 20; // the play-back of any job takes about this long at 1x

/** LightBurn-style preview: the burn path, the travel moves, the distances and times, and a play-back. */
export function JobPreview({ moves, est, onClose }: { moves: Move[]; est: Estimate; onClose: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [showTravel, setShowTravel] = useState(false);
  const [t, setT] = useState(est.totalSeconds); // seconds into the job; the whole job is shown at first
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const total = est.totalSeconds || 1;
  const [view, setView] = useState<View>(HOME);
  useZoomPan(ref, view, setView);

  const box = useMemo(() => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const m of moves) { minX = Math.min(minX, m.x0, m.x1); maxX = Math.max(maxX, m.x0, m.x1); minY = Math.min(minY, m.y0, m.y1); maxY = Math.max(maxY, m.y0, m.y1); }
    return { minX, minY, maxX, maxY };
  }, [moves]);

  // how many moves are done at time t
  const upTo = useMemo(() => {
    let lo = 0, hi = est.at.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (est.at[mid] <= t) lo = mid + 1; else hi = mid; }
    return lo;
  }, [est, t]);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const pad = 20;
    const bw = Math.max(box.maxX - box.minX, 1e-6), bh = Math.max(box.maxY - box.minY, 1e-6);
    const sc = Math.min((w - 2 * pad) / bw, (h - 2 * pad) / bh);
    const ox = (w - bw * sc) / 2, oy = (h - bh * sc) / 2;
    const X = (x: number) => (ox + (x - box.minX) * sc) * view.k + view.ox;
    const Y = (y: number) => (h - (oy + (y - box.minY) * sc)) * view.k + view.oy; // drawing Y points up
    const stroke = (pick: (m: Move) => boolean, colour: string, width: number) => {
      g.beginPath();
      for (let i = 0; i < upTo; i++) { const m = moves[i]; if (!pick(m)) continue; g.moveTo(X(m.x0), Y(m.y0)); g.lineTo(X(m.x1), Y(m.y1)); }
      g.strokeStyle = colour; g.lineWidth = width; g.stroke();
    };
    if (showTravel) stroke((m) => !m.burn, '#c08080', 1);
    stroke((m) => m.burn, '#202020', Math.max(1, Math.min(3, 0.4 * sc * view.k)));
    // the head
    if (upTo > 0) { const m = moves[upTo - 1]; g.fillStyle = '#e03030'; g.beginPath(); g.arc(X(m.x1), Y(m.y1), 4, 0, 7); g.fill(); }
  }, [moves, box, upTo, showTravel, view]);

  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    let id = 0;
    const tick = (now: number) => {
      const dt = (now - last) / 1000; last = now;
      setT((cur) => { const n = cur + dt * (total / PLAY_SECONDS) * rate; if (n >= total) { setPlaying(false); return total; } return n; });
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [playing, rate, total]);

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal preview" role="dialog" aria-modal="true" aria-label="Job preview">
        <h2>Preview</h2>
        <div className="preview-stage">
          <canvas ref={ref} aria-label="Burn path" />
          <div className="preview-legend"><span><i style={{ background: '#202020' }} /> Cut</span><span><i style={{ background: '#c08080' }} /> Move</span></div>
        </div>
        <input type="range" aria-label="Position in the job" min={0} max={total} step={total / 1000} value={t} onChange={(e) => { setPlaying(false); setT(Number(e.target.value)); }} />
        <div className="mono small" aria-live="polite">
          Cut distance: {Math.round(est.cutMm)} mm (~{clock(est.cutSeconds)}) · Rapid moves: {Math.round(est.rapidMm)} mm (~{clock(est.rapidSeconds)}) · <b>Total time estimated: {clock(est.totalSeconds)}</b>
        </div>
        <div className="row wrap">
          <label className="inline small"><input type="checkbox" checked={showTravel} onChange={(e) => setShowTravel(e.target.checked)} /> Show traversal moves</label>
          <label className="inline small">Speed
            <select value={rate} aria-label="Play-back speed" onChange={(e) => setRate(Number(e.target.value))}>
              {[0.25, 0.5, 1, 2, 5, 10].map((r) => <option key={r} value={r}>{r}×</option>)}
            </select>
          </label>
          <span className="mono small" style={{ marginLeft: 'auto' }}>{clock(t)}</span>
          <button className="btn" onClick={() => { if (!playing && t >= total) setT(0); setPlaying(!playing); }}>{playing ? 'Pause' : 'Play'}</button>
          <button className="btn primary" onClick={onClose}>OK</button>
        </div>
        <p className="muted small">Mouse wheel zooms, drag moves the picture, double-click shows the whole job. The time is an estimate. It is tuned to one machine (a Pronto 45) from two timed fills; other machines will be less accurate until they are timed too.</p>
      </div>
    </div>
  );
}
