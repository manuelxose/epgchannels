/**
 * Runtime wiring for the channel → live-video resolver (TDT-CLONE-12 §3/§5).
 *
 * Two rules drive this file:
 *
 * 1. **Browser only.** Nothing is created during SSR or where there is no
 *    `fetch`: the resolver answers "not available" and the UI honestly offers
 *    the channel's official YouTube page instead of pretending to know whether
 *    it is live.
 * 2. **Opt-in key, never invented.** The key comes from the host application
 *    (`window.TDT_YOUTUBE_API_KEY`, injected at deploy time). Without a key the
 *    resolver answers "not available"; it never claims a channel is offline.
 *
 * It is a *restricted* API key (YouTube Data API v3 only, restricted to this
 * origin): that is what makes it safe to ship to a browser.
 */
import { YoutubeDataApi } from './youtube-data-api';
import { resolveYoutubeTarget, youtubeChannelWatchUrl } from './youtube-target';
import type { YoutubeLiveResolver } from '../state/player.controller';

/**
 * Channels already sent to YouTube's own channel embed during this session.
 *
 * The documented channel embed (`/embed/live_stream?channel=…`) needs no API key:
 * it is the same public player page the publisher's own site uses, and YouTube
 * decides there whether the channel is live and whether it allows embedding.
 * Its only limitation is that OUR app cannot observe its state, so it is the
 * fallback.
 *
 * The count is bounded on purpose, but it counts mounts PER USER INTENT, not per
 * page session. Opening the channel, leaving and coming back are separate intents
 * — the user expects their player — so a return forgives one spent attempt
 * (`forgiveChannelEmbedAttempt`). Without that, a route return re-consumed the
 * budget and turned a working channel into a permanent error.
 */
const CHANNEL_EMBED_ATTEMPTS = 2;

function channelEmbedAttempts(): Map<string, number> {
  const holder = globalThis as { TDT_YOUTUBE_CHANNEL_EMBEDS?: Map<string, number> };
  holder.TDT_YOUTUBE_CHANNEL_EMBEDS ??= new Map<string, number>();
  return holder.TDT_YOUTUBE_CHANNEL_EMBEDS;
}

/** Records one mount and answers whether it is allowed. */
export function claimChannelEmbedAttempt(channelId: string): boolean {
  const attempts = channelEmbedAttempts();
  const used = attempts.get(channelId) ?? 0;
  if (used >= CHANNEL_EMBED_ATTEMPTS) {
    return false;
  }
  attempts.set(channelId, used + 1);
  return true;
}

/**
 * The user came back to a channel: the next mount is a fresh intent, so an attempt
 * already spent by an earlier visit must not become a permanent error.
 */
export function forgiveChannelEmbedAttempt(channelId: string): string | undefined {
  const attempts = channelEmbedAttempts();
  const used = attempts.get(channelId) ?? 0;
  if (used > 0) {
    attempts.set(channelId, used - 1);
  }
  return channelId;
}

/** Forgets the attempts (explicit retry, or a test). */
export function resetChannelEmbedAttempts(): void {
  channelEmbedAttempts().clear();
}

/**
 * The video currently live on a channel, read from the channel's own public page.
 *
 * MEASURED (`scripts/playback/resolve-channel-video.mjs`): the channel's live page
 * announces the live video in its canonical URL:
 *
 *   https://www.youtube.com/channel/<UC…>/live
 *     -> <link rel="canonical" href="https://www.youtube.com/watch?v=ErraEILevPE">
 *
 * This is the same page the publisher embeds on its own site; it needs no API
 * key. We take ONLY the video id from it — no manifests, no stream URLs — and
 * hand it to the official player, which is what makes playback observable.
 * Returns `undefined` when the page does not announce a live video.
 */
export async function resolveChannelLiveFromPage(
  channelId: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<string | undefined> {
  try {
    const response = await fetchImpl(`https://www.youtube.com/channel/${encodeURIComponent(channelId)}/live`, {
      // The public page is readable without an API key; sending the URL straight
      // to the browser would be blocked by CORS, so it is fetched here.
      redirect: 'follow',
      credentials: 'omit',
    });
    if (!response.ok) {
      return undefined;
    }
    const body = await response.text();
    const canonical = /<link rel="canonical" href="([^"]+)"/.exec(body)?.[1];
    if (!canonical) {
      return undefined;
    }
    const resolved = resolveYoutubeTarget(canonical);
    return resolved.ok && resolved.target.kind === 'video' ? resolved.target.videoId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Builds the production resolver over the Data API client.
 *
 * The client is created once per distinct key and shared, so its cache and its
 * quota ledger are shared too: visiting twenty channels does not make twenty
 * clients each with their own daily budget.
 */
export function createYoutubeLiveResolver(shared: { apiFor: (key: string) => YoutubeDataApi }): YoutubeLiveResolver {
  return async (sourceUrl: string, key: string) => {
    const target = resolveYoutubeTarget(sourceUrl);
    if (!target.ok) {
      return { kind: 'unplayable' as const, message: '', cause: 'unavailable' as const };
    }
    if (target.target.kind === 'handle') {
      // A handle names a channel but carries no id we could verify; resolving it
      // would need a name→id lookup the documented API does not do by handle.
      return {
        kind: 'unplayable' as const,
        message: 'Esta página de YouTube identifica el canal por su nombre, no por un vídeo concreto.',
        url: sourceUrl,
        cause: 'unavailable' as const,
      };
    }
    if (target.target.kind === 'video') {
      return { kind: 'video' as const, videoId: target.target.videoId };
    }
    const channelId = target.target.channelId;
    const livePage = youtubeChannelWatchUrl(channelId);
    const resolution = await shared.apiFor(key).resolveChannelLive(channelId);
    switch (resolution.kind) {
      case 'live':
        return { kind: 'video' as const, videoId: resolution.videoId };
      case 'offline':
        return { kind: 'offline' as const };
      case 'not-embeddable':
        return { kind: 'not-embeddable' as const };
      case 'no-api':
        /*
         * Without a key we cannot read the current live VIDEO id with the Data
         * API. YouTube's own channel embed is the public, documented answer and
         * needs no key.
         *
         * Known limitation, measured: the embed starts playing on its own only in
         * a genuine browsing session (`scripts/playback/probe-autoplay*.mjs`).
         * Its playback state is not observable from our page, so the app never
         * claims `playing` for it — the UI says who provides the state. With a
         * (restricted) Data API key the channel resolves to a concrete video and
         * playback becomes fully observable.
         *
         * Reading the id from the channel page was evaluated and rejected: the
         * browser cannot fetch youtube.com cross-origin (no CORS headers), and a
         * server-side scraper is not part of this app.
         */
        if (claimChannelEmbedAttempt(channelId)) {
          return { kind: 'channel-embed' as const, channelId };
        }
        return {
          kind: 'unplayable' as const,
          message:
            'No se ha podido reproducir aquí el reproductor de YouTube de este canal. Puedes verlo en su página oficial.',
          url: livePage,
          cause: 'unavailable' as const,
        };
      default:
        return {
          kind: 'unplayable' as const,
          message: resolution.message,
          url: livePage,
          cause: 'unavailable' as const,
        };
    }
  };
}

/**
 * One shared Data API client per key, so the quota ledger is global.
 *
 * The wiring lives in `app.config.ts` (which builds the resolver over this); an
 * extra exported default resolver would create a SECOND client and a second,
 * independent ledger for the same key, defeating the quota bound.
 */
export function sharedDataApiClients(): { apiFor: (key: string) => YoutubeDataApi } {
  const clients = new Map<string, YoutubeDataApi>();
  return {
    apiFor(key: string): YoutubeDataApi {
      let client = clients.get(key);
      if (!client) {
        client = new YoutubeDataApi({ apiKey: key });
        clients.set(key, client);
      }
      return client;
    },
  };
}