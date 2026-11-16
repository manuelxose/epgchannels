/**
 * Migration `006-incremental-dedup` — creates the identity-support indexes that
 * make incremental ingestion deduplicate deterministically: aliases, variants,
 * authorisation, health, EPG mappings, the reconciliation review queue and the
 * ingestion-run ledger.
 *
 * Alias contention fix: a `tvg-id` may belong to several channels, so the
 * pre-fix unique `{namespace, value}` alias index is dropped first and replaced
 * with a unique `{namespace, value, channelId}` plus a non-unique
 * `{namespace, value}` lookup index. A fresh database and an existing one
 * therefore converge to the same index set. The rollback drops only the indexes
 * this migration created (it never recreates the old unique index, which would
 * fail on data that already shares a tvg-id).
 */
import type { DatabaseHandle } from '../infrastructure/mongo.js';
import { COLLECTIONS } from '../infrastructure/mongo.js';
import {
  DEDUP_INDEXES,
  LEGACY_ALIAS_UNIQUE_INDEX,
  createCatalogueIndexes,
  dropCatalogueIndexes,
} from '../catalogue/schema.js';
import type { Migration } from './types.js';

export async function migrateIncrementalDedup(database: DatabaseHandle): Promise<void> {
  // Replace the pre-fix alias unique index first so an existing database and a
  // fresh one end with the identical index set.
  await dropCatalogueIndexes(database.db, COLLECTIONS.channelAliases, [LEGACY_ALIAS_UNIQUE_INDEX]);
  for (const [collection, indexes] of Object.entries(DEDUP_INDEXES)) {
    await createCatalogueIndexes(database.db, collection, indexes);
  }
}

export async function rollbackIncrementalDedup(database: DatabaseHandle): Promise<void> {
  for (const [collection, indexes] of Object.entries(DEDUP_INDEXES)) {
    await dropCatalogueIndexes(
      database.db,
      collection,
      indexes.map((index) => index.name),
    );
  }
}

export function buildIncrementalDedupMigration(database: DatabaseHandle): Migration {
  return {
    name: '006-incremental-dedup',
    description: 'Create alias/variant/authorisation/health/epg/review/run indexes.',
    run: () => migrateIncrementalDedup(database),
    rollback: () => rollbackIncrementalDedup(database),
  };
}
