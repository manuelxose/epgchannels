/**
 * MongoDB client owner.
 *
 * The database is the platform's source of truth, so the connection is opened
 * only when it can be proven: the pool is pinged before the server starts
 * listening. Collections are addressed through the `collections` map so a typo
 * is a type error, not a missing collection.
 */
import { MongoClient, type Db, type Collection } from 'mongodb';

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
