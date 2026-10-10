import type { EventEmitter } from 'node:events';
import mqtt, { type MqttClient } from 'mqtt';
import type { ConnectionInfo, JobInfo, MachineStatus, ProbeInfo, StatsInfo } from '../../shared/protocol.js';
import type { AppConfig } from './config.js';

/**
 * Home Assistant through MQTT discovery: the machine shows up in Home Assistant as one device (named in Settings) with
 * its own entities, no YAML needed, and Home Assistant sees it go offline if DemonX stops (the MQTT "last will").
 *
 * What may come back from Home Assistant is a short fixed list on purpose: the safety and recovery buttons. Nothing can
 * jog, probe, start a job or change a setting from here, whoever can publish to the broker.
 */

export const COMMANDS = ['home', 'unlock', 'reset', 'hold', 'resume', 'stop'] as const;
export type Command = typeof COMMANDS[number];

export const slugOf = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'demonx';

const fmtTime = (ms: number | undefined): string => {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '--:--';
  const s = Math.round(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${two(m)}:${two(r)}` : `${two(m)}:${two(r)}`;
};

export interface Snapshot { status: MachineStatus; job: JobInfo; connection: ConnectionInfo; probe: ProbeInfo; jobBytes: number; pcb: boolean; heightmap: boolean; now: number; version?: string; stats?: StatsInfo }

/** Everything published in the one state message. Pure, so it is tested without a broker. */
export function buildState(s: Snapshot): Record<string, string | number | boolean> {
  const { status, job, connection } = s;
  const connected = connection.connected;
  const running = job.state === 'running' || job.state === 'paused';
  const elapsedMs = job.state === 'running' ? s.now - (job.startedAt ?? s.now) : job.elapsedMs;
  const done = job.doneLines, total = job.totalLines;
  const pct = job.state === 'done' ? 100 : total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  // an estimate from the lines done so far: rough while the first few lines run, better as the job goes on
  const remainingMs = job.state === 'done' ? 0 : running && done > 0 ? (elapsedMs * (total - done)) / done : undefined;
  const r = (n: number) => Math.round(n * 1000) / 1000;
  const st = s.stats;
  const due = st ? st.tasks.filter((t) => t.due) : [];
  const next = st ? [...st.tasks].sort((a, b) => a.dueInHours - b.dueInHours)[0] : undefined;
  const hrs = (h: number) => (Math.abs(h) < 1 ? `${Math.round(Math.abs(h) * 60)} min` : `${Math.round(Math.abs(h) * 10) / 10} h`);
  return {
    machine_state: connected ? status.state : 'Disconnected',
    connected,
    alarm_active: connected && status.state === 'Alarm',
    feed_hold: connected && status.state === 'Hold',
    x_position: r(status.wpos.x), y_position: r(status.wpos.y), z_position: r(status.wpos.z),
    x_machine: r(status.mpos.x), y_machine: r(status.mpos.y), z_machine: r(status.mpos.z),
    feedrate: Math.round(status.feed), spindle_speed: Math.round(status.spindle),
    feed_override: status.ov.feed, rapid_override: status.ov.rapid, spindle_override: status.ov.spindle,
    probe_pin: status.pins.includes('P'),
    job_state: job.state,
    file_name: job.name || '—',
    job_size: s.jobBytes,
    lines_total: total, lines_sent: job.sentLines, lines_done: done,
    job_progress: pct,
    job_elapsed_formatted: job.state === 'none' || job.state === 'loaded' ? '--:--' : fmtTime(elapsedMs),
    job_remaining_formatted: fmtTime(remainingMs),
    job_error: job.error ?? '',
    probe_state: s.probe.phase === 'idle' ? 'Idle' : s.probe.title ?? s.probe.phase,
    pcb_mode: s.pcb,
    height_map: s.heightmap,
    firmware: connection.firmware ?? '',
    demonx_version: s.version ?? '',
    port: connection.target,
    machine_hours: st ? Math.round(st.totalHours * 100) / 100 : 0,
    jobs_run: st?.jobs ?? 0,
    maintenance_due: due.length > 0,
    maintenance_due_count: due.length,
    maintenance_next: next ? `${next.name} (${next.due ? `${hrs(next.dueInHours)} overdue` : `in ${hrs(next.dueInHours)}`})` : 'No tasks',
  };
}

interface Ent { kind: 'sensor' | 'binary_sensor'; key: string; name: string; unit?: string; icon?: string; cls?: string; measurement?: boolean; category?: 'diagnostic'; off?: boolean; total?: boolean }
export const ENTITIES: Ent[] = [
  { kind: 'sensor', key: 'machine_state', name: 'Machine State', icon: 'mdi:robot-industrial' },
  { kind: 'sensor', key: 'job_state', name: 'Job State', icon: 'mdi:file-cog-outline' },
  { kind: 'sensor', key: 'file_name', name: 'File Name', icon: 'mdi:file-outline' },
  { kind: 'sensor', key: 'job_progress', name: 'Job Progress', unit: '%', icon: 'mdi:progress-clock', measurement: true },
  { kind: 'sensor', key: 'job_elapsed_formatted', name: 'Job Elapsed Formatted', icon: 'mdi:timer-outline' },
  { kind: 'sensor', key: 'job_remaining_formatted', name: 'Job Remaining Formatted', icon: 'mdi:timer-sand' },
  { kind: 'sensor', key: 'job_size', name: 'Job Size', unit: 'B', icon: 'mdi:file-document-outline', cls: 'data_size', category: 'diagnostic' },
  { kind: 'sensor', key: 'lines_total', name: 'Job Lines', icon: 'mdi:format-list-numbered', category: 'diagnostic' },
  { kind: 'sensor', key: 'lines_done', name: 'Job Lines Done', icon: 'mdi:format-list-checks', measurement: true, category: 'diagnostic' },
  { kind: 'sensor', key: 'job_error', name: 'Job Error', icon: 'mdi:alert-outline' },
  { kind: 'sensor', key: 'x_position', name: 'X Position', unit: 'mm', icon: 'mdi:axis-x-arrow', measurement: true },
  { kind: 'sensor', key: 'y_position', name: 'Y Position', unit: 'mm', icon: 'mdi:axis-y-arrow', measurement: true },
  { kind: 'sensor', key: 'z_position', name: 'Z Position', unit: 'mm', icon: 'mdi:axis-z-arrow', measurement: true },
  { kind: 'sensor', key: 'x_machine', name: 'X Machine Position', unit: 'mm', icon: 'mdi:axis-x-arrow', measurement: true, category: 'diagnostic' },
  { kind: 'sensor', key: 'y_machine', name: 'Y Machine Position', unit: 'mm', icon: 'mdi:axis-y-arrow', measurement: true, category: 'diagnostic' },
  { kind: 'sensor', key: 'z_machine', name: 'Z Machine Position', unit: 'mm', icon: 'mdi:axis-z-arrow', measurement: true, category: 'diagnostic' },
  { kind: 'sensor', key: 'feedrate', name: 'Feedrate', unit: 'mm/min', icon: 'mdi:speedometer', measurement: true },
  { kind: 'sensor', key: 'spindle_speed', name: 'Spindle Speed', unit: 'rpm', icon: 'mdi:rotate-right', measurement: true },
  { kind: 'sensor', key: 'feed_override', name: 'Feed Override', unit: '%', icon: 'mdi:speedometer-medium', measurement: true, category: 'diagnostic' },
  { kind: 'sensor', key: 'rapid_override', name: 'Rapid Override', unit: '%', icon: 'mdi:speedometer-medium', measurement: true, category: 'diagnostic' },
  { kind: 'sensor', key: 'spindle_override', name: 'Spindle Override', unit: '%', icon: 'mdi:speedometer-medium', measurement: true, category: 'diagnostic' },
  { kind: 'sensor', key: 'probe_state', name: 'Probe State', icon: 'mdi:ruler' },
  { kind: 'sensor', key: 'firmware', name: 'Firmware', icon: 'mdi:chip', category: 'diagnostic' },
  { kind: 'sensor', key: 'demonx_version', name: 'DemonX Version', icon: 'mdi:tag-outline', category: 'diagnostic' },
  { kind: 'sensor', key: 'port', name: 'Port', icon: 'mdi:usb-port', category: 'diagnostic' },
  { kind: 'sensor', key: 'machine_hours', name: 'Machine Hours', unit: 'h', icon: 'mdi:clock-outline', cls: 'duration', total: true },
  { kind: 'sensor', key: 'jobs_run', name: 'Jobs Run', icon: 'mdi:counter', total: true },
  { kind: 'sensor', key: 'maintenance_due_count', name: 'Maintenance Tasks Due', icon: 'mdi:wrench-clock', measurement: true },
  { kind: 'sensor', key: 'maintenance_next', name: 'Next Maintenance', icon: 'mdi:wrench-outline' },
  { kind: 'binary_sensor', key: 'maintenance_due', name: 'Maintenance Due', icon: 'mdi:wrench-clock', cls: 'problem' },
  { kind: 'binary_sensor', key: 'alarm_active', name: 'Alarm Active', icon: 'mdi:alert-circle-outline', cls: 'problem' },
  { kind: 'binary_sensor', key: 'feed_hold', name: 'Feed Hold', icon: 'mdi:pause-circle' },
  { kind: 'binary_sensor', key: 'connected', name: 'Machine Connected', icon: 'mdi:usb', cls: 'connectivity' },
  { kind: 'binary_sensor', key: 'probe_pin', name: 'Probe Triggered', icon: 'mdi:target', category: 'diagnostic' },
  { kind: 'binary_sensor', key: 'pcb_mode', name: 'PCB Mode', icon: 'mdi:expansion-card', category: 'diagnostic' },
  { kind: 'binary_sensor', key: 'height_map', name: 'Height Map Loaded', icon: 'mdi:grid', category: 'diagnostic' },
];

const BUTTONS: { cmd: Command; name: string; icon: string }[] = [
  { cmd: 'home', name: 'Home', icon: 'mdi:home-export-outline' },
  { cmd: 'unlock', name: 'Unlock', icon: 'mdi:lock-open-variant-outline' },
  { cmd: 'reset', name: 'Reset', icon: 'mdi:restart' },
  { cmd: 'hold', name: 'Feed Hold', icon: 'mdi:pause-circle' },
  { cmd: 'resume', name: 'Resume', icon: 'mdi:play-circle' },
  { cmd: 'stop', name: 'Stop', icon: 'mdi:alert-octagon' },
];

export const baseTopic = (name: string) => `demonx/${slugOf(name)}`;
export const DISCOVERY = 'homeassistant';

/** The retained discovery messages that make the device and its entities appear in Home Assistant */
export function discovery(name: string): { topic: string; payload: Record<string, unknown> }[] {
  const slug = slugOf(name), base = baseTopic(name);
  const device = { identifiers: [`demonx_${slug}`], name, manufacturer: 'Prickly Guy Creations', model: 'DemonX CNC controller' };
  const common = { availability_topic: `${base}/availability`, device, has_entity_name: true };
  const out: { topic: string; payload: Record<string, unknown> }[] = [];
  for (const e of ENTITIES) {
    out.push({
      topic: `${DISCOVERY}/${e.kind}/${slug}/${e.key}/config`,
      payload: {
        ...common, name: e.name, unique_id: `demonx_${slug}_${e.key}`,
        state_topic: `${base}/state`,
        value_template: e.kind === 'binary_sensor' ? `{{ 'ON' if value_json.${e.key} else 'OFF' }}` : `{{ value_json.${e.key} }}`,
        ...(e.unit ? { unit_of_measurement: e.unit } : {}), ...(e.icon ? { icon: e.icon } : {}), ...(e.cls ? { device_class: e.cls } : {}),
        ...(e.measurement ? { state_class: 'measurement' } : {}), ...(e.total ? { state_class: 'total' } : {}), ...(e.category ? { entity_category: e.category } : {}),
      },
    });
  }
  // "Bridge Online": DemonX itself is running (as opposed to the machine being connected to it)
  out.push({
    topic: `${DISCOVERY}/binary_sensor/${slug}/bridge_online/config`,
    payload: { name: 'Bridge Online', unique_id: `demonx_${slug}_bridge_online`, device, has_entity_name: true, state_topic: `${base}/availability`, payload_on: 'online', payload_off: 'offline', device_class: 'connectivity', icon: 'mdi:lan-connect' },
  });
  for (const b of BUTTONS) {
    out.push({
      topic: `${DISCOVERY}/button/${slug}/${b.cmd}/config`,
      payload: { ...common, name: b.name, unique_id: `demonx_${slug}_${b.cmd}`, command_topic: `${base}/command/${b.cmd}`, payload_press: 'PRESS', icon: b.icon },
    });
  }
  return out;
}

type Cfg = AppConfig['mqtt'];
export type Connect = (url: string, opts: mqtt.IClientOptions) => MqttClient;

const urlOf = (c: Cfg) => `${c.tls ? 'mqtts' : 'mqtt'}://${c.host}:${c.port}`;
const friendly = (e: Error & { code?: string }) =>
  e.code === 'ECONNREFUSED' ? 'Connection refused: check the broker address and port'
  : e.code === 'ENOTFOUND' ? 'The broker address could not be found'
  : /not authori[sz]ed|bad user/i.test(e.message) ? 'The broker refused the user name or password'
  : e.message || 'Could not reach the MQTT broker';

/** Try a connection (for the Test button) and say what happened */
export function testBroker(c: Cfg, connect: Connect = mqtt.connect, timeoutMs = 8000): Promise<{ ok: boolean; message: string }> {
  return new Promise((resolve) => {
    if (!c.host) return resolve({ ok: false, message: 'Enter the broker address first' });
    const client = connect(urlOf(c), { username: c.user || undefined, password: c.password || undefined, reconnectPeriod: 0, connectTimeout: timeoutMs, clientId: `demonx_test_${Math.random().toString(16).slice(2, 8)}` });
    let done = false;
    const finish = (r: { ok: boolean; message: string }) => { if (done) return; done = true; clearTimeout(t); client.end(true); resolve(r); };
    const t = setTimeout(() => finish({ ok: false, message: 'The broker did not answer in time' }), timeoutMs + 500);
    client.on('connect', () => finish({ ok: true, message: `Connected to the MQTT broker at ${c.host}:${c.port}` }));
    client.on('error', (e) => finish({ ok: false, message: friendly(e as Error) }));
  });
}

export class MqttBridge {
  private client?: MqttClient;
  private applied = '';
  private slug = '';
  private published = new Set<string>();
  private lastState = '';
  private timer?: NodeJS.Timeout;
  private tick?: NodeJS.Timeout;
  private lastError = '';

  constructor(
    private cfg: () => Cfg,
    private snap: () => Snapshot,
    private run: (cmd: Command) => void,
    private log: (kind: 'sys' | 'err', text: string) => void,
    private connect: Connect = mqtt.connect,
    private throttleMs = 500,
  ) {}

  attach(ctl: EventEmitter, probe: EventEmitter, stats?: EventEmitter) {
    for (const ev of ['status', 'job', 'connection']) ctl.on(ev, () => this.schedule());
    probe.on('probe', () => this.schedule());
    stats?.on('stats', () => this.schedule());
  }

  /** Start, stop or restart to match the saved settings. Called at startup and whenever they change. */
  apply() {
    const c = this.cfg();
    const key = c.enabled ? JSON.stringify([c.host, c.port, c.user, c.password, c.tls, c.name]) : '';
    if (key === this.applied) return;
    this.applied = key;
    // entities are only removed from Home Assistant when sharing is turned off or the device is renamed;
    // a new password or broker address just reconnects
    this.stop(!c.enabled || slugOf(c.name) !== this.slug);
    if (!c.enabled || !c.host) return;
    this.slug = slugOf(c.name);
    const base = baseTopic(c.name);
    const client = this.connect(urlOf(c), {
      username: c.user || undefined, password: c.password || undefined, clientId: `demonx_${this.slug}`, reconnectPeriod: 5000, connectTimeout: 10_000,
      will: { topic: `${base}/availability`, payload: Buffer.from('offline'), retain: true, qos: 1 },
    });
    this.client = client;
    client.on('connect', () => {
      this.lastError = '';
      this.log('sys', `MQTT connected to ${c.host}:${c.port}: ${c.name} is shared with Home Assistant`);
      for (const d of discovery(c.name)) { client.publish(d.topic, JSON.stringify(d.payload), { retain: true, qos: 1 }); this.published.add(d.topic); }
      client.publish(`${base}/availability`, 'online', { retain: true, qos: 1 });
      client.subscribe(`${base}/command/+`, { qos: 1 });
      this.lastState = '';
      this.publishState();
    });
    client.on('message', (topic, payload) => {
      const cmd = topic.slice(`${base}/command/`.length) as Command;
      if (!(COMMANDS as readonly string[]).includes(cmd) || payload.toString() !== 'PRESS') return;
      this.log('sys', `Home Assistant pressed ${cmd}`);
      this.run(cmd);
    });
    client.on('error', (e) => {
      const m = friendly(e as Error);
      if (m !== this.lastError) { this.lastError = m; this.log('err', `MQTT: ${m}`); }   // once per distinct problem
    });
    this.tick = setInterval(() => { if (this.snap().job.state === 'running') this.publishState(); }, 1000); // the elapsed clock
  }

  /** Leave cleanly: Home Assistant sees the device go offline. With `forget`, also remove the entities it was shown. */
  stop(forget = false) {
    clearTimeout(this.timer); clearInterval(this.tick);
    const c = this.client;
    this.client = undefined;
    if (!c) return;
    if (c.connected) {
      c.publish(`demonx/${this.slug}/availability`, 'offline', { retain: true });
      if (forget) for (const t of this.published) c.publish(t, '', { retain: true });  // an empty retained message deletes a discovered entity
    }
    this.published.clear();
    c.end();
  }

  private schedule() {
    if (!this.client || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.publishState(); }, this.throttleMs);
  }

  private publishState() {
    const c = this.client;
    if (!c?.connected) return;
    const json = JSON.stringify(buildState(this.snap()));
    if (json === this.lastState) return;
    this.lastState = json;
    c.publish(`${baseTopic(this.cfg().name)}/state`, json, { retain: true });
  }
}
