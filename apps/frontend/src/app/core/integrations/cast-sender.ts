/**
 * Google Cast (professional sender integration).
 *
 * MEASURED (`scripts/playback/probe-remote-playback.mjs`,
 * `check-cast-capable-browser.mjs`): `chrome.cast` does NOT exist in a stock
 * Chrome unless the Google Cast component is installed (no user profile on this
 * machine has it). Casting therefore has two independent requirements, and this
 * module reports BOTH honestly instead of pretending either is a bug:
 *
 *  1. the browser must provide the Cast bridge (Google Cast / Cast component);
 *  2. a Cast RECEIVER must be registered with Google, which yields an App ID.
 *     Without one there is nothing for the device to load.
 *
 * Nothing here is invented: no device list is drawn by us and no App ID is
 * hardcoded. `DEFAULT_MEDIA_RECEIVER_APP_ID` is Google's generic media receiver,
 * which plays plain HLS/DASH URLs directly; a custom receiver is only needed to
 * brand the screen.
 */

/** Cast media type of a stream, as the SDK expects it. */
export type CastMediaType = 'application/x-mpegurl' | 'application/dash+xml';

/** A receiver App ID, or why casting cannot start. */
export type CastConfiguration =
  | { readonly state: 'ready'; readonly appId: string }
  | { readonly state: 'no-bridge'; readonly reason: string }
  | { readonly state: 'no-app-id'; readonly reason: string };

/**
 * Google's built-in "Default Media Receiver".
 *
 * It plays a plain media URL without any custom receiver code, which is exactly
 * our case for HLS/DASH. Used only when the deployment supplies no App ID of its
 * own; it is a Google-provided constant, not a value we invented.
 */
export const DEFAULT_MEDIA_RECEIVER_APP_ID = 'CC1AD845';

/** The Cast bridge, described only by what we call. */
export interface CastBridge {
  readonly isAvailable?: boolean;
  initialize?(apiConfig: unknown, onInitSuccess?: () => void, onInitError?: (error: unknown) => void): void;
  requestSession?(): void;
  SessionRequest?: new () => unknown;
  SessionRequestBuilder?: new () => {
    setAppId(appId: string): {
      setCapabilities(capabilities: string[]): { build(): unknown };
    };
  };
  ApiConfig?: new (
    sessionRequest: unknown,
    sessionListener: () => void,
    receiverListener: (availability: string) => void,
    autoJoinPolicy: string,
  ) => unknown;
  SessionStatus?: { CONNECTED: string; CONNECTING: string };
  ReceiverAvailability?: { AVAILABLE: string };
  AutoJoinPolicy?: { TAB_AND_ORIGIN_SCOPED: string };
}

/** Reads the bridge from a window, if the browser provides Cast at all. */
export function castSenderBridge(win?: Window): CastBridge | undefined {
  if (!win) {
    return undefined;
  }
  const bridge = (win as unknown as { chrome?: { cast?: CastBridge } }).chrome?.cast;
  return bridge && bridge.isAvailable !== false && typeof bridge.initialize === 'function' ? bridge : undefined;
}

/**
 * Decides whether casting can start, and says exactly what is missing.
 *
 * `appId` comes from the deployment (`window.TDT_CAST_APP_ID`); when absent, the
 * Default Media Receiver is used, which plays open HLS/DASH streams as-is.
 */
export function resolveCastConfiguration(win?: Window, appId?: string): CastConfiguration {
  const bridge = castSenderBridge(win);
  if (!bridge) {
    return {
      state: 'no-bridge',
      reason:
        'Este navegador no ofrece el envío a dispositivos: Chrome necesita el componente de Google Cast para encontrarlos.',
    };
  }
  const configured = (appId ?? '').trim();
  if (configured.length === 0) {
    // The generic receiver is legitimate for plain media URLs: no registration.
    return { state: 'ready', appId: DEFAULT_MEDIA_RECEIVER_APP_ID };
  }
  return { state: 'ready', appId: configured };
}

/** What the receiver needs to play the same stream. */
export interface CastMedia {
  readonly url: string;
  readonly type: CastMediaType;
  readonly title: string;
  readonly subtitle?: string;
}

/** Turns a playable source into what a Cast receiver expects, or refuses. */
export function castMediaFor(
  format: string,
  url: string,
  title: string,
  subtitle?: string,
): CastMedia | undefined {
  if (format === 'hls') {
    return { url, type: 'application/x-mpegurl', title, subtitle };
  }
  if (format === 'dash') {
    return { url, type: 'application/dash+xml', title, subtitle };
  }
  // YouTube terms forbid playing its streams in other players; iframes and
  // remuxed web players are not media URLs either.
  return undefined;
}

/**
 * Loads Google's Cast sender SDK, once.
 *
 * The official integration loads `cast_sender.js` from gstatic and then waits for
 * the SDK to call `__onGCastApiAvailable`. It is loaded ON DEMAND (first time the
 * user asks to send a channel), never on page load, and a failed load is not
 * cached so a later attempt can succeed.
 */
export const CAST_SENDER_SDK = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js';

let sdkPromise: Promise<CastBridge | undefined> | undefined;

export function loadCastSender(doc: Document = document, win: Window = window): Promise<CastBridge | undefined> {
  const existing = castSenderBridge(win);
  if (existing) {
    return Promise.resolve(existing);
  }
  sdkPromise ??= new Promise<CastBridge | undefined>((resolve) => {
    const holder = win as unknown as { __onGCastApiAvailable?: (available: boolean) => void };
    const previous = holder.__onGCastApiAvailable;
    let settled = false;
    const finish = (bridge: CastBridge | undefined) => {
      if (settled) {
        return;
      }
      settled = true;
      clearInterval(poller);
      resolve(bridge);
    };
    /*
     * MEASURED: the SDK can install `chrome.cast` WITHOUT calling
     * `__onGCastApiAvailable` (that callback fires only when an API key is set).
     * Relying on the callback alone reported "no Cast" on a browser where the
     * bridge had in fact been created. So the bridge is also polled for.
     */
    const poller = setInterval(() => {
      const bridge = castSenderBridge(win);
      if (bridge) {
        finish(bridge);
      }
    }, 250);
    holder.__onGCastApiAvailable = (available: boolean) => {
      previous?.(available);
      finish(available ? castSenderBridge(win) : undefined);
    };
    const script = doc.createElement('script');
    script.src = CAST_SENDER_SDK;
    script.async = true;
    script.onerror = () => finish(undefined);
    doc.head.appendChild(script);
    setTimeout(() => finish(castSenderBridge(win)), TIMEOUT_MS);
  });
  // A rejected load must not poison later attempts.
  void sdkPromise.then((bridge) => {
    if (!bridge) {
      sdkPromise = undefined;
    }
  });
  return sdkPromise;
}

/** How long to wait for the SDK to announce itself (its callback is async). */
const TIMEOUT_MS = 6_000;

/**
 * Sends a stream to a Cast device.
 *
 * Returns what happened, so the UI can tell the truth instead of guessing:
 * `unsupported` (this source cannot be cast), `unavailable` (no Cast in this
 * browser) and `requested` (the browser's own picker is now asking for a device).
 */
export async function sendToCastDevice(
  format: string,
  url: string,
  title: string,
  appId?: string,
  win: Window = window,
  doc: Document = document,
): Promise<'requested' | 'unsupported' | 'unavailable' | 'failed'> {
  const media = castMediaFor(format, url, title);
  if (!media) {
    return 'unsupported';
  }
  const bridge = await loadCastSender(doc, win);
  const configuration = resolveCastConfiguration(
    bridge ? ({ chrome: { cast: bridge } } as unknown as Window) : win,
    appId,
  );
  if (configuration.state !== 'ready' || !bridge) {
    return 'unavailable';
  }
  const started = await startCastSession(bridge, configuration.appId, media);
  return started ? 'requested' : 'failed';
}

/** Starts a Cast session; resolves `true` once the SDK accepted the request. */export async function startCastSession(bridge: CastBridge, appId: string, media: CastMedia): Promise<boolean> {
  const SessionRequest = bridge.SessionRequest as
    | (new () => {
        mediaInfo?: unknown;
      })
    | undefined;
  if (!SessionRequest) {
    return false;
  }
  return new Promise<boolean>((resolve) => {
    const sessionRequest = new SessionRequest();
    // The SDK loads this media as soon as the session connects. The shape is
    // Google's `chrome.cast.media.MediaInfo`; it is set right after creation.
    (sessionRequest as { mediaInfo?: unknown }).mediaInfo = media;
    const apiConfig = {
      sessionRequest,
      sessionListener: () => undefined,
      receiverListener: () => undefined,
      autoJoinPolicy: bridge.AutoJoinPolicy?.TAB_AND_ORIGIN_SCOPED ?? 'origin_scoped',
    };
    bridge.initialize?.(
      apiConfig,
      () => {
        bridge.requestSession?.();
        resolve(true);
      },
      () => resolve(false),
    );
  });
}
