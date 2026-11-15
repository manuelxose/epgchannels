/**
 * Verified playback states (spec §9).
 *
 * The UI may only claim a state it can back with published catalog data:
 *
 * | state                | label                        | backed by                                                            |
 * | -------------------- | ---------------------------- | -------------------------------------------------------------------- |
 * | `live`               | Ver en directo               | an in-app source this browser can attempt                            |
 * | `official-embed`     | Ver en directo (oficial)     | an official YouTube page the IFrame player may embed                 |
 * | `official-site`      | Disponible en la web oficial | the emitter's own page/player URL                                    |
 * | `eventual`           | Emisión eventual             | the catalog marks an eventual (EVT) emission, or only its guide      |
 * | `unavailable`        | No disponible actualmente    | nothing playable and no usable official route                        |
 * | `requires-official`  | Requiere acceso oficial      | publishing needs the emitter's own app or a Referer we refuse to forge |
 *
 * "Ver en directo" is never offered for a source that cannot play in our app
 * here: geo-restricted, unplayable (client tokens), a container this browser
 * cannot decode. Those fall through to the official route and, when that is not
 * playable in-app either, to an external link.
 */
import type { AvailabilityTag, Channel, MediaSource, PlaybackAvailability } from '../models/catalog.model';
import { canEmbed, isEligibleSource } from '../models/catalog.model';
import { youtubeTargetOf } from './youtube-embed';

export type VerifiedStateKind =
  | 'live'
  | 'official-embed'
  | 'official-site'
  | 'eventual'
  | 'unavailable'
  | 'requires-official';

/** Why a published source is not attempted. Only catalog-evidenced reasons exist. */
export type SourceBlockReason = 'geo' | 'unplayable-url' | 'format';

/** Capabilities the browser exposes; injected so the rule stays pure and testable. */
export interface PlaybackCapabilities {
  /** `MediaSource` in use (hls.js / dash.js capable). */
  readonly mediaSource: boolean;
  readonly canPlayHls: boolean;
  readonly canPlayProgressive: boolean;
}

export const NO_CAPABILITIES: PlaybackCapabilities = {
  mediaSource: false,
  canPlayHls: false,
  canPlayProgressive: false,
};

export interface VerifiedAction {
  readonly kind: 'in-app' | 'embed' | 'external';
  /** The YouTube page to embed (`embed`) or the page to open (`external`). */
  readonly url?: string;
  /** Source id of the embed to show, when `kind` is `embed`. */
  readonly sourceId?: string;
}

export interface VerifiedState {
  readonly kind: VerifiedStateKind;
  /** Spanish label rendered verbatim. */
  readonly label: string;
  /** Explains *why*, backed by the published facts. */
  readonly reason: string;
  /** Primary action, when there is one. */
  readonly action?: VerifiedAction;
  /** Every published source that cannot be attempted here, with the reason why. */
  readonly blockedSources: readonly { readonly source: MediaSource; readonly reason: SourceBlockReason }[];
}

const LABELS: Readonly<Record<VerifiedStateKind, string>> = {
  live: 'Ver en directo',
  'official-embed': 'Ver en directo (oficial)',
  'official-site': 'Disponible en la web oficial',
  eventual: 'Emisión eventual',
  unavailable: 'No disponible actualmente',
  'requires-official': 'Requiere acceso oficial',
};

export function verifiedStateLabel(kind: VerifiedStateKind): string {
  return LABELS[kind];
}

/**
 * UAG: the emitter's registered app only. REF-prefixed tags (REF, REFI1,
 * REFC1, …): the source needs a Referer the browser cannot set. Any of these
 * means the published URL is not an authorised, usable route for us, so it is
 * never attempted.
 *
 * NONAV is deliberately NOT included: it means "no navigation", i.e. the link
 * is not a navigable page — advice for a browser, not a restriction. Treating
 * it as one refused channels whose streams are public and play correctly (for
 * example Noroeste TV, tagged NONAV and serving a CORS-enabled HLS stream).
 */
export function requiresOfficialAccess(tags: readonly AvailabilityTag[]): boolean {
  return tags.some((tag) => tag.startsWith('UAG') || tag.startsWith('REF'));
}

function mediaSourceCanPlay(source: MediaSource, capabilities: PlaybackCapabilities): boolean {
  switch (source.format) {
    case 'hls':
      return capabilities.mediaSource || capabilities.canPlayHls;
    case 'dash':
      return capabilities.mediaSource;
    case 'progressive':
      return capabilities.canPlayProgressive;
    default:
      return false;
  }
}

function blockReason(source: MediaSource): SourceBlockReason {
  if (source.geoRestricted) {
    return 'geo';
  }
  return source.unplayable ? 'unplayable-url' : 'format';
}

/** The emitter's own page: a published embed page first, then its site. */
export function officialLink(channel: Channel, sources: readonly MediaSource[]): VerifiedAction | undefined {
  const iframe = sources.find((source) => source.format === 'iframe');
  const youtube = sources.find((source) => source.format === 'youtube');
  const url = iframe?.url ?? youtube?.url ?? channel.webUrl;
  return url ? { kind: 'external', url } : undefined;
}

export interface VerifiedStateInput {
  readonly channel: Channel;
  /** Every published option parsed as a media source, playable or not. */
  readonly sources: readonly MediaSource[];
  readonly capabilities: PlaybackCapabilities;
  /** Catalog classification; defaults to the channel's own. */
  readonly availability?: PlaybackAvailability;
}

export function verifiedPlaybackState({
  channel,
  sources,
  capabilities,
  availability = channel.availability,
}: VerifiedStateInput): VerifiedState {
  const blocked = sources
    .filter((source) => !isEligibleSource(source) || !mediaSourceCanPlay(source, capabilities))
    .map((source) => ({ source, reason: blockReason(source) }));
  const link = officialLink(channel, sources);

  /*
   * 0. The publisher states this signal needs its own access (UAG: emitter
   *    app; REF*: a Referer a browser cannot set). That restriction outranks
   *    "the URL looks playable": handing the URL to hls.js anyway made the app
   *    claim "Ver en directo" for streams the emitter answers with 403.
   *
   *    A published official YouTube page is its own player and is unaffected: we
   *    never forge the emitter's client data to reach it, we hand the page to
   *    YouTube's official player. That covers both a video page
   *    (`/live/<id>`) and a channel page (`/channel/<UC…>/live`), whose live
   *    video is resolved through the documented Data API at runtime.
   */
  const youtubeEmbed = sources.find(
    (source) => source.format === 'youtube' && !source.geoRestricted && canEmbed(source),
  );
  if (requiresOfficialAccess(channel.tags) && !youtubeEmbed) {    const applicationOnly = channel.tags.includes('UAG') || channel.tags.includes('NONAV');
    /*
     * A YouTube page we may not embed is still the emitter's own player: send
     * the user there directly, where the page opens in YouTube itself.
     */
    const youtubePage = sources.find((source) => source.format === 'youtube' && !source.geoRestricted && source.url);
    return {
      kind: 'requires-official',
      label: LABELS['requires-official'],
      reason: applicationOnly
        ? 'El emisor solo publica esta señal para su propia aplicación o página; aquí no falsificamos sus datos de cliente.'
        : 'El emisor solo sirve esta señal con una cabecera Referer que un navegador no puede enviar; no la falsificamos.',
      action: youtubePage ? { kind: 'external', url: youtubePage.url } : link,
      blockedSources: blocked,
    };
  }

  // 1. Our own player can attempt a published stream.
  const playable = sources.find((source) => isEligibleSource(source) && mediaSourceCanPlay(source, capabilities));
  if (playable) {
    const container = playable.format === 'progressive' ? 'MP4' : playable.format.toUpperCase();
    return {
      kind: 'live',
      label: LABELS.live,
      reason: `Se reproduce aquí desde la señal publicada por el emisor (${container}).`,
      action: { kind: 'in-app' },
      // Embeds are not "blocked" when the in-app stream already wins.
      blockedSources: blocked.filter((entry) => entry.source.format !== 'youtube' && entry.source.format !== 'iframe'),
    };
  }

  // 2. (moved to step 0) An access restriction on the channel outranks the
  //    mere presence of a URL, so it is decided before "live".

  // 2. Only an official YouTube page we can address is left: show it in
  //    YouTube's own IFrame player (privacy-enhanced, click-to-play) instead of
  //    linking out. This wins whenever nothing else in the channel is an in-app
  //    stream: the catalogue's `playable` tag only counted the YouTube option's
  //    presence, and a geo-restricted stream must not hide a usable embed.
  const streamHere = sources.some((source) => isEligibleSource(source) && mediaSourceCanPlay(source, capabilities));
  if (youtubeEmbed && !streamHere) {
    return {
      kind: 'official-embed',
      label: LABELS['official-embed'],
      reason: 'Se ve en el reproductor oficial de YouTube, incrustado por el emisor y sin cookies hasta que pulses.',
      action: { kind: 'embed', url: youtubeEmbed.url, sourceId: youtubeEmbed.id },
      blockedSources: blocked.filter((entry) => entry.source.id !== youtubeEmbed.id),
    };
  }

  // 4. A stream was published but cannot be attempted from here.
  if (blocked.length > 0) {
    const notice = blocked.some((entry) => entry.reason === 'format')
      ? 'Este navegador no puede reproducir el formato publicado.'
      : blocked.some((entry) => entry.reason === 'unplayable-url')
        ? 'Las señales publicadas exigen datos de cliente que no fabricamos.'
        : 'Las señales publicadas están bloqueadas por región desde aquí.';
    if (!link) {
      return { kind: 'unavailable', label: LABELS.unavailable, reason: notice, blockedSources: blocked };
    }
    return {
      kind: 'official-site',
      label: LABELS['official-site'],
      reason: `${notice} Esta página enlaza con la del emisor.`,
      action: link,
      blockedSources: blocked,
    };
  }

  // 5. The emitter publishes its own page: link out, never claim playback.
  if (availability === 'external') {
    const iframePage = sources.find((source) => source.format === 'iframe');
    const page = iframePage?.url ?? channel.webUrl;
    if (page) {
      return {
        kind: 'official-site',
        label: LABELS['official-site'],
        reason: iframePage
          ? 'El emisor solo sirve esta señal desde su propia página: aquí no incrustamos su reproductor.'
          : 'El emisor publica su emisión en su página oficial; aquí no incrustamos su reproductor.',
        action: { kind: 'external', url: page },
        blockedSources: blocked,
      };
    }
  }

  // 6. Catalogued only as an eventual emission (NOEM includes guide-only channels).
  if (channel.tags.includes('EVT') || channel.tags.includes('NOEM') || availability === 'no-emission') {
    return {
      kind: 'eventual',
      label: LABELS.eventual,
      reason: 'El emisor la publica como emisión eventual: puede no haber señal continua en línea.',
      action: link,
      blockedSources: blocked.filter((entry) => entry.source.format !== 'youtube' && entry.source.format !== 'iframe'),
    };
  }

  return {
    kind: 'unavailable',
    label: LABELS.unavailable,
    reason: 'El catálogo no publica ninguna señal ni página de emisión utilizable para este canal.',
    action: link,
    blockedSources: blocked,
  };
}
