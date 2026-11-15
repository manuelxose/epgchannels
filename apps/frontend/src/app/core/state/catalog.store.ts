import { Injectable, inject, signal, computed } from '@angular/core';
import { REBUILD_CONFIG } from '../config/rebuild-config.token';
import { ChannelsApiService } from '../api/channels-api.service';
import { EpgApiService } from '../api/epg-api.service';
import { ApiGateway } from '../api/api.gateway';
import type { CatalogSnapshot, Channel, ChannelSchedule, EpgSnapshot } from '../models/catalog.model';

export type CatalogStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * Single source of truth for catalogue and programme-guide data.
 *
 * Data now comes **exclusively** from our own API (`ChannelsApiService`,
 * `EpgApiService`). There is no fallback to a third-party catalogue: if the API
 * cannot be reached the UI says so, because falling back to foreign data would
 * reintroduce exactly the dependency this milestone removes.
 *
 * A failed guide still never blocks the catalogue.
 */
@Injectable({ providedIn: 'root' })
export class CatalogStore {
  private readonly config = inject(REBUILD_CONFIG);
  private readonly channelsApi = inject(ChannelsApiService);
  private readonly epgApi = inject(EpgApiService);

  private readonly catalogState = signal<CatalogSnapshot | undefined>(undefined);
  private readonly catalogStatusState = signal<CatalogStatus>('idle');
  private readonly catalogErrorState = signal<string | undefined>(undefined);
  private readonly epgState = signal<EpgSnapshot | undefined>(undefined);
  private readonly epgStatusState = signal<CatalogStatus>('idle');

  readonly channels = computed<readonly Channel[]>(() => this.catalogState()?.channels ?? []);
  readonly categories = computed(() => this.catalogState()?.categories ?? []);
  readonly catalog = computed(() => this.catalogState());
  readonly status = this.catalogStatusState.asReadonly();
  readonly error = this.catalogErrorState.asReadonly();
  readonly epg = computed<EpgSnapshot | undefined>(() => this.epgState());
  readonly epgStatus = this.epgStatusState.asReadonly();
  /** True when the catalogue carries third-party reference metadata (attribution shown). */
  readonly usingDemoCatalog = computed(() => this.catalogState()?.origin === 'demo');

  private channelIndex = computed(() => {
    const map = new Map<string, Channel>();
    for (const channel of this.channels()) {
      map.set(channel.id, channel);
    }
    return map;
  });

  private loadedAt = 0;
  private inFlight: Promise<void> | undefined;

  channelById(id: string | null | undefined): Channel | undefined {
    return id ? this.channelIndex().get(id) : undefined;
  }

  /** The guide of one channel, keyed by its public slug. */
  scheduleFor(channel: Channel | undefined): ChannelSchedule | undefined {
    if (!channel) {
      return undefined;
    }
    return this.epgState()?.schedules.get(channel.id);
  }

  async ensureCatalog(): Promise<void> {
    if (this.catalogStatusState() === 'ready') {
      return;
    }
    if (this.inFlight) {
      return this.inFlight;
    }
    this.catalogStatusState.set('loading');
    this.catalogErrorState.set(undefined);
    this.inFlight = (async () => {
      try {
        const loaded = await this.channelsApi.loadCatalogue();
        this.catalogState.set({
          channels: loaded.channels,
          categories: loaded.categories,
          updatedAt: new Date().toISOString(),
          origin: loaded.includesThirdPartyData ? 'remote' : 'demo',
          rejected: 0,
        });
        this.catalogStatusState.set('ready');
        void this.ensureEpg();
      } catch (error) {
        this.catalogStatusState.set('error');
        this.catalogErrorState.set(ApiGateway.describe(error));
      } finally {
        this.inFlight = undefined;
      }
    })();
    return this.inFlight;
  }

  /** Forces a catalogue reload (used by the retry action). */
  async reloadCatalog(): Promise<void> {
    this.catalogStatusState.set('idle');
    this.catalogState.set(undefined);
    await this.ensureCatalog();
  }

  /**
   * Loads the guide of the given channels (default: the first page). The API
   * answers per channel, so this stays bounded instead of downloading a guide
   * for the whole catalogue on every visit.
   */
  async ensureEpg(slugs: readonly string[] = [], force = false): Promise<void> {
    const fresh = Date.now() - this.loadedAt < this.config.epgRefreshMs;
    if (!force && fresh && this.epgStatusState() === 'ready') {
      return;
    }
    const targets = slugs.length > 0 ? slugs : this.channels().slice(0, 21).map((channel) => channel.id);
    if (targets.length === 0) {
      return;
    }
    this.epgStatusState.set('loading');
    try {
      const snapshot = await this.epgApi.schedules(targets, { hours: 24 });
      this.epgState.set(snapshot);
      this.epgStatusState.set('ready');
      this.loadedAt = Date.now();
    } catch {
      // The catalogue stays usable without a guide; the UI shows none.
      this.epgStatusState.set('error');
    }
  }

  /** Loads one channel's full record (sources + descriptor) on demand. */
  async ensureChannelDetail(slug: string): Promise<Channel | undefined> {
    const existing = this.channelById(slug);
    if (existing && existing.sources.length > 0) {
      return existing;
    }
    try {
      const { channel } = await this.channelsApi.getChannelWithPlayback(slug);
      this.catalogState.update((snapshot) => {
        if (!snapshot) return snapshot;
        const channels = snapshot.channels.map((entry) => (entry.id === slug ? channel : entry));
        return { ...snapshot, channels };
      });
      return channel;
    } catch {
      return existing;
    }
  }
}
