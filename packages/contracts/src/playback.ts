/**
 * Playback descriptor contract (`/api/v1/channels/:slug/playback`).
 *
 * The descriptor never invents a route. It states one of four things:
 *
 * 1. `available`/`degraded` with an in-app descriptor (`hls`, `dash`, or the
 *    official YouTube IFrame integration) the client's engines can reproduce;
 * 2. `external` with the emitter's official page, because only their player may
 *    show the signal;
 * 3. `eventual`/`unavailable` with no URL at all.
 *
 * A source is selectable only through four separate axes, evaluated in this
 * order and never collapsed: **authorization** (a recorded right; fail-closed),
 * **compatibility** (a measured reproduction verdict, never inferred from a
 * failure code), **health** (a recorded check, tri-state), **quality** (only a
 * tie-breaker between candidates that already passed the first three). Failover
 * exists only between candidates that are authorized *and* healthy *and*
 * compatible; a healthy source without a right is never a fallback.
 *
 * Credentials, cookies and tokens are never part of this payload.
 */
import { z } from 'zod';
import {
  idSchema,
  isoTimestampSchema,
  playbackEngineSchema,
  playbackStatusSchema,
  playbackTypeSchema,
  slugSchema,
  techIssueSchema,
} from './common.js';

/** The channel identity block repeated in playback/schedule payloads. */
export const channelRefSchema = z.object({
  id: idSchema,
  slug: slugSchema,
  name: z.string(),
  // ISO 3166-1 alpha-2 of the channel's country; `INT` for international feeds.
  // The guide groups its rows by country, so it travels with the reference.
  country: z.string().min(2).max(3).nullable().optional(),
});
export type ChannelRef = z.infer<typeof channelRefSchema>;

/**
 * The health axis of a source, resolved from a recorded verdict.
 *
 * `not-verified` is a first-class answer and is never collapsed into either
 * neighbour: our stream-health engine verifies `hls`/`dash` streams, and it says
 * nothing at all about a YouTube channel page or an official embed. "We have not
 * checked" and "we checked and it failed" are different facts.
 */
export const playbackHealthSchema = z.enum(['healthy', 'failing', 'not-verified']);
export type PlaybackHealth = z.infer<typeof playbackHealthSchema>;

/**
 * The compatibility axis. A closed union in which the ONLY value meaning
 * "incompatible" is produced from a measured reproduction verdict.
 *
 * It is deliberately impossible to derive this from a failure code: the
 * verification vocabulary reports `unsupported-format` both for a body that is
 * not a manifest and for a request we refused before sending it, so a failure
 * string is not evidence about a browser. `incompatible` means a probe actually
 * tried to reproduce the stream and it did not play.
 */
export const playbackCompatibilitySchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('reproduced'),
    /** The engine that was exercised. */
    browser: z.string().min(1).max(40),
    /** Depth the verdict came from; `browser` is the only reproduction depth. */
    depth: z.string().min(1).max(40),
    observedAt: isoTimestampSchema,
  }),
  z.object({
    state: z.literal('incompatible'),
    /** Machine reason from the probe, never a page excerpt. */
    reason: z.enum(['browser-incompatible', 'codec-failure', 'cors-limitation']),
    browser: z.string().min(1).max(40),
    observedAt: isoTimestampSchema,
  }),
  z.object({ state: z.literal('unknown') }),
]);
export type PlaybackCompatibility = z.infer<typeof playbackCompatibilitySchema>;

/**
 * One selectable source option, as the player's source picker needs it.
 *
 * `evidence` states, per axis, what we actually know. It is additive: every
 * field is optional so a client generated before these axes existed still parses
 * the payload.
 */
export const playbackOptionSchema = z.object({
  sourceId: idSchema,
  label: z.string(),
  type: playbackTypeSchema,
  engine: playbackEngineSchema,
  /** Media URL (HLS/DASH) or the official player URL (YouTube/embed). */
  url: z.string().url(),
  /** Official page a human can open (always set for YouTube/embeds). */
  externalUrl: z.string().url().nullable(),
  geoRestricted: z.boolean(),
  /** True for the option the API recommends first. */
  preferred: z.boolean(),
  /** Health axis, with the observation it rests on. */
  health: z
    .object({
      state: playbackHealthSchema,
      /** Where the verdict came from: the health ledger or the source row. */
      origin: z.enum(['health-ledger', 'source-record', 'none']),
      /** Depth the underlying check reached (`segments`, `transport`, …). */
      depth: z.string().min(1).max(40).nullable(),
      /** Failure category from the check, when it failed. */
      failure: z.string().min(1).max(80).nullable(),
      observedAt: isoTimestampSchema.nullable(),
    })
    .optional(),
  /** Compatibility axis. Omitted only for options built by older callers. */
  compatibility: playbackCompatibilitySchema.optional(),
  /**
   * How long ago the selected option was observed. Present only for a measured
   * health record; the player uses it to tell "fresh" from "stale".
   */
  observedAt: isoTimestampSchema.nullable().optional(),
});
export type PlaybackOption = z.infer<typeof playbackOptionSchema>;

export const playbackDescriptorSchema = z.object({
  channel: channelRefSchema,
  playback: z.object({
    status: playbackStatusSchema,
    /** Engine the client must select; `none` when there is nothing to play. */
    engine: playbackEngineSchema,
    /** Primary in-app descriptor, when `engine` is not `none`/`external`. */
    type: playbackTypeSchema.nullable(),
    sourceId: idSchema.nullable(),
    url: z.string().url().nullable(),
    /**
     * Official page to open when the signal is only available in the emitter's
     * own player. Never a promise of in-app playback.
     */
    externalUrl: z.string().url().nullable(),
    /** Every authorised, healthy option for the source picker. */
    options: z.array(playbackOptionSchema),
    /**
     * Why each in-app candidate that exists but cannot be selected now was
     * dropped. A candidate is only listed here if it is authorised: an
     * unauthorised source is never described as a fallback.
     */
    unavailableOptions: z
      .array(
        z.object({
          sourceId: idSchema,
          type: playbackTypeSchema,
          /** The first axis that refused it, in the platform's fixed order. */
          axis: z.enum(['compatibility', 'health', 'address']),
          code: z.string().min(1).max(80),
        }),
      )
      .optional(),
    /** Human reason for the current status when it is not `available`. */
    reason: z.string().nullable(),
  }),
  checkedAt: isoTimestampSchema,
  /** Internal technical issues, never rendered as a claim of playback. */
  issues: z.array(techIssueSchema),
});
export type PlaybackDescriptor = z.infer<typeof playbackDescriptorSchema>;

export const playbackResponseSchema = z.object({
  data: playbackDescriptorSchema,
});
export type PlaybackResponse = z.infer<typeof playbackResponseSchema>;
