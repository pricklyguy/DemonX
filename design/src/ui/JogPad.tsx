import { useEffect, useState } from 'react';
import type { Laser } from './useLaser';
import { NumField } from './NumField';
import { useJogSettings, Z_STEP_CHOICES } from './jogSettings';

const STEPS = [0.1, 1, 10, 50];

/** The arrow buttons that move the head (laser off): one step per press, at the chosen speed */
export function JogPad({ laser }: { laser: Laser }) {
  const { state, send } = laser;
  const { step, setStep, speed, setSpeed, zStep, setZStep, zSpeed, setZSpeed } = useJogSettings();
  const hasZ = state?.capabilities?.z === true;
  const [focusArmed, setFocusArmed] = useState(false);
  useEffect(() => { if (!focusArmed) return; const id = setTimeout(() => setFocusArmed(false), 4000); return () => clearTimeout(id); }, [focusArmed]);
  const isRuida = state?.kind === 'ruida';
  const running = state?.job.state === 'running' || state?.job.state === 'paused';
  const idle = state?.status.state === 'Idle';
  const off = !state?.connection.connected || running || !idle;
  const jog = (dx: number, dy: number) => send({ type: 'jog', dx, dy, feed: speed });
  const jogZ = (dz: number) => send({ type: 'jogZ', dz, feed: zSpeed });
  return (
    <div className="jog">
      <div className="jogpad" role="group" aria-label="Jog">
        <span /><button className="btn" disabled={off} onClick={() => jog(0, step)} aria-label="Jog Y plus" title={isRuida ? 'Move the head toward the rear' : 'Move the head back (Y+)'}>▲</button><span />
        <button className="btn" disabled={off} onClick={() => jog(-step, 0)} aria-label="Jog X minus" title="Move left (X−)">◀</button>
        <button className="btn" disabled={off || isRuida} onClick={() => send({ type: 'goOrigin', feed: speed })} aria-label="Go to work zero" title={isRuida ? 'A Ruida job starts where the head is: there is no work zero' : 'Go to work zero (laser off)'}>⌖</button>
        <button className="btn" disabled={off} onClick={() => jog(step, 0)} aria-label="Jog X plus" title="Move right (X+)">▶</button>
        <span /><button className="btn" disabled={off} onClick={() => jog(0, -step)} aria-label="Jog Y minus" title={isRuida ? 'Move the head toward the front' : 'Move the head forward (Y−)'}>▼</button><span />
      </div>
      <div className="jogopts">
        <div className="steps" role="radiogroup" aria-label="Step">
          {STEPS.map((s) => <button key={s} role="radio" aria-checked={step === s} className={'btn small' + (step === s ? ' on' : '')} onClick={() => setStep(s)}>{s}</button>)}
          <span className="muted small">mm</span>
        </div>
        <label className="inline small">Speed <NumField label="Jog and frame speed" value={speed} min={1} max={10000} step={100} width={80} onCommit={setSpeed} /> mm/min</label>
      </div>
      {hasZ && (
        <div className="jogz" role="group" aria-label="Z">
          <button className="btn" disabled={off} onClick={() => jogZ(zStep)} aria-label="Jog Z plus" title="Raise the Z number by one step (laser off). Which way that moves the table or the head is for you to check at the machine: try 0.1 mm first.">Z+</button>
          <button className="btn" disabled={off} onClick={() => jogZ(-zStep)} aria-label="Jog Z minus" title="Lower the Z number by one step (laser off)">Z−</button>
          <div className="steps" role="radiogroup" aria-label="Z step">
            {Z_STEP_CHOICES.map((s) => <button key={s} role="radio" aria-checked={zStep === s} className={'btn small' + (zStep === s ? ' on' : '')} onClick={() => setZStep(s)}>{s}</button>)}
            <span className="muted small">mm</span>
          </div>
          <button className={'btn small' + (focusArmed ? ' primary' : '')} disabled={off} onClick={() => { if (!focusArmed) { setFocusArmed(true); return; } setFocusArmed(false); send({ type: 'autoFocus' }); }} aria-label="Auto focus" title="The controller's own auto focus (the same command as LightBurn's button). Z moves by itself: press twice.">{focusArmed ? 'Press again' : 'Auto focus'}</button>
          <label className="inline small">Z speed <NumField label="Z speed" value={zSpeed} min={1} max={600} step={10} width={64} onCommit={setZSpeed} /> mm/min</label>
        </div>
      )}
    </div>
  );
}
