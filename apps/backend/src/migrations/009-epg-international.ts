/**
 * Migration `009-epg-international` — the EPG subsystem's own indexes and the
 * `epg_sync_runs` collection (TDT-API-02FG).
 *
 * Everything it adds is additive: fields appear as optional properties on
 * documents that already exist, indexes are new names, and no document is
 * rewritten or removed. Running it twice is a no-op (index creation is
 * idempotent by name), which is what the runner relies on after a crash between
 * `run` and the ledger write.
 *
 * The `down` really reverts: it drops the indexes this migration created and the
 * runs collection, and unsets the optional fields it introduced. Programmes,
 * channels, sources and mappings themselves are never deleted.
 */
import type { DatabaseHandle } from '../infrastructure/mongo.js';
import { COLLECTIONS } from '../infrastructure/mongo.js';
import { createCatalogueIndexes, dropCatalogueIndexes } from '../catalogue/schema.js';
import type { Migration } from './types.js';

/** Indexes this migration owns; `down` drops exactly these names. */
export const EPG_PROGRAMME_INDEXES = [
  { key: { channelId: 1, start: 1, end: 1 }, name: 'channel_window' },
  { key: { duplicateOf: 1 }, name: 'duplicate_of' },
] as const;

export const EPG_SOURCE_INDEXES = [{ key: { nextRunAt: 1 }, name: 'next_run_queue' }] as const;

export const EPG_SYNC_RUN_INDEXES = [
  { key: { sourceId: 1, startedAt: -1 }, name: 'source_recent' },
  { key: { status: 1, startedAt: -1 }, name: 'status_started' },
] as const;

/** Optional programme fields the subsystem introduced. */
const PROGRAMME_FIELDS = ['originalStart', 'timezone', 'duplicateOf', 'stale'] as const;

/** Optional source fields the subsystem introduced. */
const SOURCE_FIELDS = [
  'country',
  'language',
  'timezone',
  'fetchIntervalMinutes',
  'lastSuccessAt',
  'consecutiveFailures',
  'nextRunAt',
  'httpEtag',
  'httpLastModified',
] as const;

export async function migrateEpgInternational(database: DatabaseHandle): Promise<void> {
  const db = database.db;
  await createCatalogueIndexes(db, COLLECTIONS.programmes, EPG_PROGRAMME_INDEXES);
  await createCatalogueIndexes(db, COLLECTIONS.epgSources, EPG_SOURCE_INDEXES);
  // Creating the collection explicitly matters: the indexes must exist before
  // the first run, so the operations view is never the first writer.
  await db.createCollection<EpgSyncRunLike>(COLLECTIONS.epgSyncRuns).catch((error: unknown) => {
    const code = (error as { code?: number } | null)?.code;
    const codeName = (error as { codeName?: string } | null)?.codeName;
    if (code === 48 || codeName === 'NamespaceExists') return;
    throw error;
  });
  await createCatalogueIndexes(db, COLLECTIONS.epgSyncRuns, EPG_SYNC_RUN_INDEXES);
}

interface EpgSyncRunLike {
  _id: string;
}

export async function rollbackEpgInternational(database: DatabaseHandle): Promise<void> {
  const db = database.db;
  await dropCatalogueIndexes(
    db,
    COLLECTIONS.programmes,
    EPG_PROGRAMME_INDEXES.map((index) => index.name),
  );
  await dropCatalogueIndexes(
    db,
    COLLECTIONS.epgSources,
    EPG_SOURCE_INDEXES.map((index) => index.name),
  );
  await db.collection(COLLECTIONS.epgSyncRuns).drop().catch((error: unknown) => {
    const codeName = (error as { codeName?: string } | null)?.codeName;
    if (codeName === 'NamespaceNotFound') return;
    throw error;
  });
  // Remove only the fields this migration introduced; every other field stays.
  await db.collection(COLLECTIONS.programmes).updateMany(
    {},
    { $unset: Object.fromEntries(PROGRAMME_FIELDS.map((field) => [field, ''])) },
  );
  await db.collection(COLLECTIONS.epgSources).updateMany(
    {},
    { $unset: Object.fromEntries(SOURCE_FIELDS.map((field) => [field, ''])) },
  );
}

export function buildEpgInternationalMigration(database: DatabaseHandle): Migration {
  return {
    name: '009-epg-international',
    description:
      'Add the EPG window/duplicate indexes, the per-source next-run index and epg_sync_runs so coverage, dedup and synchronisation runs are queryable.',
    run: () => migrateEpgInternational(database),
    rollback: () => rollbackEpgInternational(database),
  };
}
