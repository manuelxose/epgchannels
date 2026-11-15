/**
 * Official YouTube IFrame integration.
 *
 * Scope (deliberate, documented in `docs/INTEGRATIONS.md`):
 * - we embed only the emitter's own public YouTube player page through YouTube's
 *   official **privacy-enhanced** domain (`youtube-nocookie.com`), with
 *   `origin` restricted to our own origin;
 * - the player is created lazily, only after the user clicks play (no third-party
 *   cookies or network before that);
 * - nothing here resolves media manifests, extracts stream URLs or impersonates a
 *   first-party client. A page URL we cannot express as an official embed stays a
 *   plain link to the emitter.
 */

import { resolveYoutubeTarget } from './youtube-target';

/** Published YouTube IFrame Player API global. Loaded on demand, never bundled. */
export interface YoutubePlayer {
  playVideo(): void;
  pauseVideo(): void;
  /** Official live-stream seek: jumps to the live edge. */
  seekTo?(seconds: number, allowSeekAhead: boolean): void;
  setVolume(volume: number): void;
  getVolume?(): number;
  mute(): void;
  unMute(): void;
  isMuted?(): boolean;
  getPlayerState?(): number;
  getVideoLoadedFraction?(): number;
  getVideoUrl?(): string;
  destroy(): void;
  getIframe(): HTMLIFrameElement | undefined;
}

/** Published player states (`YT.PlayerState`). */
export const YOUTUBE_PLAYER_STATE = {
  unstarted: -1,
  ended: 0,
  playing: 1,
  paused: 2,
  buffering: 3,
  cued: 5,
} as const;

export interface YoutubePlayerEvent {
  /** The player that fired the event. */
  readonly target?: YoutubePlayer;
  /** State code / error code / quality string, depending on the event. */
  readonly data?: number | string;
}

export interface YoutubeApi {
  Player: new (
    element: HTMLElement | string,
    config: {
      host?: string;
      videoId?: string;
      width?: string | number;
      height?: string | number;
      playerVars?: Record<string, string | number>;
      events?: {
        onReady?: (event?: YoutubePlayerEvent) => void;
        onStateChange?: (event: YoutubePlayerEvent) => void;
        onError?: (event: YoutubePlayerEvent) => void;
        onPlaybackQualityChange?: (event: YoutubePlayerEvent) => void;
      };
    },
  ) => YoutubePlayer;
  PlayerState?: Record<string, number>;
}

export const YOUTUBE_IFRAME_API = 'https://www.youtube.com/iframe_api';
export const YOUTUBE_NOCOOKIE_HOST = 'https://www.youtube-nocookie.com';
export const YOUTUBE_HOST = 'https://www.youtube.com';

const YOUTUBE_HOSTNAME = /^(?:[a-z0-9-]+\.)?youtube(?:-nocookie)?\.com$|^youtu\.be$/i;

type YoutubeTarget =
  | { readonly kind: 'video'; readonly videoId: string }
  | { readonly kind: 'channel'; readonly channelId: string };

function safeUrl(url: string): URL | undefined {
  try {
    const parsed = new URL(url, globalThis.location?.href ?? 'http://localhost/');
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isYoutubeHost(url: URL): boolean {
  return YOUTUBE_HOSTNAME.test(url.hostname.toLowerCase());
}

/**
 * The embeddable target of a page URL. Delegates to `resolveYoutubeTarget`, the
 * single validation source of truth: ids are canonical (11-character video ids,
 * `UC…` channel ids) and a handle or an unknown path is never addressable.
 */
function parseTarget(url: string): YoutubeTarget | undefined {
  if (!safeUrl(url) || !isYoutubeHost(new URL(url, globalThis.location?.href ?? 'http://localhost/'))) {
    return undefined;
  }
  const resolved = resolveYoutubeTarget(url);
  if (!resolved.ok) {
    return undefined;
  }
  if (resolved.target.kind === 'video') {
    return { kind: 'video', videoId: resolved.target.videoId };
  }
  if (resolved.target.kind === 'channel') {
    return { kind: 'channel', channelId: resolved.target.channelId };
  }
  return undefined;
}

/**
 * The YouTube identifier carried by an official page URL, if any. Used by the
 * catalog parser to describe the embed without inventing data.
 */
export function youtubeTargetOf(
  url: string,
): { readonly kind: 'video' | 'channel'; readonly id: string } | undefined {
  const target = parseTarget(url);
  if (!target) {
    return undefined;
  }
  return target.kind === 'video' ? { kind: 'video', id: target.videoId } : { kind: 'channel', id: target.channelId };
}

/**
 * Whether the official IFrame player can show this URL. A specific video can
 * always be addressed; a channel can only show its current live stream, which is
 * what `/channel/<UC...>/live` means.
 */
export function isEmbeddableYoutubeUrl(url: string): boolean {
  return parseTarget(url) !== undefined;
}

export interface YoutubeEmbedConfig {
  readonly host: string;
  readonly videoId?: string;
  readonly playerVars: Record<string, string | number>;
}

/**
 * Builds the `YT.Player` configuration for an official page URL that carries a
 * **video** identifier.
 *
 * A channel page (`/channel/<UC…>/live`) has no video id: the API cannot observe
 * its state, so this returns `undefined` and the caller must resolve the channel
 * to a video id first (see `youtube-data-api.ts`) or fall back to a plain link.
 *
 * `origin` is the current origin so YouTube can verify the embedding page; when
 * there is no browsing context (unit tests, SSR) the parameter is omitted.
 */
export function youtubeEmbedConfig(url: string, origin = currentOrigin()): YoutubeEmbedConfig | undefined {
  const target = parseTarget(url);
  if (!target || target.kind !== 'video') {
    return undefined;
  }
  const playerVars: Record<string, string | number> = {
    autoplay: 1,
    playsinline: 1,
    rel: 0,
    modestbranding: 1,
  };
  if (origin) {
    playerVars['origin'] = origin;
  }
  return {
    host: YOUTUBE_NOCOOKIE_HOST,
    videoId: target.videoId,
    playerVars,
  };
}

/** Same configuration, addressed by an already validated video id. */
export function youtubeVideoEmbedConfig(videoId: string, origin = currentOrigin()): YoutubeEmbedConfig | undefined {
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
    return undefined;
  }
  return youtubeEmbedConfig(`https://www.youtube.com/v/${videoId}`, origin);
}

/**
 * The channel-live path used when the target is a channel, not a video.
 *
 * `autoplay`/`playsinline` are published player parameters, and they are what
 * makes the channel start on its own: MEASURED, the bare embed mounts paused
 * (`scripts/playback/probe-autoplay.mjs`). `origin` is our own, as the published
 * API requires whenever the player is embedded or controlled.
 */
export function youtubeChannelLiveUrl(channelId: string, origin = currentOrigin()): string {
  const params = new URLSearchParams({ channel: channelId, autoplay: '1', playsinline: '1' });
  if (origin) {
    params.set('origin', origin);
  }
  return `${YOUTUBE_NOCOOKIE_HOST}/embed/live_stream?${params.toString()}`;
}

function currentOrigin(): string | undefined {
  const origin = globalThis.location?.origin;
  return origin && origin !== 'null' ? origin : undefined;
}

/* ------------------------------------------------------------------------- */
/* API loader: lazily injects the published script once, for every player.    */
/* ------------------------------------------------------------------------- */

let apiPromise: Promise<YoutubeApi> | undefined;

/**
 * Loads the published IFrame Player API.
 *
 * Measured against the real service (`scripts/playback/probe-youtube-api.mjs`):
 * the `/iframe_api` script's `onload` fires ~193 ms BEFORE `YT.Player` exists,
 * so a loader that only checks `onload` rejects against the real API. The API
 * announces readiness by calling `window.onYouTubeIframeAPIReady`, which is what
 * this waits for; any callback the page already installed is chained, never
 * stolen. A failure is not cached, so the next attempt retries the load.
 */
export function loadYoutubeApi(doc?: Document): Promise<YoutubeApi> {
  /*
   * Browser-only. Resolved here (not as a default parameter) so importing this
   * module on a server, or calling it during SSR/prerender, cannot touch a
   * `document` that does not exist: it fails as a normal refusal instead.
   */
  const targetDocument = doc ?? (typeof document === 'undefined' ? undefined : document);
  if (!targetDocument) {
    return Promise.reject(new Error('El reproductor de YouTube solo puede cargarse en el navegador.'));
  }
  const existing = (globalThis as { YT?: YoutubeApi }).YT;
  if (existing?.Player) {
    return Promise.resolve(existing);
  }
  apiPromise ??= new Promise<YoutubeApi>((resolve, reject) => {
    const scope = globalThis as {
      YT?: YoutubeApi;
      onYouTubeIframeAPIReady?: () => void;
      TDT_YOUTUBE_API_WAITING?: (() => void)[];
    };
    const finish = (): void => {
      const api = scope.YT;
      if (api?.Player) {
        resolve(api);
      }
    };
    // One shared waiter list: several player loads in the same page all resolve.
    const previous = scope.onYouTubeIframeAPIReady;
    const waiters = scope.TDT_YOUTUBE_API_WAITING ?? [];
    scope.TDT_YOUTUBE_API_WAITING = [...waiters, finish];
    scope.onYouTubeIframeAPIReady = () => {
      if (typeof previous === 'function') {
        previous();
      }
      for (const waiter of scope.TDT_YOUTUBE_API_WAITING ?? []) {
        waiter();
      }
    };

    const script = targetDocument.createElement('script');
    const fail = (message: string): void => {
      clearTimeout(timer);
      scope.onYouTubeIframeAPIReady = previous;
      scope.TDT_YOUTUBE_API_WAITING = (scope.TDT_YOUTUBE_API_WAITING ?? []).filter((waiter) => waiter !== finish);
      script.remove();
      apiPromise = undefined;
      reject(new Error(message));
    };
    script.src = YOUTUBE_IFRAME_API;
    script.async = true;
    // Never settle from `onload`: the API is not ready at that point. If it never
    // announces readiness, the timeout reports it instead of hanging forever.
    script.onload = () => clearTimeout(timer);
    script.onerror = () => fail('No se ha podido cargar el reproductor oficial de YouTube.');
    const timer = setTimeout(() => fail('La API del reproductor de YouTube no se ha inicializado.'), 20_000);
    targetDocument.head.appendChild(script);
  });
  return apiPromise;
}

/** Test seam: forget a loaded API (never used by the application itself). */
export function resetYoutubeApiForTests(): void {
  apiPromise = undefined;
  delete (globalThis as { YT?: YoutubeApi }).YT;
}

/**
 * YouTube IFrame error codes, mapped to what the user can do.
 *
 * - `101` / `150`: the owner forbids playing this video in embedded players;
 * - `100`: removed/private — there is no stream to play;
 * - `153`: the request carried no `HTTP Referer` (or equivalent client
 *   identification), so YouTube refuses to serve the player at all;
 * - `2`: invalid parameter (a malformed id never reaches the player in our
 *   engine, so this means YouTube considered the request malformed);
 * - `5`: the HTML5 player itself could not start.
 */
export function classifyYoutubeError(code: number): {
  readonly kind: 'embedding' | 'unavailable' | 'client-identity' | 'invalid';
  readonly message: string;
} {
  switch (code) {
    case 150:
    case 101:
      return { kind: 'embedding', message: 'El emisor no permite incrustar esta emisión fuera de YouTube.' };
    case 153:
      return {
        kind: 'client-identity',
        message:
          'YouTube exige que la página identifique el reproductor y esta solicitud no lleva esa identificación.',
      };
    case 100:
      return { kind: 'unavailable', message: 'La emisión de YouTube ya no está disponible.' };
    case 2:
      return { kind: 'invalid', message: 'La emisión de YouTube ha rechazado la reproducción (de nuevo).' };
    case 5:
      return { kind: 'unavailable', message: 'El reproductor oficial de YouTube no ha podido iniciarse.' };
    default:
      return { kind: 'unavailable', message: 'El reproductor oficial de YouTube ha informado de un error.' };
  }
}
