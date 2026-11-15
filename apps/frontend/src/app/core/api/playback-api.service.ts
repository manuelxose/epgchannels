/**
 * `PlaybackApiService` — resolves what the player may attempt.
 *
 * The player already implements HLS, DASH and the YouTube IFrame engine; this
 * service's only job is to hand it the right source list, obtained from the API
 * descriptor rather than guessed from a catalogue dump. It adds no second
 * playback engine and never fabricates a URL.
 */
import { Injectable, inject } from '@angular/core';
import type { PlaybackDescriptor } from '@tdt/api-client';
import { ApiGateway } from '../api/api.gateway';
import { sourcesFromDescriptor } from '../data/api-mappers';
import type { Channel, MediaSource } from '../models/catalog.model';

export interface ResolvedPlayback {
  readonly descriptor: PlaybackDescriptor;
  /** Sources the in-app player may attempt, in the API's preference order. */
  readonly sources: readonly MediaSource[];
  /** True when the API points at the emitter's own player instead of in-app media. */
  readonly requiresExternal: boolean;
}

@Injectable({ providedIn: 'root' })
export class PlaybackApiService {
  private readonly gateway = inject(ApiGateway);

  async resolve(slug: string, signal?: AbortSignal): Promise<ResolvedPlayback> {
    const descriptor = await this.gateway.client.playback.get(slug, signal ? { signal } : {});
    return {
      descriptor,
      sources: sourcesFromDescriptor({
        id: descriptor.channel.slug,
        name: descriptor.channel.name,
        categoryId: '',
        categoryName: '',
        country: '',
        sources: [],
        tags: [],
        availability: 'unavailable',
      }, descriptor),
      requiresExternal: descriptor.playback.status === 'external',
    };
  }
}
