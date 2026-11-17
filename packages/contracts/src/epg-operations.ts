/**
 * International EPG contracts (TDT-API-02FG).
 *
 * Additive to `epg.ts`: the existing schedule/feed shapes are unchanged. These
 * schemas describe the *operational* side of the guide — coverage, canonical
 * channel→guide mappings and synchronisation runs — so the public API and the
 * administration UI read exactly the same vocabulary.
 *
 * A channel with no guide is reported honestly (`not-mapped`, `empty`,
 * `stale`). Nothing in this module fabricates a programme.
 */
import { z } from 'zod';
import { idSchema, isoTimestampSchema, slugSchema, timezoneSchema } from './common.js';
import { scheduleAvailabilitySchema } from './epg.js';

/** Why a channel's guide cannot be trusted right now. */
export const epgCoverageStatusSchema = z.enum([
  /** Programmes cover the requested window and were refreshed inside the window. */
  'fresh',
  /** Programmes exist but the source has not produced new data in time. */
  'stale',
  /** Mapped to a source that has returned no programmes yet. */
  'empty',
  /** No canonical mapping to any guide source. */
  'not-mapped',
]);
export type EpgCoverageStatus = z.infer<typeof epgCoverageStatusSchema>;

export const epgCoverageEntrySchema = z.object({
  channelId: idSchema,
  slug: slugSchema,
  name: z.string(),
  country: z.string().min(2).max(3),
  language: z.string(),
  /** Zone the channel's guide is authored in (its own, not the server's). */
  timezone: timezoneSchema,
  mapped: z.boolean(),
  sourceId: idSchema.nullable(),
  sourceName: z.string().nullable(),
  status: epgCoverageStatusSchema,
  /** Availability of the schedule for the current window. */
  availability: scheduleAvailabilitySchema,
  /** Programmes stored for the channel inside the lookback window. */
  programmes: z.number().int().min(0),
  /** Instant of the last programme start we hold, when any. */
  lastProgrammeEnd: isoTimestampSchema.nullable(),
  /** Moment after which this coverage is considered stale. */
  staleAfter: isoTimestampSchema.nullable(),
});
export type EpgCoverageEntry = z.infer<typeof epgCoverageEntrySchema>;

export const epgCoverageSchema = z.object({
  data: z.object({
    entries: z.array(epgCoverageEntrySchema),
    totals: z.object({
      channels: z.number().int().min(0),
      mapped: z.number().int().min(0),
      fresh: z.number().int().min(0),
      stale: z.number().int().min(0),
      empty: z.number().int().min(0),
      notMapped: z.number().int().min(0),
    }),
    asOf: isoTimestampSchema,
  }),
});
export type EpgCoverageResponse = z.infer<typeof epgCoverageSchema>;

/** Canonical channel ↔ guide-source mapping. */
export const epgMappingStatusSchema = z.enum(['proposed', 'confirmed', 'rejected']);
export type EpgMappingStatus = z.infer<typeof epgMappingStatusSchema>;

export const epgMappingSchema = z.object({
  id: idSchema,
  channelId: idSchema,
  channelSlug: slugSchema,
  channelName: z.string(),
  epgSourceId: idSchema.nullable(),
  /** Identifier of the channel inside the upstream guide. */
  externalId: z.string().min(1).max(200),
  /** Namespace of the upstream identifier (`epg`, `xmltv`, `json-tdtchannels`). */
  namespace: z.string().min(1).max(40),
  confidence: z.number().min(0).max(1),
  status: epgMappingStatusSchema,
  /** True when another confirmed mapping shares the same upstream id. */
  conflict: z.boolean(),
});
export type EpgMapping = z.infer<typeof epgMappingSchema>;

export const epgMappingListResponseSchema = z.object({
  data: z.array(epgMappingSchema),
  pagination: z
    .object({
      page: z.number().int().min(1),
      pageSize: z.number().int().min(1),
      total: z.number().int().min(0),
    })
    .optional(),
});
export type EpgMappingListResponse = z.infer<typeof epgMappingListResponseSchema>;

export const epgMappingInputSchema = z.object({
  channelId: idSchema,
  epgSourceId: idSchema.nullable(),
  externalId: z.string().min(1).max(200),
  namespace: z.string().min(1).max(40).default('epg'),
  confidence: z.number().min(0).max(1).default(1),
});
export type EpgMappingInput = z.infer<typeof epgMappingInputSchema>;

/** One synchronisation run of one guide source. */
export const epgSyncRunSchema = z.object({
  id: z.string(),
  sourceId: idSchema,
  sourceName: z.string().nullable(),
  startedAt: isoTimestampSchema,
  finishedAt: isoTimestampSchema.nullable(),
  status: z.enum(['ok', 'failed']),
  trigger: z.enum(['scheduled', 'manual', 'incremental']),
  programmes: z.number().int().min(0),
  channelsMatched: z.number().int().min(0),
  rejected: z.number().int().min(0),
  duplicates: z.number().int().min(0),
  /** Generic failure class; never an upstream URL or a raw provider message. */
  error: z.string().nullable(),
});
export type EpgSyncRun = z.infer<typeof epgSyncRunSchema>;

export const epgSyncRunListResponseSchema = z.object({
  data: z.array(epgSyncRunSchema),
});
export type EpgSyncRunListResponse = z.infer<typeof epgSyncRunListResponseSchema>;
