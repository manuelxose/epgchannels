// GENERATED — do not edit by hand.
// Source: openapi/openapi.json (TDT Platform API v1).
// Generated: 2026-11-16T08:10:07.483Z

export type ApiError = {
  readonly error: {
    readonly code: "bad_request" | "validation_failed" | "not_found" | "unauthorized" | "forbidden" | "conflict" | "rate_limited" | "payload_too_large" | "unavailable" | "internal_error";
    readonly message: string;
    readonly details?: ReadonlyArray<{
      readonly path: string;
      readonly message: string;
    }>;
  };
  readonly requestId: string;
};

export type HealthResponse = {
  readonly status: "ok" | "degraded" | "down";
  readonly version: string;
  readonly apiVersion: "v1";
  readonly uptimeSeconds: number;
  readonly now: string;
  readonly dependencies: ReadonlyArray<{
    readonly name: string;
    readonly state: "up" | "down" | "disabled" | "degraded";
    readonly latencyMs: number | null;
    readonly message: string | null;
  }>;
  readonly data: {
    readonly channels: number;
    readonly publishedChannels: number;
    readonly sources: number;
    readonly programmes: number;
  };
};

export type ChannelList = {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly shortName: string;
  readonly country: string;
  readonly region: {
    readonly code: string;
    readonly name: string;
  } | null;
  readonly language: string;
  readonly category: "generalista" | "informativos" | "deportes" | "infantil" | "musica" | "cultura" | "cine-series" | "documentales" | "entretenimiento" | "religion" | "local" | "autonomica" | "internacional" | "otros";
  readonly kind: "linear" | "online" | "eventual" | "guide-only";
  readonly playbackStatus: "available" | "degraded" | "external" | "eventual" | "unavailable";
  readonly logoSrc: string | null;
  readonly hasSchedule: boolean;
};

export type ChannelListResponse = {
  readonly data: ReadonlyArray<{
    readonly id: string;
    readonly slug: string;
    readonly name: string;
    readonly shortName: string;
    readonly country: string;
    readonly region: {
      readonly code: string;
      readonly name: string;
    } | null;
    readonly language: string;
    readonly category: "generalista" | "informativos" | "deportes" | "infantil" | "musica" | "cultura" | "cine-series" | "documentales" | "entretenimiento" | "religion" | "local" | "autonomica" | "internacional" | "otros";
    readonly kind: "linear" | "online" | "eventual" | "guide-only";
    readonly playbackStatus: "available" | "degraded" | "external" | "eventual" | "unavailable";
    readonly logoSrc: string | null;
    readonly hasSchedule: boolean;
  }>;
  readonly pagination: {
    readonly page: number;
    readonly pageSize: number;
    readonly total: number;
    readonly pageCount: number;
    readonly hasNext: boolean;
    readonly hasPrevious: boolean;
  };
  readonly attribution: {
    readonly notices: ReadonlyArray<string>;
    readonly includesThirdPartyData: boolean;
  };
};

export type ChannelResponse = {
  readonly data: {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
    readonly shortName: string;
    readonly country: string;
    readonly region: {
      readonly code: string;
      readonly name: string;
    } | null;
    readonly locality: string | null;
    readonly language: string;
    readonly category: "generalista" | "informativos" | "deportes" | "infantil" | "musica" | "cultura" | "cine-series" | "documentales" | "entretenimiento" | "religion" | "local" | "autonomica" | "internacional" | "otros";
    readonly kind: "linear" | "online" | "eventual" | "guide-only";
    readonly websiteUrl: string | null;
    readonly description: string;
    readonly branding: {
      readonly logoSrc: string | null;
      readonly logoSrcPermission: "emitter" | "open-data" | "explicit-permission" | "none";
    };
    readonly editorialStatus: "draft" | "review" | "published" | "withdrawn";
    readonly playbackStatus: "available" | "degraded" | "external" | "eventual" | "unavailable";
    readonly sources: ReadonlyArray<{
      readonly id: string;
      readonly type: "hls" | "dash" | "youtube" | "official-embed" | "external";
      readonly label: string;
      readonly geoRestricted: boolean;
      readonly preferred: boolean;
      readonly engine: "hls" | "dash" | "youtube-iframe" | "official-embed" | "external";
    }>;
    readonly provenance: ReadonlyArray<{
      readonly source: string;
      readonly label: string;
      readonly url: string | null;
      readonly licence: string;
      readonly attribution: string | null;
      readonly digestSha256: string | null;
      readonly capturedAt: string;
      readonly editorial: boolean;
    }>;
    readonly aliases: ReadonlyArray<{
      readonly namespace: string;
      readonly value: string;
    }>;
    readonly hasSchedule: boolean;
    readonly reviewedAt: string | null;
    readonly updatedAt: string;
  };
  readonly attribution: {
    readonly notices: ReadonlyArray<string>;
    readonly includesThirdPartyData: boolean;
  };
};

export type PlaybackDescriptor = {
  readonly channel: {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
  };
  readonly playback: {
    readonly status: "available" | "degraded" | "external" | "eventual" | "unavailable";
    readonly engine: "hls" | "dash" | "youtube-iframe" | "official-embed" | "external" | "none";
    readonly type: "hls" | "dash" | "youtube" | "official-embed" | "external";
    readonly sourceId: string | null;
    readonly url: string | null;
    readonly externalUrl: string | null;
    readonly options: ReadonlyArray<{
      readonly sourceId: string;
      readonly label: string;
      readonly type: "hls" | "dash" | "youtube" | "official-embed" | "external";
      readonly engine: "hls" | "dash" | "youtube-iframe" | "official-embed" | "external" | "none";
      readonly url: string;
      readonly externalUrl: string | null;
      readonly geoRestricted: boolean;
      readonly preferred: boolean;
    }>;
    readonly reason: string | null;
  };
  readonly checkedAt: string;
  readonly issues: ReadonlyArray<{
    readonly kind: "verification" | "policy";
    readonly code: string;
    readonly message: string;
    readonly observedAt: string | null;
  }>;
};

export type PlaybackResponse = {
  readonly data: {
    readonly channel: {
      readonly id: string;
      readonly slug: string;
      readonly name: string;
    };
    readonly playback: {
      readonly status: "available" | "degraded" | "external" | "eventual" | "unavailable";
      readonly engine: "hls" | "dash" | "youtube-iframe" | "official-embed" | "external" | "none";
      readonly type: "hls" | "dash" | "youtube" | "official-embed" | "external";
      readonly sourceId: string | null;
      readonly url: string | null;
      readonly externalUrl: string | null;
      readonly options: ReadonlyArray<{
        readonly sourceId: string;
        readonly label: string;
        readonly type: "hls" | "dash" | "youtube" | "official-embed" | "external";
        readonly engine: "hls" | "dash" | "youtube-iframe" | "official-embed" | "external" | "none";
        readonly url: string;
        readonly externalUrl: string | null;
        readonly geoRestricted: boolean;
        readonly preferred: boolean;
      }>;
      readonly reason: string | null;
    };
    readonly checkedAt: string;
    readonly issues: ReadonlyArray<{
      readonly kind: "verification" | "policy";
      readonly code: string;
      readonly message: string;
      readonly observedAt: string | null;
    }>;
  };
};

export type Programme = {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly genre: string | null;
  readonly coverUrl: string | null;
  readonly start: string;
  readonly end: string;
};

export type ScheduleResponse = {
  readonly data: {
    readonly channel: {
      readonly id: string;
      readonly slug: string;
      readonly name: string;
    };
    readonly timezone: string;
    readonly availability: "available" | "empty" | "not-mapped" | "withdrawn";
    readonly now: {
      readonly id: string;
      readonly title: string;
      readonly description: string;
      readonly genre: string | null;
      readonly coverUrl: string | null;
      readonly start: string;
      readonly end: string;
    };
    readonly next: ReadonlyArray<{
      readonly id: string;
      readonly title: string;
      readonly description: string;
      readonly genre: string | null;
      readonly coverUrl: string | null;
      readonly start: string;
      readonly end: string;
    }>;
    readonly programmes: ReadonlyArray<{
      readonly id: string;
      readonly title: string;
      readonly description: string;
      readonly genre: string | null;
      readonly coverUrl: string | null;
      readonly start: string;
      readonly end: string;
    }>;
    readonly asOf: string;
    readonly provenance: {
      readonly sourceId: string | null;
      readonly sourceName: string | null;
      readonly licence: string | null;
      readonly attribution: string | null;
      readonly editedAt: string | null;
    };
    readonly updatedAt: string | null;
  };
  readonly attribution: {
    readonly notices: ReadonlyArray<string>;
    readonly includesThirdPartyData: boolean;
  };
};

export type EpgFeedEntry = {
  readonly channel: {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
  };
  readonly timezone: string;
  readonly availability: "available" | "empty" | "not-mapped" | "withdrawn";
  readonly programme: {
    readonly id: string;
    readonly title: string;
    readonly description: string;
    readonly genre: string | null;
    readonly coverUrl: string | null;
    readonly start: string;
    readonly end: string;
  };
  readonly provenance: {
    readonly sourceId: string | null;
    readonly sourceName: string | null;
    readonly licence: string | null;
    readonly attribution: string | null;
    readonly editedAt: string | null;
  };
};

export type EpgFeedResponse = {
  readonly data: ReadonlyArray<{
    readonly channel: {
      readonly id: string;
      readonly slug: string;
      readonly name: string;
    };
    readonly timezone: string;
    readonly availability: "available" | "empty" | "not-mapped" | "withdrawn";
    readonly programme: {
      readonly id: string;
      readonly title: string;
      readonly description: string;
      readonly genre: string | null;
      readonly coverUrl: string | null;
      readonly start: string;
      readonly end: string;
    };
    readonly provenance: {
      readonly sourceId: string | null;
      readonly sourceName: string | null;
      readonly licence: string | null;
      readonly attribution: string | null;
      readonly editedAt: string | null;
    };
  }>;
  readonly asOf: string;
  readonly attribution: {
    readonly notices: ReadonlyArray<string>;
    readonly includesThirdPartyData: boolean;
  };
};

export type Category = {
  readonly id: "generalista" | "informativos" | "deportes" | "infantil" | "musica" | "cultura" | "cine-series" | "documentales" | "entretenimiento" | "religion" | "local" | "autonomica" | "internacional" | "otros";
  readonly name: string;
  readonly channelCount: number;
  readonly playableCount: number;
};

export type CategoryListResponse = {
  readonly data: ReadonlyArray<{
    readonly id: "generalista" | "informativos" | "deportes" | "infantil" | "musica" | "cultura" | "cine-series" | "documentales" | "entretenimiento" | "religion" | "local" | "autonomica" | "internacional" | "otros";
    readonly name: string;
    readonly channelCount: number;
    readonly playableCount: number;
  }>;
  readonly attribution: {
    readonly notices: ReadonlyArray<string>;
    readonly includesThirdPartyData: boolean;
  };
};

export type RegionEntry = {
  readonly country: string;
  readonly code: string;
  readonly name: string;
  readonly channelCount: number;
  readonly playableCount: number;
};

export type RegionListResponse = {
  readonly data: ReadonlyArray<{
    readonly country: string;
    readonly code: string;
    readonly name: string;
    readonly channelCount: number;
    readonly playableCount: number;
  }>;
  readonly attribution: {
    readonly notices: ReadonlyArray<string>;
    readonly includesThirdPartyData: boolean;
  };
};

export type GuiatvChannel = {
  readonly tdtId: string;
  readonly slug: string;
  readonly name: string;
  readonly shortName: string;
  readonly country: string;
  readonly regionCode: string | null;
  readonly category: "generalista" | "informativos" | "deportes" | "infantil" | "musica" | "cultura" | "cine-series" | "documentales" | "entretenimiento" | "religion" | "local" | "autonomica" | "internacional" | "otros";
  readonly kind: "linear" | "online" | "eventual" | "guide-only";
  readonly playbackStatus: "available" | "degraded" | "external" | "eventual" | "unavailable";
  readonly aliases: ReadonlyArray<{
    readonly namespace: string;
    readonly value: string;
  }>;
  readonly guiatvSlug: string | null;
};

export type GuiatvChannelListResponse = {
  readonly data: ReadonlyArray<{
    readonly tdtId: string;
    readonly slug: string;
    readonly name: string;
    readonly shortName: string;
    readonly country: string;
    readonly regionCode: string | null;
    readonly category: "generalista" | "informativos" | "deportes" | "infantil" | "musica" | "cultura" | "cine-series" | "documentales" | "entretenimiento" | "religion" | "local" | "autonomica" | "internacional" | "otros";
    readonly kind: "linear" | "online" | "eventual" | "guide-only";
    readonly playbackStatus: "available" | "degraded" | "external" | "eventual" | "unavailable";
    readonly aliases: ReadonlyArray<{
      readonly namespace: string;
      readonly value: string;
    }>;
    readonly guiatvSlug: string | null;
  }>;
  readonly total: number;
};

export type IdentityMapping = {
  readonly tdtId: string;
  readonly slug: string;
  readonly guiatvSlug: string | null;
  readonly match: "seed" | "alias" | "manual" | "unmapped";
  readonly updatedAt: string;
};

export type IdentityMapResponse = {
  readonly data: ReadonlyArray<{
    readonly tdtId: string;
    readonly slug: string;
    readonly guiatvSlug: string | null;
    readonly match: "seed" | "alias" | "manual" | "unmapped";
    readonly updatedAt: string;
  }>;
  readonly pagination: {
    readonly page: number;
    readonly pageSize: number;
    readonly total: number;
  };
};

export type Provider = {
  readonly id: string;
  readonly name: string;
  readonly types: ReadonlyArray<"hls" | "dash" | "youtube" | "official-embed" | "external">;
  readonly requirements: ReadonlyArray<string>;
  readonly credentialFree: boolean;
  readonly enabled: boolean;
  readonly description: string;
};

export type AuditEntry = {
  readonly id: string;
  readonly actor: {
    readonly type: "user" | "system" | "anonymous";
    readonly id: string;
  };
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly before: Readonly<Record<string, unknown>> | null;
  readonly after: Readonly<Record<string, unknown>> | null;
  readonly reason: string | null;
  readonly requestId: string;
  readonly at: string;
};

export type VerifySourceResult = {
  readonly sourceId: string;
  readonly status: "ok" | "unreachable" | "http-error" | "invalid-manifest" | "unknown" | "blocked";
  readonly httpStatus: number | null;
  readonly checkedAt: string;
  readonly message: string | null;
};

export type CreateChannelInput = {
  readonly name: string;
  readonly shortName?: string;
  readonly country: string;
  readonly region?: {
    readonly code: string;
    readonly name: string;
  } | null;
  readonly locality?: string | null;
  readonly language?: string;
  readonly category: "generalista" | "informativos" | "deportes" | "infantil" | "musica" | "cultura" | "cine-series" | "documentales" | "entretenimiento" | "religion" | "local" | "autonomica" | "internacional" | "otros";
  readonly kind?: "linear" | "online" | "eventual" | "guide-only";
  readonly websiteUrl?: string | null;
  readonly description?: string;
  readonly timezone?: string;
  readonly branding?: {
    readonly logoSrc: string | null;
    readonly logoSrcPermission: "emitter" | "open-data" | "explicit-permission" | "none";
  };
  readonly aliases?: ReadonlyArray<{
    readonly namespace: string;
    readonly value: string;
  }>;
  readonly slug?: string;
  readonly editorialStatus?: "draft" | "review" | "published" | "withdrawn";
  readonly provenance: ReadonlyArray<{
    readonly source: string;
    readonly label: string;
    readonly url: string | null;
    readonly licence: string;
    readonly attribution: string | null;
    readonly editorial: boolean;
  }>;
  readonly externalRef?: string;
};

export type UpdateChannelInput = {
  readonly name?: string;
  readonly shortName?: string;
  readonly country?: string;
  readonly region?: {
    readonly code: string;
    readonly name: string;
  } | null;
  readonly locality?: string | null;
  readonly language?: string;
  readonly category?: "generalista" | "informativos" | "deportes" | "infantil" | "musica" | "cultura" | "cine-series" | "documentales" | "entretenimiento" | "religion" | "local" | "autonomica" | "internacional" | "otros";
  readonly kind?: "linear" | "online" | "eventual" | "guide-only";
  readonly websiteUrl?: string | null;
  readonly description?: string;
  readonly timezone?: string;
  readonly branding?: {
    readonly logoSrc: string | null;
    readonly logoSrcPermission: "emitter" | "open-data" | "explicit-permission" | "none";
  };
  readonly aliases?: ReadonlyArray<{
    readonly namespace: string;
    readonly value: string;
  }>;
  readonly slug?: string;
  readonly editorialStatus?: "draft" | "review" | "published" | "withdrawn";
  readonly expectedUpdatedAt?: string;
  readonly reason?: string;
};

export type CreateSourceInput = {
  readonly channelId: string;
  readonly provider: string;
  readonly type: "hls" | "dash" | "youtube" | "official-embed" | "external";
  readonly url: string | null;
  readonly officialPageUrl?: string | null;
  readonly permission: "emitter-public-stream" | "emitter-embeddable" | "official-player-only" | "open-data-licence" | "explicit-permission" | "unlicensed";
  readonly authorisationEvidence?: string | null;
  readonly conditions: {
    readonly embedAllowed: boolean;
    readonly proxyAllowed: boolean;
    readonly worldwide: boolean;
    readonly restrictedRegions: ReadonlyArray<string>;
    readonly browserCompatibility: "all" | "desktop" | "mobile";
    readonly requiresForgedHeader: boolean;
    readonly emitterAppOnly: boolean;
    readonly notes?: string | null;
  };
  readonly priority?: number;
  readonly editorialStatus?: "draft" | "review" | "published" | "withdrawn";
};

export type UpdateSourceInput = {
  readonly provider?: string;
  readonly url?: string | null;
  readonly officialPageUrl?: string | null;
  readonly permission?: "emitter-public-stream" | "emitter-embeddable" | "official-player-only" | "open-data-licence" | "explicit-permission" | "unlicensed";
  readonly authorisationEvidence?: string | null;
  readonly conditions?: {
    readonly embedAllowed?: boolean;
    readonly proxyAllowed?: boolean;
    readonly worldwide?: boolean;
    readonly restrictedRegions?: ReadonlyArray<string>;
    readonly browserCompatibility?: "all" | "desktop" | "mobile";
    readonly requiresForgedHeader?: boolean;
    readonly emitterAppOnly?: boolean;
    readonly notes?: string | null;
  };
  readonly priority?: number;
  readonly editorialStatus?: "draft" | "review" | "published" | "withdrawn";
  readonly technicalStatus?: "ok" | "unreachable" | "http-error" | "invalid-manifest" | "unknown" | "blocked";
  readonly expectedUpdatedAt?: string;
  readonly reason?: string;
};

export type ChannelListQuery = {
  readonly page?: number;
  readonly pageSize?: number;
  readonly q?: string;
  readonly country?: string;
  readonly region?: string;
  readonly category?: "generalista" | "informativos" | "deportes" | "infantil" | "musica" | "cultura" | "cine-series" | "documentales" | "entretenimiento" | "religion" | "local" | "autonomica" | "internacional" | "otros";
  readonly language?: string;
  readonly playable?: boolean | "true" | "false" | "1" | "0";
  readonly sort?: "name" | "name-desc" | "updated" | "relevance";
};

export type AuditListQuery = {
  readonly page?: number;
  readonly pageSize?: number;
  readonly entityType?: string;
  readonly entityId?: string;
  readonly action?: string;
};

/** Every documented operation, as generated from the contract. */
export const OPENAPI_OPERATIONS = {
  getHealth: { method: "GET", path: "/health" },
  listChannels: { method: "GET", path: "/channels" },
  getChannel: { method: "GET", path: "/channels/{slug}" },
  getPlayback: { method: "GET", path: "/channels/{slug}/playback" },
  getSchedule: { method: "GET", path: "/channels/{slug}/schedule" },
  getEpgNow: { method: "GET", path: "/epg/now" },
  getEpgNext: { method: "GET", path: "/epg/next" },
  listCategories: { method: "GET", path: "/categories" },
  listRegions: { method: "GET", path: "/regions" },
  getIntegrationManifest: { method: "GET", path: "/integration/manifest" },
  listGuiaTvChannels: { method: "GET", path: "/integration/guiatv/channels" },
  getGuiaTvIdentityMap: { method: "GET", path: "/integration/guiatv/identity-map" },
  adminListChannels: { method: "GET", path: "/admin/channels" },
  adminCreateChannel: { method: "POST", path: "/admin/channels" },
  adminUpdateChannel: { method: "PATCH", path: "/admin/channels/{id}" },
  adminCreateSource: { method: "POST", path: "/admin/sources" },
  adminUpdateSource: { method: "PATCH", path: "/admin/sources/{id}" },
  adminVerifySource: { method: "POST", path: "/admin/sources/{id}/verify" },
  adminListAudits: { method: "GET", path: "/admin/audits" },
  adminListProviders: { method: "GET", path: "/admin/providers" },
} as const;

export const OPENAPI_VERSION = "3.1.0";
