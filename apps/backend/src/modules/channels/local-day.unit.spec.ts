/**
 * Guide days and catalogue vocabulary — the pure part of the public surface.
 *
 * These are the rules a whole day's programming depends on, so they are tested
 * directly: a DST edge, a zone whose midnight is skipped, an impossible date, and
 * the two values the catalogue really stores (`INT`, `multi`).
 */
import { describe, expect, it } from 'vitest';
import {
  isCalendarDate,
  isKnownTimeZone,
  localDayHours,
  startOfLocalDay,
  zoneOffsetMs,
} from './local-day.js';
import {
  catalogueCountryFilterSchema,
  catalogueLanguageFilterSchema,
  publicChannelListQuerySchema,
} from './public-filters.js';
import { countryDisplayName, languageDisplayName } from './country-names.js';
import { primaryLanguage } from './catalogue.aggregates.js';

describe('local day windows', () => {
  it('starts a Madrid winter day at 23:00Z the evening before', () => {
    expect(startOfLocalDay('2026-01-15', 'Europe/Madrid').toISOString()).toBe('2026-01-14T23:00:00.000Z');
  });

  it('starts a Madrid summer day at 22:00Z the evening before', () => {
    expect(startOfLocalDay('2026-07-15', 'Europe/Madrid').toISOString()).toBe('2026-07-14T22:00:00.000Z');
  });

  it('resolves the start of a UTC day exactly', () => {
    expect(startOfLocalDay('2026-11-16', 'UTC').toISOString()).toBe('2026-11-16T00:00:00.000Z');
  });

  it('handles the DST transition day itself without drifting', () => {
    // Spain moves to summer time at 01:00 UTC on the last Sunday of March.
    const before = startOfLocalDay('2026-03-28', 'Europe/Madrid');
    const transition = startOfLocalDay('2026-03-29', 'Europe/Madrid');
    expect(before.toISOString()).toBe('2026-03-27T23:00:00.000Z');
    expect(transition.toISOString()).toBe('2026-03-28T23:00:00.000Z');
    // The transition day is 23 hours long, not 24.
    expect(localDayHours(transition, 'Europe/Madrid')).toBe(23);
  });

  it('reports a 25-hour day when the clocks go back', () => {
    const winterStart = startOfLocalDay('2026-10-25', 'Europe/Madrid');
    expect(localDayHours(winterStart, 'Europe/Madrid')).toBe(25);
  });

  it('reports the offset the zone actually applies', () => {
    expect(zoneOffsetMs(new Date('2026-01-15T12:00:00Z'), 'Europe/Madrid')).toBe(3_600_000);
    expect(zoneOffsetMs(new Date('2026-07-15T12:00:00Z'), 'Europe/Madrid')).toBe(7_200_000);
    expect(zoneOffsetMs(new Date('2026-07-15T12:00:00Z'), 'UTC')).toBe(0);
  });

  it('refuses an unknown zone instead of guessing an offset', () => {
    expect(isKnownTimeZone('Europe/Madrid')).toBe(true);
    expect(isKnownTimeZone('UTC')).toBe(true);
    expect(isKnownTimeZone('Mars/Olympus_Mons')).toBe(false);
  });

  it('accepts real calendar dates only', () => {
    expect(isCalendarDate('2026-02-28')).toBe(true);
    expect(isCalendarDate('2024-02-29')).toBe(true);
    expect(isCalendarDate('2026-02-31')).toBe(false);
    expect(isCalendarDate('2026-13-01')).toBe(false);
    expect(isCalendarDate('not-a-date')).toBe(false);
  });
});

describe('public catalogue filters', () => {
  it('accepts the international aggregate the catalogue really stores', () => {
    expect(catalogueCountryFilterSchema.safeParse('INT').success).toBe(true);
    expect(catalogueCountryFilterSchema.safeParse('ES').success).toBe(true);
  });

  it('still refuses a malformed country code', () => {
    expect(catalogueCountryFilterSchema.safeParse('es').success).toBe(false);
    expect(catalogueCountryFilterSchema.safeParse('ESPA').success).toBe(false);
    expect(catalogueCountryFilterSchema.safeParse('').success).toBe(false);
  });

  it('accepts the multi-language marker alongside real BCP-47 tags', () => {
    expect(catalogueLanguageFilterSchema.safeParse('multi').success).toBe(true);
    expect(catalogueLanguageFilterSchema.safeParse('es').success).toBe(true);
    expect(catalogueLanguageFilterSchema.safeParse('es-ES').success).toBe(true);
    expect(catalogueLanguageFilterSchema.safeParse('MULTI').success).toBe(false);
    expect(catalogueLanguageFilterSchema.safeParse('english').success).toBe(false);
  });

  it('keeps every other query parameter exactly as the contract defined it', () => {
    const parsed = publicChannelListQuerySchema.parse({ country: 'INT', language: 'multi' });
    expect(parsed).toMatchObject({ country: 'INT', language: 'multi', sort: 'name', page: 1, pageSize: 24 });
    // The pre-existing bounds are unchanged.
    expect(publicChannelListQuerySchema.safeParse({ pageSize: 1000 }).success).toBe(false);
    expect(publicChannelListQuerySchema.safeParse({ category: 'nope' }).success).toBe(false);
    expect(publicChannelListQuerySchema.parse({ playable: 'true' }).playable).toBe(true);
  });
});

describe('catalogue vocabulary', () => {
  it('names the two country values and falls back to the code', () => {
    expect(countryDisplayName('ES')).toBe('España');
    expect(countryDisplayName('INT')).toBe('Internacionales');
    expect(countryDisplayName('FR')).toBe('FR');
  });

  it('never presents a coverage marker as a spoken language', () => {
    expect(languageDisplayName('es')).toBe('Español');
    expect(languageDisplayName('ca')).toBe('Català');
    expect(languageDisplayName('multi')).toBe('Varios idiomas');
    expect(languageDisplayName('und')).toBe('Idioma sin determinar');
    expect(languageDisplayName('zz')).toBe('zz');
  });

  it('folds a tag to its primary subtag the way the client filters', () => {
    expect(primaryLanguage('es-ES')).toBe('es');
    expect(primaryLanguage('ca')).toBe('ca');
    expect(primaryLanguage('')).toBe('und');
  });
});
