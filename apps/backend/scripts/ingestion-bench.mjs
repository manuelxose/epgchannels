/**
 * Ingestion benchmark: measures a full ingestion of the captured snapshots into
 * a disposable database and reports the throughput, the peak RSS and the stage
 * durations.
 *
 *   node apps/backend/scripts/ingestion-bench.mjs [--repeat 1] [--snapshot <dir>]... [--uri <uri>]
 *
 * Default: one measured ingestion of both captured snapshots (iptv-org, then
 * Free-TV) into `tdt_bench_<12 hex>`, which is dropped before the process exits
 * — also on failure. `--repeat n` runs the same ingestion n times in that one
 * database: the first pass is the cold ingest and the following passes are the
 * idempotent re-runs (they must create zero ids).
 *
 * The output is one compact JSON object of counts, durations and rates. It
 * contains no playlist text and no document body.
 * Exit codes: 0 measured, 1 failure, 2 usage error.
 */
import { resolve } from 'node:path';
import {
  catalogueCounts,
  defaultMongoUri,
  discoverSnapshots,
  dropDisposable,
  ingestSnapshotViaPipeline,
  loadBackend,
  loadSnapshot,
  openDisposable,
  peakRssMiB,
  repositoryRoot,
  round,
} from './ingestion-core.mjs';

function usage(message) {
  process.stderr.write(
    `${message}\nUsage: node apps/backend/scripts/ingestion-bench.mjs [--repeat <n>] [--snapshot <dir>]... [--uri <mongodb-uri>]\n`,
  );
  process.exit(2);
}

function parseArgs(argv) {
  const options = { repeat: 1, snapshots: [], uri: defaultMongoUri() };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    switch (arg) {
      case '--repeat':
        if (value === undefined) usage('--repeat needs a number');
        options.repeat = Math.max(1, Math.min(10, Number.parseInt(value, 10) || 1));
        index += 1;
        break;
      case '--snapshot':
        if (value === undefined) usage('--snapshot needs a directory');
        options.snapshots.push(resolve(value));
        index += 1;
        break;
      case '--uri':
        if (value === undefined) usage('--uri needs a connection string');
        options.uri = value;
        index += 1;
        break;
      case '--help':
      case '-h':
        usage('Benchmarking ingestion.');
        break;
      default:
        usage(`unknown argument: ${arg}`);
    }
  }
  return options;
}

const sum = (values) => values.reduce((total, value) => total + value, 0);

async function main(argv) {
  const options = parseArgs(argv);
  const root = repositoryRoot();
  const backend = await loadBackend(root);

  let paths = options.snapshots;
  if (paths.length === 0) {
    const discovered = discoverSnapshots(root);
    const missing = discovered.snapshots.filter((snapshot) => snapshot.missing === true);
    if (missing.length > 0) {
      throw new Error(
        `no snapshot at ${missing[0].path}: pass --snapshot <dir> or set TDT_SNAPSHOT_DIR (looked under ${discovered.data})`,
      );
    }
    paths = discovered.snapshots.map((snapshot) => snapshot.path);
  }

  const wallStart = performance.now();
  const { name, database } = await openDisposable(backend, options.uri, 'tdt_bench_');
  let report;
  let failure = null;
  /* Real drop outcome, reported truthfully on both the success and failure paths. */
  let droppedFlag = false;
  try {
    const migrationStart = performance.now();
    const migrations = await backend.runner.migrate(database);
    const migrationMs = round(performance.now() - migrationStart, 1);

    // Verify once outside the measured window: parsing is measured per pass below.
    const verified = [];
    const verifyStart = performance.now();
    for (const path of paths) {
      const load = loadSnapshot(backend, path);
      if (load.integrity !== 'ok' || load.doc.status !== 'ingested') {
        throw new Error(`snapshot rejected: ${load.firstError ?? load.doc.rejectionReason ?? 'integrity failed'}`);
      }
      verified.push({ path, doc: load.doc, playlists: load.playlists, files: load.files, entries: load.entries, bytes: load.bytes, loadMs: load.loadMs });
    }
    const verifyMs = round(performance.now() - verifyStart, 1);

    const passes = [];
    for (let attempt = 0; attempt < options.repeat; attempt += 1) {
      const passStart = performance.now();
      const perSnapshot = [];
      for (const snapshot of verified) {
        const ingestStart = performance.now();
        // The production path: what a deployment runs, in bulk writes.
        const ingest = await ingestSnapshotViaPipeline(backend, database, snapshot.doc, snapshot.playlists, {
          idNamespace: 'bench',
        });
        perSnapshot.push({
          upstream: snapshot.doc.upstream,
          entries: snapshot.entries,
          candidates: ingest.counts.importedEntries,
          createdChannels: ingest.createdChannelIds.length,
          createdCandidates: ingest.counts.importedEntries,
          rejected: ingest.counts.rejectedEntries,
          duplicates: ingest.counts.duplicateCandidates,
          reconciled: ingest.counts.canonicalChannels,
          manualReview: ingest.counts.manualReview,
          ingestMs: round(performance.now() - ingestStart, 1),
          stages: { pipelineTotalMs: ingest.wallMs },
        });
      }
      const wallMs = round(performance.now() - passStart, 1);
      const entries = sum(perSnapshot.map((snapshot) => snapshot.entries));
      const candidates = sum(perSnapshot.map((snapshot) => snapshot.candidates));
      passes.push({
        pass: attempt + 1,
        kind: attempt === 0 ? 'cold-ingest' : 'repeat-idempotent',
        entries,
        candidates,
        createdChannels: sum(perSnapshot.map((snapshot) => snapshot.createdChannels)),
        createdCandidates: sum(perSnapshot.map((snapshot) => snapshot.createdCandidates)),
        wallMs,
        entriesPerSecond: wallMs === 0 ? null : round((entries / wallMs) * 1000, 1),
        candidatesPerSecond: wallMs === 0 ? null : round((candidates / wallMs) * 1000, 1),
        snapshots: perSnapshot,
      });
    }

    const cold = passes[0];
    const counts = await catalogueCounts(backend, database);

    report = {
      command: 'ingestion-bench',
      disposableDatabase: name,
      repeat: options.repeat,
      migrationsApplied: migrations.applied.length,
      stageDurationsMs: {
        migrate: migrationMs,
        verifyAndParse: verifyMs,
        coldIngest: cold.wallMs,
        byStage: {
          pipelineTotal: round(sum(cold.snapshots.map((snapshot) => snapshot.stages.pipelineTotalMs)), 1),
        },
      },
      throughput: {
        entriesPerSecond: cold.entriesPerSecond,
        candidatesPerSecond: cold.candidatesPerSecond,
        measuredOverMs: cold.wallMs,
        measuredEntries: cold.entries,
      },
      passes,
      counts,
      peakRssMiB: peakRssMiB(),
      wallMs: round(performance.now() - wallStart, 1),
    };
  } catch (error) {
    failure = error;
  } finally {
    const dropped = await dropDisposable(backend, options.uri, name, [database]).catch(() => false);
    droppedFlag = dropped === true;
    if (report !== undefined) report.databaseDropped = droppedFlag;
  }

  if (failure !== null) {
    process.stderr.write(
      `${JSON.stringify({ command: 'ingestion-bench', status: 'failed', databaseDropped: droppedFlag, disposableDatabase: name, error: failure instanceof Error ? failure.message : String(failure) })}\n`,
    );
    return 1;
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return 0;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`${JSON.stringify({ command: 'ingestion-bench', status: 'failed', error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
  });
