// Version comparison and "which release applies" for the update check. Pure, so both sides and the tests use it.
// Everything that comes from GitHub is untrusted text: parseReleases keeps only what it can validate.

export type UpdateChannel = 'auto' | 'test' | 'stable';

/** The update settings, kept on the server and shared by every browser */
export interface UpdateSettings {
  /** Ask GitHub about new releases (the only thing DemonX sends to the internet by itself) */
  check: boolean;
  /** auto: follow test releases while this install is itself a test release, otherwise stable only */
  channel: UpdateChannel;
  /** A version the owner chose not to be told about; empty when none */
  skipped: string;
  /** Allow the Update button to update this install itself (git installs run by PM2 only). Off until the owner turns it on. */
  apply: boolean;
}
export const defaultUpdateSettings = (): UpdateSettings => ({ check: true, channel: 'auto', skipped: '', apply: false });

/** One release as kept after checking it. Text fields are plain text, never HTML. */
export interface UpdateRelease {
  /** The version without the leading v, e.g. 2.0.0-test.4 */
  version: string;
  /** The git tag, e.g. v2.0.0-test.4 (always v + version) */
  tag: string;
  prerelease: boolean;
  name: string;
  notes: string;
  publishedAt: string;
}

export interface Version { major: number; minor: number; patch: number; pre: (number | string)[] }

const SEMVER = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** Parse a semantic version (a leading v is allowed, build metadata is ignored); null when it is not one */
export function parseVersion(s: unknown): Version | null {
  if (typeof s !== 'string' || s.length > 64) return null;
  const m = SEMVER.exec(s.trim());
  if (!m) return null;
  const nums = [m[1], m[2], m[3]].map(Number);
  if (nums.some((n) => !Number.isSafeInteger(n))) return null;
  const pre = m[4] ? m[4].split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [];
  if (pre.some((p) => typeof p === 'number' && !Number.isSafeInteger(p))) return null;
  return { major: nums[0], minor: nums[1], patch: nums[2], pre };
}

/** Normal form of a valid version (no leading v, no build metadata), or null */
export function cleanVersion(s: unknown): string | null {
  const v = parseVersion(s);
  return v ? `${v.major}.${v.minor}.${v.patch}${v.pre.length ? '-' + v.pre.join('.') : ''}` : null;
}

export const isPrerelease = (v: Version) => v.pre.length > 0;

/** Semantic version order: negative if a is older than b, 0 if equal, positive if newer. A test release is older than the release it leads to. */
export function compareVersions(a: Version, b: Version): number {
  for (const k of ['major', 'minor', 'patch'] as const) if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : 1;
    if (typeof x === 'number') return -1;   // numbers sort before words
    if (typeof y === 'number') return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** Compare two version strings; null if either is not a version */
export function compareVersionStrings(a: string, b: string): number | null {
  const x = parseVersion(a), y = parseVersion(b);
  return x && y ? compareVersions(x, y) : null;
}

const MAX_RELEASES = 30, MAX_NOTES = 6000, MAX_NAME = 120;

/** Plain text only: control characters (other than new lines and tabs) removed, length limited */
export function plainText(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const t = v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, '');
  return t.length > max ? t.slice(0, max).trimEnd() + '\u2026' : t.trim();
}

/**
 * Take what GitHub's releases list answered and keep the releases that can be trusted to be what they claim: an object
 * with a tag that is a semantic version (v1.2.3, v1.2.3-test.4), not a draft. Anything else is dropped, and a
 * malformed answer (not a list) gives null so the caller can keep its last good answer.
 */
export function parseReleases(raw: unknown): UpdateRelease[] | null {
  if (!Array.isArray(raw)) return null;
  const out: UpdateRelease[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    if (o.draft === true) continue;
    const tag = typeof o.tag_name === 'string' ? o.tag_name : '';
    if (!/^v/.test(tag)) continue;           // the project tags releases v<version>
    const version = cleanVersion(tag);
    if (!version || tag !== 'v' + version) continue;
    const v = parseVersion(version)!;
    out.push({
      version, tag, prerelease: o.prerelease === true || isPrerelease(v),
      name: plainText(o.name, MAX_NAME),
      notes: plainText(o.body, MAX_NOTES),
      publishedAt: typeof o.published_at === 'string' && !Number.isNaN(Date.parse(o.published_at)) ? new Date(o.published_at).toISOString() : '',
    });
    if (out.length >= MAX_RELEASES) break;
  }
  return out;
}

/** Does this install follow test releases? */
export function followsTestReleases(channel: UpdateChannel, current: string): boolean {
  if (channel === 'test') return true;
  if (channel === 'stable') return false;
  const v = parseVersion(current);
  return !!v && isPrerelease(v);
}

export interface UpdatePick {
  /** The newest release this install follows (a test release counts only when test releases are followed); null when there is none or the check is off */
  latest: UpdateRelease | null;
  /** latest is newer than the running version */
  newer: boolean;
  /** newer, and it is the skipped version */
  skipped: boolean;
}

/**
 * Which release should this install be told about? The newest one among those it follows. A release that is not newer
 * than the running version is never offered; the skipped version stays out of the badge but is still returned, so Settings can show it.
 */
export function pickUpdate(releases: readonly UpdateRelease[], current: string, settings: UpdateSettings): UpdatePick {
  const none: UpdatePick = { latest: null, newer: false, skipped: false };
  const cur = parseVersion(current);
  if (!settings.check || !cur) return none;
  const tests = followsTestReleases(settings.channel, current);
  let best: { r: UpdateRelease; v: Version } | null = null;
  for (const r of releases) {
    const v = parseVersion(r.version);
    if (!v || (!tests && (r.prerelease || isPrerelease(v)))) continue;
    if (!best || compareVersions(v, best.v) > 0) best = { r, v };
  }
  if (!best) return none;
  const newer = compareVersions(best.v, cur) > 0;
  const skip = parseVersion(settings.skipped);
  return { latest: best.r, newer, skipped: newer && !!skip && compareVersions(skip, best.v) === 0 };
}

/** Where an in-place update (Update now) stands. Only the server changes it. */
export interface UpdateApplyView {
  /** Update now can be used right now; when not, reason says why in words ('' while one is running) */
  available: boolean;
  reason: string;
  state: 'idle' | 'running' | 'waiting' | 'failed' | 'done';
  /** The step in progress, or the one that failed, in words */
  step: string;
  /** The outcome in words (what failed, what was put back, or what was installed) */
  message: string;
  /** The version being installed (or last installed); empty when none */
  target: string;
}
export const emptyApplyView = (): UpdateApplyView => ({ available: false, reason: '', state: 'idle', step: '', message: '', target: '' });

/** What the browsers are told about updates (see server/src/updates.ts) */
export interface UpdateInfo {
  /** The running version, without the build id */
  current: string;
  enabled: boolean;
  checking: boolean;
  /** When the last successful answer arrived (ms since 1970); 0 if never */
  checkedAt: number;
  /** Why the last attempt failed, in words; empty when it worked */
  error: string;
  latest: UpdateRelease | null;
  newer: boolean;
  skipped: boolean;
  /** The release page for latest, on GitHub */
  url: string;
  /** How this install was set up, to show the right way to update */
  install: 'git' | 'windows' | 'docker' | 'other';
  /** Update now (see server/src/updateApply.ts) */
  apply: UpdateApplyView;
}

export const emptyUpdateInfo = (): UpdateInfo => ({ current: '', enabled: true, checking: false, checkedAt: 0, error: '', latest: null, newer: false, skipped: false, url: '', install: 'other', apply: emptyApplyView() });
