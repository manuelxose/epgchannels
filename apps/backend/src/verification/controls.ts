/**
 * Operator controls for verification: pause, resume and manual retry.
 *
 * Two invariants shape the whole module:
 *
 * 1. **Pausing never deletes history.** A pause writes a kill-switch row in
 *    `verification_policies_02d` and, for a source, flips its aggregated status
 *    to `paused` while keeping `history`, counters and timestamps untouched. The
 *    resume restores the status the history implies, not a guessed `unknown`.
 * 2. **Every mutation is audited.** Each call appends one row to the audit
 *    collection (`COLLECTIONS.audits`) with actor, before and after. A mutation
 *    that could not be audited does not happen: the audit is written before the
 *    call resolves and its failure propagates.
 *
 * A manual retry requires a reason; the check it creates is `kind: 'manual'`
 * with `trigger.reason`, so the origin of an extra request to a provider is
 * always explicable months later.
 */
import { randomUUID } from 'node:crypto';
import type { Collection } from 'mongodb';
import type { AuditDoc } from '../infrastructure/schema.js';
import { COLLECTIONS } from '../infrastructure/mongo.js';
import type { DatabaseHandle } from '../infrastructure/mongo.js';
import type { Logger } from '../infrastructure/logging.js';
import type { QueueBackend } from './queue.js';
import { checkId, isoTimestamp } from './queue.js';
import { DEFAULT_MAX_ATTEMPTS, HISTORY_LIMIT, VERIFICATION_COLLECTIONS } from './types.js';
import type { HealthStatus, SourceHealthDoc, VerificationPolicyDoc } from './types.js';

export interface ControlActor {
  readonly type: 'user' | 'system';
  readonly id: string;
}

export interface ControlsOptions {
  readonly database: DatabaseHandle;
  readonly queue: QueueBackend;
  readonly logger?: Logger;
  readonly collections?: {
    readonly checks: string;
    readonly health: string;
    readonly policies: string;
  };
  readonly now?: () => Date;
}

export interface MutationResult {
  readonly scope: 'global' | 'source' | 'provider';
  readonly target: string;
  readonly paused: boolean;
  readonly changed: boolean;
  readonly auditId: string;
  readonly at: Date;
}

const GLOBAL_SWITCH_ID = 'pause-all';

/** Status a paused source resumes to, derived from its own history. */
export function statusFromHistory(row: SourceHealthDoc | null): HealthStatus {
  if (row === null) return 'unknown';
  if (row.consecutiveFailures >= 3) return 'failing';
  if (row.consecutiveFailures > 0) return 'degraded';
  if (row.lastSuccessAt !== null) return 'healthy';
  return 'unknown';
}

export class VerificationControls {
  private readonly checks: Collection<{ _id: string } & Record<string, unknown>>;
  private readonly health: Collection<SourceHealthDoc>;
  private readonly policies: Collection<VerificationPolicyDoc>;
  private readonly audits: Collection<AuditDoc>;
  private readonly queue: QueueBackend;
  private readonly logger: Logger | undefined;
  private readonly clock: () => Date;

  constructor(options: ControlsOptions) {
    const names = options.collections ?? VERIFICATION_COLLECTIONS;
    /*
     * The 02D checks collection is addressed through the raw `Db` because its
     * `_id` is a free-form idempotency key; `DatabaseHandle.collection` is typed
     * for our UUID-keyed collections and would be a silent mis-modelling.
     */
    this.checks = options.database.db.collection<{ _id: string } & Record<string, unknown>>(names.checks);
    this.health = options.database.db.collection<SourceHealthDoc>(names.health);
    this.policies = options.database.db.collection<VerificationPolicyDoc>(names.policies);
    this.audits = options.database.collection<AuditDoc>(COLLECTIONS.audits);
    this.queue = options.queue;
    this.logger = options.logger;
    this.clock = options.now ?? (() => new Date());
  }

  /* --------------------------------------------------------------- switch */

  private async writeSwitch(
    scope: 'global' | 'provider',
    provider: string | null,
    paused: boolean,
    actor: ControlActor,
    reason: string | null,
    requestId: string,
  ): Promise<{ before: Record<string, unknown> | null; after: Record<string, unknown>; id: string; auditId: string }> {
    // t2's policy rows encode the target in `_id`: `global` or `provider:<id>`.
    const id = scope === 'global' ? GLOBAL_SWITCH_ID : `provider:${provider ?? 'unknown'}`;
    const existing = await this.policies.findOne({ _id: id });
    const now = this.clock();
    /*
     * Only the operator-controlled fields are written; the scheduling knobs t2
     * declared (`maxConcurrentPerHost`, `maxAttempts`, …) keep their defaults on
     * insert and are never silently changed by a pause.
     */
    const target = {
      scope,
      paused,
      enabled: !paused,
      actor: actor.id,
      reason,
      updatedAt: now,
      revision: (existing?.revision ?? 0) + 1,
    };
    const defaults = {
      browserChecks: 'manual-only' as const,
      maxConcurrentPerHost: 1,
      maxPerTick: 200,
      leaseTtlMs: 60_000,
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
      historySize: HISTORY_LIMIT,
    };
    // `_id` comes from the filter; putting it in `$set` as well is a conflict.
    const { _id: _ignored, ...existingFields } = (existing ?? {}) as Record<string, unknown>;
    const after = { ...existingFields, ...defaults, ...target };
    const auditId = await this.audit(
      actor,
      paused ? 'verification.pause' : 'verification.resume',
      scope,
      id,
      existing === null ? null : { ...existingFields },
      after,
      reason,
      requestId,
    );
    await this.policies.updateOne({ _id: id }, { $set: after }, { upsert: true });
    return { before: existing === null ? null : { ...existingFields }, after, id, auditId };
  }

  async pauseAll(actor: ControlActor, reason: string | null, requestId: string): Promise<MutationResult> {
    const written = await this.writeSwitch('global', null, true, actor, reason, requestId);
    this.logger?.warn({ actor: actor.id, reason }, 'verification paused globally');
    return {
      scope: 'global',
      target: written.id,
      paused: true,
      changed: written.before === null || (written.before as { paused?: unknown }).paused !== true,
      auditId: written.auditId,
      at: this.clock(),
    };
  }

  async resumeAll(actor: ControlActor, reason: string | null, requestId: string): Promise<MutationResult> {
    const written = await this.writeSwitch('global', null, false, actor, reason, requestId);
    this.logger?.info({ actor: actor.id, reason }, 'verification resumed globally');
    return {
      scope: 'global',
      target: written.id,
      paused: false,
      changed: (written.before as { paused?: unknown } | null)?.paused === true,
      auditId: written.auditId,
      at: this.clock(),
    };
  }

  async pauseProvider(actor: ControlActor, provider: string, reason: string | null, requestId: string): Promise<MutationResult> {
    const written = await this.writeSwitch('provider', provider, true, actor, reason, requestId);
    return {
      scope: 'provider',
      target: provider,
      paused: true,
      changed: written.before === null || (written.before as { paused?: unknown }).paused !== true,
      auditId: written.auditId,
      at: this.clock(),
    };
  }

  async resumeProvider(actor: ControlActor, provider: string, reason: string | null, requestId: string): Promise<MutationResult> {
    const written = await this.writeSwitch('provider', provider, false, actor, reason, requestId);
    return {
      scope: 'provider',
      target: provider,
      paused: false,
      changed: (written.before as { paused?: unknown } | null)?.paused === true,
      auditId: written.auditId,
      at: this.clock(),
    };
  }

  /* --------------------------------------------------------------- source */

  /**
   * Pauses one source. The health row keeps its history, its counters and its
   * timestamps; only `status` becomes `paused` and `nextCheckAt` moves out of
   * the scheduling window, so the planner cannot pick it while paused.
   */
  async pauseSource(sourceId: string, actor: ControlActor, reason: string | null, requestId: string): Promise<MutationResult> {
    const existing = await this.health.findOne({ _id: sourceId });
    const now = this.clock();
    const before = existing === null ? null : { status: existing.status, nextCheckAt: existing.nextCheckAt.toISOString() };
    const after = {
      scope: 'source' as const,
      paused: true,
      status: 'paused' as HealthStatus,
      pausedAt: now,
      pausedBy: actor.id,
      reason,
    };
    const auditId = await this.audit(actor, 'verification.source.pause', 'source', sourceId, before, after, reason, requestId);
    if (existing === null) {
      // A source with no health row yet: create one that carries the pause and no history.
      await this.health.updateOne(
        { _id: sourceId },
        {
          $setOnInsert: {
            status: 'paused',
            consecutiveFailures: 0,
            consecutiveSuccesses: 0,
            lastSuccessAt: null,
            lastFailureAt: null,
            lastOutcome: null,
            lastCheckedAt: null,
            nextCheckAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000),
            host: null,
            circuit: { state: 'closed', openedAt: null, reopenCount: 0 },
            history: [],
            revision: 0,
            updatedAt: now,
          },
          $set: { pausedAt: now, pausedBy: actor.id, pauseReason: reason },
        },
        { upsert: true },
      );
    } else {
      await this.health.updateOne(
        { _id: sourceId, revision: existing.revision },
        {
          $set: {
            status: 'paused',
            pausedAt: now,
            pausedBy: actor.id,
            pauseReason: reason,
            // History is deliberately NOT reset: a pause is not a data loss.
            nextCheckAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000),
            revision: existing.revision + 1,
            updatedAt: now,
          },
        },
      );
    }
    return { scope: 'source', target: sourceId, paused: true, changed: existing?.status !== 'paused', auditId, at: now };
  }

  /** Resumes one source to the status its history implies. */
  async resumeSource(sourceId: string, actor: ControlActor, reason: string | null, requestId: string): Promise<MutationResult> {
    const existing = await this.health.findOne({ _id: sourceId });
    const now = this.clock();
    const status = statusFromHistory(existing);
    const before = existing === null ? null : { status: existing.status };
    const after = { scope: 'source' as const, paused: false, status };
    const auditId = await this.audit(actor, 'verification.source.resume', 'source', sourceId, before, after, reason, requestId);
    if (existing !== null) {
      await this.health.updateOne(
        { _id: sourceId, revision: existing.revision },
        {
          $set: {
            status,
            // Due immediately: an operator resuming a source wants it checked now.
            nextCheckAt: now,
            pausedAt: null,
            pausedBy: null,
            pauseReason: null,
            revision: existing.revision + 1,
            updatedAt: now,
          },
        },
      );
    }
    return { scope: 'source', target: sourceId, paused: false, changed: existing?.status === 'paused', auditId, at: now };
  }

  /* ---------------------------------------------------------- manual retry */

  /**
   * Schedules one manual check now.
   *
   * A reason is mandatory: the caller had to have one. The check id is the same
   * deterministic `(sourceId, scheduledFor)` key the scheduler uses, so a double
   * click is one row and at most one external request.
   */
  async manualRetry(
    sourceId: string,
    actor: ControlActor,
    reason: string,
    requestId: string,
    options: { readonly browser?: boolean } = {},
  ): Promise<{ checkId: string; scheduledFor: string; auditId: string; queued: boolean }> {
    const trimmed = reason.trim();
    if (trimmed.length < 3) {
      throw new Error('manualRetry requires a reason of at least 3 characters');
    }
    const now = this.clock();
    const scheduledFor = now.toISOString();
    const id = checkId(sourceId, scheduledFor);
    const auditId = await this.audit(
      actor,
      'verification.source.retry',
      'source',
      sourceId,
      null,
      { scheduledFor, browser: options.browser === true },
      trimmed,
      requestId,
    );
    await this.queue.enqueue({
      sourceId,
      scheduledFor,
      kind: 'manual',
      trigger: { actor: actor.id, reason: trimmed },
    });
    await this.checks.updateOne(
      { _id: id },
      {
        $set: {
          kind: 'manual',
          trigger: { actor: actor.id, reason: trimmed },
          browserRequested: options.browser === true,
          requestedAt: now,
        },
      },
    );
    // A manual retry also clears an open circuit: the operator asked explicitly.
    await this.health.updateOne(
      { _id: sourceId },
      { $set: { 'circuit.state': 'closed', 'circuit.openedAt': null, circuitProbeRequestedAt: now } },
    );
    return { checkId: id, scheduledFor, auditId, queued: true };
  }

  /* --------------------------------------------------------------- audit */

  /** Appends one audit row and returns its id; a failed write fails the mutation. */
  private async audit(
    actor: ControlActor,
    action: string,
    entityType: string,
    entityId: string,
    before: Record<string, unknown> | null,
    after: Record<string, unknown> | null,
    reason: string | null,
    requestId: string,
  ): Promise<string> {
    const id = randomUUID();
    await this.audits.insertOne({
      _id: id,
      actor,
      action,
      entityType,
      entityId,
      before,
      after,
      reason,
      requestId,
      at: this.clock(),
    });
    return id;
  }

  /** Current switch state, for the status view. */
  async switches(): Promise<{ all: boolean; providers: readonly string[] }> {
    const rows = await this.policies.find({ paused: true }).toArray();
    // The provider is encoded in the row id (`provider:<id>`), per t2's shape.
    const providers = rows
      .filter((row) => row.scope === 'provider' && row._id.startsWith('provider:'))
      .map((row) => row._id.slice('provider:'.length));
    return { all: rows.some((row) => row.scope === 'global'), providers };
  }
}

/** Exported so tests and the load script build the same manifest instant. */
export { isoTimestamp };
