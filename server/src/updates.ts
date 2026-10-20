import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { emptyApplyView, emptyUpdateInfo, parseReleases, pickUpdate, type UpdateApplyView, type UpdateInfo, type UpdateRelease, type UpdateSettings } from '../../shared/updates.js';

// The update check: ask GitHub's public releases list (no token) at start and about once a day, remember the answer in
// the data folder (update.json) so it survives a restart and a failed check never clears it, and work out which release,
// if any, this install should be told about. Nothing is downloaded or run: this only reads a list of release notes.
// Everything in the answer is untrusted text (see shared/updates.ts). A failed check is quiet: it is kept as a short
// reason shown in Settings > Updates, never written to the Console.

export const RELEASES_URL = 'https://api.github.com/repos/pricklyguy/DemonX/releases?per_page=30';
/** The release page for a tag; built here from a validated tag, never taken from the answer */
export const releasePageUrl = (tag: string) => `https://github.com/pricklyguy/DemonX/releases/tag/${encodeURIComponent(tag)}`;

const HOUR = 3_600_000, DAY = 24 * HOUR;
const MAX_BODY = 2_000_000;
const TIMEOUT_MS = 15_000;

/** A reason worth showing as it is; any other failure is reported as "could not reach GitHub" */
class CheckError extends Error {}

type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;

interface Saved { checkedAt: number; attemptedAt: number; nextAt: number; error: string; releases: UpdateRelease[] }

export interface UpdateOptions {
  /** The running version as in package.json, e.g. 2.0.0-test.3 */
  current: string;
  settings: () => UpdateSettings;
  install: UpdateInfo['install'];
  /** Where Update now stands (server/src/updateApply.ts) */
  apply?: () => UpdateApplyView;
  dataDir?: string;
  /** Injected in tests: no real network there */
  fetch?: FetchLike;
  url?: string;
  now?: () => number;
}

/** Read a response body, giving up when it is bigger than it should be */
async function readCapped(res: Response, max: number): Promise<string> {
  const len = Number(res.headers.get('content-length'));
  if (Number.isFinite(len) && len > max) throw new CheckError('the answer was too large');
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) { await reader.cancel().catch(() => {}); throw new CheckError('the answer was too large'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export class UpdateChecker extends EventEmitter {
  private saved: Saved = { checkedAt: 0, attemptedAt: 0, nextAt: 0, error: '', releases: [] };
  private file?: string;
  private running: Promise<void> | null = null;
  private lastSent = '';
  private timer?: NodeJS.Timeout;
  private readonly fetchFn: FetchLike;
  private readonly now: () => number;

  constructor(private readonly o: UpdateOptions) {
    super();
    this.fetchFn = o.fetch ?? ((url, init) => fetch(url, init));
    this.now = o.now ?? Date.now;
    if (!o.dataDir) return;
    this.file = path.join(o.dataDir, 'update.json');
    try {
      fs.mkdirSync(o.dataDir, { recursive: true });
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, unknown>;
      const t = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
      this.saved = {
        checkedAt: t(j.checkedAt), attemptedAt: t(j.attemptedAt), nextAt: t(j.nextAt),
        error: typeof j.error === 'string' ? j.error.slice(0, 200) : '',
        // read again with the same checks as an answer from GitHub: a hand-edited file cannot add anything odd
        releases: parseReleases(Array.isArray(j.releases) ? j.releases.map((r: Partial<UpdateRelease> | null) => ({ tag_name: r?.tag, name: r?.name, body: r?.notes, prerelease: r?.prerelease, published_at: r?.publishedAt })) : null) ?? [],
      };
    } catch { /* no file yet, or unreadable: start empty */ }
  }

  /** The release on offer (newer than the running one, check on), without building the whole view. Update now asks this: view() asks Update now, so going through view() would never end. */
  offered(): UpdateRelease | null {
    const s = this.o.settings();
    const pick = pickUpdate(this.saved.releases, this.o.current, s);
    return s.check && pick.newer ? pick.latest : null;
  }

  /** What browsers are told */
  view(): UpdateInfo {
    const s = this.o.settings();
    const pick = pickUpdate(this.saved.releases, this.o.current, s);
    return {
      ...emptyUpdateInfo(), current: this.o.current, enabled: s.check, checking: this.running !== null,
      checkedAt: this.saved.checkedAt, error: this.saved.error, install: this.o.install, apply: this.o.apply?.() ?? emptyApplyView(),
      latest: pick.latest, newer: pick.newer, skipped: pick.skipped, url: pick.latest ? releasePageUrl(pick.latest.tag) : '',
    };
  }

  /** Check now and then about once a day. The first check is a little after start, unless one was tried in the last hour. */
  start() {
    this.stop();
    const first = () => this.due();
    setTimeout(first, 3000).unref();
    this.timer = setInterval(first, HOUR);
    this.timer.unref();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  private due() {
    if (!this.o.settings().check) return;
    const t = this.now();
    if (t < this.saved.nextAt) return;
    if (t - this.saved.attemptedAt < HOUR) return;
    if (this.saved.error === '' && t - this.saved.checkedAt < DAY) return;
    void this.check();
  }

  /** The settings changed: tell the browsers, and look straight away when checking was just turned on */
  settingsChanged() {
    this.notify();
    this.due();
  }

  /** Tell the browsers, unless nothing about the update changed (any setting of DemonX comes through here) */
  notify() {
    const v = this.view(), j = JSON.stringify(v);
    if (j === this.lastSent) return;
    this.lastSent = j;
    this.emit('update', v);
  }

  /** Ask GitHub now. Never throws; the outcome is in view(). */
  check(): Promise<void> {
    if (this.running) return this.running;
    if (!this.o.settings().check) return Promise.resolve();   // turned off: nothing is sent, whoever asks
    this.running = this.run().finally(() => { this.running = null; this.notify(); });
    this.notify();
    return this.running;
  }

  private async run() {
    const t0 = this.now();
    let error = '', nextAt = 0;
    try {
      const ctl = new AbortController();
      const kill = setTimeout(() => ctl.abort(), TIMEOUT_MS);
      let res: Response;
      try {
        res = await this.fetchFn(this.o.url ?? RELEASES_URL, { headers: { accept: 'application/vnd.github+json', 'user-agent': `DemonX/${this.o.current}`, 'x-github-api-version': '2022-11-28' }, signal: ctl.signal });
        if (!res.ok) {
          const num = (h: string) => { const v = res.headers.get(h); return v === null || v.trim() === '' ? NaN : Number(v); };
          const remaining = res.headers.get('x-ratelimit-remaining'), reset = num('x-ratelimit-reset'), retry = num('retry-after');
          if (res.status === 429 || (res.status === 403 && (remaining === '0' || Number.isFinite(retry)))) {
            // rate limited: wait until GitHub says (at least an hour, at most a day)
            const wait = Number.isFinite(retry) && retry > 0 ? retry * 1000 : Number.isFinite(reset) && reset > 0 ? reset * 1000 - t0 : HOUR;
            nextAt = t0 + Math.min(DAY, Math.max(HOUR, wait));
            throw new CheckError('GitHub is limiting requests from this network right now; it will try again later');
          }
          throw new CheckError(res.status === 404 ? 'GitHub has no release list at that address' : `GitHub answered ${res.status}`);
        }
        const text = await readCapped(res, MAX_BODY);
        let raw: unknown;
        try { raw = JSON.parse(text); } catch { throw new CheckError('GitHub answered something that was not a release list'); }
        const releases = parseReleases(raw);
        if (!releases) throw new CheckError('GitHub answered something that was not a release list');
        this.saved = { checkedAt: this.now(), attemptedAt: t0, nextAt: 0, error: '', releases };
        this.write();
        return;
      } finally { clearTimeout(kill); }
    } catch (e) {
      error = e instanceof CheckError ? e.message : (e as Error)?.name === 'AbortError' ? 'GitHub did not answer in time' : 'Could not reach GitHub (no internet?)';
    }
    // a failed check keeps the last answer
    this.saved = { ...this.saved, attemptedAt: t0, nextAt, error };
    this.write();
  }

  private write() {
    if (!this.file) return;
    try {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.saved, null, 2));
      fs.renameSync(tmp, this.file);
    } catch { /* the answer is still held in memory */ }
  }
}
