/**
 * Application context: the services one server instance exposes to its routes.
 * Constructed once at boot, so a route cannot create a second Mongo client.
 */
import type { CacheStore } from '../infrastructure/cache.js';
import type { EgressOptions } from '../infrastructure/egress.js';
import type { DatabaseHandle } from '../infrastructure/mongo.js';
import type { Logger } from '../infrastructure/logging.js';
import type { AdminAuthService } from '../modules/admin/admin-auth.service.js';
import type { EditorialService } from '../modules/admin/editorial.service.js';
import type { SourcesService } from '../modules/admin/sources.service.js';
import type { ChannelsService } from '../modules/channels/channels.service.js';
import type { EpgIngestionService } from '../modules/epg/epg.ingestion.js';
import type { EpgService } from '../modules/epg/epg.service.js';
import type { PlaybackService } from '../modules/playback/playback.service.js';
import type { VerificationRuntime } from '../verification/runtime.js';

export interface AppContext {
  readonly version: string;
  readonly database: DatabaseHandle;
  readonly cache: CacheStore;
  readonly logger: Logger;
  readonly channels: ChannelsService;
  readonly playback: PlaybackService;
  readonly epg: EpgService;
  readonly epgIngestion: EpgIngestionService;
  readonly editorial: EditorialService;
  readonly sources: SourcesService;
  readonly adminAuth: AdminAuthService;
  readonly egressOptions: EgressOptions;
  readonly serviceKeyEnabled: boolean;
  /*
   * TDT-API-02D verification. One object, constructed once in bootstrap.ts by
   * `createVerificationRuntime`, so the scheduler, queue, controls and metrics
   * of a process are necessarily the same instances a route sees.
   */
  readonly verification: VerificationRuntime;
}
