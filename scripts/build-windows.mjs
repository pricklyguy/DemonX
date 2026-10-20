#!/usr/bin/env node
// Builds the Windows package: one zip with DemonX, its own copy of Node, and a double-click start file.
// Layout: each version lives in versions\<version>\app, current.txt names the one that runs, and launcher.mjs (run by the start files with
// node\node.exe) starts it. That is what lets Update now unpack a new version beside the running one (see server/src/updateWindows.ts).
// Runs on Linux, macOS or Windows (the CI job runs it on Linux). Nothing is compiled for Windows: the serial port module
// ships a prebuilt Windows binary, and the server is bundled to plain JavaScript, so no Windows build tools are needed.
//
//   node scripts/build-windows.mjs                       build, downloading Node
//   node scripts/build-windows.mjs --node-zip file.zip   use an already downloaded Node for Windows (win-x64 zip)
//   node scripts/build-windows.mjs --skip-web            reuse web/dist and design/dist as they are
//   node scripts/build-windows.mjs --skip-design         leave DemonX Design out of the zip
//
// Output: dist-windows/DemonX-<version>-windows-x64.zip, and the same name + .sha256 (the checksum Update now checks the download against)

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const NODE_VERSION = opt('--node-version') ?? '22.22.0';   // the server needs Node 20 or newer

// On Windows the commands run through the shell (npm is a .cmd file there), which does not quote arguments: do it here
const q = (a) => (process.platform === 'win32' && /[\s&()^|<>]/.test(a) ? `"${a}"` : a);
const sh = (cmd, a, cwd = root) => execFileSync(cmd, a.map(q), { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
const say = (m) => console.log(`\n== ${m}`);

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const serverPkg = JSON.parse(fs.readFileSync(path.join(root, 'server/package.json'), 'utf8'));
let commit = '';
try { commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* not a git checkout */ }

const name = `DemonX-${pkg.version}-windows-x64`;
const outDir = path.join(root, 'dist-windows');
// the folder inside the zip has no version in its name, so a newer zip extracted over an older install lands in the same place
const stage = path.join(outDir, 'DemonX');
fs.rmSync(stage, { recursive: true, force: true });
const appDir = path.join(stage, 'versions', pkg.version, 'app');   // everything that belongs to this version
fs.mkdirSync(appDir, { recursive: true });

// ---- the web UI
if (!args.includes('--skip-web')) { say('Building the web UI'); sh('npm', ['run', 'build']); }
const webDist = path.join(root, 'web/dist');
if (!fs.existsSync(path.join(webDist, 'index.html'))) throw new Error('web/dist is missing: run "npm run build" first');
fs.cpSync(webDist, path.join(appDir, 'web'), { recursive: true });

// ---- the server, as plain JavaScript (packages stay separate: the serial port module must load its own binary)
say('Bundling the server');
await build({
  entryPoints: [path.join(root, 'server/src/index.ts')], outfile: path.join(appDir, 'server.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'node20', packages: 'external', sourcemap: false, legalComments: 'none',
});
// "Set PIN.bat" runs this one: set the access PIN without opening a browser
await build({
  entryPoints: [path.join(root, 'server/src/set-pin.ts')], outfile: path.join(appDir, 'set-pin.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'node20', packages: 'external', sourcemap: false, legalComments: 'none',
});

// ---- DemonX Design (the laser and design program): its web app and its server, which run on the same packages and the same Node
if (!args.includes('--skip-design')) {
  say('Building DemonX Design');
  const designDir = path.join(root, 'design');
  if (!fs.existsSync(path.join(designDir, 'node_modules'))) sh('npm', ['ci', '--no-audit', '--no-fund'], designDir);
  if (!args.includes('--skip-web')) sh('npm', ['run', 'build'], designDir);
  if (!fs.existsSync(path.join(designDir, 'dist/index.html'))) throw new Error('design/dist is missing: run "npm run build" in the design folder first');
  fs.cpSync(path.join(designDir, 'dist'), path.join(appDir, 'design-web'), { recursive: true });
  await build({
    entryPoints: [path.join(designDir, 'server/src/index.ts')], outfile: path.join(appDir, 'design-server.mjs'),
    bundle: true, platform: 'node', format: 'esm', target: 'node20', packages: 'external', sourcemap: false, legalComments: 'none',
  });
}

// ---- production packages, with the Windows serial port binary and nothing for other systems
say('Installing the server packages');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'demonx-win-'));
fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'demonx-win', private: true, dependencies: serverPkg.dependencies }, null, 2));
sh('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock'], tmp);
fs.cpSync(path.join(tmp, 'node_modules'), path.join(appDir, 'node_modules'), { recursive: true });
fs.rmSync(tmp, { recursive: true, force: true });
const prebuilds = path.join(appDir, 'node_modules/@serialport/bindings-cpp/prebuilds');
if (!fs.existsSync(path.join(prebuilds, 'win32-x64'))) throw new Error('the serial port module has no win32-x64 binary: its version changed?');
for (const d of fs.readdirSync(prebuilds)) if (!d.startsWith('win32-x64')) fs.rmSync(path.join(prebuilds, d), { recursive: true, force: true });

// what the running server reads for its version (there is no git on the user's computer)
fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: 'demonx', version: pkg.version, build: commit || undefined, type: 'module' }, null, 2));

// the version the start files run (the launcher reads this; an update changes it)
fs.writeFileSync(path.join(stage, 'current.txt'), pkg.version + '\n');

// ---- Node for Windows (just node.exe, plus its licence). Shared by every version: it is running while an update unpacks, so no update replaces it
say(`Node ${NODE_VERSION} for Windows`);
const zipName = `node-v${NODE_VERSION}-win-x64.zip`;
let nodeZip = opt('--node-zip');
if (!nodeZip) {
  nodeZip = path.join(outDir, zipName);
  if (!fs.existsSync(nodeZip)) {
    const base = `https://nodejs.org/dist/v${NODE_VERSION}`;
    const get = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(`${u}: ${r.status}`); return Buffer.from(await r.arrayBuffer()); };
    const zip = await get(`${base}/${zipName}`);
    const sums = (await get(`${base}/SHASUMS256.txt`)).toString('utf8');
    const want = sums.split('\n').find((l) => l.endsWith(` ${zipName}`))?.split(/\s+/)[0];
    const got = crypto.createHash('sha256').update(zip).digest('hex');
    if (!want || want !== got) throw new Error(`The Node download does not match its published checksum (${got} vs ${want})`);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(nodeZip, zip);
  }
}
const nx = fs.mkdtempSync(path.join(os.tmpdir(), 'demonx-node-'));
if (process.platform === 'win32') sh('tar', ['-xf', nodeZip, '-C', nx]); else sh('unzip', ['-q', nodeZip, '-d', nx]);
const nodeDir = path.join(nx, `node-v${NODE_VERSION}-win-x64`);
fs.mkdirSync(path.join(stage, 'node'));
fs.copyFileSync(path.join(nodeDir, 'node.exe'), path.join(stage, 'node/node.exe'));
fs.copyFileSync(path.join(nodeDir, 'LICENSE'), path.join(stage, 'node/LICENSE-node.txt'));
fs.rmSync(nx, { recursive: true, force: true });

// ---- start files and the guide (the .bat files need Windows line endings)
say('Adding the start files and the guide');
const crlf = (t) => t.replace(/\r?\n/g, '\r\n');
for (const f of fs.readdirSync(path.join(root, 'scripts/windows'))) {
  const text = fs.readFileSync(path.join(root, 'scripts/windows', f), 'utf8');
  fs.writeFileSync(path.join(stage, f), /\.(bat|vbs|ps1|txt)$/i.test(f) ? crlf(text) : text);
}
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(stage, 'LICENSE.txt'));
fs.writeFileSync(path.join(stage, 'READ ME FIRST.txt'), crlf(fs.readFileSync(path.join(root, 'docs/WINDOWS.md'), 'utf8')));

// ---- what the launcher (scripts/windows/launcher.mjs) and Update now (server/src/updateWindows.ts) rely on
for (const f of ['launcher.mjs', 'current.txt', 'node/node.exe', `versions/${pkg.version}/app/server.mjs`, `versions/${pkg.version}/app/set-pin.mjs`, `versions/${pkg.version}/app/package.json`,
  `versions/${pkg.version}/app/web/index.html`, `versions/${pkg.version}/app/node_modules`, 'Start DemonX.bat', 'Set PIN.bat', ...(args.includes('--skip-design') ? [] : [`versions/${pkg.version}/app/design-server.mjs`, `versions/${pkg.version}/app/design-web/index.html`, 'Start DemonX Design.bat'])]) {
  if (!fs.existsSync(path.join(stage, f))) throw new Error(`the package layout is wrong: ${f} is missing (the launcher and Update now need it)`);
}
if (fs.readFileSync(path.join(stage, 'current.txt'), 'utf8').trim() !== pkg.version) throw new Error('current.txt does not name this version');
for (const f of ['Start DemonX.bat', 'Start DemonX Design.bat', 'Set PIN.bat']) {
  if (fs.existsSync(path.join(stage, f)) && !fs.readFileSync(path.join(stage, f), 'utf8').includes('launcher.mjs')) throw new Error(`${f} does not start DemonX through launcher.mjs`);
}

// ---- zip it
say('Zipping');
const zipOut = path.join(outDir, `${name}.zip`);
fs.rmSync(zipOut, { force: true });
if (process.platform === 'win32') sh('tar', ['-a', '-cf', zipOut, '-C', outDir, 'DemonX']);
else sh('zip', ['-q', '-r', '-9', zipOut, 'DemonX'], outDir);
// the checksum Update now checks the download against, in sha256sum's format
const digest = crypto.createHash('sha256').update(fs.readFileSync(zipOut)).digest('hex');
fs.writeFileSync(`${zipOut}.sha256`, `${digest}  ${path.basename(zipOut)}\n`);
const mb = (fs.statSync(zipOut).size / 1048576).toFixed(1);
console.log(`\nDone: ${path.relative(root, zipOut)} (${mb} MB)${commit ? `, build ${commit}` : ''}\nChecksum: ${path.relative(root, zipOut)}.sha256 (${digest})`);
