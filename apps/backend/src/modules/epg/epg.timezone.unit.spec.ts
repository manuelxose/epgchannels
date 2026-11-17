/**
 * Time-zone normalisation and daylight saving (TDT-API-02FG).
 *
 * The four zones the product ships guides for are asserted on their real
 * transitions, not on a table we keep by hand: Europe/Madrid and Europe/Berlin
 * change on the last Sunday of March and October at 01:00 UTC, Europe/London on
 * the same days at 01:00 UTC (with a different local reading), and UTC never
 * changes at all. Every assertion names an instant, so a failure says exactly
 * which hour moved.
 */
import { describe, expect, it } from 'vitest';
import {
  isValidTimeZone,
  offsetMinutesAt,
  parseXmltvTimestamp,
  wallClockIn,
  zonedToUtc,
} from './epg.timezone.js';

const WALL = { minute: 0, second: 0 } as const;

describe('zone offset', () => {
  it('reports the winter and summer offsets of the four supported zones', () => {
    const winter = new Date('2026-01-15T12:00:00Z');
    const summer = new Date('2026-07-15T12:00:00Z');
    expect(offsetMinutesAt(winter, 'Europe/Madrid')).toBe(60);
    expect(offsetMinutesAt(summer, 'Europe/Madrid')).toBe(120);
    expect(offsetMinutesAt(winter, 'Europe/Berlin')).toBe(60);
    expect(offsetMinutesAt(summer, 'Europe/Berlin')).toBe(120);
    expect(offsetMinutesAt(winter, 'Europe/London')).toBe(0);
    expect(offsetMinutesAt(summer, 'Europe/London')).toBe(60);
    expect(offsetMinutesAt(winter, 'UTC')).toBe(0);
    expect(offsetMinutesAt(summer, 'UTC')).toBe(0);
  });

  it('rejects an unknown zone instead of guessing one', () => {
    expect(isValidTimeZone('Europe/Madrid')).toBe(true);
    expect(isValidTimeZone('Not/AZone')).toBe(false);
    expect(offsetMinutesAt(new Date('2026-01-01T00:00:00Z'), 'Not/AZone')).toBeNull();
    expect(wallClockIn(new Date('2026-01-01T00:00:00Z'), 'Not/AZone')).toBeNull();
    expect(zonedToUtc({ year: 2026, month: 1, day: 1, hour: 0, ...WALL }, 'Not/AZone')).toBeNull();
  });

  it('renders the wall clock in the requested zone', () => {
    const instant = new Date('2026-03-29T01:30:00Z');
    expect(wallClockIn(instant, 'Europe/Madrid')).toMatchObject({ hour: 3, minute: 30 });
    expect(wallClockIn(instant, 'Europe/London')).toMatchObject({ hour: 2, minute: 30 });
    expect(wallClockIn(instant, 'UTC')).toMatchObject({ hour: 1, minute: 30 });
  });
});

describe('spring forward (the hour that does not exist)', () => {
  it('maps the skipped reading to the transition instant in Madrid and Berlin', () => {
    // 2026-03-29: 02:00 CET jumps to 03:00 CEST, so 02:30 never happens. The
    // reading is mapped to the moment the clock jumped (01:00Z), deterministically.
    const madrid = zonedToUtc({ year: 2026, month: 3, day: 29, hour: 2, minute: 30, second: 0 }, 'Europe/Madrid');
    expect(madrid?.toISOString()).toBe('2026-03-29T01:00:00.000Z');
    const berlin = zonedToUtc({ year: 2026, month: 3, day: 29, hour: 2, minute: 30, second: 0 }, 'Europe/Berlin');
    expect(berlin?.toISOString()).toBe('2026-03-29T01:00:00.000Z');
  });

  it('maps the skipped London reading to the transition instant', () => {
    // 2026-03-29 01:00 GMT jumps to 02:00 BST: 01:30 never happens.
    const london = zonedToUtc({ year: 2026, month: 3, day: 29, hour: 1, minute: 30, second: 0 }, 'Europe/London');
    expect(london?.toISOString()).toBe('2026-03-29T01:00:00.000Z');
  });

  it('keeps the readings either side of the jump exact', () => {
    expect(
      zonedToUtc({ year: 2026, month: 3, day: 29, hour: 1, minute: 59, second: 0 }, 'Europe/Madrid')?.toISOString(),
    ).toBe('2026-03-29T00:59:00.000Z');
    expect(
      zonedToUtc({ year: 2026, month: 3, day: 29, hour: 3, minute: 0, second: 0 }, 'Europe/Madrid')?.toISOString(),
    ).toBe('2026-03-29T01:00:00.000Z');
  });
});

describe('backward transition (the hour that happens twice)', () => {
  it('resolves the repeated Madrid reading deterministically to its first occurrence', () => {
    // 2026-10-25: 03:00 CEST falls back to 02:00 CET, so 02:30 happens twice.
    const first = zonedToUtc({ year: 2026, month: 10, day: 25, hour: 2, minute: 30, second: 0 }, 'Europe/Madrid');
    expect(first?.toISOString()).toBe('2026-10-25T00:30:00.000Z');
    const again = zonedToUtc({ year: 2026, month: 10, day: 25, hour: 2, minute: 30, second: 0 }, 'Europe/Madrid');
    expect(again?.toISOString()).toBe(first?.toISOString());
  });

  it('resolves the repeated Berlin and London readings the same way', () => {
    expect(
      zonedToUtc({ year: 2026, month: 10, day: 25, hour: 2, minute: 30, second: 0 }, 'Europe/Berlin')?.toISOString(),
    ).toBe('2026-10-25T00:30:00.000Z');
    // London falls back at 02:00 BST → 01:00 GMT: 01:30 happens twice.
    expect(
      zonedToUtc({ year: 2026, month: 10, day: 25, hour: 1, minute: 30, second: 0 }, 'Europe/London')?.toISOString(),
    ).toBe('2026-10-25T00:30:00.000Z');
  });

  it('never shifts UTC, before or after the European transitions', () => {
    for (const [month, day] of [
      [3, 29],
      [10, 25],
    ] as const) {
      const instant = zonedToUtc({ year: 2026, month, day, hour: 2, minute: 30, second: 0 }, 'UTC');
      expect(instant?.toISOString()).toBe(`2026-${String(month).padStart(2, '0')}-${day}T02:30:00.000Z`);
    }
  });
});

describe('XMLTV timestamps', () => {
  it('keeps an explicit offset instead of re-interpreting it', () => {
    const parsed = parseXmltvTimestamp('20261114200000 +0100', 'Europe/Madrid');
    expect(parsed?.instant.toISOString()).toBe('2026-11-14T19:00:00.000Z');
    expect(parsed?.zone).toBe('UTC');
  });

  it('reads an offset-less reading in the source zone and records that zone', () => {
    const madrid = parseXmltvTimestamp('20260715200000', 'Europe/Madrid');
    expect(madrid?.instant.toISOString()).toBe('2026-07-15T18:00:00.000Z');
    expect(madrid?.zone).toBe('Europe/Madrid');
    const london = parseXmltvTimestamp('20260715200000', 'Europe/London');
    expect(london?.instant.toISOString()).toBe('2026-07-15T19:00:00.000Z');
    const utc = parseXmltvTimestamp('20260715200000', 'UTC');
    expect(utc?.instant.toISOString()).toBe('2026-07-15T20:00:00.000Z');
  });

  it('separates the two transitions of one night by the real offsets', () => {
    const beforeJump = parseXmltvTimestamp('20260329015500', 'Europe/Madrid');
    const afterJump = parseXmltvTimestamp('20260329030000', 'Europe/Madrid');
    // One minute of wall clock, but the clock jumped: five minutes of real time.
    expect(beforeJump?.instant.toISOString()).toBe('2026-03-29T00:55:00.000Z');
    expect(afterJump?.instant.toISOString()).toBe('2026-03-29T01:00:00.000Z');
  });

  it('rejects malformed timestamps', () => {
    expect(parseXmltvTimestamp('not-a-date', 'Europe/Madrid')).toBeNull();
    expect(parseXmltvTimestamp('2026-03-29T01:00:00Z', 'Europe/Madrid')).toBeNull();
  });

  it('treats a negative offset correctly', () => {
    const parsed = parseXmltvTimestamp('20261114200000 -0300', 'Europe/Madrid');
    expect(parsed?.instant.toISOString()).toBe('2026-11-14T23:00:00.000Z');
  });
});
