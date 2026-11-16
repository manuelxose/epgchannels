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
      const sources = await context.database
        .collection<PlaybackSourceDoc>(COLLECTIONS.sources)
        .find({ editorialStatus: 'published', type: { $in: ['hls', 'dash'] } })
        .sort({ lastVerifiedAt: 1 })
        .limit(50)
        .toArray();
      let ok = 0;
      for (const source of sources) {
        try {
          const result = await context.playback.verifySource(source._id, {
            blockedHosts: context.egressOptions.blockedHosts,
            timeoutMs: context.egressOptions.timeoutMs,
          });
          if (result.status === 'ok') ok += 1;
        } catch {
          /* recorded by verifySource when the source exists */
        }
      }
      context.logger.info({ checked: sources.length, ok }, 'source verification finished');
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
}
