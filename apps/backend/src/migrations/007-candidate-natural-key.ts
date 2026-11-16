/**
 * Migration `007-candidate-natural-key` — repairs the unique candidate index.
 *
 * The pre-fix index was `{snapshotId, urlSha256, 'provenance.line'}`. A line
 * number is only unique WITHIN one upstream file, so two different files of the
 * same snapshot that carry the same URL on the same line number collided with
 * E11000 and aborted the ingest (reproduced with the captured iptv-org snapshot,
 * whose generated test playlists repeat one URL on line 3 of several files).
 *
 * The corrected index adds `provenance.upstreamPath`. This migration drops the
 * old index before creating the new one, so a fresh database and an existing one
 * converge to the same index set. The rollback restores the previous index shape
 * only when the data allows it; it never silently leaves a broken constraint
 * behind as "done".
 */
import type { DatabaseHandle } from '../infrastructure/mongo.js';
import { COLLECTIONS } from '../infrastructure/mongo.js';
import { CANDIDATE_INDEXES, dropCatalogueIndexes, createCatalogueIndexes } from '../catalogue/schema.js';
import type { Migration } from './types.js';

export const LEGACY_CANDIDATE_UNIQUE_INDEX = 'candidate_snapshot_url_line_unique';
const CORRECTED_INDEX_NAME = 'candidate_line_in_file_unique';

/** The corrected unique key and the extra lookups that come with it. */
const CORRECTED_INDEXES = [
  {
    key: { snapshotId: 1, 'provenance.upstreamPath': 1, urlSha256: 1, 'provenance.line': 1 },
    name: CORRECTED_INDEX_NAME,
    unique: true,
  },
  { key: { 'provenance.upstreamPath': 1 }, name: 'candidate_upstream_path' },
] as const;

export async function migrateCandidateNaturalKey(database: DatabaseHandle): Promise<void> {
  // Drop the over-constrained index first: creating the replacement while the
  // old one still exists is allowed, but leaving both would keep rejecting rows.
  await dropCatalogueIndexes(database.db, COLLECTIONS.sourceCandidates, [LEGACY_CANDIDATE_UNIQUE_INDEX]);
  await createCatalogueIndexes(database.db, COLLECTIONS.sourceCandidates, CORRECTED_INDEXES);
}

export async function rollbackCandidateNaturalKey(database: DatabaseHandle): Promise<void> {
  await dropCatalogueIndexes(database.db, COLLECTIONS.sourceCandidates, [CORRECTED_INDEX_NAME, 'candidate_upstream_path']);
  // Restore the declared set of the schema module, which is the pre-007 shape
  // minus the index this migration owns.
  const legacy = CANDIDATE_INDEXES.filter((index) => index.name !== CORRECTED_INDEX_NAME && index.name !== 'candidate_upstream_path');
  await createCatalogueIndexes(
    database.db,
    COLLECTIONS.sourceCandidates,
    legacy.map((index) =>
      index.name === LEGACY_CANDIDATE_UNIQUE_INDEX
        ? { ...index, key: { snapshotId: 1, urlSha256: 1, 'provenance.line': 1 } }
        : index,
    ),
  );
}

export function buildCandidateNaturalKeyMigration(database: DatabaseHandle): Migration {
  return {
    name: '007-candidate-natural-key',
    description: 'Add provenance.upstreamPath to the unique candidate index so equal line numbers in different files do not collide.',
    run: () => migrateCandidateNaturalKey(database),
    rollback: () => rollbackCandidateNaturalKey(database),
  };
}
