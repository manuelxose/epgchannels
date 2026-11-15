/**
 * YouTube target resolution (TDT-CLONE-12 §1/§3).
 *
 * Pure, dependency-free and SSR-safe: it turns a published page URL into the
 * identifier the official YouTube players accept, or into an explicit refusal.
 * Nothing here contacts YouTube.
 *
 * Two identifiers, deliberately kept apart:
 *
 * | identifier  | shape                     | what the IFrame API accepts        |
 * | ----------- | ------------------------- | ---------------------------------- |
 * | video id    | 11 chars `[A-Za-z0-9_-]`  | `YT.Player({ videoId })`           |
 * | channel id  | `UC` + 22 chars           | only through the channel live page |
 *
 * A handle (`/@name`), a legacy `/c/<name>` or `/user/<name>` page names a
 * channel but carries no id we could verify, so it is a distinct target kind and
 * is NEVER replayed as if it were a video or a verified channel id.
 */

/** Canonical video id: exactly 11 URL-safe base64 characters. */
export const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
/** Canonical channel id: `UC` + 22 URL-safe base64 characters. */
export const YOUTUBE_CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
/** Handle as YouTube accepts it (`@` + 3–30 of letters, digits, `_`, `-`, `.`). */
export const YOUTUBE_HANDLE = /^[A-Za-z0-9_.-]{3,30}$/;

const YOUTUBE_HOSTNAME = /^(?:[a-z0-9-]+\.)?youtube(?:-nocookie)?\.com$|^youtu\.be$/;

export type YoutubeTarget =
  | { readonly kind: 'video'; readonly videoId: string }
  | { readonly kind: 'channel'; readonly channelId: string }
  | { readonly kind: 'handle'; readonly handle: string };

/** Why a published YouTube URL cannot be used as an identifier. */
export type YoutubeTargetProblem =
  | 'not-a-url'
  | 'foreign-host'
  | 'unsupported-path'
  | 'invalid-video-id'
  | 'invalid-channel-id'
  | 'invalid-handle'
  | 'not-live-path';

export type YoutubeTargetResult =
  | { readonly ok: true; readonly target: YoutubeTarget; readonly url: URL }
  | { readonly ok: false; readonly problem: YoutubeTargetProblem };

function parseUrl(url: string): URL | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** True for any host we may talk to about YouTube; never a lookalike domain. */
export function isYoutubeHost(url: string | URL): boolean {
  try {
    const parsed = typeof url === 'string' ? new URL(url) : url;
    return YOUTUBE_HOSTNAME.test(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Trims a candidate id and answers whether it is a canonical video id. */
export function normalizeVideoId(candidate: string | undefined): string | undefined {
  const trimmed = candidate?.trim();
  return trimmed && YOUTUBE_VIDEO_ID.test(trimmed) ? trimmed : undefined;
}

export function normalizeChannelId(candidate: string | undefined): string | undefined {
  const trimmed = candidate?.trim();
  return trimmed && YOUTUBE_CHANNEL_ID.test(trimmed) ? trimmed : undefined;
}

/**
 * Reads the video id out of the official page shapes:
 * `/watch?v=`, `/live/`, `/embed/`, `/v/`, `/shorts/`, `youtu.be/`, and the
 * legacy `/live_stream?channel=` (which is a channel, not a video).
 */
export function resolveYoutubeTarget(input: string | undefined): YoutubeTargetResult {
  const url = input?.trim() ? parseUrl(input.trim()) : undefined;
  if (!url) {
    return { ok: false, problem: 'not-a-url' };
  }
  if (!isYoutubeHost(url)) {
    return { ok: false, problem: 'foreign-host' };
  }
  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split('/').filter(Boolean);

  // youtu.be/<videoId>[?t=...]
  if (host === 'youtu.be') {
    const videoId = normalizeVideoId(segments[0]);
    return videoId ? { ok: true, target: { kind: 'video', videoId }, url } : { ok: false, problem: 'invalid-video-id' };
  }

  const [first, second] = segments;

  // /watch?v=<videoId>
  if (first === 'watch') {
    const videoId = normalizeVideoId(url.searchParams.get('v') ?? undefined);
    return videoId ? { ok: true, target: { kind: 'video', videoId }, url } : { ok: false, problem: 'invalid-video-id' };
  }

  // /embed/live_stream?channel=<channelId> — the documented channel embed.
  // Checked BEFORE the generic /embed/<id> rule: `live_stream` is not a video id.
  if (first === 'embed' && second === 'live_stream') {
    const channelId = normalizeChannelId(url.searchParams.get('channel') ?? undefined);
    return channelId
      ? { ok: true, target: { kind: 'channel', channelId }, url }
      : { ok: false, problem: 'invalid-channel-id' };
  }

  // /live/<videoId>, /embed/<videoId>, /v/<videoId>, /shorts/<videoId>
  if (first && ['live', 'embed', 'v', 'shorts'].includes(first)) {
    const videoId = normalizeVideoId(second);
    return videoId ? { ok: true, target: { kind: 'video', videoId }, url } : { ok: false, problem: 'invalid-video-id' };
  }

  // /channel/<UC…> and /channel/<UC…>/live
  if (first === 'channel') {
    const channelId = normalizeChannelId(second);
    if (!channelId) {
      return { ok: false, problem: 'invalid-channel-id' };
    }
    if (segments.length === 2) {
      return { ok: true, target: { kind: 'channel', channelId }, url };
    }
    // Only the documented `/channel/<UC…>/live` form addresses the live stream.
    if (segments.length === 3 && segments[2].toLowerCase() === 'live') {
      return { ok: true, target: { kind: 'channel', channelId }, url };
    }
    return { ok: false, problem: 'not-live-path' };
  }

  // /@handle and /@handle/live, /c/<name>/live, /user/<name>/live
  if (first?.startsWith('@') || first === 'c' || first === 'user') {
    const raw = first.startsWith('@') ? first.slice(1) : second;
    const handle = raw?.trim();
    if (!handle || !YOUTUBE_HANDLE.test(handle)) {
      return { ok: false, problem: 'invalid-handle' };
    }
    return { ok: true, target: { kind: 'handle', handle }, url };
  }

  return { ok: false, problem: 'unsupported-path' };
}

/**
 * Whether a URL is a /live path for a channel we could try to resolve. Used to
 * say "this is a channel live page" without ever assuming it is embeddable.
 */
export function isChannelLivePath(input: string | undefined): boolean {
  const resolved = resolveYoutubeTarget(input);
  if (!resolved.ok) {
    return false;
  }
  if (resolved.target.kind === 'channel') {
    return resolved.url.pathname.toLowerCase().endsWith('/live') || resolved.url.pathname.toLowerCase().includes('/live_stream');
  }
  return resolved.target.kind === 'handle';
}

/** Public watch URL a human can open for a video id (never an embed). */
export function youtubeWatchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
}

/** Public channel live page a human can open. */
export function youtubeChannelWatchUrl(channelId: string): string {
  return `https://www.youtube.com/channel/${encodeURIComponent(channelId)}/live`;
}
