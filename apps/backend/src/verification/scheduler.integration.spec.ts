/**
 * Scheduler integration: bounded concurrency, retries, breakers, pause and
 * recovery — against a real MongoDB.
 *
 * Every assertion is about an observable fact (a stored row, a counter, how many
 * times the validator was entered), never about the scheduler's own belief:
 *
 * - the fake validator is the only component that could "reach the network", so
 *   the proofs about retries and circuits are counts of its entries;
 * - concurrency is measured by the validator incrementing a live counter on
 *   entry and decrementing it on exit, remembering the peak;
 * - recovery is measured by reading `source_health_02d` before and after.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoClient, type Collection } from 'mongodb';
import type { DatabaseHandle, CollectionName } from '../infrastructure/mongo.js';
import { COLLECTIONS } from '../infrastructure/mongo.js';
import { TEST_MONGO_URI, mongoAvailable } from '../test/harness.js';
import type { AuditDoc } from '../infrastructure/schema.js';
import { VerificationMetrics } from './metrics.js';
import { MongoQueue, RedisQueue, checkId } from './queue.js';
import type { ValidationRequest, ValidationResult } from './scheduler.js';
import { BoundedSemaphore, VerificationScheduler } from './scheduler.js';
import { VerificationControls } from './controls.js';
import { claimCheck, healthCollections } from './health.repository.js';
import type { SourceHealthDoc } from './types.js';

const CHECKS = 'source_health_checks_02d';
const HEALTH = 'source_health_02d';
const POLICIES = 'verification_policies_02d';

let database: DatabaseHandle;
let client: MongoClient | null = null;
const databaseName = `tdt_test_sched_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

beforeAll(async () => {
  if (!(await mongoAvailable())) return;
  client = new MongoClient(TEST_MONGO_URI);
  await client.connect();
  const rawDb = client.db(databaseName);
  database = {
    client,
    db: rawDb,
    collection<T extends { _id: string }>(name: CollectionName) {
      return rawDb.collection<T>(name);
    },
    ping: async () => 0,
    close: async () => {
      await client?.close();
    },
  };
}, 60_000);

afterAll(async () => {
  if (client === null) return;
  await client.db(databaseName).dropDatabase().catch(() => undefined);
  await client.close().catch(() => undefined);
});

beforeEach(async () => {
  if (client === null) return;
  for (const name of [CHECKS, HEALTH, POLICIES, COLLECTIONS.sources, COLLECTIONS.audits]) {
    await database.db.collection(name).deleteMany({});
  }
});

/* ------------------------------------------------------------------ fixtures */

interface PlacedSource {
  readonly id: string;
  readonly host: string;
  readonly url: string;
}

/** The exact projection the planner reads; a fixture, not the whole schema. */
interface SourceDocFixture {
  readonly _id: string;
  readonly channelId: string;
  readonly provider: string;
  readonly type: string;
  readonly url: string;
  readonly officialPageUrl: string | null;
  readonly permission: string;
  readonly authorisationEvidence: string | null;
  readonly conditions: Record<string, unknown>;
  readonly priority: number;
  readonly editorialStatus: string;
  readonly technicalStatus: string;
  readonly lastVerifiedAt: Date | null;
  readonly lastVerification: Record<string, unknown> | null;
  readonly provenance: readonly unknown[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly revision: number;
}

/** Plants published sources, each on `host`, each with a due aggregated row. */
async function plantSources(specs: Array<{ host: string; provider?: string }>): Promise<PlacedSource[]> {
  const now = new Date();
  const placed: PlacedSource[] = [];
  for (const spec of specs) {
    const id = randomUUID();
    const url = `https://${spec.host}/live/index.m3u8`;
    await database.collection<SourceDocFixture>(COLLECTIONS.sources).insertOne({
      _id: id,
      channelId: randomUUID(),
      provider: spec.provider ?? 'official-web',
      type: 'hls',
      url,
      officialPageUrl: null,
      permission: 'official',
      authorisationEvidence: null,
      conditions: {},
      priority: 1,
      editorialStatus: 'published',
      technicalStatus: 'unknown',
      lastVerifiedAt: null,
      lastVerification: null,
      provenance: [],
      createdAt: now,
      updatedAt: now,
      revision: 0,
    });
    await healthCollection().insertOne({
      _id: id,
      status: 'unknown',
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastOutcome: null,
      lastCheckedAt: null,
      nextCheckAt: new Date(now.getTime() - 60_000),
      circuit: { state: 'closed', openedAt: null, reopenCount: 0 },
      history: [],
      revision: 0,
      updatedAt: now,
    });
    placed.push({ id, host: spec.host, url });
  }
  return placed;
}

/** The fake validator: the only thing that can be "reached" in these tests. */
class FakeValidator {
  readonly requests: ValidationRequest[] = [];
  inFlight = 0;
  peak = 0;

  constructor(
    private readonly latencyMs: number,
    private readonly respond: (request: ValidationRequest, entry: number) => ValidationResult,
  ) {}

  async validate(request: ValidationRequest): Promise<ValidationResult> {
    this.requests.push(request);
    this.inFlight += 1;
    this.peak = Math.max(this.peak, this.inFlight);
    try {
      if (this.latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
      return this.respond(request, this.requests.length);
    } finally {
      this.inFlight -= 1;
    }
  }
}

function makeScheduler(
  validator: { validate(request: ValidationRequest): Promise<ValidationResult> },
  overrides: Partial<ConstructorParameters<typeof VerificationScheduler>[0]> = {},
): { scheduler: VerificationScheduler; queue: MongoQueue; metrics: VerificationMetrics } {
  const metrics = new VerificationMetrics();
  const queue = new MongoQueue({ database });
  const scheduler = new VerificationScheduler({
    database,
    queue,
    validator,
    metrics,
    concurrency: 4,
    perHostConcurrency: 2,
    perHostPlanLimit: 2,
    batchSize: 500,
    maxAttempts: 3,
    leaseTtlMs: 30_000,
    backoff: () => 0,
    collections: { checks: CHECKS, health: HEALTH, policies: POLICIES },
    ...overrides,
  });
  return { scheduler, queue, metrics };
}

function controlsFor(queue: MongoQueue, now?: () => Date): VerificationControls {
  return new VerificationControls({
    database,
    queue,
    collections: { checks: CHECKS, health: HEALTH, policies: POLICIES },
    ...(now === undefined ? {} : { now }),
  });
}

const healthy = (): ValidationResult => ({
  outcome: 'healthy',
  depth: 'segments',
  egressRequests: 2,
  segmentsSampled: true,
  evidence: { httpStatus: 200, contentType: 'application/vnd.apple.mpegurl', bytes: 512 },
});

const timeoutResult = (): ValidationResult => ({
  outcome: 'timeout',
  depth: 'transport',
  egressRequests: 1,
  failure: { code: 'timeout', httpStatus: null, detail: 'no answer' },
});

const notFound = (): ValidationResult => ({
  outcome: 'http-404',
  depth: 'transport',
  egressRequests: 1,
  failure: { code: 'http-404', httpStatus: 404, detail: 'gone' },
});

/** Makes a source due right now, as a passing interval or a resume would. */
async function makeDue(sourceId: string): Promise<void> {
  await healthCollection().updateOne(
    { _id: sourceId },
    { $set: { nextCheckAt: new Date(Date.now() - 1_000) } },
  );
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Typed handle on one of the 02D collections. Their `_id` is a string (a
 * deterministic idempotency key / source id), which the generic `Db.collection`
 * overload does not express; this helper states it once.
 */
function checksCollection(db: DatabaseHandle = database) {
  return db.db.collection(CHECKS) as unknown as Collection<Record<string, unknown> & { _id: string }>;
}

function healthCollection(db: DatabaseHandle = database) {
  return db.db.collection(HEALTH) as unknown as Collection<SourceHealthDoc>;
}

function policiesCollection(db: DatabaseHandle = database) {
  return db.db.collection(POLICIES) as unknown as Collection<Record<string, unknown> & { _id: string }>;
}

async function healthRow(sourceId: string): Promise<SourceHealthDoc> {
  const row = await healthCollection().findOne({ _id: sourceId });
  if (row === null) throw new Error('health row missing');
  return row;
}

/* --------------------------------------------------------------------- suite */

const skip = !(await mongoAvailable());

describe.skipIf(skip)('verification scheduler (real MongoDB)', () => {
  it('never exceeds the per-host concurrency limit', async () => {
    await plantSources(Array.from({ length: 8 }, () => ({ host: 'one.test.invalid' })));
    const validator = new FakeValidator(20, healthy);
    const { scheduler } = makeScheduler(validator, {
      concurrency: 8,
      perHostConcurrency: 2,
      perHostPlanLimit: 8,
    });

    const counts = await scheduler.runRound(new Date());

    expect(counts.planned).toBe(8);
    expect(counts.healthy).toBe(8);
    expect(validator.requests).toHaveLength(8);
    // The per-host limit of 2 held for the entire round, measured at the validator.
    expect(validator.peak).toBeLessThanOrEqual(2);
    expect(counts.peakInFlight).toBeLessThanOrEqual(2);
    expect(counts.peakInFlightByHost).toBeLessThanOrEqual(2);
    // It really ran in parallel: a serial loop would peak at 1.
    expect(counts.peakInFlight).toBe(2);
  });

  it('bounds the global limit across many hosts', async () => {
    await plantSources(Array.from({ length: 12 }, (_, index) => ({ host: `h${index}.test.invalid` })));
    const validator = new FakeValidator(12, healthy);
    const { scheduler } = makeScheduler(validator, {
      concurrency: 3,
      perHostConcurrency: 2,
      perHostPlanLimit: 12,
    });

    const counts = await scheduler.runRound(new Date());

    expect(counts.healthy).toBe(12);
    expect(validator.peak).toBeLessThanOrEqual(3);
    expect(counts.peakInFlight).toBeLessThanOrEqual(3);
  });

  it('retries a timeout up to the cap and then stops', async () => {
    await plantSources([{ host: 'timeout.test.invalid' }]);
    const validator = new FakeValidator(0, timeoutResult);
    const { scheduler } = makeScheduler(validator, { maxAttempts: 3, concurrency: 1, perHostConcurrency: 1 });

    const counts = await scheduler.runRound(new Date());

    expect(validator.requests).toHaveLength(3);
    expect(validator.requests.map((request) => request.attempt)).toEqual([1, 2, 3]);
    expect(counts.failed).toBe(1);
    expect(counts.retries).toBe(2);
    /*
     * In t2's row vocabulary the *category* lives in `failure.category`; the
     * `outcome` field is the status vocabulary (`unknown` for a failure), which is
     * exactly how the health ledger treats an interrupted check too.
     */
    const row = (await checksCollection().findOne({ state: 'failed' })) as unknown as {
      outcome: string;
      failure: { category: string; cause: string };
      uncertainty: { leaseExpired: boolean };
    };
    expect(row.failure.category).toBe('timeout');
    expect(row.failure.cause).toBe('network');
    // A completed lease is not an expired one.
    expect(row.uncertainty.leaseExpired).toBe(false);
  });

  it('stops retrying a transient failure as soon as it succeeds', async () => {
    await plantSources([{ host: 'flaky.test.invalid' }]);
    const validator = new FakeValidator(0, (_request, entry) => (entry === 1 ? timeoutResult() : healthy()));
    const { scheduler } = makeScheduler(validator, { maxAttempts: 3, concurrency: 1, perHostConcurrency: 1 });

    const counts = await scheduler.runRound(new Date());

    expect(validator.requests).toHaveLength(2);
    expect(counts.healthy).toBe(1);
    expect(counts.retries).toBe(1);
  });

  it('does not retry a permanent 404 even when the cap allows it', async () => {
    await plantSources([{ host: 'gone.test.invalid' }]);
    const validator = new FakeValidator(0, notFound);
    const { scheduler } = makeScheduler(validator, { maxAttempts: 3, concurrency: 1, perHostConcurrency: 1 });

    const counts = await scheduler.runRound(new Date());

    expect(validator.requests).toHaveLength(1);
    expect(counts.failed).toBe(1);
    expect(counts.retries).toBe(0);
    const row = (await checksCollection().findOne({})) as unknown as { failure: { category: string } };
    expect(row.failure.category).toBe('http-404');
  });

  it('asks for HEAD-before-GET, never segment sampling first, never browser depth', async () => {
    await plantSources([{ host: 'probe.test.invalid' }]);
    const validator = new FakeValidator(0, healthy);
    const { scheduler } = makeScheduler(validator, { concurrency: 1, perHostConcurrency: 1 });
    await scheduler.runRound(new Date());

    const request = validator.requests[0];
    expect(request).toBeDefined();
    expect(request?.headFirst).toBe(true);
    // Segments are never requested before a manifest has passed.
    expect(request?.requireSegments).toBe(false);
    // Browser verification is manual-only: a scheduled round never asks for it.
    expect(request?.browser).toBe(false);
  });

  it('opens a circuit after five failures and the sixth call never reaches the validator', async () => {
    const [source] = await plantSources([{ host: 'breaker.test.invalid' }]);
    const validator = new FakeValidator(0, notFound);
    const { scheduler } = makeScheduler(validator, { concurrency: 1, perHostConcurrency: 1, maxAttempts: 1 });

    /*
     * `applyToAggregate` moves `nextCheckAt` forward after each terminal check, so
     * every iteration makes the source due again: this is five *separate* checks,
     * which is what a real scheduler experiences over time.
     */
    for (let round = 0; round < 5; round += 1) {
      await makeDue(source!.id);
      await scheduler.runRound(new Date(Date.now() + round * 1_000));
    }
    expect(validator.requests).toHaveLength(5);
    // The circuit is visible on the aggregated row an operator reads.
    const health = await healthRow(source!.id);
    expect(health.consecutiveFailures).toBe(5);
    expect(scheduler.breakers.get('source', source!.id).state).toBe('open');

    await makeDue(source!.id);
    const sixth = await scheduler.runRound(new Date(Date.now() + 10_000));

    // The breaker removed it from the plan: the validator was not entered again.
    expect(validator.requests).toHaveLength(5);
    expect(sixth.planned).toBe(0);
    expect(sixth.deferred).toBeGreaterThanOrEqual(1);
  });

  it('admits exactly one half-open probe once the window has elapsed', async () => {
    const [source] = await plantSources([{ host: 'halfopen.test.invalid' }]);
    const validator = new FakeValidator(0, timeoutResult);
    const { scheduler } = makeScheduler(validator, {
      concurrency: 1,
      perHostConcurrency: 1,
      maxAttempts: 1,
      breakers: { threshold: 2, baseWindowMs: 1_000, maxWindowMs: 60_000 },
    });
    const base = Date.now();
    await makeDue(source!.id);
    await scheduler.runRound(new Date(base));
    await makeDue(source!.id);
    await scheduler.runRound(new Date(base + 300));

    /*
     * The circuit opened at base+300 with a 2 s window (base 1 s, first reopen),
     * so it reopens for the next half-open probe only after base+2_300.
     */
    const openedAt = base + 300;
    expect(scheduler.breakers.get('source', source!.id).state).toBe('open');
    const before = validator.requests.length;

    // Still inside the opened window: nothing runs, and no probe is consumed.
    await makeDue(source!.id);
    await scheduler.runRound(new Date(openedAt + 500));
    expect(validator.requests.length).toBe(before);

    // Window elapsed: exactly one probe is admitted.
    await makeDue(source!.id);
    const probe = await scheduler.runRound(new Date(openedAt + 2_500));
    expect(validator.requests.length).toBe(before + 1);
    expect(probe.planned).toBe(1);

    // The probe was single: a second round inside the new window runs nothing.
    await makeDue(source!.id);
    await scheduler.runRound(new Date(openedAt + 2_700));
    expect(validator.requests.length).toBe(before + 1);
  });

  it('pause stops scheduling and keeps the history', async () => {
    const [source] = await plantSources([{ host: 'paused.test.invalid' }]);
    const validator = new FakeValidator(0, healthy);
    const { scheduler, queue } = makeScheduler(validator, { concurrency: 1, perHostConcurrency: 1 });

    await scheduler.runRound(new Date());
    const beforePause = await healthRow(source!.id);
    expect(beforePause.history.length).toBeGreaterThan(0);
    const historyBefore = clone(beforePause.history);

    const controls = controlsFor(queue);
    const paused = await controls.pauseSource(
      source!.id,
      { type: 'user', id: 'operator@tdt.invalid' },
      'maintenance',
      'req-1',
    );
    expect(paused.auditId).not.toBe('');

    const afterPause = await healthRow(source!.id);
    expect(afterPause.status).toBe('paused');
    // A pause is not a data loss: every sample and counter survives it.
    expect(clone(afterPause.history)).toEqual(historyBefore);
    expect(afterPause.consecutiveSuccesses).toBe(beforePause.consecutiveSuccesses);
    expect(new Date(afterPause.lastSuccessAt!).toISOString()).toBe(new Date(beforePause.lastSuccessAt!).toISOString());

    const calls = validator.requests.length;
    const round = await scheduler.runRound(new Date(Date.now() + 60_000));
    expect(round.planned).toBe(0);
    expect(validator.requests.length).toBe(calls);

    const audit = await database.collection<AuditDoc>(COLLECTIONS.audits).findOne({ action: 'verification.source.pause' });
    expect(audit).not.toBeNull();
    expect(audit?.actor.id).toBe('operator@tdt.invalid');
    expect(audit?.reason).toBe('maintenance');

    // Resuming restores the status the history implies and makes it due again.
    await controls.resumeSource(source!.id, { type: 'user', id: 'operator@tdt.invalid' }, 'back', 'req-2');
    const resumed = await healthRow(source!.id);
    expect(resumed.status).toBe('healthy');
    expect(clone(resumed.history)).toEqual(historyBefore);

    const afterResume = await scheduler.runRound(new Date(Date.now() + 120_000));
    expect(afterResume.planned).toBe(1);
    expect(afterResume.healthy).toBe(1);
  });

  it('pause-all stops the whole round and is audited', async () => {
    const placed = await plantSources([{ host: 'a.test.invalid' }, { host: 'b.test.invalid' }]);
    const validator = new FakeValidator(0, healthy);
    const { scheduler, queue } = makeScheduler(validator, { concurrency: 2, perHostConcurrency: 1 });
    const controls = controlsFor(queue);

    await controls.pauseAll({ type: 'user', id: 'admin@tdt.invalid' }, 'incident', 'req-pause-all');
    const round = await scheduler.runRound(new Date());
    expect(round.planned).toBe(0);
    expect(validator.requests).toHaveLength(0);

    const policies = await database.db.collection(POLICIES).find({}).toArray();
    expect(policies.some((row) => (row as unknown as { scope: string }).scope === 'global')).toBe(true);
    const audit = await database
      .collection<AuditDoc>(COLLECTIONS.audits)
      .findOne({ action: 'verification.pause', entityType: 'global' });
    expect(audit).not.toBeNull();

    await controls.resumeAll({ type: 'user', id: 'admin@tdt.invalid' }, 'resolved', 'req-resume-all');
    // The sources were never scheduled while paused, so they are still due.
    for (const source of placed) await makeDue(source.id);
    const resumed = await scheduler.runRound(new Date(Date.now() + 1_000));
    // Both sources are checked again; any third entry would be a scheduling bug.
    expect(resumed.healthy).toBe(2);
    expect(validator.requests.length).toBe(2);
  });

  it('writes a manual retry with its reason to the audit log', async () => {
    const [source] = await plantSources([{ host: 'manual.test.invalid' }]);
    const { queue } = makeScheduler(new FakeValidator(0, healthy), { concurrency: 1, perHostConcurrency: 1 });
    const fixed = new Date('2026-11-17T12:00:00.000Z');
    const controls = controlsFor(queue, () => fixed);

    const result = await controls.manualRetry(
      source!.id,
      { type: 'user', id: 'ops@tdt.invalid' },
      'viewer reported a black screen',
      'req-retry-1',
    );
    expect(result.checkId).toBe(checkId(source!.id, fixed));

    const audit = await database.collection<AuditDoc>(COLLECTIONS.audits).findOne({ action: 'verification.source.retry' });
    expect(audit).not.toBeNull();
    expect(audit?.reason).toBe('viewer reported a black screen');
    expect(audit?.actor.id).toBe('ops@tdt.invalid');
    expect(audit?.requestId).toBe('req-retry-1');
    expect(audit?.before).toBeNull();
    expect((audit?.after as { scheduledFor?: string }).scheduledFor).toBe(fixed.toISOString());

    const check = (await checksCollection().findOne({ _id: result.checkId })) as unknown as {
      kind: string;
      trigger: { reason: string };
    };
    expect(check.kind).toBe('manual');
    expect(check.trigger.reason).toBe('viewer reported a black screen');
    expect(await controls.switches()).toEqual({ all: false, providers: [] });
  });

  it('refuses a manual retry without a reason', async () => {
    const [source] = await plantSources([{ host: 'noreason.test.invalid' }]);
    const { queue } = makeScheduler(new FakeValidator(0, healthy));
    const controls = controlsFor(queue);
    await expect(
      controls.manualRetry(source!.id, { type: 'user', id: 'ops@tdt.invalid' }, 'no', 'req-x'),
    ).rejects.toThrow(/reason/i);
  });

  it('reconciles an expired lease as failed without touching the aggregated health', async () => {
    const [source] = await plantSources([{ host: 'stuck.test.invalid' }]);
    const { scheduler, queue } = makeScheduler(new FakeValidator(0, healthy), { concurrency: 1, perHostConcurrency: 1 });

    // A previous process claimed the check and died: running, lease expired.
    // `claimCheck` is t2's ledger entry point, so the row has the full schema.
    const scheduledFor = new Date(Date.now() - 121_000);
    const id = checkId(source!.id, scheduledFor);
    const claimed = await claimCheck(healthCollections(database), {
      sourceId: source!.id,
      scheduledFor,
      owner: 'dead-process',
      leaseTtlMs: 1_000,
      origin: { egressHost: 'test', region: null, userAgent: 'spec', policy: 'test' },
      eligibilityAt: {
        playable: true,
        verdict: 'test',
        reason: null,
        publicationReason: null,
        authorizationReason: null,
        at: scheduledFor,
      },
      now: new Date(scheduledFor.getTime() - 1_000),
    });
    expect(claimed.claimed).toBe(true);
    // Age the lease so `reconcile` sees an abandoned check.
    await checksCollection().updateOne(
      { _id: id },
      { $set: { state: 'running', lease: { owner: 'dead-process', expiresAt: new Date(Date.now() - 60_000) } } },
    );
    const healthBefore = await healthRow(source!.id);

    const report = await scheduler.reconcile(new Date());

    expect(report.reclaimed).toBe(1);
    expect(report.owners).toContain('dead-process');
    const row = (await checksCollection().findOne({ _id: id })) as unknown as {
      state: string;
      outcome: string;
      uncertainty: { leaseExpired: boolean };
      failure: { category: string };
    };
    expect(row.state).toBe('failed');
    // t2's ledger writes the neutral `unknown` outcome and the failure category.
    expect(row.outcome).toBe('unknown');
    expect(row.failure.category).toBe('unknown-error');
    expect(row.uncertainty.leaseExpired).toBe(true);

    // The load-bearing assertion: a lease that ran out is not evidence about the source.
    const healthAfter = await healthRow(source!.id);
    expect(healthAfter.status).toBe(healthBefore.status);
    expect(healthAfter.consecutiveFailures).toBe(healthBefore.consecutiveFailures);
    expect(healthAfter.consecutiveSuccesses).toBe(healthBefore.consecutiveSuccesses);
    expect(healthAfter.revision).toBe(healthBefore.revision);
    expect(clone(healthAfter.history)).toEqual(clone(healthBefore.history));
  });

  it('loses no work across release then recover then re-enqueue', async () => {
    const [source] = await plantSources([{ host: 'release.test.invalid' }]);
    const validator = new FakeValidator(0, healthy);
    const { scheduler, queue } = makeScheduler(validator, { concurrency: 1, perHostConcurrency: 1 });

    const scheduledFor = new Date(Date.now() - 5_000).toISOString();
    await queue.enqueue({ sourceId: source!.id, scheduledFor, kind: 'scheduled' });
    const id = checkId(source!.id, scheduledFor);

    // 1. A worker claims it and hands it back (crash before it finished).
    const claim = await queue.claim('worker-a', 30_000);
    expect(claim.item?.id).toBe(id);
    await queue.release(id);
    expect(await queue.depth()).toBe(1);

    // 2. A restart reconciles: the released row is re-queued, not lost.
    const report = await scheduler.reconcile(new Date());
    expect(report.requeued).toBeGreaterThanOrEqual(1);
    expect(await queue.depth()).toBe(1);

    // 3. The next round picks it up and it reaches a terminal outcome.
    await makeDue(source!.id);
    const round = await scheduler.runRound(new Date());
    expect(round.planned).toBe(1);
    expect(round.healthy).toBe(1);

    /*
     * Idempotency, stated precisely: the *released* row still exists under its
     * deterministic id (nothing was dropped), and the round wrote its own check
     * for its own scheduled instant. Both rows are terminal or pending, none was
     * silently merged into another source's work.
     */
    const rows = await checksCollection().find({ _id: { $in: [id] } }).toArray();
    expect(rows).toHaveLength(1);
    const finalRows = await checksCollection().find({ sourceId: source!.id, state: 'done' }).toArray();
    expect(finalRows.length).toBeGreaterThanOrEqual(1);
  });

  it('enqueue is idempotent on the deterministic check id', async () => {
    const [source] = await plantSources([{ host: 'idem.test.invalid' }]);
    const queue = new MongoQueue({ database });
    const scheduledFor = new Date().toISOString();
    await queue.enqueue({ sourceId: source!.id, scheduledFor, kind: 'scheduled' });
    await queue.enqueue({ sourceId: source!.id, scheduledFor, kind: 'scheduled' });
    await queue.enqueue({ sourceId: source!.id, scheduledFor, kind: 'scheduled' });
    expect(await database.db.collection(CHECKS).countDocuments({})).toBe(1);
    expect(await queue.depth()).toBe(1);
  });

  it('two claimers never win the same item', async () => {
    const [source] = await plantSources([{ host: 'claim.test.invalid' }]);
    const queue = new MongoQueue({ database });
    await queue.enqueue({ sourceId: source!.id, scheduledFor: new Date().toISOString(), kind: 'scheduled' });

    const claims = await Promise.all([queue.claim('worker-1', 30_000), queue.claim('worker-2', 30_000)]);
    expect(claims.filter((claim) => claim.item !== null)).toHaveLength(1);
    expect(claims.filter((claim) => claim.item === null)).toHaveLength(1);
  });

  it('status counts and depth reflect the stored rows', async () => {
    const [source] = await plantSources([{ host: 'counts.test.invalid' }]);
    const queue = new MongoQueue({ database });
    await queue.enqueue({ sourceId: source!.id, scheduledFor: '2026-11-17T10:00:00.000Z', kind: 'scheduled' });
    await queue.enqueue({ sourceId: source!.id, scheduledFor: '2026-11-17T11:00:00.000Z', kind: 'scheduled' });
    await queue.claim('worker', 30_000);

    const counts = await queue.statusCounts();
    expect(counts.running).toBe(1);
    expect(counts.pending).toBe(1);
    expect(await queue.depth()).toBe(1);
  });

  it('reports a Redis outage as degraded and keeps working on the Mongo path', async () => {
    const [source] = await plantSources([{ host: 'redis.test.invalid' }]);
    const unreachable = async (): Promise<never> => {
      throw new Error('ECONNREFUSED redis://cache:6379');
    };
    const queue = new RedisQueue({
      database,
      client: {
        zadd: unreachable,
        zrangebyscore: unreachable,
        zrem: unreachable,
        zcard: unreachable,
        zscore: unreachable,
      },
    });

    const enqueued = await queue.enqueue({ sourceId: source!.id, scheduledFor: new Date().toISOString() });

    // No throw, and the outage is reported rather than silently swallowed.
    expect(enqueued.sourceId).toBe(source!.id);
    expect(queue.name).toBe('redis');
    expect(queue.degraded).toBe(true);
    expect(queue.lastError).not.toContain('redis://');

    const claim = await queue.claim('worker', 30_000);
    expect(claim.item?.sourceId).toBe(source!.id);
  });

  it('exposes bounded metric labels and never a URL', async () => {
    await plantSources([{ host: 'secret-cdn.test.invalid' }]);
    const { scheduler, metrics } = makeScheduler(new FakeValidator(0, notFound), {
      concurrency: 1,
      perHostConcurrency: 1,
    });
    await scheduler.runRound(new Date());

    const text = metrics.render();
    expect(text).toContain('tdt_verification_checks_total');
    expect(text).toContain('tdt_verification_egress_requests_total');
    expect(text).toContain('tdt_verification_check_latency_ms_bucket');
    expect(text).toContain('host_bucket="h');
    // The three things that must never appear in an exposition.
    expect(text).not.toContain('secret-cdn');
    expect(text).not.toContain('https://');
    expect(text).not.toContain('.m3u8');
  });
});

describe('bounded semaphore (pure)', () => {
  it('never admits more than the global limit', async () => {
    const gate = new BoundedSemaphore(2);
    /*
     * The third acquire must *stay pending* — awaiting it before releasing
     * anything would deadlock by construction (nothing else could free a slot).
     * So the assertion is on the waiter being queued, then on it being admitted
     * only after a release.
     */
    const first = await gate.acquire('a');
    const second = await gate.acquire('b');
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(gate.inFlight).toBe(2);

    let thirdSettled = false;
    const third = gate.acquire('a').then((release) => {
      thirdSettled = true;
      return release;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Still waiting: the global limit of 2 is honoured, never exceeded.
    expect(thirdSettled).toBe(false);
    expect(gate.waitingCount).toBe(1);
    expect(gate.inFlight).toBe(2);

    first?.();
    const thirdRelease = await third;
    expect(thirdRelease).not.toBeNull();
    expect(gate.inFlight).toBe(2);
    // The peak is exactly the limit, never above it.
    expect(gate.peakObserved).toBe(2);
    second?.();
    thirdRelease?.();
    expect(gate.inFlight).toBe(0);
  });

  it('never admits more than the per-key limit', async () => {
    const gate = new BoundedSemaphore(10, 1);
    const first = await gate.acquire('host-a');
    expect(first).not.toBeNull();
    let secondSettled = false;
    const second = gate.acquire('host-a').then((release) => {
      secondSettled = true;
      return release;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(secondSettled).toBe(false);
    const otherHost = await gate.acquire('host-b');
    expect(otherHost).not.toBeNull();
    first?.();
    expect(await second).not.toBeNull();
    expect(gate.peakFor('host-a')).toBe(1);
  });

  it('drops a waiter that aborts', async () => {
    const gate = new BoundedSemaphore(1);
    const held = await gate.acquire('k');
    const controller = new AbortController();
    const pending = gate.acquire('k', controller.signal);
    controller.abort();
    expect(await pending).toBeNull();
    held?.();
    expect(gate.inFlight).toBe(0);
  });
});
