/**
 * Service wiring: builds every service once from the configuration.
 * `createApp` and the CLI scripts share this factory so they cannot diverge.
 */
import type { Config } from '../config/config.js';
import { connectCache } from '../infrastructure/cache.js';
import { connectDatabase } from '../infrastructure/mongo.js';
import { createLogger } from '../infrastructure/logging.js';
import { AdminAuthService } from '../modules/admin/admin-auth.service.js';
import { EditorialService } from '../modules/admin/editorial.service.js';
import { SourcesService } from '../modules/admin/sources.service.js';
import { ChannelsService } from '../modules/channels/channels.service.js';
import { EpgIngestionService } from '../modules/epg/epg.ingestion.js';
import { EpgService } from '../modules/epg/epg.service.js';
import { PlaybackService } from '../modules/playback/playback.service.js';
import { createVerificationRuntime } from '../verification/runtime.js';
import { JobControlService } from '../jobs/job-control.js';
import { Metrics } from './middleware.js';
import { playbackCounters } from '../modules/admin/admin-metrics.js';
import { COLLECTIONS } from '../infrastructure/mongo.js';
import type { PlaybackSourceDoc } from '../infrastructure/schema.js';
import type { AppContext } from './context.js';

export async function createContext(config: Config): Promise<AppContext> {
  const logger = createLogger(config);
  const database = await connectDatabase(config.MONGODB_URI, config.MONGODB_DB);
  const cache = await connectCache(config.REDIS_URL);
  /*
   * The registry metrics are written to. `createApp` builds its own registry for
   * `/metrics` (it is created before the context exists), so playback counts into
   * the context's instance; both are per-process registries and neither is
   * shared across instances.
   */
  const metrics = new Metrics();
  const playback = new PlaybackService(database, playbackCounters(metrics));
  const epg = new EpgService(database);
  const editorial = new EditorialService(database);
  const context: AppContext = {
    version: '1.0.0',
    database,
    cache,
    logger,
    channels: new ChannelsService(database),
    playback,
    epg,
    epgIngestion: new EpgIngestionService(database, epg),
    editorial,
    sources: new SourcesService(database, editorial),
    adminAuth: new AdminAuthService(database, config.ADMIN_BOOTSTRAP_TOKEN),
    /*
     * Built from the SAME `editorial` instance the routes use, so a pause and the
     * audit entry that records it cannot diverge.
     */
    jobControl: new JobControlService(database, editorial),
    metrics,
    egressOptions: {
      blockedHosts: config.EGRESS_GUARD_ENABLED ? config.BLOCKED_EGRESS_HOSTS : config.BLOCKED_EGRESS_HOSTS,
      timeoutMs: config.EGRESS_TIMEOUT_MS,
    },
    serviceKeyEnabled: config.SERVICE_API_KEY_SHA256 !== undefined,
    verification: createVerificationRuntime({
      database,
      logger,
      config,
      // The 02C gate's recorded decision, read through the service that owns it.
      authorizationsFor: (sources) => playback.authorizationsFor(sources),
      findSource: (sourceId) =>
        database.collection<PlaybackSourceDoc>(COLLECTIONS.sources).findOne({ _id: sourceId }),
    }),
  };
  return context;
}
