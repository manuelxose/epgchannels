/**
 * Resolves a YouTube CHANNEL to the video it is broadcasting right now.
 *
 * Why this exists: 203 of the catalogue's published YouTube sources point at
 * `/channel/<id>/live`, a page that names a channel instead of a video. The
 * official IFrame player refuses that ("Invalid video id", measured), so the
 * app could only mount a raw iframe whose playback state is unobservable — the
 * player showed "En pausa" for channels that were broadcasting.
 *
 * Measured on this host (`node scripts/probe-channel-page.mjs`, kept as a
 * documented probe): the public live page of the channel announces the video in
 * its canonical link:
 *
 *   https://www.youtube.com/channel/<UC…>/live
 *     -> <link rel="canonical" href="https://www.youtube.com/watch?v=q5NLEgG7kmY">
 *
 * That video id plays in the official IFrame player, where every state is
 * observable (measured: ready -> state:-1 -> state:1).
 *
 * Deliberate limits:
 * - The Data API is NOT used. It costs 100 quota units per channel and the free
 *   daily allocation allows ~100 lookups: unusable for hundreds of channels and
 *   thousands of users. This resolver has no quota.
 * - Only the canonical link is read: no manifests, no stream URLs, no player
 *   responses, no tokens, no undocumented endpoints.
 * - It is a fallback for a page that does not identify a video, and it is
 *   cached: nothing here runs on the request path of a user.
 */

/** What a resolution attempt concluded. */
export type ChannelResolution =
  | { readonly kind: 'live'; readonly videoId: string }
  /** The page loaded but the channel is not broadcasting: YouTube shows an offline page. */
  | { readonly kind: 'offline' }
  /** The page could not be read (network, status, markup change). */
  | { readonly kind: 'unavailable'; readonly reason: string };

const CHANNEL_LIVE_PAGE = 'https://www.youtube.com/channel';
const VIDEO_ID = /^[\w-]{11}$/;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/**
 * A plain browser user agent. The public page serves the same document to a
 * browser and to this fetch; no cookie, no login and no token is involved.
 */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export interface ChannelResolverOptions {
  /** Injected for tests; defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Abort a single page read. */
  readonly timeoutMs?: number;
}

/** Extracts the video id from a canonical/watch URL, or null when there is none. */
export function videoIdFromCanonical(canonical: string): string | null {
  let url: URL;
  try {
    url = new URL(canonical);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host !== 'youtube.com' && host !== 'www.youtube.com' && host !== 'm.youtube.com') {
    return null;
  }
  if (url.pathname === '/watch') {
    const id = url.searchParams.get('v') ?? '';
    return VIDEO_ID.test(id) ? id : null;
  }
  // `/live/<id>` and `/embed/<id>` are addressable videos too.
  const match = /^\/(?:live|embed)\/([\w-]{11})$/.exec(url.pathname);
  return match?.[1] && VIDEO_ID.test(match[1]) ? match[1] : null;
}

/** Reads the canonical link of a channel's live page. Exported for the tests. */
export function canonicalOf(html: string): string | null {
  return /<link rel="canonical" href="([^"]+)"/.exec(html)?.[1] ?? null;
}

/**
 * Resolves one channel to its current live video.
 *
 * `offline` is a definite answer (YouTube served the channel page without a live
 * video); `unavailable` means we could not tell, and the caller must not present
 * that as "not broadcasting".
 */
export async function resolveChannelLiveVideo(
  channelId: string,
  options: ChannelResolverOptions = {},
): Promise<ChannelResolution> {
  if (!/^UC[\w-]{20,}$/.test(channelId)) {
    return { kind: 'unavailable', reason: 'invalid-channel-id' };
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8_000);
  try {
    const response = await fetchImpl(`${CHANNEL_LIVE_PAGE}/${encodeURIComponent(channelId)}/live`, {
      redirect: 'follow',
      credentials: 'omit',
      signal: controller.signal,
      headers: { 'user-agent': USER_AGENT, 'accept-language': 'es-ES,es;q=0.9,en;q=0.8' },
    });
    if (!response.ok) {
      return { kind: 'unavailable', reason: `http-${response.status}` };
    }
    const body = await response.text();
    if (body.length > MAX_BODY_BYTES) {
      return { kind: 'unavailable', reason: 'page-too-large' };
    }
    const canonical = canonicalOf(body);
    if (!canonical) {
      return { kind: 'unavailable', reason: 'no-canonical' };
    }
    const videoId = videoIdFromCanonical(canonical);
    if (videoId) {
      return { kind: 'live', videoId };
    }
    // A canonical that is not a watch URL means YouTube served the channel page
    // itself: the channel is not broadcasting right now.
    return { kind: 'offline' };
  } catch (error) {
    const reason = error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'network';
    return { kind: 'unavailable', reason };
  } finally {
    clearTimeout(timer);
  }
}

/** The official page a human can open for the channel. */
export function channelLivePageUrl(channelId: string): string {
  return `https://www.youtube.com/channel/${encodeURIComponent(channelId)}/live`;
}
