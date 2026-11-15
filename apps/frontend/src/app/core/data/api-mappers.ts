/**
 * Mapping from **our API contract** onto the UI domain model.
 *
 * This module replaces the old `parseCatalog`/`parseEpg`, which decoded a third
 * party's `tv.json`. The API is ours and already validated server-side, so this
 * is a *mapping*, not a defensive parser: it keeps the same `Channel` /
 * `EpgProgram` types the components and the player already use, which is what
 * lets the whole UI and both playback engines survive unchanged.
 *
 * One rule is preserved from the previous implementation on purpose: the player
 * must never be handed a source it cannot legally or technically attempt, so the
 * eligibility predicates in `catalog.model.ts` keep deciding, with the API's
 * per-source `geoRestricted` and engine facts as input.
 */
import type { Channel as ApiChannel, ChannelList as ApiChannelList, PlaybackDescriptor } from '@tdt/contracts';
import type {
  AvailabilityTag,
  CatalogSnapshot,
  Channel,
  ChannelCategory,
  ChannelSchedule,
  EpgProgram,
  EpgSnapshot,
  MediaFormat,
  MediaSource,
  OfficialEmbed,
  PlaybackAvailability,
} from '../models/catalog.model';
import { isEmbeddableYoutubeUrl, youtubeTargetOf } from '../integrations/youtube-embed';

/** Playback engine from the API → the container our engines understand. */
export function mediaFormatOfEngine(engine: PlaybackDescriptor['playback']['engine']): MediaFormat {
  switch (engine) {
    case 'hls':
      return 'hls';
    case 'dash':
      return 'dash';
    case 'youtube-iframe':
      return 'youtube';
    case 'official-embed':
      return 'iframe';
    case 'external':
    case 'none':
      return 'iframe';
  }
}

/**
 * Builds the `MediaSource` list the player consumes from the channel record and
 * its playback descriptor. The descriptor is authoritative for *what may be
 * attempted*; the channel record supplies the human labels.
 */
export function sourcesFromDescriptor(
  channel: ApiChannel,
  descriptor: PlaybackDescriptor | undefined,
): MediaSource[] {
  if (!descriptor) {
    return [];
  }
  const sources: MediaSource[] = [];
  const seen = new Set<string>();
  for (const option of descriptor.playback.options) {
    if (seen.has(option.sourceId)) continue;
    seen.add(option.sourceId);
    const format = mediaFormatOfEngine(option.engine);
    const target = format === 'youtube' ? youtubeTargetOf(option.url) : undefined;
    sources.push({
      id: option.sourceId,
      label: option.label,
      format,
      url: option.url,
      geoRestricted: option.geoRestricted,
      // A YouTube page is playable by the official IFrame engine; anything else
      // marked `iframe` is an embed we never hand to a media engine.
      unplayable: format === 'iframe' || (format === 'youtube' && !isEmbeddableYoutubeUrl(option.url)),
      embed: format === 'youtube' && isEmbeddableYoutubeUrl(option.url),
      ...(target ? { platformId: target.id } : {}),
    });
  }

  // An `external` descriptor carries no in-app media: it is a link to the
  // emitter's own player, which the verified-state model turns into an action.
  const externalUrl = descriptor.playback.externalUrl;
  if (sources.length === 0 && externalUrl) {
    sources.push({
      id: `${descriptor.channel.id}#external`,
      label: 'Web del emisor',
      format: 'iframe',
      url: externalUrl,
      geoRestricted: false,
      unplayable: true,
    });
  }
  return sources;
}

/** Official embeds (YouTube/iframe) offered as links, never proxied. */
export function embargoedSourcesFrom(channel: ApiChannel): OfficialEmbed[] | undefined {
  const embeds: OfficialEmbed[] = [];
  for (const [index, source] of channel.sources.entries()) {
    if (source.engine === 'youtube-iframe') {
      embeds.push({ id: `embed#${index}`, provider: 'youtube', url: source.id, embeddable: true });
    }
  }
  return embeds.length > 0 ? embeds : undefined;
}

/**
 * Availability the UI reasons about, derived from the API's playback status.
 * `available` → `playable`; `external` → `external`; `eventual` → `no-emission`;
 * `degraded`/`unavailable` → `unavailable`.
 */
export function availabilityOf(status: ApiChannel['playbackStatus']): PlaybackAvailability {
  switch (status) {
    case 'available':
      return 'playable';
    case 'external':
      return 'external';
    case 'eventual':
      return 'no-emission';
    default:
      return 'unavailable';
  }
}

/**
 * Tags the UI reads. The API carries the same facts as structured fields, so the
 * tags are derived here instead of parsed from a foreign string list.
 */
export function tagsFor(channel: ApiChannel): AvailabilityTag[] {
  const tags: AvailabilityTag[] = [];
  if (channel.kind === 'eventual') tags.push('EVT');
  if (channel.kind === 'guide-only') tags.push('NOEM');
  if (channel.sources.some((source) => source.geoRestricted)) tags.push('GEO');
  if (channel.sources.some((source) => source.engine === 'youtube-iframe')) tags.push('EMB');
  return tags;
}

/** One API channel plus its descriptor, as the UI model. */
export function toChannel(api: ApiChannel, descriptor: PlaybackDescriptor | undefined): Channel {
  return {
    id: api.slug,
    name: api.name,
    categoryId: api.category,
    categoryName: api.category,
    country: api.country,
    webUrl: api.websiteUrl ?? undefined,
    logoSrc: api.branding?.logoSrc ?? undefined,
    sources: sourcesFromDescriptor(api, descriptor),
    embargoedSources: embargoedSourcesFrom(api),
    tags: tagsFor(api),
    availability: availabilityOf(api.playbackStatus),
  };
}

/** Categories with the counts the API already computed. */
export function toCategories(
  categories: ReadonlyArray<{ id: string; name: string; channelCount: number }>,
  country = 'ES',
): ChannelCategory[] {
  return categories.map((category) => ({
    id: category.id,
    name: category.name,
    country,
    channelCount: category.channelCount,
  }));
}

/** A snapshot of the catalogue as loaded from our API. */
export function toSnapshot(
  channels: readonly Channel[],
  categories: readonly ChannelCategory[],
  includeThirdPartyData: boolean,
): CatalogSnapshot {
  return {
    channels,
    categories,
    epgJsonUrl: undefined,
    updatedAt: new Date().toISOString(),
    origin: includeThirdPartyData ? 'remote' : 'demo',
    rejected: 0,
  };
}

/**
 * The trimmed list record mapped onto the same model, before descriptors load.
 *
 * categoryNames is the API's category catalogue: the list carries the
 * category *id*, and the UI shows (and searches over) the human name.
 */
export function listToChannel(
  record: ApiChannelList & { readonly categoryName?: string },
  categoryNames?: ReadonlyMap<string, string>,
): Channel {
  return {
    id: record.slug,
    name: record.name,
    categoryId: record.category,
    categoryName: categoryNames?.get(record.category) ?? record.categoryName ?? record.category,
    country: record.country,
    logoSrc: record.logoSrc ?? undefined,
    sources: [],
    tags: [],
    availability: availabilityOf(record.playbackStatus),
  };
}

/** One API programme as the UI's `EpgProgram`. */
export function toProgram(slug: string, programme: {
  title: string;
  description: string;
  genre: string | null;
  coverUrl: string | null;
  start: string;
  end: string;
}): EpgProgram {
  return {
    id: `${slug}:${programme.start}`,
    title: programme.title,
    description: programme.description,
    genre: programme.genre ?? undefined,
    coverUrl: programme.coverUrl ?? undefined,
    start: new Date(programme.start),
    end: new Date(programme.end),
  };
}

/** A guide entry for one channel as the UI's `EpgSnapshot` fragment. */
export function toSchedule(
  slug: string,
  programmes: ReadonlyArray<Parameters<typeof toProgram>[1]>,
): ChannelSchedule {
  return {
    epgId: slug,
    programs: programmes
      .map((programme) => toProgram(slug, programme))
      .sort((a, b) => a.start.getTime() - b.start.getTime()),
  };
}

export function toEpgSnapshot(schedules: ReadonlyMap<string, ChannelSchedule>): EpgSnapshot {
  return {
    schedules,
    updatedAt: new Date().toISOString(),
    origin: 'remote',
    rejected: 0,
  };
}
