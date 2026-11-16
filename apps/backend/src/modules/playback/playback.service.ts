/**
 * Playback service: assembles the descriptor the client plays.
 *
 * The service is the only place that decides which source wins. Its rules are
 * the publication policy (authorisation first) plus health, expressed once:
 *
 * 1. In-app sources (HLS, DASH, YouTube, official embed) that are public and
 *    healthy, ordered by priority; the best one becomes the descriptor.
 * 2. Otherwise, a public `external` source: status `external`, the emitter's own
 *    page as `externalUrl`, and no pretend in-app availability.
 * 3. Otherwise the channel's playback status decides between `eventual` and
 *    `unavailable`. Nothing is invented.
 */
import type {
  ChannelRef,
  PlaybackDescriptor,
  PlaybackOption,
  PlaybackStatus,
  TechIssue,
} from '@tdt/contracts';
import type { DatabaseHandle } from '../../infrastructure/mongo.js';
import { COLLECTIONS } from '../../infrastructure/mongo.js';
import type { ChannelDoc, PlaybackSourceDoc, YoutubeChannelDoc } from '../../infrastructure/schema.js';
import { compareSources, decidePublication, engineFor, isSourceHealthy } from './publication-policy.js';
import { channelIdFromUrl } from './youtube-channel-cache.js';
import { providerRegistry } from '../providers/providers.registry.js';
import { decideSourceEligibility } from '../providers/source-eligibility.js';
import type { AuthorizationRecord } from '../providers/authorization.js';
import { AuthorizationRepository } from '../providers/authorization.repository.js';

export interface PlaybackLookup {
  readonly channel: ChannelDoc;
  readonly sources: readonly PlaybackSourceDoc[];
}

/**
 * Authorization decisions for the sources being assembled, keyed by source id.
 *
 * 02C rule (fail-closed): a source is playable only when a recorded right says
 * so. A source absent from this map has no recorded right and is therefore NOT
 * playable — the absence of a key is a denial, never a bypass. Callers that have
 * persisted decisions pass them in; callers that do not get no playback rather
 * than unauthorised playback.
 */
export type AuthorizationMap = ReadonlyMap<string, AuthorizationRecord>;

/**
 * Whether a stored source may take part in playback at all.
 *
 * Both gates must agree: the existing publication policy (admission, provenance,
 * forged-header/app-only vetoes) AND the 02C authorization gate. Availability is
 * never consulted here — `isSourceHealthy` is applied separately by callers that
 * need it, and a healthy stream cannot rescue a missing right.
 */
function isEligibleSource(
  channel: Pick<ChannelDoc, 'editorialStatus'>,
  source: PlaybackSourceDoc,
  authorizations: AuthorizationMap | undefined,
  now: Date,
  territory: string | null,
): boolean {
  const decision = decideSourceEligibility({
    publication: {
      channelStatus: channel.editorialStatus,
      sourceStatus: source.editorialStatus,
      permission: source.permission as never,
      technicalStatus: source.technicalStatus,
      conditions: source.conditions,
    },
    authorization: authorizations?.get(source._id) ?? null,
    type: source.type as never,
    now,
    requestedTerritory: territory,
  });
  return decision.playable;
}

export function channelRef(channel: Pick<ChannelDoc, '_id' | 'slug' | 'name'>): ChannelRef {
  return { id: channel._id, slug: channel.slug, name: channel.name };
}

/** Issues for every source we deliberately do not expose, with its real cause. */
export function sourceIssues(
  sources: readonly PlaybackSourceDoc[],
  channel?: Pick<ChannelDoc, 'editorialStatus'>,
): TechIssue[] {
  const issues: TechIssue[] = [];
  for (const source of sources) {
    const decision = decidePublication({
      // The channel's own state decides first: a withdrawn channel hides every
      // one of its sources, so reporting each source as "withdrawn" would be
      // both wrong and noise.
      channelStatus: channel ? channel.editorialStatus : 'published',
      sourceStatus: source.editorialStatus,
      permission: source.permission as never,
      technicalStatus: source.technicalStatus,
      conditions: source.conditions,
    });
    if (!decision.public) {
      issues.push({
        kind: 'policy',
        code: decision.reason,
        message: `${source.provider}: no se expone (${decision.reason}).`,
        observedAt: source.updatedAt.toISOString(),
      });
      continue;
    }
    if (!isSourceHealthy(source)) {
      issues.push({
        kind: 'verification',
        code: source.technicalStatus,
        message: `${source.provider}: ${source.lastVerification?.message ?? 'sin detalle de verificación'}.`,
        observedAt: (source.lastVerifiedAt ?? source.updatedAt).toISOString(),
      });
    }
  }
  return issues;
}

function optionOf(
  source: PlaybackSourceDoc,
  preferred: boolean,
  externalFallback: string | null,
  resolvedVideos: ReadonlyMap<string, string> = new Map(),
): PlaybackOption {
  const base = source.url ?? externalFallback;
  if (!base) {
    throw new Error(`Source ${source._id} has no addressable URL.`);
  }
  /*
   * A YouTube source that points at a CHANNEL page (`/channel/<id>/live`) is not
   * addressable by the official player: it refuses a channel id (measured:
   * "Invalid video id"). When our resolution cache knows the video the channel is
   * broadcasting, the descriptor hands the client that video, so playback is
   * observable instead of an opaque frame that can only report "paused".
   *
   * When the channel has not been resolved yet, the channel page is kept as the
   * address and the client falls back to the official page rather than guessing.
   */
  const channelId = source.type === 'youtube' ? channelIdFromUrl(base) : null;
  const resolvedVideoId = channelId ? resolvedVideos.get(channelId) : undefined;
  const url = resolvedVideoId ? `https://www.youtube.com/watch?v=${resolvedVideoId}` : base;
  return {
    sourceId: source._id,
    label: labelFor(source),
    type: source.type as PlaybackOption['type'],
    engine: engineFor(source),
    url,
    externalUrl: source.type === 'youtube' || source.type === 'official-embed' || source.type === 'external'
      ? (source.officialPageUrl ?? (source.type === 'youtube' ? base : null))
      : (source.officialPageUrl ?? null),
    geoRestricted: !source.conditions.worldwide,
    preferred,
  };
}

function labelFor(source: PlaybackSourceDoc): string {
  switch (source.type) {
    case 'youtube':
      return 'Emisión en YouTube';
    case 'official-embed':
      return 'Reproductor oficial';
    case 'external':
      return 'Web del emisor';
    default:
      return source.conditions.notes && source.conditions.notes.length > 0 ? source.conditions.notes : 'Señal del emisor';
  }
}

/** The status a channel shows when no in-app source can be offered. */
export function statusWithoutInApp(
  channel: ChannelDoc,
  sources: readonly PlaybackSourceDoc[],
  authorizations?: AuthorizationMap,
  now: Date = new Date(),
): PlaybackStatus {
  const publicSources = sources.filter((source) => isEligibleSource(channel, source, authorizations, now, null));
  if (publicSources.some((source) => source.type === 'external')) {
    return 'external';
  }
  if (channel.kind === 'eventual') {
    return 'eventual';
  }
  if (publicSources.length > 0) {
    // Public in-app sources exist but none is healthy right now.
    return 'degraded';
  }
  return 'unavailable';
}

export function buildDescriptor(
  channel: ChannelDoc,
  sources: readonly PlaybackSourceDoc[],
  now: Date = new Date(),
  /** Resolved live video per YouTube channel id, read from our own cache. */
  resolvedVideos: ReadonlyMap<string, string> = new Map(),
  /**
   * YouTube channel ids we have checked and found NOT broadcasting.
   *
   * The distinction matters to the user: "we cannot see this channel" and "this
   * channel is not on air right now" are different facts, and claiming live
   * playback for the second one is exactly the bug this parameter prevents.
   */
  offlineChannels: ReadonlySet<string> = new Set(),
  /**
   * Persisted authorization decisions, keyed by source id. A source with no
   * entry is NOT playable: the 02C gate fails closed, so omitting this map
   * yields no in-app playback rather than unauthorised playback.
   */
  authorizations: AuthorizationMap | undefined = undefined,
): PlaybackDescriptor {
  const issues = sourceIssues(sources, channel);
  const ordered = [...sources].sort(compareSources);

  const inApp = ordered.filter(
    (source) =>
      isEligibleSource(channel, source, authorizations, now, null) &&
      isSourceHealthy(source) &&
      source.type !== 'external' &&
      source.url !== null,
  );

  if (inApp.length > 0) {
    const options = inApp.map((source, index) => optionOf(source, index === 0, null, resolvedVideos));
    const primary = options[0];
    if (!primary) throw new Error('unreachable: inApp is not empty');

    /*
     * A channel whose only in-app source is a YouTube channel we resolved as
     * offline is not offering live playback. Reporting `available` there made
     * the app say "Ver en directo" and mount an empty player.
     */
    const onlyOfflineYoutube = options.every((option) => {
      if (option.type !== 'youtube') return false;
      const channelId = channelIdFromUrl(option.url);
      return channelId !== null && offlineChannels.has(channelId) && !resolvedVideos.has(channelId);
    });
    if (onlyOfflineYoutube) {
      const externalUrl = options.find((option) => option.externalUrl)?.externalUrl ?? channel.websiteUrl ?? null;
      return {
        channel: channelRef(channel),
        playback: {
          status: 'eventual',
          engine: 'none',
          type: null,
          sourceId: null,
          url: null,
          externalUrl,
          options: [],
          reason: 'El canal emite por YouTube pero ahora mismo no tiene ninguna emisión en directo.',
        },
        checkedAt: now.toISOString(),
        issues,
      };
    }

    return {
      channel: channelRef(channel),
      playback: {
        status: 'available',
        engine: primary.engine,
        type: primary.type,
        sourceId: primary.sourceId,
        url: primary.url,
        externalUrl: primary.externalUrl,
        options,
        reason: null,
      },
      checkedAt: now.toISOString(),
      issues,
    };
  }

  const status = statusWithoutInApp(channel, sources, authorizations, now);
  const external = ordered.find(
    (source) =>
      source.type === 'external' &&
      isEligibleSource(channel, source, authorizations, now, null),
  );
  const externalUrl = external?.officialPageUrl ?? external?.url ?? channel.websiteUrl ?? null;

  const reason =
    status === 'external'
      ? 'El emisor solo permite ver esta señal en su propio reproductor.'
      : status === 'eventual'
        ? 'El emisor la publica como emisión eventual: puede no haber señal continua.'
        : status === 'degraded'
          ? 'Las señales están registradas pero la última verificación no encontró ninguna disponible.'
          : 'No hay ninguna señal ni página de emisión registrada para este canal.';

  return {
    channel: channelRef(channel),
    playback: {
      status,
      engine: status === 'external' ? 'external' : 'none',
      type: external ? 'external' : null,
      sourceId: external?._id ?? null,
      url: null,
      externalUrl,
      options: [],
      reason,
    },
    checkedAt: now.toISOString(),
    issues,
  };
}

export class PlaybackService {
  constructor(private readonly database: DatabaseHandle) {}

  async findChannel(slug: string): Promise<ChannelDoc | null> {
    return this.database
      .collection<ChannelDoc>(COLLECTIONS.channels)
      .findOne({ slug, editorialStatus: 'published' });
  }

  async sourcesFor(channelId: string): Promise<PlaybackSourceDoc[]> {
    return this.database
      .collection<PlaybackSourceDoc>(COLLECTIONS.sources)
      .find({ channelId })
      .sort({ priority: 1 })
      .toArray();
  }

  async descriptorForSlug(slug: string): Promise<PlaybackDescriptor | null> {
    const channel = await this.findChannel(slug);
    if (!channel) return null;
    const sources = await this.sourcesFor(channel._id);
    const { videos, offline } = await this.youtubeStateFor(sources);
    const authorizations = await this.authorizationsFor(sources);
    return buildDescriptor(channel, sources, new Date(), videos, offline, authorizations);
  }

  /**
   * The recorded authorization decision for each source, keyed by source id.
   *
   * A source missing from the returned map has no recorded right, so the gate
   * refuses it. A database failure must not be mistaken for permission, so it is
   * surfaced rather than swallowed: returning an empty map is the fail-closed
   * outcome, and the caller simply gets no playback.
   */
  async authorizationsFor(
    sources: readonly PlaybackSourceDoc[],
  ): Promise<ReadonlyMap<string, AuthorizationRecord>> {
    const repository = new AuthorizationRepository(this.database);
    return repository.decisionsForSources(sources);
  }

  /**
   * What our resolution job knows about the YouTube channels behind these
   * sources: the live video id when there is one, and which channels were
   * checked and found not to be broadcasting.
   *
   * This is a database read, never a request to YouTube: the API must answer at
   * the speed of our own data no matter how many users ask.
   */
  async youtubeStateFor(
    sources: readonly PlaybackSourceDoc[],
  ): Promise<{ videos: Map<string, string>; offline: Set<string> }> {
    const channelIds = new Set<string>();
    for (const source of sources) {
      if (source.type !== 'youtube') continue;
      const channelId = channelIdFromUrl(source.url);
      if (channelId) channelIds.add(channelId);
    }
    const videos = new Map<string, string>();
    const offline = new Set<string>();
    if (channelIds.size === 0) return { videos, offline };
    const rows = await this.database
      .collection<YoutubeChannelDoc>(COLLECTIONS.youtubeChannels)
      .find({ _id: { $in: [...channelIds] } })
      .project({ _id: 1, videoId: 1, state: 1 })
      .toArray();
    for (const row of rows) {
      if (row.state === 'live' && row.videoId) {
        videos.set(row._id, row.videoId);
      } else if (row.state === 'offline') {
        offline.add(row._id);
      }
    }
    return { videos, offline };
  }

  /** @deprecated use `youtubeStateFor`; kept so older callers keep working. */
  async resolvedVideosFor(sources: readonly PlaybackSourceDoc[]): Promise<Map<string, string>> {
    return (await this.youtubeStateFor(sources)).videos;
  }

  /**
   * Playback status for many channels at once, so list endpoints stay bounded
   * (one sources query instead of N).
   */
  async statusesFor(channels: readonly ChannelDoc[]): Promise<Map<string, PlaybackStatus>> {
    const byChannel = new Map<string, PlaybackSourceDoc[]>();
    if (channels.length === 0) return new Map();
    const ids = channels.map((channel) => channel._id);
    const sources = await this.database
      .collection<PlaybackSourceDoc>(COLLECTIONS.sources)
      .find({ channelId: { $in: ids } })
      .toArray();
    for (const source of sources) {
      const list = byChannel.get(source.channelId) ?? [];
      list.push(source);
      byChannel.set(source.channelId, list);
    }
    const statuses = new Map<string, PlaybackStatus>();
    /*
     * One authorization lookup for the whole page: a channel whose sources have
     * no recorded right must not be advertised as 'available' just because its
     * manifest answers.
     */
    const authorizations = await this.authorizationsFor(sources);
    const now = new Date();
    for (const channel of channels) {
      const list = byChannel.get(channel._id) ?? [];
      const inApp = list.filter(
        (source) =>
          source.type !== 'external' &&
          source.url !== null &&
          isSourceHealthy(source) &&
          isEligibleSource(channel, source, authorizations, now, null),
      );
      statuses.set(channel._id, inApp.length > 0 ? 'available' : statusWithoutInApp(channel, list, authorizations, now));
    }
    return statuses;
  }

  /** Verifies one source with its provider adapter and records the result. */
  async verifySource(sourceId: string, egress: { blockedHosts: readonly string[]; timeoutMs: number }): Promise<import('@tdt/contracts').VerifySourceResult> {
    const sources = this.database.collection<PlaybackSourceDoc>(COLLECTIONS.sources);
    const source = await sources.findOne({ _id: sourceId });
    if (!source) {
      throw new Error('source not found');
    }
    const check = await providerRegistry.verify(source, egress);
    const checkedAt = new Date();
    await sources.updateOne(
      { _id: sourceId },
      {
        $set: {
          technicalStatus: check.technicalStatus,
          lastVerifiedAt: checkedAt,
          lastVerification: {
            status: check.technicalStatus,
            httpStatus: check.httpStatus,
            message: check.message,
            checkedAt,
          },
          updatedAt: checkedAt,
        },
        $inc: { revision: 1 },
      },
    );
    return {
      sourceId,
      status: check.technicalStatus as never,
      httpStatus: check.httpStatus,
      checkedAt: checkedAt.toISOString(),
      message: check.message,
    };
  }
}
