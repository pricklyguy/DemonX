import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { HaShare, jobEvents, machineEvents, probeEvents, connectionEvents } from '../src/hashare.js';
import { emptyJob, emptyProbe, emptyStatus } from '../../shared/protocol.js';
import type { JobInfo } from '../../shared/protocol.js';

const job = (state: JobInfo['state'], extra: Partial<JobInfo> = {}): JobInfo => ({ ...emptyJob(), name: 'board.nc', totalLines: 100, state, ...extra });

describe('events', () => {
  it('a job start, pause, resume, finish, failure and stop', () => {
    expect(jobEvents('loaded', job('running')).map((e) => e.type)).toEqual(['job_started']);
    expect(jobEvents('running', job('paused')).map((e) => e.type)).toEqual(['job_paused']);
    expect(jobEvents('paused', job('running')).map((e) => e.type)).toEqual(['job_resumed']);
    expect(jobEvents('running', job('done', { elapsedMs: 61_000 }))[0]).toEqual({ type: 'job_finished', data: { name: 'board.nc', lines: 100, elapsed_s: 61 } });
    expect(jobEvents('running', job('error', { error: 'alarm' }))[0].data.error).toBe('alarm');
    expect(jobEvents('running', job('loaded')).map((e) => e.type)).toEqual(['job_stopped']);
  });
  it('says nothing when nothing changed, or when a file is just loaded', () => {
    expect(jobEvents('running', job('running'))).toEqual([]);
    expect(jobEvents('none', job('loaded'))).toEqual([]);
    expect(jobEvents('done', job('loaded'))).toEqual([]);
  });
  it('alarm and alarm cleared', () => {
    expect(machineEvents('Idle', 'Alarm').map((e) => e.type)).toEqual(['alarm']);
    expect(machineEvents('Alarm', 'Idle').map((e) => e.type)).toEqual(['alarm_cleared']);
    expect(machineEvents('Idle', 'Run')).toEqual([]);
  });
  it('the probe asking for a person, and connection changes', () => {
    expect(probeEvents('idle', { ...emptyProbe(), phase: 'confirmConnect', title: 'PCB Z probe' })[0].data.waiting_for).toBe('connect the probe');
    expect(probeEvents('running', { ...emptyProbe(), phase: 'confirmRemove', success: true })[0].data.waiting_for).toBe('remove the probe');
    expect(probeEvents('confirmConnect', { ...emptyProbe(), phase: 'running' })).toEqual([]);
    expect(connectionEvents(false, { connected: true, target: '/dev/ttyUSB0' })[0].type).toBe('connected');
    expect(connectionEvents(true, { connected: true, target: 'x' })).toEqual([]);
  });
});

describe('HaShare', () => {
  const setup = (enabled = true) => {
    const ctl = Object.assign(new EventEmitter(), { job: job('loaded'), status: emptyStatus(), connection: { connected: true, target: 'x' } });
    const probe = Object.assign(new EventEmitter(), { info: emptyProbe() });
    const sent: { path: string; body: any }[] = [];
    const logs: string[] = [];
    let fail: Error | null = null;
    const share = new HaShare(() => enabled, async (path, body) => { if (fail) throw fail; sent.push({ path, body }); }, (_k, text) => logs.push(text));
    share.attach(ctl as never, probe as never);
    const tick = () => new Promise((r) => setTimeout(r, 0));
    return { ctl, probe, sent, logs, share, tick, failWith: (e: Error | null) => { fail = e; } };
  };

  it('fires an event when a job starts', async () => {
    const h = setup();
    h.ctl.emit('job', job('running'));
    await h.tick();
    expect(h.sent).toEqual([{ path: '/api/events/demonx_job_started', body: { name: 'board.nc', lines: 100, elapsed_s: 0 } }]);
  });

  it('sends nothing while sharing is off', async () => {
    const h = setup(false);
    h.ctl.emit('job', job('running'));
    h.ctl.emit('status', { ...emptyStatus(), state: 'Alarm' });
    await h.tick();
    expect(h.sent).toEqual([]);
  });

  it('reports a Home Assistant problem once, not for every event', async () => {
    const h = setup();
    h.failWith(new Error('Connection refused: check the Home Assistant address'));
    h.ctl.emit('status', { ...emptyStatus(), state: 'Alarm' });
    h.ctl.emit('status', { ...emptyStatus(), state: 'Idle' });
    await h.tick(); await h.tick();
    expect(h.logs).toEqual(['Home Assistant: Connection refused: check the Home Assistant address']);
  });

  it('test() reports success or the reason', async () => {
    const h = setup();
    expect((await h.share.test()).ok).toBe(true);
    expect(h.sent[0].path).toBe('/api/events/demonx_test');
    h.failWith(new Error('Home Assistant refused the access token'));
    expect(await h.share.test()).toEqual({ ok: false, message: 'Home Assistant refused the access token' });
  });
});

describe('makePoster', () => {
  it('POSTs JSON with the bearer token, and explains a refusal', async () => {
    const { default: http } = await import('node:http');
    const { makePoster } = await import('../src/hashare.js');
    const seen: { url?: string; auth?: string; body?: string }[] = [];
    let code = 200;
    const srv = http.createServer((req, res) => {
      let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { seen.push({ url: req.url, auth: req.headers.authorization, body: b }); res.writeHead(code).end('{}'); });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    const post = makePoster(() => ({ url: `http://127.0.0.1:${port}`, token: 'abc', insecureTls: false, share: true }));
    await post('/api/events/demonx_test', { a: 1 });
    expect(seen[0]).toEqual({ url: '/api/events/demonx_test', auth: 'Bearer abc', body: '{"a":1}' });
    code = 401;
    await expect(post('/api/events/x', {})).rejects.toThrow('refused the access token');
    await expect(makePoster(() => ({ url: '', token: '', insecureTls: false, share: true }))('/x', {})).rejects.toThrow('not set up');
    srv.close();
  });
});
