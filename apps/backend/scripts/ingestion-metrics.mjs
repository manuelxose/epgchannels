/**
 * Ingestion metrics: counts of an ingested catalogue, printed as one compact
 * JSON object.
 *
 *   node apps/backend/scripts/ingestion-metrics.mjs --db <database> [--uri <mongodb-uri>]
 *   node apps/backend/scripts/ingestion-metrics.mjs --snapshot <dir> [--snapshot <dir> ...]
 *   node apps/backend/scripts/ingestion-metrics.mjs            # both real snapshots,
 *                                                              #     freshly ingested into a
 *                                                              #     disposable database that is dropped
 *
 * `--db` reads an existing database (read-only: nothing is written, nothing is
 * dropped). Without `--db` the script loads the given snapshots (default: both
 * captured ones), ingests them into `tdt_metrics_<12 hex>`, reports the counts
 * and drops that database again.
 *
 * It prints only counts and ratios: no playlist text, no document body, no URL.
 * Exit codes: 0 metrics produced, 1 failure (snapshot rejected, database
 * unreachable, backend not built), 2 usage error.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  catalogueCounts,
  defaultMongoUri,
  discoverSnapshots,
  dropDisposable,
  ingestSnapshot,
  loadBackend,
  loadSnapshot,
  openDisposable,
  peakRssMiB,
  repositoryRoot,
  round,
} from './ingestion-core.mjs';

function usage(message) {
  process.stderr.write(
    `${message}\nUsage: node apps/backend/scripts/ingestion-metrics.mjs [--db <database>] [--snapshot <dir>]... [--uri <mongodb-uri>] [--samples <n>]\n`,
  );
  process.exit(2);
}

function parseArgs(argv) {
  const options = { db: null, snapshots: [], uri: defaultMongoUri(), samples: 5 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    switch (arg) {
      case '--db':
        if (value === undefined) usage('--db needs a database name');
        options.db = value;
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
      case '--samples':
        if (value === undefined) usage('--samples needs a number');
        options.samples = Math.max(1, Math.min(50, Number.parseInt(value, 10) || 5));
        index += 1;
        break;
      case '--help':
      case '-h':
        usage('Printing ingestion metrics.');
        break;
      default:
        usage(`unknown argument: ${arg}`);
    }
  }
  return options;
}

/** Top-N entries of a count map, largest first (bounded so the output stays compact). */
function topN(map, n) {
  return Object.fromEntries(Object.entries(map).sort((left, right) => right[1] - left[1]).slice(0, n));
}

/**
 * Counts the catalogue in one already-migrated disposable database after
 * ingesting the given snapshot roots. Returns the metrics report.
 */
async function ingestAndCount(backend, uri, snapshotPaths) {
  const { name, database } = await openDisposable(backend, uri, 'tdt_metrics_');
  let dropped = false;
  try {
    const migrationStart = performance.now();
    const migrations = await backend.runner.migrate(database);
    const migrationMs = round(performance.now() - migrationStart, 1);

    const perSnapshot = [];
    for (const path of snapshotPaths) {
      const load = loadSnapshot(backend, path);
      if (load.integrity !== 'ok' || load.doc.status !== 'ingested') {
        throw new Error(`snapshot rejected: ${load.firstError ?? load.doc.rejectionReason ?? 'integrity failed'}`);
      }
      const ingest = await ingestSnapshot(backend, database, load.doc, load.playlists);
      perSnapshot.push({
        upstream: load.doc.upstream,
        commitSha: load.doc.commitSha,
        integrity: load.integrity,
        files: load.files,
        entries: load.entries,
        bytes: load.bytes,
        loadMs: load.loadMs,
        candidates: ingest.counts.candidates,
        rejected: ingest.counts.rejected,
        duplicates: ingest.counts.duplicates,
        reconciled: ingest.counts.reconciled,
        manualReview: ingest.counts.review,
        createdChannels: ingest.counts.createdChannels,
      });
    }

    const counts = await catalogueCounts(backend, database);
    return {
      command: 'ingestion-metrics',
      mode: 'fresh-ingest',
      disposableDatabase: name,
      migrationsApplied: migrations.applied.length,
      migrationMs,
      snapshots: perSnapshot,
      counts,
      peakRssMiB: peakRssMiB(),
    };
  } finally {
    dropped = await dropDisposable(backend, uri, name, [database]);
  }
}

/** Counts an existing database read-only; the caller guarantees it is disposable or staged. */
async function countExisting(backend, uri, databaseName) {
  const database = await backend.mongo.connectDatabase(uri, databaseName);
  try {
    const collections = (await database.db.listCollections().toArray()).map((entry) => entry.name);
    if (!collections.includes(backend.mongo.COLLECTIONS.sourceCandidates)) {
      throw new Error(`database ${databaseName} has no source_candidates collection: migrate and ingest it first`);
    }
    return {
      command: 'ingestion-metrics',
      mode: 'existing-database',
      database: databaseName,
      collections: collections.length,
      counts: await catalogueCounts(backend, database),
      peakRssMiB: peakRssMiB(),
    };
  } finally {
    await database.close();
  }
}

async function main(argv) {
  const options = parseArgs(argv);
  const root = repositoryRoot();
  const backend = await loadBackend(root);

  let report;
  if (options.db !== null) {
    report = await countExisting(backend, options.uri, options.db);
  } else {
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
      if (!existsSync(paths[0])) throw new Error(`missing snapshot ${paths[0]}`);
    }
    report = await ingestAndCount(backend, options.uri, paths);
  }

  // Bounded maps: the full country/language tables are printed only in the top-N
  // form plus their true distinct count, so a large catalogue stays one screen.
  // Coverage of the catalogue is reported separately from what the upstream
  // itself declared, and never merged into one figure.
  const counts = report.counts;
  const compact = {
    ...report,
    counts: {
      ...counts,
      channelCountryCoverage: {
        source: counts.channelCountryCoverage.source,
        distinct: counts.channelCountryCoverage.distinct,
        known: counts.channelCountryCoverage.known,
        unknown: counts.channelCountryCoverage.unknown,
        top: topN(counts.channelCountryCoverage.byCountry, options.samples),
      },
      channelLanguageCoverage: {
        source: counts.channelLanguageCoverage.source,
        distinct: counts.channelLanguageCoverage.distinct,
        known: counts.channelLanguageCoverage.known,
        unknown: counts.channelLanguageCoverage.unknown,
        top: topN(counts.channelLanguageCoverage.byLanguage, options.samples),
      },
      languageDeclaredByUpstream: {
        distinct: counts.languageDeclaredByUpstream.distinct,
        top: topN(counts.languageDeclaredByUpstream.byLanguage, options.samples),
      },
    },
  };
  process.stdout.write(`${JSON.stringify(compact)}\n`);
  return 0;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`${JSON.stringify({ command: 'ingestion-metrics', status: 'failed', error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
  });
