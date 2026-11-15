/**
 * Primitive shared contracts: identifiers, pagination, time, errors.
 *
 * Everything the public API can emit is described here once. The backend
 * validates against these schemas and the SDK is generated from the OpenAPI
 * document built out of the same schemas, so the three cannot drift.
 */
import { z } from 'zod';

/** Opaque internal identifier. Never a public URL segment. */
export const idSchema = z.string().uuid();

/**
 * Public, semantic, ASCII slug. It is the only channel identifier a client
 * sees in a URL; the UUID stays internal.
 */
export const slugSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'lowercase ASCII slug');

/** ISO-8601 UTC timestamp. */
export const isoTimestampSchema = z.string().datetime({ offset: true });

/** IANA time-zone name (validated by the runtime, not by a fixed list). */
export const timezoneSchema = z.string().min(3).max(64);

export const countryCodeSchema = z
  .string()
  .regex(/^[A-Z]{2}$/, 'ISO 3166-1 alpha-2 country code');

export const localeCodeSchema = z
  .string()
  .regex(/^[a-z]{2,3}(?:-[A-Z]{2})?$/, 'BCP-47 language tag (lowercase language)');

/**
 * Canonical channel taxonomy. The category is our editorial decision; the
 * region is an ISO 3166-2:ES subdivision code when the channel is Spanish.
 */
export const channelCategorySchema = z.enum([
  'generalista',
  'informativos',
  'deportes',
  'infantil',
  'musica',
  'cultura',
  'cine-series',
  'documentales',
  'entretenimiento',
  'religion',
  'local',
  'autonomica',
  'internacional',
  'otros',
]);
export type ChannelCategory = z.infer<typeof channelCategorySchema>;

export const channelKindSchema = z.enum([
  /** Linear broadcast channel (television as broadcast on air). */
  'linear',
  /** Internet-only linear stream published by the emitter. */
  'online',
  /** Eventual / intermittent emission (sports events, sessions, plenary). */
  'eventual',
  /** Channel that only publishes a programme guide. */
  'guide-only',
]);
export type ChannelKind = z.infer<typeof channelKindSchema>;

/** Editorial lifecycle of a catalogue record. */
export const editorialStatusSchema = z.enum(['draft', 'review', 'published', 'withdrawn']);
export type EditorialStatus = z.infer<typeof editorialStatusSchema>;

/**
 * Playback capability as *derived* by the platform. This is deliberately
 * separate from authorisation: `status` says what we can do for this channel
 * today, `permission` on each source says whether we may.
 */
export const playbackStatusSchema = z.enum([
  /** An authorised source the web player can attempt is attached and healthy. */
  'available',
  /** Authorised sources exist but every one of them is currently unhealthy. */
  'degraded',
  /** No authorised in-app source: the user is sent to the emitter's own player. */
  'external',
  /** The emitter publishes it only eventually and nothing is attached now. */
  'eventual',
  /** Nothing playable is published anywhere. */
  'unavailable',
]);
export type PlaybackStatus = z.infer<typeof playbackStatusSchema>;

/** Playback integrations our web player implements. */
export const playbackTypeSchema = z.enum(['hls', 'dash', 'youtube', 'official-embed', 'external']);
export type PlaybackType = z.infer<typeof playbackTypeSchema>;

/** Engine the client must select for a descriptor. */
export const playbackEngineSchema = z.enum([
  'hls',
  'dash',
  'youtube-iframe',
  'official-embed',
  'external',
  'none',
]);
export type PlaybackEngine = z.infer<typeof playbackEngineSchema>;

/**
 * Authorisation modality recorded per source. It states *why* we may expose
 * the source, and it is a prerequisite for the source to be public.
 */
export const permissionSchema = z.enum([
  /** The emitter itself publishes this stream publicly for direct playback. */
  'emitter-public-stream',
  /** The emitter publishes it and its terms allow third-party embedding. */
  'emitter-embeddable',
  /** Only the emitter's own player may show it: link out, never proxy. */
  'official-player-only',
  /** Public reference data with a compatible licence (attribution required). */
  'open-data-licence',
  /** Explicit written permission on file. */
  'explicit-permission',
  /** No sufficient permission: never exposed publicly. */
  'unlicensed',
]);
export type Permission = z.infer<typeof permissionSchema>;

/** Technical health of a source, from the last verification job. */
export const technicalStatusSchema = z.enum(['ok', 'unreachable', 'http-error', 'invalid-manifest', 'unknown', 'blocked']);
export type TechnicalStatus = z.infer<typeof technicalStatusSchema>;

/** Where a record's information came from. Always stored, never inferred. */
export const provenanceSchema = z.object({
  /** Stable id of the provenance record, e.g. `tdtchannels-snapshot`. */
  source: z.string().min(1).max(120),
  /** Human-readable description of the source. */
  label: z.string().min(1).max(300),
  /** Canonical URL of the source, when it has one. */
  url: z.string().url().nullable(),
  /** Licence identifier (`Apache-2.0`, `operator-terms`, `editorial`, …). */
  licence: z.string().min(1).max(80),
  /** Attribution text that must be shown wherever this data is used. */
  attribution: z.string().min(1).max(600).nullable(),
  /** SHA-256 of the exact bytes imported, when a snapshot was imported. */
  digestSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  /** Timestamp of the import or editorial creation. */
  capturedAt: isoTimestampSchema,
  /**
   * True when the record is our own editorial statement, false when it is
   * derived from third-party material.
   */
  editorial: z.boolean(),
});
export type Provenance = z.infer<typeof provenanceSchema>;

/** One source an alias or identity can come from. */
export const aliasSchema = z.object({
  /** Namespace of the alias, e.g. `legacy-tdt`, `epg`, `guiatv`. */
  namespace: z.string().min(1).max(60),
  value: z.string().min(1).max(200),
});
export type Alias = z.infer<typeof aliasSchema>;

/** Standard error body for every non-2xx response. */
export const apiErrorCodeSchema = z.enum([
  'bad_request',
  'validation_failed',
  'not_found',
  'unauthorized',
  'forbidden',
  'conflict',
  'rate_limited',
  'payload_too_large',
  'unavailable',
  'internal_error',
]);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

export const apiErrorSchema = z.object({
  error: z.object({
    code: apiErrorCodeSchema,
    message: z.string(),
    /** Field-level details for validation failures. */
    details: z
      .array(
        z.object({
          path: z.string(),
          message: z.string(),
        }),
      )
      .optional(),
  }),
  /** Correlation id echoed in the `x-request-id` response header. */
  requestId: z.string(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

/** Pagination envelope shared by every list endpoint. */
export const paginationSchema = z.object({
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1).max(100),
  total: z.number().int().min(0),
  pageCount: z.number().int().min(0),
  hasNext: z.boolean(),
  hasPrevious: z.boolean(),
});
export type Pagination = z.infer<typeof paginationSchema>;

/** Provenance/attribution summary attached to data-derived payloads. */
export const attributionSchema = z.object({
  /** Attribution texts that must be displayed with this data. */
  notices: z.array(z.string()),
  /** True when the payload includes records derived from third-party data. */
  includesThirdPartyData: z.boolean(),
});
export type Attribution = z.infer<typeof attributionSchema>;

/**
 * A technical issue attached to a source. It is either derived from a real
 * verification run (`verification`) or from our integration rules
 * (`policy`), never from an assumption.
 */
export const techIssueSchema = z.object({
  kind: z.enum(['verification', 'policy']),
  /** Machine-readable code, e.g. `http_404`, `geo-restricted`. */
  code: z.string().min(1).max(80),
  message: z.string().min(1).max(400),
  /** When the observation behind the issue was made. */
  observedAt: isoTimestampSchema.nullable(),
});
export type TechIssue = z.infer<typeof techIssueSchema>;

/** Reason an unlicensed source is never exposed (always machine-readable). */
export const exclusionReasonSchema = z.enum([
  'unlicensed',
  'disallowed-integration',
  'credentials-required',
  'requires-forged-header',
  'emitter-app-only',
  'geo-restricted',
  'unhealthy',
  'withdrawn',
  'channel-withdrawn',
]);
export type ExclusionReason = z.infer<typeof exclusionReasonSchema>;
