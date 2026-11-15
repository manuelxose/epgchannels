/**
 * Shared request-validation schemas.
 *
 * Re-exported from the contract package so a route can never validate against a
 * schema the client does not know, and the OpenAPI document is generated from
 * the very same objects.
 */
export {
  apiErrorSchema,
  auditEntrySchema,
  auditListQuerySchema,
  categorySchema,
  channelListQuerySchema,
  channelListResponseSchema,
  channelListSchema,
  channelResponseSchema,
  channelSortSchema,
  createChannelInputSchema,
  createSourceInputSchema,
  epgFeedEntrySchema,
  epgFeedQuerySchema,
  guiatvChannelSchema,
  healthResponseSchema,
  identityMappingSchema,
  mergeChannelInputSchema,
  playbackDescriptorSchema,
  programmeSchema,
  providerSchema,
  regionEntrySchema,
  scheduleQuerySchema,
  scheduleResponseSchema,
  updateChannelInputSchema,
  updateSourceInputSchema,
  verifySourceResultSchema,
} from '@tdt/contracts';

export const apiVersion = 'v1' as const;
