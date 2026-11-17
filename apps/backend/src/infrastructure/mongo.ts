/**
 * MongoDB client owner.
 *
 * The database is the platform's source of truth, so the connection is opened
 * only when it can be proven: the pool is pinged before the server starts
 * listening. Collections are addressed through the `collections` map so a typo
 * is a type error, not a missing collection.
 */
import { MongoClient, type Db, type Collection } from 'mongodb';
import { HEALTH_COLLECTIONS } from '../verification/health.schema.js';

export const COLLECTIONS = {
  channels: 'channels',
  sources: 'playback_sources',
  programmes: 'programmes',
  epgSources: 'epg_sources',
  channelEpgMap: 'channel_epg_map',
  audits: 'audit_log',
  admins: 'admin_users',
  adminSessions: 'admin_sessions',
  jobRuns: 'job_runs',
  integrityRefusals: 'integrity_refusals',
  migrationLedger: 'migration_ledger',
  youtubeChannels: 'youtube_channels',
  sourceSnapshots: 'source_snapshots',
  sourceCandidates: 'source_candidates',
  channelAliases: 'channel_aliases',
  channelVariants: 'channel_variants',
  sourceAuthorization: 'source_authorization',
  sourceHealth: 'source_health',
  epgMappings: 'epg_mappings',
  /** TDT-API-02FG: one row per synchronisation run of one guide source. */
  epgSyncRuns: 'epg_sync_runs',
  reconciliationReview: 'reconciliation_review',
  ingestionRuns: 'ingestion_runs',
  /*
   * TDT-API-02D verification. The names come from `HEALTH_COLLECTIONS` so the
   * declaration lives with the row shapes and cannot drift from them; the keys
   * here are what the rest of the application addresses them by.
   */
  sourceHealthChecks: HEALTH_COLLECTIONS.checks,
  sourceHealthAggregate: HEALTH_COLLECTIONS.health,
  verificationPolicies: HEALTH_COLLECTIONS.policies,
} as const;

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];

export interface DatabaseHandle {
  readonly client: MongoClient;
  readonly db: Db;
  /**
   * Typed collection. `_id` is always one of our own UUID strings, so document
   * types keep their natural shape instead of `ObjectId`.
   */
  collection<T extends { _id: string }>(name: CollectionName): Collection<T>;
  ping(): Promise<number>;
  close(): Promise<void>;
}

export async function connectDatabase(uri: string, dbName: string): Promise<DatabaseHandle> {
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 10_000,
    connectTimeoutMS: 10_000,
    retryWrites: true,
  });
  await client.connect();
  const db = client.db(dbName);
  const handle: DatabaseHandle = {
    client,
    db,
    collection<T extends { _id: string }>(name: CollectionName): Collection<T> {
      return db.collection<T>(name);
    },
    async ping(): Promise<number> {
      const started = performance.now();
      await db.command({ ping: 1 });
      return Math.round(performance.now() - started);
    },
    async close(): Promise<void> {
      await client.close();
    },
  };
  await handle.ping();
  return handle;
}
