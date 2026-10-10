import http from 'node:http';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import type { ClientMessage, ServerMessage } from '../../shared/protocol.js';
import { GrblController } from './controller.js';
import { SerialTransport, listSerialPorts } from './transport.js';
import { SimulatorTransport } from './simulator.js';
import { ProbeManager } from './probe.js';
import { HeightMapStore, validateHeightMap } from './heightmap.js';
import { ConfigStore, ConfigError } from './config.js';
import { CameraHub, listHaCameras } from './camera.js';
import { MacroStore, MacroError } from './macros.js';
import { StatsStore, StatsError } from './stats.js';
import { MachineSettingsService, SettingsError } from './machinesettings.js';
import { haStreamUrl, hlsPath, proxyHls } from './hastream.js';
import { HaShare, makePoster } from './hashare.js';
import { MqttBridge, testBroker, type Command } from './mqtt.js';
import { AuthStore, AuthError, sessionToken, sessionCookie, clearedCookie, sameOrigin, classifyPeer, lanUrls } from './auth.js';

const PORT = Number(process.env.PORT ?? 8080);
const here = path.dirname(fileURLToPath(import.meta.url));
// DEMONX_WEB: where the built web UI is (the Windows package keeps it next to the server file)
const webRoot = path.resolve(process.env.DEMONX_WEB ?? path.join(here, '../../web/dist'));

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon',
};

const controller = new GrblController();
const probe = new ProbeManager(controller);
const dataDir = process.env.DEMONX_DATA ?? path.resolve(here, '../../data');
const autoloadMap = process.env.DEMONX_AUTOLOAD_MAP === '1';
const heightmaps = new HeightMapStore(dataDir, { autoload: autoloadMap });
const config = new ConfigStore(dataDir);
const camera = new CameraHub(config);
const macros = new MacroStore(dataDir);
const stats = new StatsStore(dataDir);
const machineSettings = new MachineSettingsService(controller, dataDir);
const auth = new AuthStore(dataDir);
// The computer that runs DemonX (attached to the machine) never needs the PIN. DEMONX_TRUST_LOCAL=0 turns that off.
const trustLocal = process.env.DEMONX_TRUST_LOCAL !== '0';
const peerOf = (req: http.IncomingMessage) => classifyPeer(req.socket.remoteAddress, req.headers, undefined, trustLocal);
const mayControl = (req: http.IncomingMessage, token: string | undefined) => auth.roleFor(peerOf(req), token, trustLocal) === 'operator';
const addressOf = (req: http.IncomingMessage) => req.socket.remoteAddress ?? '?';

// What a browser that has not signed in (a viewer) may ask for. Everything else needs the PIN, once one is set.
const VIEWER_MESSAGES = new Set<ClientMessage['type']>(['listPorts']);

const readJson = (req: http.IncomingMessage): Promise<Record<string, unknown>> => new Promise((resolve) => {
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
  req.on('end', () => { try { const j = JSON.parse(body || '{}'); resolve(j && typeof j === 'object' ? j : {}); } catch { resolve({}); } });
  req.on('error', () => resolve({}));
});
const json = (res: http.ServerResponse, code: number, body: unknown, headers: Record<string, string> = {}) =>
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }).end(JSON.stringify(body));
controller.heightMap = () => heightmaps.map;
controller.spindleConfig = () => config.full.spindle;
controller.pcbConfig = () => config.full.pcb;
console.log(heightmaps.map ? `Height map loaded from ${dataDir} (${heightmaps.map.cols} x ${heightmaps.map.rows} points)`
  : heightmaps.saved ? `A saved height map exists (${heightmaps.saved.cols} x ${heightmaps.saved.rows}) but is not loaded: use "Restore last scan", or set DEMONX_AUTOLOAD_MAP=1`
  : `No saved height map in ${dataDir}`);
probe.on('heightmap', (m) => heightmaps.set(m));
const haShare = new HaShare(() => config.full.homeAssistant.share && !!config.full.homeAssistant.url && !!config.full.homeAssistant.token,
  makePoster(() => config.full.homeAssistant), (kind, text) => controller.log(kind, text));
haShare.attach(controller, probe);
// Home Assistant through MQTT: the machine appears there as a device. Only these few commands may come back.
const HA_COMMANDS: Record<Command, ClientMessage> = {
  home: { type: 'home' }, unlock: { type: 'unlock' }, reset: { type: 'reset' }, hold: { type: 'hold' }, resume: { type: 'resume' }, stop: { type: 'jobStop' },
};
const appVersion = (() => {
  // the Windows package has its own package.json beside the server (with the build id); a git checkout has the repository's
  for (const dir of [here, path.resolve(here, '../..')]) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      if (!j.version) continue;
      let build: string | undefined = j.build;
      if (!build) { try { build = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* not a git checkout */ } }
      return build ? `${j.version} (${build})` : String(j.version);
    } catch { /* try the next place */ }
  }
  return 'unknown';
})();
const mqttBridge = new MqttBridge(
  () => config.full.mqtt,
  () => ({ status: controller.status, job: controller.job, connection: controller.connection, probe: probe.info, jobBytes: controller.job.state === 'none' ? 0 : Buffer.byteLength(controller.jobText()), pcb: config.full.pcb.enabled, heightmap: !!heightmaps.map, now: Date.now(), version: appVersion }),
  (cmd) => void controller.handle(HA_COMMANDS[cmd] as never),
  (kind, text) => controller.log(kind, text),
);
mqttBridge.attach(controller, probe);
mqttBridge.apply();
config.on('config', () => mqttBridge.apply());
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { mqttBridge.stop(); setTimeout(() => process.exit(0), 300); });

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const token = sessionToken(req.headers.cookie);
  if (url.pathname.startsWith('/api/auth/')) {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    if (!sameOrigin(req.headers.origin, req.headers.host)) { json(res, 403, { error: 'Not allowed from another site' }); return; }
    void (async () => {
      const body = await readJson(req);
      try {
        switch (url.pathname) {
          case '/api/auth/login': {
            const remember = body.remember === true;
            const t = auth.login(body.pin, addressOf(req), remember);
            return json(res, 200, { ok: true }, { 'set-cookie': sessionCookie(t, remember) });
          }
          case '/api/auth/logout':
            auth.logout(token);
            return json(res, 200, { ok: true }, { 'set-cookie': clearedCookie() });
          case '/api/auth/set-pin': {
            // changing the PIN needs a signed-in session; the first PIN needs the DemonX computer, or the setup code printed there
            if (!auth.canSetPin(peerOf(req), token, body.code, addressOf(req), trustLocal)) {
              return json(res, 401, { error: auth.mode === 'pin' ? 'Sign in first' : 'Set the first PIN on the DemonX computer, or enter the setup code shown there' });
            }
            const t = auth.setPin(body.pin);
            return json(res, 200, { ok: true }, { 'set-cookie': sessionCookie(t) });
          }
          case '/api/auth/open':
            // a deliberate choice to run without a PIN: the DemonX computer, or the setup code
            if (auth.mode === 'pin') return json(res, 400, { error: 'A PIN is already set: remove it from Settings, Access' });
            if (!auth.canSetPin(peerOf(req), token, body.code, addressOf(req), trustLocal)) return json(res, 401, { error: 'Enter the setup code shown on the DemonX computer' });
            auth.chooseOpen();
            return json(res, 200, { ok: true });
          case '/api/auth/clear-pin':
            if (!mayControl(req, token)) return json(res, 401, { error: 'Sign in first' });
            auth.clearPin();
            return json(res, 200, { ok: true }, { 'set-cookie': clearedCookie() });
          default: return json(res, 404, { error: 'Not found' });
        }
      } catch (e) {
        if (e instanceof AuthError) return json(res, e.retryAfterSec ? 429 : 400, { error: e.message, retryAfterSec: e.retryAfterSec });
        return json(res, 500, { error: 'Server error' });
      }
    })();
    return;
  }
  if (url.pathname === '/api/job.nc') {
    const name = controller.job.name || 'job.nc';
    res.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': `attachment; filename="${name.replace(/[^\w.\- ]/g, '_')}"` });
    res.end(controller.jobText());
    return;
  }
  if (url.pathname === '/api/camera/stream') {
    camera.attach(res); // answers by itself, with a message if no camera is set up
    return;
  }
  const backup = /^\/api\/fluidnc-backup\/([\w.\-]+\.yaml)$/.exec(url.pathname);
  if (backup) {
    if (!mayControl(req, token)) { res.writeHead(401).end('Sign in first'); return; }
    const t = machineSettings.backupText(backup[1]);
    if (t === undefined) { res.writeHead(404).end('No such backup'); return; }
    res.writeHead(200, { 'content-type': 'text/yaml', 'content-disposition': `attachment; filename="${backup[1]}"` }).end(t);
    return;
  }
  if (url.pathname === '/api/camera/hls-start') {
    // ask Home Assistant for its stream; the answer is an address the browser can play
    void (async () => {
      try {
        const src = await haStreamUrl(config.full);
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ src }));
      } catch (e) { res.writeHead(409, { 'content-type': 'text/plain' }).end((e as Error).message); }
    })();
    return;
  }
  const hls = hlsPath(url.pathname);
  if (hls) { void proxyHls(config.full, hls, url.search, res); return; }
  if (url.pathname === '/api/heightmap.json') {
    if (!heightmaps.map) { res.writeHead(404).end('No height map'); return; }
    res.writeHead(200, { 'content-type': 'application/json', 'content-disposition': 'attachment; filename="heightmap.json"' });
    res.end(JSON.stringify(heightmaps.map));
    return;
  }
  let file = path.join(webRoot, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!file.startsWith(webRoot)) { res.writeHead(403).end(); return; }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(webRoot, 'index.html');
  if (!fs.existsSync(file)) {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('DemonX server running. Build the UI with: npm run build');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 * 1024 });
const send = (ws: WebSocket, m: ServerMessage) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };
const broadcast = (m: ServerMessage) => wss.clients.forEach((c) => send(c as WebSocket, m));

controller.on('status', (d) => broadcast({ type: 'status', data: d }));
controller.on('job', (d) => broadcast({ type: 'job', data: d }));
controller.on('connection', (d) => broadcast({ type: 'connection', data: d }));
probe.on('probe', (d) => broadcast({ type: 'probe', data: d }));
heightmaps.on('heightmap', (d) => broadcast({ type: 'heightmap', data: d }));
heightmaps.on('saved', (d) => broadcast({ type: 'heightmapSaved', data: d }));
config.on('config', (d) => broadcast({ type: 'config', data: d }));
config.on('config', () => { if (!config.full.pcb.enabled) controller.clearPcbHomed(); });
macros.on('macros', (d) => broadcast({ type: 'macros', data: d }));
stats.on('stats', (d) => broadcast({ type: 'stats', data: d }));
controller.on('job', (j) => stats.observe(j));
// the running hours of a job in progress move on without any job update
setInterval(() => { if (controller.job.state === 'running') broadcast({ type: 'stats', data: stats.view() }); }, 60_000);
camera.on('state', (d) => broadcast({ type: 'camera', data: d }));
controller.on('log', (d) => broadcast({ type: 'log', data: d }));
// a PIN was set, changed or removed, or someone signed out: reconnect everybody so each browser learns its new role
auth.on('changed', () => wss.clients.forEach((c) => c.close(4001, 'Access changed')));

// keep job elapsed time ticking for all clients
setInterval(() => { if (controller.job.state === 'running') broadcast({ type: 'job', data: { ...controller.job, elapsedMs: Date.now() - (controller.job.startedAt ?? Date.now()) } }); }, 1000);

wss.on('connection', (ws, req) => {
  const token = sessionToken(req.headers.cookie);
  send(ws, {
    type: 'snapshot',
    data: {
      connection: controller.connection, status: controller.status, job: controller.job, probe: probe.info, heightmap: heightmaps.map, heightmapSaved: heightmaps.saved, config: config.view, camera: camera.state, macros: macros.list, stats: stats.view(),
      clients: wss.clients.size, log: controller.logBuffer.slice(-100),
      auth: { required: auth.mode === 'pin', operator: mayControl(req, token), local: peerOf(req) === 'local', mode: auth.mode, peer: peerOf(req) },
      addresses: lanUrls(PORT),
    },
  });
  broadcast({ type: 'clients', data: wss.clients.size });

  ws.on('message', async (raw) => {
    let msg: ClientMessage;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    // checked on every message, so a session that expired or was signed out stops working at once
    if (!VIEWER_MESSAGES.has(msg.type) && !mayControl(req, token)) return send(ws, { type: 'denied', data: { message: auth.mode === 'setup' ? 'This machine has no PIN yet: set one first (the bar at the top of the page)' : auth.mode === 'open' ? 'Outside your network you can only watch: set a PIN on the DemonX computer to control from here' : 'Sign in to control the machine' } });
    try {
      switch (msg.type) {
        case 'listPorts': return send(ws, { type: 'ports', data: await listSerialPorts() });
        case 'connect': {
          let t;
          if (msg.target === 'simulator') {
            const sim = new SimulatorTransport(Number(process.env.SIM_SPEED ?? 1), process.env.SIM_FIRMWARE === 'fluidnc' ? 'fluidnc' : 'grbl');
            // SIM_BOARD=1: a tilted, gently warped board instead of the XYZ touch block, to try autolevel
            if (process.env.SIM_BOARD) sim.surfaceFn = (x, y) => -10 + 0.02 * x + 0.01 * y + 0.1 * Math.sin(x / 8) * Math.cos(y / 8);
            t = sim;
          } else t = new SerialTransport(msg.target, msg.baud ?? 115200);
          return await controller.connect(t, msg.target);
        }
        case 'disconnect': return await controller.disconnect();
        case 'probeStart': return probe.start(msg.kind, msg.settings, msg.autolevel);
        case 'heightmapLoad': {
          const bad = validateHeightMap(msg.map);
          if (bad) return controller.log('err', `Height map not loaded: ${bad}`);
          heightmaps.set(msg.map);
          return controller.log('sys', `Height map loaded (${msg.map.cols} x ${msg.map.rows} points)`);
        }
        case 'configSet':
          try { config.update(msg.update); return send(ws, { type: 'configResult', data: { ok: true } }); }
          catch (e) {
            if (e instanceof ConfigError) return send(ws, { type: 'configResult', data: { ok: false, message: e.message } });
            throw e;
          }
        case 'mqttTest': {
          try { const c = config.preview(msg.mqtt ? { mqtt: msg.mqtt } : {}).mqtt; return send(ws, { type: 'mqttResult', data: await testBroker(c) }); }
          catch (e) { return send(ws, { type: 'mqttResult', data: { ok: false, message: (e as Error).message } }); }
        }
        case 'haShareTest': return send(ws, { type: 'haShareResult', data: await haShare.test() });
        case 'haCameras':
          try {
            const c = config.preview(msg.homeAssistant ? { homeAssistant: msg.homeAssistant } : {}).homeAssistant;
            return send(ws, { type: 'haCameras', data: { cameras: await listHaCameras(c.url, c.token, c.insecureTls) } });
          } catch (e) { return send(ws, { type: 'haCameras', data: { error: (e as Error).message } }); }
        case 'cameraTest':
          try {
            const frame = await camera.grabOne(config.preview(msg.update ?? {}));
            const kb = Math.max(1, Math.round(frame.length / 1024));
            return send(ws, { type: 'cameraTest', data: {
              ok: true, message: `Picture received (${kb} KB)`,
              image: frame.length <= 1_500_000 ? `data:image/jpeg;base64,${frame.toString('base64')}` : undefined,
            } });
          } catch (e) { return send(ws, { type: 'cameraTest', data: { ok: false, message: (e as Error).message } }); }
        case 'heightmapClear': heightmaps.set(null); return controller.log('sys', 'Height map cleared');
        case 'heightmapRestore':
          return heightmaps.restore()
            ? controller.log('sys', `Restored the last scan (${heightmaps.map!.cols} x ${heightmaps.map!.rows} points, ${new Date(heightmaps.map!.scannedAt).toLocaleString()}). Make sure it is the same board in the same position.`)
            : controller.log('err', 'There is no saved scan to restore');
        case 'macroSave':
          try { macros.save(msg.macro); return send(ws, { type: 'macroResult', data: { ok: true } }); }
          catch (e) {
            if (e instanceof MacroError) return send(ws, { type: 'macroResult', data: { ok: false, message: e.message } });
            throw e;
          }
        case 'macroDelete': return macros.remove(msg.id);
        case 'maintSave': case 'maintServiced': case 'maintDelete': case 'statsSetHours':
          try {
            if (msg.type === 'maintSave') stats.saveTask(msg.task);
            else if (msg.type === 'maintServiced') stats.serviced(msg.id);
            else if (msg.type === 'maintDelete') stats.deleteTask(msg.id);
            else stats.setHours(msg.hours);
            return send(ws, { type: 'statsResult', data: { ok: true } });
          } catch (e) {
            if (e instanceof StatsError) return send(ws, { type: 'statsResult', data: { ok: false, message: e.message } });
            throw e;
          }
        case 'macroRun': {
          const m = macros.find(msg.id);
          return m ? void controller.runMacro(m.name, m.content) : controller.log('err', 'That macro no longer exists');
        }
        case 'settingsRead': case 'settingsApply': case 'settingsSave': case 'controllerRestart': {
          const result = (ok: boolean, message: string) => send(ws, { type: 'machineSettingsResult', data: { ok, message } });
          const snapshot = (s: import('../../shared/machine-settings.js').MachineSettings) => send(ws, { type: 'machineSettings', data: { ...s, backups: machineSettings.backups() } });
          try {
            if (msg.type === 'settingsRead') { snapshot(await machineSettings.read()); return; }
            if (msg.type === 'settingsApply') {
              snapshot(await machineSettings.apply(msg.changes));
              controller.log('sys', `Controller settings changed: ${msg.changes.map((c) => `${c.key}=${c.value}`).join(', ')}`);
              return result(true, `Applied ${msg.changes.length} change${msg.changes.length === 1 ? '' : 's'}`);
            }
            if (msg.type === 'settingsSave') {
              const r = await machineSettings.save();
              snapshot(r.settings);
              controller.log('sys', `Controller config saved${r.backup ? ` (the previous one is kept as ${r.backup})` : ''}`);
              return result(true, `Saved to the controller${r.backup ? `. The previous config is kept as ${r.backup}` : ''}`);
            }
            await machineSettings.restart();
            return result(true, 'The controller is restarting');
          } catch (e) {
            if (e instanceof SettingsError) return result(false, e.message);
            throw e;
          }
        }
        case 'probeConfirm': return probe.confirm(msg.id, msg.phase);
        case 'probeCancel': return probe.cancel(msg.id);
        default: return controller.handle(msg);
      }
    } catch (e) {
      controller.log('err', (e as Error).message);
    }
  });
  ws.on('close', () => broadcast({ type: 'clients', data: wss.clients.size }));
});

// A busy port is the most common startup failure: say so plainly instead of a stack trace.
server.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Another DemonX (a terminal running "npm start"?), CNCjs or similar is running.`);
    console.error(process.platform === 'win32'
      ? `Find it with:  netstat -ano | findstr :${PORT}    then close that program, or use another port: set PORT=8090 before starting.`
      : `Find it with:  sudo ss -ltnp | grep :${PORT}    then stop it, or run on another port with PORT=8090.`);
  } else console.error(`Server error: ${e.message}`);
  process.exit(1);
});
wss.on('error', () => { /* the same error is reported by the http server above */ });
server.listen(PORT, () => {
  console.log(`DemonX server on http://0.0.0.0:${PORT}`);
  const urls = lanUrls(PORT);
  console.log(`Open it on this computer:  http://localhost:${PORT}`);
  if (urls.length) console.log(`From a phone or another computer on the same network:  ${urls.join('   or   ')}`);
  const code = auth.setupCode;
  if (code) {
    console.log('');
    console.log('DemonX has no PIN yet. Until one is set, only the browser on this computer can control the machine.');
    console.log('  - On this computer: open DemonX and use the "Set a PIN" bar at the top.');
    console.log(`  - From another device: open DemonX there and enter this setup code, then choose a PIN:   ${AuthStore.formatCode(code)}`);
    console.log('  - Or here, in a terminal:  npm run set-pin');
  }
});
