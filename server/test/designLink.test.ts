import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { askDesignBusy, designAddress } from '../src/designLink.js';

// Asking DemonX Design whether it is busy (GET /api/busy on this computer), against a fake Design.

let srv: http.Server | undefined;
const fake = (handler: http.RequestListener) => new Promise<number>((resolve) => {
  srv = http.createServer(handler).listen(0, '127.0.0.1', () => resolve((srv!.address() as { port: number }).port));
});
afterEach(() => new Promise<void>((r) => { if (srv) srv.close(() => r()); else r(); srv = undefined; }));

describe('asking DemonX Design whether it is busy', () => {
  it('is null when Design says it is idle', async () => {
    const port = await fake((_q, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"busy":false,"reason":""}'));
    expect(await askDesignBusy(port, false)).toBeNull();
  });

  it('gives the reason when Design is busy', async () => {
    const port = await fake((req, res) => { expect(req.url).toBe('/api/busy'); res.writeHead(200).end('{"busy":true,"reason":"a laser job is running"}'); });
    expect(await askDesignBusy(port, false)).toBe('DemonX Design is busy: a laser job is running');
  });

  it('refuses when Design is too old to have the question', async () => {
    const port = await fake((_q, res) => res.writeHead(404).end());
    expect(await askDesignBusy(port, false)).toMatch(/too old to say whether a laser job is running/);
  });

  it('refuses on any other answer, an unreadable one, or no answer in time', async () => {
    let port = await fake((_q, res) => res.writeHead(403).end('{}'));
    expect(await askDesignBusy(port, false)).toMatch(/answered 403/);
    await new Promise<void>((r) => srv!.close(() => r()));
    port = await fake((_q, res) => res.writeHead(200).end('<html>not json</html>'));
    expect(await askDesignBusy(port, false)).toMatch(/could not be read/);
    await new Promise<void>((r) => srv!.close(() => r()));
    port = await fake((_q, res) => res.writeHead(200).end('{"busy":"maybe"}'));
    expect(await askDesignBusy(port, false)).toMatch(/could not be read/);
    await new Promise<void>((r) => srv!.close(() => r()));
    port = await fake(() => { /* never answers */ });
    expect(await askDesignBusy(port, false, 150)).toMatch(/did not answer in time/);
  });

  it('is null when nothing is listening (Design is not running, so no laser job to interrupt)', async () => {
    const port = await fake((_q, res) => res.end());
    await new Promise<void>((r) => srv!.close(() => r()));
    srv = undefined;
    expect(await askDesignBusy(port, false)).toBeNull();
  });
});

describe('where Design listens', () => {
  const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'demonx-design-env-'));
  it('is port 8090 over http without a design.env', () => {
    expect(designAddress(dir())).toEqual({ port: 8090, tls: false });
  });
  it('follows DESIGN_PORT and DESIGN_TLS_CERT in design.env, ignoring comments and junk', () => {
    const d = dir();
    fs.writeFileSync(path.join(d, 'design.env'), '# DESIGN_PORT=1\nDESIGN_PORT=8095\nDESIGN_TLS_CERT="/x/cert.pem"\nDESIGN_HOST=0.0.0.0\n');
    expect(designAddress(d)).toEqual({ port: 8095, tls: true });
    fs.writeFileSync(path.join(d, 'design.env'), 'DESIGN_PORT=abc\n# DESIGN_TLS_CERT=/x\n');
    expect(designAddress(d)).toEqual({ port: 8090, tls: false });
  });
});
