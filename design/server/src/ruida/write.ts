// Plan -> the Ruida command stream LightBurn sends for the same layers (layout read from two captured jobs)
// Only line and fill layers, one pass, laser 1. Fields whose meaning is unknown are written with the
// values both captured jobs had.
import { enc14, enc35, encPower, encSpeed, REL_MAX, REL_MIN, toUm, chunkStream, DEFAULT_KEY } from './codec.js';
import { planBox, layerBox, burnLength, type Box, type RuidaPlan, type RuidaLayer } from './plan.js';

const ZERO10 = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
/** Second laser's power, as LightBurn writes it for a one-tube machine (20 %); the unused field is not changed per layer */
const LASER2 = encPower(20);
/** The 10 bytes of `F2 02` in both captured jobs (an element id or name; meaning unknown) */
const F2_02 = [0x05, 0x2a, 0x39, 0x1c, 0x41, 0x04, 0x6a, 0x15, 0x08, 0x20];
const MODE_BYTE = { line: 0x00, fill: 0x02 } as const;
const BODY_MODE = { line: 0x00, fill: 0x01 } as const;

const pt = (x: number, y: number) => [...enc35(x), ...enc35(y)];
/** LightBurn writes boxes to 0.01 mm */
const box10 = (b: Box): [number, number, number, number] => [b.minX, b.minY, b.maxX, b.maxY].map((v) => Math.round(toUm(v) / 10) * 10) as [number, number, number, number];

export interface WriteOptions { key?: number }

export function writeJobStream(plan: RuidaPlan): Buffer {
  if (!plan.layers.length) throw new Error('A job needs at least one layer');
  const out: number[] = [];
  const cmd = (...b: number[]) => { out.push(...b); };
  const total = planBox(plan);
  if (!total) throw new Error('A job needs at least one point');
  const [x0, y0, x1, y1] = box10(total);

  cmd(0xd8, 0x12); cmd(0xf0); cmd(0xf1, 0x02, 0x00); cmd(0xd8, 0x00);
  cmd(0xe7, 0x06, ...ZERO10);
  cmd(0xe7, 0x38, 0x00);
  cmd(0xe7, 0x03, ...pt(x0, y0));
  cmd(0xe7, 0x07, ...pt(x1, y1));
  cmd(0xe7, 0x50, ...pt(x0, y0));
  cmd(0xe7, 0x51, ...pt(x1, y1));
  cmd(0xe7, 0x04, 0x00, 0x01, 0x00, 0x01, ...ZERO10);
  cmd(0xe7, 0x05, 0x00);
  plan.layers.forEach((l, i) => {
    const lb = layerBox(l);
    if (!lb) throw new Error(`Layer ${i} has no points`);
    const [a, b, c, d] = box10(lb);
    cmd(0xc9, 0x04, i, ...encSpeed(l.speed));
    cmd(0xc6, 0x31, i, ...encPower(l.minPower));
    cmd(0xc6, 0x32, i, ...encPower(l.maxPower));
    cmd(0xc6, 0x41, i, ...LASER2);
    cmd(0xc6, 0x42, i, ...LASER2);
    cmd(0xca, 0x06, i, ...enc35(l.colorRaw));
    cmd(0xca, 0x41, i, MODE_BYTE[l.mode]);
    cmd(0xe7, 0x52, i, ...pt(a, b));
    cmd(0xe7, 0x53, i, ...pt(c, d));
    cmd(0xe7, 0x61, i, ...pt(a, b));
    cmd(0xe7, 0x62, i, ...pt(c, d));
  });
  cmd(0xca, 0x22, plan.layers.length - 1);
  cmd(0xe7, 0x54, 0x00, 0, 0, 0, 0, 0); cmd(0xe7, 0x54, 0x01, 0, 0, 0, 0, 0);
  cmd(0xe7, 0x55, 0x00, 0, 0, 0, 0, 0); cmd(0xe7, 0x55, 0x01, 0, 0, 0, 0, 0);
  cmd(0xf1, 0x03, ...ZERO10);
  cmd(0xf1, 0x00, 0x00); cmd(0xf1, 0x01, 0x00);
  cmd(0xf2, 0x00, 0x00); cmd(0xf2, 0x01, 0x00);
  cmd(0xf2, 0x02, ...F2_02);
  cmd(0xf2, 0x03, ...pt(x0, y0));
  cmd(0xf2, 0x04, ...pt(x1, y1));
  cmd(0xf2, 0x05, 0x00, 0x01, 0x00, 0x01, ...pt(x1 - x0, y1 - y0));
  cmd(0xf2, 0x06, ...ZERO10);
  cmd(0xf2, 0x07, 0x00);
  cmd(0xea, 0x00);
  cmd(0xe7, 0x60, 0x00);
  cmd(0xe7, 0x13, ...pt(x0, y0));
  cmd(0xe7, 0x17, ...pt(x1, y1));
  cmd(0xe7, 0x23, ...pt(x0, y0));
  cmd(0xe7, 0x24, 0x00);
  cmd(0xe7, 0x37, ...pt(x1, y1));
  cmd(0xe7, 0x08, 0x00, 0x01, 0x00, 0x01, ...pt(x1 - x0, y1 - y0));

  plan.layers.forEach((l, i) => {
    cmd(0xca, 0x01, BODY_MODE[l.mode]);
    cmd(0xca, 0x02, i);
    cmd(0xca, 0x01, 0x30);
    cmd(0xca, 0x01, 0x10);
    cmd(0xca, 0x01, l.air ? 0x13 : 0x12);
    cmd(0xc9, 0x02, ...encSpeed(l.speed));
    const powers = () => { cmd(0xc6, 0x01, ...encPower(l.minPower)); cmd(0xc6, 0x02, ...encPower(l.maxPower)); cmd(0xc6, 0x21, ...LASER2); cmd(0xc6, 0x22, ...LASER2); };
    const delays = () => { cmd(0xc6, 0x12, 0, 0, 0, 0, 0); cmd(0xc6, 0x13, 0, 0, 0, 0, 0); };
    if (l.mode === 'line') { delays(); cmd(0xc6, 0x50, 0x00, 0x01); cmd(0xc6, 0x51, 0x00, 0x01); powers(); } else { powers(); delays(); }
    cmd(0xca, 0x03, 0x01);
    // one by one: spreading a layer's bytes into a call overflows the stack once a fill has a hundred thousand lines
    for (const b of moves(l)) out.push(b);
    if (l.mode === 'fill') cmd(0xe7, 0x00);
  });

  cmd(0xeb);
  cmd(0xe7, 0x00);
  const lengthField = plan.lengthField ?? Math.round(burnLength(plan));
  cmd(0xda, 0x01, 0x06, 0x20, ...enc35(lengthField), ...enc35(lengthField));
  const sum = out.reduce((s, b) => s + b, 0) + 0xd7;
  cmd(0xe5, 0x05, ...enc35(sum));
  cmd(0xd7);
  return Buffer.from(out);
}

function moves(l: RuidaLayer): number[] {
  const out: number[] = [];
  let px = 0, py = 0;
  l.points.forEach((p, i) => {
    const x = toUm(p.x), y = toUm(p.y);
    if (i === 0) {
      if (p.burn) throw new Error('The first point of a layer must be a move, not a burn');
      out.push(0x88, ...enc35(x), ...enc35(y));
    } else {
      const dx = x - px, dy = y - py;
      const burn = p.burn ? 0x20 : 0;
      if (dx === 0 && dy === 0) return; // a repeated point moves nothing
      if (dx < REL_MIN || dx > REL_MAX || dy < REL_MIN || dy > REL_MAX) out.push(0x88 | burn, ...enc35(x), ...enc35(y));
      else if (dy === 0) out.push(0x8a | burn, ...enc14(dx));
      else if (dx === 0) out.push(0x8b | burn, ...enc14(dy));
      else out.push(0x89 | burn, ...enc14(dx), ...enc14(dy));
    }
    px = x; py = y;
  });
  return out;
}

/** The datagrams to send, in order. */
export function jobDatagrams(plan: RuidaPlan, opts: WriteOptions = {}): Buffer[] {
  return chunkStream(writeJobStream(plan), opts.key ?? DEFAULT_KEY);
}
