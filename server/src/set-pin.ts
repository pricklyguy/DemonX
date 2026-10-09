// Set the access PIN from a terminal (no browser needed, so it works on a headless Raspberry Pi):
//     npm run set-pin             asks for a PIN
//     npm run set-pin -- --open   run without a PIN (browsers on the home network can control the machine)
//     npm run set-pin -- --show   say what is set
// A running DemonX notices the change within a second.
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { AuthStore, AuthError, PIN_MIN } from './auth.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DEMONX_DATA ?? path.resolve(here, '../../data');
const auth = new AuthStore(dataDir);
const arg = process.argv[2];

const describe = () => ({
  pin: 'A PIN is set. Browsers need it to control the machine (the DemonX computer itself does not).',
  open: 'No PIN, by choice: browsers on your home network can control the machine. Run this again to set one.',
  setup: 'No PIN yet. Until one is set, only the browser on the DemonX computer can control the machine.',
}[auth.mode]);

/** Lines piped in (not typed): one reader for the whole run, or the second question would lose lines already read */
let piped: AsyncIterator<string> | undefined;

/** Read one line; hide what is typed when it is a keyboard */
async function ask(question: string): Promise<string> {
  const out = process.stdout;
  out.write(question);
  if (!process.stdin.isTTY) {
    piped ??= readline.createInterface({ input: process.stdin })[Symbol.asyncIterator]();
    const line = (await piped.next()).value ?? '';
    out.write('\n');
    return line;
  }
  return new Promise((resolve) => {
    let text = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n' || c === '\u0004') { process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.off('data', onData); out.write('\n'); resolve(text); return; }
        if (c === '\u0003') { process.stdin.setRawMode(false); out.write('\n'); process.exit(130); }
        if (c === '\u007f' || c === '\b') text = text.slice(0, -1); else text += c;
      }
    };
    process.stdin.on('data', onData);
  });
}

async function main() {
  if (arg === '--show') { console.log(describe()); return; }
  if (arg === '--open') {
    if (auth.mode === 'pin') { console.log('A PIN is already set. To remove it, use Settings, Access in DemonX.'); process.exitCode = 1; return; }
    auth.chooseOpen();
    console.log('Done. DemonX will run without a PIN: browsers on your home network can control the machine.');
    return;
  }
  console.log(describe());
  console.log(`Choose a PIN (at least ${PIN_MIN} characters; letters are fine). Press Enter alone to leave things as they are.`);
  const a = await ask('New PIN: ');
  if (!a) { console.log('Nothing changed.'); return; }
  const b = await ask('Repeat it: ');
  if (a !== b) { console.error('The two PINs are not the same. Nothing changed.'); process.exitCode = 1; return; }
  try {
    const token = auth.setPin(a);
    auth.logout(token);   // the command does not need to stay signed in
    console.log('Done. The PIN is set. Other devices enter it once, and can tick "Remember this device".');
  } catch (e) {
    if (e instanceof AuthError) { console.error(e.message); process.exitCode = 1; return; }
    throw e;
  }
}
void main().then(() => process.exit());
