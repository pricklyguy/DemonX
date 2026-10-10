import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StatsStore, StatsError, validateTask } from '../src/stats.js';
import type { JobInfo } from '../../shared/protocol.js';

const job = (state: JobInfo['state'], extra: Partial<JobInfo> = {}): JobInfo => ({ state, name: 'a.nc', totalLines: 10, sentLines: 0, doneLines: 0, elapsedMs: 0, ...extra });
const H = 3_600_000;

describe('StatsStore', () => {
  it('times a job without the paused time and records how it ended', () => {
    const s = new StatsStore();
    s.observe(job('running', { startedAt: 0 }), 0);
    s.observe(job('running', { startedAt: 0 }), 1000);          // progress updates change nothing
    s.observe(job('paused'), 2 * H);                              // 2 h running
    s.observe(job('running'), 5 * H);                             // resumed after 3 h paused
    s.observe(job('done'), 6 * H);                                // 1 more hour
    const v = s.view(6 * H);
    expect(v.totalHours).toBe(3);
    expect(v.jobs).toBe(1); expect(v.done).toBe(1);
    expect(v.recent[0]).toMatchObject({ name: 'a.nc', result: 'done', runMs: 3 * H, lines: 10 });
  });

  it('records a stopped job (back to loaded) and a failed one', () => {
    const s = new StatsStore();
    s.observe(job('running', { startedAt: 0 }), 0); s.observe(job('loaded'), 1000);
    s.observe(job('running', { startedAt: 5000 }), 5000); s.observe(job('error'), 6000);
    const v = s.view(7000);
    expect([v.jobs, v.done, v.stopped, v.errors]).toEqual([2, 0, 1, 1]);
    expect(v.recent.map((r) => r.result)).toEqual(['error', 'stopped']);
  });

  it('ignores job updates when nothing is running', () => {
    const s = new StatsStore();
    s.observe(job('loaded')); s.observe(job('done'));
    expect(s.view().jobs).toBe(0);
  });

  it('counts the job in progress towards the total', () => {
    const s = new StatsStore();
    s.observe(job('running', { startedAt: 0 }), 0);
    expect(s.view(H / 2).totalHours).toBe(0.5);
  });

  it('starts with editable tasks, and a task comes due after its hours of running', () => {
    const s = new StatsStore();
    const before = s.view(0);
    expect(before.tasks.length).toBeGreaterThan(0);
    expect(before.tasks.every((t) => !t.due)).toBe(true);
    s.observe(job('running', { startedAt: 0 }), 0); s.observe(job('done'), 11 * H);
    const after = s.view(11 * H);
    const clean = after.tasks.find((t) => t.everyHours === 10)!;
    expect(clean.due).toBe(true); expect(clean.dueInHours).toBe(-1);
    expect(s.dueCount(11 * H)).toBe(1);
    s.serviced(clean.id, 11 * H);
    expect(s.view(11 * H).tasks.find((t) => t.id === clean.id)).toMatchObject({ due: false, sinceHours: 0, dueInHours: 10 });
  });

  it('a new task starts counting from now, an edited one keeps its history', () => {
    const s = new StatsStore();
    s.observe(job('running', { startedAt: 0 }), 0); s.observe(job('done'), 5 * H);
    s.saveTask({ name: 'Oil spindle', everyHours: 20 });
    const t = s.view().tasks.find((x) => x.name === 'Oil spindle')!;
    expect(t.sinceHours).toBe(0);
    s.saveTask({ id: t.id, name: 'Grease spindle', everyHours: 30 });
    expect(s.view().tasks.find((x) => x.id === t.id)).toMatchObject({ name: 'Grease spindle', everyHours: 30 });
    s.deleteTask(t.id);
    expect(s.view().tasks.find((x) => x.id === t.id)).toBeUndefined();
  });

  it('setting the starting hours keeps each task\'s hours since it was done', () => {
    const s = new StatsStore();
    const id = s.view().tasks[0].id;
    s.setHours(120);
    expect(s.view().totalHours).toBe(120);
    expect(s.view().tasks.find((t) => t.id === id)!.sinceHours).toBe(0);
    s.observe(job('running', { startedAt: 0 }), 0); s.observe(job('done'), 2 * H);
    expect(s.view(2 * H).tasks.find((t) => t.id === id)!.sinceHours).toBe(2);
  });

  it('refuses a bad task, an unknown task, and changing the hours during a job', () => {
    const s = new StatsStore();
    expect(() => validateTask({ name: '', everyHours: 5 })).toThrow(StatsError);
    expect(() => validateTask({ name: 'x', everyHours: 0 })).toThrow(StatsError);
    expect(() => validateTask({ name: 'x', everyHours: 'soon' })).toThrow(StatsError);
    expect(() => s.serviced('nope')).toThrow(StatsError);
    s.observe(job('running', { startedAt: 0 }), 0);
    expect(() => s.setHours(5)).toThrow(StatsError);
    expect(() => new StatsStore().setHours(-1)).toThrow(StatsError);
  });

  it('keeps only the newest 50 runs', () => {
    const s = new StatsStore();
    for (let i = 0; i < 60; i++) { s.observe(job('running', { startedAt: i * 10 }), i * 10); s.observe(job('done'), i * 10 + 5); }
    const v = s.view(1000);
    expect(v.recent.length).toBe(50);
    expect(v.jobs).toBe(60);
  });

  it('survives a restart, and a damaged file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demonx-stats-'));
    const a = new StatsStore(dir);
    a.observe(job('running', { startedAt: 0 }), 0); a.observe(job('done'), 2 * H);
    a.saveTask({ name: 'Check belts', everyHours: 7 });
    const b = new StatsStore(dir);
    expect(b.view().totalHours).toBe(2);
    expect(b.view().recent.length).toBe(1);
    expect(b.view().tasks.some((t) => t.name === 'Check belts')).toBe(true);
    fs.writeFileSync(path.join(dir, 'stats.json'), '{ not json');
    expect(new StatsStore(dir).view().jobs).toBe(0);
  });
});
