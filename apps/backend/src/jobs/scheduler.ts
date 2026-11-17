/**
 * Idempotent background jobs.
 *
 * Each run is recorded in `job_runs`. A job that is already running is skipped,
 * and a failure is recorded rather than thrown, so one bad feed never stops the
 * schedule. Jobs are disabled unless `JOBS_ENABLED` is set.
 */
import type { Config } from '../config/config.js';
import type { AppContext } from '../server/context.js';
import { COLLECTIONS } from '../infrastructure/mongo.js';
import type { JobRunDoc, PlaybackSourceDoc } from '../infrastructure/schema.js';
import { runResolutionJob } from './youtube-resolution.js';
import { clearScheduledJobs, registerScheduledJobs } from './job-control.js';

type Job = { readonly name: string; readonly run: () => Promise<void> };

let timers: NodeJS.Timeout[] = [];
const running = new Set<string>();

export function startJobs(config: Config, context: AppContext): void {
  const epgJob: Job = {
    name: 'epg-refresh',
    run: async () => {
      const results = await context.epgIngestion.runAll(context.egressOptions);
      context.logger.info({ sources: results.length, results }, 'epg refresh finished');
    },
  };

  const verifyJob: Job = {
    name: 'source-verification',
    run: async () => {
      /*
       * TDT-API-02D: one round of the layered verification engine.
       *
       * The round itself enforces every bound that matters to a third party (the
       * global and per-host concurrency limits, the retry cap, the circuit
       * breakers) and refuses sources whose aggregate health is paused. This job
       * contributes the schedule and the `job_runs` bookkeeping and nothing else.
       *
       * Gated by `VERIFY_ENABLED`: an operator turns this on deliberately, because
       * it makes the platform contact third-party origins on a timer. A disabled
       * round returns before any planning, so it cannot touch Mongo or the network.
       */
      if (!config.VERIFY_ENABLED) {
        context.logger.debug({ job: 'source-verification' }, 'verification disabled (VERIFY_ENABLED=false)');
        return;
      }
      const counts = await context.verification.scheduler.runRound(new Date());
      context.logger.info(
        {
          planned: counts.planned,
          deferred: counts.deferred,
          paused: counts.paused,
          healthy: counts.healthy,
          degraded: counts.degraded,
          failed: counts.failed,
          retries: counts.retries,
          egressRequests: counts.egressRequests,
          wallMs: counts.wallMs,
          peakInFlight: counts.peakInFlight,
        },
        'source verification round finished',
      );
    },
  };

  const youtubeJob: Job = {
    name: 'youtube-resolution',
    run: async () => {
      /*
       * Bounded on purpose: one run resolves at most `YOUTUBE_RESOLVE_BATCH`
       * channels, oldest check first. The API never contacts YouTube, so this
       * rate is the only thing that sets the external request volume.
       */
      const result = await runResolutionJob(context.database, { limit: config.YOUTUBE_RESOLVE_BATCH });
      context.logger.info(result, 'youtube resolution finished');
    },
  };

  const run = async (job: Job): Promise<void> => {
    if (running.has(job.name)) {
      context.logger.warn({ job: job.name }, 'job already running, skipping');
      return;
    }
    /*
     * TDT-API-02FG: the operator pause is honoured HERE, before anything else and
     * on every path (timer tick and HTTP trigger), because this is the only place
     * a job actually starts. A paused job writes no `job_runs` row and contacts
     * nobody; the pause is a real stop, not a flag on a dashboard.
     */
    if (!(await context.jobControl.mayRun(job.name))) {
      context.logger.info({ job: job.name }, 'job paused by operator, skipping');
      return;
    }
    running.add(job.name);
    const startedAt = new Date();
    try {
      await job.run();
      await context.database.collection<JobRunDoc>(COLLECTIONS.jobRuns).insertOne({
        _id: `${job.name}:${startedAt.toISOString()}`,
        job: job.name,
        status: 'ok',
        startedAt,
        finishedAt: new Date(),
        message: null,
        details: {},
      });
    } catch (error) {
      await context.database.collection<JobRunDoc>(COLLECTIONS.jobRuns).insertOne({
        _id: `${job.name}:${startedAt.toISOString()}`,
        job: job.name,
        status: 'failed',
        startedAt,
        finishedAt: new Date(),
        message: error instanceof Error ? error.message : String(error),
        details: {},
      });
      context.logger.error({ job: job.name, err: error }, 'job failed');
    } finally {
      running.delete(job.name);
    }
  };

  const epgTimer = setInterval(() => void run(epgJob), config.EPG_REFRESH_INTERVAL_MINUTES * 60_000);
  const verifyTimer = setInterval(() => void run(verifyJob), config.SOURCE_VERIFY_INTERVAL_MINUTES * 60_000);
  const youtubeTimer = setInterval(() => void run(youtubeJob), config.YOUTUBE_RESOLVE_INTERVAL_MINUTES * 60_000);
  epgTimer.unref();
  verifyTimer.unref();
  youtubeTimer.unref();
  /*
   * One run shortly after boot: a freshly deployed instance should not make the
   * first visitors wait until the next interval for their channels to resolve.
   */
  const youtubeBoot = setTimeout(() => void run(youtubeJob), 15_000);
  youtubeBoot.unref();
  timers = [epgTimer, verifyTimer, youtubeTimer, youtubeBoot];
  /*
   * Publish what this process actually scheduled, so the operations endpoint can
   * report the real jobs (and refuse to pause a name it does not run) instead of
   * keeping a second, drifting list of names.
   *
   * `source-verification` is reported as disabled when `VERIFY_ENABLED` is off:
   * its timer fires but every run returns without contacting anyone, and saying so
   * is the honest state.
   */
  registerScheduledJobs([
    { name: epgJob.name, intervalMinutes: config.EPG_REFRESH_INTERVAL_MINUTES, enabled: true },
    {
      name: verifyJob.name,
      intervalMinutes: config.SOURCE_VERIFY_INTERVAL_MINUTES,
      enabled: config.VERIFY_ENABLED,
    },
    { name: youtubeJob.name, intervalMinutes: config.YOUTUBE_RESOLVE_INTERVAL_MINUTES, enabled: true },
  ]);
  context.logger.info(
    {
      epgMinutes: config.EPG_REFRESH_INTERVAL_MINUTES,
      verifyMinutes: config.SOURCE_VERIFY_INTERVAL_MINUTES,
      youtubeMinutes: config.YOUTUBE_RESOLVE_INTERVAL_MINUTES,
      youtubeBatch: config.YOUTUBE_RESOLVE_BATCH,
    },
    'jobs scheduled',
  );
}

export function stopJobs(): void {
  for (const timer of timers) {
    clearInterval(timer);
  }
  timers = [];
  // A stopped scheduler runs nothing, so nothing is pausable by name.
  clearScheduledJobs();
}
