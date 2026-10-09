import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { CameraSource, ConfigUpdate, PcbConfig, PublicConfig, SpindleConfig } from '../../shared/protocol.js';
import { SPINDLE_COMMANDS, defaultPcb, defaultSpindle } from '../../shared/protocol.js';

/** The whole setup as kept on the server, secrets included. Browsers only ever see PublicConfig. */
export interface AppConfig {
  homeAssistant: { url: string; token: string; insecureTls: boolean; share: boolean };
  mqtt: { enabled: boolean; host: string; port: number; user: string; password: string; tls: boolean; name: string };
  spindle: SpindleConfig;
  pcb: PcbConfig;
  camera: Omit<PublicConfig['camera'], 'hasPassword'> & { password: string };
}

export class ConfigError extends Error {}

export const defaultConfig = (): AppConfig => ({
  homeAssistant: { url: '', token: '', insecureTls: false, share: false },
  mqtt: { enabled: false, host: '', port: 1883, user: '', password: '', tls: false, name: 'DemonX' },
  spindle: defaultSpindle(),
  pcb: defaultPcb(),
  camera: {
    source: 'none', haEntity: '', url: '', host: '', channel: 1, scheme: 'https', mode: 'snapshot', quality: 'sub',
    user: '', password: '', fps: 5, insecureTls: true,
  },
});

const SOURCES: CameraSource[] = ['none', 'ha', 'reolink', 'http', 'rtsp', 'direct', 'hastream'];

const text = (v: unknown, what: string, max: number): string => {
  if (typeof v !== 'string') throw new ConfigError(`${what} must be text`);
  if (v.length > max) throw new ConfigError(`${what} is too long`);
  return v.trim();
};

/** A URL of one of the allowed kinds with no embedded login; returns it (without a trailing slash) */
function checkUrl(v: string, what: string, schemes: string[]): string {
  if (!v) return '';
  let u: URL;
  try { u = new URL(v); } catch { throw new ConfigError(`${what} is not a valid address`); }
  if (!schemes.includes(u.protocol)) throw new ConfigError(`${what} must start with ${schemes.map((s) => s + '//').join(' or ')}`);
  return v.replace(/\/+$/, '');
}

/**
 * Split a login out of a pasted address (rtsp://user:pass@host/path) so the password is
 * kept as a secret instead of sitting in a URL that gets displayed.
 */
function splitLogin(v: string): { url: string; user?: string; password?: string } {
  try {
    const u = new URL(v);
    if (!u.username && !u.password) return { url: v };
    const user = decodeURIComponent(u.username), password = decodeURIComponent(u.password);
    u.username = ''; u.password = '';
    return { url: u.toString().replace(/\/+$/, ''), user, password };
  } catch { return { url: v }; }
}

/**
 * Validate a change and return the new full config. Throws ConfigError with a message the
 * user can act on. Secrets are only replaced when given; an empty string clears one.
 */
export function applyUpdate(cur: AppConfig, up: ConfigUpdate): AppConfig {
  const next: AppConfig = { homeAssistant: { ...cur.homeAssistant }, mqtt: { ...cur.mqtt }, spindle: { ...cur.spindle, commands: [...cur.spindle.commands], speeds: [...cur.spindle.speeds] }, pcb: { ...cur.pcb }, camera: { ...cur.camera } };

  const ha = up.homeAssistant;
  if (ha) {
    if (ha.url !== undefined) {
      const raw = text(ha.url, 'The Home Assistant address', 300);
      const sp = splitLogin(raw);
      if (sp.password || sp.user) throw new ConfigError('Do not put a login in the Home Assistant address: use the access token field');
      next.homeAssistant.url = checkUrl(raw, 'The Home Assistant address', ['http:', 'https:']);
    }
    if (ha.token !== undefined) next.homeAssistant.token = text(ha.token, 'The access token', 600);
    if (ha.insecureTls !== undefined) next.homeAssistant.insecureTls = ha.insecureTls === true;
    if (ha.share !== undefined) next.homeAssistant.share = ha.share === true;
  }

  const mq = up.mqtt;
  if (mq) {
    if (mq.host !== undefined) {
      const h = text(mq.host, 'The broker address', 253);
      if (h && !/^[A-Za-z0-9._\-[\]:]+$/.test(h)) throw new ConfigError('The broker address should be an IP address or name, like 10.20.30.50 (no mqtt:// in front)');
      next.mqtt.host = h;
    }
    if (mq.port !== undefined) {
      if (!Number.isInteger(mq.port) || mq.port < 1 || mq.port > 65535) throw new ConfigError('The broker port is a whole number from 1 to 65535 (usually 1883)');
      next.mqtt.port = mq.port;
    }
    if (mq.user !== undefined) next.mqtt.user = text(mq.user, 'The MQTT user name', 120);
    if (mq.password !== undefined) next.mqtt.password = text(mq.password, 'The MQTT password', 200);
    if (mq.tls !== undefined) next.mqtt.tls = mq.tls === true;
    if (mq.name !== undefined) {
      const n = text(mq.name, 'The device name', 30);
      if (!n || !/[A-Za-z0-9]/.test(n)) throw new ConfigError('Give the device a name, like Cubiko');
      next.mqtt.name = n;
    }
    if (mq.enabled !== undefined) next.mqtt.enabled = mq.enabled === true;
    if (next.mqtt.enabled && !next.mqtt.host) throw new ConfigError('Enter the MQTT broker address first');
  }

  const sp = up.spindle;
  if (sp) {
    if (sp.maxRpm !== undefined) {
      if (typeof sp.maxRpm !== 'number' || !Number.isFinite(sp.maxRpm) || sp.maxRpm < 100 || sp.maxRpm > 100_000) throw new ConfigError('The highest spindle speed is from 100 to 100000 RPM');
      next.spindle.maxRpm = Math.round(sp.maxRpm);
    }
    if (sp.commands !== undefined) {
      if (!Array.isArray(sp.commands) || sp.commands.some((x) => !(SPINDLE_COMMANDS as readonly string[]).includes(x))) throw new ConfigError('Unknown spindle command');
      // M5 (off) is always offered: there must always be a way to switch the spindle off
      next.spindle.commands = SPINDLE_COMMANDS.filter((x) => x === 'M5' || sp.commands!.includes(x));
    }
    if (sp.speeds !== undefined) {
      if (!Array.isArray(sp.speeds) || !sp.speeds.length || sp.speeds.length > 20 || sp.speeds.some((x) => typeof x !== 'number' || !Number.isFinite(x) || x < 1)) {
        throw new ConfigError('Spindle speeds: a list of up to 20 positive numbers');
      }
      next.spindle.speeds = [...new Set(sp.speeds.map(Math.round))].sort((a, b) => a - b);
    }
    if (next.spindle.speeds.some((x) => x > next.spindle.maxRpm)) throw new ConfigError(`A spindle speed is above the highest speed (${next.spindle.maxRpm} RPM)`);
  }

  const pc = up.pcb;
  if (pc) {
    for (const [k, label] of [['x', 'The fixture X'], ['y', 'The fixture Y'], ['safeZ', 'The safe Z']] as const) {
      const v = pc[k];
      if (v === undefined) continue;
      if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 100_000) throw new ConfigError(`${label} must be a number of millimetres`);
      next.pcb[k] = Math.round(v * 1000) / 1000;
      next.pcb.configured = true;
    }
    if (pc.enabled !== undefined) next.pcb.enabled = pc.enabled === true;
    if (next.pcb.enabled && !next.pcb.configured) throw new ConfigError('Set the fixture position and the safe height first (Settings, PCB mode)');
  }

  const c = up.camera;
  if (c) {
    if (c.source !== undefined) {
      if (!SOURCES.includes(c.source)) throw new ConfigError('Unknown camera type');
      next.camera.source = c.source;
    }
    if (c.haEntity !== undefined) {
      const e = text(c.haEntity, 'The camera entity', 120);
      if (e && !/^camera\.[a-z0-9_]+$/.test(e)) throw new ConfigError('A Home Assistant camera entity looks like camera.workshop_cnc');
      next.camera.haEntity = e;
    }
    if (c.user !== undefined) next.camera.user = text(c.user, 'The user name', 80);
    if (c.password !== undefined) next.camera.password = text(c.password, 'The password', 200);
    // the address only matters to the types that use it: the form always sends the old one along, so an
    // rtsp:// address left over from an earlier setup must not block saving a Home Assistant camera
    if (c.url !== undefined && ['http', 'rtsp', 'direct'].includes(next.camera.source)) {
      const source = next.camera.source;
      const raw = text(c.url, 'The camera address', 1000);
      if (source === 'direct') {
        if (splitLogin(raw).user !== undefined) throw new ConfigError('A direct address cannot carry a login: browsers refuse it. Use a web camera address (proxied by the server) instead');
        next.camera.url = checkUrl(raw, 'The camera address', ['http:', 'https:']);
      } else {
        const schemes = source === 'rtsp' ? ['rtsp:', 'rtsps:'] : ['http:', 'https:'];
        const sp = raw ? splitLogin(raw) : { url: '' };
        next.camera.url = checkUrl(sp.url, 'The camera address', schemes);
        if (sp.user !== undefined && c.user === undefined) next.camera.user = sp.user;
        if (sp.password !== undefined && c.password === undefined) next.camera.password = sp.password;
      }
    }
    if (c.host !== undefined) {
      const h = text(c.host, 'The camera address', 253);
      if (h && !/^[A-Za-z0-9._:\-[\]]+$/.test(h)) throw new ConfigError('The camera host should be an IP address or name, like 10.20.30.98');
      next.camera.host = h;
    }
    if (c.channel !== undefined) {
      if (!Number.isInteger(c.channel) || c.channel < 1 || c.channel > 64) throw new ConfigError('The channel is a whole number from 1 to 64');
      next.camera.channel = c.channel;
    }
    if (c.scheme !== undefined) {
      if (c.scheme !== 'https' && c.scheme !== 'http') throw new ConfigError('Connection must be https or http');
      next.camera.scheme = c.scheme;
    }
    if (c.mode !== undefined) {
      if (c.mode !== 'snapshot' && c.mode !== 'rtsp') throw new ConfigError('Unknown Reolink mode');
      next.camera.mode = c.mode;
    }
    if (c.quality !== undefined) {
      if (c.quality !== 'main' && c.quality !== 'sub') throw new ConfigError('Quality is main or sub');
      next.camera.quality = c.quality;
    }
    if (c.fps !== undefined) {
      if (typeof c.fps !== 'number' || !Number.isFinite(c.fps) || c.fps < 1 || c.fps > 30) throw new ConfigError('Frames per second is from 1 to 30');
      next.camera.fps = Math.round(c.fps);
    }
    if (c.insecureTls !== undefined) next.camera.insecureTls = c.insecureTls === true;
  }

  return next;
}

/** What browsers may see */
export function publicView(c: AppConfig): PublicConfig {
  const { password, ...cam } = c.camera;
  return {
    homeAssistant: { url: c.homeAssistant.url, hasToken: !!c.homeAssistant.token, insecureTls: c.homeAssistant.insecureTls, share: c.homeAssistant.share },
    mqtt: { enabled: c.mqtt.enabled, host: c.mqtt.host, port: c.mqtt.port, user: c.mqtt.user, hasPassword: !!c.mqtt.password, tls: c.mqtt.tls, name: c.mqtt.name },
    spindle: { ...c.spindle, commands: [...c.spindle.commands], speeds: [...c.spindle.speeds] },
    pcb: { ...c.pcb },
    camera: { ...cam, hasPassword: !!password },
  };
}

/** Holds the setup and keeps it in a file only the server's user can read. */
export class ConfigStore extends EventEmitter {
  private cfg: AppConfig = defaultConfig();
  private file?: string;

  constructor(dataDir?: string) {
    super();
    if (!dataDir) return;
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, 'config.json');
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      // go through the same validation as a live change, so a hand-edited or old file cannot put bad values in
      this.cfg = applyUpdate(defaultConfig(), { homeAssistant: saved.homeAssistant, mqtt: saved.mqtt, camera: saved.camera, spindle: saved.spindle, pcb: saved.pcb });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`Could not read ${this.file}: ${(e as Error).message}`);
    }
  }

  get full(): AppConfig { return this.cfg; }
  get view(): PublicConfig { return publicView(this.cfg); }

  /** The config as it would be after the update, without applying it (for Test buttons) */
  preview(update: ConfigUpdate): AppConfig { return applyUpdate(this.cfg, update); }

  update(update: ConfigUpdate) {
    this.cfg = applyUpdate(this.cfg, update);
    if (this.file) {
      try {
        fs.writeFileSync(this.file, JSON.stringify(this.cfg, null, 2), { mode: 0o600 });
        fs.chmodSync(this.file, 0o600); // also when the file already existed
      } catch (e) { console.error(`Could not save ${this.file}: ${(e as Error).message}`); }
    }
    this.emit('config', this.view);
  }
}
