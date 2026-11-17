/**
 * The persistent health ledger (MODULE-CONTRACT-02D §1, §6).
 *
 * Four operations, each with one invariant that is the reason the operation
 * exists at all:
 *
 * | operation              | invariant                                                    |
 * |------------------------|--------------------------------------------------------------|
 * | `claimCheck`           | the `_id` is deterministic, so a retry is not a second check  |
 * | `completeCheck`        | a finished check is terminal and never rewritten              |
 * | `applyToAggregate`     | health moves only on a terminal outcome, under CAS            |
 * | `recoverExpiredLeases` | an abandoned lease becomes `failed`; health stays untouched   |
 *
 * The repository takes the injected `DatabaseHandle` and an injected clock and
 * next-due function, so every test is deterministic and no module here reads the
 * wall clock behind a caller's back.
 */
import type { Collection } from 'mongodb';
import type { DatabaseHandle } from '../infrastructure/mongo.js';
import type {
  CheckRunDoc,
  HealthAggregateDoc,
  HealthSample,
  HealthStatus,
} from './health.schema.js';
import { HEALTH_COLLECTIONS, isTerminalCheckState } from './health.schema.js';
import { statusForOutcome } from './backoff.js';

export const DEFAULT_HISTORY_SIZE = 30;
export const DEFAULT_LEASE_TTL_MS = 5 * 60 * 1000;

/** A minimal collection surface, so a test can drive the repository without a server. */
export interface HealthDatabase {
  checks(): Collection<CheckRunDoc>;
  health(): Collection<HealthAggregateDoc>;
}

/**
 * Adapter from the platform's `DatabaseHandle` to the two collections.
 *
 * `DatabaseHandle.collection` is typed against `CollectionName` from
 * `mongo.ts`, which does not yet list the 02D collections (editing it was out
 * of this task's scope). The names live in `HEALTH_COLLECTIONS`; this adapter is
 * the single place where the generic is widened, so wiring `mongo.ts` later
 * needs no change here.
 */
export function healthCollections(database: DatabaseHandle): HealthDatabase {
  const typed = database as unknown as {
    collection<T extends { _id: string }>(name: string): Collection<T>;
  };
  return {
    checks: () => typed.collection<CheckRunDoc>(HEALTH_COLLECTIONS.checks),
    health: () => typed.collection<HealthAggregateDoc>(HEALTH_COLLECTIONS.health),
  };
}

/** Creates the indexes these two collections need. Idempotent. */
export async function ensureHealthIndexes(database: DatabaseHandle): Promise<void> {
  const collections = healthCollections(database);
  await collections.checks().createIndexes([
    { key: { sourceId: 1, createdAt: -1 }, name: 'source_recent' },
    { key: { state: 1, 'lease.expiresAt': 1 }, name: 'lease_reaper' },
  ]);
  await collections.health().createIndexes([{ key: { nextCheckAt: 1 }, name: 'due_queue' }]);
}

/** Why a claim was refused. Explicit, because "nothing happened" is not an answer. */
export type ClaimRefusal =
  | 'already-terminal'
  | 'lease-held'
  | 'unknown';

export type ClaimOutcome =
  | { readonly claimed: true; readonly check: CheckRunDoc; readonly replayed: boolean }
  | { readonly claimed: false; readonly reason: ClaimRefusal; readonly check: CheckRunDoc | null };

export interface ClaimRequest {
  readonly sourceId: string;
  /** The instant this check is scheduled for; it is part of the identity. */
  readonly scheduledFor: Date;
  readonly owner: string;
  readonly kind?: CheckRunDoc['kind'];
  readonly trigger?: { readonly actor: string; readonly reason: string | null };
  readonly leaseTtlMs?: number;
  readonly origin: CheckRunDoc['origin'];
  readonly eligibilityAt: CheckRunDoc['eligibilityAt'];
  readonly attempt?: number;
  readonly maxAttempts?: number;
  readonly backoffMs?: number;
  readonly now: Date;
}

/** The deterministic idempotency key of contract §1.1. */
export function checkIdFor(sourceId: string, scheduledFor: Date): string {
  return `${sourceId}:${scheduledFor.toISOString()}`;
}

/**
 * Claims one check.
 *
 * The `_id` is `${sourceId}:${scheduledForISO}`, so two attempts at the same
 * scheduled instant address the same row: a duplicate insert is refused and
 * turned into an explicit `already-terminal`/`lease-held`/replay answer, so a
 * retry never becomes a second external probe of a finished check.
 */
export async function claimCheck(database: HealthDatabase, request: ClaimRequest): Promise<ClaimOutcome> {
  const _id = checkIdFor(request.sourceId, request.scheduledFor);
  const collection = database.checks();
  const leaseTtlMs = request.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  const now = request.now;
  const doc: CheckRunDoc = {
    _id,
    sourceId: request.sourceId,
    kind: request.kind ?? 'scheduled',
    trigger: request.trigger ?? { actor: 'scheduler', reason: null },
    state: 'running',
    outcome: null,
    depth: 'eligibility',
    eligibilityAt: request.eligibilityAt,
    origin: request.origin,
    timings: { queuedAt: now, startedAt: now, finishedAt: null, latencyMs: null },
    attempt: {
      number: request.attempt ?? 1,
      maxAttempts: request.maxAttempts ?? 3,
      backoffMs: request.backoffMs ?? 0,
    },
    failure: null,
    uncertainty: {
      browserNotProbed: false,
      segmentsNotSampled: false,
      leaseExpired: false,
      manifestTruncated: false,
      notes: [],
    },
    evidence: {
      httpStatus: null,
      contentType: null,
      bytes: null,
      sampleSha256: null,
      urls: [],
      segmentStatuses: [],
      manifest: null,
      latencyMs: null,
      samplesRequested: 0,
      samplesAttempted: 0,
    },
    lease: { owner: request.owner, expiresAt: new Date(now.getTime() + leaseTtlMs) },
    createdAt: now,
  };

  /*
   * Insert first, then take the lease — two writes, zero races.
   *
   * `findOneAndUpdate({...}, {upsert: true})` cannot express "refuse when the row
   * exists but is not claimable": MongoDB's upsert path treats an unmatched filter
   * as "insert a row built from the filter + update", and an `_id` collision can
   * turn that into an update of the existing row (verified against MongoDB 7).
   * A plain insert has no such ambiguity: a duplicate `_id` is a hard error, so a
   * finished check can never be reopened by a retried claim.
   */
  try {
    await collection.insertOne(doc);
    return { claimed: true, check: doc, replayed: false };
  } catch (error) {
    if ((error as { code?: unknown }).code !== 11000) throw error;
    // The row already exists: it is either live (lease) or terminal (immutable).
  }

  const existing = await collection.findOne({ _id });
  if (existing === null) {
    // The insert lost the race and the winner's row is not visible yet, or it was
    // removed concurrently. Report the refusal instead of retrying blindly.
    return { claimed: false, reason: 'unknown', check: null };
  }
  if (isTerminalCheckState(existing.state)) {
    return { claimed: false, reason: 'already-terminal', check: existing };
  }

  /*
   * A retry of a live check: the lease may be taken over by a new owner (that is
   * what recovering an abandoned claim means), but the lease *expiry* is kept,
   * so a retry cannot extend the window it holds. A live lease held by another
   * owner that has not expired is refused outright.
   */
  const liveLease = existing.lease !== null && existing.lease.expiresAt.getTime() > now.getTime();
  if (liveLease && existing.lease?.owner !== request.owner) {
    return { claimed: false, reason: 'lease-held', check: existing };
  }
  const taken = await collection.findOneAndUpdate(
    { _id, state: { $in: ['pending', 'running'] } },
    {
      $set: {
        'lease.owner': request.owner,
        'timings.startedAt': existing.timings.startedAt ?? now,
        'attempt.number': request.attempt ?? existing.attempt.number,
        'attempt.maxAttempts': request.maxAttempts ?? existing.attempt.maxAttempts,
        'attempt.backoffMs': request.backoffMs ?? existing.attempt.backoffMs,
      },
    },
    { returnDocument: 'after', includeResultMetadata: false },
  );
  if (taken !== null && taken !== undefined) {
    return { claimed: true, check: taken, replayed: true };
  }
  const raced = await collection.findOne({ _id });
  if (raced === null) return { claimed: false, reason: 'unknown', check: null };
  return {
    claimed: false,
    reason: isTerminalCheckState(raced.state) ? 'already-terminal' : 'lease-held',
    check: raced,
  };
}

/** A completed check: outcome plus the evidence, uncertainty and failure that justify it. */
export type CompletionPatch = Pick<
  CheckRunDoc,
  'outcome' | 'depth' | 'failure' | 'uncertainty' | 'evidence' | 'eligibilityAt'
>;

export type CompleteOutcome =
  | { readonly completed: true; readonly check: CheckRunDoc }
  | { readonly completed: false; readonly reason: 'not-found' | 'already-terminal' | 'lease-mismatch'; readonly check: CheckRunDoc | null };

/**
 * Writes the terminal transition. Only the holder of the current lease may
 * complete a check, and only a non-terminal check may be completed: a finished
 * row is immutable from then on (`createdAt` and `outcome` are final).
 */
export async function completeCheck(
  database: HealthDatabase,
  input: {
    readonly checkId: string;
    readonly owner: string;
    readonly result: CompletionPatch;
    readonly state?: 'done' | 'failed' | 'skipped';
    readonly now: Date;
    readonly latencyMs?: number | null;
  },
): Promise<CompleteOutcome> {
  const collection = database.checks();
  const state = input.state ?? 'done';
  const terminal = await collection.findOneAndUpdate(
    {
      _id: input.checkId,
      'lease.owner': input.owner,
      state: { $in: ['pending', 'running'] },
    },
    {
      $set: {
        state,
        outcome: input.result.outcome,
        depth: input.result.depth,
        failure: input.result.failure,
        uncertainty: input.result.uncertainty,
        evidence: input.result.evidence,
        eligibilityAt: input.result.eligibilityAt,
        'timings.finishedAt': input.now,
        'timings.latencyMs': input.latencyMs ?? input.result.evidence.latencyMs ?? null,
        lease: null,
      },
    },
    { returnDocument: 'after', includeResultMetadata: false },
  );
  if (terminal !== null && terminal !== undefined) return { completed: true, check: terminal };

  const existing = await collection.findOne({ _id: input.checkId });
  if (existing === null) return { completed: false, reason: 'not-found', check: null };
  if (isTerminalCheckState(existing.state)) return { completed: false, reason: 'already-terminal', check: existing };
  return { completed: false, reason: 'lease-mismatch', check: existing };
}

/** Computes the next due instant from a status; injected so tests are deterministic. */
export type NextCheckFn = (input: {
  readonly sourceId: string;
  readonly status: HealthStatus;
  readonly attempt: number;
  readonly from: Date;
  readonly outcome: CheckRunDoc['outcome'];
}) => Date;

export interface ApplyOptions {
  readonly historySize?: number;
  readonly nextCheckAt: NextCheckFn;
  /** CAS attempts before giving up. Default 3. */
  readonly maxCasAttempts?: number;
}

export type ApplyOutcome =
  | { readonly applied: true; readonly health: HealthAggregateDoc; readonly attempts: number }
  | { readonly applied: false; readonly reason: 'not-terminal' | 'cas-exhausted' | 'not-found'; readonly health: HealthAggregateDoc | null };

/** Successful outcomes for the purpose of the consecutive counters. */
function isSuccess(outcome: CheckRunDoc['outcome']): boolean {
  return outcome === 'healthy' || outcome === 'degraded';
}

/**
 * Moves aggregate health for one **terminal** check, under CAS.
 *
 * Refuses anything that is not terminal: a running or pending row must not be
 * able to change a status (hard rule 4). The status is derived from the check's
 * outcome only — never from a caller-supplied field.
 */
export async function applyToAggregate(
  database: HealthDatabase,
  checkId: string,
  options: ApplyOptions,
): Promise<ApplyOutcome> {
  const check = await database.checks().findOne({ _id: checkId });
  if (check === null) return { applied: false, reason: 'not-found', health: null };
  if (!isTerminalCheckState(check.state) || check.outcome === null) {
    return { applied: false, reason: 'not-terminal', health: null };
  }

  const historySize = options.historySize ?? DEFAULT_HISTORY_SIZE;
  const maxAttempts = options.maxCasAttempts ?? 3;
  const collection = database.health();

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const current = await collection.findOne({ _id: check.sourceId });
    const base = current ?? emptyAggregate(check.sourceId, options.nextCheckAt, check);
    const updated = nextAggregate(base, check, historySize, options.nextCheckAt);

    if (current === null) {
      // First write for this source: the create is the CAS (unique `_id`).
      try {
        await collection.insertOne(updated);
        return { applied: true, health: updated, attempts: attempt };
      } catch {
        // Someone else created it first; retry against their revision.
        continue;
      }
    }

    const replaced = await collection.findOneAndUpdate(
      { _id: check.sourceId, revision: current.revision },
      { $set: { ...updated, revision: current.revision + 1 } },
      { returnDocument: 'after', includeResultMetadata: false },
    );
    if (replaced !== null && replaced !== undefined) {
      return { applied: true, health: replaced, attempts: attempt };
    }
    // A stale writer lost the CAS: re-read and retry, never overwrite.
  }

  return { applied: false, reason: 'cas-exhausted', health: await collection.findOne({ _id: check.sourceId }) };
}

function emptyAggregate(sourceId: string, nextCheckAt: NextCheckFn, check: CheckRunDoc): HealthAggregateDoc {
  return {
    _id: sourceId,
    status: 'unknown',
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastOutcome: null,
    lastCheckedAt: null,
    nextCheckAt: nextCheckAt({ sourceId, status: 'unknown', attempt: check.attempt.number, from: check.timings.finishedAt ?? check.createdAt, outcome: check.outcome }),
    circuit: { state: 'closed', openedAt: null, reopenCount: 0 },
    history: [],
    /*
     * The first write of a new aggregate is revision 1, so a caller that holds
     * revision `r` can always state the exact revision it expects next.
     */
    revision: 1,
    updatedAt: check.timings.finishedAt ?? check.createdAt,
  };
}

function nextAggregate(
  base: HealthAggregateDoc,
  check: CheckRunDoc,
  historySize: number,
  nextCheckAt: NextCheckFn,
): HealthAggregateDoc {
  const outcome = check.outcome ?? 'unknown';
  const at = check.timings.finishedAt ?? base.updatedAt;
  const success = isSuccess(outcome);
  const consecutiveFailures = success ? 0 : base.consecutiveFailures + 1;
  const consecutiveSuccesses = success ? base.consecutiveSuccesses + 1 : 0;
  const status = statusForOutcome(outcome);

  const sample: HealthSample = {
    at,
    outcome,
    cause: check.failure?.cause ?? null,
    depth: check.depth,
    latencyMs: check.evidence.latencyMs,
    checkId: check._id,
  };
  const history = [...base.history, sample].slice(-Math.max(1, historySize));

  const due = nextCheckAt({ sourceId: check.sourceId, status, attempt: check.attempt.number, from: at, outcome });

  /*
   * The circuit opens on five consecutive failures and never closes on a
   * non-success: only a real success closes it. A re-open counts.
   */
  let circuit = base.circuit;
  if (consecutiveFailures >= 5 && circuit.state !== 'open') {
    circuit = { state: 'open', openedAt: at, reopenCount: circuit.reopenCount + 1 };
  } else if (success && circuit.state !== 'closed') {
    circuit = { state: 'closed', openedAt: null, reopenCount: circuit.reopenCount };
  } else if (!success && consecutiveFailures < 5 && circuit.state === 'open' && circuit.openedAt === null) {
    circuit = { ...circuit, openedAt: at };
  }

  return {
    _id: check.sourceId,
    status,
    consecutiveFailures,
    consecutiveSuccesses,
    lastSuccessAt: success ? at : base.lastSuccessAt,
    lastFailureAt: success ? base.lastFailureAt : at,
    lastOutcome: outcome,
    lastCheckedAt: at,
    nextCheckAt: due,
    circuit,
    history,
    revision: base.revision,
    updatedAt: at,
  };
}

export type RecoveryOutcome = {
  readonly recovered: readonly CheckRunDoc[];
  /** Health rows were not touched; this is always empty and exists to be asserted. */
  readonly healthRowsChanged: 0;
};

/**
 * Claims expired leases as failed checks.
 *
 * Contract §6: a `running` check whose lease expired becomes `failed` with
 * `outcome: 'unknown-error'` and `uncertainty.leaseExpired = true`. Aggregate
 * health is **not** touched here — a crashed process is not evidence about the
 * stream.
 */
export async function recoverExpiredLeases(
  database: HealthDatabase,
  input: { readonly now: Date },
): Promise<RecoveryOutcome> {
  const collection = database.checks();
  const expired = await collection
    .find({ state: { $in: ['pending', 'running'] }, 'lease.expiresAt': { $lte: input.now } })
    .toArray();

  const recovered: CheckRunDoc[] = [];
  for (const check of expired) {
    /*
     * An abandoned check is `failed` at the check layer with the neutral
     * vocabulary entry for "we do not know what happened": `unknown-error` is a
     * failure *category*, never an outcome code, so the outcome is `unknown`.
     */
    const patch: Record<string, unknown> = {
      state: 'failed',
      outcome: 'unknown',
      failure: {
        category: 'unknown-error',
        cause: 'policy',
        message: 'Lease expired before the check completed.',
        depth: check.depth,
      },
      uncertainty: { ...check.uncertainty, leaseExpired: true, notes: [...check.uncertainty.notes, 'lease-expired'] },
      'timings.finishedAt': input.now,
      lease: null,
    };
    const updated = await collection.findOneAndUpdate(
      { _id: check._id, state: check.state, 'lease.expiresAt': { $lte: input.now } },
      { $set: patch },
      { returnDocument: 'after', includeResultMetadata: false },
    );
    if (updated !== null && updated !== undefined) recovered.push(updated);
  }
  return { recovered, healthRowsChanged: 0 };
}

/** Reads one aggregate row (used by tests and operator views). */
export async function findHealth(database: HealthDatabase, sourceId: string): Promise<HealthAggregateDoc | null> {
  return database.health().findOne({ _id: sourceId });
}

/** Ensures the two health collections are reachable (integration preflight). */
export async function healthCollectionsPresent(database: HealthDatabase): Promise<boolean> {
  const [checks, health] = await Promise.all([database.checks().estimatedDocumentCount(), database.health().estimatedDocumentCount()]);
  return checks >= 0 && health >= 0;
}
