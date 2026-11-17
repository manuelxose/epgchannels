/**
 * Verifies REAL sources from the published catalogue with the 02D engine.
 *
 * This is the measurement that 02D could not make: until the authorization ledger
 * was populated the 02C gate refused every source, correctly, so the engine opened
 * zero sockets against the catalogue.
 *
 * It reads `playback_sources`, resolves each source's recorded authorization with
 * THE SAME lookup the gate uses (`decisionsForSources`), and runs the real engine.
 * It never manufactures an authorization: if a source has no decision it is
 * reported as refused, not skipped.
 *
 * Usage (repo root, after `npm run build -w @tdt/backend`):
 *   node apps/backend/scripts/verify-catalogue.mjs [--limit 10] [--out path] [--concurrency 2]
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const DIST = resolve(ROOT, 'apps', 'backend', 'dist');

if (!existsSync(resolve(DIST, 'verification', 'validator.js'))) {
  console.error(JSON.stringify({ ok: false, error: 'dist missing: run `npm run build -w @tdt/backend`' }));
  process.exit(2);
}

const load = (relative) => import(pathToFileURL(resolve(DIST, relative)).href);

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const hit = args.find((item) => item.startsWith(`--${name}=`));
  if (hit) return hit.split('=')[1];
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] && !args[idx + 1].startsWith('--') ? args[idx + 1] : fallback;
};

const LIMIT = Number(option('limit', '10'));
const OUT = option('out', 'evidence/verification-02d/catalogue-verification.json');
const CONCURRENCY = Math.max(1, Math.min(8, Number(option('concurrency', '2'))));

const MONGO_URI = process.env['MONGODB_URI'] ?? 'mongodb://127.0.0.1:27117/?replicaSet=rs0';
const MONGO_DB = process.env['MONGODB_DB'] ?? 'tdt_platform';

const { MongoClient } = await import('mongodb');
const { COLLECTIONS } = await load('infrastructure/mongo.js');
const { safeFetch } = await load('infrastructure/safe-egress.js');
const { runValidation } = await load('verification/validator.js');
const { AuthorizationRepository } = await load('modules/providers/authorization.repository.js');

/** The real SSRF-guarded egress. No allowances: production shape. */
const egress = async (request) => {
  const response = await safeFetch({
    url: request.url,
    method: request.method ?? 'GET',
    timeoutMs: request.timeoutMs,
    maxBytes: request.maxBytes,
    ...(request.allowedContentPrefixes ? { allowedContentPrefixes: request.allowedContentPrefixes } : {}),
    ...(request.prefixBytes === undefined ? {} : { prefixBytes: request.prefixBytes }),
  });
  return {
    status: response.status,
    ok: response.ok,
    contentType: response.contentType,
    bytes: response.bytes,
    body: response.body,
    finalUrl: response.finalUrl,
    latencyMs: response.latencyMs,
  };
};

const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
await client.connect();
const db = client.db(MONGO_DB);

const startedAt = Date.now();
try {
  const sources = await db
    .collection(COLLECTIONS.sources)
    .find({ editorialStatus: 'published', type: { $in: ['hls', 'dash'] }, url: { $ne: null } })
    .sort({ priority: 1, _id: 1 })
    .limit(LIMIT)
    .toArray();

  const repository = new AuthorizationRepository({
    client,
    db,
    collection: (name) => db.collection(name),
    close: async () => undefined,
  });
  const decisions = await repository.decisionsForSources(
    sources.map((source) => ({ _id: source._id, url: source.url })),
  );

  const results = [];
  let egressRequests = 0;

  const runOne = async (source) => {
    const authorization = decisions.get(source._id) ?? null;
    let requests = 0;
    const counting = async (request) => {
      requests += 1;
      return egress(request);
    };
    const started = Date.now();
    const result = await runValidation({
      source,
      authorization,
      egress: counting,
      segmentSample: 2,
      now: new Date(),
    });
    egressRequests += requests;
    return {
      sourceId: source._id,
      host: new URL(source.url).hostname,
      hasAuthorization: authorization !== null,
      verdict: authorization?.verdict ?? null,
      outcome: result.outcome,
      failure: result.failure?.category ?? null,
      depthReached: result.depthReached,
      latencyMs: Date.now() - started,
      egressRequests: requests,
      uncertaintyNotes: result.uncertainty?.notes ?? [],
    };
  };

  // Bounded concurrency: the same discipline the scheduler enforces.
  const queue = [...sources];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      try {
        results.push(await runOne(next));
      } catch (error) {
        results.push({
          sourceId: next._id,
          host: new URL(next.url).hostname,
          outcome: 'unverifiable',
          failure: 'unknown-error',
          note: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        });
      }
    }
  });
  await Promise.all(workers);

  const byOutcome = {};
  const byFailure = {};
  for (const row of results) {
    byOutcome[row.outcome] = (byOutcome[row.outcome] ?? 0) + 1;
    if (row.failure) byFailure[row.failure] = (byFailure[row.failure] ?? 0) + 1;
  }

  const report = {
    ok: true,
    generatedAt: new Date().toISOString(),
    database: MONGO_DB,
    requested: LIMIT,
    verified: results.length,
    withAuthorization: results.filter((row) => row.hasAuthorization).length,
    egressRequests,
    wallMs: Date.now() - startedAt,
    byOutcome,
    byFailure,
    results,
  };

  const target = resolve(ROOT, OUT);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  // Bounded console summary; the file carries the detail.
  console.log(
    JSON.stringify({
      ok: true,
      verified: report.verified,
      withAuthorization: report.withAuthorization,
      egressRequests: report.egressRequests,
      wallMs: report.wallMs,
      byOutcome: report.byOutcome,
      byFailure: report.byFailure,
      out: OUT,
    }),
  );
} finally {
  await client.close();
}
