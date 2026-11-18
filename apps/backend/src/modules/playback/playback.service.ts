/**
 * Playback service: assembles the descriptor the client plays.
 *
 * The service is the only place that decides which source wins, and it delegates
 * that decision to `source-selection.ts` so there is exactly one implementation of
 * the four axes (authorization → compatibility → health → quality):
 *
 * 1. In-app sources (HLS, DASH, YouTube, official embed) that are authorized and
 *    that no axis refuses, ordered by priority; the best one becomes the
 *    descriptor and the rest are its failover options.
 * 2. Otherwise, a public `external` source: status `external`, the emitter's own
 *    page as `externalUrl`, and no pretend in-app availability.
 * 3. Otherwise the channel's playback status decides between `eventual` and
 *    `unavailable`. Nothing is invented.
 *
 * Health is resolved from the recorded check first and the source row second
 * (`verification/source-health.ts`), never from `technicalStatus` alone: that
 * column is `unknown` for every row on the platform, and a truthiness check on it
 * is how an unchecked source used to be reported as available.
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
import type { Collection } from 'mongodb';
import type { ChannelDoc, PlaybackSourceDoc, YoutubeChannelDoc } from '../../infrastructure/schema.js';
import { compareSources, engineFor, decidePublication } from './publication-policy.js';
import { channelIdFromUrl } from './youtube-channel-cache.js';
import { providerRegistry } from '../providers/providers.registry.js';
import { decideSourceEligibility } from '../providers/source-eligibility.js';
import type { AuthorizationRecord } from '../providers/authorization.js';
import { AuthorizationRepository } from '../providers/authorization.repository.js';
import { HEALTH_COLLECTIONS } from '../../verification/health.schema.js';
import { recordedCheckOf, type LedgerCheckRow, type RecordedCheck } from '../../verification/source-health.js';
import {
  healthEvidence,
  hasSelectableCandidate,
  DEFAULT_REPRODUCTION_ENGINE,
  NO_EVIDENCE,
  selectPlaybackCandidates,
  sourceHealth,
  type CandidateAxes,
  type PlaybackSelection,
  type SourceEvidence,
} from './source-selection.js';

export interface PlaybackLookup {
  readonly channel: ChannelDoc;
  readonly sources: readonly PlaybackSourceDoc[];
}

/**
 * Playback counters the operations console publishes.
 *
 * Deliberately narrow: two facts the platform can state without inference.
 * `descriptorServed` is per derived status, and `refusedUnauthorised` counts a
 * descriptor refused *because* a right was missing — not every refusal.
 */
export interface PlaybackCounters {
  descriptorServed(status: PlaybackStatus): void;
  refusedUnauthorised(): void;
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
 * Whether a stored source may take part in playback *at all* — the exposure
 * question, not the in-app attempt question.
 *
 * The two questions are different and answering one with the other was a real
 * defect: `selectPlaybackCandidates` correctly refuses every `external` source as
 * an in-app candidate (it must never become an option or a failover target), so
 * routing this function through it made an eligible emitter-player link look
 * unexposed and the channel reported `unavailable` instead of `external` — the
 * legal external-player fallback this milestone must offer.
 *
 * So this asks the eligibility question directly, exactly as it did before the
 * selector existed, and the four-axis selector stays the only decider of in-app
 * candidates.
 */
function isEligibleSource(
  channel: Pick<ChannelDoc, 'editorialStatus'>,
  source: PlaybackSourceDoc,
  authorizations: AuthorizationMap | undefined,
  now: Date,
): boolean {
  return decideSourceEligibility({
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
    requestedTerritory: null,
  }).playable;
}

export function channelRef(channel: Pick<ChannelDoc, '_id' | 'slug' | 'name'> & { country?: string | null }): ChannelRef {
  return { id: channel._id, slug: channel.slug, name: channel.name, country: channel.country ?? null };
}

/** Issues for every source we deliberately do not expose, with its real cause. */
export function sourceIssues(
  sources: readonly PlaybackSourceDoc[],
  channel?: Pick<ChannelDoc, 'editorialStatus'>,
  evidence: SourceEvidence = NO_EVIDENCE,
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
    /*
     * Only a recorded failure is an issue. `not-verified` is the honest state of a
     * source nobody has checked, and reporting it as a verification problem would
     * be the mirror image of the defect this milestone fixes.
     */
    const health = sourceHealth(source, evidence);
    if (health.state === 'failing') {
      issues.push({
        kind: 'verification',
        code: health.failure ?? 'failing',
        message: `${source.provider}: ${source.lastVerification?.message ?? 'la última verificación falló'}.`,
        observedAt: (health.observedAt ?? source.updatedAt).toISOString(),
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
  axes?: CandidateAxes,
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
  const health = axes?.health ?? (sourceHealth(source, NO_EVIDENCE));
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
    health: healthEvidence(health),
    compatibility: axes?.compatibility ?? { state: 'unknown' },
    observedAt: health.observedAt?.toISOString() ?? null,
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
  evidence: SourceEvidence = NO_EVIDENCE,
): PlaybackStatus {
  const selection = selectPlaybackCandidates({ channel, sources, authorizations, now, evidence });
  if (hasSelectableCandidate(selection)) return 'available';

  /*
   * Precedence, and why it is this order rather than any other:
   *
   *   available → external → degraded → eventual → unavailable
   *
   * `external` comes BEFORE `degraded` because the two answers mean different
   * things to a user. "We cannot play it in-app, but the emitter publishes it in
   * their own player" is a real, legitimate option — the legal external-player
   * fallback this milestone is required to offer — while "we hold in-app sources
   * that no axis currently lets us use" is a statement about *our* availability.
   * A channel that qualifies for both must be reported as `external`: reporting it
   * `degraded` hides the emitter's player and, worse, contradicts the
   * `externalUrl` the descriptor goes on to attach — a fallback URL under a status
   * that says there is nothing to watch.
   *
   * `degraded` still means exactly one thing, and only an AUTHORIZED candidate can
   * produce it: a channel whose sources are all refused has no signal we may
   * offer at all, which is `unavailable`, not "degraded".
   */
  const publicSources = sources.filter((source) => isEligibleSource(channel, source, authorizations, now));
  if (publicSources.some((source) => source.type === 'external')) {
    return 'external';
  }
  if (selection.refused.length > 0) return 'degraded';
  if (channel.kind === 'eventual') {
    return 'eventual';
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
  /**
   * Recorded health evidence (the 02D ledger), keyed by source id.
   *
   * Required by the *service* path, which always resolves it with
   * `evidenceFor()` before building a descriptor; a pure caller may omit it, and
   * then each source falls back to its own record and then to `not-verified`.
   * There is deliberately no default here: an optional parameter that silently
   * defaulted to "no evidence" in every call site is how a health axis ends up
   * wired to nothing.
   */
  evidence: SourceEvidence = NO_EVIDENCE,
): PlaybackDescriptor {
  const selection = selectPlaybackCandidates({ channel, sources, authorizations, now, evidence });
  const issues = sourceIssues(sources, channel, evidence);
  const ordered = [...sources].sort(compareSources);

  if (selection.candidates.length > 0) {
    const options = selection.candidates.map((candidate, index) =>
      optionOf(candidate.source, index === 0, null, resolvedVideos, candidate.axes),
    );
    const primary = options[0];
    if (!primary) throw new Error('unreachable: candidates is not empty');

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
          unavailableOptions: unavailableOf(selection),
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
        unavailableOptions: unavailableOf(selection),
        reason: null,
      },
      checkedAt: now.toISOString(),
      issues,
    };
  }

  const status = statusWithoutInApp(channel, sources, authorizations, now, evidence);
  const external = ordered.find(
    (source) => source.type === 'external' && isEligibleSource(channel, source, authorizations, now),
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
      unavailableOptions: unavailableOf(selection),
      reason,
    },
    checkedAt: now.toISOString(),
    issues,
  };
}

/**
 * The authorized candidates that exist but cannot be selected now.
 *
 * `authorization` refusals never reach here (the selector keeps them out of
 * `refused`), and the contract's `axis` union has no authorization member because
 * of it: a denied source is not a fallback with a reason, it is not a candidate.
 */
function unavailableOf(selection: PlaybackSelection): NonNullable<PlaybackDescriptor['playback']['unavailableOptions']> {
  return selection.refused.map((entry) => ({
    sourceId: entry.source._id,
    type: entry.source.type as PlaybackOption['type'],
    axis: entry.refusal.axis,
    code: entry.refusal.code,
  }));
}

export class PlaybackService {
  /**
   * Where playback outcomes are counted (TDT-API-02FG operations console).
   *
   * Injected rather than imported so the domain service keeps no dependency on
   * the HTTP layer's registry, and a service built without one (tests, CLI
   * scripts) simply records nothing.
   */
  constructor(
    private readonly database: DatabaseHandle,
    private readonly counters: PlaybackCounters | null = null,
  ) {}

  /**
   * The one place a served descriptor is counted.
   *
   * `refusedUnauthorised` counts channels where the only thing standing between
   * the visitor and playback was a missing right — that is the number an operator
   * needs to see, and it is read from the eligibility decision, never guessed.
   */
  private countDescriptor(descriptor: PlaybackDescriptor, sources: readonly PlaybackSourceDoc[], authorizations: AuthorizationMap): void {
    if (this.counters === null) return;
    this.counters.descriptorServed(descriptor.playback.status);
    if (descriptor.playback.status !== 'available' && descriptor.playback.status !== 'external') {
      const unauthorised = sources.some(
        (source) => source.editorialStatus !== 'withdrawn' && !authorizations.has(source._id),
      );
      if (unauthorised) this.counters.refusedUnauthorised();
    }
  }

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
    const [authorizations, evidence] = await Promise.all([
      this.authorizationsFor(sources),
      this.evidenceFor(sources),
    ]);
    const descriptor = buildDescriptor(channel, sources, new Date(), videos, offline, authorizations, evidence);
    this.countDescriptor(descriptor, sources, authorizations);
    return descriptor;
  }

  /**
   * The recorded health evidence for these sources.
   *
   * This is where the health axis gets its input, and it reads the REAL ledger
   * (`source_health_checks_02d`), because that is the only place a per-source
   * verdict is persisted: `playback_sources.technicalStatus` is `unknown` for
   * every row on the platform (measured) and never moves when a check runs.
   *
   * One query per page, not per source, and the latest terminal row per source
   * wins so a re-check supersedes an older one. A source that has no ledger row
   * stays `not-verified` — the absence is the answer, not a default `healthy`.
   */
  async evidenceFor(sources: readonly PlaybackSourceDoc[]): Promise<SourceEvidence> {
    if (sources.length === 0) return NO_EVIDENCE;
    const checks = new Map<string, RecordedCheck>();
    try {
      const rows = await this.healthChecks()
        .find(
          { sourceId: { $in: sources.map((source) => source._id) }, state: { $in: ['done', 'failed'] } },
          { projection: { sourceId: 1, outcome: 1, depth: 1, failure: 1, timings: 1, createdAt: 1 } },
        )
        .sort({ 'timings.finishedAt': -1, createdAt: -1 })
        .toArray();
      for (const row of rows) {
        const sourceId = typeof row.sourceId === 'string' ? row.sourceId : null;
        if (sourceId === null || checks.has(sourceId)) continue;
        const mapped = recordedCheckOf(row);
        if (mapped !== null) checks.set(sourceId, mapped);
      }
    } catch {
      /*
       * A ledger read failure must not be read as "nothing failed". It is also not
       * a licence to report `failing`: the honest outcome is the same as having no
       * evidence, so every source falls back to its own record and then to
       * `not-verified`.
       */
      return { checks: new Map(), reproductions: new Map(), reproductionEngine: DEFAULT_REPRODUCTION_ENGINE };
    }
    return { checks, reproductions: new Map(), reproductionEngine: DEFAULT_REPRODUCTION_ENGINE };
  }

  /** The 02D check ledger, typed through its own module constant (see health.repository). */
  private healthChecks() {
    const typed = this.database as unknown as {
      collection<T extends object>(name: string): Collection<T>;
    };
    return typed.collection<LedgerCheckRow & { sourceId?: unknown }>(HEALTH_COLLECTIONS.checks);
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
    // The same recorded evidence the single-channel path uses, one query for the
    // whole page: otherwise a list endpoint would judge health differently from
    // the descriptor a user actually opens.
    const evidence = await this.evidenceFor(sources);
    const now = new Date();
    for (const channel of channels) {
      const list = byChannel.get(channel._id) ?? [];
      statuses.set(channel._id, statusWithoutInApp(channel, list, authorizations, now, evidence));
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
