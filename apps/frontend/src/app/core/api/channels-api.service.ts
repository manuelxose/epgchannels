/**
 * `ChannelsApiService` — the catalogue, as the components need it.
 *
 * Responsibilities kept deliberately narrow:
 * - walk the paginated catalogue once and expose it in the UI's own model;
 * - fetch the playback descriptor of one channel (the only source of "what may
 *   be played", never a URL the UI guessed);
 * - expose categories and regions.
 *
 * Everything is provided by our API; there is no third-party request here.
 */
import { Injectable, inject } from '@angular/core';
import type { Channel as ApiChannel, ChannelList as ApiChannelList } from '@tdt/contracts';
import { ApiGateway } from '../api/api.gateway';
import { REBUILD_CONFIG } from '../config/rebuild-config.token';
import { toCategories, toChannel, listToChannel } from '../data/api-mappers';
import type { Channel, ChannelCategory } from '../models/catalog.model';
import type { PlaybackDescriptor } from '@tdt/contracts';

export interface CatalogueLoad {
  readonly channels: readonly Channel[];
  readonly listRecords: readonly ApiChannelList[];
  readonly categories: readonly ChannelCategory[];
  readonly includesThirdPartyData: boolean;
}

@Injectable({ providedIn: 'root' })
export class ChannelsApiService {
  private readonly gateway = inject(ApiGateway);
  private readonly config = inject(REBUILD_CONFIG);

  /** Every published channel, walked page by page (bounded by the API's own cap). */
  async loadCatalogue(signal?: AbortSignal): Promise<CatalogueLoad> {
    const categoriesRequest = this.gateway.client.catalogue.categories(signal ? { signal } : {});
    // If the page walk throws first, nobody awaits `categoriesRequest`; without a
    // handler attached now its rejection surfaces as an unhandled promise later.
    categoriesRequest.catch(() => undefined);
    const listRecords: ApiChannelList[] = [];
    let page = 1;
    let includesThirdPartyData = false;
    for (;;) {
      const response = await this.gateway.client.channels.list({
        page,
        pageSize: this.config.cataloguePageSize,
        ...(signal ? { signal } : {}),
      });
      listRecords.push(...response.data);
      includesThirdPartyData ||= response.attribution.includesThirdPartyData;
      /*
       * The cap is a safety net, not the intended limit: at 100 pages a catalogue
       * above 10 000 channels lost everything after the first 10 000 (measured:
       * with 8 758 channels the walk finished, but the original channels sat
       * beyond an older cap and the UI showed none). 500 pages covers 50 000
       * channels at pageSize 100, and the walk still stops at the real end.
       */
      if (!response.pagination.hasNext || page >= 500) break;
      page += 1;
    }

    // The taxonomies do not depend on the page walk: they are requested alongside
    // the first page and awaited once, so the boot costs one walk, not a walk plus
    // a serial tail.
    const categoriesResponse = await categoriesRequest;
    const categoryNames = new Map(categoriesResponse.data.map((category) => [category.id, category.name]));
    const channels = listRecords.map((record) => listToChannel(record, categoryNames));
    return {
      channels,
      listRecords,
      categories: toCategories(categoriesResponse.data),
      includesThirdPartyData,
    };
  }

  /** Full channel record (sources, provenance, aliases). */
  async getChannel(slug: string, signal?: AbortSignal): Promise<ApiChannel> {
    const response = await this.gateway.client.channels.get(slug, signal ? { signal } : {});
    return response.data;
  }

  /** What may be played for this channel, and why not when nothing is. */
  async getPlayback(slug: string, signal?: AbortSignal): Promise<PlaybackDescriptor> {
    return this.gateway.client.playback.get(slug, signal ? { signal } : {});
  }

  /** The UI model plus the descriptor the player needs. */
  async getChannelWithPlayback(
    slug: string,
    signal?: AbortSignal,
  ): Promise<{ channel: Channel; descriptor: PlaybackDescriptor }> {
    const [channel, descriptor] = await Promise.all([
      this.getChannel(slug, signal),
      this.getPlayback(slug, signal),
    ]);
    return { channel: toChannel(channel, descriptor), descriptor };
  }

  async regions(signal?: AbortSignal): Promise<unknown> {
    return this.gateway.client.catalogue.regions(signal ? { signal } : {});
  }
}
