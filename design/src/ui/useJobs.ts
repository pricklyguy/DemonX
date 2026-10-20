import { useEffect, useRef, useState } from 'react';
import { computeJobs, fromWire, type JobInput, type JobOutput, type JobWire } from '../core/jobBuild';
import { buildLaserJob } from '../core/laser';
import { emptyDoc } from '../core/types';
import { estimateMoves } from '../core/jobEstimate';
import { NO_RUIDA_JOB } from '../core/jobBuild';

const NONE: JobOutput = { job: buildLaserJob(emptyDoc()), ruida: NO_RUIDA_JOB, est: estimateMoves([]) };

/**
 * The job for the Laser tab, worked out in a worker so a big drawing never freezes the page. While a newer job is being worked
 * out the last one stays on screen, and `stale` is true: nothing may be sent to the machine from a stale job. A change made
 * while the worker is busy throws that work away and starts again (the worker is replaced).
 * Where workers are not available the job is worked out here, as before.
 */
export function useJobs(input: JobInput | null): { out: JobOutput; stale: boolean; error: string | null } {
  const [out, setOut] = useState<JobOutput>(NONE);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const worker = useRef<Worker | null>(null);
  const seq = useRef(0);
  const busy = useRef(false);

  const spawn = () => {
    const w = new Worker(new URL('../core/jobWorker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<{ id: number; out?: JobWire; error?: string }>) => {
      if (e.data.id !== seq.current) return;
      busy.current = false; setPending(false);
      if (e.data.out) { setOut(fromWire(e.data.out)); setError(null); } else setError(e.data.error ?? 'The job could not be worked out');
    };
    w.onerror = () => { busy.current = false; setPending(false); setError('The job could not be worked out'); };
    return w;
  };

  useEffect(() => {
    if (!input) { seq.current++; busy.current = false; setPending(false); setOut(NONE); setError(null); return; }
    const id = ++seq.current;
    setPending(true);
    if (typeof Worker === 'undefined') {
      try { setOut(computeJobs(input)); setError(null); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
      setPending(false);
      return;
    }
    // a change while the worker is still busy: its work is out of date, so start a fresh worker instead of waiting for it
    if (worker.current && busy.current) { worker.current.terminate(); worker.current = null; }
    if (!worker.current) worker.current = spawn();
    busy.current = true;
    worker.current.postMessage({ id, input });
  }, [input]);

  useEffect(() => () => { worker.current?.terminate(); worker.current = null; }, []);
  return { out, stale: pending, error };
}
