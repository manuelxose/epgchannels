/**
 * Migration `008-verification-indexes` — the indexes the 02D scheduler queries by.
 *
 * Three collections, and each index exists because one query would otherwise be
 * a collection scan on every scheduler tick:
 *
 * | collection                    | index                                   | query it serves |
 * | ----------------------------- | --------------------------------------- | --------------- |
 * | `source_health_02d`           | `{nextCheckAt: 1, status: 1}`           | "which sources are due now, minus paused" (§4) |
 * | `source_health_checks_02d`    | `{state: 1, 'lease.expiresAt': 1}`      | lease reaper on boot (§6) |
 * | `source_health_checks_02d`    | `{sourceId: 1, createdAt: -1}`          | history of one source / crash reconcile |
 * | `verification_policies_02d`   | `{scope: 1}`                            | global + per-provider kill switches (§5) |
 *
 * `ensureHealthIndexes` (owned by the health ledger, t2) creates the first three;
 * this migration adds the policy index and records the whole set in the ledger so
 * a fresh database and an existing one converge to the same shape. It is
 * idempotent: `createIndexes` with an explicit name is a no-op when it exists.
 *
 * The rollback drops exactly the indexes this migration owns and nothing else.
 */
import type { DatabaseHandle } from '../infrastructure/mongo.js';
import { COLLECTIONS } from '../infrastructure/mongo.js';
import { ensureHealthIndexes } from '../verification/health.repository.js';
import type { Migration } from './types.js';

/** The policy index: one row per scope (`global`, `provider:<id>`, …). */
const POLICY_INDEX = { key: { scope: 1 } as const, name: 'verification_policy_scope' };

export async function migrateVerificationIndexes(database: DatabaseHandle): Promise<void> {
  // The ledger's own indexes (checks by lease, health by due instant).
  await ensureHealthIndexes(database);
  await database.db
    .collection(COLLECTIONS.verificationPolicies)
    .createIndex(POLICY_INDEX.key, { name: POLICY_INDEX.name });
}

export async function rollbackVerificationIndexes(database: DatabaseHandle): Promise<void> {
  // Drop only what this migration owns. The ledger's indexes are dropped too,
  // because before this migration the collections carried no declared indexes;
  // a rollback that left them behind would not restore the previous shape.
  const policies = database.db.collection(COLLECTIONS.verificationPolicies);
  await policies.dropIndex(POLICY_INDEX.name).catch(() => undefined);
  const checks = database.db.collection(COLLECTIONS.sourceHealthChecks);
  const health = database.db.collection(COLLECTIONS.sourceHealthAggregate);
  for (const [collection, names] of [
    [checks, ['source_recent', 'lease_reaper']],
    [health, ['due_queue']],
  ] as const) {
    for (const name of names) {
      await collection.dropIndex(name).catch(() => undefined);
    }
  }
}

export function buildVerificationIndexesMigration(database: DatabaseHandle): Migration {
  return {
    name: '008-verification-indexes',
    description: 'Create the source_health_02d due-queue, the lease reaper and the verification policy scope indexes.',
    run: () => migrateVerificationIndexes(database),
    rollback: () => rollbackVerificationIndexes(database),
  };
}
