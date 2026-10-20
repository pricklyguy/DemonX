// The Ruida wire format as seen in captures of LightBurn talking to an RDLC-V1.54.08 controller.
// Pure functions, no I/O. Nothing here has been tried against anything but recorded traffic and the simulator.

/** The scramble key of the owner's controller. Other models use other keys (0x11 on the RDC6334 is reported). */
export const DEFAULT_KEY = 0x88;

export const ACK = 0xcc;
/** Reported by other implementations for a bad checksum; never seen on the wire in our captures. */
export const NAK = 0xcf;

export function scrambleByte(b: number, key = DEFAULT_KEY): number {
  b ^= b >> 7;
  b ^= (b << 7) & 0xff;
  b ^= b >> 7;
  b ^= key;
  return (b + 1) & 0xff;
}

export function unscrambleByte(b: number, key = DEFAULT_KEY): number {
  b = (b - 1) & 0xff;
  b ^= key;
  b ^= b >> 7;
  b ^= (b << 7) & 0xff;
  b ^= b >> 7;
  return b;
}

export const scramble = (data: Uint8Array, key = DEFAULT_KEY): Buffer => Buffer.from(Array.from(data, (b) => scrambleByte(b, key)));
export const unscramble = (data: Uint8Array, key = DEFAULT_KEY): Buffer => Buffer.from(Array.from(data, (b) => unscrambleByte(b, key)));

/** A request datagram: 2-byte checksum (sum of the scrambled bytes, MSB first) then the scrambled bytes. Max 1472 bytes in all. */
export const MAX_DATAGRAM = 1472;
export function buildDatagram(command: Uint8Array, key = DEFAULT_KEY): Buffer {
  const body = scramble(command, key);
  const sum = body.reduce((s, b) => s + b, 0) & 0xffff;
  return Buffer.concat([Buffer.from([sum >> 8, sum & 0xff]), body]);
}

export interface ParsedDatagram { ok: boolean; data: Buffer }
export function parseDatagram(dg: Uint8Array, key = DEFAULT_KEY): ParsedDatagram {
  if (dg.length < 2) return { ok: false, data: Buffer.alloc(0) };
  const body = Buffer.from(dg.subarray(2));
  const sum = body.reduce((s, b) => s + b, 0) & 0xffff;
  return { ok: sum === ((dg[0] << 8) | dg[1]), data: unscramble(body, key) };
}

/** Split a command stream into datagrams of at most `max` bytes (cut anywhere, even inside a command, like LightBurn does). */
export function chunkStream(stream: Uint8Array, key = DEFAULT_KEY, payload = 1000): Buffer[] {
  const out: Buffer[] = [];
  for (let i = 0; i < stream.length; i += payload) out.push(buildDatagram(stream.subarray(i, i + payload), key));
  return out;
}

// ---------- numbers: 7 bits per byte, high bit clear ----------

/** 35-bit value in 5 bytes (micrometres, microseconds/1000 etc.) */
export function enc35(v: number): number[] {
  if (!Number.isInteger(v)) throw new Error('integer expected');
  let n = v < 0 ? v + 2 ** 35 : v;
  const out: number[] = [];
  for (let i = 0; i < 5; i++) { out.unshift(n % 128); n = Math.floor(n / 128); }
  return out;
}
export function dec35(b: ArrayLike<number>, at = 0): number {
  let v = 0;
  for (let i = 0; i < 5; i++) v = v * 128 + b[at + i];
  return v;
}
export function dec35s(b: ArrayLike<number>, at = 0): number {
  const v = dec35(b, at);
  return v >= 2 ** 34 ? v - 2 ** 35 : v;
}
/** 14-bit value in 2 bytes */
export const enc14 = (v: number): number[] => { const n = v < 0 ? v + 16384 : v; return [(n >> 7) & 0x7f, n & 0x7f]; };
export const dec14 = (b: ArrayLike<number>, at = 0): number => (b[at] << 7) | b[at + 1];
export const dec14s = (b: ArrayLike<number>, at = 0): number => { const v = dec14(b, at); return v >= 8192 ? v - 16384 : v; };

/** Relative moves reach at most this far in micrometres (14-bit signed) */
export const REL_MAX = 8191;
export const REL_MIN = -8192;

/** Power in percent to the controller's 14-bit value: 20 % is 3277, 15 % is 2457, 12.5 % is 2048 (checked against LightBurn jobs). */
export const encPower = (pct: number): number[] => enc14(Math.round((pct * 16383) / 100));
export const decPower = (b: ArrayLike<number>, at = 0): number => (dec14(b, at) * 100) / 16383;
/** Speed in millimetres per second to micrometres per second in 5 bytes */
export const encSpeed = (mmPerS: number): number[] => enc35(Math.round(mmPerS * 1000));
export const decSpeed = (b: ArrayLike<number>, at = 0): number => dec35(b, at) / 1000;
export const toUm = (mm: number): number => Math.round(mm * 1000);

// ---------- command lengths ----------
// Every command starts at a byte >= 0x80 and its parameters are all < 0x80. The length of each command is fixed, and a
// datagram can be cut inside one, so a receiver needs the table. Lengths below are those observed in captures; anything
// else is unknown and must be refused by anything that validates a job.
const LEN: Record<string, number> = {
  '88': 11, '89': 5, '8a': 3, '8b': 3, 'a8': 11, 'a9': 5, 'aa': 3, 'ab': 3,
  'c601': 4, 'c602': 4, 'c612': 7, 'c613': 7, 'c621': 4, 'c622': 4, 'c631': 5, 'c632': 5, 'c641': 5, 'c642': 5, 'c650': 4, 'c651': 4,
  'c902': 7, 'c904': 8,
  'ca01': 3, 'ca02': 3, 'ca03': 3, 'ca06': 8, 'ca22': 3, 'ca41': 4,
  'd7': 1, 'd800': 2, 'd801': 2, 'd802': 2, 'd803': 2, 'd812': 2, 'd82e': 2,
  'd902': 8, 'd910': 13, 'da00': 4, 'da01': 14, 'e505': 7,
  'e700': 2, 'e703': 12, 'e704': 16, 'e705': 3, 'e706': 12, 'e707': 12, 'e708': 16, 'e713': 12, 'e717': 12, 'e723': 12, 'e724': 3,
  'e737': 12, 'e738': 3, 'e750': 12, 'e751': 12, 'e752': 13, 'e753': 13, 'e754': 8, 'e755': 8, 'e760': 3, 'e761': 13, 'e762': 13,
  'ea': 2, 'eb': 1, 'f0': 1,
  'f100': 3, 'f101': 3, 'f102': 3, 'f103': 12, 'f200': 3, 'f201': 3, 'f202': 12, 'f203': 12, 'f204': 12, 'f205': 16, 'f206': 12, 'f207': 3,
};
const hex2 = (n: number) => n.toString(16).padStart(2, '0');

/** Length of the command starting at `at`, or `null` when its opcode is not one we know. `0` means "more bytes needed to tell". */
export function commandLength(buf: ArrayLike<number>, at: number, end = buf.length): number | null {
  const a = buf[at];
  if (a === undefined || a < 0x80) return null;
  const one = LEN[hex2(a)];
  if (one !== undefined) return one;
  if (at + 1 >= end) return 0;
  const two = LEN[hex2(a) + hex2(buf[at + 1])];
  return two ?? null;
}

/** Split a complete stream into commands; throws on an opcode that is not in the table or a truncated command. */
export function splitCommands(stream: Uint8Array): Buffer[] {
  const out: Buffer[] = [];
  let i = 0;
  while (i < stream.length) {
    const n = commandLength(stream, i);
    if (n === null) throw new RuidaFormatError(`unknown command ${hex2(stream[i])}${i + 1 < stream.length ? ' ' + hex2(stream[i + 1]) : ''} at byte ${i}`);
    if (n === 0 || i + n > stream.length) throw new RuidaFormatError(`truncated command at byte ${i}`);
    for (let k = 1; k < n; k++) if (stream[i + k] >= 0x80) throw new RuidaFormatError(`bad parameter byte in command at byte ${i}`);
    out.push(Buffer.from(stream.subarray(i, i + n)));
    i += n;
  }
  return out;
}

export class RuidaFormatError extends Error {}
