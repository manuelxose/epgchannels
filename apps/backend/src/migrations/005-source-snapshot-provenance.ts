/**
 * Migration `005-source-snapshot-provenance` — creates the indexes for the
 * source snapshots and source candidates collections.
 *
 * These collections start empty (ingestion is new), so this migration has no
 * data backfill; its reversible surface is exactly the indexes it creates. The
 * snapshot identity index (`upstream + commitSha + checksumSha256`) and the
 * candidate key (`snapshotId + urlSha256 + provenance.line`) are what make a
 * re-ingest of the same snapshot deduplicate instead of duplicating.
 */
import type { DatabaseHandle } from '../infrastructure/mongo.js';
import { COLLECTIONS } from '../infrastructure/mongo.js';
import {
  CANDIDATE_INDEXES,
  SNAPSHOT_INDEXES,
  createCatalogueIndexes,
  dropCatalogueIndexes,
} from '../catalogue/schema.js';
import type { Migration } from './types.js';

const SNAPSHOT_INDEX_NAMES = SNAPSHOT_INDEXES.map((index) => index.name);
const CANDIDATE_INDEX_NAMES = CANDIDATE_INDEXES.map((index) => index.name);

export async function migrateSourceSnapshotProvenance(database: DatabaseHandle): Promise<void> {
  await createCatalogueIndexes(database.db, COLLECTIONS.sourceSnapshots, SNAPSHOT_INDEXES);
  await createCatalogueIndexes(database.db, COLLECTIONS.sourceCandidates, CANDIDATE_INDEXES);
}

export async function rollbackSourceSnapshotProvenance(database: DatabaseHandle): Promise<void> {
  await dropCatalogueIndexes(database.db, COLLECTIONS.sourceSnapshots, SNAPSHOT_INDEX_NAMES);
  await dropCatalogueIndexes(database.db, COLLECTIONS.sourceCandidates, CANDIDATE_INDEX_NAMES);
}

export function buildSourceSnapshotProvenanceMigration(database: DatabaseHandle): Migration {
  return {
    name: '005-source-snapshot-provenance',
    description: 'Create snapshot and candidate indexes (unique snapshot provenance).',
    run: () => migrateSourceSnapshotProvenance(database),
    rollback: () => rollbackSourceSnapshotProvenance(database),
  };
}
