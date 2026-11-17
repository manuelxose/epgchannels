/**
 * Guide formats we can ingest, normalised to our own programme model.
 *
 * Two parsers, both pure and both strict about what they accept:
 *
 * - `xmltv`: the documented XMLTV subset (`<programme start stop channel>` with
 *   `<title>`, `<desc>`, `<category>`, `<icon>`) in a *configured time zone*.
 * - `json-tdtchannels`: the JSON shape published by the reference list, whose
 *   timestamps are absolute epoch seconds and therefore time-zone free.
 *
 * Neither parser invents an emission: anything that cannot be read completely is
 * counted as rejected, never repaired with placeholder data.
 */
import { parseXmltvTimestamp, zonedToUtc, type ZonedWallClock } from './epg.timezone.js';

// The previous release exported `zonedToUtc` from here; the implementation now
// lives with the rest of the zone handling, and the name keeps working.
export { zonedToUtc };

export interface ParsedEvent {
  /** Upstream channel identifier (the join key for reconciliation). */
  readonly upstreamChannel: string;
  readonly title: string;
  readonly description: string;
  readonly genre: string | null;
  readonly coverUrl: string | null;
  readonly start: Date;
  readonly end: Date;
  readonly externalKey: string;
  /** Zone the upstream timestamp was written in (`UTC` when it had an offset). */
  readonly timezone: string;
  /**
   * Instant before normalisation, kept for audit when the source zone differs
   * from the channel's own zone. Equal to `start` for absolute timestamps.
   */
  readonly originalStart: Date;
}

export interface ParseResult {
  readonly events: ParsedEvent[];
  readonly rejected: number;
  /** Upstream channel ids with at least one event. */
  readonly channels: string[];
}

/**
 * XMLTV timestamps are `YYYYMMDDHHMMSS` in UTC, optionally followed by an
 * offset `+HHMM`. A timestamp without offset is interpreted in the guide's
 * declared time zone, never in the server's local time.
 *
 * Daylight saving is handled by `epg.timezone.ts`: an ambiguous reading (the
 * hour that happens twice in autumn) always resolves to its first occurrence.
 */
export function parseXmltvDate(raw: string, defaultZone: string): Date | null {
  return parseXmltvTimestamp(raw, defaultZone)?.instant ?? null;
}

/** Converts a wall-clock time in `zone` to a UTC instant (re-exported). */
export function zonedToUtcWallClock(parts: ZonedWallClock, zone: string): Date | null {
  return zonedToUtc(parts, zone);
}

/** Minimal XML scanning without a permissive dependency: only the subset we use. */
function decodeXmlText(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&')
    .trim();
}

function attribute(attrs: string, name: string): string | null {
  const match = new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(attrs);
  if (match?.[1] !== undefined) return match[1];
  const single = new RegExp(`${name}\\s*=\\s*'([^']*)'`).exec(attrs);
  return single?.[1] ?? null;
}

function firstChild(block: string, tag: string): string | null {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`).exec(block);
  return match?.[1] !== undefined ? decodeXmlText(match[1]) : null;
}

function iconSrc(block: string): string | null {
  const match = /<icon\b([^>]*)\/?>/.exec(block);
  if (!match?.[1]) return null;
  const src = attribute(match[1], 'src');
  return src && /^https?:\/\//.test(src) ? src : null;
}

export function parseXmltv(xml: string, defaultZone: string): ParseResult {
  const events: ParsedEvent[] = [];
  let rejected = 0;
  const programmePattern = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/g;
  const channelIds = new Set<string>();
  for (const match of xml.matchAll(programmePattern)) {
    const attrs = match[1] ?? '';
    const body = match[2] ?? '';
    const upstreamChannel = attribute(attrs, 'channel');
    const startRaw = attribute(attrs, 'start');
    const stopRaw = attribute(attrs, 'stop');
    const title = firstChild(body, 'title');
    if (!upstreamChannel || !startRaw || !stopRaw || !title) {
      rejected += 1;
      continue;
    }
    const start = parseXmltvTimestamp(startRaw, defaultZone);
    const end = parseXmltvTimestamp(stopRaw, defaultZone);
    if (!start || !end || end.instant.getTime() <= start.instant.getTime()) {
      rejected += 1;
      continue;
    }
    channelIds.add(upstreamChannel);
    events.push({
      upstreamChannel,
      title,
      description: firstChild(body, 'desc') ?? '',
      genre: firstChild(body, 'category'),
      coverUrl: iconSrc(body),
      start: start.instant,
      end: end.instant,
      externalKey: `${upstreamChannel}|${start.instant.toISOString()}`,
      timezone: start.zone,
      originalStart: start.instant,
    });
  }
  return { events, rejected, channels: [...channelIds] };
}

/**
 * JSON guide: `{ name, events: [{ hi, hf, t, d, g, c }] }`, published both as an
 * object keyed by a numeric index and as an array of the same entries. Both
 * shapes are accepted; the join key is always the entry's own `name`.
 */
export function parseJsonGuide(payload: unknown): ParseResult {
  const events: ParsedEvent[] = [];
  const channelIds = new Set<string>();
  let rejected = 0;
  const entries: unknown[] = Array.isArray(payload)
    ? payload
    : typeof payload === 'object' && payload !== null
      ? Object.values(payload as Record<string, unknown>)
      : [];
  if (entries.length === 0) {
    return { events, rejected: 1, channels: [] };
  }
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) {
      rejected += 1;
      continue;
    }
    const record = entry as Record<string, unknown>;
    const upstreamChannel = typeof record['name'] === 'string' ? record['name'].trim() : '';
    const list = record['events'];
    if (!upstreamChannel || !Array.isArray(list)) {
      rejected += 1;
      continue;
    }
    for (const raw of list) {
      if (typeof raw !== 'object' || raw === null) {
        rejected += 1;
        continue;
      }
      const event = raw as Record<string, unknown>;
      const start = typeof event['hi'] === 'number' ? event['hi'] : Number(event['hi']);
      const end = typeof event['hf'] === 'number' ? event['hf'] : Number(event['hf']);
      const title = typeof event['t'] === 'string' ? event['t'].trim() : '';
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !title) {
        rejected += 1;
        continue;
      }
      channelIds.add(upstreamChannel);
      const cover = typeof event['c'] === 'string' && /^https?:\/\//.test(event['c']) ? event['c'] : null;
      events.push({
        upstreamChannel,
        title,
        description: typeof event['d'] === 'string' ? event['d'] : '',
        genre: typeof event['g'] === 'string' ? event['g'] : null,
        coverUrl: cover,
        start: new Date(start * 1000),
        end: new Date(end * 1000),
        externalKey: `${upstreamChannel}|${start}`,
        // Epoch seconds are absolute: the reference guide is time-zone free.
        timezone: 'UTC',
        originalStart: new Date(start * 1000),
      });
    }
  }
  return { events, rejected, channels: [...channelIds] };
}
