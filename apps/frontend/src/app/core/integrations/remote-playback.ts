/**
 * Cast / remote playback discovery (ENGINE: device casting).
 *
 * Measured (`scripts/playback/probe-remote-playback.mjs`,
 * `check-cast-capable-browser.mjs`): whether a browser can FIND devices on the
 * network depends on the platform, not on us:
 *
 * | Surface                       | What it gives us                                  |
 * | ----------------------------- | ------------------------------------------------- |
 * | `chrome.cast` (Media Router)  | Google's own device picker: a real list of devices |
 * | `HTMLMediaElement.remotePlayback` | standard Remote Playback API (Chrome, Edge)  |
 * | `webkitShowPlaybackTargetPicker` | AirPlay picker (Safari)                      |
 *
 * The app therefore drives whichever the browser exposes and never renders a
 * device list of its own: a fabricated list would be a lie, and a real one needs
 * Google's signed Cast receiver to be registered by the deployment.
 *
 * The one thing we can always do honestly is send the player we OWN (the `<video>`
 * of the HLS/DASH engines). YouTube's player lives in a cross-origin frame whose
 * document is unreachable (`contentDocument === null`, measured), so it cannot be
 * handed to any remote surface from here — its own in-player cast icon is the only
 * route, and it is controlled by YouTube.
 */

/** How the current browser can send playback to another device. */
export type RemotePlaybackRoute = 'cast' | 'remote-playback' | 'airplay' | 'presentation';

export interface RemotePlaybackCapabilities {
  /** Routes available in this browser, in preference order. */
  readonly routes: readonly RemotePlaybackRoute[];
  /** The engine can be handed over only if it owns a same-origin media element. */
  readonly canCastOwnMedia: boolean;
}

/** The remote surfaces of one media element, as the browser reports them. */
export interface MediaRemoteSurfaces {
  readonly hasRemotePlayback: boolean;
  readonly hasAirPlayPicker: boolean;
}

/** Chrome's Media Router bridge, present only where Chrome ships Cast Receiver. */
export interface CastBridge {
  readonly isAvailable?: boolean;
  readonly initialize?: (apiConfig: unknown, onInitSuccess?: () => void, onInitError?: (error: unknown) => void) => void;
  readonly requestSession?: () => void;
}

/** Feature detection without the DOM types, so this runs anywhere. */
export function readBrowserRemoteSurfaces(win?: Window, media?: HTMLMediaElement | null): MediaRemoteSurfaces {
  if (!win) {
    return { hasRemotePlayback: false, hasAirPlayPicker: false };
  }
  return {
    hasRemotePlayback: Boolean(media && 'remotePlayback' in media),
    hasAirPlayPicker:
      typeof (media as unknown as { webkitShowPlaybackTargetPicker?: unknown })?.webkitShowPlaybackTargetPicker ===
      'function',
  };
}

/** The Cast bridge of this window, if the browser exposes one. */
export function castBridgeOf(win?: Window): CastBridge | undefined {
  if (!win) {
    return undefined;
  }
  const cast = (win as unknown as { chrome?: { cast?: CastBridge } }).chrome?.cast;
  return cast && cast.isAvailable !== false ? cast : undefined;
}

/** Opens the browser's AirPlay device picker for a media element. */
export function showAirPlayPicker(media: HTMLMediaElement): boolean {
  const picker = (media as unknown as { webkitShowPlaybackTargetPicker?: () => void })
    .webkitShowPlaybackTargetPicker;
  if (typeof picker !== 'function') {
    return false;
  }
  picker.call(media);
  return true;
}

/**
 * Asks the browser's Remote Playback API to send this media element to a device.
 * The browser itself shows the device list; the app never invents one.
 */
export async function startRemotePlayback(media: HTMLMediaElement): Promise<boolean> {
  const remote = (media as unknown as { remotePlayback?: { prompt?: () => Promise<void> } }).remotePlayback;
  if (typeof remote?.prompt !== 'function') {
    return false;
  }
  await remote.prompt();
  return true;
}

/**
 * Which routes this browser offers, in the order the UI should try them.
 *
 * `ownsMedia` is the engine's answer: only a same-origin `<video>` can be handed
 * over; a cross-origin third-party player (YouTube) cannot.
 */
export function remotePlaybackCapabilities(
  surfaces: { hasCastBridge: boolean; hasRemotePlayback: boolean; hasAirPlayPicker: boolean },
  ownsMedia: boolean,
): RemotePlaybackCapabilities {
  const routes: RemotePlaybackRoute[] = [];
  if (surfaces.hasCastBridge) {
    // The browser's own picker already speaks Cast: it lists real devices.
    routes.push('cast');
  }
  if (surfaces.hasRemotePlayback && ownsMedia) {
    routes.push('remote-playback');
  }
  if (surfaces.hasAirPlayPicker && ownsMedia) {
    routes.push('airplay');
  }
  // Discovery can outlive a particular media element (a TV or a phone on the
  // network is discovered by the browser, not by this <video>), so what matters
  // for offering the button is that SOME route exists.
  return { routes, canCastOwnMedia: ownsMedia && routes.length > 0 };
}

/**
 * Can this SOURCE be sent to another device?
 *
 * "Send to a device" hands the device a URL, and the DEVICE fetches it — not our
 * browser. Measured (`scripts/playback/probe-castable-sources.mjs`): a plain
 * device client can open ~72% of the catalogue's HLS streams directly (18 of 25
 * sampled, 13 allowing cross-origin use); the rest require tokens or a player we
 * do not proxy.
 *
 * YouTube is deliberately excluded: its terms forbid extracting or redirecting
 * its stream to other players, so it is never sent.
 */
export type CastableSource =
  | { readonly kind: 'link'; readonly url: string; readonly mime: 'application/vnd.apple.mpegurl' | 'application/dash+xml' }
  /** The receiver has no way to open this source (YouTube, iframes, remuxed web players). */
  | { readonly kind: 'unsupported'; readonly reason: string };

export function castableSource(format: string, url: string): CastableSource {
  if (format === 'hls') {
    return { kind: 'link', url, mime: 'application/vnd.apple.mpegurl' };
  }
  if (format === 'dash') {
    return { kind: 'link', url, mime: 'application/dash+xml' };
  }
  if (format === 'youtube') {
    return {
      kind: 'unsupported',
      reason:
        'YouTube no permite reproducir sus emisiones en otros reproductores, así que no se envían a un dispositivo: se ven aquí o en YouTube.',
    };
  }
  if (format === 'iframe' || format === 'stream') {
    return {
      kind: 'unsupported',
      reason: 'Esta emisión solo se reproduce dentro de la web del emisor y no se puede enviar a otro dispositivo.',
    };
  }
  return {
    kind: 'unsupported',
    reason: 'Este canal tiene una señal propia que un televisor no puede abrir directamente.',
  };
}

/** Everything the receiver device needs to start the same channel. */
export interface CastSessionPayload {
  readonly v: 1;
  readonly channel: { readonly id: string; readonly name: string; readonly logo?: string };
  /** The catalogue page, so a phone can offer "open in TDT Player". */
  readonly appUrl: string;
}

/** URL-safe base64 (the payload travels in a fragment, never to a server). */
export function encodeSessionPayload(payload: CastSessionPayload): string {
  const json = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeSessionPayload(token: string): CastSessionPayload | undefined {
  try {
    const normalized = token.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof parsed !== 'object' || parsed === null) {
      return undefined;
    }
    const payload = parsed as Partial<CastSessionPayload>;
    if (payload.v !== 1 || typeof payload.channel?.id !== 'string' || typeof payload.appUrl !== 'string') {
      return undefined;
    }
    return payload as CastSessionPayload;
  } catch {
    return undefined;
  }
}

/** The link a phone receives: our own catalogue page plus the channel to open. */
export function sessionLink(appUrl: string, payload: CastSessionPayload): string {
  const base = appUrl.replace(/#.*$/, '');
  return `${base}#/cast/${encodeSessionPayload(payload)}`;
}
