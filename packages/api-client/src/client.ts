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
  ChannelAvailabilityResponse,
  ChannelListQuery,
  ChannelListResponse,
  ChannelResponse,
  CountryListResponse,
  EpgFeedEntry,
  HealthResponse,
  LanguageListResponse,
  PlaybackDescriptor,
  ScheduleResponse,
} from '@tdt/contracts';
import { HttpCore, type ClientOptions, type RequestOptions } from './http.js';
import { describePlayback, type WirePlaybackDescriptor } from './wire.js';

export interface ChannelsApi {
  list(query?: Partial<ChannelListQuery> & { signal?: AbortSignal }): Promise<ChannelListResponse>;
  get(slug: string, options?: { signal?: AbortSignal }): Promise<ChannelResponse>;
  all(query?: Partial<ChannelListQuery> & { signal?: AbortSignal }): Promise<ChannelListResponse['data']>;
  /** Public availability aggregate: authorisation-first, never a stream URL. */
  availability(slug: string, options?: { signal?: AbortSignal }): Promise<ChannelAvailabilityResponse>;
  /**
   * The complete guide day of one channel.
   *
   * `date` (`YYYY-MM-DD`, read in the channel's zone) or `from` + `hours`
   * (explicit window); the two are mutually exclusive.
   */
  epg(
    slug: string,
    options?: { date?: string; timezone?: string; from?: string; hours?: number; signal?: AbortSignal },
  ): Promise<ScheduleResponse>;
}

export interface PlaybackApi {
  get(slug: string, options?: { signal?: AbortSignal }): Promise<PlaybackDescriptor>;
}

export interface EpgApi {
  schedule(
    slug: string,
    options?: { from?: string; hours?: number; signal?: AbortSignal },
  ): Promise<ScheduleResponse>;
  now(options?: {
    channel?: string[];
    country?: string;
    category?: string;
    limit?: number;
    from?: string;
    signal?: AbortSignal;
  }): Promise<EpgFeedEntry[]>;
  next(options?: {
    channel?: string[];
    country?: string;
    category?: string;
    limit?: number;
    from?: string;
    signal?: AbortSignal;
  }): Promise<EpgFeedEntry[]>;
}

/**
 * `/countries/{code}/regions` response.
 *
 * The rows reuse the published `/regions` fields and add `aggregate`, which marks
 * the `INTL` row folding channels with no region assigned. That row exists so the
 * counts add up; a client must not offer it as a filter value.
 */
export interface CountryRegionsResponse {
  readonly country: CountryListResponse['data'][number];
  readonly data: ReadonlyArray<{
    readonly country: string;
    readonly code: string;
    readonly name: string;
    readonly channelCount: number;
    readonly playableCount: number;
    readonly aggregate: boolean;
  }>;
  readonly attribution: { readonly notices: readonly string[]; readonly includesThirdPartyData: boolean };
}

export interface CatalogueApi {
  categories(options?: { signal?: AbortSignal }): Promise<CategoryListResponse>;
  regions(options?: { signal?: AbortSignal }): Promise<unknown>;
  /** Countries with real counts, including the `INT` international aggregate. */
  countries(options?: { signal?: AbortSignal }): Promise<CountryListResponse>;
  /** Regions of one country, with counts. `code` is ISO alpha-2 or `INT`. */
  countryRegions(code: string, options?: { signal?: AbortSignal }): Promise<CountryRegionsResponse>;
  /** Languages the catalogue declares, including the `multi` marker. */
  languages(options?: { signal?: AbortSignal }): Promise<LanguageListResponse>;
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
  /** Clears cached validators, e.g. after an editorial change. */
  invalidate(): void;
}

export function createTdtClient(options: ClientOptions): TdtClient {
  const http = new HttpCore(options);

  const toRequest = (requestOptions?: { signal?: AbortSignal } | undefined): RequestOptions => ({
    ...(requestOptions?.signal ? { signal: requestOptions.signal } : {}),
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
     * Walks the catalogue page by page. Bounded at 100 pages so a misconfigured
     * consumer cannot loop forever.
     */
    all: async (query = {}) => {
      const pageSize = query.pageSize ?? 100;
      const collected: ChannelListResponse['data'][number][] = [];
      for (let page = 1; page <= 100; page += 1) {
        const response = await channels.list({ ...query, page, pageSize });
        collected.push(...response.data);
        if (!response.pagination.hasNext) break;
      }
      return collected;
    },
    availability: (slug, requestOptions) =>
      http.request<ChannelAvailabilityResponse>(
        'GET',
        `/channels/${encodeURIComponent(slug)}/availability`,
        toRequest(requestOptions),
      ),
    epg: (slug, requestOptions = {}) =>
      http.request<ScheduleResponse>('GET', `/channels/${encodeURIComponent(slug)}/epg`, {
        query: {
          date: requestOptions.date,
          timezone: requestOptions.timezone,
          from: requestOptions.from,
          hours: requestOptions.hours,
        },
        ...(requestOptions.signal ? { signal: requestOptions.signal } : {}),
      }),
  };

  const playback: PlaybackApi = {
    get: async (slug, requestOptions) => {
      const response = await http.request<{ data: WirePlaybackDescriptor }>(
        'GET',
        `/channels/${encodeURIComponent(slug)}/playback`,
        toRequest(requestOptions),
      );
      return describePlayback(response.data);
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
    categories: (requestOptions) =>
      http.request<CategoryListResponse>('GET', '/categories', toRequest(requestOptions)),
    regions: (requestOptions) => http.request('GET', '/regions', toRequest(requestOptions)),
    countries: (requestOptions) =>
      http.request<CountryListResponse>('GET', '/countries', toRequest(requestOptions)),
    countryRegions: (code, requestOptions) =>
      http.request<CountryRegionsResponse>(
        'GET',
        `/countries/${encodeURIComponent(code)}/regions`,
        toRequest(requestOptions),
      ),
    languages: (requestOptions) =>
      http.request<LanguageListResponse>('GET', '/languages', toRequest(requestOptions)),
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
