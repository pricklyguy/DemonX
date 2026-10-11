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

/** Let go of everything now */
export function stopAllJogging() { jogGesture.cancelAll(); holdBus.releaseAll(); }

/** Whether this browser may jog right now (signed in, connected, no job running) */
export const canJog = (m: Machine) => m.online && m.auth.operator && m.connection.connected && m.job.state !== 'running' && m.job.state !== 'paused';

/** Wire the bus to the connection, and stop everything whenever the page goes away or jogging stops being allowed */
export function useHoldJog(m: Machine) {
  holdBus.sender = m.send;
  const allowed = canJog(m);
  useEffect(() => { if (!allowed) stopAllJogging(); }, [allowed]);
  useEffect(() => {
    const stop = () => stopAllJogging();
    window.addEventListener('blur', stop);
    window.addEventListener('beforeunload', stop);
    document.addEventListener('visibilitychange', stop);
    return () => { window.removeEventListener('blur', stop); window.removeEventListener('beforeunload', stop); document.removeEventListener('visibilitychange', stop); stop(); };
  }, []);
}
