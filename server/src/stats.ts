import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { JobInfo, MaintTask, RunRecord, StatsInfo } from '../../shared/protocol.js';

// Job statistics and maintenance. The machine's running time is the time jobs spent actually running
// (pauses and the time between jobs do not count). Maintenance tasks come due after so many of those hours.
// Kept in the data folder as stats.json. A job that is still running when DemonX stops is not counted.

export class StatsError extends Error {}

const HOUR = 3_600_000;
const MAX_RECENT = 50, MAX_TASKS = 30, MAX_NAME = 60, MAX_HOURS = 100_000;

interface StoredTask { id: string; name: string; everyHours: number; doneAtMs: number; doneAt?: number }
interface Saved { runMs: number; jobs: number; done: number; stopped: number; errors: number; recent: RunRecord[]; tasks: StoredTask[] }

const SEED: { name: string; everyHours: number }[] = [
  { name: 'Clean the machine and vacuum the chips', everyHours: 10 },
  { name: 'Lubricate the rails and lead screws', everyHours: 40 },
  { name: 'Check belts, couplers and screws for tightness', everyHours: 100 },
];

const empty = (): Saved => ({ runMs: 0, jobs: 0, done: 0, stopped: 0, errors: 0, recent: [], tasks: SEED.map((t) => ({ id: crypto.randomUUID(), ...t, doneAtMs: 0 })) });

/** Check a task as it is saved */
export function validateTask(t: { name?: unknown; everyHours?: unknown }): { name: string; everyHours: number } {
  if (typeof t.name !== 'string' || !t.name.trim()) throw new StatsError('Give the task a name');
  const name = t.name.trim();
  if (name.length > MAX_NAME) throw new StatsError(`The name can be up to ${MAX_NAME} characters`);
  const h = Number(t.everyHours);
  if (!Number.isFinite(h) || h < 0.5 || h > MAX_HOURS) throw new StatsError('Hours between services must be between 0.5 and 100000');
  return { name, everyHours: Math.round(h * 100) / 100 };
}

export class StatsStore extends EventEmitter {
  private d: Saved = empty();
  private file?: string;
  /** The job being timed. since is set while it is running and empty while it is paused */
  private cur: { id: string; name: string; startedAt: number; runMs: number; since: number | null; lines: number } | null = null;

  constructor(dataDir?: string) {
    super();
    if (!dataDir) return;
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, 'stats.json');
    try {
      const s = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<Saved>;
      const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
      this.d = {
        runMs: n(s.runMs), jobs: n(s.jobs), done: n(s.done), stopped: n(s.stopped), errors: n(s.errors),
        recent: Array.isArray(s.recent) ? s.recent.filter((r) => r && typeof r.name === 'string').slice(0, MAX_RECENT) : [],
        tasks: Array.isArray(s.tasks) ? s.tasks.flatMap((t) => { try { return [{ id: String(t.id), ...validateTask(t), doneAtMs: n(t.doneAtMs), doneAt: typeof t.doneAt === 'number' ? t.doneAt : undefined }]; } catch { return []; } }) : [],
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') this.write();
      else console.error(`Could not read ${this.file}: ${(e as Error).message}`);
    }
  }

  /** Total running time now, counting the job in progress */
  private totalMs(now: number): number {
    const c = this.cur;
    return this.d.runMs + (c ? c.runMs + (c.since !== null ? now - c.since : 0) : 0);
  }

  /** Feed every job update here: it times the run and records how it ended */
  observe(job: JobInfo, now = Date.now()) {
    const c = this.cur;
    if (job.state === 'running') {
      if (!c) this.cur = { id: crypto.randomUUID(), name: job.name, startedAt: job.startedAt ?? now, runMs: 0, since: now, lines: job.totalLines };
      else if (c.since === null) c.since = now;
      else return;   // already counting: the once-a-second progress updates change nothing here
    } else if (job.state === 'paused') {
      if (c && c.since !== null) { c.runMs += now - c.since; c.since = null; }
      return;
    } else if (c) {
      if (c.since !== null) c.runMs += now - c.since;
      const result: RunRecord['result'] = job.state === 'done' ? 'done' : job.state === 'error' ? 'error' : 'stopped';
      this.d.recent.unshift({ id: c.id, name: c.name, startedAt: c.startedAt, runMs: Math.round(c.runMs), result, lines: c.lines });
      this.d.recent.length = Math.min(this.d.recent.length, MAX_RECENT);
      this.d.runMs += c.runMs;
      this.d.jobs++;
      if (result === 'done') this.d.done++; else if (result === 'error') this.d.errors++; else this.d.stopped++;
      this.cur = null;
      this.changed();
    } else return;
    this.emit('stats', this.view(now));
  }

  view(now = Date.now()): StatsInfo {
    const total = this.totalMs(now);
    const hours = (ms: number) => Math.round((ms / HOUR) * 100) / 100;
    return {
      totalHours: hours(total), jobs: this.d.jobs, done: this.d.done, stopped: this.d.stopped, errors: this.d.errors,
      recent: this.d.recent,
      tasks: this.d.tasks.map((t): MaintTask => {
        const since = Math.max(0, total - t.doneAtMs);
        return { id: t.id, name: t.name, everyHours: t.everyHours, doneAtHours: hours(t.doneAtMs), doneAt: t.doneAt, sinceHours: hours(since), dueInHours: hours(t.everyHours * HOUR - since), due: since >= t.everyHours * HOUR };
      }),
    };
  }

  /** How many tasks are due now (for a badge, and for Home Assistant) */
  dueCount(now = Date.now()): number { return this.view(now).tasks.filter((t) => t.due).length; }

  saveTask(t: { id?: unknown; name?: unknown; everyHours?: unknown }) {
    const ok = validateTask(t);
    const id = typeof t.id === 'string' ? t.id : undefined;
    const at = id ? this.d.tasks.findIndex((x) => x.id === id) : -1;
    if (at >= 0) this.d.tasks[at] = { ...this.d.tasks[at], ...ok };
    else {
      if (this.d.tasks.length >= MAX_TASKS) throw new StatsError(`Up to ${MAX_TASKS} tasks`);
      this.d.tasks.push({ id: crypto.randomUUID(), ...ok, doneAtMs: this.totalMs(Date.now()), doneAt: Date.now() });
    }
    this.changed(); this.emit('stats', this.view());
  }

  deleteTask(id: string) {
    this.d.tasks = this.d.tasks.filter((t) => t.id !== id);
    this.changed(); this.emit('stats', this.view());
  }

  /** The task was done now: its hours start again from zero */
  serviced(id: string, now = Date.now()) {
    const t = this.d.tasks.find((x) => x.id === id);
    if (!t) throw new StatsError('That task no longer exists');
    t.doneAtMs = this.totalMs(now); t.doneAt = now;
    this.changed(); this.emit('stats', this.view(now));
  }

  /** For a machine that ran before DemonX: set the total hours. Tasks keep the hours since they were done. */
  setHours(hours: number) {
    if (this.cur) throw new StatsError('Wait until the job has finished');
    if (!Number.isFinite(hours) || hours < 0 || hours > MAX_HOURS) throw new StatsError('Hours must be between 0 and 100000');
    const next = Math.round(hours * HOUR), delta = next - this.d.runMs;
    this.d.runMs = next;
    for (const t of this.d.tasks) t.doneAtMs = Math.max(0, t.doneAtMs + delta);
    this.changed(); this.emit('stats', this.view());
  }

  private changed() {
    if (!this.file) return;
    try { fs.writeFileSync(this.file, JSON.stringify(this.d, null, 2)); }
    catch (e) { console.error(`Could not save ${this.file}: ${(e as Error).message}`); }
  }
  private write() { this.changed(); }
}
