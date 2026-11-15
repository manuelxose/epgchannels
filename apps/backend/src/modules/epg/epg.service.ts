/**
 * EPG service: storage, normalisation and exposure of an *independent* guide.
 *
 * Ingestion is idempotent: a programme is keyed by its channel plus the
 * upstream event key, so re-importing the same guide updates in place and never
 * duplicates an emission. Programmes are never invented for a channel without a
 * guide: `availability` says why a channel has no schedule.
 */
import type {
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

export interface NormalisedProgramme {
  readonly title: string;
  readonly description: string;
  readonly genre: string | null;
  readonly coverUrl: string | null;
  readonly start: Date;
  readonly end: Date;
  readonly externalKey: string;
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

  /** Replaces the guide window of one source for one channel. Idempotent. */
  async upsertChannelGuide(
    channelId: string,
    sourceId: string,
    events: readonly NormalisedProgramme[],
  ): Promise<{ written: number; rejected: number }> {
    const { programmes, rejected } = normaliseProgrammes(events);
    if (programmes.length === 0) {
      return { written: 0, rejected };
    }
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
            updatedAt: new Date(),
          },
          $setOnInsert: {
            _id: randomUUID(),
            channelId,
            externalKey: event.externalKey,
            editedAt: null,
            createdAt: new Date(),
          },
        },
        upsert: true,
      },
    }));
    const result = await this.programmes().bulkWrite(bulk, { ordered: false });
    return { written: result.upsertedCount + result.modifiedCount, rejected };
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
    const docs =
      channel.epg?.sourceId !== null && channel.epg?.sourceId !== undefined
        ? await this.programmes()
            .find({ channelId: channel._id, end: { $gt: from }, start: { $lt: to } })
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
      .find({ channelId: { $in: ids }, end: { $gt: windowStart }, start: { $lt: windowEnd } })
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
}
