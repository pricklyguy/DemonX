import { useCallback, useEffect, useState } from 'react';
import { emptyLibraries, parseLibraries, type Libraries } from '../core/materials';

/** The material library lives in a file on the computer that runs the server; this keeps one copy in the page and writes changes back. */
export function useLibraries(): { data: Libraries; ready: boolean; error: string; save: (next: Libraries) => void } {
  const [data, setData] = useState<Libraries>(emptyLibraries);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    fetch('/api/library', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('The server has no material library (' + r.status + ')'))))
      .then((j) => { if (live) { setData(parseLibraries(j)); setReady(true); } })
      .catch((e: Error) => { if (live) { setError(e.message); setReady(true); } });
    return () => { live = false; };
  }, []);
  const save = useCallback((next: Libraries) => {
    setData(next);
    fetch('/api/library', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(next) })
      .then(async (r) => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? 'Could not save the library'); setError(''); })
      .catch((e: Error) => setError('Not saved: ' + e.message));
  }, []);
  return { data, ready, error, save };
}
