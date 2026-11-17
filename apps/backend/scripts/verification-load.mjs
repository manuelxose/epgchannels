/**
 * Verification round load measurement (a measurement, never a gate).
 *
 *   node apps/backend/scripts/verification-load.mjs [--sources 200] [--concurrency 8]
 *        [--per-host 2] [--fail-rate 0.1] [--hosts 20]
 *
 * Runs ONE real scheduler round (`VerificationScheduler.runRound`) with a stub
 * validator — no socket is opened — against a disposable MongoDB when it is
 * reachable and an in-memory store when it is not, and prints ONE compact JSON
 * line: throughput, p50/p95 latency, maximum concurrency observed (global and
 * per host), simulated egress request count and per-outcome counts.
 *
 * It prints no per-item line and no URL; hosts appear only as bucket counts.
 * Exit codes: 0 measured, 1 nothing was planted or a failure, 2 usage error.
 *
 * It imports the backend's built modules (`apps/backend/dist`), so it adds no
 * dependency and measures the code a deployment runs.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const now0 = () => performance.now();

function usage(message) {
  process.stderr.write(
    `${message}\nUsage: node apps/backend/scripts/verification-load.mjs ` +
      '[--sources <n>] [--concurrency <n>] [--per-host <n>] [--fail-rate <0..1>] [--hosts <n>] [--delay-ms <n>]\n',
  );
  process.exit(2);
}

function parseArgs(argv) {
  const options = { sources: 200, concurrency: 8, perHost: 2, failRate: 0.1, hosts: 20, delayMs: 3 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === '--help' || arg === '-h') usage('Measuring one verification round.');
    if (value === undefined) usage(`${arg} needs a value`);
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) usage(`${arg} needs a number`);
    switch (arg) {
      case '--sources':
        options.sources = Math.max(1, Math.min(10_000, Math.trunc(numeric)));
        break;
      case '--concurrency':
        options.concurrency = Math.max(1, Math.min(256, Math.trunc(numeric)));
        break;
      case '--per-host':
        options.perHost = Math.max(1, Math.min(64, Math.trunc(numeric)));
        break;
      case '--fail-rate':
        options.failRate = Math.max(0, Math.min(1, numeric));
        break;
      case '--hosts':
        options.hosts = Math.max(1, Math.min(500, Math.trunc(numeric)));
        break;
      case '--delay-ms':
        options.delayMs = Math.max(0, Math.min(1_000, Math.trunc(numeric)));
        break;
      default:
        usage(`unknown argument: ${arg}`);
    }
    index += 1;
  }
  return options;
}

const round = (value, digits = 2) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}

async function loadBackend() {
  const dist = resolve(import.meta.dirname, '..', 'dist');
  const load = async (file) => import(pathToFileURL(resolve(dist, file)).href);
  return {
    scheduler: await load('verification/scheduler.js'),
    queue: await load('verification/queue.js'),
    metrics: await load('verification/metrics.js'),
    mongo: await load('infrastructure/mongo.js'),
  };
}

/** Deterministic pseudo-random so two runs of the same args are comparable. */
function unitGenerator(seedInit) {
  let seed = seedInit;
  return () => {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

/** A stub validator: jittered latency, a configurable share of transient failures. */
function stubValidator(options) {
  const nextUnit = unitGenerator(0x2f6e2b1);
  const latencies = [];
  return {
    latencies,
    async validate() {
      const started = now0();
      // One HEAD; a manifest GET follows only when the HEAD passed.
      const headOk = nextUnit() >= options.failRate;
      if (options.delayMs > 0) {
        // A little simulated work so latency percentiles are meaningful.
        const busyUntil = now0() + nextUnit() * options.delayMs;
        while (now0() < busyUntil) {
          /* simulate provider latency without sleeping on the timer wheel */
        }
      }
      if (!headOk) {
        latencies.push(now0() - started);
        return {
          outcome: 'timeout',
          depth: 'transport',
          egressRequests: 1,
          failure: { code: 'timeout', httpStatus: null, detail: 'stub timeout' },
        };
      }
      latencies.push(now0() - started);
      return {
        outcome: nextUnit() < 0.05 ? 'degraded' : 'healthy',
        depth: 'segments',
        egressRequests: 2,
        segmentsSampled: true,
        evidence: { httpStatus: 200, contentType: 'application/vnd.apple.mpegurl', bytes: 512 },
      };
    },
  };
}

/** In-memory queue: the measurement must not depend on Redis. */
function memoryQueue() {
  const items = new Map();
  return {
    name: 'mongo',
    degraded: false,
    lastError: null,
    async enqueue(input) {
      const id = `${input.sourceId}:${input.scheduledFor}`;
      if (!items.has(id)) {
        items.set(id, { id, sourceId: input.sourceId, scheduledFor: new Date(input.scheduledFor), state: 'pending' });
      }
      const item = items.get(id);
      return { id: item.id, sourceId: item.sourceId, scheduledFor: item.scheduledFor, owner: null, attemptNumber: 1 };
    },
    async claim(owner) {
      for (const item of items.values()) {
        if (item.state === 'pending') {
          item.state = 'running';
          return { item: { ...item, owner, attemptNumber: 1 } };
        }
      }
      return { item: null, reason: 'empty' };
    },
    async complete(id, outcome) {
      const item = items.get(id);
      if (item !== undefined) item.state = outcome.state ?? 'done';
    },
    async release(id) {
      const item = items.get(id);
      if (item !== undefined) item.state = 'pending';
    },
    async requeue(id) {
      const item = items.get(id);
      if (item !== undefined) item.state = 'pending';
    },
    async depth() {
      let count = 0;
      for (const item of items.values()) if (item.state === 'pending') count += 1;
      return count;
    },
    async statusCounts() {
      const counts = { pending: 0, running: 0, done: 0, failed: 0, skipped: 0 };
      for (const item of items.values()) counts[item.state] = (counts[item.state] ?? 0) + 1;
      return counts;
    },
    async close() {},
  };
}

function sourceRows(options) {
  const now = new Date();
  const sources = [];
  const health = [];
  for (let index = 0; index < options.sources; index += 1) {
    const id = randomUUID();
    const hostIndex = index % options.hosts;
    sources.push({
      _id: id,
      channelId: randomUUID(),
      provider: `provider-${hostIndex}`,
      type: 'hls',
      url: `https://cdn${hostIndex}.invalid/live/index.m3u8`,
      officialPageUrl: null,
      permission: 'official',
      authorisationEvidence: null,
      conditions: {},
      priority: hostIndex,
      editorialStatus: 'published',
      technicalStatus: 'unknown',
      lastVerifiedAt: null,
      lastVerification: null,
      provenance: [],
      createdAt: now,
      updatedAt: now,
      revision: 0,
    });
    health.push({
      _id: id,
      status: 'unknown',
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastOutcome: null,
      lastCheckedAt: null,
      nextCheckAt: new Date(now.getTime() - 60_000),
      host: `cdn${hostIndex}.invalid`,
      circuit: { state: 'closed', openedAt: null, reopenCount: 0 },
      history: [],
      revision: 0,
      updatedAt: now,
    });
  }
  return { sources, health };
}

/** Minimal in-memory `DatabaseHandle` stand-in for the no-MongoDB path. */
function memoryDatabase(sources, health) {
  const tables = new Map([
    ['playback_sources', sources],
    ['source_health_02d', health],
    ['source_health_checks_02d', []],
    ['verification_policies_02d', []],
  ]);
  const collection = (docs) => ({
    find(filter = {}) {
      let rows = docs.slice();
      if (filter['nextCheckAt'] !== undefined) {
        rows = rows.filter((row) => row.nextCheckAt instanceof Date && row.nextCheckAt <= filter['nextCheckAt']);
      }
      if (filter['paused'] !== undefined) rows = rows.filter((row) => row.paused === filter['paused']);
      const cursor = {
        sort: () => cursor,
        limit: () => cursor,
        project: () => cursor,
        toArray: async () => rows,
      };
      return cursor;
    },
    async findOne(filter) {
      return docs.find((doc) => doc._id === filter._id) ?? null;
    },
    async insertOne(doc) {
      docs.push(doc);
      return { insertedId: doc._id };
    },
    async updateOne(filter, update) {
      const doc = docs.find((entry) => entry._id === filter._id);
      if (doc === undefined) return { matchedCount: 0, modifiedCount: 0 };
      Object.assign(doc, update.$set ?? {});
      return { matchedCount: 1, modifiedCount: 1 };
    },
    async createIndexes() {
      return [];
    },
    async createIndex() {
      return '';
    },
    aggregate() {
      return { toArray: async () => [] };
    },
    async countDocuments() {
      return docs.length;
    },
  });
  return {
    db: {
      collection(name) {
        if (!tables.has(name)) tables.set(name, []);
        return collection(tables.get(name));
      },
    },
    collection(name) {
      return this.db.collection(name);
    },
  };
}

async function main(argv) {
  const options = parseArgs(argv);
  const backend = await loadBackend();
  const metrics = new backend.metrics.VerificationMetrics();
  const { sources, health } = sourceRows(options);

  const uri = process.env['MONGODB_URI'] ?? 'mongodb://127.0.0.1:27117/?replicaSet=rs0';
  const name = `tdt_bench_${randomBytes(6).toString('hex')}`;
  let database;
  let backendLabel = 'mongodb';
  try {
    try {
      database = await backend.mongo.connectDatabase(uri, name);
      await database.db.dropDatabase();
    } catch {
      database = null;
    }
    if (database === null) {
      backendLabel = 'memory';
      database = memoryDatabase(sources, health);
    } else {
      await database.db.collection('playback_sources').insertMany(sources);
      await database.db.collection('source_health_02d').insertMany(health);
    }

    const stub = stubValidator(options);
    const scheduler = new backend.scheduler.VerificationScheduler({
      database,
      queue: memoryQueue(),
      validator: stub,
      metrics,
      concurrency: options.concurrency,
      perHostConcurrency: options.perHost,
      // Plan the whole set; the executor's semaphores do the bounding, so the
      // measurement reports what one round costs, not how it was pre-truncated.
      perHostPlanLimit: options.sources,
      batchSize: options.sources,
      maxAttempts: 1,
      backoff: () => 0,
      collections: {
        checks: 'source_health_checks_02d',
        health: 'source_health_02d',
        policies: 'verification_policies_02d',
      },
    });

    const startedAt = now0();
    const counts = await scheduler.runRound(new Date());
    const wallMs = now0() - startedAt;
    const sorted = [...stub.latencies].sort((left, right) => left - right);

    const report = {
      script: 'verification-load',
      backend: backendLabel,
      scheduled: { planned: counts.planned, deferred: counts.deferred },
      throughputChecksPerSecond: wallMs === 0 ? null : round((counts.planned / wallMs) * 1000, 1),
      wallMs: round(wallMs, 1),
      latencyMs: { p50: round(percentile(sorted, 0.5), 2), p95: round(percentile(sorted, 0.95), 2) },
      concurrency: {
        limit: options.concurrency,
        perHostLimit: options.perHost,
        maxObserved: counts.peakInFlight,
        maxObservedPerHost: counts.peakInFlightByHost,
      },
      egress: { simulatedRequests: counts.egressRequests, hostBuckets: backend.metrics.HOST_BUCKET_COUNT },
      outcomes: counts.byOutcome,
      retries: counts.retries,
      metricsSeries: metrics.render().split('\n').filter((line) => line.length > 0).length,
    };
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return counts.planned > 0 ? 0 : 1;
  } finally {
    if (backendLabel === 'mongodb' && database !== null) {
      try {
        await database.db.dropDatabase();
      } catch {
        /* report-only cleanup */
      }
      await database.close().catch(() => undefined);
    }
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(
      `${JSON.stringify({ script: 'verification-load', status: 'failed', error: error instanceof Error ? error.message : String(error) })}\n`,
    );
    process.exitCode = 1;
  });
