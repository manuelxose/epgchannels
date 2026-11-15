export * from './http.js';
export * from './client.js';
export * from './guiatv.js';
/**
 * Wire types generated from the published OpenAPI document. The runtime error
 * class (`ApiError`) keeps its name; the generated error *payload* is exported
 * as `OpenApiErrorBody` so the two cannot be confused.
 */
export type {
  ApiError as OpenApiErrorBody,
  AuditEntry,
  AuditListQuery,
  Category,
  CategoryListResponse,
  ChannelList,
  ChannelListQuery,
  ChannelListResponse,
  ChannelResponse,
  CreateChannelInput,
  CreateSourceInput,
  EpgFeedEntry,
  EpgFeedResponse,
  GuiatvChannel,
  GuiatvChannelListResponse,
  HealthResponse,
  IdentityMapResponse,
  IdentityMapping,
  PlaybackDescriptor,
  PlaybackResponse,
  Programme,
  Provider,
  RegionEntry,
  RegionListResponse,
  ScheduleResponse,
  UpdateChannelInput,
  UpdateSourceInput,
  VerifySourceResult,
} from './generated/openapi-types.js';
export { OPENAPI_OPERATIONS, OPENAPI_VERSION } from './generated/openapi-types.js';
