// Command stream -> plan. Strict on purpose: this is what decides that a job may be sent to a machine, so anything that is
// not exactly the shape captured from LightBurn is refused rather than guessed at.
import { dec14s, dec35, dec35s, decPower, decSpeed, splitCommands, RuidaFormatError } from './codec.js';
import type { RuidaLayer, RuidaMode, RuidaPlan, RuidaPoint } from './plan.js';

export interface ParsedJob {
  plan: RuidaPlan;
  /** Sum stored in the job (`E5 05`) and the one computed from its bytes: they must agree */
  fileSum: number;
  expectedSum: number;
  /** The job box from the header, micrometres */
  box: { minX: number; minY: number; maxX: number; maxY: number };
  /** Number of commands */
  commands: number;
}

const fail = (msg: string): never => { throw new RuidaFormatError(msg); };

export function parseJobStream(stream: Uint8Array): ParsedJob {
  const cmds = splitCommands(stream);
  const h = (c: Buffer) => c.toString('hex');
  if (cmds.length < 8) fail('too short to be a job');
  if (h(cmds[0]) !== 'd812' || h(cmds[1]) !== 'f0' || h(cmds[2]) !== 'f10200' || h(cmds[3]) !== 'd800') fail('a job must begin D8 12, F0, F1 02 00, D8 00');
  const n = cmds.length;
  if (h(cmds[n - 1]) !== 'd7') fail('a job must end with D7');
  if (cmds[n - 2][0] !== 0xe5 || cmds[n - 2][1] !== 0x05) fail('a job must end with its file sum (E5 05) and D7');
  const fileSum = dec35(cmds[n - 2], 2);
  let expectedSum = 0xd7;
  for (let i = 0; i < n - 2; i++) for (const b of cmds[i]) expectedSum += b;
  if (fileSum !== expectedSum) fail(`file sum ${fileSum} does not match the job (${expectedSum})`);

  const parts: { speed?: number; min?: number; max?: number; mode?: RuidaMode; color?: number }[] = [];
  const part = (i: number) => (parts[i] ??= {});
  let boxMin: [number, number] | null = null;
  let boxMax: [number, number] | null = null;
  let lastPart = -1;
  const layers: RuidaLayer[] = [];
  let lengthField: number | undefined;
  let layer: RuidaLayer | null = null;
  let layerBodyStarted = false;
  let pendingBody: number | null = null;
  let x = 0, y = 0;
  const addPoint = (nx: number, ny: number, burn: boolean) => {
    if (!layer || !layerBodyStarted) fail('motion outside a layer');
    x = nx; y = ny;
    const p: RuidaPoint = { x: nx / 1000, y: ny / 1000, burn };
    if (layer!.points.length === 0 && burn) fail('a layer must start with a move');
    layer!.points.push(p);
  };

  for (let i = 4; i < n - 2; i++) {
    const c = cmds[i];
    const op = c[0], sub = c[1];
    switch (op) {
      case 0x88: case 0xa8: addPoint(dec35s(c, 1), dec35s(c, 6), op === 0xa8); break;
      case 0x89: case 0xa9: addPoint(x + dec14s(c, 1), y + dec14s(c, 3), op === 0xa9); break;
      case 0x8a: case 0xaa: addPoint(x + dec14s(c, 1), y, op === 0xaa); break;
      case 0x8b: case 0xab: addPoint(x, y + dec14s(c, 1), op === 0xab); break;
      case 0xc9:
        if (sub === 0x04) part(c[2]).speed = decSpeed(c, 3);
        else if (layer) layer.speed = decSpeed(c, 2);
        else fail('speed outside a layer');
        break;
      case 0xc6:
        if (sub === 0x31) part(c[2]).min = decPower(c, 3);
        else if (sub === 0x32) part(c[2]).max = decPower(c, 3);
        else if (sub === 0x01 && layer) layer.minPower = decPower(c, 2);
        else if (sub === 0x02 && layer) layer.maxPower = decPower(c, 2);
        else if (sub === 0x41 || sub === 0x42 || sub === 0x21 || sub === 0x22 || sub === 0x12 || sub === 0x13 || sub === 0x50 || sub === 0x51) {
          // second laser, delays and through-power: all-zero or default in every captured job; nothing here may be non-default
          if (sub === 0x12 || sub === 0x13) { if (!c.subarray(2).every((b) => b === 0)) fail('laser delays other than zero are not supported'); }
          else if (sub === 0x50 || sub === 0x51) { if (c[2] !== 0x00 || c[3] !== 0x01) fail('through-power other than the captured default is not supported'); }
        } else fail('power command outside a layer');
        break;
      case 0xca:
        if (sub === 0x01) {
          const v = c[2];
          if (v === 0x00 || v === 0x01) pendingBody = v;
          else if (v === 0x12 || v === 0x13) { if (!layer) fail('air flag outside a layer'); layer!.air = v === 0x13; }
          else if (v !== 0x30 && v !== 0x10) fail(`unsupported layer command CA 01 ${v.toString(16)}`);
        } else if (sub === 0x02) {
          const idx = c[2];
          if (idx !== layers.length) fail(`layers must come in order (got ${idx}, expected ${layers.length})`);
          const p = parts[idx];
          if (!p || p.speed === undefined || p.min === undefined || p.max === undefined || p.mode === undefined) fail(`layer ${idx} has no header entry`);
          if (pendingBody === null) fail('layer without its mode');
          if ((p!.mode === 'fill' ? 1 : 0) !== pendingBody) fail(`layer ${idx}: header mode and body mode disagree`);
          layer = { colorRaw: p!.color ?? 0, mode: p!.mode!, speed: p!.speed!, minPower: p!.min!, maxPower: p!.max!, air: false, points: [] };
          layers.push(layer);
          layerBodyStarted = false;
        } else if (sub === 0x03) layerBodyStarted = true;
        else if (sub === 0x06) part(c[2]).color = dec35(c, 3);
        else if (sub === 0x22) lastPart = c[2];
        else if (sub === 0x41) {
          if (c[3] === 0x00) part(c[2]).mode = 'line';
          else if (c[3] === 0x02) part(c[2]).mode = 'fill';
          else fail(`layer mode ${c[3]} is not supported`);
        }
        break;
      case 0xda:
        if (sub === 0x01 && c[2] === 0x06 && c[3] === 0x20) { lengthField = dec35(c, 4); if (lengthField !== dec35(c, 9)) fail('length field values differ'); }
        else fail('only the length field may be written inside a job');
        break;
      case 0xe7:
        if (sub === 0x03) boxMin = [dec35s(c, 2), dec35s(c, 7)];
        else if (sub === 0x07) boxMax = [dec35s(c, 2), dec35s(c, 7)];
        else if (sub === 0x06 || sub === 0x04) { if (!c.subarray(sub === 0x04 ? 6 : 2).every((b) => b === 0)) fail('E7 ' + sub + ' has values that are not supported'); }
        break;
      default: break;
    }
  }
  if (!boxMin || !boxMax) return fail('no job box');
  const box = { minX: boxMin[0], minY: boxMin[1], maxX: boxMax[0], maxY: boxMax[1] };
  if (!layers.length) return fail('no layers');
  if (lastPart !== layers.length - 1) fail('layer count does not match the header');
  for (const l of layers) if (!l.points.length) fail('a layer has no motion');
  const plan: RuidaPlan = { layers, lengthField };
  return { plan, fileSum, expectedSum, box, commands: n };
}
