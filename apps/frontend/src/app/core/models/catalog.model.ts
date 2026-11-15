/**
 * Domain model for the television catalogue.
 *
 * These types are the application's own contract: they are derived from the
 * published catalog data shape, not from any third-party implementation.
 */

/**
 * `dash` is a real streaming format (MPEG-DASH `.mpd`) played by dash.js; it is
 * never treated as a progressive file. `youtube`/`iframe` are official embeds:
 * they are never handed to a media engine, only offered as links to the
 * emitter's own player.
 */
export type MediaFormat = 'hls' | 'dash' | 'youtube' | 'iframe' | 'progressive';

/** Availability hints published by the catalog; unknown values are tolerated. */
export type AvailabilityTag =
  | 'GEO'
  | 'EXTA'
  | 'EXTB'
  | 'EMB'
  | 'NOEM'
  | 'EVT'
  | 'REG'
  | 'REF'
  | 'NONAV'
  | 'UAG'
  /** Numbered variants the catalogue publishes (REFI1, REFC1, UAGB, …). */
  | (string & {});

export interface MediaSource {
  /** Stable identifier: `${channelId}#${index}`. */
  readonly id: string;
  /** Human label shown in the source picker, e.g. "Emisión 1". */
  readonly label: string;
  readonly format: MediaFormat;
  readonly url: string;
  /** Optional Referer header hint. Browsers cannot set it; recorded for diagnostics. */
  readonly referer?: string;
  readonly resolution?: string;
  readonly language?: string;
  /** True when the catalog marks the option or channel as geo-restricted. */
  readonly geoRestricted: boolean;
  /**
   * True when the URL needs client data we refuse to forge (e.g. placeholder
   * tokens), so it is listed for transparency but never attempted.
   */
  readonly unplayable?: boolean;
  /**
   * Embed-only source: `true` when its URL is an official YouTube page the
   * official IFrame player may show. Read defensively (see `canEmbed`).
   */
  readonly embed?: boolean;
  /** Official identifier carried by the page URL (YouTube video/channel id). */
  readonly platformId?: string;
}

export type PlaybackAvailability = 'playable' | 'external' | 'no-emission' | 'unavailable';

export interface Channel {
  readonly id: string;
  readonly name: string;
  readonly categoryId: string;
  readonly categoryName: string;
  readonly country: string;
  readonly webUrl?: string;
  readonly logoSrc?: string;
  readonly epgId?: string;
  /** Sources the catalog publishes, embeds included (so the UI can say why not). */
  readonly sources: readonly MediaSource[];
  /** Official embeds (YouTube/iframe) offered as links, never proxied. */
  readonly embargoedSources?: readonly OfficialEmbed[];
  readonly tags: readonly AvailabilityTag[];
  readonly availability: PlaybackAvailability;
}

/** An official player URL published by the emitter. */
export interface OfficialEmbed {
  readonly id: string;
  readonly provider: 'youtube' | 'iframe';
  readonly url: string;
  /** YouTube canonical identifier (video or channel), when the URL carries one. */
  readonly youtubeId?: string;
  readonly youtubeKind?: 'video' | 'channel';
  /** True when the URL is a player page we can embed in the official IFrame player. */
  readonly embeddable?: boolean;
}

export interface ChannelCategory {
  readonly id: string;
  readonly name: string;
  readonly country: string;
  readonly channelCount: number;
}

export interface CatalogSnapshot {
  readonly channels: readonly Channel[];
  readonly categories: readonly ChannelCategory[];
  readonly epgJsonUrl?: string;
  /** ISO timestamp of when the snapshot was produced. */
  readonly updatedAt: string;
  readonly origin: 'remote' | 'demo';
  /** Number of catalog entries rejected during validation. */
  readonly rejected: number;
}

export interface EpgProgram {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly genre?: string;
  readonly coverUrl?: string;
  readonly start: Date;
  readonly end: Date;
}

export interface ChannelSchedule {
  readonly epgId: string;
  /** Sorted by start; validated and de-duplicated. */
  readonly programs: readonly EpgProgram[];
}

export interface EpgSnapshot {
  readonly schedules: ReadonlyMap<string, ChannelSchedule>;
  readonly updatedAt: string;
  readonly origin: 'remote' | 'demo';
  /** Number of events rejected during validation. */
  readonly rejected: number;
}

/** Result of asking the source adapter how a channel should be presented. */
export type PlaybackPlan =
  | { readonly kind: 'hls'; readonly url: string }
  | { readonly kind: 'dash'; readonly url: string }
  | { readonly kind: 'progressive'; readonly url: string }
  | { readonly kind: 'youtube'; readonly url: string }
  | { readonly kind: 'external'; readonly externalUrl?: string }
  | { readonly kind: 'no-emission' }
  | { readonly kind: 'none' };

/**
 * Builds the playback plan for a channel: the first source the player can
 * attempt wins; otherwise the emitter's official player is offered when known.
 */
export function planPlayback(channel: Channel): PlaybackPlan {
  const source = channel.sources.find((candidate) => isEligibleSource(candidate));
  switch (source?.format) {
    case 'hls':
      return { kind: 'hls', url: source.url };
    case 'dash':
      return { kind: 'dash', url: source.url };
    case 'progressive':
      return { kind: 'progressive', url: source.url };
    case 'youtube':
      // Official YouTube page: played in-app by the official IFrame engine.
      return { kind: 'youtube', url: source.url };
    default:
      break;
  }
  /*
   * A channel page carries no video id, so it is not an engine-eligible source,
   * but it IS an in-app route: the official player shows it once the channel's
   * live video is resolved. It must not be planned as an external redirect.
   */
  const youtubeChannel = channel.sources.find((candidate) => youtubeChannelSource(candidate));
  if (youtubeChannel) {
    return { kind: 'youtube', url: youtubeChannel.url };
  }
  const embed = channel.embargoedSources?.[0];
  if (embed) {
    return { kind: 'external', externalUrl: embed.url };
  }
  if (channel.availability === 'external') {
    return { kind: 'external', externalUrl: channel.webUrl };
  }
  if (channel.availability === 'no-emission' || channel.availability === 'unavailable') {
    return { kind: 'no-emission' };
  }
  return { kind: 'none' };
}

import { isEmbeddableYoutubeUrl } from '../integrations/youtube-embed';
import { resolveYoutubeTarget } from '../integrations/youtube-target';

/**
 * A source is eligible for the in-app player when its container is streamed by
 * one of our engines (HLS, DASH, progressive) or it is an official YouTube page
 * that carries a **video** identifier, the URL is not geo-locked by the
 * catalogue and it does not need client data we refuse to forge.
 *
 * A YouTube *channel* page is not eligible by this rule alone: it names a
 * channel, and whether that channel is live and embeddable is a runtime answer
 * (see `youtubeChannelSource` and the watch page). Handles are never eligible:
 * we cannot verify what they point at.
 */
export function isEligibleSource(source: MediaSource): boolean {
  if (source.geoRestricted || source.unplayable) {
    return false;
  }
  if (source.format === 'youtube') {
    return youtubeVideoSource(source);
  }
  return source.format === 'hls' || source.format === 'dash' || source.format === 'progressive';
}

/** The YouTube source that names a specific video (the only one an engine can drive). */
export function youtubeVideoSource(source: MediaSource): boolean {
  if (source.format !== 'youtube') {
    return false;
  }
  const target = resolveYoutubeTarget(source.url);
  return target.ok && target.target.kind === 'video';
}

/** The YouTube source that names a channel, whose live video must be resolved. */
export function youtubeChannelSource(source: MediaSource): boolean {
  if (source.format !== 'youtube') {
    return false;
  }
  const target = resolveYoutubeTarget(source.url);
  return target.ok && (target.target.kind === 'channel' || target.target.kind === 'handle');
}

/**
 * Whether an official page URL can be shown in the official YouTube IFrame
 * player. Platforms (iOS Safari) expose an `embed` field that `parseCatalog`
 * does not validate, so the format check reads it defensively.
 */
export function canEmbed(source: MediaSource): boolean {
  const embed = (source as { readonly embed?: unknown }).embed;
  return embed === true && source.format === 'youtube' && isEmbeddableYoutubeUrl(source.url);
}

/**
 * A channel may be attempted by our own player only when it declares a catalog
 * format our engines understand. Official YouTube/iframe options are embeds, not
 * media, so a channel that only declares them is never "in app" playable.
 */
export function canPlayInApp(channel: Channel): boolean {
  return channel.sources.some((source) => isEligibleSource(source));
}

/**
 * The embed the official IFrame player can show, if any. Only official YouTube
 * player pages (channel `/live` or a specific `/live/<id>`) qualify: anything
 * else stays a plain link to the emitter.
 */
export function embeddableVideo(channel: Channel): OfficialEmbed | undefined {
  return channel.embargoedSources?.find((embed) => embed.provider === 'youtube' && embed.embeddable);
}
