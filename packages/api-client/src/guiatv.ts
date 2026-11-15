/**
 * GuíaTV integration adapter.
 *
 * Purpose: let a GuíaTV instance consume TDT Platform **without** adopting our
 * internal shape, and without creating a second public URL for a channel GuíaTV
 * already publishes.
 *
 * Design rules enforced here:
 * 1. **No inverse dependency.** GuíaTV talks to us over HTTP when it is asked
 *    to; nothing in this package calls GuíaTV, and TDT Platform never reads it.
 *    If GuíaTV is offline, our own service is unaffected.
 * 2. **Slug authority.** The identity map says which slug is public. When GuíaTV
 *    already has a canonical slug, that slug wins on its side; we never mint a
 *    competing one.
 * 3. **Honest availability.** `resolvePlayback` returns an engine selection you
 *    can hand to an existing player, plus the exact reason when nothing plays.
 *    It never turns `external` into "available".
 * 4. **SSR-safe.** Everything here is plain async code over `fetch`; it runs the
 *    same in a browser, in Node and inside Angular SSR.
 */
import type { Channel, ChannelListResponse, PlaybackDescriptor } from '@tdt/contracts';
import { ApiError, type ClientOptions } from './http.js';
import { createTdtClient, type TdtClient } from './client.js';

/** Engine selection a consumer's player can act on. */
export type EngineSelection =
  | { readonly kind: 'hls'; readonly url: string; readonly sourceId: string }
  | { readonly kind: 'dash'; readonly url: string; readonly sourceId: string }
  | { readonly kind: 'youtube'; readonly url: string; readonly sourceId: string }
  | { readonly kind: 'external'; readonly url: string }
  | { readonly kind: 'none'; readonly reason: string };

export interface GuiaTvChannelLink {
  /** Our canonical identity. */
  readonly tdtId: string;
  /** Public slug on our side. */
  readonly slug: string;
  /** GuíaTV's own canonical slug, when already mapped. */
  readonly guiatvSlug: string | null;
  /** The slug a consumer should publish for this channel. */
  readonly publicSlug: string;
}

export interface GuiaTvAvailability {
  readonly slug: string;
  readonly status: PlaybackDescriptor['playback']['status'];
  readonly selectable: EngineSelection;
  /** Every selectable option, in our preference order. */
  readonly options: ReadonlyArray<EngineSelection>;
  readonly checkedAt: string;
}

export interface GuiaTvPlaybackAdapter {
  /** Catalogue pages, ready to be mapped onto GuíaTV's own model. */
  listChannels(options?: { page?: number; pageSize?: number; signal?: AbortSignal }): Promise<ChannelListResponse>;
  /** Every published channel, paged internally. */
  allChannels(options?: { signal?: AbortSignal }): Promise<Channel[]>;
  /** Full identity cross-reference table. */
  identityMap(options?: { signal?: AbortSignal }): Promise<ReadonlyArray<GuiaTvChannelLink>>;
  /** Resolves one channel by any identity GuíaTV may hold. */
  link(slugOrGuiatvSlug: string, options?: { signal?: AbortSignal }): Promise<GuiaTvChannelLink | null>;
  /** Availability + engine selection for one channel. */
  resolvePlayback(slug: string, options?: { signal?: AbortSignal }): Promise<GuiaTvAvailability>;
  /** Schedule for one channel. */
  schedule(slug: string, options?: { from?: string; hours?: number; signal?: AbortSignal }): Promise<unknown>;
  /** Whether this platform is reachable and serving data. */
  health(options?: { signal?: AbortSignal }): Promise<{ ok: boolean; status: string; detail?: string }>;
}

/** Maps our descriptor onto the engine decision a player needs. */
export function selectEngine(descriptor: PlaybackDescriptor): { primary: EngineSelection; all: EngineSelection[] } {
  const options: EngineSelection[] = [];
  for (const option of descriptor.playback.options) {
    switch (option.engine) {
      case 'hls':
        options.push({ kind: 'hls', url: option.url, sourceId: option.sourceId });
        break;
      case 'dash':
        options.push({ kind: 'dash', url: option.url, sourceId: option.sourceId });
        break;
      case 'youtube-iframe':
        options.push({ kind: 'youtube', url: option.url, sourceId: option.sourceId });
        break;
      case 'official-embed':
        options.push({ kind: 'external', url: option.url });
        break;
      default:
        break;
    }
  }
  const primary = options[0];
  if (primary) return { primary, all: options };
  const externalUrl = descriptor.playback.externalUrl;
  if (externalUrl) {
    return { primary: { kind: 'external', url: externalUrl }, all: [] };
  }
  return {
    primary: { kind: 'none', reason: descriptor.playback.reason ?? 'Sin fuente disponible.' },
    all: [],
  };
}

export interface GuiaTvAdapterOptions extends ClientOptions {
  /** Optional existing client to reuse (e.g. one configured for SSR). */
  readonly client?: TdtClient;
}

export function createGuiaTvPlaybackAdapter(options: GuiaTvAdapterOptions): GuiaTvPlaybackAdapter {
  const client = options.client ?? createTdtClient(options);

  const adapter: GuiaTvPlaybackAdapter = {
    listChannels: (query = {}) =>
      client.channels.list({
        ...(query.page !== undefined ? { page: query.page } : {}),
        ...(query.pageSize !== undefined ? { pageSize: query.pageSize } : {}),
        ...(query.signal ? { signal: query.signal } : {}),
      }),

    allChannels: async (query = {}) => {
      const all = await client.channels.all({ ...(query.signal ? { signal: query.signal } : {}) });
      // The list endpoint returns the trimmed record; callers that need the
      // full record fetch it per channel through `get`.
      return all as unknown as Channel[];
    },

    identityMap: async (query = {}) => {
      const http = new (await import('./http.js')).HttpCore(options);
      const links: GuiaTvChannelLink[] = [];
      for (let page = 1; page <= 100; page += 1) {
        const response = await http.request<{
          data: Array<{ tdtId: string; slug: string; guiatvSlug: string | null }>;
          pagination: { page: number; pageSize: number; total: number };
        }>('GET', '/integration/guiatv/identity-map', {
          query: { page, pageSize: 500 },
          ...(query.signal ? { signal: query.signal } : {}),
        });
        for (const row of response.data) {
          links.push({ ...row, publicSlug: row.guiatvSlug ?? row.slug });
        }
        if (page * response.pagination.pageSize >= response.pagination.total) break;
      }
      return links;
    },

    link: async (slugOrGuiatvSlug, query = {}) => {
      const linkOptions = { ...(query.signal ? { signal: query.signal } : {}) };
      try {
        const channel = await client.channels.get(slugOrGuiatvSlug, linkOptions);
        const guiatvAlias = channel.data.aliases.find((alias) => alias.namespace === 'guiatv');
        return {
          tdtId: channel.data.id,
          slug: channel.data.slug,
          guiatvSlug: guiatvAlias?.value ?? null,
          publicSlug: guiatvAlias?.value ?? channel.data.slug,
        };
      } catch (error) {
        if (!(error instanceof ApiError) || !error.isNotFound) throw error;
      }
      const map = await adapter.identityMap(linkOptions);
      return map.find((entry) => entry.guiatvSlug === slugOrGuiatvSlug) ?? null;
    },

    resolvePlayback: async (slug, query = {}) => {
      const descriptor = await client.playback.get(slug, query);
      const selection = selectEngine(descriptor);
      return {
        slug: descriptor.channel.slug,
        status: descriptor.playback.status,
        selectable: selection.primary,
        options: selection.all,
        checkedAt: descriptor.checkedAt,
      };
    },

    schedule: (slug, query = {}) => client.epg.schedule(slug, query),

    health: async (query = {}) => {
      try {
        const health = await client.system.health(query);
        return { ok: health.status === 'ok', status: health.status };
      } catch (error) {
        return { ok: false, status: 'unreachable', detail: error instanceof Error ? error.message : String(error) };
      }
    },
  };

  return adapter;
}
