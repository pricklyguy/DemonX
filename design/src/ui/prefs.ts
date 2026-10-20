import { useEffect, useState } from 'react';

// Small per-browser choices. Kept in this browser only; the page works the same when storage is blocked.
const HIDE_KEY = 'design-hide-notes';
const read = (): boolean => { try { return localStorage.getItem(HIDE_KEY) === '1'; } catch { return false; } };

/** Hide the reminders and notes in the Laser panel (never the warnings that stop a job, nor alarms). */
export function useHideNotes(): [boolean, (v: boolean) => void] {
  const [v, setV] = useState(read);
  useEffect(() => {
    const on = () => setV(read());
    window.addEventListener('design-prefs', on);
    return () => window.removeEventListener('design-prefs', on);
  }, []);
  const set = (n: boolean) => {
    try { localStorage.setItem(HIDE_KEY, n ? '1' : '0'); } catch { /* storage blocked */ }
    setV(n);
    window.dispatchEvent(new Event('design-prefs'));
  };
  return [v, set];
}
