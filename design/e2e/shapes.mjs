// Browser check for the Draw Circle panel: Diameter or Radius, click to place at a set size, Create at typed centre, drag still draws.
//
//   cd design && npm run build
//   DESIGN_DATA=$(mktemp -d) npm run serve &      (any fresh server)
//   node e2e/shapes.mjs
//
// Stop the server by its port when done (fuser -k 8090/tcp), not with pkill -f.
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
function loadPlaywright() {
  for (const p of [process.env.PLAYWRIGHT_PATH, 'playwright', '/opt/node22/lib/node_modules/playwright']) {
    if (!p) continue;
    try { return require(p); } catch { /* try the next */ }
  }
  throw new Error('Playwright not found. Install it (npm i -g playwright) or set PLAYWRIGHT_PATH.');
}
const { chromium } = loadPlaywright();
import { startDesign } from './start.mjs';
const URL_BASE = process.env.DESIGN_URL ?? 'http://localhost:8090';
const chromiumPath = process.env.CHROMIUM ?? (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
let failures = 0;
const check = (ok, what) => { console.log((ok ? 'PASS ' : 'FAIL ') + what); if (!ok) failures++; };

const browser = await chromium.launch({ ...(chromiumPath ? { executablePath: chromiumPath } : {}) });
const page = await (await browser.newContext({ viewport: { width: 1360, height: 820 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(URL_BASE);
await page.waitForSelector('canvas.design-canvas');
await startDesign(page, { laser: '3018 + laser head' });
const shapes = () => page.evaluate(() => window.demonxDesign.doc().shapes);
const circles = async () => (await shapes()).filter((s) => s.kind === 'circle');

const tools = page.getByRole('navigation', { name: 'Tools' });
await tools.getByRole('button', { name: /^Circle \(C\)/ }).click();
const panel = page.getByRole('group', { name: 'Draw Circle' });
await panel.waitFor();
check(await panel.getByRole('radio', { name: 'Diameter' }).isChecked(), 'the circle panel opens with Diameter chosen');
check((await panel.getByLabel('Circle diameter').inputValue()) === '10', 'and a diameter of 10 mm');

await panel.getByLabel('Circle diameter').fill('30'); await panel.getByLabel('Circle diameter').press('Enter');
const cv = await page.locator('canvas.design-canvas').boundingBox();
const at = (fx, fy) => ({ x: cv.x + cv.width * fx, y: cv.y + cv.height * fy });
for (const [fx, fy] of [[0.45, 0.35], [0.6, 0.5], [0.75, 0.65]]) { const p = at(fx, fy); await page.mouse.click(p.x, p.y); }
await page.waitForTimeout(200);
let cs = await circles();
check(cs.length === 3, 'three clicks put down three circles: ' + cs.length);
check(cs.every((c) => Math.abs(c.r - 15) < 1e-6), 'each has radius 15 (diameter 30): ' + cs.map((c) => c.r).join(', '));
check(new Set(cs.map((c) => c.cx + ',' + c.cy)).size === 3, 'at three different places');
const x0 = Number(await panel.getByLabel('Circle centre X').inputValue());
check(Math.abs(x0 - cs[2].cx) < 0.01, 'the panel shows where the last one went (X ' + x0 + ')');

// radius: the size converts, and the same click makes the same circle
await panel.getByRole('radio', { name: 'Radius' }).check(); await page.waitForTimeout(150);
const rv = await panel.getByLabel('Circle radius').inputValue(); check(rv === '15', 'switching to Radius turns 30 into 15 (it shows ' + rv + ')');
await panel.getByLabel('Circle radius').fill('5'); await panel.getByLabel('Circle radius').press('Enter');
const p4 = at(0.3, 0.7); await page.mouse.click(p4.x, p4.y);
await page.waitForTimeout(150);
cs = await circles();
check(cs.length === 4 && Math.abs(cs[3].r - 5) < 1e-6, 'a click in Radius mode with 5 makes a circle of radius 5');

// typed centre and Create
await panel.getByLabel('Circle centre X').fill('100'); await panel.getByLabel('Circle centre X').press('Enter');
await panel.getByLabel('Circle centre Y').fill('50'); await panel.getByLabel('Circle centre Y').press('Enter');
await panel.getByRole('button', { name: 'Create' }).click();
cs = await circles();
const last = cs[cs.length - 1];
check(cs.length === 5 && Math.abs(last.cx - 100) < 1e-6 && Math.abs(last.r - 5) < 1e-6, 'Create puts the circle at the typed centre: ' + last.cx + ', ' + last.cy);
check(Math.abs((180 - last.cy) - 50) < 1e-6, 'and the typed Y counts from the top of the page like the Y box (' + last.cy + ' from the bottom)');

// a drag still sizes a circle by hand
const a = at(0.55, 0.2), b = { x: a.x + 60, y: a.y };
await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 5 }); await page.mouse.up();
await page.waitForTimeout(150);
cs = await circles();
check(cs.length === 6 && Math.abs(cs[5].r - 5) > 1, 'dragging still draws a circle of the size you drag: r ' + cs[5]?.r);

await panel.getByRole('button', { name: 'Close' }).click();
check((await panel.count()) === 0, 'Close puts the panel away');

// ---- the rectangle panel
await tools.getByRole('button', { name: /^Rectangle \(R\)/ }).click();
const rpanel = page.getByRole('group', { name: 'Draw Rectangle' });
await rpanel.waitFor();
const rects = async () => (await shapes()).filter((s) => s.kind === 'path');
const box = (s) => { const pts = s.rings.flat(); const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]); return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) }; };
check((await rpanel.getByLabel('Rectangle width').inputValue()) === '20' && (await rpanel.getByLabel('Rectangle height').inputValue()) === '10', 'the rectangle panel opens at 20 by 10');
check(await rpanel.getByRole('radio', { name: 'Point: centre' }).getAttribute('aria-checked') === 'true', 'the centre is the point that goes where you click');
await rpanel.getByLabel('Rectangle width').fill('40'); await rpanel.getByLabel('Rectangle width').press('Enter');
await rpanel.getByLabel('Rectangle height').fill('20'); await rpanel.getByLabel('Rectangle height').press('Enter');
const before = (await rects()).length;
const q1 = at(0.55, 0.45); await page.mouse.click(q1.x, q1.y);
await page.waitForTimeout(200);
let rs = await rects();
check(rs.length === before + 1, 'a click puts down a rectangle');
let b1 = box(rs[rs.length - 1]);
check(Math.abs((b1.x1 - b1.x0) - 40) < 1e-6 && Math.abs((b1.y1 - b1.y0) - 20) < 1e-6, 'of the size in the panel (40 by 20)');
const cx = (b1.x0 + b1.x1) / 2, cy = (b1.y0 + b1.y1) / 2;
check(Math.abs(Number(await rpanel.getByLabel('Rectangle point X').inputValue()) - cx) < 0.01, 'its centre is at the click (the panel shows X ' + cx + ')');
// the top-left of the rectangle on the click
await rpanel.getByRole('radio', { name: 'Point: top-left' }).click();
const q2 = at(0.7, 0.4); await page.mouse.click(q2.x, q2.y);
await page.waitForTimeout(200);
rs = await rects();
const b2 = box(rs[rs.length - 1]);
const shownX = Number(await rpanel.getByLabel('Rectangle point X').inputValue());
check(Math.abs(b2.x0 - shownX) < 0.01, 'with the top-left chosen, the left edge is at the click (X ' + shownX + ')');
check(Math.abs((b2.y1 - b2.y0) - 20) < 1e-6, 'and the top is the click (the rectangle hangs down from it)');
// typed place and Create
await rpanel.getByRole('radio', { name: 'Point: centre' }).click();
await rpanel.getByLabel('Rectangle point X').fill('150'); await rpanel.getByLabel('Rectangle point X').press('Enter');
await rpanel.getByLabel('Rectangle point Y').fill('90'); await rpanel.getByLabel('Rectangle point Y').press('Enter');
await rpanel.getByRole('button', { name: 'Create' }).click();
rs = await rects();
const b3 = box(rs[rs.length - 1]);
check(Math.abs((b3.x0 + b3.x1) / 2 - 150) < 1e-6 && Math.abs(((b3.y0 + b3.y1) / 2) - (180 - 90)) < 1e-6, 'Create puts the centre at the typed X 150, Y 90 (counted from the top of the page)');
// drag still draws by hand
const da = at(0.3, 0.8), db = { x: da.x + 80, y: da.y + 40 };
const nBefore = (await rects()).length;
await page.mouse.move(da.x, da.y); await page.mouse.down(); await page.mouse.move(db.x, db.y, { steps: 5 }); await page.mouse.up();
await page.waitForTimeout(150);
rs = await rects();
const b4 = box(rs[rs.length - 1]);
check(rs.length === nBefore + 1 && Math.abs((b4.x1 - b4.x0) - 40) > 1, 'dragging still draws a rectangle of the size you drag: ' + (b4.x1 - b4.x0).toFixed(1));
await rpanel.getByRole('button', { name: 'Close' }).click();
await tools.getByRole('button', { name: /^Circle \(C\)/ }).click();
await page.getByRole('group', { name: 'Draw Circle' }).waitFor();
check((await rpanel.count()) === 0, 'choosing the circle tool swaps the rectangle card for the circle card');
await page.getByRole('group', { name: 'Draw Circle' }).getByRole('button', { name: 'Close' }).click();
check(await tools.getByRole('button', { name: /^Select \(V\)/ }).getAttribute('aria-pressed') === 'true', 'and goes back to Select');
// ellipse, polygon, star and arc: the same card and click-to-place
const paths = async () => (await shapes()).filter((s) => s.kind === 'path');
const bb = (s) => { const pts = s.rings.flat(); const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]); return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys), n: pts.length }; };
await tools.getByRole('button', { name: 'Ellipse', exact: true }).click();
const epanel = page.getByRole('group', { name: 'Draw Ellipse' }); await epanel.waitFor();
await epanel.getByLabel('Ellipse width').fill('40'); await epanel.getByLabel('Ellipse width').press('Enter');
await epanel.getByLabel('Ellipse height').fill('20'); await epanel.getByLabel('Ellipse height').press('Enter');
const n0 = (await paths()).length;
const e1 = at(0.4, 0.4); await page.mouse.click(e1.x, e1.y); await page.waitForTimeout(150);
let ps = await paths(); let eb = bb(ps[ps.length - 1]);
check(ps.length === n0 + 1 && Math.abs(eb.w - 40) < 0.05 && Math.abs(eb.h - 20) < 0.05, 'a click puts a 40 x 20 ellipse down: ' + eb.w.toFixed(2) + ' x ' + eb.h.toFixed(2));
const e2 = at(0.6, 0.6); await page.mouse.click(e2.x, e2.y); await page.waitForTimeout(150);
check((await paths()).length === n0 + 2, 'and again at the next click');
const dstart = at(0.3, 0.8);
await page.mouse.move(dstart.x, dstart.y); await page.mouse.down(); await page.mouse.move(dstart.x + 90, dstart.y + 50, { steps: 5 }); await page.mouse.up(); await page.waitForTimeout(150);
ps = await paths(); eb = bb(ps[ps.length - 1]);
check(ps.length === n0 + 3 && Math.abs(eb.w - 40) > 1, 'a drag draws an ellipse in the box you drag: ' + eb.w.toFixed(1) + ' x ' + eb.h.toFixed(1));

await tools.getByRole('button', { name: 'Regular polygon with any number of sides', exact: true }).click();
const ppanel = page.getByRole('group', { name: 'Draw Polygon' }); await ppanel.waitFor();
check(await ppanel.getByRole('radio', { name: 'Diameter' }).isChecked(), 'the polygon card also defaults to Diameter');
await ppanel.getByLabel('Polygon sides').fill('8'); await ppanel.getByLabel('Polygon sides').press('Enter');
await ppanel.getByLabel('Polygon diameter').fill('30'); await ppanel.getByLabel('Polygon diameter').press('Enter');
const pn = (await paths()).length;
const p1 = at(0.5, 0.3); await page.mouse.click(p1.x, p1.y); await page.waitForTimeout(150);
ps = await paths(); const pg = ps[ps.length - 1];
const pc = pg.rings[0].reduce((a, q) => [a[0] + q[0] / 8, a[1] + q[1] / 8], [0, 0]);
check(ps.length === pn + 1 && pg.rings[0].length === 8 && pg.closed && pg.rings[0].every((q) => Math.abs(Math.hypot(q[0] - pc[0], q[1] - pc[1]) - 15) < 0.01), 'a click puts an 8-sided polygon with corners 15 mm from its centre');

await tools.getByRole('button', { name: 'Star', exact: true }).click();
const spanel = page.getByRole('group', { name: 'Draw Star' }); await spanel.waitFor();
await spanel.getByLabel('Star diameter').fill('40'); await spanel.getByLabel('Star diameter').press('Enter');
const sn = (await paths()).length;
const s1 = at(0.7, 0.3); await page.mouse.click(s1.x, s1.y); await page.waitForTimeout(150);
ps = await paths(); const st = ps[ps.length - 1];
check(ps.length === sn + 1 && st.rings[0].length === 10, 'a click puts a 5-pointed star down (10 corners)');

await tools.getByRole('button', { name: 'Arc', exact: true }).click();
const apanel = page.getByRole('group', { name: 'Draw Arc' }); await apanel.waitFor();
await apanel.getByLabel('Arc diameter').fill('40'); await apanel.getByLabel('Arc diameter').press('Enter');
await apanel.getByLabel('Arc end angle').fill('180'); await apanel.getByLabel('Arc end angle').press('Enter');
const an = (await paths()).length;
const a1 = at(0.5, 0.7); await page.mouse.click(a1.x, a1.y); await page.waitForTimeout(150);
ps = await paths(); const ar = ps[ps.length - 1];
const ab = bb(ar);
check(ps.length === an + 1 && !ar.closed && Math.abs(ab.w - 40) < 0.05 && Math.abs(ab.h - 20) < 0.05, 'a click puts an open half circle down: ' + ab.w.toFixed(2) + ' x ' + ab.h.toFixed(2));
await apanel.getByRole('button', { name: 'Create' }).click(); await page.waitForTimeout(150);
check((await paths()).length === an + 2, 'Create puts one at the typed centre');
await apanel.getByRole('button', { name: 'Close' }).click();
check((await page.getByRole('group', { name: /^Draw (Ellipse|Polygon|Star|Arc)$/ }).count()) === 0, 'Close puts the card away');
// remembered
await page.reload();
await startDesign(page);
await tools.getByRole('button', { name: /^Circle \(C\)/ }).click();
check(await page.getByRole('group', { name: 'Draw Circle' }).getByRole('radio', { name: 'Radius' }).isChecked(), 'the choice (Radius, 5) is remembered in this browser');
check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
await browser.close();
process.exit(failures ? 1 : 0);
