/**
 * `ingest-catalogue`: ingest a bounded, verified upstream snapshot into the
 * catalogue, or roll one run back.
 *
 *   node apps/backend/dist/scripts/ingest-catalogue.js --snapshot <dir>
 *   node apps/backend/dist/scripts/ingest-catalogue.js --rollback <runId>
 *
 * It reads a local snapshot only. It never fetches an upstream and never
 * publishes anything: a run creates staging records, and the publication policy
 * remains the only path to a public answer.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../config/config.js';
import { initCliEnvironment, reportFailure } from '../scripts/cli-env.js';
import { connectDatabase } from '../infrastructure/mongo.js';
import { ChannelStore } from '../catalogue/store.js';
import { COLLECTIONS } from '../infrastructure/mongo.js';
import type { IngestionRunDoc } from '../catalogue/schema.js';
import { loadSnapshot, snapshotDocument } from '../ingestion/snapshot.js';
import { runIngestion } from '../ingestion/pipeline.js';

function arg(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? (process.argv[index + 1] as string) : null;
}

async function main(): Promise<void> {
  initCliEnvironment();
  const config = loadConfig();
  const database = await connectDatabase(config.MONGODB_URI, config.MONGODB_DB);
  try {
    const rollbackTarget = arg('--rollback');
    if (rollbackTarget !== null) {
      const store = new ChannelStore(database);
      const result = await store.rollbackRun(rollbackTarget);
      console.log(JSON.stringify({ command: 'ingest-catalogue', action: 'rollback', runId: rollbackTarget, removed: result.removed }, null, 2));
      return;
    }

    const snapshotArg = arg('--snapshot');
    if (snapshotArg === null) {
      console.error(JSON.stringify({ ok: false, error: 'missing --snapshot <dir> or --rollback <runId>' }));
      process.exitCode = 2;
      return;
    }
    const root = resolve(snapshotArg);
    if (!existsSync(root)) {
      console.error(JSON.stringify({ ok: false, error: `snapshot directory not found: ${root}` }));
      process.exitCode = 2;
      return;
    }

    const load = loadSnapshot(root);
    // A tampered or partial snapshot is refused wholesale: no partial ingest.
    if (load.integrity !== 'ok' || load.manifest === null) {
      console.error(
        JSON.stringify(
          { ok: false, action: 'ingest', error: 'snapshot-integrity-failed', errors: load.errors.slice(0, 10) },
          null,
          2,
        ),
      );
      process.exitCode = 1;
      return;
    }

    const snapshot = snapshotDocument(load);
    const existing = await database.collection(COLLECTIONS.sourceSnapshots).findOne({ _id: snapshot._id });
    if (existing === null) {
      await database.collection(COLLECTIONS.sourceSnapshots).insertOne(snapshot);
    }

    const result = await runIngestion(database, snapshot, load.playlists);
    console.log(
      JSON.stringify(
        {
          command: 'ingest-catalogue',
          action: 'ingest',
          snapshotId: result.snapshotId,
          runId: result.runId,
          upstream: result.upstream,
          commitSha: snapshot.commitSha,
          retrievedAt: snapshot.retrievedAt,
          licence: snapshot.licence.reuse,
          metrics: result.metrics,
        },
        null,
        2,
      ),
    );
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  reportFailure('ingest-catalogue', error);
  process.exit(1);
});
