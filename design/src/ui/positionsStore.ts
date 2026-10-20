import { useCallback, useEffect, useState } from 'react';
import { emptyPositions, parsePositions, type PositionList } from '../core/positions';

/** The saved head positions live in a file on the computer that runs the server, so every computer sees the same ones */
export function usePositions(): { data: PositionList; error: string; save: (next: PositionList) => void } {
  const [data, setData] = useState<PositionList>(emptyPositions);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    const load = () => fetch('/api/positions', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('The server keeps no saved positions (' + r.status + ')'))))
      .then((j) => { if (live) setData(parsePositions(j)); })
      .catch((e: Error) => { if (live) setError(e.message); });
    void load();
    // another part of the page saved: look again (the Laser panel needs the job origin chosen in the Move window)
    const on = () => void load();
    window.addEventListener('design-positions', on);
    return () => { live = false; window.removeEventListener('design-positions', on); };
  }, []);
  const save = useCallback((next: PositionList) => {
    setData(next);
    fetch('/api/positions', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(next) })
      .then(async (r) => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? 'Could not save the positions'); setError(''); window.dispatchEvent(new Event('design-positions')); })
      .catch((e: Error) => setError('Not saved: ' + e.message));
  }, []);
  return { data, error, save };
}
