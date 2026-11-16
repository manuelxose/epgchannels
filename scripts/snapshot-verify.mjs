/**
 * Verify a bounded local snapshot and report what ingestion would see.
 *
 * Read-only maintainer tool: it never fetches, never repairs and never writes
 * into the snapshot directory. Exit codes: 0 verified, 1 rejected (digest,
 * size, missing file, schema), 2 usage error.
 *
 * Usage:
 *   node scripts/snapshot-verify.mjs <snapshot-root> [--json]
 */
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const distDir = resolve(repoRoot, 'apps/backend/dist/ingestion');

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

async function loadIngestion() {
  const require = createRequire(import.meta.url);
  try {
    require.resolve(`${distDir}/snapshot.js`);
  } catch {
    fail(`The ingestion build is missing (${distDir}). Run: npm run build`);
  }
  return {
    snapshot: await import(pathToFileURL(`${distDir}/snapshot.js`).href),
    provenance: await import(pathToFileURL(`${distDir}/provenance.js`).href),
    metrics: await import(pathToFileURL(`${distDir}/metrics.js`).href),
  };
}

const args = process.argv.slice(2);
const json = args.includes('--json');
const positional = args.filter((arg) => !arg.startsWith('--'));
const root = positional[0];
if (root === undefined) fail('Usage: node scripts/snapshot-verify.mjs <snapshot-root> [--json]');

const { snapshot: snapshotModule, provenance, metrics } = await loadIngestion();
const load = snapshotModule.loadSnapshot(root);
const doc = snapshotModule.snapshotDocument(load);

const summary = {
  root: resolve(root),
  integrity: load.integrity,
  upstream: doc.upstream,
  commitSha: doc.commitSha,
  retrievedAt: doc.retrievedAt.toISOString(),
  snapshotId: doc._id,
  files: load.playlists.length,
  entries: load.playlists.reduce((sum, playlist) => sum + playlist.playlist.entries.length, 0),
  rejectedLines: load.playlists.reduce((sum, playlist) => sum + playlist.playlist.rejected.length, 0),
  errors: load.errors.slice(0, 20),
};

if (load.integrity === 'ok') {
  const candidates = provenance.buildCandidates(doc, load.playlists);
  const runMetrics = metrics.accumulateMetrics({ upstream: doc.upstream, candidates });
  summary.candidates = candidates.length;
  summary.byState = candidates.reduce((acc, candidate) => {
    acc[candidate.state] = (acc[candidate.state] ?? 0) + 1;
    return acc;
  }, {});
  summary.byType = candidates.reduce((acc, candidate) => {
    acc[candidate.type] = (acc[candidate.type] ?? 0) + 1;
    return acc;
  }, {});
  summary.flagged = candidates.reduce((acc, candidate) => {
    for (const flag of candidate.flags) acc[flag] = (acc[flag] ?? 0) + 1;
    return acc;
  }, {});
  summary.countries = Object.keys(runMetrics.byCountry).length;
  summary.metrics = runMetrics;
}

if (json) {
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} else {
  const lines = [
    `snapshot      ${summary.root}`,
    `integrity     ${summary.integrity}`,
    `upstream      ${summary.upstream} @ ${summary.commitSha ?? 'unknown commit'}`,
    `retrievedAt   ${summary.retrievedAt}`,
    `snapshotId    ${summary.snapshotId}`,
    `files         ${summary.files}`,
    `entries       ${summary.entries}`,
    `rejected      ${summary.rejectedLines} parse-time lines`,
  ];
  if (summary.candidates !== undefined) {
    lines.push(
      `candidates    ${summary.candidates}  ${JSON.stringify(summary.byState ?? {})}`,
      `types         ${JSON.stringify(summary.byType ?? {})}`,
      `flags         ${JSON.stringify(summary.flagged ?? {})}`,
      `countries     ${summary.countries}`,
    );
  }
  for (const error of summary.errors) lines.push(`ERROR         ${error}`);
  process.stdout.write(`${lines.join('\n')}\n`);
}

process.exit(load.integrity === 'ok' ? 0 : 1);
