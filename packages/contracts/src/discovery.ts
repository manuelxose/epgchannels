/**
 * Public discovery contracts for the international catalogue
 * (TDT-API-02FG).
 *
 * Additive only: nothing here changes an existing public shape. These
 * payloads exist so the Angular client and third-party consumers can discover
 * the catalogue's *axes* (country, region, language) without downloading the
 * catalogue itself.
 *
 * Every count is a measurement over the published catalogue at the moment of
 * the request; no count is derived or estimated, and a channel without an EPG
 * mapping is reported as `not-mapped` instead of being hidden.
 */
import { z } from 'zod';
import { attributionSchema, countryCodeSchema, localeCodeSchema } from './common.js';

/** `/countries` — one entry per country with published channels. */
export const countryEntrySchema = z.object({
  /** ISO 3166-1 alpha-2, or `INT` for the international aggregate. */
  code: z.string().min(2).max(3),
  name: z.string().min(1).max(120),
  /** True when this row aggregates channels published without a national identity. */
  international: z.boolean(),
  channelCount: z.number().int().min(0),
  playableCount: z.number().int().min(0),
  regionCount: z.number().int().min(0),
});
export type CountryEntry = z.infer<typeof countryEntrySchema>;

export const countryListResponseSchema = z.object({
  data: z.array(countryEntrySchema),
  attribution: attributionSchema,
});
export type CountryListResponse = z.infer<typeof countryListResponseSchema>;

/** `/languages` — one entry per declared language of the published catalogue. */
export const languageEntrySchema = z.object({
  /** BCP-47 tag as declared by the channel (`es`, `multi`, …). */
  code: localeCodeSchema,
  name: z.string().min(1).max(120),
  channelCount: z.number().int().min(0),
  playableCount: z.number().int().min(0),
});
export type LanguageEntry = z.infer<typeof languageEntrySchema>;

export const languageListResponseSchema = z.object({
  data: z.array(languageEntrySchema),
  attribution: attributionSchema,
});
export type LanguageListResponse = z.infer<typeof languageListResponseSchema>;

/**
 * Public availability of one channel. This is the *authorisation-first* answer
 * to "can this channel be watched?" — it never carries a stream URL, a
 * provider name, a credential or an authorization clause.
 */
export const channelAvailabilitySchema = z.object({
  slug: z.string(),
  /** `available` requires at least one authorised, healthy in-app source. */
  playable: z.boolean(),
  playbackStatus: z.enum(['available', 'degraded', 'unavailable', 'external']),
  /** True when at least one authorised source is geo-restricted for us. */
  geoRestricted: z.boolean(),
  /** Number of authorised sources that could be offered, without URLs. */
  authorisedSources: z.number().int().min(0),
  /** Epoch seconds of the last verification of the preferred source, if any. */
  lastVerifiedAt: z.string().nullable(),
  epg: z.object({
    availability: z.enum(['available', 'empty', 'not-mapped', 'withdrawn']),
    /** Instant the channel's guide was last refreshed, when known. */
    updatedAt: z.string().nullable(),
  }),
});
export type ChannelAvailability = z.infer<typeof channelAvailabilitySchema>;

export const channelAvailabilityResponseSchema = z.object({
  data: channelAvailabilitySchema,
  attribution: attributionSchema,
});
export type ChannelAvailabilityResponse = z.infer<typeof channelAvailabilityResponseSchema>;

/** Re-exported for consumers that group by country and language together. */
export const discoveryAxesSchema = z.object({
  countries: z.array(countryEntrySchema),
  languages: z.array(languageEntrySchema),
  /** ISO code of the primary national catalogue, when one exists. */
  homeCountry: countryCodeSchema.nullable(),
});
export type DiscoveryAxes = z.infer<typeof discoveryAxesSchema>;
