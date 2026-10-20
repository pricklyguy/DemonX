// The camera card: one still picture from a Home Assistant camera, fetched by the server so the access token never reaches a
// browser. Where the Home Assistant address and token come from:
//   - DemonX CNC's saved setup, when DESIGN_CNC_DATA (or DESIGN_AUTH_DIR) points at its data folder: nothing to enter twice;
//   - otherwise an address and token entered here (Settings, Camera), kept in this server's data folder.
// The camera itself (its entity name) is chosen here either way.
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { hostOk } from './access.js';

export interface CameraSetup { url: string; token: string; insecureTls: boolean; entity: string; from: 'cnc' | 'own' | 'none' }
export interface CameraStatus { configured: boolean; entity: string; from: 'cnc' | 'own' | 'none'; haUrl: string; hasToken: boolean }

const ENTITY = /^camera\.[a-z0-9_]+$/;
export const validEntity = (e: unknown): e is string => typeof e === 'string' && ENTITY.test(e);

/** Home Assistant is on the home network: refuse to send its token anywhere else */
export function validHaUrl(u: unknown): string | null {
  if (typeof u !== 'string') return null;
  try {
    const url = new URL(u.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    if (!hostOk(url.host)) return null;
    return `${url.protocol}//${url.host}`;
  } catch { return null; }
}

const readJson = (file: string): any => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

export class CameraStore {
  private frame?: { at: number; body: Buffer; type: string };
  private inflight?: Promise<{ body: Buffer; type: string }>;
  constructor(private ownFile: string, private cncDataDir?: string, private now: () => number = Date.now) {}

  /** What is saved here: the entity, and an address and token if they were entered here */
  private own(): { entity?: string; url?: string; token?: string; insecureTls?: boolean } { return readJson(this.ownFile) ?? {}; }

  resolve(): CameraSetup {
    const own = this.own();
    const cnc = this.cncDataDir ? readJson(path.join(this.cncDataDir, 'config.json')) : null;
    const ha = cnc?.homeAssistant;
    if (ha?.url && ha?.token && validHaUrl(ha.url)) {
      return { url: validHaUrl(ha.url)!, token: String(ha.token), insecureTls: ha.insecureTls === true, entity: validEntity(own.entity) ? own.entity : validEntity(cnc?.camera?.haEntity) ? cnc.camera.haEntity : '', from: 'cnc' };
    }
    if (own.url && own.token && validHaUrl(own.url)) return { url: validHaUrl(own.url)!, token: own.token, insecureTls: own.insecureTls === true, entity: validEntity(own.entity) ? own.entity : '', from: 'own' };
    return { url: '', token: '', insecureTls: false, entity: validEntity(own.entity) ? own.entity : '', from: 'none' };
  }

  status(): CameraStatus {
    const c = this.resolve();
    return { configured: !!(c.url && c.token && c.entity), entity: c.entity, from: c.from, haUrl: c.url, hasToken: !!c.token };
  }

  /** Save the camera. An address and token are only taken when DemonX CNC's are not in use. Throws a plain message. */
  save(update: { entity?: unknown; url?: unknown; token?: unknown; insecureTls?: unknown }) {
    const cur = this.own();
    const next = { ...cur };
    if (update.entity !== undefined) {
      if (update.entity !== '' && !validEntity(update.entity)) throw new Error('A Home Assistant camera looks like camera.test_mainstream');
      next.entity = update.entity as string;
    }
    if (update.url !== undefined && update.url !== '') {
      const u = validHaUrl(update.url);
      if (!u) throw new Error('Home Assistant must be an address on your own network, such as http://192.168.1.10:8123');
      next.url = u;
    }
    if (typeof update.token === 'string' && update.token.trim()) next.token = update.token.trim().slice(0, 600);
    if (update.insecureTls !== undefined) next.insecureTls = update.insecureTls === true;
    fs.mkdirSync(path.dirname(this.ownFile), { recursive: true });
    fs.writeFileSync(this.ownFile, JSON.stringify(next), { mode: 0o600 });
    fs.chmodSync(this.ownFile, 0o600);
    this.frame = undefined;
  }

  /** The latest picture. Several viewers share one request to Home Assistant, and a picture under a second old is reused. */
  async still(): Promise<{ body: Buffer; type: string }> {
    const c = this.resolve();
    if (!c.url || !c.token) throw new Error('Home Assistant is not set up: use Settings, Camera');
    if (!c.entity) throw new Error('Choose a Home Assistant camera: Settings, Camera');
    if (this.frame && this.now() - this.frame.at < 1000) return this.frame;
    this.inflight ??= fetchStill(c).then((r) => { this.frame = { at: this.now(), ...r }; return r; }).finally(() => { this.inflight = undefined; });
    return this.inflight;
  }
}

const MAX_BYTES = 4 * 1024 * 1024;

function fetchStill(c: CameraSetup): Promise<{ body: Buffer; type: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(`${c.url}/api/camera_proxy/${c.entity}`);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, { method: 'GET', headers: { Authorization: `Bearer ${c.token}` }, ...(u.protocol === 'https:' && c.insecureTls ? { rejectUnauthorized: false } : {}) }, (res) => {
      if ((res.statusCode ?? 0) >= 400) {
        res.resume();
        const why: Record<number, string> = { 401: 'Home Assistant refused the access token', 404: 'Home Assistant does not know that camera' };
        return reject(new Error(why[res.statusCode!] ?? `Home Assistant answered ${res.statusCode}`));
      }
      const parts: Buffer[] = []; let n = 0;
      res.on('data', (d: Buffer) => { n += d.length; if (n > MAX_BYTES) { res.destroy(); reject(new Error('The picture was bigger than expected')); } else parts.push(d); });
      res.on('end', () => resolve({ body: Buffer.concat(parts), type: String(res.headers['content-type'] ?? 'image/jpeg') }));
      res.on('error', reject);
    });
    req.setTimeout(8000, () => req.destroy(new Error('Home Assistant did not answer in time')));
    req.on('error', (e) => reject(new Error(`Could not reach Home Assistant: ${(e as Error).message}`)));
    req.end();
  });
}
