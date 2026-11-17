/**
 * Migration runner.
 *
 * `migrate` applies every migration not yet in the ledger, in order, and
 * records each one. `migrationStatus` reports what is pending without changing
 * anything. `rollbackMigration` rolls one applied migration back and records the
 * rollback in the ledger — it never rolls back silently and never rolls back a
 * migration that has no `rollback` function or that is not applied.
 */
import type { Filter } from 'mongodb';
import type { DatabaseHandle } from '../infrastructure/mongo.js';
import { ensureIndexes } from '../infrastructure/schema.js';
import { COLLECTIONS } from '../infrastructure/mongo.js';
import { LEDGER_COLLECTION, type Migration } from './types.js';
import type { EpgSourceDoc } from '../infrastructure/schema.js';
import { EPG_SOURCE_SEED } from '../scripts/seed-data.js';
import { buildCatalogueIdentityMigration } from './004-catalogue-identity.js';
import { buildSourceSnapshotProvenanceMigration } from './005-source-snapshot-provenance.js';
import { buildIncrementalDedupMigration } from './006-incremental-dedup.js';
import { buildCandidateNaturalKeyMigration } from './007-candidate-natural-key.js';
import { buildVerificationIndexesMigration } from './008-verification-indexes.js';
import { buildEpgInternationalMigration } from './009-epg-international.js';

interface LedgerEntry {
  _id: string;
  name: string;
  kind?: 'applied' | 'rolled-back';
  description: string;
  appliedAt: Date | null;
  rolledBackAt: Date | null;
}

export interface RollbackResult {
  readonly name: string;
  readonly recorded: string;
}

/** Legacy ledger entries predate `kind`; they are applied entries. */
function appliedFilter(name: string): Filter<LedgerEntry> {
  return {
    name,
    $or: [{ kind: 'applied' }, { kind: { $exists: false } }],
  };
}

export function buildMigrations(database: DatabaseHandle): Migration[] {
  return [
    {
      name: '001-indexes',
      description: 'Create every index the queried collections need (idempotent).',
      run: () => ensureIndexes(database.db),
    },
    {
      name: '002-epg-editorial-source',
      description: 'Register the editorial guide source so manual programmes have provenance.',
      run: async () => {
        const now = new Date();
        await database.db.collection<EpgSourceDoc>(COLLECTIONS.epgSources).updateOne(
          { _id: EPG_SOURCE_SEED.id },
          {
            $setOnInsert: {
              _id: EPG_SOURCE_SEED.id,
              name: EPG_SOURCE_SEED.name,
              kind: EPG_SOURCE_SEED.kind,
              url: null,
              licence: EPG_SOURCE_SEED.licence,
              attribution: EPG_SOURCE_SEED.attribution,
              ingestionEnabled: false,
              status: 'published',
              lastRunAt: null,
              lastRunStatus: 'never',
              lastRunProgrammes: 0,
              createdAt: now,
              updatedAt: now,
            },
          },
          { upsert: true },
        );
      },
    },
    buildCatalogueIdentityMigration(database),
    buildSourceSnapshotProvenanceMigration(database),
    buildIncrementalDedupMigration(database),
    buildCandidateNaturalKeyMigration(database),
    buildVerificationIndexesMigration(database),
    buildEpgInternationalMigration(database),
  ];
}

export async function migrate(database: DatabaseHandle): Promise<{ applied: string[]; already: string[] }> {
  const ledger = database.db.collection<LedgerEntry>(LEDGER_COLLECTION);
  const migrations = buildMigrations(database);
  const applied: string[] = [];
  const already: string[] = [];
  for (const migration of migrations) {
    const existing = await ledger.findOne(appliedFilter(migration.name));
    if (existing) {
      already.push(migration.name);
      continue;
    }
    await migration.run();
    await ledger.insertOne({
      _id: migration.name,
      name: migration.name,
      kind: 'applied',
      description: migration.description,
      appliedAt: new Date(),
      rolledBackAt: null,
    });
    applied.push(migration.name);
  }
  return { applied, already };
}

/**
 * Rolls an applied migration back and records the rollback. Throws when the
 * migration is unknown, has no rollback, or is not currently applied — a
 * rollback is never silent and never partial.
 */
export async function rollbackMigration(database: DatabaseHandle, name: string): Promise<RollbackResult> {
  const migration = buildMigrations(database).find((candidate) => candidate.name === name);
  if (!migration) {
    throw new Error(`Unknown migration "${name}": cannot roll back.`);
  }
  if (!migration.rollback) {
    throw new Error(`Migration "${name}" has no rollback function; refusing to roll it back.`);
  }
  const ledger = database.db.collection<LedgerEntry>(LEDGER_COLLECTION);
  const applied = await ledger.findOne(appliedFilter(name));
  if (!applied) {
    throw new Error(`Migration "${name}" is not applied; nothing to roll back.`);
  }
  await migration.rollback();
  const rolledBackAt = new Date();
  const recordId = `${name}:rollback:${rolledBackAt.toISOString()}`;
  await ledger.deleteOne({ _id: name });
  await ledger.insertOne({
    _id: recordId,
    name,
    kind: 'rolled-back',
    description: migration.description,
    appliedAt: null,
    rolledBackAt,
  });
  return { name, recorded: recordId };
}

export async function migrationStatus(database: DatabaseHandle): Promise<{
  pending: string[];
  applied: string[];
}> {
  const ledger = database.db.collection<LedgerEntry>(LEDGER_COLLECTION);
  const rows = await ledger.find({}).toArray();
  const appliedNames = rows
    .filter((row) => row.kind === undefined || row.kind === 'applied')
    .map((row) => row.name);
  const all = buildMigrations(database).map((migration) => migration.name);
  return { pending: all.filter((name) => !appliedNames.includes(name)), applied: appliedNames };
}
