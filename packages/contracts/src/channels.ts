/**
 * Public channel contract (`/api/v1/channels*`).
 *
 * The shape intentionally mirrors what the Angular client already needs
 * (`Channel`, `MediaSource`, `PlaybackAvailability` in the old frontend), so
 * the existing components can be kept while their data source changes.
 */
import { z } from 'zod';
import {
  aliasSchema,
  attributionSchema,
  channelCategorySchema,
  channelKindSchema,
  countryCodeSchema,
  editorialStatusSchema,
  idSchema,
  isoTimestampSchema,
  localeCodeSchema,
  paginationSchema,
  playbackStatusSchema,
  playbackTypeSchema,
  provenanceSchema,
  slugSchema,
} from './common.js';

/** Region (ISO 3166-2 subdivision code without the country prefix, e.g. `MD`). */
export const regionSchema = z.object({
  code: z.string().min(1).max(16),
  name: z.string().min(1),
});
export type Region = z.infer<typeof regionSchema>;

/** A playable integration attached to a channel, as exposed publicly. */
export const channelSourceSummarySchema = z.object({
  /** Internal id of the source record. Used by admin + verification, not routing. */
  id: idSchema,
  /** Aspect of the integration the descriptor expresses. */
  type: playbackTypeSchema,
  /** Public label shown in the source picker ("Emisión 1", "Emisión en YouTube"). */
  label: z.string().min(1).max(120),
  /** True when the emitter restricts the stream by geography. */
  geoRestricted: z.boolean(),
  /** True when this source is the one the API would pick first. */
  preferred: z.boolean(),
  /** Engine that must reproduce it. */
  engine: z.enum(['hls', 'dash', 'youtube-iframe', 'official-embed', 'external']),
});
export type ChannelSourceSummary = z.infer<typeof channelSourceSummarySchema>;

/** The public channel record. No technical identifiers appear in URLs. */
export const channelSchema = z.object({
  /** Internal UUID. Stable across renames; never placed in a public URL. */
  id: idSchema,
  /** Public, semantic slug: the URL identifier. */
  slug: slugSchema,
  name: z.string().min(1).max(160),
  shortName: z.string().min(1).max(40),
  country: countryCodeSchema,
  region: regionSchema.nullable(),
  locality: z.string().min(1).max(120).nullable(),
  language: localeCodeSchema,
  category: channelCategorySchema,
  kind: channelKindSchema,
  /** Official emitter page, when known and verified. */
  websiteUrl: z.string().url().nullable(),
  /** Our editorial description. Never copied from a third party. */
  description: z.string().max(2000),
  /** Authorised brand metadata: a logo we are allowed to display. */
  branding: z
    .object({
      logoSrc: z.string().url().nullable(),
      /** Where the logo may be displayed from (licence/terms). */
      logoSrcPermission: z.enum(['emitter', 'open-data', 'explicit-permission', 'none']),
    })
    .nullable(),
  editorialStatus: editorialStatusSchema,
  playbackStatus: playbackStatusSchema,
  /** Integrations the API would offer, ordered by preference. */
  sources: z.array(channelSourceSummarySchema),
  /** Provenance of the record's information. */
  provenance: z.array(provenanceSchema),
  /** External identities (legacy catalogue id, EPG ids, GuiaTV slug). */
  aliases: z.array(aliasSchema),
  /** True when the channel has an independent programme guide attached. */
  hasSchedule: z.boolean(),
  /** When our editors last reviewed the record. */
  reviewedAt: isoTimestampSchema.nullable(),
  updatedAt: isoTimestampSchema,
});
export type Channel = z.infer<typeof channelSchema>;

/** Trimmed channel record used inside lists (bounded response size). */
export const channelListSchema = z.object({
  id: idSchema,
  slug: slugSchema,
  name: z.string(),
  shortName: z.string(),
  country: countryCodeSchema,
  region: regionSchema.nullable(),
  language: localeCodeSchema,
  category: channelCategorySchema,
  kind: channelKindSchema,
  playbackStatus: playbackStatusSchema,
  logoSrc: z.string().url().nullable(),
  hasSchedule: z.boolean(),
});
export type ChannelList = z.infer<typeof channelListSchema>;

export const channelSortSchema = z.enum(['name', 'name-desc', 'updated', 'relevance']);
export type ChannelSort = z.infer<typeof channelSortSchema>;

export const channelListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(24),
  /** Free text over name, short name and aliases. */
  q: z.string().trim().min(1).max(120).optional(),
  country: countryCodeSchema.optional(),
  region: z.string().trim().min(1).max(16).optional(),
  category: channelCategorySchema.optional(),
  language: localeCodeSchema.optional(),
  /** Only channels with an in-app authorised source. */
  playable: z
    .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
    .transform((value) => value === true || value === 'true' || value === '1')
    .optional(),
  sort: channelSortSchema.default('name'),
});
export type ChannelListQuery = z.infer<typeof channelListQuerySchema>;

export const channelListResponseSchema = z.object({
  data: z.array(channelListSchema),
  pagination: paginationSchema,
  attribution: attributionSchema,
});
export type ChannelListResponse = z.infer<typeof channelListResponseSchema>;

export const channelResponseSchema = z.object({
  data: channelSchema,
  attribution: attributionSchema,
});
export type ChannelResponse = z.infer<typeof channelResponseSchema>;

/** `/categories` — our canonical taxonomy with live counts. */
export const categorySchema = z.object({
  id: channelCategorySchema,
  name: z.string(),
  channelCount: z.number().int().min(0),
  playableCount: z.number().int().min(0),
});
export type Category = z.infer<typeof categorySchema>;

export const categoryListResponseSchema = z.object({
  data: z.array(categorySchema),
  attribution: attributionSchema,
});
export type CategoryListResponse = z.infer<typeof categoryListResponseSchema>;

/** `/regions` — Spanish autonomous communities plus international aggregate. */
export const regionEntrySchema = z.object({
  country: countryCodeSchema,
  code: z.string(),
  name: z.string(),
  channelCount: z.number().int().min(0),
  playableCount: z.number().int().min(0),
});
export type RegionEntry = z.infer<typeof regionEntrySchema>;

export const regionListResponseSchema = z.object({
  data: z.array(regionEntrySchema),
  attribution: attributionSchema,
});
export type RegionListResponse = z.infer<typeof regionListResponseSchema>;
