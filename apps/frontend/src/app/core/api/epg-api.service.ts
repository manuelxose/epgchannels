/**
 * `EpgApiService` — the programme guide, fetched per channel and refreshed.
 *
 * The guide comes from our own store: `GET /channels/:slug/schedule` and the
 * `/epg/now|next` feeds. A channel without a guide is a legitimate answer and is
 * reported as such, never filled with invented emissions.
 */
import { Injectable, inject } from '@angular/core';
import { ApiGateway } from '../api/api.gateway';
import { toEpgSnapshot, toSchedule } from '../data/api-mappers';
import type { ChannelSchedule, EpgSnapshot } from '../models/catalog.model';

@Injectable({ providedIn: 'root' })
export class EpgApiService {
  private readonly gateway = inject(ApiGateway);

  /** The guide for one channel: now, next and the programmes in a window. */
  async schedule(
    slug: string,
    options: { hours?: number; from?: string; signal?: AbortSignal } = {},
  ): Promise<{ schedule: ChannelSchedule; availability: string; updatedAt: string | null }> {
    const response = await this.gateway.client.epg.schedule(slug, options);
    return {
      schedule: toSchedule(slug, response.data.programmes),
      availability: response.data.availability,
      updatedAt: response.data.updatedAt,
    };
  }

  /** Guide snapshots for several channels at once (used by the grid page). */
  async schedules(
    slugs: readonly string[],
    options: { hours?: number; signal?: AbortSignal } = {},
  ): Promise<EpgSnapshot> {
    const entries = await Promise.all(
      slugs.map(async (slug) => {
        try {
          const result = await this.schedule(slug, options);
          return [slug, result.schedule] as const;
        } catch {
          // A channel whose guide is not published is not an error for the page.
          return [slug, { epgId: slug, programs: [] }] as const;
        }
      }),
    );
    return toEpgSnapshot(new Map(entries));
  }

  /** What is on air now across the catalogue. */
  async now(options: { channel?: string[]; limit?: number; signal?: AbortSignal } = {}) {
    return this.gateway.client.epg.now(options);
  }

  /** What is on next across the catalogue. */
  async next(options: { channel?: string[]; limit?: number; signal?: AbortSignal } = {}) {
    return this.gateway.client.epg.next(options);
  }
}
