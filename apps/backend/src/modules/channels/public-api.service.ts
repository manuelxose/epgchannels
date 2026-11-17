/**
 * Public API service: the read-side composition for the public international
 * surface (`/channels/:slug/epg`, `/channels/:slug/availability`).
 *
 * Two rules govern everything here:
 *
 * 1. **Authorization first.** Nothing about a source is described until the same
 *    four-axis gate that builds the playback descriptor has accepted it. The
 *    availability aggregate therefore reports *what kind* of integration exists
 *    and *how many* are refused — never an address, a source id, a provider
 *    credential or a licence clause.
 * 2. **Never fabricate.** A channel without a guide answers `not-mapped`; a day
 *    with no programmes answers `empty` with an empty list. No placeholder
 *    programme is ever invented to fill a grid.
 */
import type {
  ChannelAvailability,
  ChannelAvailabilityResponse,
  ScheduleResponse,
} from '@tdt/contracts';
import { attributionSchema, scheduleResponseSchema } from '@tdt/contracts';
import type { DatabaseHandle } from '../../infrastructure/mongo.js';
import { COLLECTIONS } from '../../infrastructure/mongo.js';
import type { ChannelDoc, PlaybackSourceDoc } from '../../infrastructure/schema.js';
import { AppError } from '../../server/errors.js';
import type { PlaybackService } from '../playback/playback.service.js';
import { buildDescriptor } from '../playback/playback.service.js';
import type { EpgService } from '../epg/epg.service.js';
import { attributionFor } from './channels.service.js';
import { isCalendarDate, isKnownTimeZone, startOfLocalDay, type EpgDayQuery } from './local-day.js';

export class PublicApiService {
  constructor(
    private readonly database: DatabaseHandle,
    private readonly playback: PlaybackService,
    private readonly epg: EpgService,
  ) {}

  private channels() {
    return this.database.collection<ChannelDoc>(COLLECTIONS.channels);
  }

  // ------------------------------------------------------------------- epg

  /**
   * `/channels/:slug/epg` — one complete guide day.
   *
   * `?date=YYYY-MM-DD` is read in the channel's own zone unless `?timezone=` says
   * otherwise; `?from=` + `?hours=` takes the explicit window. Both end up as a
   * `[from, to)` instant window and reuse `EpgService.scheduleFor`, so this
   * endpoint and `/channels/:slug/schedule` can never disagree about what the
   * guide says.
   */
  async epgDay(slug: string, query: EpgDayQuery): Promise<ScheduleResponse> {
    const channel = await this.channels().findOne({ slug, editorialStatus: 'published', mergedInto: null });
    if (!channel) throw AppError.notFound('Canal no encontrado.');

    const timeZone = query.timezone ?? channel.timezone;
    if (!isKnownTimeZone(timeZone)) {
      throw AppError.validation('Parámetros no válidos.', [
        { path: 'timezone', message: 'Zona horaria IANA desconocida.' },
      ]);
    }
    if (query.date !== undefined && !isCalendarDate(query.date)) {
      throw AppError.validation('Parámetros no válidos.', [
        { path: 'date', message: 'Se espera una fecha real en formato AAAA-MM-DD.' },
      ]);
    }
    if (query.from !== undefined && Number.isNaN(new Date(query.from).getTime())) {
      throw AppError.validation('Parámetros no válidos.', [
        { path: 'from', message: 'Instante ISO-8601 no válido.' },
      ]);
    }

    const from = query.date !== undefined ? startOfLocalDay(query.date, timeZone) : new Date(query.from ?? Date.now());
    // A date always means its whole local day (23, 24 or 25 hours across a DST edge).
    const hours = query.date !== undefined ? 24 : query.hours;

    const response = await this.epg.scheduleFor(channel, from, hours);
    return scheduleResponseSchema.parse({
      ...response,
      data: { ...response.data, timezone: timeZone },
    });
  }

  // ---------------------------------------------------------- availability

  /**
   * `/channels/:slug/availability` — the published `channelAvailabilitySchema`.
   *
   * The descriptor is built once (the only place that decides what may be
   * exposed) and then *reduced* field by field: the answer carries the boolean
   * facts the contract defines and none of the descriptor's addresses, source
   * ids, provider names, credentials or licensing clauses. Constructing the
   * reduced object explicitly (instead of deleting keys afterwards) is what
   * makes the authorization-first rule structural rather than a promise.
   *
   * The EPG block comes from `EpgService.coverage()` — the single shared
   * coverage measurement — so this endpoint, `/epg/channels` and the admin
   * console cannot disagree about a channel's guide.
   */
  async availability(slug: string): Promise<ChannelAvailabilityResponse> {
    const channel = await this.channels().findOne({ slug, editorialStatus: 'published', mergedInto: null });
    if (!channel) throw AppError.notFound('Canal no encontrado.');

    const sources = await this.database
      .collection<PlaybackSourceDoc>(COLLECTIONS.sources)
      .find({ channelId: channel._id })
      .sort({ priority: 1 })
      .toArray();
    const [authorizations, evidence, coverage] = await Promise.all([
      this.playback.authorizationsFor(sources),
      this.playback.evidenceFor(sources),
      this.epg.coverage(),
    ]);
    const descriptor = buildDescriptor(
      channel,
      sources,
      new Date(),
      new Map(),
      new Set(),
      authorizations,
      evidence,
    );

    const entry = coverage.entries.find((row) => row.channelId === channel._id);
    const authorised = descriptor.playback.options;
    /*
     * `available` is the contract's own definition: at least one authorised,
     * healthy in-app source. The descriptor already applies that gate, so it is
     * read from it rather than re-derived from the raw source rows.
     */
    const status = descriptor.playback.status;
    const data: ChannelAvailability = {
      slug: channel.slug,
      playable: status === 'available',
      /*
       * The published contract enumerates four statuses and `eventual` is not
       * one of them: an eventual channel with nothing attached is, from a
       * spectator's point of view, not watchable in-app right now. It is
       * reported `unavailable` (with `playable: false`) instead of being mapped
       * to `external`, which would claim the emitter offers a player it may not
       * have. `/channels/:slug/playback` remains the place where `eventual` is
       * reported exactly.
       */
      playbackStatus: status === 'eventual' ? 'unavailable' : status,
      geoRestricted: authorised.some((option) => option.geoRestricted),
      authorisedSources: authorised.length,
      lastVerifiedAt: this.lastVerifiedAt(sources, evidence),
      epg: {
        availability: entry?.availability ?? 'not-mapped',
        updatedAt: entry?.lastProgrammeEnd ?? null,
      },
    };
    const attribution = attributionSchema.parse(attributionFor([channel]));
    return { data, attribution };
  }

  /**
   * When the preferred source was last observed, or null when it never was.
   *
   * Read from the recorded health ledger first (the only place a verdict is
   * persisted) and from the source's own verification record second. A source
   * nobody has checked answers null: "not verified" is not a timestamp.
   */
  private lastVerifiedAt(
    sources: readonly PlaybackSourceDoc[],
    evidence: { checks: ReadonlyMap<string, { observedAt: Date }> },
  ): string | null {
    const ordered = [...sources].sort((a, b) => a.priority - b.priority);
    for (const source of ordered) {
      const checked = evidence.checks.get(source._id)?.observedAt ?? source.lastVerifiedAt ?? null;
      if (checked instanceof Date && !Number.isNaN(checked.getTime())) return checked.toISOString();
    }
    return null;
  }
}
