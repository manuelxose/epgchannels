import { describe, expect, it, vi } from 'vitest';
import { YoutubeDataApi, type YoutubeDataApiConfig } from './youtube-data-api';
import { createYoutubeLiveResolver, resetChannelEmbedAttempts, sharedDataApiClients } from './youtube-runtime';

/**
 * Channel → live video resolution, driven entirely by deterministic fixtures.
 * No test here touches the network: `fetchImpl` is injected.
 */
const CHANNEL = 'UCOCGPFW1UqPP9zdol7vEK1A';
const VIDEO = 'OkQduT-9Pyc';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A fake Data API answering with the given pages, recording every URL it saw. */
function fakeApi(handlers: {
  search?: unknown;
  searchStatus?: number;
  videos?: unknown;
  videosStatus?: number;
}) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('/search')) {
      return jsonResponse(handlers.search ?? { items: [] }, handlers.searchStatus ?? 200);
    }
    return jsonResponse(handlers.videos ?? { items: [] }, handlers.videosStatus ?? 200);
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

const liveSearch = { items: [{ id: { kind: 'youtube#video', videoId: VIDEO } }] };
const liveVideos = {
  items: [
    {
      id: VIDEO,
      status: { embeddable: true },
      snippet: { channelId: CHANNEL, title: 'En directo', liveBroadcastContent: 'live' },
    },
  ],
};

function api(config: Partial<YoutubeDataApiConfig> = {}, handlers: Parameters<typeof fakeApi>[0] = {}) {
  const fake = fakeApi(handlers);
  const client = new YoutubeDataApi({
    apiKey: 'test-key',
    fetchImpl: fake.fetchImpl,
    now: () => Date.parse('2026-11-15T12:00:00Z'),
    ...config,
  });
  return { client, calls: fake.calls };
}

describe('YoutubeDataApi.resolveChannelLive', () => {
  it('resolves a live, embeddable broadcast of that very channel', async () => {
    const { client } = api({}, { search: liveSearch, videos: liveVideos });
    await expect(client.resolveChannelLive(CHANNEL)).resolves.toEqual({
      kind: 'live',
      videoId: VIDEO,
      channelId: CHANNEL,
      title: 'En directo',
      embeddable: true,
    });
  });

  it('uses only the documented endpoints and parameters', async () => {
    const { client, calls } = api({}, { search: liveSearch, videos: liveVideos });
    await client.resolveChannelLive(CHANNEL);
    expect(calls).toHaveLength(2);
    const search = new URL(calls[0]);
    expect(search.origin + search.pathname).toBe('https://www.googleapis.com/youtube/v3/search');
    expect(search.searchParams.get('part')).toBe('snippet');
    expect(search.searchParams.get('channelId')).toBe(CHANNEL);
    expect(search.searchParams.get('eventType')).toBe('live');
    expect(search.searchParams.get('type')).toBe('video');
    /*
     * `videoEmbeddable` is deliberately NOT sent: search cannot tell "no live"
     * from "a live that forbids embedding", and that distinction is decided by
     * `videos.list` (`status.embeddable`), which is the next request.
     */
    expect(search.searchParams.get('videoEmbeddable')).toBeNull();
    const videos = new URL(calls[1]);
    expect(videos.pathname).toBe('/youtube/v3/videos');
    expect(videos.searchParams.get('part')).toBe('status,snippet,liveStreamingDetails');
    expect(videos.searchParams.get('id')).toBe(VIDEO);
  });

  it('reports a channel that is not broadcasting as offline', async () => {
    const { client } = api({}, { search: { items: [] } });
    await expect(client.resolveChannelLive(CHANNEL)).resolves.toEqual({ kind: 'offline', channelId: CHANNEL });
  });

  it('reports a live broadcast whose owner forbids embedding', async () => {
    const { client } = api(
      {},
      {
        search: liveSearch,
        videos: {
          items: [
            {
              id: VIDEO,
              status: { embeddable: false },
              snippet: { channelId: CHANNEL, title: 'En directo', liveBroadcastContent: 'live' },
            },
          ],
        },
      },
    );
    await expect(client.resolveChannelLive(CHANNEL)).resolves.toMatchObject({
      kind: 'not-embeddable',
      videoId: VIDEO,
    });
  });

  it('requires the live video to belong to the resolved channel', async () => {
    const { client } = api(
      {},
      {
        search: liveSearch,
        videos: {
          items: [
            {
              id: VIDEO,
              status: { embeddable: true },
              snippet: { channelId: 'UCsomeoneelse000000000', liveBroadcastContent: 'live' },
            },
          ],
        },
      },
    );
    // A video owned by another channel is not "the emission of this channel".
    await expect(client.resolveChannelLive(CHANNEL)).resolves.toEqual({ kind: 'offline', channelId: CHANNEL });
  });

  it('requires the video to still be live, not merely found', async () => {
    const { client } = api(
      {},
      {
        search: liveSearch,
        videos: {
          items: [{ id: VIDEO, status: { embeddable: true }, snippet: { channelId: CHANNEL, liveBroadcastContent: 'upcoming' } }],
        },
      },
    );
    await expect(client.resolveChannelLive(CHANNEL)).resolves.toEqual({ kind: 'offline', channelId: CHANNEL });
  });

  /*
   * "The channel is not live" is a claim about the world. It may only be made
   * when YouTube actually said so; anything we could not read is "unknown", and
   * the UI then offers the channel's page instead of asserting an absence.
   */
  it('reports unknown broadcast state as an error, never as offline', async () => {
    const { client } = api(
      {},
      {
        search: liveSearch,
        videos: { items: [{ id: VIDEO, status: { embeddable: true }, snippet: { channelId: CHANNEL } }] },
      },
    );
    const result = await client.resolveChannelLive(CHANNEL);
    expect(result.kind).toBe('error');
    expect(result.kind === 'error' && result.message).toMatch(/no ha indicado/i);
  });

  it('reports an empty videos.list answer as unknown, not as offline', async () => {
    const { client } = api({}, { search: liveSearch, videos: { items: [] } });
    const result = await client.resolveChannelLive(CHANNEL);
    expect(result.kind).toBe('error');
    expect(result.kind === 'error' && result.message).toMatch(/no ha devuelto/i);
  });

  it('treats an absent embeddable flag as NOT embeddable', async () => {
    const { client } = api(
      {},
      {
        search: liveSearch,
        videos: { items: [{ id: VIDEO, status: {}, snippet: { channelId: CHANNEL, liveBroadcastContent: 'live' } }] },
      },
    );
    await expect(client.resolveChannelLive(CHANNEL)).resolves.toMatchObject({ kind: 'not-embeddable' });
  });

  it('refuses without a key instead of calling anything', async () => {
    const { client, calls } = api({ apiKey: undefined });
    await expect(client.resolveChannelLive(CHANNEL)).resolves.toEqual({ kind: 'no-api', channelId: CHANNEL });
    expect(calls).toEqual([]);
    expect(client.available).toBe(false);
  });

  it('rejects a malformed channel id without a request', async () => {
    const { client, calls } = api({}, { search: liveSearch });
    await expect(client.resolveChannelLive(VIDEO)).resolves.toMatchObject({ kind: 'error', retryable: false });
    expect(calls).toEqual([]);
  });

  it('explains an exhausted quota and does not retry it', async () => {
    const { client } = api(
      {},
      {
        searchStatus: 403,
        search: { error: { errors: [{ reason: 'quotaExceeded' }] } },
      },
    );
    const result = await client.resolveChannelLive(CHANNEL);
    expect(result).toMatchObject({ kind: 'error', retryable: false });
    expect(result.kind === 'error' && result.message).toMatch(/cuota/i);
  });

  it('reports an HTTP 500 as a retryable error', async () => {
    const { client } = api({}, { searchStatus: 500, search: {} });
    await expect(client.resolveChannelLive(CHANNEL)).resolves.toMatchObject({ kind: 'error', retryable: true });
  });
});

describe('YoutubeDataApi caching and quota', () => {
  it('caches a positive resolution for its TTL', async () => {
    let now = Date.parse('2026-11-15T12:00:00Z');
    const fake = fakeApi({ search: liveSearch, videos: liveVideos });
    const client = new YoutubeDataApi({
      apiKey: 'k',
      fetchImpl: fake.fetchImpl,
      now: () => now,
      liveTtlMs: 60_000,
    });
    await client.resolveChannelLive(CHANNEL);
    now += 30_000;
    await client.resolveChannelLive(CHANNEL);
    expect(fake.calls).toHaveLength(2); // one search + one videos, not four
    now += 60_000;
    await client.resolveChannelLive(CHANNEL);
    expect(fake.calls).toHaveLength(4); // expired: resolved again
  });

  it('caches "not live" so a quiet channel does not burn quota', async () => {
    const fake = fakeApi({ search: { items: [] } });
    const client = new YoutubeDataApi({ apiKey: 'k', fetchImpl: fake.fetchImpl, now: () => 0 });
    await client.resolveChannelLive(CHANNEL);
    await client.resolveChannelLive(CHANNEL);
    await client.resolveChannelLive(CHANNEL);
    expect(fake.calls).toHaveLength(1);
  });

  it('de-duplicates concurrent resolutions of the same channel', async () => {
    const fake = fakeApi({ search: liveSearch, videos: liveVideos });
    const client = new YoutubeDataApi({ apiKey: 'k', fetchImpl: fake.fetchImpl, now: () => 0 });
    const [a, b, c] = await Promise.all([
      client.resolveChannelLive(CHANNEL),
      client.resolveChannelLive(CHANNEL),
      client.resolveChannelLive(CHANNEL),
    ]);
    expect([a.kind, b.kind, c.kind]).toEqual(['live', 'live', 'live']);
    expect(fake.calls).toHaveLength(2);
  });

  it('stops at the documented search budget instead of calling forever', async () => {
    // A fake that answers consistently per channel: the search returns a video
    // id derived from the channel, and `videos.list` echoes that channel back,
    // exactly like the Data API does.
    const calls: string[] = [];
    const ownerByVideo = new Map<string, string>();
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/search')) {
        const channelId = parsed.searchParams.get('channelId') ?? '';
        const videoId = channelId.slice(2, 13);
        ownerByVideo.set(videoId, channelId);
        return jsonResponse({ items: [{ id: { videoId } }] });
      }
      const ids = (parsed.searchParams.get('id') ?? '').split(',');
      return jsonResponse({
        items: ids.map((id) => ({
          id,
          status: { embeddable: true },
          snippet: { channelId: ownerByVideo.get(id), liveBroadcastContent: 'live' },
        })),
      });
    }) as unknown as typeof fetch;
    const client = new YoutubeDataApi({
      apiKey: 'k',
      fetchImpl,
      now: () => 0,
      searchPerDay: 2,
      liveTtlMs: 1,
    });
    const channels = ['UCOCGPFW1UqPP9zdol7vEK1A', 'UC7QZIf0dta-XPXsp9Hv4dTw', 'UCyoGb3SMlTlB8CLGVH4c8Rw'];
    const results = [];
    for (const channel of channels) {
      results.push((await client.resolveChannelLive(channel)).kind);
    }
    // Two resolutions fit the documented bucket; the third is refused by us,
    // not by YouTube, and never reaches the network.
    expect(results).toEqual(['live', 'live', 'error']);
    expect(calls.filter((url) => url.includes('/search'))).toHaveLength(2);
    expect(client.quota()).toMatchObject({ searchUsed: 2 });
  });

  it('stops asking after the server reports the quota exhausted', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return jsonResponse({ error: { errors: [{ reason: 'quotaExceeded' }] } }, 403);
    }) as unknown as typeof fetch;
    const client = new YoutubeDataApi({ apiKey: 'k', fetchImpl, now: () => 0 });
    await client.resolveChannelLive(CHANNEL);
    const afterFirst = calls.length;
    // A different channel must not spend another call on a quota we know is gone.
    const second = await client.resolveChannelLive('UC7QZIf0dta-XPXsp9Hv4dTw');
    expect(second.kind).toBe('error');
    expect(calls.length).toBe(afterFirst);
  });

  it('resets the ledger at midnight Pacific, not UTC', async () => {
    // 07:30 UTC on 2026-11-16 is still 23:30 on 2026-11-15 in Los Angeles.
    let now = Date.parse('2026-11-16T07:30:00Z');
    const fake = fakeApi({ search: liveSearch, videos: liveVideos });
    const client = new YoutubeDataApi({ apiKey: 'k', fetchImpl: fake.fetchImpl, now: () => now, searchPerDay: 1 });
    await client.resolveChannelLive(CHANNEL);
    expect((await client.resolveChannelLive('UC7QZIf0dta-XPXsp9Hv4dTw')).kind).toBe('error');
    // 08:30 UTC is 00:30 in Los Angeles: a new quota day.
    now = Date.parse('2026-11-16T08:30:00Z');
    expect(client.quota()).toMatchObject({ searchUsed: 0 });
  });

  it('can be invalidated explicitly', async () => {
    const fake = fakeApi({ search: liveSearch, videos: liveVideos });
    const client = new YoutubeDataApi({ apiKey: 'k', fetchImpl: fake.fetchImpl, now: () => 0 });
    await client.resolveChannelLive(CHANNEL);
    client.invalidate(CHANNEL);
    await client.resolveChannelLive(CHANNEL);
    expect(fake.calls).toHaveLength(4);
  });

  it('replaces an expired entry instead of retaining it for the page lifetime', async () => {
    let now = 0;
    const fake = fakeApi({ search: liveSearch, videos: liveVideos });
    const client = new YoutubeDataApi({
      apiKey: 'k',
      fetchImpl: fake.fetchImpl,
      now: () => now,
      liveTtlMs: 10,
    });
    await client.resolveChannelLive(CHANNEL);
    now = 1_000; // the entry has expired
    await client.resolveChannelLive(CHANNEL);
    const internal = client as unknown as { cache: Map<string, unknown> };
    expect(internal.cache.size).toBe(1);
  });
});

describe('createYoutubeLiveResolver', () => {
  /** The adapter takes the runtime key and builds/reuses a client per key. */
  const resolverFor = (client: YoutubeDataApi) => createYoutubeLiveResolver({ apiFor: () => client });
  const KEY = 'test-key';

  it('passes a video page straight through as a video id', async () => {
    const resolve = resolverFor(api().client);
    await expect(resolve('https://www.youtube.com/live/OkQduT-9Pyc', KEY)).resolves.toEqual({
      kind: 'video',
      videoId: VIDEO,
    });
  });

  it('resolves a channel page through the Data API', async () => {
    const { client } = api({}, { search: liveSearch, videos: liveVideos });
    const resolve = resolverFor(client);
    await expect(resolve(`https://www.youtube.com/channel/${CHANNEL}/live`, KEY)).resolves.toEqual({
      kind: 'video',
      videoId: VIDEO,
    });
  });

  it('reports offline for a channel with no live stream', async () => {
    const { client } = api({}, { search: { items: [] } });
    const resolve = resolverFor(client);
    await expect(resolve(`https://www.youtube.com/channel/${CHANNEL}/live`, KEY)).resolves.toEqual({ kind: 'offline' });
  });

  /*
   * The browser path resolved the channel but the page still ended in a generic
   * "external" state, so this pins what the production adapter really returns:
   * an offline channel must be reported as offline, not as "cannot check".
   */
  it('returns offline end-to-end through the production adapter shape', async () => {
    const { client, calls } = api({}, { search: { items: [] } });
    const resolve = createYoutubeLiveResolver({ apiFor: () => client });
    const result = await resolve(`https://www.youtube.com/channel/${CHANNEL}/live`, KEY);
    expect(result).toEqual({ kind: 'offline' });
    expect(calls.filter((url) => url.includes('/search'))).toHaveLength(1);
    expect(calls.filter((url) => url.includes('/videos'))).toHaveLength(0);
  });

  it('reports the creator restriction for a non-embeddable live', async () => {
    const { client } = api(
      {},
      {
        search: liveSearch,
        videos: { items: [{ id: VIDEO, status: { embeddable: false }, snippet: { channelId: CHANNEL, liveBroadcastContent: 'live' } }] },
      },
    );
    const resolve = resolverFor(client);
    await expect(resolve(`https://www.youtube.com/channel/${CHANNEL}/live`, KEY)).resolves.toEqual({
      kind: 'not-embeddable',
    });
  });

  it('explains a handle instead of pretending to resolve it', async () => {
    const resolve = resolverFor(api().client);
    const result = await resolve('https://www.youtube.com/@emisora/live', KEY);
    expect(result.kind).toBe('unplayable');
    expect(result.kind === 'unplayable' && result.message).toMatch(/nombre/i);
  });

  /*
   * Without a key the app does NOT give up: YouTube's documented channel embed is
   * public and needs no key. This is the case reported for La Séptima, which
   * indeed broadcasts there while the app claimed "ninguna fuente disponible".
   */
  it('falls back to the documented channel embed without a key, never to "offline"', async () => {
    resetChannelEmbedAttempts();
    const calls = vi.fn();
    const client = new YoutubeDataApi({ fetchImpl: calls as unknown as typeof fetch });
    const resolve = resolverFor(client);
    await expect(resolve(`https://www.youtube.com/channel/${CHANNEL}/live`, '')).resolves.toEqual({
      kind: 'channel-embed',
      channelId: CHANNEL,
    });
    // No Data API call was made, and it is certainly not reported as offline.
    expect(calls).not.toHaveBeenCalled();
  });

  /*
   * Two attempts, not one: a single try was observed as an intermittent "no ha
   * podido reproducirse aquí" for a channel that does work, so the embed gets one
   * more real attempt before the reason is shown for good.
   */
  it('offers the channel embed twice, then explains and links to the live page', async () => {
    resetChannelEmbedAttempts();
    const resolve = resolverFor(new YoutubeDataApi({}));
    const first = await resolve(`https://www.youtube.com/channel/${CHANNEL}/live`, '');
    const second = await resolve(`https://www.youtube.com/channel/${CHANNEL}/live`, '');
    const third = await resolve(`https://www.youtube.com/channel/${CHANNEL}/live`, '');
    expect(first.kind).toBe('channel-embed');
    expect(second.kind).toBe('channel-embed');
    expect(third.kind).toBe('unplayable');
    expect(third.kind === 'unplayable' && third.url).toBe(`https://www.youtube.com/channel/${CHANNEL}/live`);
    expect(third.kind === 'unplayable' && third.message).not.toMatch(/no está emitiendo/i);
  });

  it('a blank deployment key means no check, so offline is never claimed', async () => {
    // This is the real default in a build without the key: the resolver must not
    // reach the network and must not answer "the channel is not live".
    const calls = vi.fn();
    const client = new YoutubeDataApi({ fetchImpl: calls as unknown as typeof fetch });
    const resolve = resolverFor(client);
    const result = await resolve(`https://www.youtube.com/channel/${CHANNEL}/live`, '');
    expect(result.kind).not.toBe('offline');
    expect(calls).not.toHaveBeenCalled();
  });

  it('shares one client per key so the quota ledger is global', () => {
    const shared = sharedDataApiClients();
    expect(shared.apiFor('a')).toBe(shared.apiFor('a'));
    expect(shared.apiFor('a')).not.toBe(shared.apiFor('b'));
  });
});
