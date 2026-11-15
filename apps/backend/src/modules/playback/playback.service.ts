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
import type { ChannelDoc, PlaybackSourceDoc } from '../../infrastructure/schema.js';
import { compareSources, decidePublication, engineFor, isSourceHealthy } from './publication-policy.js';
import { providerRegistry } from '../providers/providers.registry.js';

export interface PlaybackLookup {
  readonly channel: ChannelDoc;
  readonly sources: readonly PlaybackSourceDoc[];
}

export function channelRef(channel: Pick<ChannelDoc, '_id' | 'slug' | 'name'>): ChannelRef {
  return { id: channel._id, slug: channel.slug, name: channel.name };
}

/** Issues for every source we deliberately do not expose, with its real cause. */
export function sourceIssues(sources: readonly PlaybackSourceDoc[]): TechIssue[] {
  const issues: TechIssue[] = [];
  for (const source of sources) {
    const decision = decidePublication({
      channelStatus: 'published',
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

function optionOf(source: PlaybackSourceDoc, preferred: boolean, externalFallback: string | null): PlaybackOption {
  const url = source.url ?? externalFallback;
  if (!url) {
    throw new Error(`Source ${source._id} has no addressable URL.`);
  }
  return {
    sourceId: source._id,
    label: labelFor(source),
    type: source.type as PlaybackOption['type'],
    engine: engineFor(source),
    url,
    externalUrl: source.type === 'youtube' || source.type === 'official-embed' || source.type === 'external'
      ? (source.officialPageUrl ?? (source.type === 'youtube' ? source.url : null))
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
export function statusWithoutInApp(channel: ChannelDoc, sources: readonly PlaybackSourceDoc[]): PlaybackStatus {
  const publicSources = sources.filter(
    (source) =>
      decidePublication({
        channelStatus: channel.editorialStatus,
        sourceStatus: source.editorialStatus,
        permission: source.permission as never,
        technicalStatus: source.technicalStatus,
        conditions: source.conditions,
      }).public,
  );
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
): PlaybackDescriptor {
  const issues = sourceIssues(sources);
  const ordered = [...sources].sort(compareSources);

  const inApp = ordered.filter((source) => {
    const decision = decidePublication({
      channelStatus: channel.editorialStatus,
      sourceStatus: source.editorialStatus,
      permission: source.permission as never,
      technicalStatus: source.technicalStatus,
      conditions: source.conditions,
    });
    return decision.public && isSourceHealthy(source) && source.type !== 'external' && source.url !== null;
  });

  if (inApp.length > 0) {
    const options = inApp.map((source, index) => optionOf(source, index === 0, null));
    const primary = options[0];
    if (!primary) throw new Error('unreachable: inApp is not empty');
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

  const status = statusWithoutInApp(channel, sources);
  const external = ordered.find(
    (source) =>
      source.type === 'external' &&
      decidePublication({
        channelStatus: channel.editorialStatus,
        sourceStatus: source.editorialStatus,
        permission: source.permission as never,
        technicalStatus: source.technicalStatus,
        conditions: source.conditions,
      }).public,
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
    return buildDescriptor(channel, sources);
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
    for (const channel of channels) {
      const list = byChannel.get(channel._id) ?? [];
      const inApp = list.filter(
        (source) =>
          source.type !== 'external' &&
          source.url !== null &&
          isSourceHealthy(source) &&
          decidePublication({
            channelStatus: channel.editorialStatus,
            sourceStatus: source.editorialStatus,
            permission: source.permission as never,
            technicalStatus: source.technicalStatus,
            conditions: source.conditions,
          }).public,
      );
      statuses.set(channel._id, inApp.length > 0 ? 'available' : statusWithoutInApp(channel, list));
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
