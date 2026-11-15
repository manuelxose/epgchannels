/**
 * Typed client for the TDT Platform API v1.
 *
 * The public surface is intentionally small and stable:
 *
 * ```ts
 * const tdt = createTdtClient({ baseUrl: 'https://api.example.org/api/v1' });
 * const page = await tdt.channels.list({ q: 'la 1' });
 * const playback = await tdt.playback.get('la-1');
 * const schedule = await tdt.epg.schedule('la-1');
 * ```
 *
 * Every selector is a public slug. Internal identifiers never appear in a URL.
 */
import type {
  CategoryListResponse,
  ChannelListQuery,
  ChannelListResponse,
  ChannelResponse,
  EpgFeedEntry,
  HealthResponse,
  PlaybackDescriptor,
  PlaybackResponse,
  ScheduleResponse,
} from '@tdt/contracts';
import { HttpCore, type ClientOptions, type RequestOptions } from './http.js';

export interface ChannelsApi {
  list(query?: Partial<ChannelListQuery> & { signal?: AbortSignal }): Promise<ChannelListResponse>;
  get(slug: string, options?: { signal?: AbortSignal }): Promise<ChannelResponse>;
  all(query?: Partial<ChannelListQuery> & { signal?: AbortSignal }): Promise<ChannelListResponse['data']>;
}

export interface PlaybackApi {
  get(slug: string, options?: { signal?: AbortSignal }): Promise<PlaybackDescriptor>;
}

export interface EpgApi {
  schedule(
    slug: string,
    options?: { from?: string; hours?: number; signal?: AbortSignal },
  ): Promise<ScheduleResponse>;
  now(options?: { channel?: string[]; country?: string; category?: string; limit?: number; from?: string; signal?: AbortSignal }): Promise<EpgFeedEntry[]>;
  next(options?: { channel?: string[]; country?: string; category?: string; limit?: number; from?: string; signal?: AbortSignal }): Promise<EpgFeedEntry[]>;
}

export interface CatalogueApi {
  categories(options?: { signal?: AbortSignal }): Promise<CategoryListResponse>;
  regions(options?: { signal?: AbortSignal }): Promise<unknown>;
}

export interface SystemApi {
  health(options?: { signal?: AbortSignal }): Promise<HealthResponse>;
}

export interface TdtClient {
  readonly channels: ChannelsApi;
  readonly playback: PlaybackApi;
  readonly epg: EpgApi;
  readonly catalogue: CatalogueApi;
  readonly system: SystemApi;
  /** Clears cached validators, e.g. after the server signals a change. */
  invalidate(): void;
}

export function createTdtClient(options: ClientOptions): TdtClient {
  const http = new HttpCore(options);

  const toRequest = (options?: { signal?: AbortSignal } | undefined): RequestOptions => ({
    ...(options?.signal ? { signal: options.signal } : {}),
  });

  const channels: ChannelsApi = {
    list: (query = {}) =>
      http.request<ChannelListResponse>('GET', '/channels', {
        query: {
          page: query.page,
          pageSize: query.pageSize,
          q: query.q,
          country: query.country,
          region: query.region,
          category: query.category,
          language: query.language,
          playable: query.playable,
          sort: query.sort,
        },
        ...(query.signal ? { signal: query.signal } : {}),
      }),
    get: (slug, requestOptions) =>
      http.request<ChannelResponse>('GET', `/channels/${encodeURIComponent(slug)}`, toRequest(requestOptions)),
    /**
     * Pages through the catalogue. Bounded: stops at `maxPages` (default 100)
     * so a misconfigured consumer cannot loop forever.
     */
    all: async (query = {}) => {
      const pageSize = query.pageSize ?? 100;
      const maxPages = 100;
      const collected: ChannelListResponse['data'][number][] = [];
      for (let page = 1; page <= maxPages; page += 1) {
        const response = await channels.list({ ...query, page, pageSize });
        collected.push(...response.data);
        if (!response.pagination.hasNext) break;
      }
      return collected;
    },
  };

  const playback: PlaybackApi = {
    get: async (slug, requestOptions) => {
      const response = await http.request<PlaybackResponse>(
        'GET',
        `/channels/${encodeURIComponent(slug)}/playback`,
        toRequest(requestOptions),
      );
      return response.data;
    },
  };

  const epg: EpgApi = {
    schedule: (slug, requestOptions = {}) =>
      http.request<ScheduleResponse>('GET', `/channels/${encodeURIComponent(slug)}/schedule`, {
        query: { from: requestOptions.from, hours: requestOptions.hours },
        ...(requestOptions.signal ? { signal: requestOptions.signal } : {}),
      }),
    now: async (requestOptions = {}) => {
      const response = await http.request<{ data: EpgFeedEntry[] }>('GET', '/epg/now', {
        query: {
          channel: requestOptions.channel,
          country: requestOptions.country,
          category: requestOptions.category,
          limit: requestOptions.limit,
          from: requestOptions.from,
        },
        ...(requestOptions.signal ? { signal: requestOptions.signal } : {}),
      });
      return response.data;
    },
    next: async (requestOptions = {}) => {
      const response = await http.request<{ data: EpgFeedEntry[] }>('GET', '/epg/next', {
        query: {
          channel: requestOptions.channel,
          country: requestOptions.country,
          category: requestOptions.category,
          limit: requestOptions.limit,
          from: requestOptions.from,
        },
        ...(requestOptions.signal ? { signal: requestOptions.signal } : {}),
      });
      return response.data;
    },
  };

  const catalogue: CatalogueApi = {
    categories: (requestOptions) => http.request<CategoryListResponse>('GET', '/categories', toRequest(requestOptions)),
    regions: (requestOptions) => http.request('GET', '/regions', toRequest(requestOptions)),
  };

  const system: SystemApi = {
    health: (requestOptions) => http.request<HealthResponse>('GET', '/health', toRequest(requestOptions)),
  };

  return {
    channels,
    playback,
    epg,
    catalogue,
    system,
    invalidate: () => http.clearCache(),
  };
}
