/**
 * HLS/DASH recognition and bounded parsing.
 *
 * The parser answers exactly one question — "is this a coherent manifest of the
 * declared format, and what shape does it have?" — and it answers it with
 * **structured facts only**. It never returns the playlist text: a playlist can
 * carry tokenized URLs, and a health row must not become a place where a token
 * is stored (hard rule 7, D-015). The only thing derived from the bytes that
 * survives is a SHA-256 of the first 4 KiB and a handful of counts.
 *
 * Bounds are part of the contract, not a suggestion: at most 200 KiB is looked
 * at, and a body larger than that is reported as truncated rather than parsed.
 */
import { createHash } from 'node:crypto';
import type { ManifestFactsSummary } from './health.schema.js';

/** Never look at more than this many bytes of a manifest. */
export const MAX_MANIFEST_PARSE_BYTES = 200 * 1024;
/** Size of the digest window that identifies a manifest across runs. */
export const MANIFEST_DIGEST_WINDOW_BYTES = 4 * 1024;

export type ManifestFormat = 'hls-master' | 'hls-media' | 'dash';

export interface ParseManifestOptions {
  /**
   * Format the source declares. `null` means "infer from content-type alone" —
   * used when the caller wants recognition rather than validation.
   */
  readonly expected: 'hls' | 'dash' | null;
}

export type ManifestParse =
  | {
      readonly ok: true;
      readonly facts: ManifestFactsSummary;
      /** Nothing here is playlist text: variant/segment *counts* only. */
      readonly truncated: boolean;
    }
  | {
      readonly ok: false;
      /** `invalid-manifest`: the body is not a manifest of the expected format. */
      readonly reason: 'invalid-manifest';
      readonly detail: string;
      readonly truncated: boolean;
    }
  | {
      readonly ok: false;
      /** `unsupported-format`: the body is not a manifest at all (e.g. HTML). */
      readonly reason: 'unsupported-format';
      readonly detail: string;
      readonly truncated: boolean;
    };

/** MIME types we accept as HLS / DASH declarations. */
const HLS_MIME = new Set([
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'audio/mpegurl',
  'audio/x-mpegurl',
  'application/mpegurl',
  'vnd.apple.mpegurl',
]);
const DASH_MIME = new Set(['application/dash+xml', 'application/dash-patch+xml']);

function mimeOf(contentType: string | null): string {
  if (contentType === null) return '';
  return contentType.split(';')[0]?.trim().toLowerCase() ?? '';
}

export function isHlsMime(contentType: string | null): boolean {
  return HLS_MIME.has(mimeOf(contentType));
}

export function isDashMime(contentType: string | null): boolean {
  return DASH_MIME.has(mimeOf(contentType));
}

/**
 * Whether a declared playback type needs an HLS/DASH manifest at all.
 * `youtube`, `official-embed` and `external` are embed/link integrations: we do
 * not fetch third-party manifests for them, and pretending to would be the
 * generic-proxy evasion the contract forbids.
 */
export function requiresManifest(type: string): type is 'hls' | 'dash' {
  return type === 'hls' || type === 'dash';
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** First non-empty line, trimmed, with a UTF-8 BOM tolerated. */
function firstLine(text: string): string {
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (const line of withoutBom.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed !== '') return trimmed;
  }
  return '';
}

interface HlsScan {
  variants: number;
  segments: number;
  mediaSequence: number | null;
  targetDuration: number | null;
  endList: boolean;
  discontinuity: number;
}

/**
 * Counts HLS tags without keeping any of their values except the two numbers we
 * report. Attribute values (URLs, keys) are never captured.
 */
function scanHls(lines: readonly string[]): HlsScan {
  const scan: HlsScan = {
    variants: 0,
    segments: 0,
    mediaSequence: null,
    targetDuration: null,
    endList: false,
    discontinuity: 0,
  };
  let pendingExtinf = false;
  let pendingVariant = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') continue;
    if (line.startsWith('#')) {
      if (line.startsWith('#EXT-X-STREAM-INF')) {
        scan.variants += 1;
        pendingVariant = true;
      } else if (line.startsWith('#EXTINF')) pendingExtinf = true;
      else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE')) scan.mediaSequence = leadingInt(line);
      else if (line.startsWith('#EXT-X-TARGETDURATION')) scan.targetDuration = leadingInt(line);
      else if (line === '#EXT-X-ENDLIST') scan.endList = true;
      else if (line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE')) scan.discontinuity += 1;
      continue;
    }
    /*
     * A non-comment line is a URI. Only its *role* is counted, never the URI:
     * after `#EXTINF` it is a segment, after `#EXT-X-STREAM-INF` it is the
     * variant (already counted by the tag). Anything else is not a media entry.
     */
    if (pendingExtinf) {
      scan.segments += 1;
      pendingExtinf = false;
      pendingVariant = false;
    } else if (pendingVariant) {
      pendingVariant = false;
    }
  }
  return scan;
}

function leadingInt(line: string): number | null {
  const colon = line.indexOf(':');
  if (colon === -1) return null;
  const value = Number.parseInt(line.slice(colon + 1).trim(), 10);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** Bounded DASH checks: a real MPD root element and a period. */
function scanDash(text: string): { ok: boolean; detail: string } {
  const head = text.slice(0, 8 * 1024);
  if (!/<MPD[\s>]/i.test(head)) return { ok: false, detail: 'no <MPD> root element in first 8 KiB' };
  if (!/<Period[\s>]/i.test(text)) return { ok: false, detail: 'no <Period> element: an MPD without a period describes nothing to play' };
  return { ok: true, detail: '' };
}

/**
 * Parses a manifest body into structured facts.
 *
 * Fails closed: anything that is not provably a manifest of the declared format
 * returns `ok: false` with the category the validator should record.
 */
export function parseManifest(body: string, contentType: string | null, options: ParseManifestOptions): ManifestParse {
  const mime = mimeOf(contentType);
  const declaredDash = options.expected === 'dash' || (options.expected === null && DASH_MIME.has(mime));
  const raw = Buffer.from(body, 'utf8');
  const truncated = raw.byteLength > MAX_MANIFEST_PARSE_BYTES;
  const bounded = truncated ? raw.subarray(0, MAX_MANIFEST_PARSE_BYTES) : raw;
  const text = bounded.toString('utf8');
  const digest = sha256Hex(raw.subarray(0, MANIFEST_DIGEST_WINDOW_BYTES));
  const parsedBytes = bounded.byteLength;

  if (declaredDash) {
    const dash = scanDash(text);
    if (!dash.ok) {
      return {
        ok: false,
        reason: mime.length === 0 || DASH_MIME.has(mime) ? 'invalid-manifest' : 'unsupported-format',
        detail: dash.detail,
        truncated,
      };
    }
    return {
      ok: true,
      truncated,
      facts: {
        format: 'dash',
        mimeType: mime,
        startsWithExtM3u: false,
        mediaSequence: null,
        segmentCount: 0,
        variantCount: 0,
        targetDuration: null,
        endsWithEndList: false,
        first4KiBSha256: digest,
        parsedBytes,
      },
    };
  }

  const first = firstLine(text);
  if (first !== '#EXTM3U') {
    /*
     * A body whose own header is not `#EXTM3U` is not an HLS playlist. When the
     * served MIME *declares* HLS, the origin served a broken manifest, which is
     * `invalid-manifest`. When neither the header nor the MIME says HLS, nothing
     * about the response says "manifest", so it is `unsupported-format`.
     */
    const mimeSaysHls = isHlsMime(contentType);
    return {
      ok: false,
      reason: mimeSaysHls ? 'invalid-manifest' : 'unsupported-format',
      detail:
        first === ''
          ? 'empty body: no #EXTM3U header'
          : `first line is not #EXTM3U (${first.slice(0, 40).replace(/[^\x20-\x7e]/g, '?')})`,
      truncated,
    };
  }

  const scan = scanHls(text.split(/\r?\n/));
  const isMaster = scan.variants > 0;
  if (!isMaster && scan.segments === 0) {
    // Header present but no variant and no segment: an empty playlist. It is a
    // well-formed header carrying nothing to play, so it is `invalid-manifest`
    // (the validator never calls it healthy from 200 + header alone).
    return {
      ok: false,
      reason: 'invalid-manifest',
      detail: 'no #EXT-X-STREAM-INF variant and no #EXTINF segment',
      truncated,
    };
  }

  return {
    ok: true,
    truncated,
    facts: {
      format: isMaster ? 'hls-master' : 'hls-media',
      mimeType: mime,
      startsWithExtM3u: true,
      mediaSequence: scan.mediaSequence,
      segmentCount: isMaster ? 0 : scan.segments,
      variantCount: scan.variants,
      targetDuration: scan.targetDuration,
      endsWithEndList: scan.endList,
      first4KiBSha256: digest,
      parsedBytes,
    },
  };
}

/**
 * Resolves a playlist-relative URI against the manifest's own final URL.
 *
 * Returns `null` for anything that is not an `http(s)` absolute result — a
 * `data:` or `file:` reference inside a playlist is not something this platform
 * follows. The resolved URL is used for a bounded probe and is redacted before
 * it is ever written to a row.
 */
export function resolvePlaylistUri(baseUrl: string, uri: string): string | null {
  try {
    const resolved = new URL(uri.trim(), baseUrl);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
    return resolved.toString();
  } catch {
    return null;
  }
}

/**
 * Extracts at most `limit` variant and segment URIs for sampling.
 *
 * The returned list is bounded and is only used to build probe requests: it is
 * never persisted. `limit` is the segment sample size (default 2, contract §4).
 */
export function samplePlaylistUris(
  body: string,
  baseUrl: string,
  limit: number,
): { readonly variants: readonly string[]; readonly segments: readonly string[] } {
  const text = body.slice(0, MAX_MANIFEST_PARSE_BYTES);
  const variants: string[] = [];
  const segments: string[] = [];
  let expectVariant = false;
  let expectSegment = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    if (line.startsWith('#')) {
      if (line.startsWith('#EXT-X-STREAM-INF')) expectVariant = true;
      else if (line.startsWith('#EXTINF')) expectSegment = true;
      continue;
    }
    const resolved = resolvePlaylistUri(baseUrl, line);
    if (expectVariant) {
      if (resolved !== null && variants.length < limit) variants.push(resolved);
      expectVariant = false;
      continue;
    }
    if (expectSegment) {
      if (resolved !== null && segments.length < limit) segments.push(resolved);
      expectSegment = false;
      continue;
    }
  }
  return { variants, segments };
}
