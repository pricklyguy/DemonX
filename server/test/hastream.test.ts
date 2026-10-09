import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import zlib from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { haStreamUrl, hlsPath, proxyHls } from '../src/hastream.js';
import { applyUpdate, defaultConfig, type AppConfig } from '../src/config.js';

const closers: (() => void)[] = [];
afterEach(() => { for (const c of closers.splice(0)) c(); });

/** A pretend Home Assistant: websocket API plus the /api/hls/ files */
async function fakeHa(opts: { token?: string; streamResult?: object } = {}) {
  const token = opts.token ?? 'good';
  const seenHttp: { url: string; auth?: string }[] = [];
  const seenWs: object[] = [];
  const server = http.createServer((req, res) => {
    seenHttp.push({ url: req.url ?? '', auth: req.headers.authorization });
    if (req.url?.startsWith('/api/hls/tok123/playlist.m3u8')) { res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }).end('#EXTM3U\n'); return; }
    if (req.url?.startsWith('/api/hls/tok123/gz.m3u8')) { res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'content-encoding': 'gzip' }).end(zlib.gzipSync('#EXTM3U\n')); return; }
    res.writeHead(404).end('nope');
  });
  const wss = new WebSocketServer({ server, path: '/api/websocket' });
  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'auth_required' }));
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw)); seenWs.push(m);
      if (m.type === 'auth') ws.send(JSON.stringify({ type: m.access_token === token ? 'auth_ok' : 'auth_invalid' }));
      else if (m.type === 'camera/stream') ws.send(JSON.stringify({ id: m.id, type: 'result', ...(opts.streamResult ?? { success: true, result: { url: '/api/hls/tok123/master_playlist.m3u8' } }) }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  closers.push(() => { wss.clients.forEach((c) => c.terminate()); server.closeAllConnections(); server.close(); });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seenHttp, seenWs };
}

const cfg = (url: string, token = 'good', entity = 'camera.cnc'): AppConfig =>
  applyUpdate(defaultConfig(), { homeAssistant: { url, token }, camera: { source: 'hastream', haEntity: entity } });

describe('Home Assistant stream', () => {
  it('asks HA for the stream and returns an address under our own prefix', async () => {
    const ha = await fakeHa();
    expect(await haStreamUrl(cfg(ha.url))).toBe('/api/camera/hls/tok123/master_playlist.m3u8');
    expect(ha.seenWs).toContainEqual({ type: 'camera/stream', id: 1, entity_id: 'camera.cnc' });
  });

  it('says so when the token is wrong or the camera cannot stream', async () => {
    const ha = await fakeHa();
    await expect(haStreamUrl(cfg(ha.url, 'bad'))).rejects.toThrow(/refused the access token/);
    const noStream = await fakeHa({ streamResult: { success: false, error: { message: 'Camera does not support streaming' } } });
    await expect(haStreamUrl(cfg(noStream.url))).rejects.toThrow(/does not support streaming/);
  });

  it('needs the setup filled in', () => {
    expect(() => haStreamUrl(applyUpdate(defaultConfig(), { camera: { source: 'hastream' } }))).toThrow(/not set up/);
  });

  it('only passes on safe stream paths', () => {
    expect(hlsPath('/api/camera/hls/tok/segment/3.m4s')).toBe('tok/segment/3.m4s');
    expect(hlsPath('/api/camera/hls/../../etc/passwd')).toBeUndefined();
    expect(hlsPath('/api/camera/hls/a//b')).toBeUndefined();
    expect(hlsPath('/api/camera/hls/a b')).toBeUndefined();
    expect(hlsPath('/api/other')).toBeUndefined();
  });

  it('passes a playlist through, with its query, and reports a missing file', async () => {
    const ha = await fakeHa();
    const front = http.createServer((req, res) => {
      const u = new URL(req.url!, 'http://x');
      void proxyHls(cfg(ha.url), hlsPath(u.pathname)!, u.search, res);
    });
    await new Promise<void>((r) => front.listen(0, '127.0.0.1', r));
    closers.push(() => { front.closeAllConnections(); front.close(); });
    const base = `http://127.0.0.1:${(front.address() as AddressInfo).port}`;
    const ok = await fetch(`${base}/api/camera/hls/tok123/playlist.m3u8?_HLS_msn=4`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toMatch(/mpegurl/);
    expect(await ok.text()).toBe('#EXTM3U\n');
    expect(ha.seenHttp[0].url).toBe('/api/hls/tok123/playlist.m3u8?_HLS_msn=4');
    // a compressed playlist from HA must stay readable (the browser undoes the compression)
    const gz = await fetch(`${base}/api/camera/hls/tok123/gz.m3u8`);
    expect(gz.headers.get('content-encoding')).toBe('gzip');
    expect(await gz.text()).toBe('#EXTM3U\n');
    expect((await fetch(`${base}/api/camera/hls/tok123/missing.m4s`)).status).toBe(502);
  });
});
