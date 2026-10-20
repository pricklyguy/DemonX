import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Who may control the machine.
 *
 * One shared PIN (or passphrase). Three states:
 *  - "pin":   a PIN is set. A browser that has not signed in is a viewer.
 *  - "setup": no PIN yet (a fresh install). Every browser is a viewer, except the one on the DemonX computer itself,
 *             until a PIN is set. A browser elsewhere can set the first PIN by entering the setup code the server prints.
 *  - "open":  someone chose, on purpose, to run without a PIN. Browsers on the home network control the machine.
 * In every state a browser from outside the network (a public address, a VPN such as Tailscale, or behind a proxy)
 * can only watch until it signs in with a PIN.
 */
export class AuthError extends Error {
  constructor(message: string, readonly retryAfterSec?: number) { super(message); }
}

export type Mode = 'pin' | 'open' | 'setup';
/** Where a connection comes from: this computer, the home network, or anywhere else */
export type Peer = 'local' | 'lan' | 'outside';
export type Role = 'operator' | 'viewer';

export const PIN_MIN = 4;
export const PIN_MAX = 64;
export const COOKIE = 'demonx_session';
/** "Remember this device" signs in for 90 days and survives a restart; otherwise 12 hours (and the cookie ends with the browser) */
export const REMEMBER_MS = 90 * 24 * 3600_000;
const SHORT_MS = 12 * 3600_000;
const MAX_SESSIONS = 200;

interface Saved { salt: string; hash: string }

const digest = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

const hashPin = (pin: string, salt: Buffer) => crypto.scryptSync(pin, salt, 32);

export class AuthStore extends EventEmitter {
  private saved: Saved | null = null;
  private open = false;
  private file?: string;
  private fileMtime = 0;
  private lastStat = 0;
  private code?: string;
  /** sha256(token) -> expiry. Remembered sessions are kept in auth.json so an update or restart does not sign them out. */
  private sessions = new Map<string, number>();
  private fails = new Map<string, { n: number; until: number }>();

  constructor(dataDir?: string, private now: () => number = Date.now) {
    super();
    if (dataDir) {
      fs.mkdirSync(dataDir, { recursive: true });
      this.file = path.join(dataDir, 'auth.json');
      this.load();
    }
    this.ensureCode();
  }

  /** Read auth.json (a PIN, or the choice to run without one, or neither) */
  private load() {
    this.saved = null; this.open = false; this.sessions.clear();
    if (!this.file) return;
    try {
      this.fileMtime = fs.statSync(this.file).mtimeMs;
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (typeof j.salt === 'string' && typeof j.hash === 'string') {
        this.saved = { salt: j.salt, hash: j.hash };
        const t = this.now();
        if (j.sessions && typeof j.sessions === 'object') {
          for (const [k, exp] of Object.entries(j.sessions)) if (typeof exp === 'number' && exp > t) this.sessions.set(k, exp);
        }
      } else if (j.open === true) this.open = true;
    } catch (e) {
      this.fileMtime = 0;
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`Could not read ${this.file}: ${(e as Error).message}`);
    }
  }

  /** Pick up a change made by another program (the "set PIN" command, or the file being deleted), at most once a second */
  private sync() {
    if (!this.file) return;
    const t = this.now();
    if (t - this.lastStat < 1000) return;
    this.lastStat = t;
    let m = 0;
    try { m = fs.statSync(this.file).mtimeMs; } catch { /* no file */ }
    if (m === this.fileMtime) return;
    const before = this.stateKey();
    this.load();
    this.fileMtime = m;
    this.ensureCode();
    if (this.stateKey() !== before) this.emit('changed');
  }

  private stateKey() { return `${this.saved?.hash ?? ''}|${this.open}`; }

  get mode(): Mode { this.sync(); return this.saved ? 'pin' : this.open ? 'open' : 'setup'; }
  get enabled(): boolean { return this.mode === 'pin'; }

  /** The one-time setup code (8 digits) while there is no PIN and no choice to go without: shown on the DemonX computer */
  get setupCode(): string | undefined { this.sync(); return this.mode === 'setup' ? this.code : undefined; }
  private ensureCode() {
    if (this.mode === 'setup') this.code ??= String(crypto.randomInt(0, 100_000_000)).padStart(8, '0');
    else this.code = undefined;
  }
  /** "1234-5678" */
  static formatCode = (c: string) => `${c.slice(0, 4)}-${c.slice(4)}`;

  private sessionValid(token: string | undefined): boolean {
    if (!this.saved || !token) return false;
    const key = digest(token);
    const exp = this.sessions.get(key);
    if (exp === undefined) return false;
    if (exp < this.now()) { this.sessions.delete(key); return false; }
    return true;
  }

  /**
   * The rule. A browser on the DemonX computer itself is always an operator. Otherwise: with a PIN, only a signed-in
   * session; with no PIN but a deliberate choice to go without, browsers on the home network; in setup, nobody.
   * With `trustLocal` off the DemonX computer is treated like any other home-network browser.
   */
  roleFor(peer: Peer, token: string | undefined, trustLocal = true): Role {
    const mode = this.mode;
    if (peer === 'local' && trustLocal) return 'operator';
    if (mode === 'pin') return this.sessionValid(token) ? 'operator' : 'viewer';
    if (mode === 'open') return peer === 'outside' ? 'viewer' : 'operator';
    return 'viewer';
  }

  /** Is this the right setup code? Wrong tries lock the address out for a while, the same as wrong PINs. */
  checkCode(code: unknown, who: string) {
    const t = this.now();
    const key = `code:${who}`;
    const f = this.fails.get(key);
    if (f && f.until > t) throw new AuthError('Too many wrong codes. Wait and try again', Math.ceil((f.until - t) / 1000));
    const given = typeof code === 'string' ? code.replace(/\D/g, '') : '';
    const want = this.setupCode;
    const ok = !!want && given.length === want.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(want));
    if (ok) { this.fails.delete(key); return; }
    const n = (f?.n ?? 0) + 1;
    const wait = n > 5 ? Math.min(900_000, 5000 * 2 ** (n - 6)) : 0;
    this.fails.set(key, { n, until: t + wait });
    if (this.fails.size > 1000) this.fails.delete(this.fails.keys().next().value as string);
    throw new AuthError('That is not the setup code', wait ? Math.ceil(wait / 1000) : undefined);
  }

  /**
   * May this caller set or change the PIN, or choose to go without one? An operator may. In setup, a browser elsewhere
   * may too if it knows the setup code (throws when the code is wrong).
   */
  canSetPin(peer: Peer, token: string | undefined, code: unknown, who: string, trustLocal = true): boolean {
    if (this.roleFor(peer, token, trustLocal) === 'operator') return true;
    if (this.mode !== 'setup') return false;
    this.checkCode(code, who);
    return true;
  }

  private check(pin: unknown): string {
    if (typeof pin !== 'string' || pin.length < PIN_MIN) throw new AuthError(`The PIN must be at least ${PIN_MIN} characters`);
    if (pin.length > PIN_MAX) throw new AuthError(`The PIN must be at most ${PIN_MAX} characters`);
    return pin;
  }

  private newSession(remember: boolean): string {
    const t = this.now();
    for (const [k, exp] of this.sessions) if (exp < t) this.sessions.delete(k);
    while (this.sessions.size >= MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value as string);
    const token = crypto.randomBytes(32).toString('hex');
    this.sessions.set(digest(token), t + (remember ? REMEMBER_MS : SHORT_MS));
    this.persist();
    return token;
  }

  private persist() {
    if (!this.file) return;
    if (this.saved) {
      // only the long-lived sessions are worth keeping across a restart
      const keep = Object.fromEntries([...this.sessions].filter(([, exp]) => exp - this.now() > SHORT_MS));
      fs.writeFileSync(this.file, JSON.stringify({ ...this.saved, sessions: keep }), { mode: 0o600 });
    } else if (this.open) fs.writeFileSync(this.file, JSON.stringify({ open: true }), { mode: 0o600 });
    else { fs.rmSync(this.file, { force: true }); this.fileMtime = 0; return; }
    fs.chmodSync(this.file, 0o600);
    this.fileMtime = fs.statSync(this.file).mtimeMs;   // our own write is not a change made by someone else
  }

  /** Check a PIN from a client at `who` (an address). Returns a new session token. Too many wrong tries lock that address out for a while. */
  login(pin: unknown, who: string, remember = false): string {
    if (this.mode !== 'pin' || !this.saved) throw new AuthError('No PIN is set');
    const t = this.now();
    const f = this.fails.get(who);
    if (f && f.until > t) throw new AuthError('Too many wrong PINs. Wait and try again', Math.ceil((f.until - t) / 1000));
    const given = typeof pin === 'string' ? pin.slice(0, PIN_MAX) : '';
    const ok = crypto.timingSafeEqual(hashPin(given, Buffer.from(this.saved.salt, 'hex')), Buffer.from(this.saved.hash, 'hex'));
    if (!ok) {
      const n = (f?.n ?? 0) + 1;
      // 5 free tries, then 5 s, 10 s, 20 s ... up to 15 minutes
      const wait = n > 5 ? Math.min(900_000, 5000 * 2 ** (n - 6)) : 0;
      this.fails.set(who, { n, until: t + wait });
      if (this.fails.size > 1000) this.fails.delete(this.fails.keys().next().value as string);
      throw new AuthError('Wrong PIN', wait ? Math.ceil(wait / 1000) : undefined);
    }
    this.fails.delete(who);
    return this.newSession(remember);
  }

  logout(token: string | undefined) {
    if (token && this.sessions.delete(digest(token))) { this.persist(); this.emit('changed'); }
  }

  /**
   * Set or change the PIN. The caller must already be allowed (canSetPin): index.ts checks that.
   * Every other session is signed out; the caller gets a fresh one.
   */
  setPin(pin: unknown): string {
    const p = this.check(pin);
    const salt = crypto.randomBytes(16);
    this.saved = { salt: salt.toString('hex'), hash: hashPin(p, salt).toString('hex') };
    this.open = false;
    this.code = undefined;
    this.sessions.clear();
    this.fails.clear();
    const token = this.newSession(true);
    this.emit('changed');
    return token;
  }

  /** Choose, on purpose, to run without a PIN: browsers on the home network can then control the machine */
  chooseOpen() {
    this.saved = null;
    this.open = true;
    this.code = undefined;
    this.persist();
    this.sessions.clear();
    this.fails.clear();
    this.emit('changed');
  }

  /** Remove the PIN. That is the same deliberate choice as chooseOpen. */
  clearPin() { this.chooseOpen(); }
}

export function sessionToken(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim() || undefined;
  }
  return undefined;
}

/** Without `remember` there is no Max-Age, so the browser forgets the sign-in when it closes */
export const sessionCookie = (token: string, remember = true) =>
  `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict${remember ? `; Max-Age=${REMEMBER_MS / 1000}` : ''}`;
export const clearedCookie = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;

/** A browser POST must come from this very site: refuses a page on another site that tries to act for the user */
export function sameOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true; // not sent by non-browser callers (curl); a browser always sends it on a POST
  try { return new URL(origin).host === host; } catch { return false; }
}

/** Headers a proxy or tunnel adds: their presence means the real origin of the request is hidden */
const PROXY_HEADERS = ['x-forwarded-for', 'forwarded', 'x-real-ip', 'cf-connecting-ip', 'true-client-ip'];
const proxied = (headers: Record<string, string | string[] | undefined>) => PROXY_HEADERS.some((h) => headers[h]);

/**
 * Is this connection from the DemonX computer itself (the one attached to the machine)? Its own screen needs no PIN.
 * Only a direct connection counts: a request that carries a forwarding header came through a proxy, which makes
 * every visitor look local, so it does not.
 */
export function isLocalRequest(remote: string | undefined, headers: Record<string, string | string[] | undefined>, own: Set<string> = ownAddresses()): boolean {
  if (!remote || proxied(headers)) return false;
  const a = remote.replace(/^::ffff:/, '');
  return a === '127.0.0.1' || a === '::1' || own.has(a);
}

/** The addresses of this computer's own network cards (the browser on the DemonX computer may use any of them) */
export function ownAddresses(): Set<string> {
  const out = new Set<string>();
  for (const list of Object.values(os.networkInterfaces())) for (const i of list ?? []) out.add(i.address);
  return out;
}

const v4ToBig = (ip: string): bigint | undefined => {
  const p = ip.split('.').map(Number);
  return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? p.reduce((a, n) => (a << 8n) | BigInt(n), 0n) : undefined;
};
const v6ToBig = (ip: string): bigint | undefined => {
  const [head, tail, extra] = ip.toLowerCase().split('::');
  if (extra !== undefined || !/^[0-9a-f:]*$/.test(ip.toLowerCase())) return undefined;
  const h = head ? head.split(':') : [], t = tail ? tail.split(':') : [];
  if (tail === undefined ? h.length !== 8 : h.length + t.length > 7) return undefined;
  const groups = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return undefined;
  return groups.reduce((a, g) => (a << 16n) | BigInt(parseInt(g, 16)), 0n);
};
const toBig = (ip: string) => (ip.includes(':') ? v6ToBig(ip) : v4ToBig(ip));
const within = (ip: bigint, base: bigint, prefix: number, bits: number) => prefix <= 0 || (ip >> BigInt(bits - prefix)) === (base >> BigInt(bits - prefix));

/**
 * Where does this connection come from? "local": this computer. "lan": the home or office network (a private range, or
 * the same subnet as one of this computer's network cards). "outside": a public address, a VPN such as Tailscale
 * (100.64.0.0/10), or anything that came through a proxy or tunnel (which hides the real origin).
 * With `trustLocal` off, this computer counts as "lan".
 */
export function classifyPeer(
  remote: string | undefined,
  headers: Record<string, string | string[] | undefined>,
  nets: ReturnType<typeof os.networkInterfaces> = os.networkInterfaces(),
  trustLocal = true,
): Peer {
  if (!remote || proxied(headers)) return 'outside';
  const ip = remote.replace(/^::ffff:/i, '').split('%')[0];
  const own = new Set<string>();
  for (const list of Object.values(nets)) for (const i of list ?? []) own.add(i.address);
  if (/^127\./.test(ip) || ip === '::1' || own.has(ip)) return trustLocal ? 'local' : 'lan';
  const n = toBig(ip);
  if (n === undefined) return 'outside';
  if (!ip.includes(':')) {
    const b = Number(n >> 16n);          // the first two numbers, as one value: a.b
    const a = b >> 8, c = b & 255;
    if (a === 100 && c >= 64 && c <= 127) return 'outside';                       // 100.64.0.0/10: Tailscale and other VPNs
    if (a === 10 || (a === 172 && c >= 16 && c <= 31) || (a === 192 && c === 168) || (a === 169 && c === 254)) return 'lan';
  } else {
    const top = Number(n >> 112n);
    if ((top & 0xffc0) === 0xfe80 || (top & 0xfe00) === 0xfc00) return 'lan';     // link-local and unique-local addresses
  }
  // same subnet as one of this computer's own network cards (also covers IPv6 addresses on the home network)
  for (const list of Object.values(nets)) {
    for (const i of list ?? []) {
      if (i.internal || !i.cidr) continue;
      const [base, len] = i.cidr.split('/');
      const bb = toBig(base), prefix = Number(len);
      if (bb === undefined || !Number.isFinite(prefix) || (base.includes(':') !== ip.includes(':'))) continue;
      if (prefix === 0) continue;       // a catch-all route is not a network
      if (within(n, bb, prefix, ip.includes(':') ? 128 : 32)) return 'lan';
    }
  }
  return 'outside';
}

/**
 * The addresses other devices can use to open DemonX: this computer's own IPv4 addresses on the network, home-network
 * ranges first (a computer can also have virtual adapters, VPNs and so on, which are listed last).
 */
export function lanUrls(port: number, nets: ReturnType<typeof os.networkInterfaces> = os.networkInterfaces()): string[] {
  const rank = (a: string) => (/^192\.168\./.test(a) ? 0 : /^10\./.test(a) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(a) ? 2 : 3);
  const found: string[] = [];
  for (const list of Object.values(nets)) {
    for (const i of list ?? []) {
      if (i.family !== 'IPv4' || i.internal || i.address.startsWith('169.254.')) continue;
      found.push(i.address);
    }
  }
  return [...new Set(found)].sort((a, b) => rank(a) - rank(b)).map((a) => `http://${a}:${port}`);
}
