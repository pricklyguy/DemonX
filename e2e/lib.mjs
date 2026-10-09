// Shared helpers for the browser (end to end) checks in this folder.
//
// These drive a real browser against a running DemonX. Start the server first, with the
// built UI and a throwaway data folder, using the simulator so no machine is needed:
//
//   npm run build
//   SIM_SPEED=30 DEMONX_DATA=/tmp/demonx-e2e PORT=8080 npm start
//
// Needs Playwright with a Chromium. Set PLAYWRIGHT_PATH to the playwright package folder
// and CHROMIUM to the browser binary if they are not found automatically.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
function loadPlaywright() {
  for (const p of [process.env.PLAYWRIGHT_PATH, 'playwright', '/opt/node22/lib/node_modules/playwright']) {
    if (!p) continue;
    try { return require(p); } catch { /* try the next */ }
  }
  throw new Error('Playwright not found. Install it (npm i -g playwright) or set PLAYWRIGHT_PATH.');
}
export const { chromium } = loadPlaywright();
export const URL_BASE = process.env.DEMONX_URL ?? 'http://localhost:8080';

const chromiumPath = process.env.CHROMIUM ?? (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
/** Software WebGL flags make the 3D view work in a headless browser without a GPU */
export const launch = () => chromium.launch({
  ...(chromiumPath ? { executablePath: chromiumPath } : {}),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'],
});

export async function open(browser, w, h, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, ...opts });
  const p = await ctx.newPage();
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  p.errors = errors;
  await p.goto(URL_BASE); await p.waitForSelector('.panel'); await p.waitForTimeout(500);
  return p;
}

/** Connect to the built-in simulator, unless the server is already connected */
export async function connect(p) {
  if (await p.locator('input[list=ports]').count()) {
    await p.fill('input[list=ports]', 'simulator');
    await p.getByRole('button', { name: 'Connect', exact: true }).click();
  }
  await p.waitForSelector('text=Connected to'); await p.waitForTimeout(400);
}

/** Every panel's rectangle, and how many pixels its body would have to scroll */
export const report = (p) => p.evaluate(() => [...document.querySelectorAll('.panel')].map((el) => {
  const r = el.getBoundingClientRect(), b = el.querySelector('.body');
  return { id: el.dataset.panel, x: Math.round(r.x), y: Math.round(r.y + scrollY), w: Math.round(r.width), h: Math.round(r.height),
    overflow: b ? b.scrollHeight - b.clientHeight : 0 };
}));
export const overlaps = (rs) => { const o = []; for (const a of rs) for (const b of rs) if (a.id < b.id && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) o.push(a.id + '/' + b.id); return o; };

/** Screenshots go to a temp folder (E2E_SHOTS to change it), never into the working directory */
export const SHOT_DIR = process.env.E2E_SHOTS ?? path.join(os.tmpdir(), 'demonx-e2e-shots');
export const shotPath = (name) => { fs.mkdirSync(SHOT_DIR, { recursive: true }); return path.join(SHOT_DIR, name); };
