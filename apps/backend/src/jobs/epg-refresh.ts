/**
 * `epg-refresh` — one scheduled round of guide ingestion (TDT-API-02FG).
 *
 * What this job is, precisely: a *scheduler* over sources, never a second
 * ingestion implementation. It decides nothing about guides; it decides which
 * enabled sources deserve an attempt right now, using the pure planning rules the
 * EPG module already owns (`planRuns`, `shouldRetry`), then hands each one to
 * `EpgIngestionService.runSource`, which records the attempt in `epg_sync_runs`
 * (success or failure) and moves the source's own retry counters.
 *
 * Two rules are load-bearing and are why this is not `runAll`:
 *
 * 1. **The operator pause is consulted before every source.** `JobControlService`
 *    is the one state `POST /admin/operations/jobs/epg-refresh/pause` writes; a
 *    round that is paused half-way (or paused while the scheduler was still
 *    waiting on a fetch) stops before the next source, not after the whole list.
 *    A paused round fetches nothing and writes no run row.
 * 2. **Bounded retries.** A source past `MAX_ATTEMPTS` consecutive failures is
 *    left alone for this round so its exponential back-off drives the next
 *    attempt instead of a tight retry loop.
 *
 * The job still reports as registered when `JOBS_ENABLED` is off (it is scheduled,
 * it simply does not fetch): announcing it as paused would be a different claim.
 */
import type { DatabaseHandle } from '../infrastructure/mongo.js';
import { COLLECTIONS } from '../infrastructure/mongo.js';
import type { EpgSourceDoc } from '../infrastructure/schema.js';
import type { EgressOptions } from '../infrastructure/egress.js';
import type { Logger } from '../infrastructure/logging.js';
import { MAX_ATTEMPTS, planRuns, shouldRetry } from '../modules/epg/epg.sync.js';
import type { IngestionPort, SyncRunsPort } from '../modules/epg/epg.ingestion.js';

/** The name the operator pauses and the operations view reports. */
export const EPG_REFRESH_JOB = 'epg-refresh';

/** What the round needs; injected so a test never contacts anything. */
export interface EpgRefreshDeps {
  readonly database: Pick<DatabaseHandle, 'collection'>;
  /** The ingestion service, narrowed to the one operation this job calls. */
  readonly ingestion: IngestionPort & { readonly syncRuns: SyncRunsPort };
  /** One reader of the operator pause, shared with the admin route. */
  readonly control: { mayRun(name: string): Promise<boolean> };
  readonly egress: EgressOptions;
  readonly logger?: Pick<Logger, 'info'>;
}

export interface EpgRefreshOutcome {
  /** Sources due at planning time. */
  readonly planned: number;
  /** Sources the back-off kept out of this round. */
  readonly skipped: number;
  /** Sources actually run (each wrote one `epg_sync_runs` row). */
  readonly ran: number;
  readonly succeeded: number;
  readonly failed: number;
  /** True when the round stopped because the operator paused the job. */
  readonly paused: boolean;
}

/**
 * Runs one round. Stops before any source as soon as the pause is set, and
 * re-asks before each source so a pause takes effect mid-round.
 */
export async function runEpgRefreshRound(
  deps: EpgRefreshDeps,
  now: Date = new Date(),
): Promise<EpgRefreshOutcome> {
  const outcome = { planned: 0, skipped: 0, ran: 0, succeeded: 0, failed: 0, paused: false };

  /* The pause is the first thing consulted: a paused round reads no source. */
  if (!(await deps.control.mayRun(EPG_REFRESH_JOB))) {
    return { ...outcome, paused: true };
  }

  const sources = await deps.database.collection<EpgSourceDoc>(COLLECTIONS.epgSources).find({}).toArray();
  const planned = planRuns(sources, now);
  const byId = new Map(sources.map((source) => [source._id, source]));
  outcome.planned = planned.length;

  for (const entry of planned) {
    const source = byId.get(entry.sourceId);
    /*
     * Back-off: a source past the retry cap keeps its streak and waits for its
     * next due time, so the round never becomes a tight retry loop.
     */
    if (source !== undefined && (source.consecutiveFailures ?? 0) >= MAX_ATTEMPTS) {
      outcome.skipped += 1;
      continue;
    }
    if (source !== undefined && !shouldRetry(source)) {
      outcome.skipped += 1;
      continue;
    }
    /* Re-read the operator pause before each source: a pause is a real stop. */
    if (!(await deps.control.mayRun(EPG_REFRESH_JOB))) {
      return { ...outcome, paused: true };
    }
    const result = await deps.ingestion.runSource(entry.sourceId, deps.egress, 'scheduled', {
      trigger: 'scheduled',
    });
    outcome.ran += 1;
    if (result.status === 'ok') outcome.succeeded += 1;
    else outcome.failed += 1;
    deps.logger?.info(
      { sourceId: entry.sourceId, name: entry.name, status: result.status, runId: result.runId },
      'epg source refreshed',
    );
  }
  return outcome;
}

/** The scheduler's entry point for `epg-refresh`. */
export function createEpgRefreshJob(deps: EpgRefreshDeps): { name: string; run: () => Promise<void> } {
  return {
    name: EPG_REFRESH_JOB,
    run: async () => {
      const outcome = await runEpgRefreshRound(deps);
      if (outcome.paused) {
        deps.logger?.info({ job: EPG_REFRESH_JOB }, 'job paused by operator, nothing fetched');
      }
    },
  };
}
