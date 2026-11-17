/**
 * Administration operations contracts (TDT-API-02FG).
 *
 * Additive to `admin.ts`: the existing editorial/source payloads are
 * unchanged. These schemas describe the operational console — a global
 * overview, the catalogue workbench, source health, EPG coverage and the
 * background jobs — and they are deliberately **credential-free**: no clause
 * URL, no provider secret, no unauthorised stream URL and no raw upstream
 * message is representable in these shapes.
 */
import { z } from 'zod';
import {
  attributionSchema,
  channelCategorySchema,
  countryCodeSchema,
  editorialStatusSchema,
  idSchema,
  isoTimestampSchema,
  localeCodeSchema,
  playbackStatusSchema,
  slugSchema,
} from './common.js';
import {
  epgCoverageEntrySchema,
  epgMappingStatusSchema,
  epgSyncRunSchema,
} from './epg-operations.js';

// ------------------------------------------------------------------ overview

export const adminOverviewSchema = z.object({
  catalogue: z.object({
    total: z.number().int().min(0),
    published: z.number().int().min(0),
    review: z.number().int().min(0),
    draft: z.number().int().min(0),
    withdrawn: z.number().int().min(0),
  }),
  countries: z.array(
    z.object({
      code: z.string().min(2).max(3),
      name: z.string(),
      channelCount: z.number().int().min(0),
      playableCount: z.number().int().min(0),
    }),
  ),
  languages: z.array(
    z.object({
      code: z.string(),
      channelCount: z.number().int().min(0),
    }),
  ),
  sources: z.object({
    total: z.number().int().min(0),
    healthy: z.number().int().min(0),
    failing: z.number().int().min(0),
    unverified: z.number().int().min(0),
    ineligible: z.number().int().min(0),
  }),
  epg: z.object({
    sources: z.number().int().min(0),
    mappedChannels: z.number().int().min(0),
    missingChannels: z.number().int().min(0),
    staleChannels: z.number().int().min(0),
    failedRuns24h: z.number().int().min(0),
  }),
  operations: z.object({
    jobs: z.number().int().min(0),
    paused: z.number().int().min(0),
    failed: z.number().int().min(0),
  }),
  asOf: isoTimestampSchema,
});
export type AdminOverview = z.infer<typeof adminOverviewSchema>;

export const adminOverviewResponseSchema = z.object({ data: adminOverviewSchema });

// --------------------------------------------------------------- catalogue

export const adminCatalogueRowSchema = z.object({
  id: idSchema,
  slug: slugSchema,
  name: z.string(),
  country: z.string().min(2).max(3),
  regionCode: z.string().nullable(),
  language: localeCodeSchema,
  category: channelCategorySchema,
  editorialStatus: editorialStatusSchema,
  playbackStatus: playbackStatusSchema,
  /** Number of sources attached, split by whether they may be exposed. */
  sourceCandidates: z.number().int().min(0),
  eligibleSources: z.number().int().min(0),
  /** True when a duplicate group proposes merging this channel. */
  duplicateOf: idSchema.nullable(),
  updatedAt: isoTimestampSchema,
});
export type AdminCatalogueRow = z.infer<typeof adminCatalogueRowSchema>;

export const adminCatalogueQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  q: z.string().trim().min(1).max(120).optional(),
  country: z.string().min(2).max(3).optional(),
  language: z.string().min(1).max(20).optional(),
  category: channelCategorySchema.optional(),
  status: editorialStatusSchema.optional(),
  /** `true` shows only channels with a merged duplicate pending. */
  duplicatesOnly: z.coerce.boolean().optional(),
});
export type AdminCatalogueQuery = z.infer<typeof adminCatalogueQuerySchema>;

export const adminCatalogueResponseSchema = z.object({
  data: z.array(adminCatalogueRowSchema),
  pagination: z.object({
    page: z.number().int().min(1),
    pageSize: z.number().int().min(1),
    total: z.number().int().min(0),
    pageCount: z.number().int().min(0),
    hasNext: z.boolean(),
    hasPrevious: z.boolean(),
  }),
});

export const adminIdentityInputSchema = z.object({
  name: z.string().min(1).max(160).optional(),
  shortName: z.string().min(1).max(40).optional(),
  country: countryCodeSchema.or(z.literal('INT')).optional(),
  language: localeCodeSchema.optional(),
  category: channelCategorySchema.optional(),
  regionCode: z.string().min(1).max(16).nullable().optional(),
  reason: z.string().min(3).max(400),
});
export type AdminIdentityInput = z.infer<typeof adminIdentityInputSchema>;

export const adminChannelDetailSchema = z.object({
  id: idSchema,
  slug: slugSchema,
  name: z.string(),
  shortName: z.string(),
  country: z.string().min(2).max(3),
  regionCode: z.string().nullable(),
  language: localeCodeSchema,
  category: channelCategorySchema,
  editorialStatus: editorialStatusSchema,
  playbackStatus: playbackStatusSchema,
  alias: z.array(z.object({ namespace: z.string(), value: z.string() })),
  sources: z.array(
    z.object({
      id: idSchema,
      provider: z.string(),
      type: z.string(),
      permission: z.string(),
      technicalStatus: z.string(),
      editorialStatus: editorialStatusSchema,
      priority: z.number().int(),
      eligible: z.boolean(),
      eligibilityReason: z.string().nullable(),
      lastVerifiedAt: isoTimestampSchema.nullable(),
    }),
  ),
  duplicates: z.array(z.object({ id: idSchema, slug: slugSchema, name: z.string(), score: z.number() })),
  updatedAt: isoTimestampSchema,
});
export type AdminChannelDetail = z.infer<typeof adminChannelDetailSchema>;

export const adminChannelDetailResponseSchema = z.object({ data: adminChannelDetailSchema });

export const adminDuplicateGroupSchema = z.object({
  key: z.string(),
  reason: z.enum(['alias', 'name', 'url']),
  channelIds: z.array(idSchema).min(2),
  channels: z.array(z.object({ id: idSchema, slug: slugSchema, name: z.string(), country: z.string() })),
  suggestedPrimary: idSchema.nullable(),
});
export type AdminDuplicateGroup = z.infer<typeof adminDuplicateGroupSchema>;

export const adminDuplicateListResponseSchema = z.object({
  data: z.array(adminDuplicateGroupSchema),
  total: z.number().int().min(0),
});

export const adminMergeInputSchema = z.object({
  primaryId: idSchema,
  mergeId: idSchema,
  reason: z.string().min(3).max(400),
});

// ------------------------------------------------------------ source health

export const adminSourceFailureClassSchema = z.enum([
  'none',
  'http-error',
  'unreachable',
  'invalid-manifest',
  'missing-segments',
  'unsupported-format',
  'timeout',
  'unknown',
]);
export type AdminSourceFailureClass = z.infer<typeof adminSourceFailureClassSchema>;

export const adminSourceHealthRowSchema = z.object({
  id: idSchema,
  channelId: idSchema,
  channelSlug: slugSchema.nullable(),
  channelName: z.string().nullable(),
  /** Provider label only — never a URL, credential or private metadata. */
  provider: z.string(),
  type: z.string(),
  permission: z.string(),
  technicalStatus: z.string(),
  editorialStatus: editorialStatusSchema,
  eligible: z.boolean(),
  eligibilityReason: z.string().nullable(),
  failureClass: adminSourceFailureClassSchema,
  lastVerifiedAt: isoTimestampSchema.nullable(),
  consecutiveFailures: z.number().int().min(0),
  /** Number of other authorised sources for the same channel. */
  alternatives: z.number().int().min(0),
});
export type AdminSourceHealthRow = z.infer<typeof adminSourceHealthRowSchema>;

export const adminSourceHealthResponseSchema = z.object({
  data: z.array(adminSourceHealthRowSchema),
  pagination: z.object({
    page: z.number().int().min(1),
    pageSize: z.number().int().min(1),
    total: z.number().int().min(0),
  }),
});

export const adminSourceHealthQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  channelId: idSchema.optional(),
  provider: z.string().min(1).max(80).optional(),
  /** Filter by the failure class derived from the last verification. */
  failureClass: adminSourceFailureClassSchema.optional(),
  eligible: z.coerce.boolean().optional(),
});

export const adminSourceHistoryEntrySchema = z.object({
  at: isoTimestampSchema,
  state: z.string(),
  depth: z.string(),
  httpStatus: z.number().int().nullable(),
  failureClass: adminSourceFailureClassSchema,
  /** Generic error label; never a raw upstream message. */
  detail: z.string().nullable(),
});
export type AdminSourceHistoryEntry = z.infer<typeof adminSourceHistoryEntrySchema>;

export const adminSourceHistoryResponseSchema = z.object({
  data: z.object({
    sourceId: idSchema,
    entries: z.array(adminSourceHistoryEntrySchema),
  }),
});

export const adminSourceAssignInputSchema = z.object({
  channelId: idSchema,
  sourceId: idSchema,
  reason: z.string().min(3).max(400),
});

export const adminSourceRemoveInputSchema = z.object({
  reason: z.string().min(3).max(400),
});

// ---------------------------------------------------------------------- epg

export const adminEpgCoverageResponseSchema = z.object({
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
    /** Mappings whose upstream id is claimed more than once. */
    conflicts: z.number().int().min(0),
    asOf: isoTimestampSchema,
  }),
  attribution: attributionSchema,
});

export const adminMappingRowSchema = z.object({
  id: idSchema,
  channelId: idSchema,
  channelSlug: slugSchema,
  channelName: z.string(),
  epgSourceId: idSchema.nullable(),
  externalId: z.string(),
  namespace: z.string(),
  confidence: z.number(),
  status: epgMappingStatusSchema,
  conflict: z.boolean(),
});
export type AdminMappingRow = z.infer<typeof adminMappingRowSchema>;

export const adminMappingListResponseSchema = z.object({
  data: z.array(adminMappingRowSchema),
  pagination: z.object({
    page: z.number().int().min(1),
    pageSize: z.number().int().min(1),
    total: z.number().int().min(0),
  }),
});

export const adminMappingDecisionInputSchema = z.object({
  reason: z.string().min(3).max(400),
});

export const adminIngestionRunListResponseSchema = z.object({
  data: z.array(epgSyncRunSchema),
});

// ---------------------------------------------------------------- operations

export const adminJobRowSchema = z.object({
  name: z.string(),
  /** True when the scheduler must not run this job. */
  paused: z.boolean(),
  lastStatus: z.enum(['never', 'running', 'ok', 'failed']),
  lastStartedAt: isoTimestampSchema.nullable(),
  lastFinishedAt: isoTimestampSchema.nullable(),
  lastDurationMs: z.number().int().min(0).nullable(),
  consecutiveFailures: z.number().int().min(0),
  /** Generic failure class; never a stack trace or provider message. */
  lastError: z.string().nullable(),
});
export type AdminJobRow = z.infer<typeof adminJobRowSchema>;

export const adminJobListResponseSchema = z.object({ data: z.array(adminJobRowSchema) });

export const adminOperationErrorSchema = z.object({
  at: isoTimestampSchema,
  component: z.enum(['job', 'epg', 'verification', 'ingestion']),
  code: z.string(),
  count: z.number().int().min(1),
});
export type AdminOperationError = z.infer<typeof adminOperationErrorSchema>;

export const adminOperationErrorListResponseSchema = z.object({
  data: z.array(adminOperationErrorSchema),
});

export const adminMetricsSchema = z.object({
  http: z.object({
    totalRequests: z.number().int().min(0),
    errorRequests: z.number().int().min(0),
    p50Ms: z.number().min(0),
    p95Ms: z.number().min(0),
  }),
  playback: z.object({
    descriptorsServed: z.number().int().min(0),
    refusedUnauthorised: z.number().int().min(0),
  }),
  windowSeconds: z.number().int().min(1),
  asOf: isoTimestampSchema,
});
export type AdminMetrics = z.infer<typeof adminMetricsSchema>;

export const adminMetricsResponseSchema = z.object({ data: adminMetricsSchema });

export const adminJobControlInputSchema = z.object({
  reason: z.string().min(3).max(400),
});
