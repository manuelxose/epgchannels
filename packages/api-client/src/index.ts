export * from './http.js';
export * from './client.js';
export * from './guiatv.js';
export * from './wire.js';
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
  ChannelAvailability,
  ChannelAvailabilityResponse,
  ChannelList,
  ChannelListQuery,
  ChannelListResponse,
  ChannelResponse,
  CountryEntry,
  CountryListResponse,
  CountryRegionEntry,
  CountryRegionsResponse,
  CreateChannelInput,
  CreateSourceInput,
  EpgCoverageEntry,
  EpgCoverageResponse,
  EpgFeedEntry,
  EpgFeedResponse,
  GuiatvChannel,
  GuiatvChannelListResponse,
  HealthResponse,
  IdentityMapResponse,
  IdentityMapping,
  LanguageEntry,
  LanguageListResponse,
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

// Authoritative domain types, shared with the backend's Zod contracts. These are
// what consumers (and the frontend) build against: the generated wire types
// document the transport, these define the meaning.
export type {
  Alias,
  Attribution,
  Channel,
  ChannelCategory,
  ChannelKind,
  ChannelSourceSummary,
  ExclusionReason,
  Pagination,
  Permission,
  PlaybackEngine,
  PlaybackOption,
  PlaybackStatus,
  PlaybackType,
  Provenance,
  TechnicalStatus,
} from '@tdt/contracts';
