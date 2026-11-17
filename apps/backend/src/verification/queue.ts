/**
 * Verification work queue: one contract, two backends, one honest failure mode.
 *
 * A queue item is a check row (`source_health_checks_02d`) whose `_id` is the
 * idempotency key `${sourceId}:${scheduledForISO}`. The queue only decides *who
 * runs it now*; the row itself is the source of truth, so a lost lease never
 * loses work and a repeated enqueue never duplicates it.
 *
 * | backend | claim                           | where the queue lives |
 * | ------- | ------------------------------- | --------------------- |
 * | `mongo` | `findOneAndUpdate` lease claim  | the check rows        |
 * | `redis` | `ZRANGEBYSCORE`+`ZREM` claim    | a ZSET + the check rows |
 *
 * Redis is optional (D-008). Every Redis path is wrapped: when Redis is absent,
 * stops answering or loses an item, the queue **degrades to the Mongo path and
 * says so** through `degraded`/`lastError` — it never throws, and never answers
 * "empty" when it means "I could not reach the queue". A Redis claim is also
 * re-verified against Mongo (`state === 'pending'`) before it is honoured, so the
 * two backends can never both hand out the same item.
 */
import type { Collection } from 'mongodb';
import type { DatabaseHandle } from '../infrastructure/mongo.js';
import type { Logger } from '../infrastructure/logging.js';
import type { CheckState } from './types.js';
import { VERIFICATION_COLLECTIONS } from './types.js';

/** Queue-facing view of a check row; the full row type belongs to the validator. */
export interface QueueRecord {
  readonly _id: string;
  readonly sourceId: string;
  readonly state: CheckState;
  /** ISO alias offered to hand-written enqueue calls (the row stores a Date). */
  readonly scheduledFor?: Date | string;
  readonly [field: string]: unknown;
}

export interface QueueItem {
  readonly id: string;
  readonly sourceId: string;
  readonly scheduledFor: Date;
  readonly owner: string | null;
  readonly attemptNumber: number;
}

export interface ClaimResult {
  readonly item: QueueItem | null;
  /** `null` when nothing was due or another owner held the item. */
  readonly reason?: 'empty' | 'contended' | 'unavailable';
}

export interface EnqueueInput {
  readonly sourceId: string;
  readonly scheduledFor: string;
  readonly kind?: 'scheduled' | 'manual' | 'retry';
  readonly trigger?: { readonly actor: string; readonly reason: string | null };
}

export interface CompleteOutcome {
  readonly outcome: string | null;
  /** Terminal state of the row: `done`, `failed`, or `skipped` when it never ran. */
  readonly state?: 'done' | 'failed' | 'skipped';
  /** Free-form bounded bookkeeping written onto the row (never a URL). */
  readonly fields?: Record<string, unknown>;
}

export interface StatusCounts {
  readonly pending: number;
  readonly running: number;
  readonly done: number;
  readonly failed: number;
  readonly skipped: number;
}

export interface QueueBackend {
  readonly name: 'mongo' | 'redis';
  /** True once the backend stopped serving from its fast path. */
  readonly degraded: boolean;
  /** Last transport failure, already sanitised (never a URL or credential). */
  readonly lastError: string | null;
  enqueue(input: EnqueueInput): Promise<QueueItem>;
  claim(owner: string, ttlMs: number): Promise<ClaimResult>;
  complete(id: string, outcome: CompleteOutcome): Promise<void>;
  release(id: string): Promise<void>;
  depth(): Promise<number>;
  statusCounts(): Promise<StatusCounts>;
  /** Puts an item that was released or recovered back at the head of its time slot. */
  requeue(id: string, scheduledFor: string): Promise<void>;
  close(): Promise<void>;
}

export function isoTimestamp(scheduledFor: string): Date {
  const parsed = new Date(scheduledFor);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('scheduledFor must be an ISO 8601 instant');
  }
  return parsed;
}

/** Idempotency key of a check: one row per (source, scheduled instant). */
export function checkId(sourceId: string, scheduledFor: Date | string): string {
  const iso = typeof scheduledFor === 'string' ? scheduledFor : scheduledFor.toISOString();
  return `${sourceId}:${iso}`;
}

/**
 * A complete, not-yet-claimed `source_health_checks_02d` row (contract §1.1).
 *
 * The queue owns this so that a row *it* creates is one t2's ledger can resume:
 * `claimCheck` reads `timings` and `attempt` from the existing row, and a partial
 * insert would be a row it cannot take over.
 */
export function emptyCheckRow(input: {
  readonly _id: string;
  readonly sourceId: string;
  readonly kind: 'scheduled' | 'manual' | 'retry';
  readonly trigger: { readonly actor: string; readonly reason: string | null };
  readonly now: Date;
}): Record<string, unknown> {
  return {
    _id: input._id,
    sourceId: input.sourceId,
    kind: input.kind,
    trigger: input.trigger,
    state: 'pending',
    outcome: null,
    depth: 'eligibility',
    eligibilityAt: {
      playable: true,
      verdict: 'not-evaluated-by-queue',
      reason: null,
      publicationReason: null,
      authorizationReason: null,
      at: input.now,
    },
    origin: {
      egressHost: 'queue',
      region: null,
      userAgent: 'TDTVerification/1.0',
      policy: 'scheduled-manual-browser',
    },
    timings: { queuedAt: input.now, startedAt: null, finishedAt: null, latencyMs: null },
    attempt: { number: 1, maxAttempts: 3, backoffMs: 0 },
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
    lease: null,
    createdAt: input.now,
  };
}

/** Transport error text safe to log: the driver message, never a connection string. */
function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/[\w.+-]+:\/\/[^\s"']+/g, '[redacted-uri]')
    .replace(/\s+/g, ' ')
    .slice(0, 200);
}

function toItem(record: QueueRecord, owner: string | null): QueueItem {
  const scheduled = record.scheduledFor;
  const scheduledFor =
    scheduled instanceof Date ? scheduled : typeof scheduled === 'string' ? new Date(scheduled) : new Date(0);
  const attempt = (record['attempt'] ?? {}) as { number?: unknown };
  return {
    id: record._id,
    sourceId: record.sourceId,
    scheduledFor: Number.isNaN(scheduledFor.getTime()) ? new Date(0) : scheduledFor,
    owner,
    attemptNumber: typeof attempt.number === 'number' ? attempt.number : 1,
  };
}

/* ------------------------------------------------------------------------- *
 * Mongo backend: the always-available path
 * ------------------------------------------------------------------------- */

export interface MongoQueueOptions {
  readonly database: DatabaseHandle;
  readonly collection?: string;
  readonly logger?: Logger;
}

export class MongoQueue implements QueueBackend {
  readonly name = 'mongo' as const;
  readonly degraded = false;
  readonly lastError = null;
  private readonly collection: Collection<QueueRecord>;

  constructor(options: MongoQueueOptions) {
    /*
     * The 02D collections are not yet listed in `COLLECTIONS` (a captain wiring
     * change); the names come from `HEALTH_COLLECTIONS` via `types.ts`, which is
     * t2's single declaration. An injected collection name always wins.
     */
    const name = options.collection ?? VERIFICATION_COLLECTIONS.checks;
    this.collection = options.database.db.collection<QueueRecord & { _id: string }>(name);
  }

  async enqueue(input: EnqueueInput): Promise<QueueItem> {
    const scheduledFor = isoTimestamp(input.scheduledFor);
    const id = checkId(input.sourceId, scheduledFor);
    /*
     * The queue **schedules**, it does not create check rows: t2's `claimCheck`
     * owns row creation (it needs a non-null `lease` to take a row over, so a row
     * the queue created with `lease: null` would be one it cannot resume).
     *
     * So `enqueue` records the due instant in the queue's own ordering key. That
     * is idempotent on the deterministic `_id`, and `claimCheck` will fill in the
     * row atomically when the item is claimed.
     */
    await this.collection.updateOne(
      { _id: id },
      {
        $setOnInsert: {
          _id: id,
          sourceId: input.sourceId,
          state: 'pending',
          scheduledForAt: scheduledFor,
          scheduledFor: scheduledFor.toISOString(),
          kind: input.kind ?? 'scheduled',
          trigger: input.trigger ?? { actor: 'system', reason: null },
          createdAt: new Date(),
        },
      },
      { upsert: true },
    );
    const stored = (await this.collection.findOne({ _id: id })) as unknown as QueueRecord | null;
    return stored === null
      ? {
          id,
          sourceId: input.sourceId,
          scheduledFor,
          owner: null,
          attemptNumber: 1,
        }
      : toItem(stored, null);
  }

  /**
   * Atomic lease claim: the find and the write are one operation, so two
   * workers can never both win. `$cond` keeps the attempt counter monotonically
   * increasing instead of being reset by a later claim.
   */
  async claim(owner: string, ttlMs: number): Promise<ClaimResult> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs);
    const claimed = await this.collection.findOneAndUpdate(
      {
        state: 'pending',
        $or: [{ lease: null }, { 'lease.expiresAt': { $lte: now } }],
      },
      [
        {
          $set: {
            state: 'running',
            lease: { owner, expiresAt },
            startedAt: now,
            attempt: {
              $cond: [
                { $eq: ['$attempt.number', 1] },
                '$attempt',
                { $mergeObjects: ['$attempt', { number: { $add: ['$attempt.number', 1] }, backoffMs: 0 }] },
              ],
            },
          },
        },
      ],
      { sort: { scheduledForAt: 1, createdAt: 1 }, returnDocument: 'after' },
    );
    if (claimed === null) return { item: null, reason: 'empty' };
    return { item: toItem(claimed, owner) };
  }

  async complete(id: string, outcome: CompleteOutcome): Promise<void> {
    await this.collection.updateOne(
      { _id: id },
      {
        $set: {
          state: outcome.state ?? (outcome.outcome === null ? 'done' : 'done'),
          outcome: outcome.outcome,
          finishedAt: new Date(),
          lease: null,
          ...(outcome.fields ?? {}),
        },
      },
    );
  }

  async release(id: string): Promise<void> {
    await this.collection.updateOne(
      { _id: id },
      { $set: { state: 'pending', lease: null, releasedAt: new Date() } },
    );
  }

  async requeue(id: string, scheduledFor: string): Promise<void> {
    const at = isoTimestamp(scheduledFor);
    await this.collection.updateOne(
      { _id: id },
      { $set: { state: 'pending', lease: null, scheduledForAt: at, scheduledFor: at.toISOString() } },
    );
  }

  async depth(): Promise<number> {
    return this.collection.countDocuments({ state: 'pending' });
  }

  async statusCounts(): Promise<StatusCounts> {
    const rows = await this.collection
      .aggregate<{ _id: string; count: number }>([{ $group: { _id: '$state', count: { $sum: 1 } } }])
      .toArray();
    const counts: Record<string, number> = {};
    for (const row of rows) counts[row._id] = row.count;
    return {
      pending: counts['pending'] ?? 0,
      running: counts['running'] ?? 0,
      done: counts['done'] ?? 0,
      failed: counts['failed'] ?? 0,
      skipped: counts['skipped'] ?? 0,
    };
  }

  async close(): Promise<void> {
    /* the Mongo handle is owned by the application context */
  }
}

/* ------------------------------------------------------------------------- *
 * Redis backend: an accelerator with a Mongo fallback
 * ------------------------------------------------------------------------- */

/** The slice of `redis` this module uses, kept structural so a test can fake it. */
export interface RedisQueueClient {
  zadd(key: string, score: number, member: string): Promise<unknown>;
  zrangebyscore(key: string, min: number | string, max: number | string, options?: { LIMIT?: { offset: number; count: number } }): Promise<string[]>;
  zrem(key: string, member: string): Promise<number>;
  zcard(key: string): Promise<number>;
  zscore(key: string, member: string): Promise<string | null>;
  close?(): Promise<void>;
}

export interface RedisQueueOptions {
  readonly database: DatabaseHandle;
  /** Injected client (production passes the shared `redis` client). */
  readonly client: RedisQueueClient;
  readonly keyPrefix?: string;
  readonly collection?: string;
  readonly logger?: Logger;
}

export class RedisQueue implements QueueBackend {
  readonly name = 'redis' as const;
  private readonly fallback: MongoQueue;
  private readonly key: string;
  private degradedFlag = false;
  private lastErrorText: string | null = null;

  constructor(private readonly options: RedisQueueOptions) {
    this.fallback = new MongoQueue(
      options.collection === undefined
        ? { database: options.database }
        : { database: options.database, collection: options.collection },
    );
    this.key = `${options.keyPrefix ?? 'tdt:verification'}:queue`;
  }

  get degraded(): boolean {
    return this.degradedFlag;
  }

  get lastError(): string | null {
    return this.lastErrorText;
  }

  /**
   * Runs a Redis operation; on the first failure the backend degrades for good
   * (it does not flap between "shared" and "local" queue answers within a
   * process) and the caller gets `undefined` so it can take the Mongo path.
   */
  private async attempt<T>(operation: () => Promise<T>): Promise<T | undefined> {
    if (this.degradedFlag) return undefined;
    try {
      return await operation();
    } catch (error) {
      this.degradedFlag = true;
      this.lastErrorText = sanitizeError(error);
      this.options.logger?.warn(
        { queue: 'redis', err: this.lastErrorText },
        'verification queue degraded to the mongo path',
      );
      return undefined;
    }
  }

  async enqueue(input: EnqueueInput): Promise<QueueItem> {
    const item = await this.fallback.enqueue(input);
    // Scheduled in the ZSET until it is claimed; the row stays the truth.
    await this.attempt(async () =>
      this.options.client.zadd(this.key, item.scheduledFor.getTime(), `${item.id}#${item.scheduledFor.toISOString()}`),
    );
    return item;
  }

  /**
   * Claim order: pop the earliest ZSET member, then prove in Mongo that the row
   * is still `pending` and lease it there. A Redis hit that Mongo rejects is a
   * contended item: it is dropped from the ZSET and the claim reports
   * `contended` rather than handing out work twice.
   */
  async claim(owner: string, ttlMs: number): Promise<ClaimResult> {
    if (this.degradedFlag) {
      return this.fallback.claim(owner, ttlMs);
    }
    const members = await this.attempt(async () =>
      this.options.client.zrangebyscore(this.key, '-inf', Date.now(), { LIMIT: { offset: 0, count: 8 } }),
    );
    if (members === undefined) {
      this.degradedFlag = true;
      return this.fallback.claim(owner, ttlMs);
    }
    if (members.length === 0) {
      /*
       * Never answer "empty" on behalf of Redis alone: the Mongo rows are the
       * only place that knows what is due, so an empty or lost ZSET falls
       * through to the durable claim.
       */
      return this.fallback.claim(owner, ttlMs);
    }
    for (const member of members) {
      await this.attempt(async () => this.options.client.zrem(this.key, member));
      const id = member.slice(0, member.lastIndexOf('#'));
      const claimed = await this.fallbackClaimById(id, owner, ttlMs);
      if (claimed.item !== null) return claimed;
    }
    return { item: null, reason: 'contended' };
  }

  /** Lease one specific pending row (Mongo is the arbiter). */
  private async fallbackClaimById(id: string, owner: string, ttlMs: number): Promise<ClaimResult> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs);
    const collection = this.options.database
      .db
      .collection<QueueRecord>(this.options.collection ?? VERIFICATION_COLLECTIONS.checks);
    const claimed = await collection.findOneAndUpdate(
      { _id: id, state: 'pending', $or: [{ lease: null }, { 'lease.expiresAt': { $lte: now } }] },
      { $set: { state: 'running', lease: { owner, expiresAt }, startedAt: now } },
      { returnDocument: 'after' },
    );
    return claimed === null ? { item: null, reason: 'contended' } : { item: toItem(claimed, owner) };
  }

  async complete(id: string, outcome: CompleteOutcome): Promise<void> {
    await this.fallback.complete(id, outcome);
    await this.attempt(async () => this.options.client.zrem(this.key, id));
  }

  async release(id: string): Promise<void> {
    await this.fallback.release(id);
    const at = new Date().toISOString();
    await this.attempt(async () => this.options.client.zadd(this.key, Date.now(), `${id}#${at}`));
  }

  async requeue(id: string, scheduledFor: string): Promise<void> {
    await this.fallback.requeue(id, scheduledFor);
    const at = isoTimestamp(scheduledFor);
    await this.attempt(async () => this.options.client.zadd(this.key, at.getTime(), `${id}#${at.toISOString()}`));
  }

  async depth(): Promise<number> {
    const shared = await this.attempt(async () => this.options.client.zcard(this.key));
    // The durable depth is the answer that cannot be wrong; the ZSET is a cache.
    const durable = await this.fallback.depth();
    if (shared === undefined) return durable;
    return Math.max(durable, shared);
  }

  async statusCounts(): Promise<StatusCounts> {
    return this.fallback.statusCounts();
  }

  async close(): Promise<void> {
    /* the client is shared with the response cache; closing it is not our call */
  }
}

/* ------------------------------------------------------------------------- *
 * Factory
 * ------------------------------------------------------------------------- */

export interface QueueOptions {
  readonly database: DatabaseHandle;
  readonly logger?: Logger;
  readonly redis?: RedisQueueClient | null;
  readonly collection?: string;
}

/**
 * Chooses the backend from configuration: Redis when a client is supplied,
 * Mongo otherwise. There is no configuration in which this throws for a missing
 * Redis: that is the D-008 contract.
 */
export function createQueue(options: QueueOptions): QueueBackend {
  if (options.redis) {
    return new RedisQueue({
      database: options.database,
      client: options.redis,
      ...(options.collection === undefined ? {} : { collection: options.collection }),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });
  }
  return new MongoQueue({
    database: options.database,
    ...(options.collection === undefined ? {} : { collection: options.collection }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
}

/** Backend report for the operator status view: never claims shared when it is not. */
export function queueReport(queue: QueueBackend): {
  backend: 'mongo' | 'redis';
  degraded: boolean;
  lastError: string | null;
} {
  return { backend: queue.name, degraded: queue.degraded, lastError: queue.lastError };
}
