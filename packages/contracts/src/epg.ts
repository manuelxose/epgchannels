/**
 * Independent EPG contract.
 *
 * The guide is stored as programmes per canonical channel. A channel with no
 * programmes is a legitimate answer (`status: 'no-schedule'` or `'empty'`); the
 * API never fabricates an emission to fill the gap.
 */
import { z } from 'zod';
import {
  attributionSchema,
  editorialStatusSchema,
  idSchema,
  isoTimestampSchema,
  slugSchema,
  timezoneSchema,
} from './common.js';
import { channelRefSchema } from './playback.js';

export const scheduleAvailabilitySchema = z.enum([
  /** The channel has programmes covering the requested window. */
  'available',
  /** The channel is mapped to a guide source that returned nothing yet. */
  'empty',
  /** The channel is not mapped to any guide source. */
  'not-mapped',
  /** The channel's guide is withdrawn (licence or emitter request). */
  'withdrawn',
]);
export type ScheduleAvailability = z.infer<typeof scheduleAvailabilitySchema>;

export const programmeSchema = z.object({
  id: idSchema,
  title: z.string().min(1).max(300),
  description: z.string().max(2000),
  genre: z.string().max(80).nullable(),
  coverUrl: z.string().url().nullable(),
  /** ISO-8601 instant the programme starts. */
  start: isoTimestampSchema,
  /** ISO-8601 instant the programme ends. */
  end: isoTimestampSchema,
});
export type Programme = z.infer<typeof programmeSchema>;

/** Provenance block attached to EPG payloads. */
export const epgProvenanceSchema = z.object({
  sourceId: idSchema.nullable(),
  sourceName: z.string().nullable(),
  licence: z.string().nullable(),
  attribution: z.string().nullable(),
  editedAt: isoTimestampSchema.nullable(),
});
export type EpgProvenance = z.infer<typeof epgProvenanceSchema>;

export const scheduleQuerySchema = z.object({
  /**
   * ISO-8601 instant to anchor the window. Defaults to "now". The window is
   * `[from - lookBackHours, from + hours]` clipped to `days` days.
   */
  from: isoTimestampSchema.optional(),
  /** Hours of guide to return from `from` (bounded). */
  hours: z.coerce.number().int().min(1).max(72).default(24),
});
export type ScheduleQuery = z.infer<typeof scheduleQuerySchema>;

export const scheduleResponseSchema = z.object({
  data: z.object({
    channel: channelRefSchema,
    timezone: timezoneSchema,
    availability: scheduleAvailabilitySchema,
    /** Programme on air at `asOf`, when one exists. */
    now: programmeSchema.nullable(),
    /** The next programmes after `now`, in start order. */
    next: z.array(programmeSchema),
    /** The full window, in start order. */
    programmes: z.array(programmeSchema),
    asOf: isoTimestampSchema,
    provenance: epgProvenanceSchema,
    updatedAt: isoTimestampSchema.nullable(),
  }),
  attribution: attributionSchema,
});
export type ScheduleResponse = z.infer<typeof scheduleResponseSchema>;

/** `/epg/now` and `/epg/next` — a bounded slice across many channels. */
export const epgFeedQuerySchema = z.object({
  channel: z.array(slugSchema).min(1).max(50).optional(),
  country: z.string().length(2).optional(),
  category: z.string().min(1).max(40).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  page: z.coerce.number().int().min(1).default(1),
  // Off by default: the feed answers "what is on", so unmapped channels would
  // otherwise flood the first pages with empty rows.
  includeUnmapped: z.coerce.boolean().default(false),
  from: isoTimestampSchema.optional(),
});
export type EpgFeedQuery = z.infer<typeof epgFeedQuerySchema>;

export const epgFeedEntrySchema = z.object({
  channel: channelRefSchema,
  timezone: timezoneSchema,
  availability: scheduleAvailabilitySchema,
  programme: programmeSchema.nullable(),
  provenance: epgProvenanceSchema,
});
export type EpgFeedEntry = z.infer<typeof epgFeedEntrySchema>;

export const epgFeedResponseSchema = z.object({
  data: z.array(epgFeedEntrySchema),
  asOf: isoTimestampSchema,
  attribution: attributionSchema,
});
export type EpgFeedResponse = z.infer<typeof epgFeedResponseSchema>;

/** Admin: registered guide sources. */
export const epgSourceKindSchema = z.enum(['xmltv', 'json-tdtchannels', 'editorial']);
export type EpgSourceKind = z.infer<typeof epgSourceKindSchema>;

export const epgSourceSchema = z.object({
  id: idSchema,
  name: z.string(),
  kind: epgSourceKindSchema,
  /** Public URL the job fetches (null for editorial sources). */
  url: z.string().url().nullable(),
  licence: z.string(),
  attribution: z.string().nullable(),
  /** True when this source may be fetched by the scheduled job. */
  ingestionEnabled: z.boolean(),
  status: editorialStatusSchema,
  lastRunAt: isoTimestampSchema.nullable(),
  lastRunStatus: z.enum(['never', 'ok', 'failed']),
  lastRunProgrammes: z.number().int().min(0),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
});
export type EpgSource = z.infer<typeof epgSourceSchema>;

export const epgVerifyInputSchema = z.object({
  sourceId: idSchema,
});

export const epgIngestResultSchema = z.object({
  sourceId: idSchema,
  runId: z.string(),
  status: z.enum(['ok', 'failed']),
  programmes: z.number().int().min(0),
  channelsMatched: z.number().int().min(0),
  rejected: z.number().int().min(0),
  message: z.string().nullable(),
});
export type EpgIngestResult = z.infer<typeof epgIngestResultSchema>;
