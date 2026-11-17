/**
 * Calendar days in a named time zone.
 *
 * A guide day is a *local* day: `2026-11-16` in `Europe/Madrid` starts at
 * 23:00Z the evening before in winter and at 22:00Z in summer. Computing the
 * window in UTC would be wrong twice a year and silently shift a whole day's
 * programming, so the window is derived from the zone itself with `Intl`, which
 * knows the real offset rules (including DST and zones that skip a date).
 *
 * Nothing here guesses: an unknown zone is reported as an error so the caller can
 * answer 400 instead of pretending it understood the request.
 */
import { z } from 'zod';
import { isoTimestampSchema } from '@tdt/contracts';

/**
 * `/channels/:slug/epg` query.
 *
 * Two mutually exclusive ways to name the window:
 *
 * - `date=YYYY-MM-DD` — one complete local day in `timezone` (default: the
 *   channel's own zone);
 * - `from=<ISO instant>` + `hours=1..72` — an explicit window in UTC.
 *
 * Additive to the published contracts, which cover the discovery axes and the
 * availability aggregate but not this endpoint.
 */
export const epgDayQuerySchema = z
  .object({
    /** Local calendar date in the channel's own zone (`YYYY-MM-DD`). */
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Se espera una fecha AAAA-MM-DD.')
      .optional(),
    /** IANA zone to read `date` in; defaults to the channel's zone. */
    timezone: z.string().min(3).max(64).optional(),
    /** Start instant (ISO-8601). */
    from: isoTimestampSchema.optional(),
    /** Hours from `from`; ignored when `date` is given. */
    hours: z.coerce.number().int().min(1).max(72).default(24),
  })
  .refine((value) => !(value.date !== undefined && value.from !== undefined), {
    message: 'Usa `date` o `from`, no ambos.',
    path: ['date'],
  });
export type EpgDayQuery = z.infer<typeof epgDayQuerySchema>;

/**
 * Offset of `timeZone` at instant `at`, in milliseconds.
 *
 * Derived from `Intl.DateTimeFormat` parts rather than from a table: the runtime
 * carries the IANA database.
 */
export function zoneOffsetMs(at: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = formatter.formatToParts(at);
  const read = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? '0');
  const asUtc = Date.UTC(
    read('year'),
    read('month') - 1,
    read('day'),
    read('hour') % 24,
    read('minute'),
    read('second'),
  );
  return asUtc - at.getTime();
}

/** True when the runtime recognises `timeZone` as an IANA zone. */
export function isKnownTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

/**
 * The instant at which local date `date` (`YYYY-MM-DD`) begins in `timeZone`.
 *
 * A zone whose midnight does not exist on that date (a DST jump at 00:00) starts
 * its day at the first existing instant, which is what the two-pass offset
 * resolution below converges to.
 */
export function startOfLocalDay(date: string, timeZone: string): Date {
  const [year, month, day] = date.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error(`Invalid calendar date: ${date}`);
  }
  // First guess: treat the wall-clock midnight as if it were UTC.
  const naive = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  // Apply the zone offset observed near that instant, then re-check once so a
  // transition falling inside the day is accounted for.
  const firstOffset = zoneOffsetMs(new Date(naive), timeZone);
  let candidate = naive - firstOffset;
  const secondOffset = zoneOffsetMs(new Date(candidate), timeZone);
  if (secondOffset !== firstOffset) {
    candidate = naive - secondOffset;
  }
  const result = new Date(candidate);
  if (Number.isNaN(result.getTime())) {
    throw new Error(`Invalid calendar date: ${date}`);
  }
  return result;
}

/** True when `date` is a real calendar date (rejects `2026-02-31`). */
export function isCalendarDate(date: string): boolean {
  const [year, month, day] = date.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day
  );
}

/**
 * Length of the local day that starts at `start`: 23, 24 or 25 hours.
 *
 * The next day is located by its *calendar date*, not by adding 24 hours: on a
 * 25-hour day, `start + 24h` still falls on the same local date, which is exactly
 * the bug this avoids.
 */
export function localDayHours(start: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const dateOf = (instant: Date): string => formatter.format(instant);
  const startDate = dateOf(start);
  /*
   * The whole local day lies inside the 48 hours after it begins, so the first
   * instant whose local date differs is the start of the next day.
   */
  let nextStart: Date | null = null;
  for (let hours = 1; hours <= 48; hours += 1) {
    const candidate = new Date(start.getTime() + hours * 3_600_000);
    if (dateOf(candidate) !== startDate) {
      // Walk to the exact boundary within the last hour.
      let low = new Date(candidate.getTime() - 3_600_000);
      for (let step = 0; step < 60; step += 1) {
        const mid = new Date(low.getTime() + 60_000);
        if (dateOf(mid) !== startDate) break;
        low = mid;
      }
      nextStart = new Date(low.getTime() + 60_000);
      break;
    }
  }
  if (nextStart === null) return 24;
  return Math.round((nextStart.getTime() - start.getTime()) / 3_600_000);
}
