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

  /**
   * Guide snapshots for several channels at once (used by the grid page).
   *
   * The two failure kinds are deliberately treated differently:
   * - `404`: this channel simply has no guide — a legitimate, per-channel answer;
   * - anything else (network, 5xx, rate limit): the guide service itself is
   *   unavailable, so the caller must be able to say so instead of showing an
   *   empty guide that looks like "no programmes today".
   */
  async schedules(
    slugs: readonly string[],
    options: { hours?: number; signal?: AbortSignal } = {},
  ): Promise<EpgSnapshot> {
    // `Promise.all` rejects with the first failure but leaves the other requests
    // running and unobserved, which surfaces later as an unhandled rejection.
    // `allSettled` collects every outcome, then the first real failure is rethrown.
    const results = await Promise.allSettled(
      slugs.map((slug) => this.schedule(slug, options)),
    );
    const entries: (readonly [string, ChannelSchedule])[] = [];
    let failure: { error: unknown } | undefined;
    results.forEach((result, index) => {
      const slug = slugs[index] as string;
      if (result.status === 'fulfilled') {
        entries.push([slug, result.value.schedule] as const);
        return;
      }
      if (ApiGateway.isNotFound(result.reason)) {
        // This channel simply has no guide: a legitimate, per-channel answer.
        entries.push([slug, { epgId: slug, programs: [] }] as const);
        return;
      }
      failure ??= { error: result.reason };
    });
    if (failure) {
      throw failure.error;
    }
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
