import { useEffect } from 'react';
import { Gesture, HoldBus } from '../../shared/holdjog';
import type { Machine } from './useMachine';

// One place that turns presses (Jog panel buttons, keyboard keys) and the gamepad into jog messages: a tap is one step, a hold keeps
// moving while it is held. See shared/holdjog.ts for how, and server/src/jogHold.ts for the stops on the server side.

export const holdBus = new HoldBus();
const num = (key: string, fallback: number) => Number(localStorage.getItem(key)) || fallback;

export const jogGesture = new Gesture(holdBus, {
  tap: (d) => {
    const xy = d.x !== 0 || d.y !== 0;
    holdBus.sender({
      type: 'jog',
      ...(d.x ? { dx: d.x * num('jogStep', 1) } : {}), ...(d.y ? { dy: d.y * num('jogStep', 1) } : {}), ...(d.z ? { dz: d.z * num('jogZStep', 1) } : {}),
      feed: xy ? num('jogFeedXY', 3000) : num('jogZFeed', 300),
    });
  },
  speeds: () => ({ xy: num('jogFeedXY', 3000), z: num('jogZFeed', 300) }),
});

/** Which pointer (finger or mouse) is holding which button, so a lift elsewhere on the page only lets go of its own button */
export const heldBy = new Map<string, number>();

const TOUCH_HOLD_KEY = 'jogTouchHold';
/** Whether a held finger on a Jog button keeps the machine moving (off by default: see Settings > Jog buttons) */
export function touchHoldOn(): boolean { try { return localStorage.getItem(TOUCH_HOLD_KEY) === '1'; } catch { return false; } }
export function setTouchHold(on: boolean) { try { localStorage.setItem(TOUCH_HOLD_KEY, on ? '1' : '0'); } catch { /* not saved in private mode */ } }

/** Let go of everything now */
export function stopAllJogging() { jogGesture.cancelAll(); holdBus.releaseAll(); heldBy.clear(); }

/** Whether this browser may jog right now (signed in, connected, no job running) */
export const canJog = (m: Machine) => {
  const st = m.status.state;
  // the same states the server refuses a held jog in (see jogHoldBlocked in server/src/controller.ts)
  const blocked = st === 'Alarm' || st.startsWith('Door') || st.startsWith('Hold') || st === 'Home' || st === 'Check' || st === 'Sleep';
  return m.online && m.auth.operator && m.connection.connected && m.job.state !== 'running' && m.job.state !== 'paused' && !blocked;
};

/** Wire the bus to the connection, and stop everything whenever the page goes away or jogging stops being allowed */
export function useHoldJog(m: Machine) {
  holdBus.sender = m.send;
  const allowed = canJog(m);
  useEffect(() => { if (!allowed) stopAllJogging(); }, [allowed]);
  useEffect(() => {
    const stop = () => stopAllJogging();
    // a finger or mouse let go somewhere other than on its button (the browser did not keep it on the button): that is still letting go
    const lifted = (e: Event) => {
      const pid = (e as PointerEvent).pointerId;
      for (const [id, p] of [...heldBy]) if (p === pid) { heldBy.delete(id); jogGesture.up(id); }
    };
    const lifts = ['pointerup', 'pointercancel'] as const;
    for (const t of lifts) window.addEventListener(t, lifted, true);
    window.addEventListener('blur', stop);
    window.addEventListener('beforeunload', stop);
    document.addEventListener('visibilitychange', stop);
    return () => { for (const t of lifts) window.removeEventListener(t, lifted, true); window.removeEventListener('blur', stop); window.removeEventListener('beforeunload', stop); document.removeEventListener('visibilitychange', stop); stop(); };
  }, []);
}
