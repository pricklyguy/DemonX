// Position panel: coordinates in the thousands must fit without a sideways scrollbar (restart the server first: it moves the simulator)
import { launch, open, connect } from './lib.mjs';
const b = await launch();
let ok = 0, bad = 0;
const check = (name, cond, extra = '') => { (cond ? ok++ : bad++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`); };
for (const [w, h] of [[1920, 1080], [1366, 768]]) {
  const p = await open(b, w, h); await connect(p);
  await p.getByPlaceholder(/Send command/).fill('G90 G0 X-1234.56 Y1999.99'); await p.keyboard.press('Enter');
  await p.waitForFunction(() => document.querySelector('.wpos')?.textContent === '-1234.56', null, { timeout: 15000 });
  const r = await p.locator('[data-panel=position] .body').evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, txt: [...el.querySelectorAll('.wpos')].map((e) => e.textContent).join(' ') }));
  check(`${w}px wide: X -1234.56 and Y 1999.99 fit with no sideways scroll`, r.sw <= r.cw + 1, JSON.stringify(r));
  check(`${w}px wide: the large readout has 2 decimals`, /-1234\.56 1999\.99/.test(r.txt), r.txt);
  const edges = await p.locator('[data-panel=position]').evaluate((el) => {
    const right = (sel) => [...el.querySelectorAll(sel)].map((e) => Math.round(e.getBoundingClientRect().right));
    const left = (sel) => [...el.querySelectorAll(sel)].map((e) => Math.round(e.getBoundingClientRect().left));
    return { w: right('.wpos'), m: right('.mpos'), z: left('.dro-row .btn') };
  });
  const same = (a) => a.length === 3 && a.every((x) => x === a[0]);
  check(`${w}px wide: the three axes line up (work, machine and Zero columns)`, same(edges.w) && same(edges.m) && same(edges.z), JSON.stringify(edges));
  const frame = await p.getByRole('button', { name: 'Frame', exact: true }).evaluate((el) => getComputedStyle(el).borderTopWidth);
  check(`${w}px wide: Frame has a thick border`, parseFloat(frame) >= 3, frame);
  if (w === 1920) await p.locator('[data-panel=position]').screenshot({ path: (await import('./lib.mjs')).shotPath('position-wide.png') });
  await p.context().close();
}
console.log(`\n${ok} passed, ${bad} failed`);
await b.close(); process.exit(bad ? 1 : 0);
