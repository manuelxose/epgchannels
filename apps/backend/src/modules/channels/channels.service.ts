/**
 * Channels service: the canonical catalogue.
 *
 * Reads are bounded (pagination), filtered in the database and never return
 * unlicensed sources. Writes go through the editorial service, which records an
 * audit entry for every change.
 */
import type { Channel, ChannelList, ChannelListQuery, ChannelSourceSummary, PlaybackStatus } from '@tdt/contracts';
import { attributionSchema } from '@tdt/contracts';
import type { DatabaseHandle } from '../../infrastructure/mongo.js';
import { COLLECTIONS } from '../../infrastructure/mongo.js';
import type { ChannelDoc, PlaybackSourceDoc } from '../../infrastructure/schema.js';
import { normalizeForSearch, searchText } from '../../shared/search.js';
import { compareSources, decidePublication, engineFor, isSourceHealthy } from '../playback/publication-policy.js';
import { PUBLIC_CHANNEL_MATCH, escapeRegex, scanPlayableWindow } from './catalogue.aggregates.js';

export const THIRD_PARTY_ATTRIBUTION =
  'Metadatos de referencia: proyecto TDTChannels (github.com/LaQuay/TDTChannels), licencia Apache-2.0. ' +
  'Las descripciones editoriales de esta plataforma son propias. Las señales pertenecen a sus emisores.';

export function attributionFor(channels: readonly ChannelDoc[]): import('@tdt/contracts').Attribution {
  const thirdParty = channels.some((channel) =>
    channel.provenance.some((entry) => !entry.editorial && entry.attribution !== null),
  );
  const notices = new Set<string>();
  for (const channel of channels) {
    for (const entry of channel.provenance) {
      if (!entry.editorial && entry.attribution) {
        notices.add(entry.attribution);
      }
    }
  }
  return attributionSchema.parse({
    notices: [...notices],
    includesThirdPartyData: thirdParty,
  });
}

export function toChannelList(channel: ChannelDoc, status: PlaybackStatus): ChannelList {
  return {
    id: channel._id,
    slug: channel.slug,
    name: channel.name,
    shortName: channel.shortName,
    country: channel.country,
    region: channel.region,
    language: channel.languageTag,
    category: channel.category as ChannelList['category'],
    kind: channel.kind as ChannelList['kind'],
    playbackStatus: status,
    logoSrc: channel.branding?.logoSrc ?? null,
    hasSchedule: channel.epg !== null && channel.epg.sourceId !== null,
  };
}

export function toChannel(
  channel: ChannelDoc,
  sources: readonly PlaybackSourceDoc[],
  status: PlaybackStatus,
): Channel {
  const publicSources = [...sources].sort(compareSources).filter((source) =>
    decidePublication({
      channelStatus: channel.editorialStatus,
      sourceStatus: source.editorialStatus,
      permission: source.permission as never,
      technicalStatus: source.technicalStatus,
      conditions: source.conditions,
    }).public,
  );
  const preferred = publicSources.find((source) => isSourceHealthy(source) && source.type !== 'external');
  const summaries: ChannelSourceSummary[] = publicSources.map((source) => ({
    id: source._id,
    type: source.type as ChannelSourceSummary['type'],
    label: source.conditions.notes ?? source.provider,
    geoRestricted: !source.conditions.worldwide,
    preferred: preferred?._id === source._id,
    engine: engineFor(source),
  }));
  return {
    id: channel._id,
    slug: channel.slug,
    name: channel.name,
    shortName: channel.shortName,
    country: channel.country,
    region: channel.region,
    locality: channel.locality,
    language: channel.languageTag,
    category: channel.category as Channel['category'],
    kind: channel.kind as Channel['kind'],
    websiteUrl: channel.websiteUrl,
    description: channel.description,
    branding: channel.branding,
    editorialStatus: channel.editorialStatus as Channel['editorialStatus'],
    playbackStatus: status,
    sources: summaries,
    provenance: channel.provenance.map((entry) => ({
      source: entry.source,
      label: entry.label,
      url: entry.url,
      licence: entry.licence,
      attribution: entry.attribution,
      digestSha256: entry.digestSha256,
      capturedAt: entry.capturedAt.toISOString(),
      editorial: entry.editorial,
    })),
    aliases: channel.aliases,
    hasSchedule: channel.epg !== null && channel.epg.sourceId !== null,
    reviewedAt: channel.reviewedAt?.toISOString() ?? null,
    updatedAt: channel.updatedAt.toISOString(),
  };
}

export interface ChannelFilter {
  readonly q?: string | undefined;
  readonly country?: string | undefined;
  readonly region?: string | undefined;
  readonly category?: string | undefined;
  readonly language?: string | undefined;
  readonly playable?: boolean | undefined;
  readonly sort: 'name' | 'name-desc' | 'updated' | 'relevance';
}

export class ChannelsService {
  constructor(private readonly database: DatabaseHandle) {}

  private channels() {
    return this.database.collection<ChannelDoc>(COLLECTIONS.channels);
  }

  /**
   * Mongo filter for a list query. Only published channels are public.
   *
   * The published predicate comes from `PUBLIC_CHANNEL_MATCH` so the listing and
   * the catalogue counts (countries, regions, languages) are filtered by exactly
   * the same rule.
   */
  buildFilter(filter: ChannelFilter): Record<string, unknown> {
    const clauses: Record<string, unknown>[] = [{ ...PUBLIC_CHANNEL_MATCH }];
    if (filter.country) clauses.push({ country: filter.country });
    if (filter.region) clauses.push({ 'region.code': filter.region });
    if (filter.category) clauses.push({ category: filter.category });
    if (filter.language) clauses.push({ languageTag: filter.language });
    if (filter.q) {
      const folded = normalizeForSearch(filter.q);
      if (folded) {
        // Accent-insensitive substring search over the stored search forms.
        clauses.push({ searchText: { $regex: escapeRegex(folded), $options: 'i' } });
      }
    }
    return clauses.length === 1 ? (clauses[0] as Record<string, unknown>) : { $and: clauses };
  }

  sortSpec(sort: ChannelFilter['sort']): Record<string, 1 | -1> {
    switch (sort) {
      case 'name-desc':
        return { name: -1, slug: 1 };
      case 'updated':
        return { updatedAt: -1, slug: 1 };
      case 'relevance':
      case 'name':
      default:
        return { name: 1, slug: 1 };
    }
  }

  async list(
    filter: ChannelFilter,
    page: number,
    pageSize: number,
    playback: import('../playback/playback.service.js').PlaybackService,
  ): Promise<import('@tdt/contracts').ChannelListResponse> {
    const mongoFilter = this.buildFilter(filter);
    // `playable` needs the derived status, so it is applied after the fetch; the
    // fetch is still bounded by the page window plus a small over-fetch.
    if (filter.playable === true) {
      return this.listPlayable(filter, page, pageSize, playback);
    }
    // The count and the page are independent: issuing them together halves the
    // round trips on the most requested endpoint.
    const [total, docs] = await Promise.all([
      this.channels().countDocuments(mongoFilter),
      this.channels()
        .find(mongoFilter)
        .sort(this.sortSpec(filter.sort))
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .toArray(),
    ]);
    const statuses = await playback.statusesFor(docs);
    const pageCount = pageSize > 0 ? Math.ceil(total / pageSize) : 0;
    return {
      data: docs.map((doc) => toChannelList(doc, statuses.get(doc._id) ?? 'unavailable')),
      pagination: {
        page,
        pageSize,
        total,
        pageCount,
        hasNext: page < pageCount,
        hasPrevious: page > 1,
      },
      attribution: attributionFor(docs),
    };
  }

  /**
   * `playable=true` pages over the subset with an in-app authorised source.
   *
   * Playback status is derived, not stored, so this cannot be a plain `$match`.
   * Instead of loading the whole filtered catalogue (which is what a full scan
   * did), it streams candidate ids in the requested order through a bounded scan
   * and stops once the requested window plus one is known: a first-page request
   * costs one bounded pass even on a large catalogue. Health and authorization
   * are still decided by the same `statusesFor` the descriptor uses, so the page
   * a consumer sees here matches what `/channels/:slug/playback` says.
   */
  private async listPlayable(
    filter: ChannelFilter,
    page: number,
    pageSize: number,
    playback: import('../playback/playback.service.js').PlaybackService,
  ): Promise<import('@tdt/contracts').ChannelListResponse> {
    const mongoFilter = this.buildFilter(filter);
    const candidates = this.channels()
      .find(mongoFilter, { projection: { _id: 1 } })
      .sort(this.sortSpec(filter.sort))
      .batchSize(500);
    const window = await scanPlayableWindow(this.database, playback, candidates, page, pageSize);
    const docs = window.pageIds.length > 0
      ? await this.channels().find({ _id: { $in: [...window.pageIds] } }).toArray()
      : [];
    const byId = new Map(docs.map((doc) => [doc._id, doc]));
    const ordered = window.pageIds
      .map((id) => byId.get(id))
      .filter((doc): doc is ChannelDoc => doc !== undefined);
    const statuses = await playback.statusesFor(ordered);
    /*
     * The envelope is derived from ONE number so it can never contradict itself.
     *
     * `playableSeen` is exact when the sweep reached the end of the candidates.
     * When it stopped early it counted exactly this window plus one further
     * playable channel, so it is a truthful lower bound — "at least this many" —
     * which is what makes `hasNext` true and `pageCount` at least `page + 1`.
     * Reporting a smaller `total` while claiming `hasNext` was the inconsistency
     * this fixes.
     */
    const total = window.playableSeen;
    const pageCount = pageSize > 0 ? Math.ceil(total / pageSize) : 0;
    return {
      data: ordered.map((doc) => toChannelList(doc, statuses.get(doc._id) ?? 'unavailable')),
      pagination: {
        page,
        pageSize,
        total,
        pageCount,
        hasNext: page < pageCount,
        hasPrevious: page > 1,
      },
      attribution: attributionFor(ordered),
    };
  }

  async bySlug(
    slug: string,
    playback: import('../playback/playback.service.js').PlaybackService,
  ): Promise<import('@tdt/contracts').ChannelResponse | null> {
    const channel = await this.channels().findOne({ slug, editorialStatus: 'published', mergedInto: null });
    if (!channel) return null;
    const sources = await this.database
      .collection<PlaybackSourceDoc>(COLLECTIONS.sources)
      .find({ channelId: channel._id })
      .toArray();
    const statuses = await playback.statusesFor([channel]);
    return {
      data: toChannel(channel, sources, statuses.get(channel._id) ?? 'unavailable'),
      attribution: attributionFor([channel]),
    };
  }

  /** Counts used by health: proof that persisted data answers, not a fixture. */
  async counts(): Promise<{ channels: number; publishedChannels: number; sources: number; programmes: number }> {
    const [channels, publishedChannels, sources, programmes] = await Promise.all([
      this.channels().countDocuments({}),
      this.channels().countDocuments({ editorialStatus: 'published', mergedInto: null }),
      this.database.collection(COLLECTIONS.sources).countDocuments({}),
      this.database.collection(COLLECTIONS.programmes).countDocuments({}),
    ]);
    return { channels, publishedChannels, sources, programmes };
  }

  /** Searchable text for a channel record, stored on write. */
  static searchTextFor(channel: Pick<ChannelDoc, 'name' | 'shortName' | 'aliases'>): string {
    return searchText(channel.name, channel.shortName, ...channel.aliases.map((alias) => alias.value));
  }
}
