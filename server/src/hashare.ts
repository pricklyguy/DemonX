import type { EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import type { ConnectionInfo, JobInfo, MachineStatus, ProbeInfo } from '../../shared/protocol.js';
import type { AppConfig } from './config.js';

/**
 * Tell Home Assistant what the machine is doing, so its automations can react ("job finished: flash the lights",
 * "alarm: notify my phone"). It uses the address and access token already saved for the camera.
 *
 * Events (HA: Developer tools > Events, or an automation trigger of type Event) carry the moment something happened.
 * The machine's values (state, position, progress...) are not sent here: they are entities shared through MQTT (mqtt.ts).
 */

export type HaEvent = { type: string; data: Record<string, unknown> };

export const EVENT_PREFIX = 'demonx_';

/** What happened between two observations of the machine. Pure, so it is easy to test. */
export function jobEvents(prev: JobInfo['state'], job: JobInfo): HaEvent[] {
  const d = { name: job.name, lines: job.totalLines, elapsed_s: Math.round(job.elapsedMs / 1000) };
  if (prev === job.state) return [];
  if (job.state === 'running') return [{ type: prev === 'paused' ? 'job_resumed' : 'job_started', data: d }];
  if (job.state === 'paused') return [{ type: 'job_paused', data: d }];
  if (job.state === 'done') return [{ type: 'job_finished', data: d }];
  if (job.state === 'error') return [{ type: 'job_failed', data: { ...d, error: job.error ?? '' } }];
  if (job.state === 'loaded' && (prev === 'running' || prev === 'paused')) return [{ type: 'job_stopped', data: d }];
  return [];
}

export function machineEvents(prev: MachineStatus['state'], now: MachineStatus['state']): HaEvent[] {
  if (prev === now) return [];
  if (now === 'Alarm') return [{ type: 'alarm', data: {} }];
  if (prev === 'Alarm') return [{ type: 'alarm_cleared', data: { state: now } }];
  return [];
}

export function probeEvents(prev: ProbeInfo['phase'], p: ProbeInfo): HaEvent[] {
  if (prev === p.phase) return [];
  // the probe waits for a person at "is the probe connected?" and "remove the probe": worth a phone notification
  if (p.phase === 'confirmConnect' || p.phase === 'confirmRemove') {
    return [{ type: 'probe_waiting', data: { kind: p.kind ?? '', title: p.title ?? '', waiting_for: p.phase === 'confirmConnect' ? 'connect the probe' : 'remove the probe', success: p.success ?? null, error: p.error ?? '' } }];
  }
  return [];
}

export const connectionEvents = (prev: boolean, c: ConnectionInfo): HaEvent[] =>
  prev === c.connected ? [] : [{ type: c.connected ? 'connected' : 'disconnected', data: { target: c.target } }];

export type Poster = (path: string, body: unknown) => Promise<void>;

/** POST JSON to Home Assistant's REST API with the saved token */
export function makePoster(cfg: () => AppConfig['homeAssistant']): Poster {
  return (path, body) => new Promise((resolve, reject) => {
    const ha = cfg();
    if (!ha.url || !ha.token) return reject(new Error('Home Assistant is not set up: enter its address and an access token'));
    const u = new URL(ha.url + path);
    const payload = JSON.stringify(body);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ha.token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      ...(u.protocol === 'https:' && ha.insecureTls ? { rejectUnauthorized: false } : {}),
    }, (res) => {
      res.resume();
      const code = res.statusCode ?? 0;
      if (code === 401) return reject(new Error('Home Assistant refused the access token'));
      if (code >= 400) return reject(new Error(`Home Assistant answered ${code}`));
      resolve();
    });
    req.setTimeout(5000, () => req.destroy(new Error('Home Assistant did not answer in time')));
    req.on('error', (e) => reject(new Error((e as NodeJS.ErrnoException).code === 'ECONNREFUSED' ? 'Connection refused: check the Home Assistant address' : e.message)));
    req.end(payload);
  });
}


/** Watches the machine and fires events. Does nothing unless sharing is switched on. */
export class HaShare {
  private job: JobInfo['state'] = 'none';
  private mstate: MachineStatus['state'] = 'Disconnected';
  private connected = false;
  private phase: ProbeInfo['phase'] = 'idle';
  private lastError = '';

  constructor(
    private enabled: () => boolean,
    private post: Poster,
    private log: (kind: 'sys' | 'err', text: string) => void,
  ) {}

  attach(ctl: EventEmitter & { job: JobInfo; status: MachineStatus; connection: ConnectionInfo }, probe: EventEmitter & { info: ProbeInfo }) {
    this.job = ctl.job.state; this.mstate = ctl.status.state; this.connected = ctl.connection.connected; this.phase = probe.info.phase;
    ctl.on('job', (j: JobInfo) => { const ev = jobEvents(this.job, j); this.job = j.state; this.events(ev); });
    ctl.on('status', (s: MachineStatus) => { const ev = machineEvents(this.mstate, s.state); this.mstate = s.state; this.events(ev); });
    ctl.on('connection', (c: ConnectionInfo) => { const ev = connectionEvents(this.connected, c); this.connected = c.connected; this.events(ev); });
    probe.on('probe', (p: ProbeInfo) => { const ev = probeEvents(this.phase, p); this.phase = p.phase; this.events(ev); });
  }

  private events(list: HaEvent[]) {
    if (!this.enabled()) return;
    for (const e of list) void this.send(`/api/events/${EVENT_PREFIX}${e.type}`, e.data);
  }

  /** For the Test button: fires demonx_test and reports what happened */
  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.post(`/api/events/${EVENT_PREFIX}test`, { message: 'Test from DemonX' });
      this.lastError = '';
      return { ok: true, message: `Sent the event ${EVENT_PREFIX}test: it shows in Home Assistant under Developer tools, Events (listen to demonx_*)` };
    } catch (e) { return { ok: false, message: (e as Error).message }; }
  }

  private async send(path: string, body: unknown) {
    try { await this.post(path, body); this.lastError = ''; }
    catch (e) {
      const m = (e as Error).message;
      if (m !== this.lastError) { this.lastError = m; this.log('err', `Home Assistant: ${m}`); } // once per distinct problem, not per event
    }
  }
}
