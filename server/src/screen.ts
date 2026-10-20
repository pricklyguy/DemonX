import fs from 'node:fs';
import path from 'node:path';

// The screen (the built web app) is served from disk by the running server, so Update now never builds into it. It builds into a
// staging folder beside it (web/dist-next), and the staged screen is swapped in by renaming, in the same step that takes the
// controller lock just before the restart. The folders are siblings of the served one: <dir>-next is the staged screen and <dir>-prev
// is the one that was replaced (kept until the next swap, so a swap can be undone).

const STAMP = '.staged.json';
export const stagedDir = (webRoot: string) => `${webRoot}-next`;
const prevDir = (webRoot: string) => `${webRoot}-prev`;
const rm = (d: string) => fs.rmSync(d, { recursive: true, force: true });

/** Write down which DemonX version a staged screen belongs to (so a left-over one is never served with other code) */
export function stampStaged(webRoot: string, version: string) {
  fs.writeFileSync(path.join(stagedDir(webRoot), STAMP), JSON.stringify({ version }));
}

function stagedVersion(webRoot: string): string | null {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(stagedDir(webRoot), STAMP), 'utf8')) as { version?: unknown };
    return typeof j.version === 'string' && fs.existsSync(path.join(stagedDir(webRoot), 'index.html')) ? j.version : null;
  } catch { return null; }
}

/** Delete the staged screen (an update that failed or was never finished) */
export function removeStaged(webRoot: string) { rm(stagedDir(webRoot)); }

/** Put the staged screen in place of the served one. Returns '' when done, else why not (and nothing is changed). */
export function swapIn(webRoot: string): string {
  const next = stagedDir(webRoot), prev = prevDir(webRoot);
  if (!fs.existsSync(path.join(next, 'index.html'))) return 'the new screen was not built (web/dist-next has no index.html)';
  try {
    rm(prev);
    const hadOld = fs.existsSync(webRoot);
    if (hadOld) fs.renameSync(webRoot, prev);
    try { fs.renameSync(next, webRoot); } catch (e) {
      if (hadOld) fs.renameSync(prev, webRoot);   // put the old screen back
      throw e;
    }
    return '';
  } catch (e) { return `the new screen could not be put in place: ${(e as Error).message}`; }
}

/** Undo swapIn: the old screen is served again and the new one is staged again. Returns '' when done. */
export function swapBack(webRoot: string): string {
  const next = stagedDir(webRoot), prev = prevDir(webRoot);
  if (!fs.existsSync(prev)) return 'there is no previous screen to put back';
  try {
    rm(next);
    fs.renameSync(webRoot, next);
    try { fs.renameSync(prev, webRoot); } catch (e) { fs.renameSync(next, webRoot); throw e; }
    return '';
  } catch (e) { return `the previous screen could not be put back: ${(e as Error).message}`; }
}

/**
 * At start: if an update left a staged screen for exactly this version (installed, but DemonX was restarted by hand later), it
 * becomes the served screen; any other staged screen is stale and is deleted. Returns a line for the log, or ''.
 */
export function adoptStaged(webRoot: string, version: string): string {
  if (!fs.existsSync(stagedDir(webRoot))) return '';
  const v = stagedVersion(webRoot);
  if (v === null || !version || v !== version) { removeStaged(webRoot); return 'Removed a left-over staged screen that does not belong to this version.'; }
  const err = swapIn(webRoot);
  return err ? `The staged screen for ${version} could not be used: ${err}` : `Now serving the screen built for ${version}.`;
}
