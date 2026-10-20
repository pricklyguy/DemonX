import { useEffect, useRef, useState } from 'react';
import type { Laser } from './useLaser';
import { usePositions } from './positionsStore';
import type { SavedPosition } from '../core/positions';
import { NumField } from './NumField';
import { JogPad } from './JogPad';

const MOVE_FEED = 6000; // mm/min asked for; the server caps a rapid move at 100 mm/s

/**
 * Like LightBurn's Move window: the arrows, "Move to Position" with typed X and Y, and the saved positions (add, rename, change,
 * delete, sort). One list per laser, kept on the server. Every move is a rapid with the laser off, pressed twice to go.
 */
export function PositionsPanel({ laser }: { laser: Laser }) {
  const { data, error, save } = usePositions();
  const { state, send } = laser;
  const [armed, setArmed] = useState<string | null>(null); // the Go that was pressed once
  const [tx, setTx] = useState(25), [ty, setTy] = useState(25);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);

  const connected = !!state?.connection.connected;
  const isRuida = state?.kind === 'ruida';
  const key = connected ? state!.connection.target : '';
  const wpos = state?.status.wpos;
  const running = state?.job.state === 'running' || state?.job.state === 'paused';
  const idle = state?.status.state === 'Idle';
  const bedW = state?.workArea?.width ?? 100000, bedH = state?.workArea?.height ?? 100000;
  const list: SavedPosition[] = key ? data.sets[key] ?? [] : [];
  const put = (next: SavedPosition[]) => save({ v: 1, sets: { ...data.sets, [key]: next } });
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const canGo = idle && !running;

  const go = (id: string, x: number, y: number) => {
    if (armed !== id) { setArmed(id); clearTimeout(timer.current); timer.current = setTimeout(() => setArmed(null), 4000); return; }
    setArmed(null);
    send({ type: 'moveTo', x, y, feed: MOVE_FEED });
  };
  const goTitle = running ? 'Not while a job runs' : !idle ? 'The laser is not idle' : 'Move the head there with the laser off (press twice)';
  const goLabel = (id: string) => (armed === id ? 'Move? Press again' : 'Go');

  const addNew = () => {
    let n = list.length + 1;
    while (list.some((p) => p.name === `Position ${n}`)) n++;
    put([...list, { name: `Position ${n}`, x: wpos ? r2(wpos.x) : 25, y: wpos ? r2(wpos.y) : 25 }]);
  };
  const edit = (i: number, patch: Partial<SavedPosition>) => put(list.map((p, k) => (k === i ? { ...p, ...patch } : p)));
  const rename = (i: number, raw: string) => {
    const name = raw.trim();
    if (!name || name === list[i].name || list.some((p, k) => k !== i && p.name === name)) return false;
    edit(i, { name });
    return true;
  };

  return (
    <section className="panel">
      <h2><span>Move</span></h2>
      <div className="body">
        {!connected && <p className="muted small">Connect to a laser (Laser tab) to move the head and keep places for it.</p>}
        {connected && (
          <>
            <div className="mono small pos" aria-label="Head position">Head: X {wpos ? r2(wpos.x) : '–'} · Y {wpos ? r2(wpos.y) : '–'} mm{state?.capabilities?.z && wpos ? <> · Z {r2(wpos.z) >= 0 ? '+' : ''}{r2(wpos.z)} <span className="muted" title="Counted from where Z was when DemonX Design first looked">(since connecting)</span></> : null}</div>
            <JogPad laser={laser} />
            {!isRuida && <p className="muted small">Moving to a typed or saved position works with a Ruida laser for now.</p>}
            {isRuida && (
              <>
                <div className="row wrap" role="group" aria-label="Move to position">
                  <b className="small">Move to</b>
                  <label className="inline small">X <NumField label="Move to X" value={tx} min={0} max={bedW} step={1} width={72} onCommit={setTx} /></label>
                  <label className="inline small">Y <NumField label="Move to Y" value={ty} min={0} max={bedH} step={1} width={72} onCommit={setTy} /></label>
                  <button className="btn small" disabled={!wpos} onClick={() => { if (wpos) { setTx(r2(wpos.x)); setTy(r2(wpos.y)); } }} title="Put the head's position in the boxes">Get position</button>
                  <button className={'btn' + (armed === 'typed' ? ' primary' : '')} disabled={!canGo} onClick={() => go('typed', tx, ty)} aria-label="Go to the typed position" title={goTitle}>{goLabel('typed')}</button>
                </div>

                <div className="row" style={{ marginTop: 6 }}>
                  <b className="small">Saved positions</b>
                  <span className="spacer" />
                  <button className="btn small" onClick={addNew} title="Add a position (at the head's place; change it below)">Add new</button>
                  <button className="btn small" disabled={list.length < 2} onClick={() => put([...list].sort((a, b) => a.name.localeCompare(b.name)))}>Sort by name</button>
                </div>
                {list.length === 0 && <p className="muted small">Nothing saved yet. Press Add new, then give it a name and X and Y. Or move the head, press Get position, and type them in. Star one (☆) to use it as the job origin.</p>}
                <div className="positions" role="list" aria-label="Saved positions">
                  {list.map((p, i) => (
                    <div key={i} className="positions-row" role="listitem">
                      <NameBox value={p.name} onCommit={(v) => rename(i, v)} label={`Name of position ${i + 1}`} />
                      <label className="inline small">X <NumField label={`X of ${p.name}`} value={p.x} min={0} max={bedW} step={1} width={64} onCommit={(v) => edit(i, { x: v })} /></label>
                      <label className="inline small">Y <NumField label={`Y of ${p.name}`} value={p.y} min={0} max={bedH} step={1} width={64} onCommit={(v) => edit(i, { y: v })} /></label>
                      <button className={'btn small' + (p.origin ? ' on' : '')} aria-pressed={!!p.origin} aria-label={`${p.name} is the job origin`} title={p.origin ? 'This is the job origin (Start from: User origin). Press to clear it.' : 'Use this as the job origin: Start from: User origin places the job (and its frame) here'} onClick={() => put(list.map((q, k) => ({ ...q, origin: k === i ? !p.origin : false })).map((q) => (q.origin ? q : { name: q.name, x: q.x, y: q.y })))}>{p.origin ? '★' : '☆'}</button>
                      <button className={'btn small' + (armed === p.name ? ' primary' : '')} disabled={!canGo} onClick={() => go(p.name, p.x, p.y)} aria-label={`Go to ${p.name}`} title={goTitle}>{goLabel(p.name)}</button>
                      <button className="btn small" onClick={() => put(list.filter((_, k) => k !== i))} aria-label={`Delete ${p.name}`} title="Delete this position">✕</button>
                    </div>
                  ))}
                </div>
                <p className="muted small">The head moves with the laser off, at a safe speed, and only inside the work area. Stop works as always. Z (height) is not available yet.</p>
              </>
            )}
          </>
        )}
        {error && <div className="warn small" role="alert">⚠ {error}</div>}
      </div>
    </section>
  );
}

/** A text box that commits on Enter or when it loses focus, and goes back to the saved name when the change is refused */
function NameBox({ value, onCommit, label }: { value: string; onCommit: (v: string) => boolean; label: string }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = () => { if (text !== value && !onCommit(text)) setText(value); };
  return <input className="positions-name" aria-label={label} value={text} maxLength={40} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setText(value); (e.target as HTMLInputElement).blur(); } }} />;
}
