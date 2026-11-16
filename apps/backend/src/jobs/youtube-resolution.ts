/**
 * Scheduled resolution of YouTube channels.
 *
 * The job is what makes the feature scale: it reads channels from YouTube at a
 * controlled rate and stores the result in our database, so the API never calls
 * YouTube and the cost grows with the catalogue rather than with traffic.
 *
 * Design choices:
 * - One run touches at most `limit` channels, oldest check first. With hundreds
 *   of channels and a run every few minutes this keeps the request rate bounded
 *   and predictable, with no spike when the deployment scales up.
 * - A channel that keeps failing backs off, so a broken or removed channel
 *   cannot monopolise the budget.
 * - The job never fails the whole run on one channel: each outcome is recorded
 *   and the run reports what it did.
 */
import type { DatabaseHandle } from '../infrastructure/mongo.js';
import { COLLECTIONS } from '../infrastructure/mongo.js';
import type { PlaybackSourceDoc, YoutubeChannelDoc } from '../infrastructure/schema.js';
import { YoutubeChannelCache, channelIdFromUrl, type ResolutionPolicy } from '../modules/playback/youtube-channel-cache.js';
import type { ChannelResolverOptions } from '../modules/playback/youtube-channel-resolver.js';

export interface ResolutionRunResult {
  readonly attempted: number;
  readonly live: number;
  readonly offline: number;
  readonly unavailable: number;
  readonly durationMs: number;
}

/** Every YouTube channel id our published catalogue points at. */
export async function publishedYoutubeChannelIds(database: DatabaseHandle): Promise<string[]> {
  const sources = await database
    .collection<PlaybackSourceDoc>(COLLECTIONS.sources)
    .find({ type: 'youtube', editorialStatus: 'published' })
    .project({ url: 1 })
    .toArray();
  const ids = new Set<string>();
  for (const source of sources) {
    const channelId = channelIdFromUrl(source.url);
    if (channelId) ids.add(channelId);
  }
  return [...ids];
}

/**
 * Registers every catalogue channel in the cache so the queue knows about it.
 * Rows created here are immediately due: the first run resolves them.
 */
export async function seedResolutionQueue(database: DatabaseHandle, now: Date = new Date()): Promise<number> {
  const ids = await publishedYoutubeChannelIds(database);
  if (ids.length === 0) return 0;
  const collection = database.collection<YoutubeChannelDoc>(COLLECTIONS.youtubeChannels);
  await collection.bulkWrite(
    ids.map((channelId) => ({
      updateOne: {
        filter: { _id: channelId },
        update: {
          $setOnInsert: {
            videoId: null,
            state: 'unavailable' as const,
            resolvedAt: null,
            nextCheckAt: now,
            failures: 0,
            lastError: null,
            createdAt: now,
            updatedAt: now,
          },
        },
        upsert: true,
      },
    })),
    { ordered: false },
  );
  return ids.length;
}

export interface ResolutionJobOptions {
  readonly limit?: number;
  readonly policy?: ResolutionPolicy;
  readonly resolver?: ChannelResolverOptions;
}

export async function runResolutionJob(
  database: DatabaseHandle,
  options: ResolutionJobOptions = {},
): Promise<ResolutionRunResult> {
  const startedAt = Date.now();
  // Seed first: a channel added to the catalogue today must not wait for an
  // operator to remember it.
  await seedResolutionQueue(database);

  const cache = new YoutubeChannelCache(database, options.policy, options.resolver);
  const due = await cache.due(options.limit ?? 50);

  let live = 0;
  let offline = 0;
  let unavailable = 0;
  for (const channelId of due) {
    const outcome = await cache.resolve(channelId);
    if (outcome.state === 'live') live += 1;
    else if (outcome.state === 'offline') offline += 1;
    else unavailable += 1;
  }

  return {
    attempted: due.length,
    live,
    offline,
    unavailable,
    durationMs: Date.now() - startedAt,
  };
}
