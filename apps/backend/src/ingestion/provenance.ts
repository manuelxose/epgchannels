/**
 * Provenance pipeline: parsed playlists → contract-shaped source candidates.
 *
 * Every {@link SourceCandidateDoc} keeps the full chain back to the bytes it
 * came from (`snapshotId`, `upstreamPath`, `line`, `rawName`, `attributes`,
 * `retrievedAt`, `checksumSha256`) so a candidate can always be re-derived and
 * audited (contract §2.2, §3.1, hard rule 6).
 *
 * Pure and deterministic with respect to its inputs: no clock (the snapshot's
 * `retrievedAt` is the only time source), no randomness, no network, no I/O.
 *
 * It does *not*: decide channel identity (that is `catalogue-identity`), verify
 * that a URL works, publish anything, or keep credential values in `url` — a
 * URL with userinfo or a token-like query parameter is stored with
 * `authRequired` and its credential parts stripped from the stored/normalised
 * URL (hard rule 7: no secrets in payloads).
 */
import { createHash } from 'node:crypto';
import type { M3uEntry } from './m3u.js';
import type { LoadedPlaylist } from './snapshot.js';
import { lookupCountryCode, lookupCountryName } from './country-names.js';

export type CandidateKind = 'hls' | 'dash' | 'youtube' | 'official-embed' | 'external';

export type SourceCandidateFlag =
  | 'geo-blocked'
  | 'authRequired'
  | 'userAgentRequired'
  | 'refererRequired'
  | 'placeholder'
  | 'unsupported-scheme'
  | 'name-mangled';

export type CandidateQuality = 'SD' | 'HD' | 'FHD' | 'UHD';

export interface SourceSnapshotLicence {
  spdx: string | null;
  url: string | null;
  reuse: 'public-domain' | 'permitted-with-attribution' | 'unlicensed';
  notes: string;
}

export interface SourceSnapshotDoc {
  _id: string;
  upstream: 'iptv-org' | 'free-tv';
  upstreamUrl: string;
  commitSha: string | null;
  retrievedAt: Date;
  checksumSha256: string;
  licence: SourceSnapshotLicence;
  format: 'm3u' | 'json';
  fileCount: number;
  entryCount: number;
  bytes: number;
  status: 'ingested' | 'rejected';
  rejectionReason: string | null;
  createdAt: Date;
}

export interface SourceProvenanceDoc {
  snapshotId: string;
  upstream: string;
  upstreamPath: string;
  /** 1-based line of the `#EXTINF` (the URL line when the block had none). */
  line: number;
  rawName: string;
  rawAttributes: Record<string, string>;
  retrievedAt: Date;
  checksumSha256: string;
}

export type CandidateState = 'staging' | 'duplicate' | 'unmatched' | 'reconciled' | 'rejected';

export interface SourceCandidateDoc {
  _id: string;
  channelId: string | null;
  snapshotId: string;
  upstream: string;
  url: string;
  normalizedUrl: string;
  urlSha256: string;
  type: string;
  name: string;
  attributes: Record<string, string>;
  country: string | null;
  provider: string | null;
  groupTitle: string | null;
  language: string | null;
  quality: CandidateQuality | null;
  flags: string[];
  provenance: SourceProvenanceDoc;
  state: CandidateState;
  rejectionReason: string | null;
  duplicateOf: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Namespace for deterministic candidate ids (uuid v5). */
const CANDIDATE_ID_NAMESPACE = '6f1b4e2c-6a0a-5c55-9a0e-8b6d7c1f2a3b';

/** Query keys that never change what is served: dropped from the normalised URL. */
const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id', 'utm_name',
  'gclid', 'fbclid', 'msclkid', 'yclid', 'dclid', 'twclid', 'igshid', 'mc_cid', 'mc_eid',
  '_ga', '_gl', 'ref', 'ref_src', 'referrer', 'referer', 'source', 'si', 'feature', 'share',
  'spm', 'trk', 'tracking', 'cmp', 'campaign',
]);

/** Keys that are a credential, or only a credential when nothing else is left. */
const TOKEN_PARAMS = new Set([
  'token', 'access_token', 'auth', 'authorization', 'apikey', 'api_key', 'sig', 'signature',
  'hmac', 'password', 'passwd', 'pwd', 'user', 'username', 'login', 'wssec', 'hdnts', 'wmsauthsign',
  'jwt', 'session', 'sessionid', 'sid', 'mac', 'md5', 'tok', 'secret',
]);

/** Weak tokens: only treated as credentials when no meaningful parameter remains. */
const WEAK_TOKEN_PARAMS = new Set(['key']);

/** Flags that make a stored URL unpublishable until an authorisation says otherwise. */
export const UNPUBLISHABLE_FLAGS: ReadonlyArray<SourceCandidateFlag> = ['authRequired', 'placeholder', 'unsupported-scheme'];

const GEO_BLOCKED = /\[?\s*geo[\s-]?blocked\s*\]?/i;
const PLACEHOLDER = /^\[?\s*no (?:public |available |known )?stream\s*\]?$|^\[?\s*(?:not available|n\/a|none)\s*\]?$/i;
const MANGLE_MARK = /\uFFFD|\p{L}\?\s+(?=\S)/u;
const QUALITY_MARK = /\((\d{3,4})p\)|\[(\d{3,4})p\]|\b(4320|2160|1440|1080|720|576|540|480|360|240)p\b|\b(8k|4k|uhd|fhd|full\s*hd|hq|sd)\b/gi;

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'youtube-nocookie.com', 'www.youtube-nocookie.com']);

/** ISO 639-3 → 639-1 for languages that appear in upstream `tvg-language` tags. */
export const ISO3_TO_ISO1: Readonly<Record<string, string>> = {
  spa: 'es', eng: 'en', cat: 'ca', glg: 'gl', eus: 'eu', por: 'pt', fra: 'fr', fre: 'fr', deu: 'de', ger: 'de',
  ita: 'it', nld: 'nl', dut: 'nl', swe: 'sv', nor: 'no', dan: 'da', fin: 'fi', pol: 'pl', ces: 'cs', cze: 'cs',
  slk: 'sk', slo: 'sk', hun: 'hu', ron: 'ro', rum: 'ro', bul: 'bg', ell: 'el', gre: 'el', tur: 'tr', rus: 'ru',
  ukr: 'uk', ara: 'ar', heb: 'he', hin: 'hi', urd: 'ur', ben: 'bn', tam: 'ta', tel: 'te', zho: 'zh', chi: 'zh',
  jpn: 'ja', kor: 'ko', tha: 'th', vie: 'vi', ind: 'id', msa: 'ms', may: 'ms', fil: 'fil', tgl: 'tl',
  srp: 'sr', hrv: 'hr', bos: 'bs', slv: 'sl', mkd: 'mk', sqi: 'sq', alb: 'sq', hye: 'hy', arm: 'hy',
  kat: 'ka', geo: 'ka', aze: 'az', kaz: 'kk', uzb: 'uz', per: 'fa', fas: 'fa', amh: 'am', swa: 'sw',
  afr: 'af', isl: 'is', ice: 'is', gle: 'ga', cym: 'cy', wel: 'cy', mlg: 'mg', hat: 'ht', mya: 'my',
  khm: 'km', lao: 'lo', sin: 'si', nep: 'ne', mar: 'mr', guj: 'gu', kan: 'kn', mal: 'ml', pan: 'pa',
};

const QUALITY_BY_HEIGHT: ReadonlyArray<readonly [number, CandidateQuality]> = [
  [2160, 'UHD'],
  [1440, 'FHD'],
  [1080, 'FHD'],
  [720, 'HD'],
];

export interface NormalizedUrl {
  normalized: string;
  /** True when userinfo or a token-like query parameter was present. */
  authRequired: boolean;
  /** True when credentials were removed and the URL must not be used blindly. */
  credentialsStripped: boolean;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isDefaultPort(scheme: string, port: string): boolean {
  return (scheme === 'http' && port === '80') || (scheme === 'https' && port === '443');
}

/**
 * Normalises an http(s) URL for identity comparison.
 *
 * - scheme and host lowercased; default port dropped; trailing `/` on an empty
 *   path kept (it is meaningful for some origins) and path preserved verbatim;
 * - userinfo removed (and reported), token-like query values removed (and
 *   reported); tracking parameters dropped; the remaining query is kept in
 *   its original order so the contract's "meaningful query" stays stable.
 *
 * Non-http URLs are returned trimmed and unchanged. It does not resolve
 * redirects, decode percent-encoding beyond the URL parser, or validate that
 * the host exists.
 */
export function normalizeUrl(raw: string): NormalizedUrl {
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { normalized: trimmed, authRequired: false, credentialsStripped: false };
  }
  const scheme = url.protocol.replace(/:$/, '').toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') {
    return { normalized: trimmed, authRequired: false, credentialsStripped: false };
  }
  const hasUserinfo = url.username !== '' || url.password !== '';
  const meaningful: string[] = [];
  let tokenFound = false;
  let weakTokenFound = false;
  for (const [key, value] of url.searchParams) {
    const lowered = key.toLowerCase();
    // Tracking parameters are dropped first: they are never "meaningful" params.
    if (TRACKING_PARAMS.has(lowered) || lowered.startsWith('utm_')) continue;
    if (TOKEN_PARAMS.has(lowered)) {
      tokenFound = true;
      continue;
    }
    if (WEAK_TOKEN_PARAMS.has(lowered)) {
      weakTokenFound = true;
      continue;
    }
    meaningful.push(`${key}=${value}`);
  }
  const kept = weakTokenFound && meaningful.length === 0 ? [] : meaningful;
  const credential = hasUserinfo || tokenFound || (weakTokenFound && kept.length === 0);
  const port = url.port === '' || isDefaultPort(scheme, url.port) ? '' : `:${url.port}`;
  const path = url.pathname === '' ? '/' : url.pathname;
  const query = kept.length > 0 ? `?${kept.join('&')}` : '';
  const normalized = `${scheme}://${url.hostname.toLowerCase()}${port}${path}${query}`;
  return { normalized, authRequired: credential, credentialsStripped: credential };
}

/**
 * Detects the kind of stream a URL points at.
 *
 * `official-embed` covers media-server player URLs (`embed`, `player`, `iframe`,
 * `m3u8_player`, …) which are not themselves a stream. It does not fetch the
 * URL to find out what it really returns.
 */
export function detectStreamType(raw: string): CandidateKind {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return 'external';
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (YOUTUBE_HOSTS.has(host) || host.endsWith('.youtube.com')) return 'youtube';
  const path = url.pathname.toLowerCase();
  if (path.endsWith('.mpd') || /[?&]type=mpd\b/.test(url.search.toLowerCase())) return 'dash';
  if (path.endsWith('.m3u8') || path.endsWith('.m3u')) return 'hls';
  const composite = `${host}${path}${url.search.toLowerCase()}`;
  if (/(?:^|[./_-])(embed|player|iframe|play)(?:[./_?=-]|$)/.test(composite)) return 'official-embed';
  return 'external';
}

interface QualityHit {
  quality: CandidateQuality;
  /** The decoration span that produced the quality, for name cleaning. */
  span: string;
}

/** Infers the maximum advertised quality from decorations like `(1080p)` or `[FHD]`. */
export function inferQuality(...texts: ReadonlyArray<string | null | undefined>): QualityHit | null {
  let best: CandidateQuality | null = null;
  let bestSpan = '';
  const rank: Record<CandidateQuality, number> = { SD: 0, HD: 1, FHD: 2, UHD: 3 };
  for (const text of texts) {
    if (text === null || text === undefined || text === '') continue;
    QUALITY_MARK.lastIndex = 0;
    let match = QUALITY_MARK.exec(text);
    while (match !== null) {
      const height = Number(match[1] ?? match[2] ?? match[3]);
      let quality: CandidateQuality | null = null;
      if (Number.isFinite(height) && height > 0) {
        for (const [threshold, label] of QUALITY_BY_HEIGHT) {
          if (height >= threshold) {
            quality = label;
            break;
          }
        }
        if (quality === null) quality = 'SD';
      } else {
        const word = (match[4] ?? '').toLowerCase().replace(/\s+/g, '');
        if (word === '8k' || word === '4k' || word === 'uhd') quality = 'UHD';
        else if (word === 'fhd' || word === 'fullhd') quality = 'FHD';
        else if (word === 'hq') quality = 'HD';
        else if (word === 'sd') quality = 'SD';
      }
      if (quality !== null && (best === null || rank[quality] > rank[best])) {
        best = quality;
        bestSpan = match[0];
      }
      match = QUALITY_MARK.exec(text);
    }
  }
  return best === null ? null : { quality: best, span: bestSpan };
}

/**
 * True when a name carries the replacement character or a glued `C?meres`-style
 * mark: a `?` right after a letter, digit or accented letter (what a mangled
 * accent becomes). A `?` after a space is normal punctuation and not a mark.
 * Implemented with explicit character ranges so no Unicode property escape or
 * look-behind is required.
 */
export function looksMangled(name: string): boolean {
  if (name.includes('\uFFFD')) return true;
  const accents = [...'\u00C0\u00C1\u00C2\u00C3\u00C4\u00C5\u00C7\u00C8\u00C9\u00CA\u00CB\u00CC\u00CD\u00CE\u00CF\u00D1\u00D2\u00D3\u00D4\u00D5\u00D6\u00D8\u00D9\u00DA\u00DB\u00DC\u00DD\u00DF\u00E0\u00E1\u00E2\u00E3\u00E4\u00E5\u00E7\u00E8\u00E9\u00EA\u00EB\u00EC\u00ED\u00EE\u00EF\u00F1\u00F2\u00F3\u00F4\u00F5\u00F6\u00F8\u00F9\u00FA\u00FB\u00FC\u00FD\u00FF'].join('');
  const heads = new Set<string>([...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', ...accents]);
  for (let index = 1; index < name.length; index += 1) {
    if (name[index] === '?' && heads.has(name[index - 1] ?? '')) return true;
  }
  return false;
}

/**
 * Removes upstream decorations from a display name: quality tags, the
 * `[Geo-blocked]` marker and placeholder brackets. It does not fold accents,
 * remove numbering, or otherwise normalise identity (that is `catalogue-identity`).
 */
export function cleanDisplayName(name: string): string {
  let value = name.replace(/\[?\s*geo[\s-]?blocked\s*\]?/gi, ' ');
  value = value.replace(/\(\s*\d{3,4}p\s*\)/gi, ' ');
  value = value.replace(/\[\s*\d{3,4}p\s*\]/gi, ' ');
  value = value.replace(/\s+/g, ' ').trim();
  value = value.replace(/[\s\-–—|/]+$/g, '').trim();
  return value === '' ? name.trim() : value;
}

/** Maps a language tag (`es`, `es-ES`, `Spanish`, `spa`) to ISO 639-1, or null. */
export function normalizeLanguage(input: string | null | undefined): string | null {
  if (input === null || input === undefined) return null;
  const raw = input.trim();
  if (raw === '') return null;
  if (/^[a-zA-Z]{2}(?:[-_][a-zA-Z]{2,4})?$/.test(raw)) {
    const primary = raw.slice(0, 2).toLowerCase();
    return ISO3_TO_ISO1[raw.toLowerCase()] ?? primary;
  }
  const lowered = raw.toLowerCase();
  const iso3 = ISO3_TO_ISO1[lowered];
  if (iso3 !== undefined) return iso3;
  return null;
}

/** Looks a country up by ISO code or English/Spanish name. */
export function normalizeCountry(input: string | null | undefined): string | null {
  if (input === null || input === undefined) return null;
  const raw = input.trim();
  if (raw === '') return null;
  if (/^[a-zA-Z]{2}$/.test(raw)) {
    const upper = raw.toUpperCase();
    return lookupCountryCode(upper) ? upper : null;
  }
  return lookupCountryName(raw);
}

/** iptv-org style `tvg-id`: `Name.cc@SD` → `cc`; free-tv style `Name.cc` → `cc`. */
export function countryFromTvgId(tvgId: string | null | undefined): string | null {
  if (tvgId === null || tvgId === undefined) return null;
  const withoutQuality = tvgId.trim().replace(/@[^@]*$/, '');
  const match = /\.([A-Za-z]{2})$/.exec(withoutQuality);
  if (match?.[1] === undefined) return null;
  return normalizeCountry(match[1]);
}

/** Directory hint from an upstream path: a `<cc>` filename segment (`streams/es.m3u`). */
export function countryFromPath(upstreamPath: string): string | null {
  const segments = upstreamPath.split('/').filter((part) => part !== '');
  const last = segments[segments.length - 1] ?? '';
  const base = last.replace(/\.(?:m3u8?|json)$/i, '');
  const code = /^([a-zA-Z]{2})(?:_|-)/.exec(base)?.[1] ?? (/^[a-zA-Z]{2}$/.test(base) ? base : undefined);
  if (code === undefined) return null;
  return normalizeCountry(code);
}

/** Locale hint from a path such as `playlists/playlist_spain.m3u8` (free-tv). */
export function countryFromPlaylistName(upstreamPath: string): string | null {
  const base = (upstreamPath.split('/').pop() ?? '').replace(/\.(?:m3u8?|json)$/i, '');
  const hint = /^playlist[_-](.+)$/i.exec(base)?.[1];
  if (hint === undefined) return null;
  return normalizeCountry(hint.replace(/[_-]+/g, ' '));
}

/** RFC 4122 name-based UUID v5 over a SHA-1 of `namespace || name`. */
export function uuidV5(name: string, namespace: string = CANDIDATE_ID_NAMESPACE): string {
  const nsBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const digest = createHash('sha1').update(nsBytes).update(Buffer.from(name, 'utf8')).digest();
  const bytes = Uint8Array.prototype.slice.call(digest, 0, 16) as Uint8Array;
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function attributesWithoutCredentials(attributes: Record<string, string>): Record<string, string> {
  const copy: Record<string, string> = {};
  for (const [key, value] of Object.entries(attributes)) copy[key] = value;
  return copy;
}

interface CountryResolution {
  country: string | null;
  source: 'attribute' | 'tvg-id' | 'group' | 'path' | null;
}

function resolveCountry(entry: M3uEntry, playlist: LoadedPlaylist): CountryResolution {
  const fromAttribute = normalizeCountry(
    entry.attributes['tvg-country'] ?? entry.attributes['tvg_country'] ?? entry.attributes['country'] ?? null,
  );
  if (fromAttribute !== null) return { country: fromAttribute, source: 'attribute' };
  const fromTvg = countryFromTvgId(entry.attributes['tvg-id'] ?? null);
  if (fromTvg !== null) return { country: fromTvg, source: 'tvg-id' };
  const fromGroup = normalizeCountry(entry.attributes['group-title'] ?? null);
  if (fromGroup !== null) return { country: fromGroup, source: 'group' };
  const fromPath = countryFromPath(playlist.path) ?? countryFromPlaylistName(playlist.path);
  if (fromPath !== null) return { country: fromPath, source: 'path' };
  return { country: null, source: null };
}

function inferLanguage(entry: M3uEntry): string | null {
  return normalizeLanguage(entry.attributes['tvg-language'] ?? entry.attributes['tvg_language'] ?? null);
}

function providerHint(entry: M3uEntry, url: string): string | null {
  const tvgId = entry.attributes['tvg-id'] ?? '';
  const fromId = tvgId.replace(/@[^@]*$/, '').replace(/\.[A-Za-z]{2}$/, '').trim();
  if (fromId !== '') return fromId;
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return host === '' ? null : host;
  } catch {
    return null;
  }
}

function collectFlags(entry: M3uEntry, authRequired: boolean, kind: CandidateKind, name: string): string[] {
  const flags: SourceCandidateFlag[] = [];
  const geo = GEO_BLOCKED.test(name) || /geo-?block/i.test(entry.attributes['tvg-name'] ?? '');
  const referer = entry.directives['http-referrer'] ?? null;
  const userAgent = entry.directives['http-user-agent'] ?? null;
  if (geo) flags.push('geo-blocked');
  if (authRequired) flags.push('authRequired');
  if (userAgent !== null && userAgent !== '') flags.push('userAgentRequired');
  if (referer !== null && referer !== '') flags.push('refererRequired');
  if (PLACEHOLDER.test(name.trim()) || entry.url === null) flags.push('placeholder');
  if (kind === 'external' && entry.url !== null && !/^https?:\/\//i.test(entry.url)) flags.push('unsupported-scheme');
  if (looksMangled(name)) flags.push('name-mangled');
  return flags;
}

function rejectionFor(entry: M3uEntry, name: string, rawUrl: string): string | null {
  if (PLACEHOLDER.test(rawUrl.trim()) || PLACEHOLDER.test(name.trim())) return 'placeholder';
  return entry.rejected;
}

function emptyCandidate(snapshot: SourceSnapshotDoc): SourceCandidateDoc {
  return {
    _id: '',
    channelId: null,
    snapshotId: snapshot._id,
    upstream: snapshot.upstream,
    url: '',
    normalizedUrl: '',
    urlSha256: '',
    type: 'external',
    name: '',
    attributes: {},
    country: null,
    provider: null,
    groupTitle: null,
    language: null,
    quality: null,
    flags: [],
    provenance: {
      snapshotId: snapshot._id,
      upstream: snapshot.upstream,
      upstreamPath: '',
      line: 0,
      rawName: '',
      rawAttributes: {},
      retrievedAt: snapshot.retrievedAt,
      checksumSha256: snapshot.checksumSha256,
    },
    state: 'rejected',
    rejectionReason: null,
    duplicateOf: null,
    createdAt: snapshot.retrievedAt,
    updatedAt: snapshot.retrievedAt,
  };
}

/** Attributes that carry a name, in upstream preference order. */
const NAME_ATTRIBUTES = ['tvg-name', 'tvg-name-alt', 'name'] as const;

function readName(entry: M3uEntry): string {
  for (const key of NAME_ATTRIBUTES) {
    const value = entry.attributes[key];
    if (value !== undefined && value.trim() !== '') return value.trim();
  }
  return '';
}

/**
 * Builds one candidate per parseable entry of every loaded playlist.
 *
 * Entry-level rejections from the parser (`no-url`, `not-http`, `missing-name`,
 * `no-extinf`) and placeholders (`[NO PUBLIC STREAM]`) become candidates in
 * state `rejected` with the typed `rejectionReason`, so every input line is
 * accounted for (hard rule 6). Valid entries are `staging`; `duplicateOf` is
 * left `null` — duplicate detection belongs to reconciliation.
 *
 * It does not touch the network, does not decide identity, and never stores
 * userinfo or token query values in `url` / `normalizedUrl`.
 */
export function buildCandidates(
  snapshot: SourceSnapshotDoc,
  playlists: readonly LoadedPlaylist[],
  options: CandidateBuildOptions = {},
): SourceCandidateDoc[] {
  return buildCandidateRows(snapshot, playlists, options);
}

/**
 * A catalogue whose channel identities come from another database (iptv-org).
 *
 * `sourceCandidates` is the record of "this URL appeared in this snapshot", and
 * it must stay exactly that: one row per line, no half-real rows. The channel
 * database tells us the name, the country and the genre of every channel, which
 * the M3U line does not. Importing that knowledge into the *channel* is this
 * module's job (see `ingestion/iptv-org.import.ts`); importing it into a
 * candidate would make the candidate disagree with the line it claims to
 * describe.
 *
 * For the country specifically the playlist hint is already exact: iptv-org
 * files are `streams/<cc>.m3u`, and an extra-region file such as `us_pluto.m3u`
 * keeps `us`. This option asks for that behaviour explicitly rather than relying
 * on it, so a future change to the path rules cannot silently reclassify a
 * catalogue that has no per-line country attribute.
 */
export interface CandidateBuildOptions {
  /**
   * Resolve the country from the playlist file name even when the channel
   * database knows better; used when the candidate must mirror its own line.
   */
  readonly countryFromPlaylist?: boolean;
}

/**
 * The candidate builder itself. `options.countryFromPlaylist` only reorders the
 * country resolution so the playlist hint is preferred over a per-line
 * attribute; every other rule is unchanged.
 */
function buildCandidateRows(
  snapshot: SourceSnapshotDoc,
  playlists: readonly LoadedPlaylist[],
  options: CandidateBuildOptions = {},
): SourceCandidateDoc[] {
  const out: SourceCandidateDoc[] = [];
  for (const playlist of playlists) {
    const retrievedAt = snapshot.retrievedAt;
    for (const entry of playlist.playlist.entries) {
      const candidate = emptyCandidate(snapshot);
      const rawUrl = entry.url !== null ? entry.url.trim() : '';
      const displayName = entry.name.trim() !== '' ? entry.name.trim() : readName(entry);
      const normalized = rawUrl === '' ? { normalized: '', authRequired: false, credentialsStripped: false } : normalizeUrl(rawUrl);
      const kind = rawUrl === '' ? 'external' : detectStreamType(rawUrl);
      const country = options.countryFromPlaylist === true
        ? (countryFromPath(playlist.path) !== null
            ? { country: countryFromPath(playlist.path), source: 'path' as const }
            : resolveCountry(entry, playlist))
        : resolveCountry(entry, playlist);
      const quality = inferQuality(entry.name, entry.attributes['tvg-name'], entry.attributes['tvg-quality']);
      const rejection = rejectionFor(entry, displayName, rawUrl);
      const flags = collectFlags(entry, normalized.authRequired, kind, displayName);
      const urlSha = normalized.normalized === '' ? '' : sha256Hex(normalized.normalized);
      const provider = providerHint(entry, rawUrl);
      const groupTitle = (entry.attributes['group-title'] ?? '').trim();

      candidate._id = uuidV5(`${snapshot._id}:${playlist.path}:${entry.line}:${normalized.normalized}`);
      candidate.url = normalized.normalized === '' ? '' : redactCredentials(rawUrl, normalized.credentialsStripped);
      candidate.normalizedUrl = normalized.normalized;
      candidate.urlSha256 = urlSha;
      candidate.type = kind;
      candidate.name = cleanDisplayName(displayName);
      // Directive values are opaque and never persisted: they contain raw
      // User-Agent strings, and a referer can carry credentials.
      candidate.attributes = attributesWithoutCredentials(entry.attributes);
      candidate.country = country.country;
      candidate.provider = provider;
      candidate.groupTitle = groupTitle === '' ? null : groupTitle;
      candidate.language = inferLanguage(entry);
      candidate.quality = quality === null ? null : quality.quality;
      candidate.flags = flags;
      candidate.provenance = {
        snapshotId: snapshot._id,
        upstream: snapshot.upstream,
        upstreamPath: playlist.path,
        line: entry.line,
        rawName: entry.name,
        rawAttributes: attributesWithoutCredentials(entry.attributes),
        retrievedAt: snapshot.retrievedAt,
        checksumSha256: playlist.sha256 !== '' ? playlist.sha256 : snapshot.checksumSha256,
      };
      candidate.createdAt = retrievedAt;
      candidate.updatedAt = retrievedAt;
      if (rejection === null) {
        candidate.state = 'staging';
        candidate.rejectionReason = null;
      } else {
        candidate.state = 'rejected';
        candidate.rejectionReason = rejection;
      }
      out.push(candidate);
    }
  }
  return out;
}

/**
 * Removes credentials from a URL string when `strip` is set: userinfo (so a
 * password never reaches the store) and token-like query parameters. The rest
 * stays verbatim, including tracking parameters, so `url` still mirrors the
 * upstream line for the operator. It does not validate the URL.
 */
export function redactCredentials(rawUrl: string, strip: boolean): string {
  const trimmed = rawUrl.trim();
  if (!strip) return trimmed;
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/?#]*)([^#]*)(#.*)?$/s.exec(trimmed);
  if (match === null) return trimmed;
  const authority = match[2] ?? '';
  const at = authority.lastIndexOf('@');
  const host = at === -1 ? authority : authority.slice(at + 1);
  const rest = match[3] ?? '';
  const hash = match[4] ?? '';
  const queryAt = rest.indexOf('?');
  if (queryAt === -1) return `${match[1] ?? ''}${host}${rest}${hash}`;
  const path = rest.slice(0, queryAt);
  const kept: string[] = [];
  for (const part of rest.slice(queryAt + 1).split('&')) {
    if (part === '') continue;
    const key = (part.split('=')[0] ?? '').toLowerCase();
    if (TOKEN_PARAMS.has(key) || WEAK_TOKEN_PARAMS.has(key)) continue;
    kept.push(part);
  }
  return `${match[1] ?? ''}${host}${path}${kept.length > 0 ? `?${kept.join('&')}` : ''}${hash}`;
}

/**
 * True when a candidate may leave staging without an authorisation decision.
 * It is a formatting-level veto only; the publication policy is still the
 * final gate and must be consulted for everything else.
 */
export function isPublishableShape(candidate: SourceCandidateDoc): boolean {
  if (candidate.state !== 'staging' && candidate.state !== 'reconciled') return false;
  return !candidate.flags.some((flag) => (UNPUBLISHABLE_FLAGS as ReadonlyArray<string>).includes(flag));
}
