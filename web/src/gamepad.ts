import { useCallback, useEffect, useRef, useState } from 'react';
import { PadSession, SPEED_DEFAULT, SPEED_MAX, SPEED_MIN, type PadAction } from '../../shared/gamepad';
import type { Machine } from './useMachine';
import { holdBus, stopAllJogging } from './holdJog';

// Reads a gamepad (the browser's Gamepad API) about ten times a second and sends hold-to-jog messages. What the sticks mean and
// when they may move the machine is decided in shared/gamepad.ts; the server adds its own stops (server/src/jogHold.ts).
// The setting lives in this browser only and is off until turned on in Settings > Gamepad.

const KEY = 'gamepad';
interface Saved { enabled: boolean; speed: number }

function load(): Saved {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    const speed = Number(raw?.speed);
    return { enabled: raw?.enabled === true, speed: Number.isFinite(speed) ? Math.max(SPEED_MIN, Math.min(SPEED_MAX, speed)) : SPEED_DEFAULT };
  } catch { return { enabled: false, speed: SPEED_DEFAULT }; }
}

const savedNum = (key: string, initial: number) => { const n = Number(localStorage.getItem(key)); return n > 0 ? n : initial; };

export interface PadState {
  supported: boolean;
  enabled: boolean;
  speed: number;
  /** The name of the pad in use, if one is connected */
  name?: string;
  armed: boolean;
  setEnabled: (on: boolean) => void;
  setSpeed: (speed: number) => void;
}

export function useGamepad(m: Machine): PadState {
  const supported = typeof navigator !== 'undefined' && 'getGamepads' in navigator;
  const [saved, setSaved] = useState<Saved>(load);
  const [name, setName] = useState<string | undefined>();
  const [armed, setArmed] = useState(false);
  const session = useRef(new PadSession());
  const latest = useRef({ m, saved });
  latest.current = { m, saved };

  const update = useCallback((f: (s: Saved) => Saved) => setSaved((s) => {
    const n = f(s);
    try { localStorage.setItem(KEY, JSON.stringify(n)); } catch { /* not saved in private mode */ }
    return n;
  }), []);

  useEffect(() => {
    if (!supported) return;
    const run = (actions: PadAction[]) => {
      const { m: mm } = latest.current;
      for (const a of actions) {
        if (a.type === 'hold') holdBus.set('pad', { x: a.x, y: a.y, z: a.z });
        else if (a.type === 'release') holdBus.set('pad', null);
        else if (a.type === 'stop') { stopAllJogging(); mm.send({ type: 'hold' }); }
        else update((s) => ({ ...s, speed: a.speed }));
      }
    };
    const lost = () => { run(session.current.lost()); setArmed(false); };
    const look = () => {
      const { m: mm, saved: sv } = latest.current;
      const pad = [...(navigator.getGamepads?.() ?? [])].find((p) => p && p.connected) ?? null;
      setName((old) => (pad?.id === old ? old : pad?.id));
      const busy = mm.job.state === 'running' || mm.job.state === 'paused';
      const bad = mm.status.state === 'Alarm' || mm.status.state.startsWith('Door');
      const allowed = mm.online && mm.auth.operator && mm.connection.connected && !busy && !bad;
      const actions = session.current.update({
        active: sv.enabled && !!pad,
        focused: document.hasFocus() && !document.hidden,
        allowed,
        axes: pad ? [...pad.axes] : [],
        buttons: pad ? pad.buttons.map((b) => b.pressed) : [],
      }, { speed: sv.speed, xyFeed: savedNum('jogFeedXY', 3000), zFeed: savedNum('jogZFeed', 300) });
      run(actions);
      setArmed(session.current.armed);
    };
    const timer = setInterval(look, 100);
    // anything that takes the pad (or the page) away stops the machine at once, without waiting for the next look
    window.addEventListener('blur', lost);
    window.addEventListener('beforeunload', lost);
    window.addEventListener('gamepaddisconnected', lost);
    document.addEventListener('visibilitychange', lost);
    return () => {
      clearInterval(timer);
      window.removeEventListener('blur', lost);
      window.removeEventListener('beforeunload', lost);
      window.removeEventListener('gamepaddisconnected', lost);
      document.removeEventListener('visibilitychange', lost);
      lost();
    };
  }, [supported, update]);

  // turning it off in Settings stops and disarms too
  useEffect(() => {
    if (!saved.enabled) { session.current.lost(); holdBus.set('pad', null); setArmed(false); }
  }, [saved.enabled]);

  return {
    supported, enabled: saved.enabled, speed: saved.speed, name: saved.enabled ? name : undefined, armed: saved.enabled && armed,
    setEnabled: (on) => update((s) => ({ ...s, enabled: on })),
    setSpeed: (speed) => update((s) => ({ ...s, speed: Math.max(SPEED_MIN, Math.min(SPEED_MAX, Math.round(speed))) })),
  };
}
