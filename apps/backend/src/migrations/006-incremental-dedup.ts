/**
 * Migration `006-incremental-dedup` — creates the identity-support indexes that
 * make incremental ingestion deduplicate deterministically: aliases, variants,
 * authorisation, health, EPG mappings, the reconciliation review queue and the
 * ingestion-run ledger.
 *
 * Like 005 these collections start empty, so the reversible surface is exactly
 * the indexes. The unique keys (`namespace+value`, `channelId+variantKey`,
 * `candidateId`, `channelId+namespace+externalId`) are the dedup guards; the
 * non-unique keys are the read paths for review and health work.
 */
import type { DatabaseHandle } from '../infrastructure/mongo.js';
import { DEDUP_INDEXES, createCatalogueIndexes, dropCatalogueIndexes } from '../catalogue/schema.js';
import type { Migration } from './types.js';

export async function migrateIncrementalDedup(database: DatabaseHandle): Promise<void> {
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
