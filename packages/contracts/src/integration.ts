/**
 * Integration contract for external consumers (GuíaTV).
 *
 * `GuiaTv*` schemas describe the *shape GuíaTV can map onto its own model*,
 * plus the identifier cross-reference table that prevents a second public URL
 * for a channel GuíaTV already identifies.
 */
import { z } from 'zod';
import {
  aliasSchema,
  channelCategorySchema,
  channelKindSchema,
  countryCodeSchema,
  idSchema,
  isoTimestampSchema,
  playbackStatusSchema,
  slugSchema,
} from './common.js';

/** `GET /api/v1/integration/guiatv/channels` item. */
export const guiatvChannelSchema = z.object({
  /** Our canonical identity. */
  tdtId: idSchema,
  /** Public slug both sides agree on. */
  slug: slugSchema,
  name: z.string(),
  shortName: z.string(),
  country: countryCodeSchema,
  regionCode: z.string().nullable(),
  category: channelCategorySchema,
  kind: channelKindSchema,
  playbackStatus: playbackStatusSchema,
  /** Identities this channel is known by elsewhere. */
  aliases: z.array(aliasSchema),
  /** GuiaTV's own slug for this channel, when already mapped. */
  guiatvSlug: z.string().nullable(),
});
export type GuiatvChannel = z.infer<typeof guiatvChannelSchema>;

export const guiatvChannelListResponseSchema = z.object({
  data: z.array(guiatvChannelSchema),
  /** Cursor-free full-catalogue export; consumers page with `page`. */
  total: z.number().int().min(0),
});

/** `GET /api/v1/integration/guiatv/identity-map` — the cross-reference table. */
export const identityMappingSchema = z.object({
  tdtId: idSchema,
  slug: slugSchema,
  guiatvSlug: z.string().nullable(),
  /** How the mapping was established: never guessed silently. */
  match: z.enum(['seed', 'alias', 'manual', 'unmapped']),
  updatedAt: isoTimestampSchema,
});
export type IdentityMapping = z.infer<typeof identityMappingSchema>;

export const identityMapResponseSchema = z.object({
  data: z.array(identityMappingSchema),
  pagination: z.object({
    page: z.number().int(),
    pageSize: z.number().int(),
    total: z.number().int(),
  }),
});

/** Capabilities the consumer can rely on without reading our internals. */
export const integrationManifestSchema = z.object({
  /** API version implemented (`v1`). */
  apiVersion: z.literal('v1'),
  /** Base path of the public API. */
  basePath: z.literal('/api/v1'),
  /** Servers that support server-to-server use without a browser. */
  serverToServer: z.object({ requiresApiKey: z.boolean(), supportsSsr: z.boolean() }),
  /** Playback engines this platform can describe. */
  engines: z.array(z.string()),
  /** Endpoints the consumer may call. */
  endpoints: z.array(z.object({ method: z.string(), path: z.string(), description: z.string() })),
  /** Slug policy the consumer must adopt to avoid duplicate public URLs. */
  slugPolicy: z.object({
    authoritative: z.literal('tdt-platform'),
    guiatvSlugWinsWhenPresent: z.literal(true),
  }),
});
export type IntegrationManifest = z.infer<typeof integrationManifestSchema>;
