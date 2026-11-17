/**
 * Verification round planner and executor.
 *
 * One *round* is one scheduler tick. It is deliberately two observable phases so
 * the plan can be inspected (and tested) without touching the network:
 *
 *   planRound(now)  → which sources are due, and what the round will refuse
 *   runRound(now)   → claim them from the queue, run them, and return counts
 *
 * What a round guarantees, in the contract's order of concern:
 *
 * - **Minimum load on the provider.** Due sources are grouped by host and a
 *   bounded semaphore caps both the global in-flight checks and the in-flight
 *   checks *per host*; a saturated host is deferred to the next round, never
 *   overflowed.
 * - **Minimum bandwidth.** The validator is told to probe with `HEAD` first
 *   (`headFirst`) and to skip segment sampling when `requireSegments` is false,
 *   which this planner sets to `false` for every check whose manifest may still
 *   fail — segments are only ever requested after a manifest has passed.
 * - **Retry cap.** At most `maxAttempts` (3) attempts per check. A transient
 *   failure is retried inside the round with an injected backoff; a permanent
 *   one (`http-404`, `http-403`, `ineligible`, …) is never retried.
 * - **Circuit breakers.** Per source *and* per host: 5 consecutive failures open
 *   the circuit for `min(2^n * 5 min, 60 min)`, after which exactly one
 *   half-open probe decides. A deferred source is not an attempt: it costs the
 *   provider nothing and does not feed the breaker.
 * - **Browser verification is manual-only.** A scheduled round never asks for
 *   depth `browser`; only a manual retry with `browser: true` does.
 * - **Crash recovery.** `reconcile()` reclaims `running` checks whose lease
 *   expired as `failed` / `unknown-error` / `uncertainty.leaseExpired`, and — this
 *   is the part the contract insists on — **never** writes aggregated health. A
 *   wedged check is not evidence about the source.
 *
 * The planner owns no I/O besides Mongo and the queue; the network is entirely
 * the injected `validator`'s job, which is what makes it testable.
 */
import { createHash } from 'node:crypto';
import type { Collection } from 'mongodb';
import { COLLECTIONS } from '../infrastructure/mongo.js';
import type { DatabaseHandle } from '../infrastructure/mongo.js';
import type { Logger } from '../infrastructure/logging.js';
import {
  countsTowardBreakerOnThrow,
  egressCodeOf,
  failureCodeOfThrown,
  isRetryableThrown,
} from './egress-classification.js';
import type { VerificationMetrics } from './metrics.js';
import { hostOf } from './metrics.js';
import type { QueueBackend, QueueItem } from './queue.js';
import { checkId, isoTimestamp } from './queue.js';
import {
  applyToAggregate,
  claimCheck,
  completeCheck,
  ensureHealthIndexes,
  healthCollections,
  recoverExpiredLeases,
} from './health.repository.js';
import type { HealthDatabase } from './health.repository.js';
import {
  CIRCUIT_BASE_WINDOW_MS,
  CIRCUIT_FAILURE_THRESHOLD,
  CIRCUIT_MAX_WINDOW_MS,
  DEFAULT_MAX_ATTEMPTS,
  VERIFICATION_COLLECTIONS,
  countsTowardBreaker,
  failureCause,
  isCheckOutcomeCode,
  isFailureCode,
  isPermanentFailure,
} from './types.js';
import type {
  CheckOutcomeCode,
  CheckState,
  FailureCode,
  HealthStatus,
  SourceHealthDoc,
  TrimmedSource,
  ValidationDepth,
  VerificationPolicyDoc,
} from './types.js';
import type { Uncertainty } from './health.schema.js';

/** t2's outcome vocabulary (no `aborted`): what a check row may store. */
export type SchemaOutcome = Exclude<CheckOutcomeCode, 'aborted'>;

/**
 * Narrows a validator outcome to what a check row may store.
 *
 * t2's row vocabulary is a *status* vocabulary (`healthy`, `degraded`, `unknown`,
 * `ineligible`, …); a failure is stored as `failure.category`, not as the
 * outcome. So a failure category becomes the neutral `unknown` here, which is
 * exactly what t2's `recoverExpiredLeases` does for the same reason.
 */
export function toSchemaOutcome(outcome: ValidationOutcome | null): SchemaOutcome | null {
  if (outcome === null || outcome === 'aborted') return null;
  if (outcome === 'healthy' || outcome === 'degraded') return outcome;
  if (isFailureCode(outcome)) return 'unknown';
  return outcome;
}

/** The failure category of an outcome, or `null` when it did not fail. */
export function asFailureCode(outcome: ValidationOutcome): FailureCode | null {
  if (outcome === 'healthy' || outcome === 'degraded' || outcome === 'aborted') return null;
  return isFailureCode(outcome) ? outcome : null;
}

/* ------------------------------------------------------------------------- *
 * Configuration and injected collaborators
 * ------------------------------------------------------------------------- */

export interface BreakerOptions {
  /** Consecutive failures that open a circuit. */
  readonly threshold?: number;
  /** Base reopening window; doubles per reopen. */
  readonly baseWindowMs?: number;
  /** Upper bound for the reopening window. */
  readonly maxWindowMs?: number;
}

export interface SchedulerOptions {
  readonly database: DatabaseHandle;
  readonly queue: QueueBackend;
  /** Executes one attempt. The only component that may open a socket. */
  readonly validator: ValidationExecutor;
  readonly metrics?: VerificationMetrics;
  readonly logger?: Logger;
  /** Global maximum of checks in flight in one round. */
  readonly concurrency?: number;
  /** Per-host maximum of checks in flight. */
  readonly perHostConcurrency?: number;
  /** Maximum sources a round will plan (the rest wait for the next tick). */
  readonly batchSize?: number;
  /**
   * Maximum sources the planner will admit for *one* host inside a round. The
   * executor's per-host semaphore also bounds the live in-flight count; this is
   * the planning-side cap that keeps a round from being monopolised by one host.
   * Defaults to the per-host concurrency, so a plan never promises more than the
   * executor will run at once.
   */
  readonly perHostPlanLimit?: number;
  readonly maxAttempts?: number;
  readonly leaseTtlMs?: number;
  /** `base * 2^attempt` with deterministic jitter, per contract §4. */
  readonly backoff?: BackoffFunction;
  readonly breakers?: BreakerOptions;
  /** Collection overrides: the production wiring passes `COLLECTIONS`. */
  readonly collections?: {
    readonly checks: string;
    readonly health: string;
    readonly policies: string;
  };
  readonly now?: () => Date;
}

/** Deterministic jitter in [0.8, 1.2) from the source key: reproducible, no herd. */
export type BackoffFunction = (attempt: number, sourceId: string) => number;

export function deterministicBackoff(attempt: number, sourceId: string): number {
  const powers = Math.min(Math.max(attempt, 0), 12);
  const digest = createHash('sha256').update(`${sourceId}:${attempt}`).digest();
  const unit = digest.readUInt32BE(0) / 0x1_0000_0000;
  const jitter = 0.8 + unit * 0.4;
  return Math.round(Math.min(CIRCUIT_BASE_WINDOW_MS * 2 ** powers, 24 * 60 * 60 * 1000) * jitter);
}

export interface ValidationRequest {
  readonly sourceId: string;
  readonly url: string;
  readonly type: string;
  readonly attempt: number;
  /** Probe with `HEAD` before downloading anything. Always true for scheduled checks. */
  readonly headFirst: true;
  /** Segment sampling is offered only after a manifest has passed. */
  readonly requireSegments: boolean;
  /** A scheduled round never asks for browser depth. */
  readonly browser: boolean;
  /** Which of the result fields the validator honoured (for the audit trail). */
  readonly budget: { readonly requestCount: number };
}

/**
 * What one validator attempt reports.
 *
 * `outcome` uses the contract vocabulary: `healthy`/`degraded` for a pass, any
 * failure *category* for a fail, and `aborted` when the attempt never ran. The
 * category is therefore expressible both as `outcome` and as `failure.code`;
 * the scheduler prefers `failure.code` when present.
 */
export type ValidationOutcome = CheckOutcomeCode | FailureCode;

export interface ValidatorFailure {
  readonly code: FailureCode;
  readonly httpStatus?: number | null;
  readonly detail?: string;
}

export interface ValidationResult {
  readonly outcome: ValidationOutcome;
  /** `true` when the validator accepted the request; `false` when it refused it. */
  readonly started?: boolean;
  readonly depth?: ValidationDepth;
  readonly latencyMs?: number;
  /** Egress requests the validator actually issued. */
  readonly egressRequests?: number;
  /** Structured failure detail when the validator knows more than the outcome. */
  readonly failure?: ValidatorFailure;
  readonly segmentsSampled?: boolean;
  readonly uncertainty?: Partial<Uncertainty>;
  readonly evidence?: {
    readonly httpStatus?: number | null;
    readonly contentType?: string | null;
    readonly bytes?: number;
  };
  /** Set by the scheduler when the validator threw instead of answering. */
  readonly thrown?: boolean;
  /** The thrown value, kept so the retry classifier can read its egress code. */
  readonly thrownError?: unknown;
}

export interface ValidationExecutor {
  validate(request: ValidationRequest): Promise<ValidationResult>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Row state a validated outcome settles into. `aborted` never became a run. */
export function terminalStateOf(outcome: ValidationOutcome): 'done' | 'failed' | 'skipped' {
  if (outcome === 'healthy' || outcome === 'degraded') return 'done';
  if (outcome === 'aborted') return 'skipped';
  return 'failed';
}

/* ------------------------------------------------------------------------- *
 * Bounded semaphore
 * ------------------------------------------------------------------------- */

/**
 * A counting semaphore with a per-key limit on top of a global one.
 *
 * `acquire` answers immediately when capacity exists, otherwise it enqueues the
 * waiter. A waiter that is aborted leaves the queue, so a round that ends early
 * cannot leave a phantom reservation behind. The measured `peak` is what the
 * concurrency test asserts on.
 */
export class BoundedSemaphore {
  private active = 0;
  private readonly activeByKey = new Map<string, number>();
  private peak = 0;
  private readonly peakByKey = new Map<string, number>();
  private readonly waiting: Array<{ key: string; resolve: (release: () => void) => void }> = [];

  constructor(
    private readonly limit: number,
    private readonly perKeyLimit = Number.POSITIVE_INFINITY,
  ) {
    if (limit < 1) throw new Error('BoundedSemaphore limit must be >= 1');
  }

  get inFlight(): number {
    return this.active;
  }

  get peakObserved(): number {
    return this.peak;
  }

  peakFor(key: string): number {
    return this.peakByKey.get(key) ?? 0;
  }

  get waitingCount(): number {
    return this.waiting.length;
  }

  inFlightFor(key: string): number {
    return this.activeByKey.get(key) ?? 0;
  }

  /** Resolves to a `release` function, or `null` when `signal` aborted first. */
  async acquire(key: string, signal?: AbortSignal): Promise<(() => void) | null> {
    if (signal?.aborted === true) return null;
    if (this.canAdmit(key)) return this.admit(key);
    const settled = await new Promise<(() => void) | null>((resolve) => {
      const waiter = { key, resolve: (release: () => void) => resolve(release) };
      this.waiting.push(waiter);
      signal?.addEventListener(
        'abort',
        () => {
          const index = this.waiting.indexOf(waiter);
          if (index >= 0) this.waiting.splice(index, 1);
          resolve(null);
        },
        { once: true },
      );
    });
    return settled;
  }

  private canAdmit(key: string): boolean {
    return this.active < this.limit && this.inFlightFor(key) < this.perKeyLimit;
  }

  private admit(key: string): () => void {
    this.active += 1;
    const current = this.inFlightFor(key) + 1;
    this.activeByKey.set(key, current);
    this.peak = Math.max(this.peak, this.active);
    this.peakByKey.set(key, Math.max(this.peakFor(key), current));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      const next = this.inFlightFor(key) - 1;
      if (next <= 0) this.activeByKey.delete(key);
      else this.activeByKey.set(key, next);
      this.drain();
    };
  }

  private drain(): void {
    for (let index = 0; index < this.waiting.length; ) {
      const waiter = this.waiting[index] as { key: string; resolve: (release: () => void) => void };
      if (!this.canAdmit(waiter.key)) {
        index += 1;
        continue;
      }
      this.waiting.splice(index, 1);
      waiter.resolve(this.admit(waiter.key));
    }
  }
}

/* ------------------------------------------------------------------------- *
 * Circuit breaker registry (in-process view of `source_health_02d.circuit`)
 * ------------------------------------------------------------------------- */

export interface CircuitView {
  state: 'closed' | 'open' | 'half-open';
  consecutiveFailures: number;
  reopenCount: number;
  openedAt: Date | null;
}

export class CircuitBreakers {
  private readonly circuits = new Map<string, CircuitView>();
  private readonly threshold: number;
  private readonly baseWindowMs: number;
  private readonly maxWindowMs: number;
  private readonly onOpen?: (scope: 'source' | 'host') => void;

  constructor(options: BreakerOptions & { readonly onOpen?: (scope: 'source' | 'host') => void } = {}) {
    this.threshold = options.threshold ?? CIRCUIT_FAILURE_THRESHOLD;
    this.baseWindowMs = options.baseWindowMs ?? CIRCUIT_BASE_WINDOW_MS;
    this.maxWindowMs = options.maxWindowMs ?? CIRCUIT_MAX_WINDOW_MS;
    if (options.onOpen) this.onOpen = options.onOpen;
  }

  get(scope: 'source' | 'host', key: string): CircuitView {
    return this.circuits.get(`${scope}:${key}`) ?? { state: 'closed', consecutiveFailures: 0, reopenCount: 0, openedAt: null };
  }

  /** How long an open circuit still refuses work, in milliseconds (0 when not open). */
  remainingOpenMs(scope: 'source' | 'host', key: string, now: Date): number {
    const view = this.get(scope, key);
    if (view.state !== 'open' || view.openedAt === null) return 0;
    const window = Math.min(this.baseWindowMs * 2 ** view.reopenCount, this.maxWindowMs);
    return Math.max(0, view.openedAt.getTime() + window - now.getTime());
  }

  /**
   * Records a permanent-ish failure. Reaching the threshold opens the circuit;
   * a failure that arrives while the circuit is open counts as the failed
   * half-open probe and re-opens it with a doubled window (capped).
   */
  recordFailure(scope: 'source' | 'host', key: string, now: Date): CircuitView {
    const id = `${scope}:${key}`;
    const view = { ...this.get(scope, key) };
    if (view.state === 'open') {
      view.reopenCount += 1;
      view.openedAt = now;
      view.state = 'open';
      this.circuits.set(id, view);
      this.onOpen?.(scope);
      return view;
    }
    if (view.state === 'half-open') {
      view.state = 'open';
      view.reopenCount += 1;
      view.openedAt = now;
      this.circuits.set(id, view);
      this.onOpen?.(scope);
      return view;
    }
    view.consecutiveFailures += 1;
    if (view.consecutiveFailures >= this.threshold) {
      view.state = 'open';
      view.openedAt = now;
      view.reopenCount = 0;
      this.onOpen?.(scope);
    }
    this.circuits.set(id, view);
    return view;
  }

  recordSuccess(scope: 'source' | 'host', key: string): CircuitView {
    const view: CircuitView = { state: 'closed', consecutiveFailures: 0, reopenCount: 0, openedAt: null };
    this.circuits.set(`${scope}:${key}`, view);
    return view;
  }

  /**
   * The single half-open probe: only one caller gets `true` per open window. The
   * claim is in memory and per process, which matches the one-writer-per-check
   * lease model.
   */
  private readonly probes = new Map<string, boolean>();

  /**
   * Decides whether this caller may touch the network.
   *
   * - closed → yes
   * - open, window not elapsed → no
   * - open, window elapsed, probe unclaimed → yes, and mark the probe claimed
   * - open, window elapsed, probe claimed → no (a probe is in flight)
   */
  admit(scope: 'source' | 'host', key: string, now: Date): 'closed' | 'half-open' | 'open' {
    const id = `${scope}:${key}`;
    const view = this.get(scope, key);
    if (view.state === 'closed') return 'closed';
    if (view.state === 'half-open') {
      if (this.probes.get(id) === true) return 'open';
      this.probes.set(id, true);
      return 'half-open';
    }
    if (this.remainingOpenMs(scope, key, now) > 0) return 'open';
    if (this.probes.get(id) === true) return 'open';
    this.probes.set(id, true);
    this.circuits.set(id, { ...view, state: 'half-open' });
    return 'half-open';
  }

  /** Releases the probe claim after a half-open probe finished (success or failure). */
  releaseProbe(scope: 'source' | 'host', key: string): void {
    this.probes.delete(`${scope}:${key}`);
  }

  /** Re-arms the probe only once the (new) window has elapsed; called by the planner. */
  armProbeIfElapsed(scope: 'source' | 'host', key: string, now: Date): void {
    if (this.remainingOpenMs(scope, key, now) <= 0) this.probes.delete(`${scope}:${key}`);
  }

  /** Number of circuits currently open (operator view). */
  openCount(): number {
    let count = 0;
    for (const view of this.circuits.values()) if (view.state === 'open') count += 1;
    return count;
  }

  snapshot(): Record<string, CircuitView> {
    return Object.fromEntries(this.circuits);
  }
}

/* ------------------------------------------------------------------------- *
 * The scheduler
 * ------------------------------------------------------------------------- */

export interface PlannedSource {
  readonly sourceId: string;
  readonly host: string;
  readonly url: string;
  readonly type: string;
}

export interface DeferredSource {
  readonly sourceId: string;
  readonly host: string;
  readonly reason: 'circuit-open' | 'host-budget' | 'global-budget' | 'paused-provider' | 'paused-all' | 'running';
}

export interface RoundPlan {
  readonly now: Date;
  readonly due: readonly PlannedSource[];
  readonly selected: readonly PlannedSource[];
  readonly deferred: readonly DeferredSource[];
  /** Sources whose aggregated health is paused; they are not due at all. */
  readonly paused: number;
}

export interface CheckRunResult {
  readonly sourceId: string;
  readonly checkId: string;
  readonly outcome: ValidationOutcome;
  readonly state: CheckState;
  readonly attempts: number;
  readonly latencyMs: number;
  readonly egressRequests: number;
  readonly deferred?: DeferredSource['reason'];
}

export interface RoundCounts {
  readonly planned: number;
  readonly deferred: number;
  readonly paused: number;
  readonly healthy: number;
  readonly degraded: number;
  readonly failed: number;
  readonly aborted: number;
  readonly skipped: number;
  readonly retries: number;
  readonly egressRequests: number;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly wallMs: number;
  readonly peakInFlight: number;
  readonly peakInFlightByHost: number;
  readonly plans: readonly CheckRunResult[];
  readonly byOutcome: Readonly<Record<string, number>>;
}

export interface ReconcileReport {
  readonly reclaimed: number;
  readonly requeued: number;
  readonly owners: readonly string[];
  readonly at: Date;
}

export class VerificationScheduler {
  private readonly database: DatabaseHandle;
  private readonly queue: QueueBackend;
  private readonly validator: ValidationExecutor;
  private readonly metrics: VerificationMetrics | undefined;
  private readonly logger: Logger | undefined;
  private readonly concurrency: number;
  private readonly perHostConcurrency: number;
  private readonly perHostPlanLimit: number;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly leaseTtlMs: number;
  private readonly backoff: BackoffFunction;
  readonly breakers: CircuitBreakers;
  private readonly healthDb: HealthDatabase;
  private readonly policies: Collection<VerificationPolicyDoc>;
  private readonly clock: () => Date;
  private readonly owner: string;

  constructor(options: SchedulerOptions) {
    this.database = options.database;
    this.queue = options.queue;
    this.validator = options.validator;
    this.metrics = options.metrics;
    this.logger = options.logger;
    this.concurrency = Math.max(1, options.concurrency ?? 4);
    this.perHostConcurrency = Math.max(1, options.perHostConcurrency ?? 1);
    this.perHostPlanLimit = Math.max(1, options.perHostPlanLimit ?? this.perHostConcurrency);
    this.batchSize = Math.max(1, options.batchSize ?? 200);
    this.maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    this.leaseTtlMs = Math.max(1_000, options.leaseTtlMs ?? 60_000);
    this.backoff = options.backoff ?? deterministicBackoff;
    this.clock = options.now ?? (() => new Date());
    this.owner = `${process.pid}:${createHash('sha256').update(String(Date.now())).digest('hex').slice(0, 8)}`;
    /*
     * The health ledger is t2's: `healthCollections` is the one place that widens
     * the generic so `DatabaseHandle.collection` does not need the 02D names in
     * its `CollectionName` union. Read-only rows this scheduler still needs
     * (policies) go through the same widening.
     */
    this.healthDb = healthCollections(this.database);
    this.policies = this.widenedDatabase().collection<VerificationPolicyDoc>(VERIFICATION_COLLECTIONS.policies);
    this.breakers = new CircuitBreakers({
      ...(options.breakers ?? {}),
      onOpen: (scope) => {
        this.metrics?.circuitOpenTotal(scope);
      },
    });
  }

  /** `DatabaseHandle` with the string-keyed 02D collection names allowed. */
  private widenedDatabase(): {
    collection<T extends { _id: string }>(name: string): Collection<T>;
  } {
    return this.database as unknown as {
      collection<T extends { _id: string }>(name: string): Collection<T>;
    };
  }

  get instanceOwner(): string {
    return this.owner;
  }

  /** Creates the indexes the round queries depend on (idempotent). */
  async ensureIndexes(): Promise<void> {
    await ensureHealthIndexes(this.database);
    await this.policies.createIndex({ scope: 1, _id: 1 });
  }

  /* ------------------------------------------------------------- planning */

  /** The source documents a plan may touch: published playable HTTP(S) sources. */
  private async candidateSources(): Promise<TrimmedSource[]> {
    const sources = this.database.collection<TrimmedSource>(COLLECTIONS.sources);
    return sources
      .find(
        { editorialStatus: 'published', url: { $ne: null } },
        { projection: { _id: 1, url: 1, type: 1, provider: 1, editorialStatus: 1, priority: 1 } },
      )
      .toArray();
  }

  /** Global and per-provider kill switches, read once per plan. */
  private async pausedScopes(): Promise<{ all: boolean; providers: ReadonlySet<string> }> {
    const rows = await this.policies.find({ paused: true }).toArray();
    const providers = new Set<string>();
    let all = false;
    for (const row of rows) {
      if (row.scope === 'global') all = true;
      // The provider is encoded in t2's row id (`provider:<id>`).
      if (row.scope === 'provider' && row._id.startsWith('provider:')) {
        providers.add(row._id.slice('provider:'.length));
      }
    }
    return { all, providers };
  }

  /**
   * Selects the sources of this round.
   *
   * Selection order is the contract's priority: the aggregated row's
   * `nextCheckAt` (earliest first), then the source's own `priority`, then the
   * id — a total order, so two plans of the same state are identical.
   */
  async planRound(now: Date = this.clock()): Promise<RoundPlan> {
    const [sources, scopes] = await Promise.all([this.candidateSources(), this.pausedScopes()]);
    const byId = new Map(sources.map((source) => [source._id, source]));
    const rows = await this.healthDb
      .health()
      .find({
        _id: { $in: sources.map((source) => source._id) },
        nextCheckAt: { $lte: now },
        status: { $ne: 'paused' },
      })
      .sort({ nextCheckAt: 1 })
      .limit(this.batchSize * 4)
      .toArray();

    const due: PlannedSource[] = [];
    const deferred: DeferredSource[] = [];
    const paused = scopes.all ? sources.length : 0;
    const scheduled = rows
      .map((row) => ({ row, source: byId.get(row._id) }))
      .filter((entry): entry is { row: SourceHealthDoc; source: TrimmedSource } => entry.source !== undefined)
      .sort((left, right) => {
        const byTime = left.row.nextCheckAt.getTime() - right.row.nextCheckAt.getTime();
        if (byTime !== 0) return byTime;
        if (left.source.priority !== right.source.priority) return left.source.priority - right.source.priority;
        return left.source._id < right.source._id ? -1 : left.source._id > right.source._id ? 1 : 0;
      });

    const hostCounts = new Map<string, number>();
    for (const { row, source } of scheduled) {
      // The host is derived from the source URL; the aggregate row does not carry it.
      const host = hostOf(source.url ?? '');
      if (scopes.all) {
        deferred.push({ sourceId: source._id, host, reason: 'paused-all' });
        continue;
      }
      if (scopes.providers.has(source.provider)) {
        deferred.push({ sourceId: source._id, host, reason: 'paused-provider' });
        continue;
      }
      const url = source.url;
      if (url === null || !/^https?:/i.test(url)) {
        // Not a network source at all: the round has nothing to ask the network.
        deferred.push({ sourceId: source._id, host, reason: 'global-budget' });
        continue;
      }
      const planned: PlannedSource = { sourceId: source._id, host, url, type: source.type };
      /*
       * A saturated host or a full round defers the source to the next tick. It
       * is *not* an attempt: nothing is written for it and the breaker is not
       * fed, so the provider never pays for our limits.
       */
      const inRound = hostCounts.get(host) ?? 0;
      if (inRound >= this.perHostPlanLimit) {
        deferred.push({ sourceId: source._id, host, reason: 'host-budget' });
        continue;
      }
      if (due.length >= this.batchSize) {
        deferred.push({ sourceId: source._id, host, reason: 'global-budget' });
        continue;
      }
      if (this.breakers.admit('source', source._id, now) === 'open') {
        deferred.push({ sourceId: source._id, host, reason: 'circuit-open' });
        continue;
      }
      if (this.breakers.admit('host', host, now) === 'open') {
        // Hand back the source probe: this round is not going to use it.
        this.breakers.releaseProbe('source', source._id);
        deferred.push({ sourceId: source._id, host, reason: 'circuit-open' });
        continue;
      }
      hostCounts.set(host, inRound + 1);
      due.push(planned);
    }
    this.metrics?.setSourcesByStatus('paused', paused);
    return { now, due, selected: due, deferred, paused };
  }

  /**
   * Hand a planned source back when the round did not use it, so a deferred
   * half-open probe is available to the next tick instead of being consumed.
   */
  releasePlanClaim(source: PlannedSource): void {
    this.breakers.releaseProbe('source', source.sourceId);
    this.breakers.releaseProbe('host', source.host);
  }

  /* ------------------------------------------------------------ execution */

  /**
   * Runs one round: claim → validate → record, with the global and per-host
   * semaphore, the retry cap and the breakers applied.
   *
   * The health row is written **only** by `applyOutcome`, i.e. only when a check
   * reached a terminal outcome.
   */
  async runRound(now: Date = this.clock()): Promise<RoundCounts> {
    const startedAt = new Date();
    const wallStart = performance.now();
    const plan = await this.planRound(now);
    const gate = new BoundedSemaphore(this.concurrency, this.perHostConcurrency);
    const abort = new AbortController();
    const results: CheckRunResult[] = [];

    await Promise.all(
      plan.selected.map(async (source) => {
        const release = await gate.acquire(source.host, abort.signal);
        if (release === null) {
          results.push({
            sourceId: source.sourceId,
            checkId: checkId(source.sourceId, now.toISOString()),
            outcome: 'aborted',
            state: 'skipped',
            attempts: 0,
            latencyMs: 0,
            egressRequests: 0,
            deferred: 'global-budget',
          });
          return;
        }
        this.metrics?.setInFlight(gate.inFlight);
        this.metrics?.setHostInFlight(source.host, gate.inFlightFor(source.host));
        try {
          results.push(await this.runOne(source, now));
        } finally {
          release();
          this.metrics?.setInFlight(gate.inFlight);
          this.metrics?.setHostInFlight(source.host, gate.inFlightFor(source.host));
        }
      }),
    );

    const counts: Record<string, number> = {};
    let retries = 0;
    let egressRequests = 0;
    for (const result of results) {
      counts[result.outcome] = (counts[result.outcome] ?? 0) + 1;
      retries += Math.max(0, result.attempts - 1);
      egressRequests += result.egressRequests;
    }
    const failed = results.filter((result) => result.state === 'failed').length;
    const finishedAt = new Date();
    const wallMs = Math.round(performance.now() - wallStart);
    const peakByHost = plan.selected.reduce((peak, source) => Math.max(peak, gate.peakFor(source.host)), 0);
    this.metrics?.roundTotal(failed > 0 ? 'degraded' : 'ok');
    this.metrics?.setInFlight(0);
    const depth = await this.queue.depth().catch(() => 0);
    this.metrics?.setQueueDepth(this.queue.name, depth);

    return {
      planned: plan.due.length,
      deferred: plan.deferred.length,
      paused: plan.paused,
      healthy: counts['healthy'] ?? 0,
      degraded: counts['degraded'] ?? 0,
      failed,
      aborted: counts['aborted'] ?? 0,
      skipped: counts['skipped'] ?? 0,
      retries,
      egressRequests,
      startedAt,
      finishedAt,
      wallMs,
      peakInFlight: gate.peakObserved,
      peakInFlightByHost: peakByHost,
      plans: results,
      byOutcome: counts,
    };
  }

  /** One source of the round: enqueue, claim, attempt with backoff, record. */
  private async runOne(source: PlannedSource, now: Date): Promise<CheckRunResult> {
    const scheduledFor = now.toISOString();
    /*
     * The eligibility snapshot is recorded as audit only. This scheduler does
     * not decide eligibility (that is t2's engine and the 02C gate); it records
     * that the check was planned under the current policy, which is all the row
     * needs to be auditable.
     */
    const preEligibility = {
      playable: true,
      verdict: 'not-evaluated-by-scheduler',
      reason: null,
      publicationReason: null,
      authorizationReason: null,
      at: now,
    };
    /*
     * The durable claim is t2's `claimCheck` and it runs **first**: it owns row
     * creation, and it needs a non-null `lease` on a row it takes over. The
     * queue's `enqueue` only records the due instant afterwards, so the queue can
     * never create a row the ledger cannot resume.
     */
    const claimedCheck = await claimCheck(this.healthDb, {
      sourceId: source.sourceId,
      scheduledFor: now,
      owner: this.owner,
      kind: 'scheduled',
      leaseTtlMs: this.leaseTtlMs,
      origin: {
        egressHost: 'scheduler',
        region: null,
        userAgent: 'TDTVerification/1.0',
        policy: 'scheduled-manual-browser',
      },
      eligibilityAt: preEligibility,
      maxAttempts: this.maxAttempts,
      now,
    });
    if (!claimedCheck.claimed) {
      return {
        sourceId: source.sourceId,
        checkId: checkId(source.sourceId, scheduledFor),
        outcome: 'aborted',
        state: 'skipped',
        attempts: 0,
        latencyMs: 0,
        egressRequests: 0,
        deferred: 'running',
      };
    }
    const item: QueueItem = {
      id: claimedCheck.check._id,
      sourceId: source.sourceId,
      scheduledFor: now,
      owner: this.owner,
      attemptNumber: claimedCheck.check.attempt.number,
    };
    // Now that the ledger owns the row, record the due instant in the queue too.
    await this.queue.enqueue({ sourceId: source.sourceId, scheduledFor, kind: 'scheduled' });
    const startedAt = performance.now();
    let attempts = 0;
    let egressRequests = 0;
    let lastResult: ValidationResult = {
      outcome: 'aborted',
      started: false,
      failure: { code: 'unknown-error', detail: 'validator did not run' },
    };

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      attempts = attempt;
      const result = await this.safeValidate(source, attempt);
      lastResult = result;
      egressRequests += Math.max(0, result.egressRequests ?? 0);
      for (let made = 1; made <= Math.max(1, result.egressRequests ?? 1); made += 1) {
        this.metrics?.egressRequestTotal(source.host);
      }

      const isFailure = result.outcome !== 'healthy' && result.outcome !== 'degraded' && result.outcome !== 'aborted';
      if (!isFailure) break;
      const failureCode: FailureCode = asFailureCode(result.outcome) ?? result.failure?.code ?? 'unknown-error';
      /*
       * Two independent vetoes, both fail-closed:
       * 1. `thrown` — the validator threw an egress failure. Only the four
       *    retryable egress codes earn another attempt; a refusal (SSRF,
       *    credential-in-url, redirect-unsafe…) is never repeated, because a
       *    retried refusal is one request too many against a host we declined.
       * 2. `isPermanentFailure` — a permanent outcome code from the vocabulary.
       */
      if (result.thrown === true && !isRetryableThrown(result.thrownError)) break;
      if (isPermanentFailure(failureCode)) break;
      if (attempt >= this.maxAttempts) break;
      this.metrics?.retryTotal(failureCode === 'timeout' ? 'timeout' : 'transient');
      const delay = Math.max(0, this.backoff(attempt, source.sourceId));
      if (delay > 0) await sleep(delay);
    }

    const latencyMs = Math.round(performance.now() - startedAt);
    const outcome = lastResult.outcome;
    const code: FailureCode =
      asFailureCode(outcome) ?? lastResult.failure?.code ?? 'unknown-error';
    const terminal = terminalStateOf(outcome);

    /*
     * The terminal write is t2's `completeCheck`, not a hand-built `$set`: the
     * ledger owns the row shape and enforces "only the current lease holder may
     * complete a non-terminal check". It must run **before** the queue's
     * `complete`, which releases the lease — the ledger's filter keys on it.
     */
    await completeCheck(this.healthDb, {
      checkId: item.id,
      owner: this.owner,
      state: terminal,
      now: this.clock(),
      latencyMs,
      result: {
        outcome: terminal === 'skipped' ? null : toSchemaOutcome(outcome),
        depth: lastResult.depth ?? (outcome === 'healthy' ? 'segments' : 'transport'),
        failure:
          terminal === 'failed'
            ? {
                category: code,
                cause: failureCause(code),
                message: lastResult.failure?.detail ?? 'check failed',
                depth: lastResult.depth ?? 'transport',
              }
            : null,
        uncertainty: {
          browserNotProbed: true,
          segmentsNotSampled: lastResult.segmentsSampled !== true,
          leaseExpired: false,
          manifestTruncated: false,
          notes: lastResult.uncertainty?.notes ?? [],
        },
        evidence: {
          httpStatus: lastResult.evidence?.httpStatus ?? null,
          contentType: lastResult.evidence?.contentType ?? null,
          bytes: lastResult.evidence?.bytes ?? null,
          sampleSha256: null,
          urls: [],
          segmentStatuses: [],
          manifest: null,
          latencyMs,
          samplesRequested: lastResult.egressRequests ?? 0,
          samplesAttempted: lastResult.egressRequests ?? 0,
        },
        eligibilityAt: preEligibility,
      },
    });
    // Keep the queue fast path in step with the durable row the ledger just wrote.
    await this.queue.complete(item.id, {
      outcome: outcome === 'aborted' ? null : toSchemaOutcome(outcome),
      state: terminal,
    });

    this.metrics?.checksTotal(outcome);
    this.metrics?.observeLatency(latencyMs, { kind: 'scheduled', outcome });

    if (terminal === 'failed') {
      this.metrics?.failureTotal(failureCause(code));
      /*
       * A thrown policy refusal (SSRF block, credential-in-url) describes our
       * rules, not the destination: it sent no request, so it must not open the
       * circuit for a shared host. An answered permanent failure does count.
       */
      const blamesDestination =
        lastResult.thrown === true ? countsTowardBreakerOnThrow(lastResult.thrownError) : countsTowardBreaker(code);
      if (blamesDestination) {
        /*
         * Stamped with the ROUND's instant, not the wall clock: the planner
         * decides admissibility with `now`, so the breaker's window must be
         * measured on the same timeline or a probe looks re-armed immediately.
         */
        this.breakers.recordFailure('source', source.sourceId, now);
        this.breakers.recordFailure('host', source.host, now);
      }
      this.breakers.releaseProbe('source', source.sourceId);
      this.breakers.releaseProbe('host', source.host);
      // Aggregate health moves only here — a terminal, failed check.
      await applyToAggregate(this.healthDb, item.id, {
        nextCheckAt: ({ status, from }) => new Date(from.getTime() + intervalFor(status)),
      });
    } else {
      this.breakers.recordSuccess('source', source.sourceId);
      this.breakers.recordSuccess('host', source.host);
      this.breakers.releaseProbe('source', source.sourceId);
      this.breakers.releaseProbe('host', source.host);
      if (terminal === 'done') {
        await applyToAggregate(this.healthDb, item.id, {
          nextCheckAt: ({ status, from }) => new Date(from.getTime() + intervalFor(status)),
        });
      }
    }

    return {
      sourceId: source.sourceId,
      checkId: item.id,
      outcome,
      state: terminal,
      attempts,
      latencyMs,
      egressRequests,
    };
  }

  private async safeValidate(source: PlannedSource, attempt: number): Promise<ValidationResult> {
    const request: ValidationRequest = {
      sourceId: source.sourceId,
      url: source.url,
      type: source.type,
      attempt,
      headFirst: true,
      /*
       * Segments are only offered after the manifest gate: the planner cannot
       * know in advance whether the manifest will pass, so it never asks for
       * segment sampling on the first attempt. That is the "no segment checks
       * when the manifest failed" rule, enforced as a request property.
       */
      requireSegments: false,
      browser: false,
      budget: { requestCount: 1 },
    };
    try {
      const result = await this.validator.validate(request);
      return { started: true, ...result };
    } catch (error) {
      /*
       * A validator that throws is either an egress refusal (an `EgressFailure`
       * with a closed code) or a control-plane bug. Both are recorded as a
       * terminal failure — a check must not sit `running` forever — but only a
       * *retryable* thrown failure is ever attempted again (see the loop in
       * `runOne`, which uses `isRetryableThrown`).
       */
      const thrown = failureCodeOfThrown(error);
      this.logger?.warn(
        { sourceId: source.sourceId, attempt, code: egressCodeOf(error), failure: thrown },
        'validator threw; recorded as a failure',
      );
      return {
        outcome: thrown,
        started: true,
        egressRequests: 1,
        failure: { code: thrown, httpStatus: null, detail: 'validator threw' },
        thrown: true,
        thrownError: error,
      };
    }
  }

  /* ------------------------------------------------------------- recovery */

  /**
   * Crash recovery (contract §6): a check whose lease expired is reclaimed as
   * `failed`/`unknown` with `uncertainty.leaseExpired`, and its source is
   * re-queued. **No aggregated health is written here** — a lease that ran out
   * says nothing about the source, only about the process that held it.
   *
   * The reclaim itself is t2's `recoverExpiredLeases`, which reports
   * `healthRowsChanged: 0` for exactly that reason; this method adds what the
   * scheduler owns: the queue re-enqueue and the operator report.
   */
  async reconcile(now: Date = this.clock()): Promise<ReconcileReport> {
    /*
     * Read the owners *before* reclaiming: the ledger clears `lease` as part of
     * the same write that marks the row failed, so afterwards there is nobody to
     * blame (and an operator report of "which process died" would be empty).
     */
    const abandoned = await this.healthDb
      .checks()
      .find({ state: { $in: ['pending', 'running'] }, 'lease.expiresAt': { $lte: now } })
      .toArray();
    const owners = [...new Set(abandoned.map((row) => row.lease?.owner ?? 'unknown'))];

    const recovery = await recoverExpiredLeases(this.healthDb, { now });
    // A reclaimed lease is a *check* event, not a source verdict: count it as the
    // neutral outcome the ledger wrote (`unknown`), never as a failure category.
    for (const row of recovery.recovered) this.metrics?.checksTotal(row.outcome ?? 'unknown');

    const requeued = await this.requeueOrphans(now);
    this.logger?.info(
      { reclaimed: recovery.recovered.length, requeued, owners, healthRowsChanged: recovery.healthRowsChanged },
      'verification leases reconciled',
    );
    return { reclaimed: recovery.recovered.length, requeued, owners, at: now };
  }

  /**
   * Re-queues `pending` rows that the queue lost (a Redis eviction, a crashed
   * process between insert and claim). Ordering comes from `scheduledForAt` when
   * present and from the row's `createdAt` otherwise, so a row a worker merely
   * released (which keeps its original createdAt) is still re-queued. The
   * deterministic `_id` makes it idempotent: re-enqueueing a present row is a
   * no-op, so nothing is duplicated and nothing is dropped.
   */
  async requeueOrphans(now: Date): Promise<number> {
    const orphans = await this.healthDb.checks().find({ state: 'pending' }).limit(500).toArray();
    let requeued = 0;
    for (const orphan of orphans) {
      const at = (orphan as unknown as { scheduledForAt?: Date }).scheduledForAt ?? orphan.createdAt;
      if (!(at instanceof Date) || at.getTime() > now.getTime()) continue;
      await this.queue.requeue(orphan._id, at.toISOString());
      requeued += 1;
    }
    return requeued;
  }

  /** Operator view: how many checks sit in each state right now. */
  async statusGrid(): Promise<{
    checks: Awaited<ReturnType<QueueBackend['statusCounts']>>;
    sources: Record<HealthStatus, number>;
    circuitsOpen: number;
    queue: { backend: 'mongo' | 'redis'; degraded: boolean; lastError: string | null };
  }> {
    const counts = await this.queue.statusCounts();
    const rows = await this.healthDb
      .health()
      .aggregate<{ _id: HealthStatus; count: number }>([{ $group: { _id: '$status', count: { $sum: 1 } } }])
      .toArray();
    const sources: Record<HealthStatus, number> = {
      healthy: 0,
      degraded: 0,
      failing: 0,
      unknown: 0,
      paused: 0,
      unverifiable: 0,
    };
    for (const row of rows) sources[row._id] = row.count;
    for (const status of Object.keys(sources) as HealthStatus[]) this.metrics?.setSourcesByStatus(status, sources[status]);
    return {
      checks: counts,
      sources,
      circuitsOpen: this.breakers.openCount(),
      queue: { backend: this.queue.name, degraded: this.queue.degraded, lastError: this.queue.lastError },
    };
  }
}

/** Base interval by aggregated status (contract §4). */
export function intervalFor(status: HealthStatus): number {
  switch (status) {
    case 'healthy':
      return 6 * 60 * 60 * 1000;
    case 'degraded':
      return 2 * 60 * 60 * 1000;
    case 'failing':
      return 30 * 60 * 1000;
    case 'unverifiable':
      return 60 * 60 * 1000;
    case 'unknown':
      return 15 * 60 * 1000;
    case 'paused':
      return 0;
  }
}

/** Exported for the operator "manual retry" path: it must share the check id shape. */
export { checkId, isoTimestamp };

/** Convenience: does this outcome exist in the closed vocabulary? */
export function isOutcomeCode(value: string): boolean {
  return isCheckOutcomeCode(value);
}

/** Re-exported so a caller can build a `FailureDetail` without importing t2. */
export type { FailureDetail } from './health.schema.js';
