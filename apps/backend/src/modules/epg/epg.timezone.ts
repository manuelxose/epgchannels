/**
 * Time-zone normalisation for third-party guides (TDT-API-02FG).
 *
 * A guide's timestamps are wall-clock readings in the *source's* zone, never in
 * the server's. Two shapes exist and both are handled here, once:
 *
 * - XMLTV `YYYYMMDDHHMMSS +HHMM` — absolute, the offset is kept as given;
 * - XMLTV `YYYYMMDDHHMMSS` — wall clock, interpreted in the source's declared
 *   zone, including both daylight-saving transitions;
 * - epoch seconds (the JSON reference guide) — already absolute.
 *
 * `zonedToUtc` is a fixed-point search against `Intl`'s own rendering of the
 * zone, so it uses the platform's real tz database rather than a table we would
 * have to keep correct by hand.
 */

export type ZonedWallClock = {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
};

/** Formatting a date in an unknown zone throws, so validity is a probe. */
export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

const formatterCache = new Map<string, Intl.DateTimeFormat | null>();

function formatterFor(zone: string): Intl.DateTimeFormat | null {
  if (formatterCache.has(zone)) return formatterCache.get(zone) ?? null;
  let formatter: Intl.DateTimeFormat | null;
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
    formatter = null;
  }
  formatterCache.set(zone, formatter);
  return formatter;
}

/** The wall-clock reading of `instant` in `zone`. */
export function wallClockIn(instant: Date, zone: string): ZonedWallClock | null {
  const formatter = formatterFor(zone);
  if (!formatter) return null;
  const get = (type: string): number =>
    Number(formatter.formatToParts(instant).find((part) => part.type === type)?.value ?? '0');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    // `Intl` renders midnight as 24 in some locales; the day boundary wins.
    hour: get('hour') % 24,
    minute: get('minute'),
    second: get('second'),
  };
}

/**
 * Offset of `zone` at `instant`, in minutes east of UTC.
 *
 * `2026-01-15T12:00:00Z` in Europe/Madrid → `60` (CET);
 * `2026-07-15T12:00:00Z` in Europe/Madrid → `120` (CEST).
 */
export function offsetMinutesAt(instant: Date, zone: string): number | null {
  const wall = wallClockIn(instant, zone);
  if (!wall) return null;
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  // Second-resolution wall clock, so drop the instant's own milliseconds.
  return Math.round((asUtc - (instant.getTime() - instant.getMilliseconds())) / 60_000);
}

/**
 * Converts a wall clock in `zone` to a UTC instant.
 *
 * - A wall clock that does not exist (spring forward) resolves to the instant
 *   the clock actually jumps to, which is the reading a person would give it.
 * - A wall clock that happens twice (autumn back) resolves to the **first**
 *   occurrence, deterministically, so re-ingesting the same feed never moves an
 *   emission by an hour between runs.
 */
export function zonedToUtc(parts: ZonedWallClock, zone: string): Date | null {
  if (!formatterFor(zone)) return null;
  const target = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  if (!Number.isFinite(target)) return null;

  // Every zone offset any wall clock near `target` can have (at most two: the
  // offsets either side of a transition).
  const candidates = new Set<number>();
  for (const probeHours of [-36, 0, 36]) {
    const offset = offsetMinutesAt(new Date(target + probeHours * 3_600_000), zone);
    if (offset !== null) candidates.add(offset);
  }

  const exact: number[] = [];
  let skipped: number | null = null;
  for (const offset of candidates) {
    const instant = target - offset * 60_000;
    const wall = wallClockIn(new Date(instant), zone);
    if (!wall) continue;
    const back = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
    if (back === target) exact.push(instant);
  }

  if (exact.length > 0) return new Date(Math.min(...exact));
  // Spring-forward gap: the reading never happened. The clock after the jump is
  // the smallest wall-clock reading greater than the requested one.
  for (let probe = target + 60_000; probe <= target + 4 * 3_600_000; probe += 60_000) {
    for (const offset of candidates) {
      const instant = probe - offset * 60_000;
      const wall = wallClockIn(new Date(instant), zone);
      if (!wall) continue;
      const back = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
      if (back === probe && (skipped === null || instant < skipped)) skipped = instant;
    }
    if (skipped !== null) break;
  }
  if (skipped !== null) return new Date(skipped);
  return new Date(target);
}

const XMLTV_OFFSET = /^([+-])(\d{2})(\d{2})$/;
const XMLTV_LOCAL = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?$/;

/**
 * XMLTV timestamp → instant, plus the zone it was authored in for the audit
 * trail: `UTC` when the feed carried its own offset, the declared zone
 * otherwise.
 */
export function parseXmltvTimestamp(
  raw: string,
  defaultZone: string,
): { instant: Date; zone: string } | null {
  const match = XMLTV_LOCAL.exec(raw.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute, second, offset] = match;
  const parts: ZonedWallClock = {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
    second: Number(second ?? '0'),
  };
  if (offset !== undefined) {
    const parsedOffset = XMLTV_OFFSET.exec(offset);
    if (!parsedOffset) return null;
    const sign = parsedOffset[1] === '-' ? -1 : 1;
    const hours = Number(parsedOffset[2]);
    const minutes = Number(parsedOffset[3]);
    const utcMillis = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    return { instant: new Date(utcMillis - sign * (hours * 60 + minutes) * 60_000), zone: 'UTC' };
  }
  const instant = zonedToUtc(parts, defaultZone);
  return instant === null ? null : { instant, zone: defaultZone };
}
