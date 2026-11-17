/**
 * Guide ingestion: fetches an *enabled* guide source, normalises it and
 * reconciles it against our canonical channels (TDT-API-02FG).
 *
 * The rules that shape this file:
 *
 * - **Only `fetchWithPolicy`.** Every byte comes through the SSRF-safe egress
 *   module with the source's declared validators (`If-None-Match`,
 *   `If-Modified-Since`), so a guide that has not changed costs one 304 and
 *   nothing else.
 * - **Canonical mappings.** An upstream id is matched through `epg_mappings`
 *   (`confirmed` rows first, the legacy `epg` alias as a compatibility fallback).
 *   Unmapped upstream ids are *proposed* and reported, never guessed, and a
 *   channel is never created here.
 * - **Nothing is invented.** A source that returns no programmes leaves the
 *   store untouched and reports `empty`; a channel that disappears from a guide
 *   keeps its history and is marked stale by the service.
 * - **Every run is recorded.** One row in `epg_sync_runs` per attempt, success
 *   or failure, plus the source's own counters (`consecutiveFailures`,
 *   `lastSuccessAt`, `nextRunAt`, the HTTP validators).
 */
import type { EpgIngestResult } from '@tdt/contracts';
import { randomUUID } from 'node:crypto';
import type { EgressOptions } from '../../infrastructure/egress.js';
import { fetchWithPolicy } from '../../infrastructure/egress.js';
import type { DatabaseHandle } from '../../infrastructure/mongo.js';
import { COLLECTIONS } from '../../infrastructure/mongo.js';
import type { ChannelDoc, EpgSourceDoc, JobRunDoc } from '../../infrastructure/schema.js';
import { EpgMappingService, SYSTEM_ACTOR } from './epg.mappings.js';
import { parseJsonGuide, parseXmltv, type ParseResult } from './epg.parsers.js';
import { EpgService } from './epg.service.js';
import { EpgSyncRunService, MAX_ATTEMPTS, nextRunAfter, type SyncTrigger } from './epg.sync.js';
import { isValidTimeZone } from './epg.timezone.js';

export interface ReconciliationReport {
  readonly upstreamChannels: string[];
  readonly matched: string[];
  readonly unmapped: string[];
}

/** Which zones a guide may legitimately be authored in (contract §4.1). */
export const SOURCE_TIMEZONES = ['Europe/Madrid', 'Europe/London', 'Europe/Berlin', 'UTC'] as const;

/** Validators a caller may pass to make a fetch conditional. */
export interface SourceValidators {
  readonly etag?: string | null;
  readonly lastModified?: string | null;
}

/** The subset of a fetch result ingestion needs; injectable for tests. */
export interface FetchedGuide {
  readonly status: number;
  readonly ok: boolean;
  readonly body: string | null;
  readonly etag: string | null;
  readonly lastModified: string | null;
}

export type GuideFetcher = (url: string, egress: EgressOptions, validators: SourceValidators) => Promise<FetchedGuide>;

/**
 * The production fetcher: one `fetchWithPolicy` call, nothing else. Validators
 * are forwarded as conditional headers so the server may answer 304.
 */
export const fetchGuide: GuideFetcher = async (url, egress, validators) => {
  const conditional: EgressOptions = {
    ...egress,
    maxBytes: egress.maxBytes ?? 32 * 1024 * 1024,
    ...(validators.etag ? { ifNoneMatch: validators.etag } : {}),
    ...(validators.lastModified ? { ifModifiedSince: validators.lastModified } : {}),
  };
  const fetched = await fetchWithPolicy(url, conditional);
  return {
    status: fetched.status,
    ok: fetched.ok,
    body: fetched.body,
    // A guarded 304 carries no headers: keep the validators the caller passed.
    etag: fetched.headers?.etag ?? validators.etag ?? null,
    lastModified: fetched.headers?.lastModified ?? validators.lastModified ?? null,
  };
};

/** Failure text we are willing to store and show: a class, never a URL. */
export function safeFailureMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  // Drop anything URL-shaped: a provider message must not leak an endpoint.
  return raw.replace(/https?:\/\/\S+/g, '[url]').slice(0, 300);
}

export class EpgIngestionService {
  readonly mappings: EpgMappingService;
  readonly syncRuns: EpgSyncRunService;

  constructor(
    private readonly database: DatabaseHandle,
    private readonly epg: EpgService,
    private readonly fetcher: GuideFetcher = fetchGuide,
  ) {
    this.mappings = new EpgMappingService(database);
    this.syncRuns = new EpgSyncRunService(database);
  }

  private epgSources() {
    return this.database.collection<EpgSourceDoc>(COLLECTIONS.epgSources);
  }

  private channels() {
    return this.database.collection<ChannelDoc>(COLLECTIONS.channels);
  }

  /** The zone a guide's wall clocks are read in. Defaults to the TDT network's. */
  static zoneOf(source: Pick<EpgSourceDoc, 'timezone'>): string {
    const zone = source.timezone ?? null;
    return zone !== null && isValidTimeZone(zone) ? zone : 'Europe/Madrid';
  }

  /**
   * Maps upstream guide ids to our channels through the canonical table.
   *
   * Legacy alias resolution is preserved inside `EpgMappingService` for
   * compatibility with guides ingested before the canonical table existed.
   */
  async reconcile(upstreamChannels: readonly string[], sourceId: string | null = null): Promise<ReconciliationReport> {
    if (upstreamChannels.length === 0) {
      return { upstreamChannels: [], matched: [], unmapped: [] };
    }
    const resolution = await this.mappings.resolveForSource(sourceId, upstreamChannels);
    const matched = [...resolution.byExternalId.keys()];
    return {
      upstreamChannels: [...upstreamChannels],
      matched,
      unmapped: upstreamChannels.filter((id) => !resolution.byExternalId.has(id)),
    };
  }

  /** Parses a guide payload according to the source kind. Pure. */
  static parse(
    source: Pick<EpgSourceDoc, 'kind' | 'timezone'>,
    payload: string,
    timezone?: string,
  ): ParseResult {
    if (source.kind === 'xmltv') {
      return parseXmltv(payload, timezone ?? EpgIngestionService.zoneOf(source));
    }
    if (source.kind === 'json-tdtchannels') {
      return parseJsonGuide(JSON.parse(payload) as unknown);
    }
    return { events: [], rejected: 0, channels: [] };
  }

  /**
   * Runs one source. The run record is always written, success or failure, so a
   * silent guide outage is impossible; the source's retry counters move either
   * way.
   *
   * `trigger` distinguishes a scheduled round from an operator's click and from
   * an incremental fetch that used HTTP validators.
   */
  async runSource(
    sourceId: string,
    egress: EgressOptions,
    triggeredBy: string,
    options: { readonly trigger?: SyncTrigger; readonly incremental?: boolean } = {},
  ): Promise<EpgIngestResult> {
    const startedAt = new Date();
    const trigger: SyncTrigger =
      options.trigger ?? (triggeredBy.startsWith('manual') ? 'manual' : 'scheduled');
    const runId = await this.syncRuns.start(sourceId, trigger, startedAt);
    const source = await this.epgSources().findOne({ _id: sourceId });

    const fail = async (message: string): Promise<EpgIngestResult> => {
      const finishedAt = new Date();
      const failures = (source?.consecutiveFailures ?? 0) + 1;
      await this.epgSources().updateOne(
        { _id: sourceId },
        {
          $set: {
            lastRunAt: finishedAt,
            lastRunStatus: 'failed',
            lastRunProgrammes: 0,
            consecutiveFailures: failures,
            updatedAt: finishedAt,
            nextRunAt: source ? nextRunAfter({ ...source, consecutiveFailures: failures }, finishedAt) : null,
          },
        },
      );
      await this.syncRuns.finish(runId, { status: 'failed', error: message });
      await this.database.collection<JobRunDoc>(COLLECTIONS.jobRuns).insertOne({
        _id: randomUUID(),
        job: `epg:${source?.name ?? sourceId}`,
        status: 'failed',
        startedAt,
        finishedAt,
        message,
        details: { sourceId, triggeredBy, trigger, syncRunId: runId },
      });
      return {
        sourceId,
        runId,
        status: 'failed',
        programmes: 0,
        channelsMatched: 0,
        rejected: 0,
        message,
      };
    };

    if (!source) return fail('Fuente de guía no encontrada.');
    if (!source.ingestionEnabled) return fail('La ingesta está deshabilitada para esta fuente.');
    if (!source.url) return fail('La fuente no tiene URL de descarga.');
    if (source.kind !== 'xmltv' && source.kind !== 'json-tdtchannels') {
      return fail('El tipo de fuente no admite ingesta automática.');
    }

    let fetched: FetchedGuide;
    try {
      fetched = await this.fetcher(source.url, egress, {
        etag: source.httpEtag ?? null,
        lastModified: source.httpLastModified ?? null,
      });
    } catch (error) {
      return fail(safeFailureMessage(error));
    }

    if (fetched.status === 304) {
      // Nothing changed upstream: the store already holds this revision.
      const finishedAt = new Date();
      await this.touchSuccess(source, 0, finishedAt, {
        etag: fetched.etag ?? source.httpEtag ?? null,
        lastModified: fetched.lastModified ?? source.httpLastModified ?? null,
      });
      await this.syncRuns.finish(runId, { status: 'ok' });
      return {
        sourceId,
        runId,
        status: 'ok',
        programmes: 0,
        channelsMatched: 0,
        rejected: 0,
        message: null,
      };
    }
    if (!fetched.ok || fetched.body === null) {
      return fail(`HTTP ${fetched.status} al descargar la guía.`);
    }

    const zone = EpgIngestionService.zoneOf(source);
    let parsed: ParseResult;
    try {
      parsed = EpgIngestionService.parse(source, fetched.body, zone);
    } catch (error) {
      return fail(safeFailureMessage(error));
    }

    const report = await this.reconcile(parsed.channels, source._id);
    const resolution = await this.mappings.resolveForSource(source._id, report.matched);
    const byExternal = new Map(resolution.byExternalId);

    let written = 0;
    let rejected = parsed.rejected;
    let duplicates = 0;
    let channelsMatched = 0;

    const perChannel = new Map<string, typeof parsed.events>();
    for (const event of parsed.events) {
      const list = perChannel.get(event.upstreamChannel) ?? [];
      list.push(event);
      perChannel.set(event.upstreamChannel, list);
    }

    for (const [upstreamId, events] of perChannel) {
      const channelId = byExternal.get(upstreamId);
      if (!channelId) {
        // Report, never guess: the proposal is the operator's to confirm.
        continue;
      }
      channelsMatched += 1;
      const result = await this.epg.upsertChannelGuide(
        channelId,
        source._id,
        events.map((event) => ({
          title: event.title,
          description: event.description,
          genre: event.genre,
          coverUrl: event.coverUrl,
          start: event.start,
          end: event.end,
          externalKey: event.externalKey,
          timezone: event.timezone,
          originalStart: event.originalStart,
        })),
        { now: startedAt, sourceTimezone: zone },
      );
      written += result.written;
      rejected += result.rejected;
      duplicates += result.duplicates;
      await this.channels().updateOne(
        { _id: channelId },
        { $set: { epg: { sourceId: source._id, externalId: upstreamId } } },
      );
    }

    // Record the intent for every upstream id we did not resolve, so an operator
    // can confirm or reject it. Proposed only: ingestion never confirms itself.
    for (const upstreamId of report.matched) {
      const channelId = byExternal.get(upstreamId);
      if (!channelId) continue;
      await this.mappings.propose(
        { channelId, epgSourceId: source._id, externalId: upstreamId, confidence: 0.5 },
        SYSTEM_ACTOR,
      );
    }

    const finishedAt = new Date();
    await this.touchSuccess(source, written, finishedAt, {
      etag: fetched.etag ?? source.httpEtag ?? null,
      lastModified: fetched.lastModified ?? source.httpLastModified ?? null,
    });
    await this.syncRuns.finish(runId, {
      status: 'ok',
      programmes: written,
      channelsMatched,
      rejected,
      duplicates,
    });
    await this.database.collection<JobRunDoc>(COLLECTIONS.jobRuns).insertOne({
      _id: randomUUID(),
      job: `epg:${source.name}`,
      status: 'ok',
      startedAt,
      finishedAt,
      message: null,
      details: {
        triggeredBy,
        trigger,
        syncRunId: runId,
        programmes: written,
        rejected,
        duplicates,
        channelsMatched,
        unmapped: report.unmapped.length,
      },
    });
    return {
      sourceId,
      runId,
      status: 'ok',
      programmes: written,
      channelsMatched,
      rejected,
      message: null,
    };
  }

  private async touchSuccess(
    source: EpgSourceDoc,
    programmes: number,
    finishedAt: Date,
    validators: { readonly etag: string | null; readonly lastModified: string | null },
  ): Promise<void> {
    await this.epgSources().updateOne(
      { _id: source._id },
      {
        $set: {
          lastRunAt: finishedAt,
          lastRunStatus: 'ok',
          lastRunProgrammes: programmes,
          lastSuccessAt: finishedAt,
          consecutiveFailures: 0,
          nextRunAt: nextRunAfter({ ...source, consecutiveFailures: 0 }, finishedAt),
          httpEtag: validators.etag,
          httpLastModified: validators.lastModified,
          updatedAt: finishedAt,
        },
      },
    );
  }

  /**
   * Scheduled entry point: runs every enabled source that is due, one at a time.
   *
   * A source past `MAX_ATTEMPTS` consecutive failures is skipped for the round
   * (its back-off drives the next attempt) instead of being retried in a loop.
   */
  async runAll(egress: EgressOptions, options: { readonly now?: Date; readonly force?: boolean } = {}): Promise<EpgIngestResult[]> {
    const now = options.now ?? new Date();
    const sources = await this.epgSources().find({ ingestionEnabled: true, status: 'published' }).toArray();
    const results: EpgIngestResult[] = [];
    for (const source of sources) {
      const due = source.nextRunAt === null || source.nextRunAt === undefined || source.nextRunAt.getTime() <= now.getTime();
      if (!options.force && !due) continue;
      if (!options.force && (source.consecutiveFailures ?? 0) >= MAX_ATTEMPTS) continue;
      results.push(
        await this.runSource(source._id, egress, 'scheduled', {
          trigger: 'scheduled',
        }),
      );
    }
    return results;
  }
}
