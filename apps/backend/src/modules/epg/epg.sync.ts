/**
 * Synchronisation bookkeeping for guide sources (TDT-API-02FG).
 *
 * Two things live here, both deliberately small:
 *
 * 1. `epg_sync_runs` — one row per run of one source, success or failure, so a
 *    silent guide outage is impossible to miss.
 * 2. The scheduling decision itself (`planRuns`, `nextRunAfter`, `shouldRetry`),
 *    kept pure so the back-off and the retry cap are testable without Mongo and
 *    without waiting for a timer.
 *
 * Bounded retries are the point: a source that has been failing for hours must
 * not be retried every minute, and must not be dropped either. The back-off is
 * exponential up to the source's own interval, and the scheduled job gives up
 * for that round after `MAX_ATTEMPTS` consecutive failures — the next round
 * still tries, because a guide may come back.
 */
import { randomUUID } from 'node:crypto';
import type { EpgSyncRun } from '@tdt/contracts';
import type { DatabaseHandle } from '../../infrastructure/mongo.js';
import { COLLECTIONS } from '../../infrastructure/mongo.js';
import type { EpgSourceDoc, EpgSyncRunDoc } from '../../infrastructure/schema.js';

/** Attempts inside one scheduled round before the source is skipped. */
export const MAX_ATTEMPTS = 3;
/** The first retry waits this long, then doubles. */
export const BASE_RETRY_MS = 60_000;
/** Default freshness target for a source that does not declare one. */
export const DEFAULT_INTERVAL_MINUTES = 360;

export type SyncTrigger = EpgSyncRunDoc['trigger'];

/**
 * Back-off after `consecutiveFailures` failures, in milliseconds.
 *
 * Zero failures means "not failing": the next run is simply the interval.
 */
export function retryDelayMs(consecutiveFailures: number, intervalMinutes: number): number {
  const intervalMs = Math.max(1, intervalMinutes) * 60_000;
  if (consecutiveFailures <= 0) return intervalMs;
  const exponential = BASE_RETRY_MS * 2 ** (consecutiveFailures - 1);
  return Math.min(intervalMs, exponential);
}

/** When the next run of this source is due. Pure. */
export function nextRunAfter(
  source: Pick<EpgSourceDoc, 'fetchIntervalMinutes' | 'consecutiveFailures'>,
  from: Date,
): Date {
  const failures = source.consecutiveFailures ?? 0;
  const interval = source.fetchIntervalMinutes ?? DEFAULT_INTERVAL_MINUTES;
  return new Date(from.getTime() + retryDelayMs(failures, interval));
}

/**
 * True while the source still deserves an attempt in this round.
 *
 * A source with no run yet always deserves one. Past the cap the round leaves it
 * alone and its `nextRunAt` drives the retry instead of a tight loop.
 */
export function shouldRetry(source: Pick<EpgSourceDoc, 'lastRunAt' | 'consecutiveFailures'>): boolean {
  if (!source.lastRunAt) return true;
  return (source.consecutiveFailures ?? 0) < MAX_ATTEMPTS;
}

export interface PlannedRun {
  readonly sourceId: string;
  readonly name: string;
  readonly dueAt: Date | null;
}

/**
 * Which sources this round should run.
 *
 * - a source that never ran, or whose `nextRunAt` has passed, is due;
 * - a source inside its back-off window is not;
 * - `force` (a manual run) ignores both, because an operator asking now is the
 *   whole point of a manual run.
 */
export function planRuns(
  sources: readonly Pick<EpgSourceDoc, '_id' | 'name' | 'ingestionEnabled' | 'status' | 'nextRunAt' | 'lastRunAt' | 'consecutiveFailures'>[],
  now: Date,
  options: { readonly force?: boolean } = {},
): PlannedRun[] {
  const planned: PlannedRun[] = [];
  for (const source of sources) {
    if (!source.ingestionEnabled || source.status !== 'published') continue;
    const dueAt = source.nextRunAt ? new Date(source.nextRunAt) : null;
    const isDue = dueAt === null || dueAt.getTime() <= now.getTime() || !source.lastRunAt;
    if (!options.force && !isDue) continue;
    planned.push({ sourceId: source._id, name: source.name, dueAt });
  }
  return planned;
}

/** Normalises a run row to the published contract shape. */
export function toSyncRun(doc: EpgSyncRunDoc, sourceName: string | null): EpgSyncRun {
  return {
    id: doc._id,
    sourceId: doc.sourceId,
    sourceName,
    startedAt: doc.startedAt.toISOString(),
    finishedAt: doc.finishedAt ? doc.finishedAt.toISOString() : null,
    status: doc.status,
    trigger: doc.trigger,
    programmes: doc.programmes,
    channelsMatched: doc.channelsMatched,
    rejected: doc.rejected,
    duplicates: doc.duplicates,
    error: doc.error,
  };
}

export class EpgSyncRunService {
  constructor(private readonly database: DatabaseHandle) {}

  private runs() {
    return this.database.collection<EpgSyncRunDoc>(COLLECTIONS.epgSyncRuns);
  }

  async start(sourceId: string, trigger: SyncTrigger, startedAt = new Date()): Promise<string> {
    const id = randomUUID();
    const doc: EpgSyncRunDoc = {
      _id: id,
      sourceId,
      startedAt,
      finishedAt: null,
      status: 'failed',
      programmes: 0,
      channelsMatched: 0,
      rejected: 0,
      duplicates: 0,
      error: null,
      trigger,
    };
    await this.runs().insertOne(doc);
    return id;
  }

  async finish(
    runId: string,
    outcome: {
      readonly status: 'ok' | 'failed';
      readonly programmes?: number;
      readonly channelsMatched?: number;
      readonly rejected?: number;
      readonly duplicates?: number;
      readonly error?: string | null;
    },
  ): Promise<void> {
    await this.runs().updateOne(
      { _id: runId },
      {
        $set: {
          status: outcome.status,
          finishedAt: new Date(),
          programmes: outcome.programmes ?? 0,
          channelsMatched: outcome.channelsMatched ?? 0,
          rejected: outcome.rejected ?? 0,
          duplicates: outcome.duplicates ?? 0,
          error: outcome.error ?? null,
        },
      },
    );
  }

  async list(
    options: { readonly sourceId?: string; readonly limit?: number } = {},
  ): Promise<EpgSyncRun[]> {
    const query: Record<string, unknown> = {};
    if (options.sourceId) query['sourceId'] = options.sourceId;
    const docs = await this.runs()
      .find(query)
      .sort({ startedAt: -1 })
      .limit(Math.min(Math.max(options.limit ?? 50, 1), 200))
      .toArray();
    if (docs.length === 0) return [];
    const sources = await this.database
      .collection<EpgSourceDoc>(COLLECTIONS.epgSources)
      .find({ _id: { $in: [...new Set(docs.map((doc) => doc.sourceId))] } }, { projection: { name: 1 } })
      .toArray();
    const nameById = new Map(sources.map((source) => [source._id, source.name]));
    return docs.map((doc) => toSyncRun(doc, nameById.get(doc.sourceId) ?? null));
  }

  /** Runs that failed, newest first: the operations view's first question. */
  async failures(limit = 50): Promise<EpgSyncRun[]> {
    const docs = await this.runs().find({ status: 'failed' }).sort({ startedAt: -1 }).limit(limit).toArray();
    if (docs.length === 0) return [];
    const sources = await this.database
      .collection<EpgSourceDoc>(COLLECTIONS.epgSources)
      .find({ _id: { $in: [...new Set(docs.map((doc) => doc.sourceId))] } }, { projection: { name: 1 } })
      .toArray();
    const nameById = new Map(sources.map((source) => [source._id, source.name]));
    return docs.map((doc) => toSyncRun(doc, nameById.get(doc.sourceId) ?? null));
  }
}
