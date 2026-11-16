/**
 * The resolved YouTube video must reach the API descriptor, and the cache must
 * behave like a cache (no external read while fresh, back-off on failure).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseHandle } from '../../infrastructure/mongo.js';
import { COLLECTIONS } from '../../infrastructure/mongo.js';
import { createHarness, type TestHarness } from '../../test/harness.js';
import { YoutubeChannelCache, channelIdFromUrl } from './youtube-channel-cache.js';
import { buildDescriptor } from './playback.service.js';
import type { ChannelDoc, PlaybackSourceDoc } from '../../infrastructure/schema.js';
import { runResolutionJob } from '../../jobs/youtube-resolution.js';

const CHANNEL_ID = 'UCBi2mrWuNuyYy4gbM6fU18Q';

function youtubeSource(channelId: string, url: string): PlaybackSourceDoc {
  const now = new Date();
  return {
    _id: 'src-youtube-1',
    channelId,
    provider: 'platform:youtube.com',
    type: 'youtube',
    url,
    officialPageUrl: null,
    permission: 'emitter-public-stream',
    authorisationEvidence: null,
    conditions: {
      embedAllowed: true,
      proxyAllowed: false,
      worldwide: true,
      browserCompatibility: 'all',
      restrictedRegions: [],
      requiresForgedHeader: false,
      emitterAppOnly: false,
      notes: null,
    },
    priority: 1,
    editorialStatus: 'published',
    technicalStatus: 'ok',
    lastVerifiedAt: now,
    lastVerification: null,
    provenance: [],
    createdAt: now,
    updatedAt: now,
    revision: 1,
  } as PlaybackSourceDoc;
}

function channelDoc(): ChannelDoc {
  const now = new Date();
  return {
    _id: 'chan-1',
    slug: 'abc-news-usa',
    name: 'ABC News USA',
    editorialsStatus: 'published',
    editorialStatus: 'published',
    kind: 'linear',
    category: 'informativos',
    country: 'INT',
    region: null,
    languageTag: 'en',
    searchText: 'abc news usa',
    createdAt: now,
    updatedAt: now,
  } as unknown as ChannelDoc;
}

describe('channelIdFromUrl', () => {
  it('reads the channel id out of every channel-page shape', () => {
    expect(channelIdFromUrl(`https://www.youtube.com/channel/${CHANNEL_ID}/live`)).toBe(CHANNEL_ID);
    expect(channelIdFromUrl(`https://www.youtube.com/channel/${CHANNEL_ID}`)).toBe(CHANNEL_ID);
    expect(channelIdFromUrl(`https://www.youtube.com/embed/live_stream?channel=${CHANNEL_ID}`)).toBe(CHANNEL_ID);
  });

  it('ignores video URLs and foreign hosts', () => {
    expect(channelIdFromUrl('https://www.youtube.com/watch?v=q5NLEgG7kmY')).toBeNull();
    expect(channelIdFromUrl('https://example.org/channel/UCBi2mrWuNuyYy4gbM6fU18Q')).toBeNull();
    expect(channelIdFromUrl(null)).toBeNull();
  });
});

describe('descriptor with a resolved video', () => {
  it('hands the client the video instead of the channel page', () => {
    const descriptor = buildDescriptor(
      channelDoc(),
      [youtubeSource('chan-1', `https://www.youtube.com/channel/${CHANNEL_ID}/live`)],
      new Date(),
      new Map([[CHANNEL_ID, 'q5NLEgG7kmY']]),
    );
    const option = descriptor.playback.options[0];
    expect(option?.url).toBe('https://www.youtube.com/watch?v=q5NLEgG7kmY');
    expect(option?.engine).toBe('youtube-iframe');
  });

  it('keeps the channel page when nothing has been resolved yet', () => {
    const descriptor = buildDescriptor(
      channelDoc(),
      [youtubeSource('chan-1', `https://www.youtube.com/channel/${CHANNEL_ID}/live`)],
    );
    expect(descriptor.playback.options[0]?.url).toBe(`https://www.youtube.com/channel/${CHANNEL_ID}/live`);
  });

  it('leaves a video source untouched even when a channel resolves', () => {
    const descriptor = buildDescriptor(
      channelDoc(),
      [youtubeSource('chan-1', 'https://www.youtube.com/watch?v=ErraEILevPE')],
      new Date(),
      new Map([[CHANNEL_ID, 'q5NLEgG7kmY']]),
    );
    expect(descriptor.playback.options[0]?.url).toBe('https://www.youtube.com/watch?v=ErraEILevPE');
  });
});

describe('YoutubeChannelCache', () => {
  let harness: TestHarness;
  let database: DatabaseHandle;

  beforeAll(async () => {
    harness = await createHarness();
    database = harness.context.database;
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await database.collection(COLLECTIONS.youtubeChannels).deleteMany({});
  });

  it('reads YouTube once and then answers from the cache', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response('<link rel="canonical" href="https://www.youtube.com/watch?v=q5NLEgG7kmY">', {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const cache = new YoutubeChannelCache(database, undefined, { fetchImpl });

    const first = await cache.resolve(CHANNEL_ID);
    const second = await cache.resolve(CHANNEL_ID);

    expect(first).toMatchObject({ state: 'live', videoId: 'q5NLEgG7kmY', cached: false });
    expect(second).toMatchObject({ state: 'live', videoId: 'q5NLEgG7kmY', cached: true });
    expect(calls).toBe(1);
  });

  it('records a definite offline answer as offline, not as an error', async () => {
    const fetchImpl = (async () =>
      new Response(`<link rel="canonical" href="https://www.youtube.com/channel/${CHANNEL_ID}">`, {
        status: 200,
      })) as unknown as typeof fetch;
    const cache = new YoutubeChannelCache(database, undefined, { fetchImpl });
    await expect(cache.resolve(CHANNEL_ID)).resolves.toMatchObject({ state: 'offline', videoId: null });
  });

  it('backs off after failures so a broken channel cannot hog the budget', async () => {
    const failing = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch;
    const cache = new YoutubeChannelCache(database, undefined, { fetchImpl: failing });
    const first = await cache.resolve(CHANNEL_ID);
    expect(first.state).toBe('unavailable');
    const row = await cache.read(CHANNEL_ID);
    expect(row?.failures).toBe(1);
    // The next check moves further away than the plain failure TTL would.
    expect(row?.nextCheckAt.getTime()).toBeGreaterThan(Date.now() + 4 * 60 * 1000);
  });

  it('queues only what is due, oldest first', async () => {
    const fetchImpl = (async () =>
      new Response('<link rel="canonical" href="https://www.youtube.com/watch?v=q5NLEgG7kmY">', {
        status: 200,
      })) as unknown as typeof fetch;
    const cache = new YoutubeChannelCache(database, undefined, { fetchImpl });
    await cache.resolve(CHANNEL_ID);
    expect(await cache.due(10)).toEqual([]);
    // Forcing the check time makes it due again.
    await database
      .collection(COLLECTIONS.youtubeChannels)
      .updateOne({ _id: CHANNEL_ID }, { $set: { nextCheckAt: new Date(Date.now() - 1000) } });
    expect(await cache.due(10)).toEqual([CHANNEL_ID]);
  });

  it('a job run resolves the queue and reports what it found', async () => {
    const now = new Date();
    await database.collection(COLLECTIONS.channels).insertOne({
      _id: 'job-channel',
      slug: 'job-channel',
      name: 'Job Channel',
      editorialStatus: 'published',
      createdAt: now,
      updatedAt: now,
    } as never);
    await database
      .collection(COLLECTIONS.sources)
      .insertOne(youtubeSource('job-channel', `https://www.youtube.com/channel/${CHANNEL_ID}/live`));

    const result = await runResolutionJob(database, {
      limit: 5,
      resolver: {
        fetchImpl: (async () =>
          new Response('<link rel="canonical" href="https://www.youtube.com/watch?v=q5NLEgG7kmY">', {
            status: 200,
          })) as unknown as typeof fetch,
      },
    });
    expect(result.attempted).toBeGreaterThan(0);
    expect(result.unavailable).toBe(0);
    expect(result.live).toBeGreaterThan(0);
  });
});
