/**
 * Shared request-validation schemas, re-exported from the contract package so a
 * route can never validate against a schema the client does not know.
 */
export {
  channelListQuerySchema,
  channelSortSchema,
  categorySchema,
  regionEntrySchema,
  epgFeedQuerySchema,
  scheduleQuerySchema,
  auditListQuerySchema,
  createChannelInputSchema,
  updateChannelInputSchema,
  mergeChannelInputSchema,
  createSourceInputSchema,
  updateSourceInputSchema,
  providerSchema,
  apiErrorSchema,
  healthResponseSchema,
} from '@tdt/contracts';

export const apiVersion = 'v1' as const;
