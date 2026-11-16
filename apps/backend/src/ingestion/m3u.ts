/**
 * M3U / M3U8 playlist parsing — pure, no I/O, never throws.
 *
 * The upstream playlists (iptv-org, Free-TV) are community-maintained and are
 * not always well formed: BOMs, UTF-16 exports, windows-1252 mojibake, nested
 * `#EXTVLCOPT` directives, placeholder lines instead of URLs, commas inside
 * channel names and comma-separated (very long) `x-tvg-url` header values.
 *
 * Contract (MODULE-CONTRACT-02B §3.1): every rejected input line is reported
 * with its 1-based line number and a typed reason; nothing is dropped silently
 * and no input can make a parse throw.
 *
 * This module does *not*: touch the network, read files, resolve anything about
 * a channel's identity, keep `x-tvg-url` values (they are counted, never
 * stored), or follow M3U/M3U8 media-playlist semantics (`#EXT-X-*` tags are
 * treated as comments — an event/stream playlist is parsed as an entry list).
 */

export interface M3uEntry {
  /** 0-based entry ordinal among `#EXTINF` blocks. */
  index: number;
  /** 1-based line of the `#EXTINF`. */
  line: number;
  duration: number | null;
  /** Every `key="value"` attribute of the `#EXTINF`, key case preserved. */
  attributes: Record<string, string>;
  /** Text after the first top-level comma; empty when absent. */
  name: string;
  /** Href line, trimmed. */
  url: string | null;
  urlLine: number | null;
  /** `#EXTVLCOPT` / `#EXTVLCOPT:KEY=v` directives seen for this entry; last wins. */
  directives: Record<string, string>;
  rejected: M3uRejection | null;
}

export type M3uRejection = 'no-url' | 'not-http' | 'missing-name' | 'no-extinf';

/**
 * Additional typed diagnostics (contract extensions): they never replace the
 * four contract reasons on an entry, they only explain a bounded/odd line.
 */
export type M3uDiagnostic = 'attribute-too-long' | 'directive-not-string';

export interface M3uRejectedLine {
  line: number;
  reason: M3uRejection | M3uDiagnostic;
  /** The offending text, bounded to {@link MAX_RAW_BOUND_BYTES} UTF-16 units. */
  raw: string;
}

export interface M3uDiagnosticLine {
  line: number;
  reason: M3uDiagnostic;
  /** The offending text, bounded to {@link MAX_RAW_BOUND_BYTES} UTF-16 units. */
  raw: string;
}

export interface M3uHeader {
  /** Attributes of the `#EXTM3U` line, except the counted-only `x-tvg-url`. */
  attributes: Record<string, string>;
  /** Number of comma-separated guide URLs in `x-tvg-url`; the values are never retained. */
  xTvgUrlCount: number;
  /** True when `x-tvg-url` was present. */
  hasXTvgUrl: boolean;
  /** True when entries were present but no `#EXTM3U` header line was found. */
  missing: boolean;
}

export interface M3uPlaylist {
  header: M3uHeader;
  entries: M3uEntry[];
  rejected: M3uRejectedLine[];
  /** Contract extensions (bounded values, unreadable directives). */
  diagnostics: M3uDiagnosticLine[];
  stats: { lines: number; entries: number; rejectedEntries: number; byeForced: boolean };
}

/** Bounds. A single line longer than this is truncated for parsing. */
export const MAX_LINE_CHARS = 16_384;
/** A `key="value"` value longer than this is dropped (diagnostic `attribute-too-long`). */
export const MAX_ATTRIBUTE_VALUE_CHARS = 2_048;
/** The rejected-line `raw` echo is bounded to this many UTF-16 units. */
export const MAX_RAW_BOUND_BYTES = 512;
/** Input bytes above this are not parsed beyond this offset. */
export const MAX_SNAPSHOT_PLAYLIST_BYTES = 8 * 1024 * 1024;

const BOM_UTF8 = '\uFEFF';
const HTTP_URL = /^https?:\/\//i;
/** Href placeholders used upstream instead of a stream (`[NO PUBLIC STREAM]`). */
const PLACEHOLDER_URL = /^\[\s*(?:no public |not available|n\/a)/i;
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

interface DecodeStep {
  text: string;
  encoding: string;
  validUtf8: boolean;
}

function decodeUtf16(bytes: Uint8Array, littleEndian: boolean, start: number): string {
  const body = bytes.subarray(start);
  const even = body.length - (body.length % 2);
  const swapped = new Uint8Array(even);
  for (let i = 0; i < even; i += 2) {
    const lo = body[littleEndian ? i : i + 1] ?? 0;
    const hi = body[littleEndian ? i + 1 : i] ?? 0;
    swapped[i] = lo;
    swapped[i + 1] = hi;
  }
  return new TextDecoder('utf-16le', { fatal: false }).decode(swapped);
}

/** Strict UTF-8 attempt; returns null when the bytes are not valid UTF-8. */
function tryUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

function decodeWindows1252(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}

function looksUtf16WithoutBom(bytes: Uint8Array): 'le' | 'be' | null {
  const sample = bytes.subarray(0, 64);
  if (sample.length < 4) return null;
  let zeroEven = 0;
  let zeroOdd = 0;
  for (let i = 0; i < sample.length; i += 1) {
    if (sample[i] === 0) {
      if (i % 2 === 0) zeroEven += 1;
      else zeroOdd += 1;
    }
  }
  const half = Math.floor(sample.length / 2);
  if (zeroOdd >= half * 0.8 && zeroEven <= sample.length * 0.05) return 'le';
  if (zeroEven >= half * 0.8 && zeroOdd <= sample.length * 0.05) return 'be';
  return null;
}

function decodeStep(bytes: Uint8Array): DecodeStep {
  if (bytes.length === 0) return { text: '', encoding: 'utf-8', validUtf8: true };
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    const strict = tryUtf8(bytes.subarray(3));
    return strict === null
      ? { text: decodeWindows1252(bytes.subarray(3)), encoding: 'windows-1252', validUtf8: false }
      : { text: strict, encoding: 'utf-8-bom', validUtf8: true };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: decodeUtf16(bytes, true, 2), encoding: 'utf-16le', validUtf8: false };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: decodeUtf16(bytes, false, 2), encoding: 'utf-16be', validUtf8: false };
  }
  const guessed = looksUtf16WithoutBom(bytes);
  if (guessed === 'le') return { text: decodeUtf16(bytes, true, 0), encoding: 'utf-16le', validUtf8: false };
  if (guessed === 'be') return { text: decodeUtf16(bytes, false, 0), encoding: 'utf-16be', validUtf8: false };
  const strict = tryUtf8(bytes);
  if (strict !== null) return { text: strict, encoding: 'utf-8', validUtf8: true };
  return { text: decodeWindows1252(bytes), encoding: 'windows-1252', validUtf8: false };
}

/**
 * Decodes playlist bytes and reports the encoding actually used.
 *
 * Order: UTF-8 BOM → UTF-16 BOM (LE/BE) → BOM-less UTF-16 by NUL pattern →
 * strict UTF-8 → windows-1252. It does not transcode unsupported encodings
 * (e.g. ISO-8859-2) correctly and never throws.
 */
export function decodePlaylistBytes(bytes: Uint8Array): { text: string; encoding: string } {
  let step: DecodeStep;
  try {
    step = decodeStep(bytes);
  } catch {
    let text = '';
    for (const byte of bytes) text += String.fromCharCode(byte);
    return { text, encoding: 'latin1' };
  }
  // A UTF-8 decode can still carry a stray BOM mid-stream (concatenated playlists).
  const text = step.text.split(BOM_UTF8).join('').replace(/\r\n?/g, '\n');
  return { text, encoding: step.encoding };
}

/** Drops a leading BOM and control characters left by a mangled encoding. */
function normaliseLine(raw: string): string {
  const trimmed = raw.replace(/^\uFEFF+/, '');
  return trimmed.replace(CONTROL_CHARS, '');
}

function boundRaw(raw: string): string {
  return raw.length > MAX_RAW_BOUND_BYTES ? `${raw.slice(0, MAX_RAW_BOUND_BYTES)}…` : raw;
}

function parseAttributes(input: string): { attributes: Record<string, string>; dropped: string[] } {
  const attributes: Record<string, string> = Object.create(null) as Record<string, string>;
  const dropped: string[] = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    while (i < n && /\s/.test(input[i] ?? '')) i += 1;
    const keyStart = i;
    while (i < n && !/[\s=]/.test(input[i] ?? '')) i += 1;
    const key = input.slice(keyStart, i);
    if (key === '') {
      i += 1;
      continue;
    }
    while (i < n && /\s/.test(input[i] ?? '')) i += 1;
    if (input[i] !== '=') {
      // Bare attribute (`tvg-id,Name` or `#EXTINF:-1`): recorded as an empty flag.
      attributes[key] = '';
      continue;
    }
    i += 1;
    let value = '';
    if (input[i] === '"') {
      i += 1;
      const valueStart = i;
      while (i < n && input[i] !== '"') i += 1;
      value = input.slice(valueStart, i);
      if (i < n) i += 1; // closing quote
    } else {
      const valueStart = i;
      while (i < n && !/\s/.test(input[i] ?? '')) i += 1;
      value = input.slice(valueStart, i);
    }
    if (value.length > MAX_ATTRIBUTE_VALUE_CHARS) {
      // Never store a value that could bloat the candidate payload.
      attributes[key] = '';
      dropped.push(key);
      continue;
    }
    attributes[key] = value;
  }
  return { attributes, dropped };
}

function applyDirective(
  rawDirective: string,
  directives: Record<string, string>,
  onNonString: () => void,
): void {
  let body = rawDirective;
  // Observed malformed nesting: `http-user-agent=#EXTVLCOPT:http-user-agent=…`.
  // Unwrap the inner directive, keeping `last wins`.
  for (let guard = 0; guard < 4; guard += 1) {
    const inner = /^[A-Za-z0-9_-]+\s*[=:]\s*(?=#EXTVLCOPT\b)/i.exec(body);
    if (inner === null) break;
    body = body.slice(inner[0].length).replace(/^#EXTVLCOPT:?/i, '').trimStart();
  }
  // Junk suffixes glued to the value (`… Chrome/92.0 WOW64`, `11.O`) stay in the
  // value — they are observationally harmless and the value is opaque to us.
  const nameMatch = /^([A-Za-z0-9_-]+)(?=[=:\s]|$)/.exec(body);
  const name = nameMatch?.[1];
  if (name === undefined) {
    onNonString();
    return;
  }
  let rest = body.slice(name.length);
  // `#EXTVLCOPT:key=value` → key `http-referrer`, value `…`; `key:value` is junk form.
  rest = rest.replace(/^[=:]/, '').trim();
  if (rest === '' || rest.startsWith('=')) {
    onNonString();
    return;
  }
  directives[name.toLowerCase()] = rest;
}

/**
 * Parses playlist bytes into entries, rejections and a bounded header.
 *
 * It never throws: malformed UTF-16, unbalanced quotes, absurd line lengths
 * and binary garbage all yield a playlist object. It does not validate that a
 * URL is reachable, distinct, or authorised, and it never retains `x-tvg-url`.
 *
 * Reason vocabulary (contract §3.1 plus typed extensions, all documented here):
 * - `no-extinf`   — a URL line with no preceding `#EXTINF`.
 * - `no-url`      — an `#EXTINF` with no URL line before the next `#EXTINF`.
 * - `not-http`    — the URL is not http(s) (rtsp, rtmp, `[NO PUBLIC STREAM]`, …).
 * - `missing-name`— `#EXTINF` without a name after the comma.
 * - `attribute-too-long` — an attribute value exceeded {@link MAX_ATTRIBUTE_VALUE_CHARS}
 *   and was dropped (the value is never kept).
 * - `directive-not-string` — an `#EXTVLCOPT` body that is not `KEY=VALUE`.
 */
export function parseM3u(bytes: Uint8Array): M3uPlaylist {
  const text = decodePlaylistBytes(bytes).text;
  return parsePlaylistText(text);
}

/**
 * Text variant of {@link parseM3u}; same guarantees, no byte decoding.
 * It does not normalise encodings (call {@link decodePlaylistBytes} first).
 */
export function parsePlaylistText(text: string): M3uPlaylist {
  const lines = text.split('\n');
  const entries: M3uEntry[] = [];
  const rejected: M3uRejectedLine[] = [];
  const diagnostics: M3uDiagnosticLine[] = [];
  const header: M3uHeader = { attributes: {}, xTvgUrlCount: 0, hasXTvgUrl: false, missing: false };
  let headerSeen = false;
  let linesScanned = 0;
  let headerMissing = false;
  let current: M3uEntry | null = null;
  /** The `#EXTINF` text of the open entry, echoed by its `no-url` rejection. */
  let openExtinfLine = '';
  /** Directives that precede the next `#EXTINF` (the observed upstream order). */
  const pendingDirectives: Record<string, string> = {};

  const reject = (line: number, reason: M3uRejection, raw: string): void => {
    rejected.push({ line, reason, raw: boundRaw(raw) });
  };

  const diagnose = (line: number, reason: M3uDiagnostic, raw: string): void => {
    diagnostics.push({ line, reason, raw: boundRaw(raw) });
  };

  const finish = (entry: M3uEntry, extinfLine: string): void => {
    if (entry.url === null) {
      entry.rejected = 'no-url';
      reject(entry.line, 'no-url', extinfLine);
    }
    entries.push(entry);
    current = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    let line = lines[index] ?? '';
    linesScanned = lineNumber;
    if (line.length > MAX_LINE_CHARS) line = line.slice(0, MAX_LINE_CHARS);
    // Trim the trimmed-away head's edges only: a BOM glued to the header and a
    // CR from CRLF must not leak into values; inner spaces are meaningful.
    line = normaliseLine(line).replace(/^[ \t]+|[ \t]+$/g, '');
    if (line === '') continue;

    if (/^#EXTM3U(?:\s|$)/i.test(line)) {
      headerSeen = true;
      const body = line.replace(/^#EXTM3U/i, '').trim();
      parseHeaderAttributes(body, header);
      continue;
    }

    if (/^#EXTINF\b/i.test(line)) {
      if (current !== null) finish(current, openExtinfLine);
      openExtinfLine = line;
      const rest = line.replace(/^#EXTINF/i, '');
      let i = 0;
      while (i < rest.length && /\s/.test(rest[i] ?? '')) i += 1;
      if (rest[i] === ':') i += 1;
      const metadataStart = i;
      let inQuotes = false;
      let commaAt = -1;
      for (; i < rest.length; i += 1) {
        const char = rest[i];
        if (char === '"') inQuotes = !inQuotes;
        else if (char === ',' && !inQuotes) {
          commaAt = i;
          break;
        }
      }
      const metadata = commaAt === -1 ? rest.slice(metadataStart) : rest.slice(metadataStart, commaAt);
      const name = commaAt === -1 ? '' : rest.slice(commaAt + 1).trim();
      let duration: number | null = null;
      let attributeSource = metadata;
      const durationMatch = /^([+-]?\d+(?:\.\d+)?)\s*(.*)$/s.exec(metadata);
      if (durationMatch !== null) {
        const parsed = Number(durationMatch[1]);
        duration = Number.isFinite(parsed) ? parsed : null;
        attributeSource = durationMatch[2] ?? '';
      }
      const { attributes, dropped } = parseAttributes(`${attributeSource} `);
      // A placeholder href (`[NO PUBLIC STREAM]`) still names the roster line;
      // keep the `tvg-name` as the entry name so the candidate is not nameless.
      const nextHref = (lines[index + 1] ?? '').trim();
      const effectiveName = name === '' && PLACEHOLDER_URL.test(nextHref) ? (attributes['tvg-name'] ?? '').trim() : name;
      const directives: Record<string, string> = {};
      for (const [key, value] of Object.entries(pendingDirectives)) {
        directives[key] = value;
        delete pendingDirectives[key];
      }
      current = {
        index: entries.length,
        line: lineNumber,
        duration,
        attributes,
        name: effectiveName,
        url: null,
        urlLine: null,
        directives,
        rejected: null,
      };
      for (const key of dropped) diagnose(lineNumber, 'attribute-too-long', `${key}=…`);
      if (name === '') current.rejected = 'missing-name';
      if (name === '' && effectiveName === '') reject(lineNumber, 'missing-name', line);
      continue;
    }

    if (/^#EXTVLCOPT\b/i.test(line)) {
      const rawDirective = line.replace(/^#EXTVLCOPT/i, '').trim().replace(/^:/, '');
      let nonString = false;
      // Upstream writes directives *before* their `#EXTINF` (iptv-org) or after
      // it; either way they belong to the entry and last wins.
      applyDirective(rawDirective, current === null ? pendingDirectives : current.directives, () => {
        nonString = true;
      });
      if (nonString) diagnose(lineNumber, 'directive-not-string', line);
      continue;
    }

    if (line.startsWith('#')) {
      if (!headerSeen) headerMissing = true; // a tag before any `#EXTM3U`
      continue;
    }
    if (!headerSeen) headerMissing = true;

    // Href line.
    if (current === null) {
      reject(lineNumber, 'no-extinf', line);
      const orphan: M3uEntry = {
        index: entries.length,
        line: lineNumber,
        duration: null,
        attributes: {},
        name: '',
        url: line,
        urlLine: lineNumber,
        directives: {},
        rejected: 'no-extinf',
      };
      entries.push(orphan);
      continue;
    }
    current.url = line;
    current.urlLine = lineNumber;
    if (!HTTP_URL.test(line)) {
      current.rejected = 'not-http';
      reject(lineNumber, 'not-http', line);
    }
    finish(current, line);
  }
  if (current !== null) finish(current, openExtinfLine);
  header.missing = headerMissing && entries.length > 0;

  return {
    header,
    entries,
    rejected,
    diagnostics,
    stats: {
      lines: linesScanned,
      entries: entries.length,
      rejectedEntries: rejected.length,
      byeForced: false,
    },
  };
}

/** Splits header attributes, counting (never storing) the comma-separated `x-tvg-url`. */
function parseHeaderAttributes(body: string, header: M3uHeader): void {
  let i = 0;
  const n = body.length;
  while (i < n) {
    while (i < n && /\s/.test(body[i] ?? '')) i += 1;
    const keyStart = i;
    while (i < n && !/[\s=]/.test(body[i] ?? '')) i += 1;
    const key = body.slice(keyStart, i);
    if (key === '') {
      i += 1;
      continue;
    }
    while (i < n && /\s/.test(body[i] ?? '')) i += 1;
    if (body[i] !== '=') {
      header.attributes[key] = '';
      continue;
    }
    i += 1;
    let value = '';
    if (body[i] === '"') {
      i += 1;
      const valueStart = i;
      while (i < n && body[i] !== '"') i += 1;
      value = body.slice(valueStart, i);
      if (i < n) i += 1;
    } else {
      const valueStart = i;
      while (i < n && !/\s/.test(body[i] ?? '')) i += 1;
      value = body.slice(valueStart, i);
    }
    if (key.toLowerCase() === 'x-tvg-url') {
      header.hasXTvgUrl = true;
      header.xTvgUrlCount = value
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part !== '').length;
      continue; // never stored
    }
    if (value.length > MAX_ATTRIBUTE_VALUE_CHARS) continue;
    header.attributes[key] = value;
  }
}
