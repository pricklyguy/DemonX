// DemonX Design's server: owns the laser's connection and serves the built app.
//   npm run build && npm run serve        then open http://localhost:8090
// For development run `npm run dev:server` and `npm run dev` (the app proxies /ws to this server).
//
// Access: only this computer. A connection from anywhere else is refused, and so is a web page from another site that
// tries to reach the laser through the browser (the WebSocket's Origin must match the address it was opened on).
import { rotaryOn } from './rotary.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LaserSession } from './laserSession.js';
import { LaserHub } from './laserHub.js';
import { RuidaSession } from './ruida/session.js';
import { ruidaConfigFromEnv } from './ruida/config.js';
import { createLaserServer } from './app.js';
import { makeAccess } from './access.js';
import { CameraStore } from './camera.js';
import { AuthStore, lanUrls } from '../../../server/src/auth.js';

const PORT = Number(process.env.DESIGN_PORT ?? 8090);
const HOST = process.env.DESIGN_HOST ?? '127.0.0.1';
const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(process.env.DESIGN_WEB ?? path.join(here, '../../dist'));

const simSpeed = Number(process.env.DESIGN_SIM_SPEED ?? 1);
const ruidaConfig = ruidaConfigFromEnv(process.env);
if (ruidaConfig.enabled) console.log('Ruida support is ON. It has not been tried on a real machine: first runs at low power, watching, with a hand on the emergency stop.');
const session = new LaserHub(new LaserSession({ simSpeed, allowedPorts: (process.env.DESIGN_SERIAL_PORTS ?? '').split(',').map((s) => s.trim()).filter(Boolean) }), new RuidaSession({ config: ruidaConfig, simSpeed, storeFile: path.join(process.env.DESIGN_DATA ?? path.resolve(here, '../../data'), 'ruida-controllers.json'), rotaryOn: (target) => rotaryOn(path.join(process.env.DESIGN_DATA ?? path.resolve(here, '../../data'), 'rotary.json'), target) }));
const dataDir = process.env.DESIGN_DATA ?? path.resolve(here, '../../data');
// The PIN. To use one PIN for DemonX CNC and Design, point DESIGN_AUTH_DIR at DemonX CNC's data folder (they then share the PIN
// and the signed-in browsers); by default Design keeps its own. The computer that runs the server never needs the PIN.
const authDir = process.env.DESIGN_AUTH_DIR ?? dataDir;
let auth: AuthStore;
try { auth = new AuthStore(authDir); } catch (e) {
  console.error(`Cannot use ${authDir} for the PIN (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}). If this is the DESIGN_AUTH_DIR line in design.env, check that the folder really exists on this computer (it should be DemonX CNC's data folder).`);
  process.exit(1);
}
const access = makeAccess(auth, process.env.DESIGN_TRUST_LOCAL !== '0');
// https, when a certificate is given (DESIGN_TLS_CERT and DESIGN_TLS_KEY, paths): a browser only offers its Save As and Open dialogs
// (and stops flagging downloads) on a secure address, which http://<another computer>:8090 is not
let tls: { cert: Buffer; key: Buffer } | undefined;
if (process.env.DESIGN_TLS_CERT || process.env.DESIGN_TLS_KEY) {
  try { tls = { cert: fs.readFileSync(process.env.DESIGN_TLS_CERT ?? ''), key: fs.readFileSync(process.env.DESIGN_TLS_KEY ?? '') }; } catch (e) {
    console.error(`Cannot read the certificate or key (DESIGN_TLS_CERT, DESIGN_TLS_KEY): ${(e as Error).message}`);
    process.exit(1);
  }
}
const { server } = createLaserServer(session, webRoot, { libraryFile: path.join(dataDir, 'material-library.json'), lasersFile: path.join(dataDir, 'lasers.json'), toolLibFile: path.join(dataDir, 'tool-library.json'), positionsFile: path.join(dataDir, 'positions.json'), rotaryFile: path.join(dataDir, 'rotary.json'), camera: new CameraStore(path.join(dataDir, 'camera.json'), process.env.DESIGN_CNC_DATA ?? process.env.DESIGN_AUTH_DIR), tls, access });

server.on('error', (e: NodeJS.ErrnoException) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use (is DemonX Design already running?).` : e.message);
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  const everywhere = HOST === '0.0.0.0' || HOST === '::';
  console.log(`DemonX Design laser server on ${tls ? 'https' : 'http'}://${HOST}:${PORT} ${everywhere ? '(this computer and the home network)' : '(this computer only)'}`);
  if (everywhere) for (const u of lanUrls(PORT)) console.log(`  other computers on the home network: ${tls ? u.replace('http:', 'https:') : u}`);
  const code = auth.setupCode;
  if (code) console.log(`No PIN is set yet. Other computers can only watch until you set one (Settings, Access) on this computer. Setup code for setting it from elsewhere: ${AuthStore.formatCode(code)}`);
});
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { void session.close().finally(() => process.exit(0)); });
}
