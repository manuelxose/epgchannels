/**
 * Explicit ingestion entrypoint for a bounded local snapshot.
 *
 * Loads the snapshot, verifies every digest, builds the candidates and reports
 * the run metrics. It never fetches and never writes: persisting candidates is
 * the catalogue store's job (models-specialist), called by the captain's CLI.
 *
 * Usage:
 *   node apps/backend/dist/ingestion/ingest-snapshot.js <snapshot-root> [--json]
 * Exit codes: 0 ingested, 1 snapshot rejected, 2 usage error.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { accumulateMetrics } from './metrics.js';
import { buildCandidates } from './provenance.js';
import { loadSnapshot, snapshotDocument } from './snapshot.js';

function usage(): never {
  process.stderr.write('Usage: node ingest-snapshot.js <snapshot-root> [--json]\n');
  process.exit(2);
}

/** Reads `<root>/source.json` when present: `{ upstreamUrl?: string }` (the fetch origin). */
function readSourceHint(root: string): { upstreamUrl?: string } {
  try {
    const raw = JSON.parse(readFileSync(resolve(root, 'source.json'), 'utf8')) as unknown;
    if (typeof raw === 'object' && raw !== null && typeof (raw as { upstreamUrl?: unknown }).upstreamUrl === 'string') {
      return { upstreamUrl: (raw as { upstreamUrl: string }).upstreamUrl };
    }
    return {};
  } catch {
    return {};
  }
}

function main(argv: readonly string[]): number {
  const positional = argv.filter((arg) => !arg.startsWith('--'));
  const root = positional[0];
  if (root === undefined) usage();
  const load = loadSnapshot(root);
  const doc = snapshotDocument(load, readSourceHint(root));
  const report = {
    snapshot: {
      id: doc._id,
      upstream: doc.upstream,
      commitSha: doc.commitSha,
      status: doc.status,
      rejectionReason: doc.rejectionReason,
      files: doc.fileCount,
      entries: doc.entryCount,
    },
    errors: load.errors.slice(0, 20),
  };
  if (doc.status !== 'ingested') {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 1;
  }
  const candidates = buildCandidates(doc, load.playlists);
  const metrics = accumulateMetrics({ upstream: doc.upstream, candidates });
  const output = {
    ...report,
    candidates: candidates.length,
    rejectedEntries: candidates.filter((candidate) => candidate.state === 'rejected').length,
    metrics,
  };
  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } else {
    process.stdout.write(
      [
        `snapshot      ${doc.upstream} @ ${doc.commitSha ?? 'unknown'}`,
        `files/entries ${doc.fileCount} / ${doc.entryCount}`,
        `candidates    ${candidates.length}`,
        `countries     ${Object.keys(metrics.byCountry).length}`,
        `rejected      ${metrics.rejectedEntries}`,
      ].join('\n') + '\n',
    );
  }
  return 0;
}

process.exit(main(process.argv.slice(2)));
