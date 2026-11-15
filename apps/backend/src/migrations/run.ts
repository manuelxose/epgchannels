/**
 * `migrate`: applies the schema migrations and registers the editorial guide
 * source. Safe to run repeatedly, safe on an empty database.
 */
import { loadConfig } from '../config/config.js';
import { initCliEnvironment, reportFailure } from '../scripts/cli-env.js';
import { connectDatabase } from '../infrastructure/mongo.js';
import { migrate, migrationStatus } from './runner.js';

async function main(): Promise<void> {
  initCliEnvironment();
  const config = loadConfig();
  const database = await connectDatabase(config.MONGODB_URI, config.MONGODB_DB);
  try {
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
