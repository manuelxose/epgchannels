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
}

export interface ParseResult {
  readonly events: ParsedEvent[];
  readonly rejected: number;
  /** Upstream channel ids with at least one event. */
  readonly channels: string[];
}

const XMLTV_OFFSET = /^([+-])(\d{2})(\d{2})$/;

/**
 * XMLTV timestamps are `YYYYMMDDHHMMSS` in UTC, optionally followed by an
 * offset `+HHMM`. A timestamp without offset is interpreted in the guide's
 * declared time zone, never in the server's local time.
 */
export function parseXmltvDate(raw: string, defaultZone: string): Date | null {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?$/.exec(raw.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute, second, offset] = match;
  const parts = {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
    second: Number(second ?? '0'),
  };
  if (offset) {
    const offsetMatch = XMLTV_OFFSET.exec(offset);
    if (!offsetMatch) return null;
    const sign = offsetMatch[1] === '-' ? -1 : 1;
    const hours = Number(offsetMatch[2]);
    const minutes = Number(offsetMatch[3]);
    const utcMillis = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    return new Date(utcMillis - sign * (hours * 60 + minutes) * 60_000);
  }
  return zonedToUtc(parts, defaultZone);
}

/** Converts a wall-clock time in `zone` to a UTC instant. */
export function zonedToUtc(
  parts: { year: number; month: number; day: number; hour: number; minute: number; second: number },
  zone: string,
): Date | null {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return null;
  }
  // Initial guess, then correct by the observed offset (handles DST).
  let guess = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const rendered = formatter.formatToParts(new Date(guess));
    const get = (type: string): number => Number(rendered.find((part) => part.type === type)?.value ?? '0');
    const asUtc = Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour') % 24,
      get('minute'),
      get('second'),
    );
    const target = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    const delta = target - asUtc;
    if (delta === 0) break;
    guess += delta;
  }
  const result = new Date(guess);
  return Number.isFinite(result.getTime()) ? result : null;
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
    const start = parseXmltvDate(startRaw, defaultZone);
    const end = parseXmltvDate(stopRaw, defaultZone);
    if (!start || !end || end.getTime() <= start.getTime()) {
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
      start,
      end,
      externalKey: `${upstreamChannel}|${start.toISOString()}`,
    });
  }
  return { events, rejected, channels: [...channelIds] };
}

/** JSON shape published by the reference lists: `{ name, events: [{ hi, hf, t, d, g, c }] }`. */
export function parseJsonGuide(payload: unknown): ParseResult {
  const events: ParsedEvent[] = [];
  const channelIds = new Set<string>();
  let rejected = 0;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { events, rejected: 1, channels: [] };
  }
  for (const entry of Object.values(payload as Record<string, unknown>)) {
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
      });
    }
  }
  return { events, rejected, channels: [...channelIds] };
}
