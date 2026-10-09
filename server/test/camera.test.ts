import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { CameraHub, JpegSplitter, isJpeg, listHaCameras, specFor, rtspArgs } from '../src/camera.js';
import { ConfigStore, ConfigError, applyUpdate, defaultConfig, publicView } from '../src/config.js';

const FA = fs.readFileSync(new URL('./fixtures/frame-a.jpg', import.meta.url));
const FB = fs.readFileSync(new URL('./fixtures/frame-b.jpg', import.meta.url));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error('timeout'); await wait(20); }
}

// ---------------------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------------------
const servers: http.Server[] = [];
const hubs: CameraHub[] = [];
afterEach(() => { for (const h of hubs.splice(0)) h.close(); for (const s of servers.splice(0)) { s.closeAllConnections(); s.close(); } });

interface Seen { url: string; headers: http.IncomingHttpHeaders }
async function fake(handler: (req: http.IncomingMessage, res: http.ServerResponse, n: number) => void) {
  const seen: Seen[] = [];
  const s = http.createServer((req, res) => { seen.push({ url: req.url ?? '', headers: req.headers }); handler(req, res, seen.length); });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as AddressInfo).port;
  return { port, url: `http://127.0.0.1:${port}`, seen };
}
const jpeg = (res: http.ServerResponse, n = 0) => { res.writeHead(200, { 'content-type': 'image/jpeg' }); res.end(n % 2 ? FB : FA); };

/** A camera that streams multipart JPEGs for as long as the client stays */
const mjpegCamera = (req: http.IncomingMessage, res: http.ServerResponse) => {
  res.writeHead(200, { 'content-type': 'multipart/x-mixed-replace; boundary=frame' });
  let i = 0;
  const t = setInterval(() => { const f = i++ % 2 ? FB : FA; res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${f.length}\r\n\r\n`); res.write(f); res.write('\r\n'); }, 30);
  req.on('close', () => clearInterval(t));
};

function setup(update: Parameters<ConfigStore['update']>[0], opts: ConstructorParameters<typeof CameraHub>[1] = { idleMs: 100 }) {
  const config = new ConfigStore();
  config.update(update);
  const hub = new CameraHub(config, opts);
  hubs.push(hub);
  // the hub behind a plain route, like the real server
  return { config, hub };
}

/** Watch a hub the way a browser <img> does: open the stream and read frames */
async function watch(hub: CameraHub, frames: number, ms = 6000) {
  const s = http.createServer((_q, res) => { hub.attach(res); });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const got: Buffer[] = []; const split = new JpegSplitter();
  let headers: http.IncomingHttpHeaders = {}; let status = 0; let body = '';
  const req = http.get({ host: '127.0.0.1', port: (s.address() as AddressInfo).port });
  const done = new Promise<void>((resolve) => {
    req.on('response', (res) => {
      status = res.statusCode ?? 0; headers = res.headers;
      res.on('data', (c: Buffer) => { if (status !== 200) { body += c.toString(); return; } for (const f of split.push(c)) { got.push(f); if (got.length >= frames) resolve(); } });
      res.on('end', resolve);
    });
    req.on('error', resolve);
    setTimeout(resolve, ms);
  });
  await done;
  return { frames: got, headers, status, body, close: () => req.destroy() };
}

// ---------------------------------------------------------------------------------------
describe('JpegSplitter', () => {
  const split = (chunks: Buffer[]) => { const s = new JpegSplitter(); return chunks.flatMap((c) => s.push(c)); };
  const chunked = (b: Buffer, n: number) => { const out: Buffer[] = []; for (let i = 0; i < b.length; i += n) out.push(b.subarray(i, i + n)); return out; };

  it('finds every frame however the bytes arrive', () => {
    const stream = Buffer.concat([FA, FB, FA]);
    for (const n of [1, 3, 7, 64, 500, stream.length]) {
      const f = split(chunked(stream, n));
      expect(f.length, `chunk size ${n}`).toBe(3);
      expect(f[0].equals(FA) && f[1].equals(FB) && f[2].equals(FA), `chunk size ${n}`).toBe(true);
    }
  });

  it('skips multipart headers and boundaries between frames', () => {
    const glue = (f: Buffer) => Buffer.concat([Buffer.from(`\r\n--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${f.length}\r\n\r\n`), f]);
    const f = split(chunked(Buffer.concat([glue(FA), glue(FB), Buffer.from('\r\n--frame--')]), 13));
    expect(f.length).toBe(2);
    expect(f[1].equals(FB)).toBe(true);
  });

  it('is not fooled by an end marker inside an embedded thumbnail', () => {
    // SOI, APP1 carrying a whole little JPEG (with its own end marker), SOS with stuffed FF00, EOI
    const thumb = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xd9]);
    const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, 0x00, thumb.length + 2]), thumb]);
    const sos = Buffer.from([0xff, 0xda, 0x00, 0x04, 0x01, 0x02]);
    const data = Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56]);   // stuffed byte and a restart marker
    const frame = Buffer.concat([Buffer.from([0xff, 0xd8]), app1, sos, data, Buffer.from([0xff, 0xd9])]);
    const f = split([Buffer.concat([frame, frame])]);
    expect(f.length).toBe(2);
    expect(f[0].equals(frame)).toBe(true);
  });

  it('waits for the rest of a frame, and does not hand out half a picture', () => {
    const s = new JpegSplitter();
    expect(s.push(FA.subarray(0, FA.length - 10))).toEqual([]);
    const f = s.push(FA.subarray(FA.length - 10));
    expect(f.length).toBe(1);
    expect(f[0].equals(FA)).toBe(true);
  });

  it('resynchronises after a damaged frame', () => {
    const damaged = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x12, 0x34]);
    const f = split([Buffer.concat([damaged, FB])]);
    expect(f.length).toBe(1);
    expect(f[0].equals(FB)).toBe(true);
  });

  it('does not keep growing on noise', () => {
    const s = new JpegSplitter();
    for (let i = 0; i < 200; i++) s.push(Buffer.alloc(10_000, 7));
    expect((s as unknown as { buf: Buffer }).buf.length).toBeLessThanOrEqual(2);
    expect(isJpeg(FA)).toBe(true);
    expect(isJpeg(Buffer.from('<html>'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------
describe('camera configuration', () => {
  const SECRETS = ['tok-SECRET-123', 'pw-SECRET-456'];
  const full = () => applyUpdate(defaultConfig(), {
    homeAssistant: { url: 'https://ha.example.com:8123/', token: SECRETS[0] },
    camera: { source: 'reolink', host: '10.20.30.114', user: 'admin', password: SECRETS[1], haEntity: 'camera.workshop_cnc' },
  });

  it('never shows a secret to a browser, only whether one is saved', () => {
    const view = JSON.stringify(publicView(full()));
    for (const s of SECRETS) expect(view).not.toContain(s);
    expect(publicView(full()).homeAssistant.hasToken).toBe(true);
    expect(publicView(full()).camera.hasPassword).toBe(true);
    expect(publicView(defaultConfig()).camera.hasPassword).toBe(false);
  });

  it('keeps secrets when they are left out of an update, and clears them when sent empty', () => {
    const a = applyUpdate(full(), { camera: { fps: 8 }, homeAssistant: { insecureTls: true } });
    expect(a.homeAssistant.token).toBe(SECRETS[0]);
    expect(a.camera.password).toBe(SECRETS[1]);
    const b = applyUpdate(a, { homeAssistant: { token: '' }, camera: { password: '' } });
    expect(b.homeAssistant.token).toBe('');
    expect(b.camera.password).toBe('');
  });

  it('splits a login out of a pasted address so the password stays secret', () => {
    const c = applyUpdate(defaultConfig(), { camera: { source: 'rtsp', url: 'rtsp://cam%20user:p%40ss@10.0.0.5:554/stream1' } }).camera;
    expect(c.url).toBe('rtsp://10.0.0.5:554/stream1');
    expect([c.user, c.password]).toEqual(['cam user', 'p@ss']);
    expect(JSON.stringify(publicView(applyUpdate(defaultConfig(), { camera: { source: 'rtsp', url: 'rtsp://u:topsecret@h/s' } })))).not.toContain('topsecret');
  });

  it.each([
    ['a Home Assistant address that is not http', { homeAssistant: { url: 'ftp://ha' } }, /http/],
    ['a login in the Home Assistant address', { homeAssistant: { url: 'http://u:p@ha:8123' } }, /access token/],
    ['a nonsense entity', { camera: { haEntity: 'light.kitchen' } }, /camera\./],
    ['frames per second of 0', { camera: { fps: 0 } }, /1 to 30/],
    ['frames per second of 31', { camera: { fps: 31 } }, /1 to 30/],
    ['frames per second that is not a number', { camera: { fps: NaN } }, /1 to 30/],
    ['channel 0', { camera: { channel: 0 } }, /1 to 64/],
    ['a fractional channel', { camera: { channel: 1.5 } }, /1 to 64/],
    ['a host with spaces or slashes', { camera: { host: '10.0.0.1/evil path' } }, /IP address or name/],
    ['an unknown camera type', { camera: { source: 'webcam' as never } }, /Unknown camera type/],
    ['an unknown reolink mode', { camera: { mode: 'x' as never } }, /mode/],
    ['an unknown connection type', { camera: { scheme: 'ftp' as never } }, /https or http/],
    ['an enormous password', { camera: { password: 'x'.repeat(5000) } }, /too long/],
    ['a secret that is not text', { camera: { password: 5 as never } }, /text/],
  ])('rejects %s with a message that says what to do', (_n, update, msg) => {
    expect(() => applyUpdate(defaultConfig(), update)).toThrow(ConfigError);
    expect(() => applyUpdate(defaultConfig(), update)).toThrow(msg);
  });

  it('checks the address kind that suits each camera type', () => {
    expect(() => applyUpdate(defaultConfig(), { camera: { source: 'rtsp', url: 'http://cam/stream' } })).toThrow(/rtsp/);
    expect(() => applyUpdate(defaultConfig(), { camera: { source: 'http', url: 'rtsp://cam/stream' } })).toThrow(/http/);
    expect(() => applyUpdate(defaultConfig(), { camera: { source: 'http', url: 'not a url' } })).toThrow(/valid address/);
    expect(() => applyUpdate(defaultConfig(), { camera: { source: 'direct', url: 'http://u:p@cam/video' } })).toThrow(/browsers refuse/);
    expect(applyUpdate(defaultConfig(), { camera: { source: 'direct', url: 'http://cam/video/' } }).camera.url).toBe('http://cam/video');
  });

  it('stores the file readable only by its owner, and loads it back', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demonx-cfg-'));
    const a = new ConfigStore(dir);
    a.update({ homeAssistant: { url: 'http://ha:8123', token: SECRETS[0] }, camera: { source: 'ha', haEntity: 'camera.workshop_cnc' } });
    expect(fs.statSync(path.join(dir, 'config.json')).mode & 0o777).toBe(0o600);
    const b = new ConfigStore(dir);
    expect(b.full.homeAssistant.token).toBe(SECRETS[0]);
    expect(b.view.camera.haEntity).toBe('camera.workshop_cnc');
    a.update({ camera: { fps: 3 } });                                  // a rewrite keeps the permissions
    expect(fs.statSync(path.join(dir, 'config.json')).mode & 0o777).toBe(0o600);
  });

  it('starts from the defaults when the saved file is damaged or has bad values, and says nothing sensitive', () => {
    for (const bad of ['{not json', JSON.stringify({ camera: { fps: 999 } }), JSON.stringify({ homeAssistant: { url: 'ftp://x' } })]) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demonx-cfg-'));
      fs.writeFileSync(path.join(dir, 'config.json'), bad);
      expect(new ConfigStore(dir).full).toEqual(defaultConfig());
    }
  });

  it('announces a change so every browser updates', () => {
    const s = new ConfigStore(); let seen: unknown;
    s.on('config', (v) => { seen = v; });
    s.update({ camera: { source: 'ha' } });
    expect((seen as ReturnType<typeof publicView>).camera.source).toBe('ha');
  });
});

describe('where each camera type fetches from', () => {
  const cfg = (c: Parameters<typeof applyUpdate>[1]) => applyUpdate(defaultConfig(), c);

  it('Home Assistant: the camera proxy with the token as a bearer header, never in the address', () => {
    const s = specFor(cfg({ homeAssistant: { url: 'https://ha.example.com/', token: 'T0K' }, camera: { source: 'ha', haEntity: 'camera.workshop_cnc_b' } }));
    expect(s).toMatchObject({ kind: 'poll', req: { url: 'https://ha.example.com/api/camera_proxy/camera.workshop_cnc_b', headers: { Authorization: 'Bearer T0K' } } });
    expect(JSON.stringify(s)).not.toMatch(/token=/i);
  });

  it('Reolink snapshot: channels count from 1 for you and from 0 for the camera, and logins are encoded', () => {
    const s = specFor(cfg({ camera: { source: 'reolink', host: '10.20.30.114', scheme: 'https', channel: 2, user: 'admin', password: 'p&ss=1 #' } }));
    const u = new URL((s as { req: { url: string } }).req.url);
    expect(u.origin + u.pathname).toBe('https://10.20.30.114/cgi-bin/api.cgi');
    expect(u.searchParams.get('cmd')).toBe('Snap');
    expect(u.searchParams.get('channel')).toBe('1');
    expect(u.searchParams.get('user')).toBe('admin');
    expect(u.searchParams.get('password')).toBe('p&ss=1 #');                       // survives intact
    expect(u.searchParams.get('rs')).toBeTruthy();
    expect((s as { req: { insecure?: boolean } }).req.insecure).toBe(true);        // NVRs use self-signed certificates
  });

  it('Reolink RTSP: the preview path for the channel and quality', () => {
    const s = specFor(cfg({ camera: { source: 'reolink', host: '10.20.30.98', mode: 'rtsp', channel: 1, quality: 'main', user: 'admin', password: 'p@ss' } }));
    expect(s).toEqual({ kind: 'rtsp', url: 'rtsp://admin:p%40ss@10.20.30.98:554/h264Preview_01_main' });
    expect(specFor(cfg({ camera: { source: 'reolink', host: 'nvr', mode: 'rtsp', channel: 12, quality: 'sub' } }))).toEqual({ kind: 'rtsp', url: 'rtsp://nvr:554/h264Preview_12_sub' });
  });

  it('a web address uses basic authentication when a login is given', () => {
    const s = specFor(cfg({ camera: { source: 'http', url: 'http://cam/video.mjpg', user: 'u', password: 'p' } }));
    expect((s as { req: { headers: Record<string, string> } }).req.headers.Authorization).toBe('Basic ' + Buffer.from('u:p').toString('base64'));
  });

  it('RTSP: the login is added to the address only on the server', () => {
    const c = cfg({ camera: { source: 'rtsp', url: 'rtsp://10.0.0.5/live', user: 'a b', password: 'x/y' } });
    expect((specFor(c) as { url: string }).url).toBe('rtsp://a%20b:x%2Fy@10.0.0.5/live');
    expect(JSON.stringify(publicView(c))).not.toContain('x%2Fy');
  });

  it.each([
    ['nothing chosen', {}, /No camera/],
    ['Home Assistant with no address', { camera: { source: 'ha' as const, haEntity: 'camera.a' } }, /not set up yet/],
    ['Home Assistant with no token', { homeAssistant: { url: 'http://ha' }, camera: { source: 'ha' as const, haEntity: 'camera.a' } }, /access token/],
    ['Home Assistant with no camera chosen', { homeAssistant: { url: 'http://ha', token: 't' }, camera: { source: 'ha' as const } }, /Choose a Home Assistant camera/],
    ['Reolink with no address', { camera: { source: 'reolink' as const } }, /camera or NVR address/],
    ['a web camera with no address', { camera: { source: 'http' as const } }, /camera address/],
    ['RTSP with no address', { camera: { source: 'rtsp' as const } }, /RTSP address/],
    ['a direct camera (the browser does that itself)', { camera: { source: 'direct' as const, url: 'http://cam/v' } }, /browser itself/],
  ])('explains what is missing: %s', (_n, update, msg) => {
    expect(() => specFor(cfg(update))).toThrow(msg);
  });
});

// ---------------------------------------------------------------------------------------
describe('streaming from a camera to many viewers', () => {
  it('Home Assistant: fetches with the token, serves a multipart stream, and stops when the last viewer leaves', async () => {
    const ha = await fake((_q, res, n) => jpeg(res, n));
    const { hub } = setup({ homeAssistant: { url: ha.url, token: 'TOK' }, camera: { source: 'ha', haEntity: 'camera.workshop_cnc', fps: 10 } });
    const w = await watch(hub, 4);
    expect(w.status).toBe(200);
    expect(w.headers['content-type']).toMatch(/^multipart\/x-mixed-replace; boundary=/);
    expect(w.frames.length).toBeGreaterThanOrEqual(4);
    expect(w.frames.every((f) => f.equals(FA) || f.equals(FB))).toBe(true);
    expect(new Set(w.frames.map((f) => f.length)).size).toBe(2);                       // both pictures came through
    expect(ha.seen[0].url).toBe('/api/camera_proxy/camera.workshop_cnc');
    expect(ha.seen[0].headers.authorization).toBe('Bearer TOK');
    expect(hub.state).toMatchObject({ running: true, viewers: 1 });
    w.close();
    await until(() => !hub.state.running);                                              // idle timeout
    const hits = ha.seen.length; await wait(400);
    expect(ha.seen.length).toBe(hits);                                                  // no more fetching once nobody watches
    expect(hub.state.viewers).toBe(0);
  });

  it('two viewers share one pull from the camera', async () => {
    const ha = await fake((_q, res, n) => jpeg(res, n));
    const { hub } = setup({ homeAssistant: { url: ha.url, token: 'T' }, camera: { source: 'ha', haEntity: 'camera.a', fps: 10 } });
    const a = await watch(hub, 3), b = await watch(hub, 3);
    expect(hub.state.viewers).toBe(2);
    const before = ha.seen.length; await wait(1000);
    const perSecond = ha.seen.length - before;
    expect(perSecond, 'one poller at 10 fps, not one per viewer').toBeLessThan(15);
    a.close(); await wait(250);
    expect(hub.state).toMatchObject({ running: true, viewers: 1 });                     // still running for the other
    b.close(); await until(() => !hub.state.running);
  });

  it('a late viewer is shown the latest picture immediately', async () => {
    const ha = await fake((_q, res, n) => jpeg(res, n));
    const { hub } = setup({ homeAssistant: { url: ha.url, token: 'T' }, camera: { source: 'ha', haEntity: 'camera.a', fps: 2 } });
    const first = await watch(hub, 2);
    const t0 = Date.now(); const late = await watch(hub, 1);
    expect(Date.now() - t0).toBeLessThan(300);                                          // no waiting for the next 500 ms tick
    expect(late.frames.length).toBe(1);
    first.close(); late.close();
  });

  it('a web camera that streams (MJPEG) is relayed, with basic authentication', async () => {
    const cam = await fake((q, res) => mjpegCamera(q, res));
    const { hub } = setup({ camera: { source: 'http', url: `${cam.url}/video.mjpg`, user: 'u', password: 'p' } });
    const w = await watch(hub, 5);
    expect(w.frames.length).toBeGreaterThanOrEqual(5);
    expect(w.frames.every((f) => f.equals(FA) || f.equals(FB))).toBe(true);
    expect(cam.seen[0].headers.authorization).toBe('Basic ' + Buffer.from('u:p').toString('base64'));
    w.close();
  });

  it('a web address that gives single pictures is fetched over and over', async () => {
    const cam = await fake((_q, res, n) => jpeg(res, n));
    const { hub } = setup({ camera: { source: 'http', url: `${cam.url}/snap.jpg`, fps: 10 } });
    const w = await watch(hub, 4);
    expect(w.frames.length).toBeGreaterThanOrEqual(4);
    expect(cam.seen.length).toBeGreaterThanOrEqual(4);
    w.close();
  });

  it('Reolink snapshot: asks the API for the right channel with the login', async () => {
    const nvr = await fake((_q, res, n) => jpeg(res, n));
    const { hub } = setup({ camera: { source: 'reolink', host: `127.0.0.1:${nvr.port}`, scheme: 'http', channel: 2, user: 'admin', password: 'p&ss', fps: 10 } });
    const w = await watch(hub, 2);
    expect(w.frames.length).toBeGreaterThanOrEqual(2);
    const u = new URL(nvr.seen[0].url, 'http://x');
    expect(u.pathname).toBe('/cgi-bin/api.cgi');
    expect([u.searchParams.get('cmd'), u.searchParams.get('channel'), u.searchParams.get('user'), u.searchParams.get('password')]).toEqual(['Snap', '1', 'admin', 'p&ss']);
    w.close();
  });

  it('tells the viewer when nothing is set up instead of hanging', async () => {
    const { hub } = setup({});
    const w = await watch(hub, 1, 1500);
    expect(w.status).toBe(409);
    expect(w.body).toMatch(/No camera/);
    expect(hub.state.running).toBe(false);
    const d = setup({ camera: { source: 'direct', url: 'http://cam/v' } });
    expect((await watch(d.hub, 1, 1500)).status).toBe(409);
  });

  it.each([
    [401, /wrong user name or password/], [403, /access refused/], [404, /not found/],
  ])('reports a %s from the camera in plain words', async (code, msg) => {
    const cam = await fake((_q, res) => { res.writeHead(code).end(); });
    const { hub } = setup({ camera: { source: 'http', url: `${cam.url}/x` } });
    const w = await watch(hub, 1, 300);
    await until(() => !!hub.state.error);
    expect(hub.state.error).toMatch(msg);
    w.close();
  });

  it('reports an unreachable camera, a camera that answers with a web page, and then recovers', async () => {
    // refused
    const refused = setup({ camera: { source: 'http', url: 'http://127.0.0.1:1/v' } });
    const w1 = await watch(refused.hub, 1, 300);
    await until(() => !!refused.hub.state.error);
    expect(refused.hub.state.error).toMatch(/Connection refused/);
    w1.close();
    // answers, but not with a picture; later fixed
    let good = false;
    const cam = await fake((_q, res, n) => (good ? jpeg(res, n) : (res.writeHead(200, { 'content-type': 'text/html' }), res.end('<html>login</html>'))));
    const { hub } = setup({ camera: { source: 'http', url: `${cam.url}/x`, fps: 10 } });
    const w2 = await watch(hub, 1, 300);
    await until(() => !!hub.state.error);
    expect(hub.state.error).toMatch(/not with a picture/);
    good = true;
    await until(() => !hub.state.error && hub.state.fps >= 0 && hub.state.running, 6000);
    const w3 = await watch(hub, 2);
    expect(w3.frames.length).toBeGreaterThanOrEqual(2);
    w2.close(); w3.close();
  });

  it('restarts with the new settings when the setup changes while streaming', async () => {
    const ha = await fake((_q, res, n) => jpeg(res, n));
    const { hub, config } = setup({ homeAssistant: { url: ha.url, token: 'T' }, camera: { source: 'ha', haEntity: 'camera.one', fps: 10 } });
    const w = await watch(hub, 2);
    config.update({ camera: { haEntity: 'camera.two' } });
    await until(() => ha.seen.some((s) => s.url.endsWith('camera.two')));
    const last = ha.seen[ha.seen.length - 1].url;
    expect(last).toBe('/api/camera_proxy/camera.two');
    w.close();
  });

  it('one stuck viewer does not hold up the others', async () => {
    const cam = await fake((q, res) => mjpegCamera(q, res));
    const { hub } = setup({ camera: { source: 'http', url: `${cam.url}/v` } });
    // a viewer that never reads
    const stuck = http.get({ host: '127.0.0.1', port: (servers[servers.length - 1].address() as AddressInfo).port });
    stuck.on('error', () => {});
    const s = http.createServer((_q, res) => { hub.attach(res); }); servers.push(s);
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const slow = http.get({ host: '127.0.0.1', port: (s.address() as AddressInfo).port }, (res) => res.pause());
    slow.on('error', () => {});
    const good = await watch(hub, 15);
    expect(good.frames.length).toBeGreaterThanOrEqual(15);
    stuck.destroy(); slow.destroy(); good.close();
  });
});

// ---------------------------------------------------------------------------------------
describe('the Test button (one frame, from a setup that may not be saved yet)', () => {
  it('returns a picture from unsaved settings without changing the saved ones', async () => {
    const ha = await fake((_q, res) => jpeg(res, 0));
    const { hub, config } = setup({});
    const preview = config.preview({ homeAssistant: { url: ha.url, token: 'T' }, camera: { source: 'ha', haEntity: 'camera.a' } });
    const frame = await hub.grabOne(preview);
    expect(frame.equals(FA)).toBe(true);
    expect(config.full.camera.source).toBe('none');
  });

  it('explains failures', async () => {
    const { hub, config } = setup({});
    await expect(hub.grabOne(config.preview({ camera: { source: 'http', url: 'http://127.0.0.1:1/x' } }))).rejects.toThrow(/Connection refused/);
    await expect(hub.grabOne(config.preview({}))).rejects.toThrow(/No camera/);
    const html = await fake((_q, res) => { res.writeHead(200, { 'content-type': 'text/html' }).end('<html>'); });
    await expect(hub.grabOne(config.preview({ camera: { source: 'http', url: html.url + '/x' } }))).rejects.toThrow(/JPEG/);
  });
});

describe('listing Home Assistant cameras', () => {
  it('returns only camera entities, by friendly name', async () => {
    const ha = await fake((_q, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify([
        { entity_id: 'light.kitchen', attributes: {} },
        { entity_id: 'camera.workshop_cnc_b', attributes: { friendly_name: 'Workshop CNC B' } },
        { entity_id: 'camera.driveway', attributes: {} },
        { entity_id: 'camera.workshop_cnc_a', attributes: { friendly_name: 'Workshop CNC A' } },
      ]));
    });
    const cams = await listHaCameras(ha.url, 'TOK', false);
    expect(cams).toEqual([
      { entity_id: 'camera.driveway', name: 'camera.driveway' },
      { entity_id: 'camera.workshop_cnc_a', name: 'Workshop CNC A' },
      { entity_id: 'camera.workshop_cnc_b', name: 'Workshop CNC B' },
    ]);
    expect(ha.seen[0].url).toBe('/api/states');
    expect(ha.seen[0].headers.authorization).toBe('Bearer TOK');
  });

  it('explains a wrong token, a wrong address, and something that is not Home Assistant', async () => {
    const denied = await fake((_q, res) => { res.writeHead(401).end(); });
    await expect(listHaCameras(denied.url, 'bad', false)).rejects.toThrow(/wrong user name or password/);
    const web = await fake((_q, res) => { res.writeHead(200).end('<html>router login</html>'); });
    await expect(listHaCameras(web.url, 't', false)).rejects.toThrow(/did not answer like Home Assistant/);
    await expect(listHaCameras('http://127.0.0.1:1', 't', false)).rejects.toThrow(/Connection refused/);
    await expect(listHaCameras('', 't', false)).rejects.toThrow(/address first/);
    await expect(listHaCameras('http://ha', '', false)).rejects.toThrow(/token first/);
  });
});

// ---------------------------------------------------------------------------------------
describe('RTSP through ffmpeg', () => {
  const script = (body: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demonx-ff-'));
    const bin = path.join(dir, 'ffmpeg');
    fs.writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return { bin, args: path.join(dir, 'args.txt'), dir };
  };
  const A = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures/frame-a.jpg');
  const B = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures/frame-b.jpg');

  it('says plainly when ffmpeg is not installed, and does not keep retrying', async () => {
    const { hub } = setup({ camera: { source: 'rtsp', url: 'rtsp://10.0.0.5/live' } }, { idleMs: 100, ffmpeg: '/nonexistent/ffmpeg' });
    const w = await watch(hub, 1, 500);
    await until(() => !!hub.state.error);
    expect(hub.state.error).toMatch(/ffmpeg is not installed/);
    expect(hub.state.error).not.toMatch(/10\.0\.0\.5/);
    w.close();
    await expect(hub.grabOne()).rejects.toThrow(/ffmpeg is not installed/);
  });

  it('runs ffmpeg safely and turns its output into a stream', async () => {
    const ff = script(`echo "$@" > "${'${ARGSFILE}'}"; while true; do cat "${A}" "${B}"; sleep 0.05; done`.replace('${ARGSFILE}', '__ARGS__'));
    fs.writeFileSync(ff.bin, fs.readFileSync(ff.bin, 'utf8').replace('__ARGS__', ff.args));
    const { hub } = setup({ camera: { source: 'reolink', host: '10.20.30.98', mode: 'rtsp', channel: 1, quality: 'sub', user: 'admin', password: 'p@ss w0rd', fps: 6 } }, { idleMs: 100, ffmpeg: ff.bin });
    const w = await watch(hub, 4);
    expect(w.frames.length).toBeGreaterThanOrEqual(4);
    expect(w.frames.every((f) => f.equals(FA) || f.equals(FB))).toBe(true);
    const args = fs.readFileSync(ff.args, 'utf8');
    expect(args).toContain('-rtsp_transport tcp');
    expect(args).toContain('-protocol_whitelist rtsp,rtp,tcp,udp,tls,crypto');          // cannot be told to read local files
    expect(args).toContain('fps=6');
    expect(args).toContain('rtsp://admin:p%40ss%20w0rd@10.20.30.98:554/h264Preview_01_sub');
    w.close();
    await until(() => !hub.state.running);                                                 // ffmpeg is stopped with the last viewer
  });

  it('never repeats the password when ffmpeg fails', async () => {
    const ff = script(`echo "Error opening input rtsp://admin:p%40ss@10.20.30.98:554/x: Server returned 401 Unauthorized" 1>&2; exit 1`);
    const { hub } = setup({ camera: { source: 'rtsp', url: 'rtsp://10.20.30.98/x', user: 'admin', password: 'p@ss' } }, { idleMs: 100, ffmpeg: ff.bin });
    const w = await watch(hub, 1, 500);
    await until(() => !!hub.state.error);
    expect(hub.state.error).toMatch(/401 Unauthorized/);
    expect(hub.state.error).not.toMatch(/p%40ss|p@ss/);
    w.close();
  });
});

describe('rtspArgs', () => {
  it('uses wall-clock timestamps and no input buffering, and caps the picture size', () => {
    const a = rtspArgs('rtsp://cam/stream', 12);
    expect(a).toContain('-use_wallclock_as_timestamps');
    expect(a.join(' ')).toMatch(/-fflags nobuffer/);
    expect(a.join(' ')).toMatch(/fps=12,scale='min\(1280,iw\)':-2/);
    expect(a.indexOf('-use_wallclock_as_timestamps')).toBeLessThan(a.indexOf('-i')); // an input option
  });
});

describe('switching camera type', () => {
  it('keeps an old rtsp:// address from blocking a Home Assistant camera', () => {
    const rtsp = applyUpdate(defaultConfig(), { camera: { source: 'rtsp', url: 'rtsp://10.0.0.5/stream1' } });
    for (const source of ['ha', 'hastream', 'reolink'] as const) {
      const next = applyUpdate(rtsp, { camera: { source, url: 'rtsp://10.0.0.5/stream1', haEntity: 'camera.cnc' } });
      expect(next.camera.source).toBe(source);
    }
    // but a wrong address is still caught for a type that uses it
    expect(() => applyUpdate(rtsp, { camera: { source: 'http', url: 'rtsp://10.0.0.5/stream1' } })).toThrow(/must start with http/);
  });
});

describe('spindle setup', () => {
  it('has sensible defaults, always keeps M5, and sorts the speeds', () => {
    const d = defaultConfig();
    expect(d.spindle).toEqual({ commands: ['M3', 'M5'], speeds: [1000, 5000, 10000, 18000, 24000], maxRpm: 24000 });
    const c = applyUpdate(d, { spindle: { commands: ['M7', 'M9', 'M3'], speeds: [18000, 1000, 1000, 12000.4] } });
    expect(c.spindle.commands).toEqual(['M3', 'M5', 'M7', 'M9']);   // M5 added, order fixed
    expect(c.spindle.speeds).toEqual([1000, 12000, 18000]);
    expect(applyUpdate(d, { spindle: { commands: [] } }).spindle.commands).toEqual(['M5']);
  });

  it('rejects what makes no sense', () => {
    const d = defaultConfig();
    expect(() => applyUpdate(d, { spindle: { commands: ['M3', 'M99' as never] } })).toThrow(/Unknown spindle command/);
    expect(() => applyUpdate(d, { spindle: { speeds: [] } })).toThrow(/up to 20 positive/);
    expect(() => applyUpdate(d, { spindle: { speeds: [0] } })).toThrow(/positive/);
    expect(() => applyUpdate(d, { spindle: { maxRpm: 10 } })).toThrow(/from 100 to 100000/);
    expect(() => applyUpdate(d, { spindle: { speeds: [30000] } })).toThrow(/above the highest speed/);
    expect(applyUpdate(d, { spindle: { maxRpm: 30000, speeds: [30000] } }).spindle.maxRpm).toBe(30000);
  });
});

describe('PCB mode setup', () => {
  it('needs the fixture and safe height before the mode can be switched on', () => {
    const d = defaultConfig();
    expect(d.pcb).toEqual({ enabled: false, configured: false, x: 0, y: 0, safeZ: 0 });
    expect(() => applyUpdate(d, { pcb: { enabled: true } })).toThrow(/Set the fixture position/);
    const c = applyUpdate(d, { pcb: { x: 120.5, y: 33.3333, safeZ: -8 } });
    expect(c.pcb).toEqual({ enabled: false, configured: true, x: 120.5, y: 33.333, safeZ: -8 });
    const on = applyUpdate(c, { pcb: { enabled: true } });
    expect(on.pcb.enabled).toBe(true);
    expect(applyUpdate(on, { pcb: { enabled: false } }).pcb.configured).toBe(true);      // turning it off keeps the setup
    expect(applyUpdate(d, { pcb: { enabled: true, x: 1, y: 2, safeZ: -5 } }).pcb.enabled).toBe(true);   // set up and switched on in one go
  });

  it('rejects numbers that make no sense', () => {
    const d = defaultConfig();
    expect(() => applyUpdate(d, { pcb: { x: NaN } })).toThrow(/fixture X must be a number/);
    expect(() => applyUpdate(d, { pcb: { y: '5' as never } })).toThrow(/fixture Y must be a number/);
    expect(() => applyUpdate(d, { pcb: { safeZ: 1e9 } })).toThrow(/safe Z must be a number/);
  });
});
