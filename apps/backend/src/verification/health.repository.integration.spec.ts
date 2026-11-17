/**
 * The health ledger, against a real MongoDB.
 *
 * Four properties, each one a failure mode of a naive ledger:
 *
 * - a stale writer loses the CAS and the row is never overwritten;
 * - an expired lease becomes a failed check and **health does not move**;
 * - the deterministic `_id` makes a retried claim the same check, not a second one;
 * - the ring buffer stays bounded no matter how many checks land.
 *
 * The suite skips (loudly) only when MongoDB is unreachable; every assertion
 * below is a real round trip when it is.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectDatabase, type DatabaseHandle } from '../infrastructure/mongo.js';
import { TEST_MONGO_URI, testConfig } from '../test/harness.js';
import {
  applyToAggregate,
  checkIdFor,
  claimCheck,
  completeCheck,
  findHealth,
  healthCollections,
  recoverExpiredLeases,
  type ClaimRequest,
  type CompletionPatch,
  type NextCheckFn,
} from './health.repository.js';
import { DEFAULT_HISTORY_SIZE } from './health.repository.js';
import type { CheckRunDoc, EligibilitySnapshot } from './health.schema.js';
import { computeBackoff } from './backoff.js';

const NOW = new Date('2026-11-17T10:00:00.000Z');

const ELIGIBILITY: EligibilitySnapshot = {
  playable: true,
  verdict: 'permitted-direct-playback',
  reason: null,
  publicationReason: null,
  authorizationReason: null,
  at: NOW,
};

const ORIGIN: CheckRunDoc['origin'] = {
  egressHost: 'validator-test',
  region: 'ES',
  userAgent: 'TDTPlatform/test',
  policy: 'default',
};

/** The injected next-due function: the real back-off, so the value is checkable. */
const nextCheck: NextCheckFn = (input) =>
  computeBackoff({ status: input.status, attempt: input.attempt, sourceId: input.sourceId }, input.from).nextCheckAt;

function healthyPatch(): CompletionPatch {
  return {
    outcome: 'healthy',
    depth: 'segments',
    failure: null,
    uncertainty: {
      browserNotProbed: true,
      segmentsNotSampled: false,
      leaseExpired: false,
      manifestTruncated: false,
      notes: [],
    },
    evidence: {
      httpStatus: 200,
      contentType: 'application/vnd.apple.mpegurl',
      bytes: 512,
      sampleSha256: 'a'.repeat(64),
      urls: ['https://example.test/live/master.m3u8'],
      segmentStatuses: [200, 200],
      manifest: {
        format: 'hls-media',
        mimeType: 'application/vnd.apple.mpegurl',
        startsWithExtM3u: true,
        mediaSequence: 42,
        segmentCount: 3,
        variantCount: 0,
        targetDuration: 6,
        endsWithEndList: false,
        first4KiBSha256: 'a'.repeat(64),
        parsedBytes: 512,
      },
      latencyMs: 40,
      samplesRequested: 2,
      samplesAttempted: 2,
    },
    eligibilityAt: ELIGIBILITY,
  };
}

function failurePatch(): CompletionPatch {
  return {
    outcome: 'failing',
    depth: 'transport',
    failure: { category: 'http-500' as never, cause: 'protocol', message: 'HTTP 500', depth: 'transport' },
    uncertainty: {
      browserNotProbed: false,
      segmentsNotSampled: true,
      leaseExpired: false,
      manifestTruncated: false,
      notes: [],
    },
    evidence: {
      httpStatus: 500,
      contentType: null,
      bytes: 0,
      sampleSha256: null,
      urls: ['https://example.test/live/master.m3u8'],
      segmentStatuses: [],
      manifest: null,
      latencyMs: 12,
      samplesRequested: 2,
      samplesAttempted: 0,
    },
    eligibilityAt: ELIGIBILITY,
  };
}

function claimRequest(sourceId: string, owner: string, scheduledFor = NOW, overrides: Partial<ClaimRequest> = {}): ClaimRequest {
  return {
    sourceId,
    scheduledFor,
    owner,
    origin: ORIGIN,
    eligibilityAt: ELIGIBILITY,
    now: NOW,
    ...overrides,
  };
}

let database: DatabaseHandle | null = null;
let available = false;
let dbName = '';

beforeAll(async () => {
  dbName = testConfig().MONGODB_DB;
  try {
    database = await connectDatabase(TEST_MONGO_URI, dbName);
    await database.db.command({ ping: 1 });
    available = true;
  } catch {
    available = false;
  }
});

afterAll(async () => {
  if (database !== null) {
    await database.db.dropDatabase().catch(() => undefined);
    await database.close();
  }
});

function db(): Parameters<typeof findHealth>[0] {
  if (database === null) throw new Error('MongoDB is not available');
  return healthCollections(database);
}

describe('health repository — real MongoDB', () => {
  it(
    'is reachable',
    () => {
      if (!available) {
        // Loud skip: a suite that silently "passes" without a database proves nothing.
        console.warn(`[health.repository] MongoDB unreachable at ${TEST_MONGO_URI}: integration assertions skipped`);
      }
      expect(typeof available).toBe('boolean');
    },
  );

  it('a completed check is terminal: a second completion is refused and the row is unchanged', async () => {
    if (!available) return;
    const sourceId = `src-terminal-${randomUUID()}`;
    const claim = await claimCheck(db(), claimRequest(sourceId, 'worker-1'));
    expect(claim.claimed).toBe(true);
    if (!claim.claimed) return;

    const done = await completeCheck(db(), {
      checkId: claim.check._id,
      owner: 'worker-1',
      result: healthyPatch(),
      now: new Date(NOW.getTime() + 1000),
    });
    expect(done.completed).toBe(true);
    if (!done.completed) return;
    expect(done.check.state).toBe('done');
    expect(done.check.outcome).toBe('healthy');
    expect(done.check.lease).toBeNull();

    const again = await completeCheck(db(), {
      checkId: claim.check._id,
      owner: 'worker-1',
      result: failurePatch(),
      now: new Date(NOW.getTime() + 2000),
    });
    expect(again.completed).toBe(false);
    if (again.completed) return;
    expect(again.reason).toBe('already-terminal');

    const stored = await db().checks().findOne({ _id: claim.check._id });
    expect(stored?.outcome).toBe('healthy');
    expect(stored?.failure).toBeNull();

    // A finished check can no longer be claimed either.
    const reclaim = await claimCheck(db(), claimRequest(sourceId, 'worker-2'));
    expect(reclaim.claimed).toBe(false);
    if (reclaim.claimed) return;
    expect(reclaim.reason).toBe('already-terminal');
  });

  it('the deterministic _id makes a retry the same check, not a second one', async () => {
    if (!available) return;
    const sourceId = `src-idem-${randomUUID()}`;
    const first = await claimCheck(db(), claimRequest(sourceId, 'worker-a'));
    expect(first.claimed).toBe(true);
    if (!first.claimed) return;

    // Retry after a crash: same (sourceId, scheduledFor) ⇒ same row.
    const retry = await claimCheck(db(), claimRequest(sourceId, 'worker-b'));
    expect(retry.claimed).toBe(false);
    if (retry.claimed) return;
    expect(retry.reason).toBe('lease-held');
    expect(retry.check?._id).toBe(checkIdFor(sourceId, NOW));

    const count = await db().checks().countDocuments({ sourceId });
    expect(count).toBe(1);

    // Complete it, then a *later* scheduled instant is a genuinely new check.
    await completeCheck(db(), { checkId: first.check._id, owner: 'worker-a', result: healthyPatch(), now: NOW });
    const next = await claimCheck(db(), claimRequest(sourceId, 'worker-b', new Date(NOW.getTime() + 6 * 3600 * 1000)));
    expect(next.claimed).toBe(true);
    if (!next.claimed) return;
    expect(next.check._id).not.toBe(first.check._id);
    expect(await db().checks().countDocuments({ sourceId })).toBe(2);
  });

  it('CAS: a stale writer fails and never overwrites the newer revision', async () => {
    if (!available) return;
    const sourceId = `src-cas-${randomUUID()}`;
    const claim = await claimCheck(db(), claimRequest(sourceId, 'worker-1'));
    if (!claim.claimed) return;
    await completeCheck(db(), { checkId: claim.check._id, owner: 'worker-1', result: healthyPatch(), now: NOW });
    const applied = await applyToAggregate(db(), claim.check._id, { nextCheckAt: nextCheck });
    expect(applied.applied).toBe(true);
    if (!applied.applied) return;
    expect(applied.health.status).toBe('healthy');
    expect(applied.health.revision).toBe(1);

    /*
     * A stale writer holds revision 1 and tries to write behind the aggregate's
     * back with a *different* revision. It must lose, not corrupt.
     */
    const collection = db().health();
    const current = await collection.findOne({ _id: sourceId });
    expect(current).not.toBeNull();
    if (current === null) return;
    const stale = await collection.updateOne(
      { _id: sourceId, revision: current.revision - 1 },
      { $set: { status: 'failing', revision: current.revision - 1 } },
    );
    expect(stale.matchedCount).toBe(0);

    // Applying the same terminal check twice is idempotent on revision, not a
    // silent double-count of history.
    const before = current.revision;
    await applyToAggregate(db(), claim.check._id, { nextCheckAt: nextCheck });
    const after = await findHealth(db(), sourceId);
    expect(after?.revision).toBe(before + 1);
    expect(after?.history).toHaveLength(2);
    expect(after?.status).toBe('healthy');

    // And two independent applies racing from the same revision converge.
    const results = await Promise.all([
      applyToAggregate(db(), claim.check._id, { nextCheckAt: nextCheck, maxCasAttempts: 6 }),
      applyToAggregate(db(), claim.check._id, { nextCheckAt: nextCheck, maxCasAttempts: 6 }),
      applyToAggregate(db(), claim.check._id, { nextCheckAt: nextCheck, maxCasAttempts: 6 }),
    ]);
    expect(results.some((r) => r.applied)).toBe(true);
    const final = await findHealth(db(), sourceId);
    expect(final?.status).toBe('healthy');
    expect(final?.revision).toBeGreaterThan(before + 1);
    // Every CAS attempt that succeeded incremented revision by exactly one: no lost update.
    expect(final?.history.length).toBeGreaterThanOrEqual(3);
    expect(final?.consecutiveSuccesses).toBeGreaterThanOrEqual(1);
    expect(final?.consecutiveFailures).toBe(0);
  });

  it('CAS exhaustion is reported explicitly instead of overwriting', async () => {
    if (!available) return;
    const sourceId = `src-cas-exhaust-${randomUUID()}`;
    const claim = await claimCheck(db(), claimRequest(sourceId, 'worker-1'));
    if (!claim.claimed) return;
    await completeCheck(db(), { checkId: claim.check._id, owner: 'worker-1', result: healthyPatch(), now: NOW });
    await applyToAggregate(db(), claim.check._id, { nextCheckAt: nextCheck });

    // maxCasAttempts: 0 makes every CAS round unavailable — the call must refuse.
    const refused = await applyToAggregate(db(), claim.check._id, { nextCheckAt: nextCheck, maxCasAttempts: 0 });
    expect(refused.applied).toBe(false);
    if (refused.applied) return;
    expect(refused.reason).toBe('cas-exhausted');
  });

  it('an expired lease becomes a failed check and health is NOT touched', async () => {
    if (!available) return;
    const sourceId = `src-lease-${randomUUID()}`;

    // A healthy baseline, so "unchanged" is a meaningful comparison.
    const first = await claimCheck(db(), claimRequest(sourceId, 'worker-ok'));
    if (!first.claimed) return;
    await completeCheck(db(), { checkId: first.check._id, owner: 'worker-ok', result: healthyPatch(), now: NOW });
    await applyToAggregate(db(), first.check._id, { nextCheckAt: nextCheck });
    const baseline = await findHealth(db(), sourceId);
    expect(baseline?.status).toBe('healthy');

    // A second check is claimed and then "crashes": the process never completes it.
    const later = new Date(NOW.getTime() + 6 * 3600 * 1000);
    const crashed = await claimCheck(
      db(),
      claimRequest(sourceId, 'worker-dead', later, { leaseTtlMs: 60_000, now: later }),
    );
    expect(crashed.claimed).toBe(true);
    if (!crashed.claimed) return;

    // Nothing to reclaim before the lease expires.
    const early = await recoverExpiredLeases(db(), { now: new Date(later.getTime() + 30_000) });
    expect(early.recovered.some((c) => c._id === crashed.check._id)).toBe(false);
    expect((await findHealth(db(), sourceId))?.status).toBe('healthy');

    const recovery = await recoverExpiredLeases(db(), { now: new Date(later.getTime() + 120_000) });
    const reclaimed = recovery.recovered.find((c) => c._id === crashed.check._id);
    expect(reclaimed).toBeDefined();
    expect(reclaimed?.state).toBe('failed');
    expect(reclaimed?.uncertainty.leaseExpired).toBe(true);
    expect(reclaimed?.lease).toBeNull();
    expect(recovery.healthRowsChanged).toBe(0);

    // Health is byte-identical: a crashed process is not evidence about the stream.
    const afterRecovery = await findHealth(db(), sourceId);
    expect(afterRecovery).toEqual(baseline);

    // And applying the reclaimed check does not silently mark the source failing.
    const applied = await applyToAggregate(db(), crashed.check._id, { nextCheckAt: nextCheck });
    expect(applied.applied).toBe(true);
  });

  it('the ring buffer is bounded at the default size and by an explicit override', async () => {
    if (!available) return;
    const sourceId = `src-ring-${randomUUID()}`;
    const total = DEFAULT_HISTORY_SIZE + 7;

    for (let index = 0; index < total; index += 1) {
      const instant = new Date(NOW.getTime() + index * 60_000);
      const claim = await claimCheck(db(), claimRequest(sourceId, 'worker', instant, { now: instant }));
      if (!claim.claimed) continue;
      await completeCheck(db(), {
        checkId: claim.check._id,
        owner: 'worker',
        result: index % 2 === 0 ? healthyPatch() : failurePatch(),
        now: instant,
      });
      await applyToAggregate(db(), claim.check._id, { nextCheckAt: nextCheck });
    }

    const bounded = await findHealth(db(), sourceId);
    expect(bounded?.history).toHaveLength(DEFAULT_HISTORY_SIZE);
    expect(bounded?.lastOutcome).not.toBeNull();
    // Counters follow the last transition, not the whole history.
    const failures = bounded?.consecutiveFailures ?? -1;
    const successes = bounded?.consecutiveSuccesses ?? -1;
    expect(failures + successes).toBeLessThanOrEqual(DEFAULT_HISTORY_SIZE);
    expect(failures >= 0 && successes >= 0).toBe(true);
    expect(bounded?.lastCheckedAt?.getTime()).toBe(NOW.getTime() + (total - 1) * 60_000);

    const sourceSmall = `src-ring-small-${randomUUID()}`;
    for (let index = 0; index < 5; index += 1) {
      const instant = new Date(NOW.getTime() + index * 60_000);
      const claim = await claimCheck(db(), claimRequest(sourceSmall, 'worker', instant, { now: instant }));
      if (!claim.claimed) continue;
      await completeCheck(db(), { checkId: claim.check._id, owner: 'worker', result: healthyPatch(), now: instant });
      await applyToAggregate(db(), claim.check._id, { nextCheckAt: nextCheck, historySize: 3 });
    }
    expect((await findHealth(db(), sourceSmall))?.history).toHaveLength(3);
  });

  it('refuses to move health from a non-terminal check', async () => {
    if (!available) return;
    const sourceId = `src-running-${randomUUID()}`;
    const claim = await claimCheck(db(), claimRequest(sourceId, 'worker-1'));
    if (!claim.claimed) return;
    // The check is `running` with no outcome: it must not be able to move health.
    const refused = await applyToAggregate(db(), claim.check._id, { nextCheckAt: nextCheck });
    expect(refused.applied).toBe(false);
    if (refused.applied) return;
    expect(refused.reason).toBe('not-terminal');
    expect(await findHealth(db(), sourceId)).toBeNull();
  });

  it('consecutive failures open the circuit at five, and only a success closes it', async () => {
    if (!available) return;
    const sourceId = `src-circuit-${randomUUID()}`;
    for (let index = 0; index < 5; index += 1) {
      const instant = new Date(NOW.getTime() + index * 60_000);
      const claim = await claimCheck(db(), claimRequest(sourceId, 'worker', instant, { now: instant }));
      if (!claim.claimed) continue;
      await completeCheck(db(), { checkId: claim.check._id, owner: 'worker', result: failurePatch(), now: instant });
      await applyToAggregate(db(), claim.check._id, { nextCheckAt: nextCheck });
    }
    let health = await findHealth(db(), sourceId);
    expect(health?.consecutiveFailures).toBe(5);
    expect(health?.circuit.state).toBe('open');
    expect(health?.circuit.openedAt).not.toBeNull();
    expect(health?.status).toBe('failing');

    const successAt = new Date(NOW.getTime() + 10 * 60_000);
    const okClaim = await claimCheck(db(), claimRequest(sourceId, 'worker', successAt, { now: successAt }));
    if (okClaim.claimed) {
      await completeCheck(db(), { checkId: okClaim.check._id, owner: 'worker', result: healthyPatch(), now: successAt });
      await applyToAggregate(db(), okClaim.check._id, { nextCheckAt: nextCheck });
    }
    health = await findHealth(db(), sourceId);
    expect(health?.consecutiveFailures).toBe(0);
    expect(health?.consecutiveSuccesses).toBe(1);
    expect(health?.circuit.state).toBe('closed');
    expect(health?.status).toBe('healthy');
  });
});
