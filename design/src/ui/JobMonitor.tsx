import { useEffect, useMemo, useRef, useState } from 'react';
import type { Move } from '../core/laser';
import { clock, type Estimate } from '../core/jobEstimate';
import { CameraImage, fetchCameraStatus } from './CameraCard';
import { HOME, useZoomPan, type View } from './zoomView';

/** What the monitor needs to know about the job it is watching, fixed at the moment Start was pressed. */
export interface MonitorJob {
  moves: Move[];
  est: Estimate;
  /** Where the head was when the job started, in the controller's coordinates (mm from the rear-left corner) */
  start: { x: number; y: number };
}

interface Live {
  jobState: string;
  elapsedMs: number;
  /** The head, in the controller's coordinates */
  head: { x: number; y: number } | null;
}

const segDist = (px: number, py: number, m: Move): number => {
  const dx = m.x1 - m.x0, dy = m.y1 - m.y0;
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - m.x0) * dx + (py - m.y0) * dy) / l2));
  return Math.hypot(px - (m.x0 + t * dx), py - (m.y0 + t * dy));
};

/**
 * Where in the job the head probably is. The controller does not say, so this matches the head's position to the planned path,
 * only ever moving forward and only looking near where the clock says the job should be. It is a general idea, not a measurement.
 */
export function findProgress(job: MonitorJob, head: { x: number; y: number }, elapsedS: number, from: number): number {
  const { moves, est } = job;
  const hx = head.x - job.start.x, hy = -(head.y - job.start.y); // the plan is in the drawing's orientation (Y up)
  const lo = Math.max(from, firstAfter(est.at, Math.max(0, elapsedS * 0.6 - 20)));
  const hi = Math.min(moves.length, firstAfter(est.at, elapsedS * 1.6 + 30) + 1);
  let best = -1, bestD = Infinity;
  for (let i = lo; i < hi; i++) {
    const d = segDist(hx, hy, moves[i]);
    if (d < bestD - 1e-6) { bestD = d; best = i; }
  }
  return best < 0 ? from : best;
}

const firstAfter = (at: Float64Array, t: number): number => {
  let lo = 0, hi = at.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (at[mid] < t) lo = mid + 1; else hi = mid; }
  return lo;
};

/** A small card, not a window that blocks the screen: the job's path, the head and its trail, progress and time. Stop is always here. */
export function JobMonitor({ job, live, onStop, onClose, docked = false }: { job: MonitorJob; live: Live; onStop: () => void; onClose: () => void; /** shown in the Monitor tab instead of floating; `onClose` then pops it out into its own card */ docked?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const base = useRef<HTMLCanvasElement | null>(null);
  const done = useRef<{ canvas: HTMLCanvasElement; upTo: number } | null>(null);
  const trail = useRef<[number, number][]>([]);
  const [idx, setIdx] = useState(0);
  // zoom: `view` follows the wheel at once; the drawn layers are rebuilt sharp for `settled` shortly after it stops
  const [view, setView] = useState<View>(HOME);
  const [settled, setSettled] = useState<View>(HOME);
  useZoomPan(ref, view, setView, true);
  useEffect(() => { const id = setTimeout(() => setSettled(view), 150); return () => clearTimeout(id); }, [view]);
  const lastIdx = useRef(0);
  const W = 380, H = 300;
  // the camera, when one is set up and the box is ticked (remembered on this computer)
  const [camReady, setCamReady] = useState(false);
  const [withCam, setWithCam] = useState(() => { try { return localStorage.getItem('design-monitor-camera') === '1'; } catch { return false; } });
  useEffect(() => { void fetchCameraStatus().then((s) => setCamReady(!!s?.configured)); }, []);
  const toggleCam = (v: boolean) => { setWithCam(v); try { localStorage.setItem('design-monitor-camera', v ? '1' : '0'); } catch { /* not remembered */ } };

  const box = useMemo(() => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const m of job.moves) { minX = Math.min(minX, m.x0, m.x1); maxX = Math.max(maxX, m.x0, m.x1); minY = Math.min(minY, m.y0, m.y1); maxY = Math.max(maxY, m.y0, m.y1); }
    const pad = 10;
    const sc = Math.min((W - 2 * pad) / Math.max(maxX - minX, 1e-6), (H - 2 * pad) / Math.max(maxY - minY, 1e-6));
    return { sc, X: (x: number) => pad + (x - minX) * sc, Y: (y: number) => H - pad - (y - minY) * sc };
  }, [job]);

  // a new job starts from the whole picture
  useEffect(() => {
    trail.current = [];
    lastIdx.current = 0;
    setIdx(0);
    setView(HOME); setSettled(HOME);
  }, [job, box]);

  // the planned path (faint) and the part already burnt, drawn for the view the picture has settled on
  useEffect(() => {
    const mk = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; return c; };
    const lw = Math.max(1, Math.min(3, 0.4 * box.sc * settled.k));
    const layer = (c: HTMLCanvasElement, from: number, to: number, colour: string, only: boolean) => {
      const g = c.getContext('2d')!;
      g.setTransform(settled.k, 0, 0, settled.k, settled.ox, settled.oy);
      g.beginPath();
      for (let i = from; i < to && i < job.moves.length; i++) { const m = job.moves[i]; if (m.burn || !only) { g.moveTo(box.X(m.x0), box.Y(m.y0)); g.lineTo(box.X(m.x1), box.Y(m.y1)); } }
      g.strokeStyle = colour; g.lineWidth = lw / settled.k; g.stroke();
    };
    const b = mk();
    layer(b, 0, job.moves.length, 'rgba(120,120,120,0.45)', true);
    base.current = b;
    const d = mk();
    layer(d, 0, lastIdx.current + 1, '#d8553b', true);
    done.current = { canvas: d, upTo: lastIdx.current + 1 };
    setIdx((n) => n);
  }, [job, box, settled]);

  // each new head position: add to the trail and work out where in the path it is
  useEffect(() => {
    if (!live.head) return;
    const t = trail.current;
    const hx = live.head.x - job.start.x, hy = -(live.head.y - job.start.y);
    if (!t.length || Math.hypot(t[t.length - 1][0] - hx, t[t.length - 1][1] - hy) > 0.3) { t.push([hx, hy]); if (t.length > 40) t.splice(0, t.length - 40); }
    const running = live.jobState === 'running' || live.jobState === 'paused';
    if (running) {
      const i = findProgress(job, live.head, live.elapsedMs / 1000, lastIdx.current);
      lastIdx.current = i; setIdx(i);
    }
  }, [live.head?.x, live.head?.y]);

  useEffect(() => {
    const c = ref.current, b = base.current, d = done.current;
    if (!c || !b || !d) return;
    const g = c.getContext('2d')!;
    // the part of the path already burnt, added to as the head moves on
    const dg = d.canvas.getContext('2d')!;
    dg.setTransform(settled.k, 0, 0, settled.k, settled.ox, settled.oy);
    dg.beginPath();
    for (let i = d.upTo; i <= idx && i < job.moves.length; i++) { const m = job.moves[i]; if (m.burn) { dg.moveTo(box.X(m.x0), box.Y(m.y0)); dg.lineTo(box.X(m.x1), box.Y(m.y1)); } }
    dg.strokeStyle = '#d8553b'; dg.lineWidth = Math.max(1, Math.min(3, 0.4 * box.sc * settled.k)) / settled.k; dg.stroke();
    d.upTo = Math.max(d.upTo, idx + 1);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);
    // the layers were drawn for `settled`; while the wheel is still turning they are scaled to the current view
    const r = view.k / settled.k;
    g.setTransform(r, 0, 0, r, view.ox - r * settled.ox, view.oy - r * settled.oy);
    g.drawImage(b, 0, 0); g.drawImage(d.canvas, 0, 0);
    g.setTransform(view.k, 0, 0, view.k, view.ox, view.oy);
    // the last few positions of the head, short so it never hides what was done
    const t = trail.current;
    if (t.length) {
      g.beginPath(); t.forEach(([x, y], i) => (i ? g.lineTo(box.X(x), box.Y(y)) : g.moveTo(box.X(x), box.Y(y))));
      g.strokeStyle = 'rgba(40,160,220,0.8)'; g.lineWidth = 1 / view.k; g.stroke();
      const [hx, hy] = t[t.length - 1];
      g.fillStyle = '#2aa0e0'; g.beginPath(); g.arc(box.X(hx), box.Y(hy), 4 / view.k, 0, 7); g.fill();
    }
  }, [idx, live.head?.x, live.head?.y, box, job, view, settled]);

  const total = job.est.totalSeconds || 1;
  const elapsed = live.elapsedMs / 1000;
  const doneAt = idx > 0 ? job.est.at[Math.min(idx, job.est.at.length - 1)] : 0;
  const running = live.jobState === 'running' || live.jobState === 'paused';
  const finished = live.jobState === 'done';
  const pct = finished ? 100 : Math.max(0, Math.min(99, Math.round((doneAt / total) * 100)));
  // how fast the real job is going compared with the estimate, to say how long is left
  const pace = doneAt > 20 && elapsed > 20 ? elapsed / doneAt : 1;
  const left = finished ? 0 : Math.max(0, (total - doneAt) * pace);

  return (
    <div className={'monitor' + (docked ? ' docked' : '')} role="region" aria-label="Job monitor">
      <div className="monitor-head">
        <b>Monitor</b>
        <span className="muted small">{finished ? 'finished' : live.jobState === 'paused' ? 'paused' : running ? 'running' : live.jobState}</span>
        {docked
          ? <button className="btn small" style={{ marginLeft: 'auto' }} onClick={onClose} aria-label="Open the monitor in its own card" title="Show the monitor as a card over the drawing">Pop out</button>
          : <button className="btn small" style={{ marginLeft: 'auto' }} onClick={onClose} aria-label="Close the monitor" title="Close the card: the monitor stays in the Monitor tab (the job keeps running)">✕ to tab</button>}
      </div>
      <canvas ref={ref} width={W} height={H} aria-label="Where the head is in the job" title="Mouse wheel zooms, drag moves, double-click shows the whole job" />
      {camReady && <label className="inline small"><input type="checkbox" checked={withCam} onChange={(e) => toggleCam(e.target.checked)} /> Include the camera</label>}
      {camReady && withCam && <CameraImage />}
      <div className="monitor-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}><i style={{ width: pct + '%' }} /></div>
      <div className="mono small" aria-live="polite">
        {pct}% · {clock(elapsed)} so far · about {clock(left)} left · estimated {clock(total)}
      </div>
      <div className="muted small">The controller does not report progress: this is worked out from the head's position, and is a general idea.</div>
      <button className="btn danger" onClick={onStop} disabled={!running}>Stop</button>
    </div>
  );
}
