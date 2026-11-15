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
});
export type ChannelRef = z.infer<typeof channelRefSchema>;

/** One selectable source option, as the player's source picker needs it. */
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
