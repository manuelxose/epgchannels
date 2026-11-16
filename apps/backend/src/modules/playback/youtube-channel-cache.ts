/**
 * Persistent resolution cache for YouTube channels.
 *
 * The point of this module is cost decoupling: a channel is read from YouTube
 * once and then answered from MongoDB for every visitor. The number of external
 * requests therefore grows with the SIZE OF THE CATALOGUE, never with traffic —
 * which is what lets the platform serve thousands of users.
 *
 * Policy:
 * - a live channel is re-checked every `liveTtlMs` (its video id is stable while
 *   the broadcast lasts);
 * - an offline channel every `offlineTtlMs` (it may start at any time);
 * - a failed read backs off exponentially, so a broken channel cannot consume
 *   the budget on every run.
 *
 * Nothing here runs on a request path: the API reads the stored row, and the
 * scheduled job fills it.
 */
import { COLLECTIONS } from '../../infrastructure/mongo.js';
import type { DatabaseHandle } from '../../infrastructure/mongo.js';
import type { YoutubeChannelDoc } from '../../infrastructure/schema.js';
import { resolveChannelLiveVideo, type ChannelResolverOptions } from './youtube-channel-resolver.js';

export interface ResolutionPolicy {
  /** How long a live video id is trusted. */
  readonly liveTtlMs: number;
  /** How long "not live" is trusted before looking again. */
  readonly offlineTtlMs: number;
  /** How long a failed read is trusted before retrying (grows with `failures`). */
  readonly failureTtlMs: number;
  /** Upper bound for the exponential back-off. */
  readonly maxFailureTtlMs: number;
}

export const DEFAULT_RESOLUTION_POLICY: ResolutionPolicy = {
  // 20 minutes: long enough that a popular channel is read a handful of times a
  // day, short enough that a new broadcast is picked up quickly.
  liveTtlMs: 20 * 60 * 1000,
  // 10 minutes: an offline channel may go live at any moment.
  offlineTtlMs: 10 * 60 * 1000,
  failureTtlMs: 5 * 60 * 1000,
  maxFailureTtlMs: 6 * 60 * 60 * 1000,
};

/** A channel id extracted from a YouTube URL, or null when the URL is not one. */
export function channelIdFromUrl(raw: string | null): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (!/(^|\.)youtube(-nocookie)?\.com$/.test(host)) return null;
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments[0] === 'channel' && segments[1] && /^UC[\w-]{20,}$/.test(segments[1])) {
    return segments[1];
  }
  const embedded = url.searchParams.get('channel');
  if (segments[0] === 'embed' && segments[1] === 'live_stream' && embedded && /^UC[\w-]{20,}$/.test(embedded)) {
    return embedded;
  }
  return null;
}

export interface ResolutionOutcome {
  readonly channelId: string;
  readonly state: YoutubeChannelDoc['state'];
  readonly videoId: string | null;
  /** True when the row was served from cache instead of reading YouTube. */
  readonly cached: boolean;
}

export class YoutubeChannelCache {
  constructor(
    private readonly database: DatabaseHandle,
    private readonly policy: ResolutionPolicy = DEFAULT_RESOLUTION_POLICY,
    private readonly resolverOptions: ChannelResolverOptions = {},
  ) {}

  private get collection() {
    return this.database.collection<YoutubeChannelDoc>(COLLECTIONS.youtubeChannels);
  }

  /** Stored rows for these channels, without contacting YouTube. */
  async readMany(channelIds: readonly string[]): Promise<Map<string, YoutubeChannelDoc>> {
    if (channelIds.length === 0) return new Map();
    const unique = [...new Set(channelIds)];
    const rows = await this.collection.find({ _id: { $in: unique } }).toArray();
    return new Map(rows.map((row) => [row._id, row]));
  }

  /** One stored row, without contacting YouTube. */
  async read(channelId: string): Promise<YoutubeChannelDoc | null> {
    return this.collection.findOne({ _id: channelId });
  }

  /**
   * Resolves a channel, using the stored row when it is still fresh.
   *
   * `force` bypasses the TTL (an operator asking explicitly), never the back-off
   * on repeated failures.
   */
  async resolve(channelId: string, options: { force?: boolean } = {}): Promise<ResolutionOutcome> {
    const now = Date.now();
    const stored = await this.read(channelId);
    const fresh = stored ? stored.nextCheckAt.getTime() > now : false;
    if (stored && fresh && !options.force) {
      return { channelId, state: stored.state, videoId: stored.videoId, cached: true };
    }

    const result = await resolveChannelLiveVideo(channelId, this.resolverOptions);
    const failures = result.kind === 'unavailable' ? (stored?.failures ?? 0) + 1 : 0;
    const nextCheckAt = new Date(now + this.ttlFor(result.kind, failures));

    const row: YoutubeChannelDoc = {
      _id: channelId,
      videoId: result.kind === 'live' ? result.videoId : null,
      state: result.kind,
      resolvedAt: result.kind === 'unavailable' ? (stored?.resolvedAt ?? null) : new Date(now),
      nextCheckAt,
      failures,
      lastError: result.kind === 'unavailable' ? result.reason : null,
      createdAt: stored?.createdAt ?? new Date(now),
      updatedAt: new Date(now),
    };
    await this.collection.updateOne({ _id: channelId }, { $set: row }, { upsert: true });
    return { channelId, state: row.state, videoId: row.videoId, cached: false };
  }

  private ttlFor(kind: 'live' | 'offline' | 'unavailable', failures: number): number {
    if (kind === 'live') return this.policy.liveTtlMs;
    if (kind === 'offline') return this.policy.offlineTtlMs;
    const exponent = Math.max(0, failures - 1);
    return Math.min(this.policy.maxFailureTtlMs, this.policy.failureTtlMs * 2 ** exponent);
  }

  /**
   * The channels whose next check is due, oldest first.
   *
   * `limit` is the budget for one run: with hundreds of channels and a run every
   * few minutes, this is what keeps the request rate to YouTube bounded and
   * predictable.
   */
  async due(limit: number, now: Date = new Date()): Promise<string[]> {
    const rows = await this.collection
      .find({ nextCheckAt: { $lte: now } })
      .sort({ nextCheckAt: 1 })
      .limit(Math.max(1, limit))
      .project({ _id: 1 })
      .toArray();
    return rows.map((row) => row._id);
  }

  /** Number of rows by state, for the operations view. */
  async stats(): Promise<Record<string, number>> {
    const rows = await this.collection
      .aggregate<{ _id: string; count: number }>([{ $group: { _id: '$state', count: { $sum: 1 } } }])
      .toArray();
    return Object.fromEntries(rows.map((row) => [row._id, row.count]));
  }
}
