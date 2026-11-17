/**
 * EPG service: storage, normalisation and exposure of an *independent* guide.
 *
 * Ingestion is idempotent: a programme is keyed by its channel plus the
 * upstream event key, so re-importing the same guide updates in place and never
 * duplicates an emission. Programmes are never invented for a channel without a
 * guide: `availability` says why a channel has no schedule.
 */
import type {
  EpgCoverageEntry,
  EpgFeedEntry,
  EpgProvenance,
  Programme,
  ScheduleAvailability,
  ScheduleResponse,
} from '@tdt/contracts';
import { attributionSchema } from '@tdt/contracts';
import { randomUUID } from 'node:crypto';
import type { DatabaseHandle } from '../../infrastructure/mongo.js';
import { COLLECTIONS } from '../../infrastructure/mongo.js';
import type { ChannelDoc, EpgSourceDoc, ProgrammeDoc } from '../../infrastructure/schema.js';
import { channelRef } from '../playback/playback.service.js';
import { findDuplicatePairs, normaliseTitle, windowsOverlap } from './epg.dedup.js';

export interface NormalisedProgramme {
  readonly title: string;
  readonly description: string;
  readonly genre: string | null;
  readonly coverUrl: string | null;
  readonly start: Date;
  readonly end: Date;
  readonly externalKey: string;
  /** Zone of the upstream reading (contract §4.1). Defaults to `UTC`. */
  readonly timezone?: string;
  /** Upstream wall clock before normalisation, for audit. Defaults to `start`. */
  readonly originalStart?: Date;
}

/** What one channel's upsert changed, for the run record. */
export interface UpsertOutcome {
  readonly written: number;
  readonly rejected: number;
  readonly duplicates: number;
}

export function toProgramme(doc: ProgrammeDoc): Programme {
  return {
    id: doc._id,
    title: doc.title,
    description: doc.description,
    genre: doc.genre,
    coverUrl: doc.coverUrl,
    start: doc.start.toISOString(),
    end: doc.end.toISOString(),
  };
}

/**
 * Drops invalid emissions and folds duplicates deterministically:
 * an event is invalid when it has no title, a non-positive duration or a
 * non-finite instant; duplicates are the same (start, end, title).
 */
export function normaliseProgrammes(input: readonly NormalisedProgramme[]): {
  programmes: NormalisedProgramme[];
  rejected: number;
} {
  const out: NormalisedProgramme[] = [];
  const seen = new Set<string>();
  let rejected = 0;
  for (const event of input) {
    const start = event.start.getTime();
    const end = event.end.getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || event.title.trim().length === 0) {
      rejected += 1;
      continue;
    }
    const key = `${start}|${end}|${event.title.trim().toLowerCase()}`;
    if (seen.has(key)) {
      rejected += 1;
      continue;
    }
    seen.add(key);
    out.push({
      ...event,
      title: event.title.trim().slice(0, 300),
      description: event.description.slice(0, 2000),
    });
  }
  out.sort((a, b) => a.start.getTime() - b.start.getTime());
  return { programmes: out, rejected };
}

/** Programme on air at `at`, and the `count` after it. Deterministic. */
export function pickNowNext(
  programmes: readonly Programme[],
  at: Date,
  count = 8,
): { now: Programme | null; next: Programme[] } {
  const instant = at.getTime();
  const sorted = [...programmes].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const now = sorted.find(
    (programme) => Date.parse(programme.start) <= instant && instant < Date.parse(programme.end),
  );
  const next = sorted.filter((programme) => Date.parse(programme.start) > instant).slice(0, count);
  return { now: now ?? null, next };
}

export class EpgService {
  constructor(private readonly database: DatabaseHandle) {}

  private programmes() {
    return this.database.collection<ProgrammeDoc>(COLLECTIONS.programmes);
  }

  /**
   * Replaces the guide window of one source for one channel. Idempotent.
   *
   * After the bulk write the channel's window is scanned once for duplicates
   * (same channel, overlapping window, same normalised title) and for staleness
   * against what the source currently promises. Duplicates are **marked** —
   * `duplicateOf` points at the winner — never deleted, so an operator can audit
   * or reverse the decision.
   */
  async upsertChannelGuide(
    channelId: string,
    sourceId: string,
    events: readonly NormalisedProgramme[],
    options: { readonly now?: Date; readonly sourceTimezone?: string | null } = {},
  ): Promise<UpsertOutcome> {
    const { programmes, rejected } = normaliseProgrammes(events);
    if (programmes.length === 0) {
      return { written: 0, rejected, duplicates: 0 };
    }
    const now = options.now ?? new Date();
    const bulk = programmes.map((event) => ({
      updateOne: {
        filter: { channelId, externalKey: event.externalKey },
        update: {
          $set: {
            title: event.title,
            description: event.description,
            genre: event.genre,
            coverUrl: event.coverUrl,
            start: event.start,
            end: event.end,
            sourceId,
            timezone: event.timezone ?? options.sourceTimezone ?? 'UTC',
            originalStart: event.originalStart ?? event.start,
            updatedAt: now,
          },
          $setOnInsert: {
            _id: randomUUID(),
            channelId,
            externalKey: event.externalKey,
            editedAt: null,
            duplicateOf: null,
            createdAt: now,
          },
        },
        upsert: true,
      },
    }));
    const result = await this.programmes().bulkWrite(bulk, { ordered: false });
    const duplicates = await this.reclassifyChannel(channelId, now);
    return { written: result.upsertedCount + result.modifiedCount, rejected, duplicates };
  }

  /**
   * Recomputes `duplicateOf` and `stale` for one channel's whole guide.
   *
   * One read of the channel's window, one pure classification, one bulk write:
   * the cost is bounded by the guide size, not by the number of emissions
   * compared. Returns how many emissions are currently marked as duplicates.
   */
  async reclassifyChannel(channelId: string, now = new Date()): Promise<number> {
    const docs = await this.programmes()
      .find({ channelId }, { projection: { _id: 1, title: 1, start: 1, end: 1, sourceId: 1, duplicateOf: 1 } })
      .sort({ start: 1 })
      .toArray();
    if (docs.length === 0) return 0;
    const lastEnd = docs.reduce((max, doc) => (doc.end.getTime() > max ? doc.end.getTime() : max), 0);
    const { duplicates } = findDuplicatePairs(
      docs.map((doc) => ({ id: doc._id, title: doc.title, start: doc.start, end: doc.end })),
    );
    const operations = docs.map((doc) => {
      const winner = duplicates.get(doc._id) ?? null;
      // Stale: nothing of the guide reaches the present any more.
      const stale = doc.end.getTime() <= now.getTime() && lastEnd > now.getTime();
      return {
        updateOne: {
          filter: { _id: doc._id },
          update: { $set: { duplicateOf: winner, stale } },
        },
      };
    });
    await this.programmes().bulkWrite(operations, { ordered: false });
    return duplicates.size;
  }

  /**
   * Duplicates of one channel, as (duplicate, winner) pairs. Read-only view for
   * the administration surface; nothing is merged here.
   */
  async duplicatesOf(channelId: string): Promise<{ id: string; duplicateOf: string }[]> {
    const docs = await this.programmes()
      .find({ channelId, duplicateOf: { $ne: null } }, { projection: { _id: 1, duplicateOf: 1 } })
      .toArray();
    return docs
      .filter((doc): doc is ProgrammeDoc & { duplicateOf: string } => typeof doc.duplicateOf === 'string')
      .map((doc) => ({ id: doc._id, duplicateOf: doc.duplicateOf }));
  }

  /**
   * Whether an emission would be a duplicate of something already stored.
   *
   * Used by the ingestion pre-check so an incremental run can count duplicates
   * it refused to write without reading the whole channel back.
   */
  async findStoredDuplicate(
    channelId: string,
    title: string,
    start: Date,
    end: Date,
  ): Promise<string | null> {
    const candidates = await this.programmes()
      .find(
        { channelId, start: { $lt: end }, end: { $gt: start } },
        { projection: { _id: 1, title: 1, start: 1, end: 1 } },
      )
      .limit(50)
      .toArray();
    const wanted = normaliseTitle(title);
    for (const candidate of candidates) {
      if (normaliseTitle(candidate.title) !== wanted) continue;
      if (windowsOverlap(start, end, candidate.start, candidate.end)) return candidate._id;
    }
    return null;
  }

  /**
   * Editorial programme: an emission an editor records directly, because it
   * comes from an official publication (a printed schedule, an emitter's own
   * page) that we may cite but cannot redistribute as a feed.
   */
  async createEditorialProgramme(
    input: {
      channelId: string;
      title: string;
      description: string;
      genre: string | null;
      coverUrl: string | null;
      start: string;
      end: string;
    },
    actor: string,
  ): Promise<Programme> {
    const start = new Date(input.start);
    const end = new Date(input.end);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) {
      throw new Error('Invalid editorial programme window.');
    }
    const source = await this.database
      .collection<EpgSourceDoc>(COLLECTIONS.epgSources)
      .findOne({ kind: 'editorial' });
    if (!source) {
      throw new Error('No editorial guide source is registered.');
    }
    const now = new Date();
    const doc: ProgrammeDoc = {
      _id: randomUUID(),
      channelId: input.channelId,
      sourceId: source._id,
      title: input.title.slice(0, 300),
      description: input.description.slice(0, 2000),
      genre: input.genre,
      coverUrl: input.coverUrl,
      start,
      end,
      externalKey: `editorial|${start.toISOString()}|${actor}`,
      editedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    await this.programmes().replaceOne({ channelId: doc.channelId, externalKey: doc.externalKey }, doc, { upsert: true });
    await this.database.collection<ChannelDoc>(COLLECTIONS.channels).updateOne(
      { _id: input.channelId, 'epg.sourceId': null },
      { $set: { epg: { sourceId: source._id, externalId: null } } },
    );
    return toProgramme(doc);
  }

  async scheduleFor(
    channel: ChannelDoc,
    from: Date,
    hours: number,
  ): Promise<ScheduleResponse> {
    const to = new Date(from.getTime() + hours * 3_600_000);
    const availability = this.availabilityOf(channel);
    // A duplicate keeps its row but is not shown: the winner represents the
    // broadcast. Rows without the field predate dedup and are shown.
    const docs =
      channel.epg?.sourceId !== null && channel.epg?.sourceId !== undefined
        ? await this.programmes()
            .find({
              channelId: channel._id,
              end: { $gt: from },
              start: { $lt: to },
              duplicateOf: { $in: [null] },
            })
            .sort({ start: 1 })
            .toArray()
        : [];
    const programmes = docs.map(toProgramme);
    const provenance = await this.provenanceOf(channel);
    return {
      data: {
        channel: channelRef(channel),
        timezone: channel.timezone,
        availability: programmes.length > 0 ? 'available' : availability,
        now: pickNowNext(programmes, from, 0).now,
        next: pickNowNext(programmes, from, 12).next,
        programmes,
        asOf: from.toISOString(),
        provenance,
        updatedAt: docs.length > 0 ? (docs[0]?.updatedAt.toISOString() ?? null) : null,
      },
      attribution: await this.attributionOf(channel),
    };
  }

  async feed(channels: readonly ChannelDoc[], at: Date, mode: 'now' | 'next'): Promise<EpgFeedEntry[]> {
    if (channels.length === 0) return [];
    const ids = channels.map((channel) => channel._id);
    const windowStart = new Date(at.getTime() - 12 * 3_600_000);
    const windowEnd = new Date(at.getTime() + 48 * 3_600_000);
    const docs = await this.programmes()
      .find({
        channelId: { $in: ids },
        end: { $gt: windowStart },
        start: { $lt: windowEnd },
        duplicateOf: { $in: [null] },
      })
      .sort({ start: 1 })
      .toArray();
    const byChannel = new Map<string, ProgrammeDoc[]>();
    for (const doc of docs) {
      const list = byChannel.get(doc.channelId) ?? [];
      list.push(doc);
      byChannel.set(doc.channelId, list);
    }
    const sources = await this.database.collection<EpgSourceDoc>(COLLECTIONS.epgSources).find({}).toArray();
    const sourceById = new Map(sources.map((source) => [source._id, source]));
    const entries: EpgFeedEntry[] = [];
    for (const channel of channels) {
      const list = (byChannel.get(channel._id) ?? []).map(toProgramme);
      const { now, next } = pickNowNext(list, at, 1);
      const picked = mode === 'now' ? now : (next[0] ?? null);
      const source = channel.epg?.sourceId ? sourceById.get(channel.epg.sourceId) : undefined;
      entries.push({
        channel: channelRef(channel),
        timezone: channel.timezone,
        availability: picked ? 'available' : this.availabilityOf(channel),
        programme: picked,
        provenance: {
          sourceId: source?._id ?? null,
          sourceName: source?.name ?? null,
          licence: source?.licence ?? null,
          attribution: source?.attribution ?? null,
          editedAt: null,
        },
      });
    }
    return entries;
  }

  availabilityOf(channel: ChannelDoc): ScheduleAvailability {
    if (!channel.epg || channel.epg.sourceId === null) {
      return 'not-mapped';
    }
    return 'empty';
  }

  private async provenanceOf(channel: ChannelDoc): Promise<EpgProvenance> {
    if (!channel.epg?.sourceId) {
      return { sourceId: null, sourceName: null, licence: null, attribution: null, editedAt: null };
    }
    const source = await this.database
      .collection<EpgSourceDoc>(COLLECTIONS.epgSources)
      .findOne({ _id: channel.epg.sourceId });
    return {
      sourceId: source?._id ?? null,
      sourceName: source?.name ?? null,
      licence: source?.licence ?? null,
      attribution: source?.attribution ?? null,
      editedAt: null,
    };
  }

  private async attributionOf(channel: ChannelDoc): Promise<import('@tdt/contracts').Attribution> {
    const provenance = await this.provenanceOf(channel);
    return attributionSchema.parse({
      notices: provenance.attribution ? [provenance.attribution] : [],
      includesThirdPartyData: provenance.attribution !== null,
    });
  }

  /**
   * Coverage of the guide across the **published** catalogue (TDT-API-02FG).
   *
   * This is the one measurement the public API and the administration console
   * share. It is a two-query aggregate over all published channels, not a
   * per-channel loop, so its cost does not grow with the number of round trips.
   *
   * A channel is `fresh` when it holds programmes that end after `now` and its
   * last refresh is inside `staleAfterMs`; `stale` when it holds programmes but
   * the source has gone quiet; `empty` when mapped but nothing was ever
   * ingested; `not-mapped` when no guide source is attached. Nothing is
   * inferred from absence of data: no programme is synthesized.
   */
  async coverage(
    options: { readonly staleAfterMs?: number; readonly now?: Date; readonly lookbackMs?: number } = {},
  ): Promise<{
    entries: EpgCoverageEntry[];
    totals: {
      channels: number;
      mapped: number;
      fresh: number;
      stale: number;
      empty: number;
      notMapped: number;
    };
    asOf: string;
  }> {
    const now = options.now ?? new Date();
    const staleAfterMs = options.staleAfterMs ?? 24 * 3_600_000;
    const lookbackMs = options.lookbackMs ?? 24 * 3_600_000;
    const staleAfter = new Date(now.getTime() + staleAfterMs);

    const channels = await this.database
      .collection<ChannelDoc>(COLLECTIONS.channels)
      .find({ editorialStatus: 'published', mergedInto: null })
      .sort({ name: 1 })
      .toArray();

    const sources = await this.database
      .collection<EpgSourceDoc>(COLLECTIONS.epgSources)
      .find({})
      .project<Pick<EpgSourceDoc, '_id' | 'name'>>({ name: 1 })
      .toArray();
    const sourceName = new Map(sources.map((source) => [source._id, source.name]));

    // One aggregate for every channel: programme count, latest end and latest
    // refresh, so the coverage of N channels is still a single round trip.
    const stats = new Map<string, { count: number; lastEnd: Date | null; lastUpdated: Date | null }>();
    if (channels.length > 0) {
      const rows = await this.programmes()
        .aggregate<{ _id: string; count: number; lastEnd: Date; lastUpdated: Date }>([
          {
            $match: {
              channelId: { $in: channels.map((channel) => channel._id) },
              end: { $gte: new Date(now.getTime() - lookbackMs) },
              duplicateOf: { $in: [null] },
            },
          },
          {
            $group: {
              _id: '$channelId',
              count: { $sum: 1 },
              lastEnd: { $max: '$end' },
              lastUpdated: { $max: '$updatedAt' },
            },
          },
        ])
        .toArray();
      for (const row of rows) {
        stats.set(row._id, { count: row.count, lastEnd: row.lastEnd, lastUpdated: row.lastUpdated });
      }
    }

    const totals = { channels: channels.length, mapped: 0, fresh: 0, stale: 0, empty: 0, notMapped: 0 };
    const entries: EpgCoverageEntry[] = channels.map((channel) => {
      const sourceId = channel.epg?.sourceId ?? null;
      const stat = stats.get(channel._id);
      const availability = this.availabilityOf(channel);
      const lastEndMs = stat?.lastEnd?.getTime() ?? null;
      const lastUpdatedMs = stat?.lastUpdated?.getTime() ?? null;
      const covered = lastEndMs !== null && lastEndMs > now.getTime();
      const refreshedInsideWindow = lastUpdatedMs !== null && lastUpdatedMs > now.getTime() - staleAfterMs;
      let status: EpgCoverageEntry['status'];
      if (sourceId === null) {
        status = 'not-mapped';
        totals.notMapped += 1;
      } else {
        totals.mapped += 1;
        if (!stat || stat.count === 0) {
          status = 'empty';
          totals.empty += 1;
        } else if (covered && refreshedInsideWindow) {
          status = 'fresh';
          totals.fresh += 1;
        } else {
          status = 'stale';
          totals.stale += 1;
        }
      }
      return {
        channelId: channel._id,
        slug: channel.slug,
        name: channel.name,
        country: channel.country,
        language: channel.languageTag,
        timezone: channel.timezone,
        mapped: sourceId !== null,
        sourceId,
        sourceName: sourceId === null ? null : (sourceName.get(sourceId) ?? null),
        status,
        availability: status === 'fresh' || status === 'stale' ? 'available' : availability,
        programmes: stat?.count ?? 0,
        lastProgrammeEnd: stat?.lastEnd?.toISOString() ?? null,
        staleAfter: sourceId === null ? null : staleAfter.toISOString(),
      };
    });

    return { entries, totals, asOf: now.toISOString() };
  }
}
