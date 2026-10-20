import { useCallback, useEffect, useState } from 'react';
import { emptyRotary, parseRotary, DEFAULT_ROTARY, type RotaryList, type RotarySetup } from '../core/rotary';

/** The rotary settings live in a file on the computer that runs the server (one set per laser), so every computer sees the same ones */
export function useRotary(key: string): { setup: RotarySetup; known: boolean; error: string; save: (next: RotarySetup) => void } {
  const [data, setData] = useState<RotaryList>(emptyRotary);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    const load = () => fetch('/api/rotary', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('The server keeps no rotary settings (' + r.status + ')'))))
      .then((j) => { if (live) setData(parseRotary(j)); })
      .catch((e: Error) => { if (live) setError(e.message); });
    void load();
    const on = () => void load();
    window.addEventListener('design-rotary', on);
    return () => { live = false; window.removeEventListener('design-rotary', on); };
  }, []);
  const save = useCallback((next: RotarySetup) => {
    if (!key) return;
    const merged: RotaryList = { v: 1, sets: { ...data.sets, [key]: next } };
    setData(merged);
    fetch('/api/rotary', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(merged) })
      .then(async (r) => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? 'Could not save the rotary settings'); setError(''); window.dispatchEvent(new Event('design-rotary')); })
      .catch((e: Error) => setError('Not saved: ' + e.message));
  }, [key, data]);
  return { setup: data.sets[key] ?? DEFAULT_ROTARY, known: !!data.sets[key], error, save };
}
