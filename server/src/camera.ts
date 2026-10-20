import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import type { ServerResponse, IncomingMessage } from 'node:http';
import type { CameraState, HaCamera } from '../../shared/protocol.js';
import { ConfigError, type AppConfig, type ConfigStore } from './config.js';

// ---------------------------------------------------------------------------------------
// JPEG frames out of a byte stream
// ---------------------------------------------------------------------------------------

/**
 * Cuts a stream of concatenated JPEGs (what ffmpeg and MJPEG cameras produce) into frames.
 * It walks the JPEG segments rather than searching for the end marker, because an EXIF
 * thumbnail inside a frame contains its own end marker. Anything between frames (multipart
 * headers, boundaries) is skipped.
 */
export class JpegSplitter {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Buffer[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const frames: Buffer[] = [];
    for (;;) {
      const start = this.findStart();
      if (start < 0) { this.buf = this.buf.subarray(Math.max(0, this.buf.length - 2)); break; } // keep a possible split marker
      const end = this.frameEnd(start);
      if (end === 'bad') { this.buf = this.buf.subarray(start + 2); continue; }  // damaged: resync at the next start
      if (end === 'more') { this.buf = this.buf.subarray(start); break; }
      frames.push(this.buf.subarray(start, end));
      this.buf = this.buf.subarray(end);
    }
    return frames;
  }

  private findStart(): number {
    for (let i = 0; i + 2 < this.buf.length; i++) if (this.buf[i] === 0xff && this.buf[i + 1] === 0xd8 && this.buf[i + 2] === 0xff) return i;
    return -1;
  }

  /** Index just past the frame's end marker, 'more' if the frame is not complete yet, 'bad' if it is not a JPEG */
  private frameEnd(start: number): number | 'more' | 'bad' {
    const b = this.buf;
    let p = start + 2;
    for (;;) {
      if (p + 2 > b.length) return 'more';
      if (b[p] !== 0xff) return 'bad';
      const marker = b[p + 1];
      if (marker === 0xff) { p++; continue; }                                 // fill byte
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { p += 2; continue; }  // markers with no length
      // 0x00 is only a stuffed byte, 0xD8 a new picture starting and 0xD9 an end with no picture: none can open a segment
      if (marker < 0xc0 || marker === 0xd8 || marker === 0xd9) return 'bad';
      if (p + 4 > b.length) return 'more';
      const len = b.readUInt16BE(p + 2);
      if (len < 2 || p + 2 + len - start > MAX_FRAME_BYTES) return 'bad';
      if (marker === 0xda) {                                                    // start of scan: image data follows
        p += 2 + len;
        for (;;) {
          const i = b.indexOf(0xff, p);
          if (i < 0 || i + 1 >= b.length) return 'more';
          const m = b[i + 1];
          if (m === 0xd9) return i + 2;                                         // end of image
          if (m === 0xd8) return 'bad';                                         // a new picture began: this one was cut short
          p = i + 1;                                                            // FF00 (stuffed), a restart marker or fill: keep going
        }
      }
      p += 2 + len;
    }
  }
}

export const isJpeg = (b: Buffer) => b.length > 4 && b[0] === 0xff && b[1] === 0xd8;

// ---------------------------------------------------------------------------------------
// Talking to cameras
// ---------------------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

export interface Req { url: string; headers?: Record<string, string>; insecure?: boolean }

/** Start a GET and resolve when the response headers arrive (the body is read by the caller). */
export function get(r: Req, signal?: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const u = new URL(r.url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, {
      method: 'GET', headers: r.headers, signal,
      ...(u.protocol === 'https:' && r.insecure ? { rejectUnauthorized: false } : {}),
    }, (res) => {
      if ((res.statusCode ?? 0) >= 400) {
        res.resume();
        const why: Record<number, string> = { 401: 'wrong user name or password', 403: 'access refused', 404: 'not found: check the address, entity or channel' };
        return reject(new Error(`The camera answered ${res.statusCode}${why[res.statusCode!] ? ` (${why[res.statusCode!]})` : ''}`));
      }
      resolve(res);
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error('The camera did not answer in time')));
    req.on('error', (e) => reject(friendly(e)));
    req.end();
  });
}

/** Say what a network error means instead of leaving ECONNREFUSED to the user */
function friendly(e: unknown): Error {
  const err = e as NodeJS.ErrnoException;
  const code = err.code ?? '';
  const map: Record<string, string> = {
    ECONNREFUSED: 'Connection refused: nothing is listening at that address and port',
    ENOTFOUND: 'That name could not be found: check the address',
    EHOSTUNREACH: 'The camera cannot be reached from this computer',
    ENETUNREACH: 'The camera cannot be reached from this computer',
    ETIMEDOUT: 'The camera did not answer in time',
    ECONNRESET: 'The connection was dropped by the camera',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'The camera uses a self-signed certificate: tick "Accept a self-signed certificate"',
    SELF_SIGNED_CERT_IN_CHAIN: 'The camera uses a self-signed certificate: tick "Accept a self-signed certificate"',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'The certificate could not be verified: tick "Accept a self-signed certificate" if the camera is on your own network',
    ERR_TLS_CERT_ALTNAME_INVALID: 'The certificate does not match the address: tick "Accept a self-signed certificate" if the camera is on your own network',
  };
  if (err.name === 'AbortError') return err;
  return new Error(map[code] ?? err.message ?? 'Could not reach the camera');
}

async function readBody(res: IncomingMessage, max = MAX_FRAME_BYTES): Promise<Buffer> {
  const parts: Buffer[] = []; let n = 0;
  for await (const c of res) { n += (c as Buffer).length; if (n > max) { res.destroy(); throw new Error('The camera sent more data than a picture should be'); } parts.push(c as Buffer); }
  return Buffer.concat(parts);
}

const basic = (u: string, p: string) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
const enc = encodeURIComponent;

/** How to get video from a configured camera, or why it cannot be done yet */
export type Spec =
  | { kind: 'poll'; req: Req }                               // fetch pictures over and over
  | { kind: 'http'; req: Req }                               // a web address: a stream or a single picture, found out on connect
  | { kind: 'rtsp'; url: string };                           // ffmpeg turns it into pictures

export function specFor(c: AppConfig): Spec {
  const k = c.camera;
  switch (k.source) {
    case 'ha':
    case 'hastream': { // the stream itself is served by hastream.ts; this is the still picture used by Test and as a fallback
      if (!c.homeAssistant.url) throw new ConfigError('Home Assistant is not set up yet: enter its address and an access token');
      if (!c.homeAssistant.token) throw new ConfigError('Home Assistant needs an access token (Profile, Security, Long-lived access tokens)');
      if (!k.haEntity) throw new ConfigError('Choose a Home Assistant camera');
      return { kind: 'poll', req: { url: `${c.homeAssistant.url}/api/camera_proxy/${k.haEntity}`, headers: { Authorization: `Bearer ${c.homeAssistant.token}` }, insecure: c.homeAssistant.insecureTls } };
    }
    case 'reolink': {
      if (!k.host) throw new ConfigError('Enter the camera or NVR address');
      if (k.mode === 'rtsp') {
        const login = k.user ? `${enc(k.user)}:${enc(k.password)}@` : '';
        return { kind: 'rtsp', url: `rtsp://${login}${k.host}:554/h264Preview_${String(k.channel).padStart(2, '0')}_${k.quality === 'main' ? 'main' : 'sub'}` };
      }
      // the Reolink API counts channels from 0; the app and the NVR screen count from 1
      const q = `cmd=Snap&channel=${k.channel - 1}&rs=demonx&user=${enc(k.user)}&password=${enc(k.password)}`;
      return { kind: 'poll', req: { url: `${k.scheme}://${k.host}/cgi-bin/api.cgi?${q}`, insecure: k.insecureTls } };
    }
    case 'http': {
      if (!k.url) throw new ConfigError('Enter the camera address');
      return { kind: 'http', req: { url: k.url, headers: k.user ? { Authorization: basic(k.user, k.password) } : undefined, insecure: k.insecureTls } };
    }
    case 'rtsp': {
      if (!k.url) throw new ConfigError('Enter the RTSP address');
      const u = new URL(k.url);
      if (k.user) { u.username = k.user; u.password = k.password; }
      return { kind: 'rtsp', url: u.toString() };
    }
    case 'direct': throw new ConfigError('A direct camera is shown by your browser itself: the server has nothing to stream');
    default: throw new ConfigError('No camera is set up');
  }
}

/** One picture. Used by the poller and by the Test button. */
export async function fetchFrame(req: Req, signal?: AbortSignal): Promise<Buffer> {
  const res = await get(req, signal);
  const body = await readBody(res);
  if (!isJpeg(body)) throw new Error('The address answered, but not with a JPEG picture. Is it the right camera address?');
  return body;
}

/** List the camera entities of a Home Assistant */
export async function listHaCameras(url: string, token: string, insecure: boolean): Promise<HaCamera[]> {
  if (!url) throw new ConfigError('Enter the Home Assistant address first');
  if (!token) throw new ConfigError('Enter an access token first (Profile, Security, Long-lived access tokens)');
  const res = await get({ url: `${url}/api/states`, headers: { Authorization: `Bearer ${token}` }, insecure });
  let states: unknown;
  try { states = JSON.parse((await readBody(res, 20 * 1024 * 1024)).toString('utf8')); } catch { throw new Error('That address did not answer like Home Assistant'); }
  if (!Array.isArray(states)) throw new Error('That address did not answer like Home Assistant');
  return states
    .filter((s: { entity_id?: unknown }) => typeof s?.entity_id === 'string' && (s.entity_id as string).startsWith('camera.'))
    .map((s: { entity_id: string; attributes?: { friendly_name?: string } }) => ({ entity_id: s.entity_id, name: s.attributes?.friendly_name ?? s.entity_id }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------------------
// Upstreams: each pushes frames until stopped
// ---------------------------------------------------------------------------------------

interface Sink { onFrame: (f: Buffer) => void; onError: (message: string) => void }
type Stop = () => void;

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const t = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

/** Fetch pictures at about `fps`, backing off when the camera is unreachable. */
function startPoller(getFrame: (s: AbortSignal) => Promise<Buffer>, fps: number, sink: Sink): Stop {
  const ac = new AbortController();
  void (async () => {
    let backoff = 1000;
    while (!ac.signal.aborted) {
      const t0 = Date.now();
      try {
        sink.onFrame(await getFrame(ac.signal));
        backoff = 1000;
        await sleep(Math.max(0, 1000 / fps - (Date.now() - t0)), ac.signal);
      } catch (e) {
        if (ac.signal.aborted) return;
        sink.onError((e as Error).message);
        await sleep(backoff, ac.signal);
        backoff = Math.min(backoff * 2, 10_000);
      }
    }
  })();
  return () => ac.abort();
}

/** A web address: if it answers with a multipart stream read it, if with a single picture keep fetching it. */
function startHttp(req: Req, fps: number, sink: Sink): Stop {
  const ac = new AbortController();
  void (async () => {
    let backoff = 1000;
    while (!ac.signal.aborted) {
      try {
        const res = await get(req, ac.signal);
        backoff = 1000;
        const type = String(res.headers['content-type'] ?? '');
        if (/multipart/i.test(type)) {
          const split = new JpegSplitter();
          await new Promise<void>((resolve, reject) => {
            res.on('data', (c: Buffer) => { for (const f of split.push(c)) sink.onFrame(f); });
            res.on('end', resolve); res.on('error', reject); res.on('close', resolve);
          });
          if (!ac.signal.aborted) sink.onError('The camera stream ended; reconnecting');
        } else {
          const first = await readBody(res);
          if (!isJpeg(first)) throw new Error('The address answered, but not with a picture or a video stream. Is it the right camera address?');
          sink.onFrame(first);
          startPollingInto(req, fps, sink, ac);
          return;
        }
      } catch (e) {
        if (ac.signal.aborted) return;
        sink.onError((e as Error).message);
      }
      await sleep(backoff, ac.signal);
      backoff = Math.min(backoff * 2, 10_000);
    }
  })();
  return () => ac.abort();
}

function startPollingInto(req: Req, fps: number, sink: Sink, ac: AbortController) {
  const stop = startPoller((s) => fetchFrame(req, s), fps, sink);
  ac.signal.addEventListener('abort', stop, { once: true });
}

/**
 * ffmpeg arguments for RTSP to a stream of JPEGs. Choppy video came from three things: camera
 * timestamps with network jitter fed straight to the fps filter (uneven spacing, dropped and
 * repeated pictures), ffmpeg buffering before it started, and decoding and re-encoding the
 * full-size picture (a 4K main stream is far more than a mini PC can do at 15 fps).
 */
export function rtspArgs(url: string, fps: number): string[] {
  return [
    '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'rtsp,rtp,tcp,udp,tls,crypto',
    '-fflags', 'nobuffer+discardcorrupt', '-flags', 'low_delay', '-use_wallclock_as_timestamps', '1',
    '-rtsp_transport', 'tcp', '-i', url, '-an',
    '-vf', `fps=${fps},scale='min(1280,iw)':-2`,
    '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '5', 'pipe:1',
  ];
}

/** An RTSP address through ffmpeg. */
function startRtsp(url: string, fps: number, sink: Sink, ffmpeg = 'ffmpeg'): Stop {
  let child: ChildProcess | undefined;
  let stopped = false;
  const ac = new AbortController();
  void (async () => {
    while (!stopped) {
      const split = new JpegSplitter();
      let err = '';
      const reason = await new Promise<string>((resolve) => {
        child = spawn(ffmpeg, [
          ...rtspArgs(url, fps),
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout!.on('data', (c: Buffer) => { for (const f of split.push(c)) sink.onFrame(f); });
        child.stderr!.on('data', (c: Buffer) => { err = (err + c.toString()).slice(-300); });
        child.on('error', (e: NodeJS.ErrnoException) => resolve(e.code === 'ENOENT' ? 'NO_FFMPEG' : e.message));
        child.on('close', () => resolve(err.trim() || 'The video stream ended'));
      });
      if (stopped) return;
      if (reason === 'NO_FFMPEG') { sink.onError('ffmpeg is not installed on the DemonX computer, and RTSP video needs it. Install ffmpeg, or use a Home Assistant camera or a Reolink snapshot instead'); return; }
      sink.onError(reason.replace(/rtsp:\/\/[^@\s]*@/g, 'rtsp://***@')); // never repeat a password back
      await sleep(3000, ac.signal);
    }
  })();
  return () => { stopped = true; ac.abort(); child?.kill('SIGKILL'); };
}

// ---------------------------------------------------------------------------------------
// The hub: one upstream shared by every viewer
// ---------------------------------------------------------------------------------------

const BOUNDARY = 'demonxframe';
const STALE_MS = 15_000;

/**
 * Pulls video from the camera only while someone is watching, and shares that one pull with
 * every viewer as an MJPEG stream (which a plain <img> understands). Credentials stay here.
 */
export class CameraHub extends EventEmitter {
  state: CameraState = { running: false, viewers: 0, fps: 0 };
  private clients = new Set<ServerResponse>();
  private stop?: Stop;
  private idleTimer?: NodeJS.Timeout;
  private watchdog?: NodeJS.Timeout;
  private last?: Buffer;
  private lastAt = 0;
  private frameTimes: number[] = [];
  private lastFpsEmit = 0;

  constructor(private config: ConfigStore, private opts: { idleMs?: number; ffmpeg?: string } = {}) {
    super();
    // a changed setup restarts a running stream with the new settings
    config.on('config', () => { if (this.state.running) { this.halt(); this.begin(); } });
  }

  /** Serve a viewer. Returns false (and answers) when there is nothing to stream. */
  attach(res: ServerResponse): boolean {
    try { specFor(this.config.full); } catch (e) {
      res.writeHead(409, { 'content-type': 'text/plain' }).end((e as Error).message);
      return false;
    }
    res.writeHead(200, {
      'content-type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
      'cache-control': 'no-store, no-cache, must-revalidate', pragma: 'no-cache', connection: 'close',
    });
    this.clients.add(res);
    res.on('close', () => this.detach(res));
    if (this.last && Date.now() - this.lastAt < STALE_MS) this.write(res, this.last);
    clearTimeout(this.idleTimer);
    if (!this.state.running) this.begin();
    this.setState({ viewers: this.clients.size });
    return true;
  }

  /** One picture for the Test button, from the saved setup or one with unsaved changes. */
  async grabOne(cfg: AppConfig = this.config.full): Promise<Buffer> {
    const spec = specFor(cfg);
    if (spec.kind === 'poll' || spec.kind === 'http') return fetchFrame(spec.req);
    return new Promise<Buffer>((resolve, reject) => {
      let done = false;
      const finish = (f?: Buffer, e?: string) => { if (done) return; done = true; clearTimeout(t); stop(); f ? resolve(f) : reject(new Error(e)); };
      const stop = startRtsp(spec.url, 1, { onFrame: (f) => finish(f), onError: (m) => finish(undefined, m) }, this.opts.ffmpeg);
      const t = setTimeout(() => finish(undefined, 'No video arrived within 15 seconds'), 15_000);
    });
  }

  close() { this.halt(); for (const c of this.clients) c.end(); this.clients.clear(); clearTimeout(this.idleTimer); }

  // ---------- internals ----------
  private detach(res: ServerResponse) {
    if (!this.clients.delete(res)) return;
    this.setState({ viewers: this.clients.size });
    if (this.clients.size === 0) {
      // keep going briefly, so a page reload or a quick restart does not tear the upstream down
      this.idleTimer = setTimeout(() => this.halt(), this.opts.idleMs ?? 5000);
    }
  }

  private begin() {
    let spec: Spec;
    try { spec = specFor(this.config.full); } catch (e) { this.setState({ running: false, error: (e as Error).message }); return; }
    const c = this.config.full.camera;
    const sink: Sink = { onFrame: (f) => this.onFrame(f), onError: (m) => this.setState({ error: m }) };
    this.stop = spec.kind === 'poll' ? startPoller((s) => fetchFrame(spec.req, s), c.fps, sink)
      : spec.kind === 'http' ? startHttp(spec.req, c.fps, sink)
      : startRtsp(spec.url, c.fps, sink, this.opts.ffmpeg);
    this.lastAt = Date.now();
    this.watchdog = setInterval(() => {
      if (Date.now() - this.lastAt > STALE_MS && !this.state.error) this.setState({ error: 'No video for 15 seconds' });
    }, 5000);
    this.setState({ running: true, error: undefined });
  }

  private halt() {
    this.stop?.(); this.stop = undefined;
    clearInterval(this.watchdog);
    this.last = undefined; this.frameTimes = [];
    this.setState({ running: false, fps: 0 });
  }

  private onFrame(f: Buffer) {
    const now = Date.now();
    this.last = f; this.lastAt = now;
    this.frameTimes = this.frameTimes.filter((t) => now - t < 5000); this.frameTimes.push(now);
    for (const c of this.clients) this.write(c, f);
    // a rate needs a few pictures to be meaningful: do not announce "0 fps" while the first ones arrive
    const enough = this.frameTimes.length >= 3;
    const fps = enough ? Math.round(((this.frameTimes.length - 1) / ((now - this.frameTimes[0]) / 1000)) * 10) / 10 : this.state.fps;
    if (this.state.error) this.setState({ error: undefined, fps });
    else if (enough && now - this.lastFpsEmit > 1000) { this.lastFpsEmit = now; this.setState({ fps }); }
  }

  /** A viewer that cannot keep up misses frames instead of making the others wait */
  private write(res: ServerResponse, f: Buffer) {
    if (res.writableNeedDrain || res.destroyed) return;
    res.write(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${f.length}\r\n\r\n`);
    res.write(f);
    res.write('\r\n');
  }

  private setState(patch: Partial<CameraState>) {
    const next = { ...this.state, ...patch };
    if (JSON.stringify(next) === JSON.stringify(this.state)) return;
    this.state = next;
    this.emit('state', next);
  }
}
