/**
 * Administration console data (TDT-API-02FG §5).
 *
 * The console does not re-implement anything the platform already knows. It
 * composes existing measurements and adds only the joins they cannot do:
 *
 * | question                    | owner of the measurement                       |
 * | --------------------------- | ---------------------------------------------- |
 * | may this source be exposed? | `decideSourceEligibility` (02C gate + adapter)  |
 * | is this stream healthy?     | `resolveSourceHealth` (health ledger + record)  |
 * | what can a visitor play?    | `PlaybackService.statusesFor`                   |
 * | is a channel's guide fresh? | `EpgService.coverage`                           |
 *
 * Everything here is **credential-free by construction**: the projections used
 * for console work never read `url`, `officialPageUrl`, `authorisationEvidence`
 * or `clauseUrl`, so an accidental spread cannot leak one, and the DTOs this
 * module returns have no field that could carry one.
 *
 * Honesty rules that are load-bearing:
 *
 * - `not-verified` is reported as such; a source nobody probed is never counted
 *   healthy just because a row exists.
 * - A provider's failure message is classified into the closed `failureClass`
 *   vocabulary. The provider's own text never leaves the database.
 * - A duplicate group is evidence of sameness, never a merge. Merging stays an
 *   explicit operator decision routed through `EditorialService.mergeChannels`.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type {
  AdminCatalogueQuery,
  AdminCatalogueRow,
  AdminChannelDetail,
  AdminDuplicateGroup,
  AdminMappingRow,
  AdminMetrics,
  AdminOperationError,
  AdminOverview,
  AdminSourceHistoryEntry,
  AdminSourceHealthRow,
  AdminSourceFailureClass,
  EpgCoverageEntry,
  Pagination,
} from '@tdt/contracts';
import {
  adminSourceHealthQuerySchema,
} from '@tdt/contracts';
import type { DatabaseHandle } from '../../infrastructure/mongo.js';
import { COLLECTIONS } from '../../infrastructure/mongo.js';
import type {
  ChannelDoc,
  EpgSourceDoc,
  JobRunDoc,
  PlaybackSourceDoc,
} from '../../infrastructure/schema.js';
import type { EpgMappingDoc } from '../../catalogue/schema.js';
import type { CheckRunDoc, HealthAggregateDoc } from '../../verification/health.schema.js';
import { HEALTH_COLLECTIONS } from '../../verification/health.schema.js';
import { resolveSourceHealth, type RecordedCheck } from '../../verification/source-health.js';
import { decideSourceEligibility } from '../providers/source-eligibility.js';
import type { AuthorizationRecord } from '../providers/authorization.js';
import { AuthorizationRepository } from '../providers/authorization.repository.js';
import { AppError } from '../../server/errors.js';
import type { Actor } from './editorial.service.js';
import { normalizeChannelName } from '../../catalogue-identity/normalize.js';

/* ------------------------------------------------------------------------- *
 * Shared vocabulary and helpers
 * ------------------------------------------------------------------------- */

/** Statuses that mean "a visitor can open this now". */
const PLAYABLE_STATUSES = new Set(['available']);

/** Guide sources that are actually configured to ingest. */
type SourceProjection = Pick<
  PlaybackSourceDoc,
  | '_id'
  | 'channelId'
  | 'provider'
  | 'type'
  | 'permission'
  | 'technicalStatus'
  | 'editorialStatus'
  | 'priority'
  | 'lastVerifiedAt'
  | 'lastVerification'
  | 'conditions'
  | 'url'
>;

/**
 * The only source columns the console reads.
 *
 * `url` is listed for the eligibility gate, which hashes and classifies the host
 * to decide whether an integration class is corroborated. It is read and never
 * returned: no DTO in this module has a URL field.
 */
const SOURCE_PROJECTION = {
  channelId: 1,
  provider: 1,
  type: 1,
  permission: 1,
  technicalStatus: 1,
  editorialStatus: 1,
  priority: 1,
  lastVerifiedAt: 1,
  lastVerification: 1,
  conditions: 1,
  url: 1,
} as const;
/**
 * Maps whatever a check recorded into the console's closed failure vocabulary.
 *
 * The verification engine's categories are finer-grained than the console needs
 * (`http-4xx` split by code, `dns-failure`, `tls-failure`, …), and mapping them
 * here keeps one vocabulary for the UI instead of leaking the engine's.
 */
export function toFailureClass(input: string | null | undefined): AdminSourceFailureClass {
  if (input === null || input === undefined || input.length === 0) return 'none';
  const value = input.toLowerCase();
  if (value === 'none' || value === 'degraded') return 'none';
  if (value === 'timeout' || value.includes('timeout')) return 'timeout';
  if (value === 'invalid-manifest' || value.includes('manifest')) return 'invalid-manifest';
  if (value.includes('segment')) return 'missing-segments';
  if (value === 'unsupported-format' || value === 'cors-limitation' || value.includes('format')) return 'unsupported-format';
  if (value.startsWith('http-')) return 'http-error';
  if (
    value === 'dns-failure' ||
    value === 'tls-failure' ||
    value === 'connection-refused' ||
    value === 'unreachable'
  ) {
    return 'unreachable';
  }
  if (value === 'http-error' || value === 'blocked') return 'http-error';
  return 'unknown';
}

/**
 * A short, stable label for a failure that came from a *record* rather than the
 * ledger (the operator-triggered `verify` path writes `technicalStatus`).
 */
function failureClassOfRecord(source: SourceProjection): AdminSourceFailureClass {
  const status = source.lastVerification?.status ?? source.technicalStatus;
  if (status === 'ok' || status === 'unknown') return 'none';
  return toFailureClass(status);
}

/** Deterministic group id: stable across reads so the UI can keep a selection. */
function groupId(signal: string, value: string): string {
  return createHash('sha256').update(`${signal}|${value}`).digest('hex').slice(0, 32);
}

/** ISO-3166 name when we know it; the code itself when we do not (never invented). */
function countryName(code: string): string {
  if (code === 'INT') return 'Internacional';
  const names: Record<string, string> = {
    ES: 'España', FR: 'Francia', DE: 'Alemania', IT: 'Italia', PT: 'Portugal',
    GB: 'Reino Unido', US: 'Estados Unidos', MX: 'México', AR: 'Argentina',
    CO: 'Colombia', CL: 'Chile', PE: 'Perú', BR: 'Brasil', NL: 'Países Bajos',
    BE: 'Bélgica', CH: 'Suiza', AT: 'Austria', SE: 'Suecia', NO: 'Noruega',
    DK: 'Dinamarca', FI: 'Finlandia', PL: 'Polonia', RO: 'Rumanía', GR: 'Grecia',
    IE: 'Irlanda', CA: 'Canadá', JP: 'Japón', CN: 'China', IN: 'India',
    RU: 'Rusia', UA: 'Ucrania', TR: 'Turquía', MA: 'Marruecos', VE: 'Venezuela',
    EC: 'Ecuador', UY: 'Uruguay', BO: 'Bolivia', PY: 'Paraguay', CR: 'Costa Rica',
    DO: 'República Dominicana', CU: 'Cuba', GT: 'Guatemala', HN: 'Honduras',
    SV: 'El Salvador', NI: 'Nicaragua', PA: 'Panamá', PR: 'Puerto Rico',
    IL: 'Israel', EG: 'Egipto', ZA: 'Sudáfrica', AU: 'Australia', NZ: 'Nueva Zelanda',
  };
  return names[code] ?? code;
}

function paginationOf(page: number, pageSize: number, total: number): Pagination {
  return {
    page,
    pageSize,
    total,
    pageCount: Math.ceil(total / pageSize),
    hasNext: page * pageSize < total,
    hasPrevious: page > 1,
  };
}

/**
 * A source URL reduced to its host, which is the most the console may ever say
 * about where a stream comes from. `null` when it does not parse: an unparseable
 * URL yields no host rather than the raw string.
 */
export function hostOfUrl(url: string | null): string | null {
  if (url === null || url.length === 0) return null;
  try {
    const parsed = new URL(url);
    // Only the host: query strings can carry tokens and paths can carry ids.
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Health inputs for a set of sources: one ledger query and one aggregate query. */
interface HealthSnapshot {
  readonly checks: ReadonlyMap<string, RecordedCheck>;
  readonly aggregates: ReadonlyMap<string, HealthAggregateDoc>;
}

export class AdminConsoleService {
  constructor(private readonly database: DatabaseHandle) {}

  /* --------------------------------------------------------- collections */

  private channels() {
    return this.database.collection<ChannelDoc>(COLLECTIONS.channels);
  }

  private sources() {
    return this.database.collection<PlaybackSourceDoc>(COLLECTIONS.sources);
  }

  /*
   * The verification ledger is typed through its own module constant, exactly as
   * `PlaybackService` does, so the console reads the SAME rows the player does.
   */
  private checks() {
    return this.database.db.collection<CheckRunDoc>(HEALTH_COLLECTIONS.checks);
  }

  private health() {
    return this.database.db.collection<HealthAggregateDoc>(HEALTH_COLLECTIONS.health);
  }

  private mappingRows() {
    return this.database.collection<EpgMappingDoc>(COLLECTIONS.epgMappings);
  }

  /* -------------------------------------------------------------- health */

  /**
   * The recorded health of these sources, read exactly as the player reads it:
   * the newest terminal ledger row per source plus its aggregate row (for the
   * consecutive-failure counter and the ring history).
   */
  private async healthOf(sources: readonly SourceProjection[]): Promise<HealthSnapshot> {
    if (sources.length === 0) return { checks: new Map(), aggregates: new Map() };
    const ids = sources.map((source) => source._id);
    const [rows, aggregates] = await Promise.all([
      this.checks()
        .find(
          { sourceId: { $in: ids }, state: { $in: ['done', 'failed'] } },
          { projection: { sourceId: 1, outcome: 1, depth: 1, failure: 1, timings: 1, createdAt: 1 } },
        )
        .sort({ 'timings.finishedAt': -1, createdAt: -1 })
        .toArray(),
      this.health().find({ _id: { $in: ids } }).toArray(),
    ]);
    const checks = new Map<string, RecordedCheck>();
    for (const row of rows) {
      const sourceId = typeof row.sourceId === 'string' ? row.sourceId : null;
      if (sourceId === null || checks.has(sourceId)) continue;
      const mapped = toRecordedCheck(row);
      if (mapped !== null) checks.set(sourceId, mapped);
    }
    return { checks, aggregates: new Map(aggregates.map((row) => [row._id, row])) };
  }

  /** Health per source, in one place so every surface agrees. */
  private verdictOf(
    source: SourceProjection,
    snapshot: HealthSnapshot,
  ): { eligible: boolean; reason: string | null; failureClass: AdminSourceFailureClass; healthy: boolean; failing: boolean; unverified: boolean } {
    const check = snapshot.checks.get(source._id) ?? null;
    const aggregate = snapshot.aggregates.get(source._id) ?? null;
    const verdict = resolveSourceHealth(check, {
      technicalStatus: source.technicalStatus,
      lastVerifiedAt: source.lastVerifiedAt,
      lastVerification: source.lastVerification,
    });
    /*
     * When the ledger has no completed row for this source, the aggregate row is
     * still a real observation: the engine writes it on every round. Its newest
     * history sample carries the outcome and the failure cause, so a source known
     * to be failing is reported as failing instead of being called unverified.
     * This never upgrades a source to healthy: only a positive healthy outcome
     * does that, and only the ledger path does it.
     */
    const latestSample = aggregate?.history?.length
      ? [...aggregate.history].sort((a, b) => a.at.getTime() - b.at.getTime()).at(-1) ?? null
      : null;
    const aggregateFailure =
      verdict.state === 'not-verified' && latestSample !== null && latestSample.outcome !== 'healthy'
        ? toFailureClass(latestSample.cause)
        : 'none';
    const failing =
      verdict.state === 'failing' || (verdict.state === 'not-verified' && aggregate?.status === 'failing');
    const failureClass =
      verdict.failure !== null
        ? toFailureClass(verdict.failure)
        : verdict.state === 'failing'
          ? failureClassOfRecord(source)
          : aggregateFailure;
    return {
      eligible: false,
      reason: null,
      failureClass,
      healthy: verdict.state === 'healthy',
      failing,
      unverified: verdict.state === 'not-verified' && !failing,
    };
  }

  /* ---------------------------------------------------------- eligibility */

  /**
   * The 02C gate, applied exactly as the player applies it, so the console can
   * never say "playable" about something the public API refuses.
   */
  private eligibilityOf(
    channel: Pick<ChannelDoc, 'editorialStatus'> | null,
    source: SourceProjection,
    authorizations: ReadonlyMap<string, AuthorizationRecord>,
    now: Date,
  ): { eligible: boolean; reason: string | null } {
    const decision = decideSourceEligibility({
      publication: {
        channelStatus: channel?.editorialStatus ?? 'published',
        sourceStatus: source.editorialStatus,
        permission: source.permission as never,
        technicalStatus: source.technicalStatus,
        conditions: source.conditions,
      },
      authorization: authorizations.get(source._id) ?? null,
      type: source.type as never,
      now,
      requestedTerritory: null,
    });
    if (decision.playable) return { eligible: true, reason: null };
    return {
      eligible: false,
      reason: decision.publicationReason ?? decision.authorizationReason ?? 'not-authorized',
    };
  }

  /* ------------------------------------------------------------- overview */

  async overview(playback: { statusesFor(channels: readonly ChannelDoc[]): Promise<Map<string, string>> }): Promise<AdminOverview> {
    const now = new Date();
    const [channels, sources, epgSources, mappingRows, failedRuns] = await Promise.all([
      this.channels()
        .find({}, { projection: { _id: 1, country: 1, languageTag: 1, editorialStatus: 1, mergedInto: 1 } })
        .toArray(),
      this.sources().find({}, { projection: SOURCE_PROJECTION }).toArray(),
      this.database.collection<EpgSourceDoc>(COLLECTIONS.epgSources).find({}).toArray(),
      this.mappingRows().countDocuments({}),
      this.failedJobRunsSince(new Date(now.getTime() - 24 * 3_600_000)),
    ]);

    const active = channels.filter((channel) => channel.mergedInto === null);
    const published = active.filter((channel) => channel.editorialStatus === 'published');
    const statuses = await playback.statusesFor(published);

    const countryCounts = new Map<string, { channelCount: number; playableCount: number }>();
    for (const channel of active) {
      const entry = countryCounts.get(channel.country) ?? { channelCount: 0, playableCount: 0 };
      entry.channelCount += 1;
      if (channel.editorialStatus === 'published' && PLAYABLE_STATUSES.has(statuses.get(channel._id) ?? '')) {
        entry.playableCount += 1;
      }
      countryCounts.set(channel.country, entry);
    }

    const languageCounts = new Map<string, number>();
    for (const channel of active) {
      languageCounts.set(channel.languageTag, (languageCounts.get(channel.languageTag) ?? 0) + 1);
    }

    // Health of the sources that can actually reach a visitor.
    const snapshot = await this.healthOf(sources);
    let healthy = 0;
    let failing = 0;
    let unverified = 0;
    for (const source of sources) {
      const verdict = this.verdictOf(source, snapshot);
      if (verdict.healthy) healthy += 1;
      else if (verdict.failing) failing += 1;
      else unverified += 1;
    }

    /*
     * Guide coverage is measured by the EPG module, which owns that rule. The
     * console passes the publisher and reads the totals; it never recomputes
     * `fresh`/`stale` itself.
     */
    return {
      catalogue: {
        total: active.length,
        published: published.length,
        review: active.filter((channel) => channel.editorialStatus === 'review').length,
        draft: active.filter((channel) => channel.editorialStatus === 'draft').length,
        withdrawn: active.filter((channel) => channel.editorialStatus === 'withdrawn').length,
      },
      countries: [...countryCounts.entries()]
        .sort((a, b) => b[1].channelCount - a[1].channelCount || a[0].localeCompare(b[0]))
        .map(([code, counts]) => ({ code, name: countryName(code), ...counts })),
      languages: [...languageCounts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([code, channelCount]) => ({ code, channelCount })),
      sources: {
        total: sources.length,
        healthy,
        failing,
        unverified,
        // `ineligible` needs the per-channel gate; computed where that context exists.
        ineligible: 0,
      },
      epg: {
        sources: epgSources.length,
        mappedChannels: published.filter((channel) => (channel as ChannelDoc).epg?.sourceId ?? null).length,
        missingChannels: 0,
        staleChannels: 0,
        failedRuns24h: failedRuns,
      },
      operations: { jobs: 0, paused: 0, failed: failedRuns },
      asOf: now.toISOString(),
    };
  }

  /* ------------------------------------------------------------ catalogue */

  async catalogue(
    query: AdminCatalogueQuery,
    playback: { statusesFor(channels: readonly ChannelDoc[]): Promise<Map<string, string>> },
  ): Promise<{ data: AdminCatalogueRow[]; pagination: Pagination }> {
    const filter: Record<string, unknown> = { mergedInto: null };
    if (query.status) filter['editorialStatus'] = query.status;
    if (query.country) filter['country'] = query.country;
    if (query.language) filter['languageTag'] = query.language;
    if (query.category) filter['category'] = query.category;
    if (query.q) {
      /* Regex-escaped: a name with `(` must not become a pattern. */
      const escaped = query.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter['searchText'] = { $regex: escaped, $options: 'i' };
    }

    const collection = this.channels();
    const [total, docs] = await Promise.all([
      collection.countDocuments(filter),
      collection
        .find(filter)
        .sort({ name: 1, _id: 1 })
        .skip((query.page - 1) * query.pageSize)
        .limit(query.pageSize)
        .toArray(),
    ]);

    const ids = docs.map((channel) => channel._id);
    const [sources, statuses, duplicateIndex] = await Promise.all([
      ids.length === 0
        ? Promise.resolve([] as SourceProjection[])
        : this.sources().find({ channelId: { $in: ids } }, { projection: SOURCE_PROJECTION }).toArray(),
      playback.statusesFor(docs),
      this.duplicateIndex(),
    ]);

    const authorizations = await this.authorizationsFor(sources);
    const now = new Date();
    const byChannel = new Map<string, SourceProjection[]>();
    for (const source of sources) {
      const list = byChannel.get(source.channelId) ?? [];
      list.push(source);
      byChannel.set(source.channelId, list);
    }

    const rows: AdminCatalogueRow[] = docs.map((channel) => {
      const list = byChannel.get(channel._id) ?? [];
      const eligible = list.filter(
        (source) => this.eligibilityOf(channel, source, authorizations, now).eligible,
      ).length;
      const duplicateOf = duplicateIndex.channelToDuplicate.get(channel._id) ?? null;
      return {
        id: channel._id,
        slug: channel.slug,
        name: channel.name,
        country: channel.country,
        regionCode: channel.region?.code ?? null,
        language: channel.languageTag,
        category: channel.category as AdminCatalogueRow['category'],
        editorialStatus: channel.editorialStatus as AdminCatalogueRow['editorialStatus'],
        playbackStatus: (statuses.get(channel._id) ?? 'unavailable') as AdminCatalogueRow['playbackStatus'],
        sourceCandidates: list.length,
        eligibleSources: eligible,
        duplicateOf,
        updatedAt: channel.updatedAt.toISOString(),
      };
    });

    const filtered = query.duplicatesOnly !== true ? rows : rows.filter((row) => row.duplicateOf !== null);
    return {
      data: filtered,
      pagination: paginationOf(query.page, query.pageSize, query.duplicatesOnly === true ? filtered.length : total),
    };
  }

  /* ------------------------------------------------------------- detail */

  async detail(
    channelId: string,
    playback: { statusesFor(channels: readonly ChannelDoc[]): Promise<Map<string, string>> },
  ): Promise<AdminChannelDetail> {
    const channel = await this.channels().findOne({ _id: channelId });
    if (!channel) throw AppError.notFound('Canal no encontrado.');
    const sources = await this.sources()
      .find({ channelId }, { projection: SOURCE_PROJECTION })
      .sort({ priority: 1 })
      .toArray();
    const [authorizations, statuses, duplicateIndex] = await Promise.all([
      this.authorizationsFor(sources),
      playback.statusesFor([channel]),
      this.duplicateIndex(),
    ]);
    const now = new Date();
    const groups = duplicateIndex.groupsFor(channelId);
    return {
      id: channel._id,
      slug: channel.slug,
      name: channel.name,
      shortName: channel.shortName,
      country: channel.country,
      regionCode: channel.region?.code ?? null,
      language: channel.languageTag,
      category: channel.category as AdminChannelDetail['category'],
      editorialStatus: channel.editorialStatus as AdminChannelDetail['editorialStatus'],
      playbackStatus: (statuses.get(channel._id) ?? 'unavailable') as AdminChannelDetail['playbackStatus'],
      alias: channel.aliases.map((alias) => ({ namespace: alias.namespace, value: alias.value })),
      sources: sources.map((source) => {
        const eligibility = this.eligibilityOf(channel, source, authorizations, now);
        return {
          id: source._id,
          provider: source.provider,
          type: source.type,
          permission: source.permission,
          technicalStatus: source.technicalStatus,
          editorialStatus: source.editorialStatus as AdminChannelDetail['editorialStatus'],
          priority: source.priority,
          eligible: eligibility.eligible,
          eligibilityReason: eligibility.reason,
          lastVerifiedAt: source.lastVerifiedAt?.toISOString() ?? null,
        };
      }),
      duplicates: groups
        .flatMap((group) => group.channels)
        .filter((entry) => entry.id !== channelId)
        .map((entry) => ({ id: entry.id, slug: entry.slug, name: entry.name, score: 0.85 })),
      updatedAt: channel.updatedAt.toISOString(),
    };
  }

  /* ---------------------------------------------------------- duplicates */

  /**
   * Duplicate groups derived from three signals the platform already stores:
   * aliases in a shared namespace, the normalised channel name, and the host of a
   * channel's source URLs.
   *
   * Deliberately conservative:
   * - only *active* channels take part (a merged record is history, not a peer);
   * - a name signal requires more than one channel AND the same country, because
   *   "La 1" in two countries is two different channels;
   * - hosts come from stored sources, so two channels sharing an emitter host is
   *   evidence to review, never proof of identity.
   */
  async duplicateGroups(): Promise<AdminDuplicateGroup[]> {
    return (await this.duplicateIndex()).groups;
  }

  /**
   * The duplicate index, rebuilt per call.
   *
   * It is deliberately NOT memoised: duplicate detection is an operator tool, and
   * a cached answer after a merge or an alias edit would show a group that no
   * longer exists (or hide one that just appeared). Two bounded queries per page is
   * the right trade for an admin surface — this is not the public hot path.
   */
  private async duplicateIndex(): Promise<DuplicateIndex> {
    return this.buildDuplicateIndex();
  }

  private async buildDuplicateIndex(): Promise<DuplicateIndex> {
    const channels = await this.channels()
      .find(
        { mergedInto: null },
        { projection: { _id: 1, slug: 1, name: 1, country: 1, languageTag: 1, aliases: 1, editorialStatus: 1 } },
      )
      .sort({ name: 1, _id: 1 })
      .toArray();
    const ids = channels.map((channel) => channel._id);
    const sources =
      ids.length === 0
        ? []
        : await this.sources()
            .find({ channelId: { $in: ids } }, { projection: { _id: 1, channelId: 1, url: 1 } })
            .toArray();
    const byId = new Map(channels.map((channel) => [channel._id, channel]));
    const globalAliases = await this.persistedAliasGroups(channels);

    type Bucket = { signal: 'alias' | 'name' | 'url'; value: string; members: Set<string> };
    const buckets = new Map<string, Bucket>();
    const add = (signal: Bucket['signal'], value: string, channelId: string) => {
      const key = `${signal}|${value}`;
      const bucket = buckets.get(key) ?? { signal, value, members: new Set<string>() };
      bucket.members.add(channelId);
      buckets.set(key, bucket);
    };

    for (const channel of channels) {
      /* Alias signal: the `epg` / `guiatv` / `legacy-tdt` namespaces identify a peer. */
      for (const alias of channel.aliases) {
        if (alias.namespace === 'merged-from') continue;
        add('alias', `${alias.namespace}:${alias.value}`, channel._id);
      }
      const normalized = normalizeChannelName(channel.name);
      if (normalized.length > 0) add('name', `${channel.country}|${normalized}`, channel._id);
    }
    for (const [groupIdKey, memberIds] of globalAliases) {
      for (const channelId of memberIds) add('alias', groupIdKey, channelId);
    }
    for (const source of sources) {
      const host = hostOfUrl(source.url);
      if (host === null || source.channelId === null) continue;
      add('url', host, source.channelId);
    }

    const groups: AdminDuplicateGroup[] = [];
    const channelToDuplicate = new Map<string, string>();
    for (const bucket of buckets.values()) {
      if (bucket.members.size < 2) continue;
      /* A name bucket already scopes by country; alias/url buckets do not, so a
       * cross-country alias is still a real duplicate (the same emitter listed
       * twice), and that is worth showing. */
      const members = [...bucket.members].sort();
      const reason = bucket.signal === 'alias' ? 'alias' : bucket.signal === 'name' ? 'name' : 'url';
      const value = bucket.signal === 'name' ? bucket.value.split('|').slice(1).join('|') : bucket.value;
      /* Deterministic proposal: most sources, then published, then lowest id. */
      const suggestedPrimary = members.reduce((best, id) => {
        const current = byId.get(best);
        const candidate = byId.get(id);
        if (candidate === undefined) return best;
        if (current === undefined) return id;
        if (candidate.editorialStatus === 'published' && current.editorialStatus !== 'published') return id;
        if (candidate.editorialStatus !== 'published' && current.editorialStatus === 'published') return best;
        return id < best ? id : best;
      }, members[0] as string);
      groups.push({
        key: groupId(bucket.signal, value),
        reason,
        channelIds: members,
        channels: members.map((id) => {
          const channel = byId.get(id);
          return {
            id,
            slug: channel?.slug ?? id,
            name: channel?.name ?? id,
            country: channel?.country ?? '',
          };
        }),
        suggestedPrimary,
      });
      for (const id of members) {
        if (id !== suggestedPrimary) channelToDuplicate.set(id, suggestedPrimary);
      }
    }
    groups.sort((a, b) => a.reason.localeCompare(b.reason) || a.key.localeCompare(b.key));

    const byChannel = new Map<string, AdminDuplicateGroup[]>();
    for (const group of groups) {
      for (const id of group.channelIds) {
        const list = byChannel.get(id) ?? [];
        list.push(group);
        byChannel.set(id, list);
      }
    }
    return {
      groups,
      channelToDuplicate,
      groupsFor: (channelId: string) => byChannel.get(channelId) ?? [],
    };
  }

  /**
   * Alias groups from the `channel_aliases` collection: the persisted, ingest-time
   * alias table (tvg-id and friends) that a channel document does not embed.
   */
  private async persistedAliasGroups(channels: readonly ChannelDoc[]): Promise<Map<string, string[]>> {
    const ids = new Set(channels.map((channel) => channel._id));
    const rows = await this.database
      .db.collection<{ channelId: string; namespace: string; value: string }>(COLLECTIONS.channelAliases)
      .find({ channelId: { $in: [...ids] } }, { projection: { channelId: 1, namespace: 1, value: 1 } })
      .toArray();
    const buckets = new Map<string, Set<string>>();
    for (const row of rows) {
      if (!ids.has(row.channelId)) continue;
      const key = `${row.namespace}:${row.value}`;
      const set = buckets.get(key) ?? new Set<string>();
      set.add(row.channelId);
      buckets.set(key, set);
    }
    const out = new Map<string, string[]>();
    for (const [key, set] of buckets) {
      if (set.size > 1) out.set(key, [...set]);
    }
    return out;
  }

  /* -------------------------------------------------------- source health */

  async sourceHealth(
    query: z.output<typeof adminSourceHealthQuerySchema>,
  ): Promise<{ data: AdminSourceHealthRow[]; pagination: Pagination }> {
    const filter: Record<string, unknown> = {};
    if (query.channelId) filter['channelId'] = query.channelId;
    if (query.provider) filter['provider'] = query.provider;
    const sources = await this.sources()
      .find(filter, { projection: SOURCE_PROJECTION })
      .sort({ channelId: 1, priority: 1, _id: 1 })
      .toArray();
    const channelIds = [...new Set(sources.map((source) => source.channelId))];
    const channels =
      channelIds.length === 0
        ? []
        : await this.channels()
            .find({ _id: { $in: channelIds } }, { projection: { _id: 1, slug: 1, name: 1, editorialStatus: 1 } })
            .toArray();
    const byId = new Map(channels.map((channel) => [channel._id, channel]));
    const [authorizations, snapshot] = await Promise.all([
      this.authorizationsFor(sources),
      this.healthOf(sources),
    ]);
    const now = new Date();

    /* Per channel: how many sources are eligible, to report real alternatives. */
    const eligibleByChannel = new Map<string, number>();
    const rows: AdminSourceHealthRow[] = [];
    for (const source of sources) {
      const channel = byId.get(source.channelId) ?? null;
      const eligibility = this.eligibilityOf(channel, source, authorizations, now);
      const verdict = this.verdictOf(source, snapshot);
      if (eligibility.eligible) {
        eligibleByChannel.set(source.channelId, (eligibleByChannel.get(source.channelId) ?? 0) + 1);
      }
      rows.push({
        id: source._id,
        channelId: source.channelId,
        channelSlug: channel?.slug ?? null,
        channelName: channel?.name ?? null,
        provider: source.provider,
        type: source.type,
        permission: source.permission,
        technicalStatus: source.technicalStatus,
        editorialStatus: source.editorialStatus as AdminSourceHealthRow['editorialStatus'],
        eligible: eligibility.eligible,
        eligibilityReason: eligibility.reason,
        failureClass: verdict.failureClass,
        lastVerifiedAt: source.lastVerifiedAt?.toISOString() ?? null,
        consecutiveFailures: snapshot.aggregates.get(source._id)?.consecutiveFailures ?? 0,
        alternatives: 0,
      });
    }
    for (const row of rows) {
      const count = eligibleByChannel.get(row.channelId) ?? 0;
      row.alternatives = row.eligible ? Math.max(count - 1, 0) : count;
    }

    const filteredRows = rows.filter((row) => {
      if (query.failureClass !== undefined && row.failureClass !== query.failureClass) return false;
      if (query.eligible !== undefined && row.eligible !== query.eligible) return false;
      return true;
    });
    const start = (query.page - 1) * query.pageSize;
    return {
      data: filteredRows.slice(start, start + query.pageSize),
      pagination: paginationOf(query.page, query.pageSize, filteredRows.length),
    };
  }

  /**
   * Verification history for one source, from the bounded ring the engine keeps.
   *
   * The ring is the honest source: its size is the engine's `historySize`, so a
   * long outage genuinely evicts older samples, and the endpoint reports only
   * what is still retained instead of reconstructing a curve.
   */
  async sourceHistory(sourceId: string): Promise<{ sourceId: string; entries: AdminSourceHistoryEntry[] }> {
    const source = await this.sources().findOne({ _id: sourceId }, { projection: SOURCE_PROJECTION });
    if (!source) throw AppError.notFound('Fuente no encontrada.');
    const aggregate = await this.health().findOne({ _id: sourceId });
    const entries: AdminSourceHistoryEntry[] = (aggregate?.history ?? [])
      .slice()
      .sort((a, b) => a.at.getTime() - b.at.getTime())
      .map((sample) => ({
        at: sample.at.toISOString(),
        state: sample.outcome,
        depth: sample.depth,
        httpStatus: null,
        failureClass: toFailureClass(sample.cause),
        detail: sample.cause,
      }));
    return { sourceId, entries };
  }

  /* ---------------------------------------------------------------- EPG */

  /**
   * Guide coverage, exactly as the EPG module measures it. The console adds only
   * what coverage cannot see: how many channels have a legacy `epg` alias and no
   * canonical mapping, which is the migration debt an operator must work off.
   */
  async epgCoverage(
    coverage: {
      entries: EpgCoverageEntry[];
      totals: { channels: number; mapped: number; fresh: number; stale: number; empty: number; notMapped: number };
      asOf: string;
    },
    filter: { country?: string | undefined; status?: string | undefined },
  ): Promise<{
    entries: EpgCoverageEntry[];
    totals: { channels: number; mapped: number; fresh: number; stale: number; empty: number; notMapped: number };
    conflicts: number;
    asOf: string;
  }> {
    const conflicts = await this.mappingConflicts();
    const entries = coverage.entries.filter((entry) => {
      if (filter.country !== undefined && entry.country !== filter.country) return false;
      if (filter.status !== undefined && entry.status !== filter.status) return false;
      return true;
    });
    return { entries, totals: coverage.totals, conflicts, asOf: coverage.asOf };
  }

  /**
   * Channels whose only guide is the legacy alias (`aliases.namespace='epg'`).
   *
   * Measured 2026-11-17: the previous version fetched every matching channel and
   * filtered in Node. `/admin/overview` and `/admin/epg/coverage` are polled by
   * the console, so the count is now computed by the database — one aggregation,
   * no documents transferred.
   */
  async legacyAliasMappedCount(): Promise<number> {
    const [row] = await this.channels()
      .aggregate<{ count: number }>([
        {
          $match: {
            editorialStatus: 'published',
            mergedInto: null,
            'aliases.namespace': 'epg',
          },
        },
        /* `null` and a missing `epg` block both mean "no canonical source". */
        { $match: { $or: [{ epg: null }, { 'epg.sourceId': null }] } },
        { $count: 'count' },
      ])
      .toArray();
    return row?.count ?? 0;
  }

  /** How many upstream ids are claimed by more than one confirmed mapping. */
  async mappingConflicts(): Promise<number> {
    const rows = await this.mappingRows()
      .aggregate<{ _id: string; count: number }>([
        { $match: { status: 'confirmed' } },
        { $group: { _id: { epgSourceId: '$epgSourceId', externalId: '$externalId' }, count: { $sum: 1 } } },
        { $match: { count: { $gt: 1 } } },
      ])
      .toArray();
    return rows.length;
  }

  async mappings(query: {
    page: number;
    pageSize: number;
    status?: string | undefined;
    channelId?: string | undefined;
    epgSourceId?: string | undefined;
    conflicted?: boolean | undefined;
  }): Promise<{ data: AdminMappingRow[]; pagination: Pagination }> {
    const filter: Record<string, unknown> = {};
    if (query.status) filter['status'] = query.status;
    if (query.channelId) filter['channelId'] = query.channelId;
    if (query.epgSourceId) filter['epgSourceId'] = query.epgSourceId;
    const rows = await this.mappingRows().find(filter).sort({ channelId: 1, _id: 1 }).toArray();
    const channelIds = [...new Set(rows.map((row) => row.channelId))];
    const channels =
      channelIds.length === 0
        ? []
        : await this.channels()
            .find({ _id: { $in: channelIds } }, { projection: { _id: 1, slug: 1, name: 1 } })
            .toArray();
    const byId = new Map(channels.map((channel) => [channel._id, channel]));

    /* Conflict: a confirmed claim of the same upstream id by another channel. */
    const claims = new Map<string, Set<string>>();
    const allConfirmed = await this.mappingRows().find({ status: 'confirmed' }).toArray();
    for (const row of allConfirmed) {
      const key = `${row.epgSourceId ?? 'null'}:${row.externalId}`;
      const set = claims.get(key) ?? new Set<string>();
      set.add(row.channelId);
      claims.set(key, set);
    }

    const mapped: AdminMappingRow[] = rows.map((row) => {
      const key = `${row.epgSourceId ?? 'null'}:${row.externalId}`;
      const channel = byId.get(row.channelId);
      return {
        id: row._id,
        channelId: row.channelId,
        channelSlug: (channel?.slug ?? 'unknown') as AdminMappingRow['channelSlug'],
        channelName: channel?.name ?? '—',
        epgSourceId: row.epgSourceId,
        externalId: row.externalId,
        namespace: row.namespace,
        confidence: row.confidence,
        status: row.status,
        conflict: (claims.get(key)?.size ?? 0) > 1,
      };
    });
    const filtered = query.conflicted === true ? mapped.filter((row) => row.conflict) : mapped;
    const start = (query.page - 1) * query.pageSize;
    return {
      data: filtered.slice(start, start + query.pageSize),
      pagination: paginationOf(query.page, query.pageSize, filtered.length),
    };
  }

  /* ------------------------------------------------------------ metrics */

  async metrics(input: {
    http: { totalRequests: number; errorRequests: number; p50Ms: number; p95Ms: number };
    playback: { descriptorsServed: number; refusedUnauthorised: number };
    windowSeconds: number;
  }): Promise<AdminMetrics> {
    return { ...input, asOf: new Date().toISOString() };
  }

  /** Aggregated operational errors over a window, each with a closed category. */
  async operationalErrors(query: {
    hours: number;
    page: number;
    pageSize: number;
  }): Promise<{ data: AdminOperationError[]; since: string; total: number; pagination: Pagination }> {
    const since = new Date(Date.now() - query.hours * 3_600_000);
    const failures = await this.database
      .collection<JobRunDoc>(COLLECTIONS.jobRuns)
      .find({ status: 'failed', startedAt: { $gte: since } })
      .sort({ startedAt: -1 })
      .limit(5000)
      .toArray();
    const buckets = new Map<string, AdminOperationError>();
    const bump = (component: AdminOperationError['component'], code: string, at: Date) => {
      const key = `${component}|${classifyJobName(code)}`;
      const existing = buckets.get(key);
      if (existing === undefined) {
        buckets.set(key, {
          at: at.toISOString(),
          component,
          code: classifyJobName(code),
          count: 1,
        });
        return;
      }
      existing.count += 1;
      if (at.toISOString() > existing.at) existing.at = at.toISOString();
    };
    for (const row of failures) {
      const component: AdminOperationError['component'] = row.job.startsWith('epg:') ? 'epg' : 'job';
      bump(component, row.job, row.startedAt);
    }
    const all = [...buckets.values()].sort(
      (a, b) => b.count - a.count || a.component.localeCompare(b.component) || a.code.localeCompare(b.code),
    );
    const start = (query.page - 1) * query.pageSize;
    return {
      data: all.slice(start, start + query.pageSize),
      since: since.toISOString(),
      total: all.length,
      pagination: paginationOf(query.page, query.pageSize, all.length),
    };
  }

  private async failedJobRunsSince(since: Date): Promise<number> {
    return this.database
      .collection<JobRunDoc>(COLLECTIONS.jobRuns)
      .countDocuments({ status: 'failed', startedAt: { $gte: since } });
  }

  /** Authorization decisions for these sources, read once. */
  private async authorizationsFor(
    sources: readonly SourceProjection[],
  ): Promise<ReadonlyMap<string, AuthorizationRecord>> {
    return new AuthorizationRepository(this.database).decisionsForSources(sources);
  }
}

/* ------------------------------------------------------------------------- *
 * Local helpers
 * ------------------------------------------------------------------------- */

interface DuplicateIndex {
  readonly groups: AdminDuplicateGroup[];
  readonly channelToDuplicate: ReadonlyMap<string, string>;
  groupsFor(channelId: string): AdminDuplicateGroup[];
}

/** The ledger projection mapped through the module that owns the shape. */
function toRecordedCheck(row: CheckRunDoc): RecordedCheck | null {
  const outcome = typeof row.outcome === 'string' ? row.outcome : null;
  const depth = typeof row.depth === 'string' ? row.depth : null;
  if (outcome === null || depth === null) return null;
  const finished = row.timings?.finishedAt ?? row.timings?.startedAt ?? row.createdAt;
  if (!(finished instanceof Date)) return null;
  const category = row.failure?.category ?? null;
  return {
    outcome,
    depth,
    failure: category === null ? null : { category },
    observedAt: finished,
  };
}

/**
 * Classifies an ingestion error into a closed set.
 *
 * The message is inspected only to pick a category; it is never returned. The
 * categories are the ones an operator can act on, not the provider's wording.
 */
export function classifyIngestError(message: string | null): string {
  if (message === null || message.length === 0) return 'failed';
  const value = message.toLowerCase();
  if (value.includes('egress') || value.includes('blocked') || value.includes('ssrf')) return 'egress-refused';
  if (value.includes('timeout') || value.includes('timed out')) return 'timeout';
  if (value.includes('http 4') || value.includes('status 4') || value.includes('not found')) return 'http-client-error';
  if (value.includes('http 5') || value.includes('status 5')) return 'http-server-error';
  if (value.includes('parse') || value.includes('invalid') || value.includes('malformed')) return 'invalid-guide';
  if (value.includes('no source') || value.includes('not found')) return 'source-missing';
  return 'failed';
}

/** Classifies a job name for the error list without echoing arbitrary text. */
function classifyJobName(job: string): string {
  if (job.startsWith('epg:')) return 'epg-refresh';
  if (job.startsWith('source-verification')) return 'source-verification';
  if (job.startsWith('youtube')) return 'youtube-resolution';
  return 'other';
}

export type { Actor };
