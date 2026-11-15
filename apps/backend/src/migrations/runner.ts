/**
 * Migration runner.
 *
 * `migrate` applies every migration not yet in the ledger, in order, and
 * records each one. `status` reports what is pending without changing anything.
 */
import type { DatabaseHandle } from '../infrastructure/mongo.js';
import { ensureIndexes } from '../infrastructure/schema.js';
import { COLLECTIONS } from '../infrastructure/mongo.js';
import { LEDGER_COLLECTION, type Migration } from './types.js';
import type { EpgSourceDoc } from '../infrastructure/schema.js';
import { EPG_SOURCE_SEED } from '../scripts/seed-data.js';

interface LedgerEntry {
  _id: string;
  name: string;
  appliedAt: Date;
  description: string;
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
  ];
}

export async function migrate(database: DatabaseHandle): Promise<{ applied: string[]; already: string[] }> {
  const ledger = database.db.collection<LedgerEntry>(LEDGER_COLLECTION);
  const migrations = buildMigrations(database);
  const applied: string[] = [];
  const already: string[] = [];
  for (const migration of migrations) {
    const existing = await ledger.findOne({ name: migration.name });
    if (existing) {
      already.push(migration.name);
      continue;
    }
    await migration.run();
    await ledger.insertOne({
      _id: migration.name,
      name: migration.name,
      description: migration.description,
      appliedAt: new Date(),
    });
    applied.push(migration.name);
  }
  return { applied, already };
}

export async function migrationStatus(database: DatabaseHandle): Promise<{
  pending: string[];
  applied: string[];
}> {
  const ledger = database.db.collection<LedgerEntry>(LEDGER_COLLECTION);
  const rows = await ledger.find({}).toArray();
  const appliedNames = rows.map((row) => row.name);
  const all = buildMigrations(database).map((migration) => migration.name);
  return { pending: all.filter((name) => !appliedNames.includes(name)), applied: appliedNames };
}
