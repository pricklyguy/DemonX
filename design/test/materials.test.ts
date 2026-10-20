import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { emptyDoc, newLayer } from '../src/core/types';
import { execute } from '../src/core/commands';
import { entryFromLayer, freeName, groupOf, importClb, layerPatch, parseLibraries, putEntry, type Library } from '../src/core/materials';
import { LaserSession } from '../server/src/laserSession';
import { createLaserServer } from '../server/src/app';

// a small library in LightBurn's layout (neutral values)
const CLB = `<?xml version="1.0" encoding="UTF-8"?>
<LightBurnLibrary DisplayName="Bench &amp; laser">
  <Material name="Acrylic">
    <Entry Thickness="5.0000" Desc="Cutout">
      <CutSetting type="Cut"><index Value="0"/><minPower Value="45"/><maxPower Value="62.5"/><speed Value="10"/><runBlower Value="1"/><numPasses Value="2"/><overscan Value="0"/></CutSetting>
    </Entry>
    <Entry Thickness="-1.0000" Desc="Fill" NoThickTitle="Engraving">
      <CutSetting type="Scan"><minPower Value="16.5"/><maxPower Value="19"/><speed Value="400"/><interval Value="0.08"/></CutSetting>
    </Entry>
    <Entry Thickness="-1.0000" Desc="Light etch" NoThickTitle="Line (score)">
      <CutSetting type="Cut"><maxPower Value="20"/><speed Value="500"/></CutSetting>
    </Entry>
  </Material>
</LightBurnLibrary>`;

describe('material library', () => {
  it('imports a LightBurn library: modes, powers, passes, air, and missing minimum power', () => {
    const lib = importClb(CLB);
    expect(lib.name).toBe('Bench & laser');
    const [cut, fill, line] = lib.materials[0].entries;
    expect(cut).toMatchObject({ name: 'Cutout', thickness: 5, mode: 'cut', power: 62.5, minPower: 45, speed: 10, passes: 2, air: true, overscan: 0 });
    expect(groupOf(cut)).toBe('5 mm');
    expect(fill).toMatchObject({ mode: 'engrave', group: 'Engraving', thickness: null, minPower: 16.5, power: 19, interval: 0.08, passes: 1, air: false });
    expect(fill.overscan).toBeUndefined();
    expect(line).toMatchObject({ mode: 'score', minPower: 20, power: 20, group: 'Line (score)' });
    expect(() => importClb('<html/>')).toThrow(/not a LightBurn/);
  });
  it('assigns an entry to a layer and makes an entry from a layer', () => {
    const lib = importClb(CLB);
    const fill = lib.materials[0].entries[1];
    const d = execute(emptyDoc(), 'layer_set', { name: 'Layer 1', ...layerPatch(fill) }).doc;
    expect(d.layers[0]).toMatchObject({ mode: 'engrave', speed: 400, power: 19, minPower: 16.5, interval: 0.08, passes: 1 });
    const e = entryFromLayer(d.layers[0], 'Mine', null, 'Engraving');
    expect(e).toMatchObject({ mode: 'engrave', power: 19, minPower: 16.5, interval: 0.08, group: 'Engraving' });
    const cutE = entryFromLayer({ ...newLayer('x', 0), mode: 'cut' }, 'C', 3, 'ignored');
    expect(cutE).toMatchObject({ thickness: 3, group: '' });
    expect(cutE.interval).toBeUndefined();
  });
  it('puts, replaces and names entries without losing the others', () => {
    let lib: Library = importClb(CLB);
    const e = lib.materials[0].entries[0];
    lib = putEntry(lib, 'Acrylic', { ...e, speed: 12 });
    expect(lib.materials[0].entries).toHaveLength(3);
    expect(lib.materials[0].entries[0].speed).toBe(12);
    lib = putEntry(lib, 'Birch', { ...e, name: 'Cut 3', thickness: 3 });
    expect(lib.materials.map((m) => m.name)).toEqual(['Acrylic', 'Birch']);
    expect(freeName(lib.materials[0], 'Cutout', '5 mm')).toBe('Cutout copy');
    expect(freeName(lib.materials[0], 'Other', '5 mm')).toBe('Other');
  });
  it('refuses damaged libraries', () => {
    const ok = { v: 1, libraries: [{ name: 'A', materials: [{ name: 'M', entries: [{ name: 'e', thickness: null, group: 'g', mode: 'cut', speed: 5, power: 20, minPower: 10, passes: 1, air: false }] }] }] };
    expect(parseLibraries(ok).libraries[0].materials[0].entries[0].minPower).toBe(10);
    const bad = (f: (o: any) => void) => { const o = JSON.parse(JSON.stringify(ok)); f(o); return () => parseLibraries(o); };
    expect(bad((o) => { o.libraries[0].materials[0].entries[0].minPower = 50; })).toThrow(/minimum/);
    expect(bad((o) => { o.libraries[0].materials[0].entries[0].mode = 'tool'; })).toThrow(/mode/);
    expect(bad((o) => { o.libraries[0].materials[0].entries[0].power = 101; })).toThrow(/power/);
    expect(bad((o) => { o.libraries.push(o.libraries[0]); })).toThrow(/own name/);
    expect(() => parseLibraries({ v: 2 })).toThrow();
  });
});

describe('material library on the server', () => {
  let dir: string, session: LaserSession, server: http.Server, port: number;
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-lib-'));
    session = new LaserSession({ simSpeed: 100, listPorts: async () => [] });
    server = createLaserServer(session, dir, { libraryFile: path.join(dir, 'data', 'lib.json') }).server;
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterEach(async () => { await session.close(); await new Promise((r) => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });
  const call = (method: string, body?: string, headers: Record<string, string> = {}) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/library', method, headers }, (res) => {
      let t = ''; res.on('data', (c) => (t += c)); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: t ? JSON.parse(t) : null }));
    });
    req.on('error', reject); req.end(body);
  });
  it('starts empty, stores what it is given and hands it back', async () => {
    expect((await call('GET')).body).toEqual({ v: 1, libraries: [] });
    const lib = { v: 1, libraries: [importClb(CLB)] };
    expect((await call('PUT', JSON.stringify(lib))).status).toBe(200);
    expect((await call('GET')).body.libraries[0].materials[0].entries).toHaveLength(3);
    expect(fs.existsSync(path.join(dir, 'data', 'lib.json'))).toBe(true);
  });
  it('refuses a damaged library, a page from another site, and keeps the old file', async () => {
    const lib = JSON.stringify({ v: 1, libraries: [importClb(CLB)] });
    await call('PUT', lib);
    expect((await call('PUT', '{"v":1,"libraries":[{"name":"x"}]}')).status).toBe(400);
    expect((await call('PUT', 'nope')).status).toBe(400);
    expect((await call('PUT', lib, { origin: 'http://evil.example' })).status).toBe(403);
    expect((await call('GET')).body.libraries).toHaveLength(1);
    expect((await call('DELETE')).status).toBe(405);
  });
});
