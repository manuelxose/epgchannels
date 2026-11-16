/**
 * `migrate`: applies the schema migrations and registers the editorial guide
 * source. Safe to run repeatedly, safe on an empty database.
 */
import { loadConfig } from '../config/config.js';
import { initCliEnvironment, reportFailure } from '../scripts/cli-env.js';
import { connectDatabase } from '../infrastructure/mongo.js';
import { migrate, migrationStatus, rollbackMigration } from './runner.js';

async function main(): Promise<void> {
  initCliEnvironment();
  const config = loadConfig();
  const database = await connectDatabase(config.MONGODB_URI, config.MONGODB_DB);
  try {
    const subcommand = process.argv[2];
    if (subcommand === 'rollback') {
      const name = process.argv[3];
      if (!name) {
        throw new Error('Usage: run.js rollback <migration-name>');
      }
      const result = await rollbackMigration(database, name);
      const after = await migrationStatus(database);
      console.log(
        JSON.stringify(
          {
            command: 'rollback',
            database: config.MONGODB_DB,
            rolledBack: result.name,
            recorded: result.recorded,
            pendingAfter: after.pending,
          },
          null,
          2,
        ),
      );
      return;
    }

    const before = await migrationStatus(database);
    const result = await migrate(database);
    const after = await migrationStatus(database);
    console.log(
      JSON.stringify(
        {
          command: 'migrate',
          database: config.MONGODB_DB,
          pendingBefore: before.pending,
          appliedNow: result.applied,
          alreadyApplied: result.already,
          pendingAfter: after.pending,
        },
        null,
        2,
      ),
    );
    if (after.pending.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  reportFailure('migrate', error);
  process.exit(1);
});
