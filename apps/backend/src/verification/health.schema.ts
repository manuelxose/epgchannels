/**
 * Persistence shapes for automated stream verification (MODULE-CONTRACT-02D §1).
 *
 * Three collections, three responsibilities, and no reuse of the legacy
 * `source_health` collection (its `_id` is a candidate id, so reusing it would be
 * a silent remapping). The names live here — in this module — because the
 * verification milestone owns them; `infrastructure/mongo.ts` is another
 * writer's file and editing it was explicitly out of scope for this task.
 * `HEALTH_COLLECTIONS` is the single source of truth for the three names and is
 * what a future wiring in `COLLECTIONS` should import.
 */
import type { FailureCategory } from './failures.js';

export const HEALTH_COLLECTIONS = {
  /** One immutable row per verification attempt. */
  checks: 'source_health_checks_02d',
  /** Aggregate state + bounded ring history per source. */
  health: 'source_health_02d',
  /** Kill-switch and operator controls per provider/host. */
  policies: 'verification_policies_02d',
} as const;

export type HealthCollectionName = (typeof HEALTH_COLLECTIONS)[keyof typeof HEALTH_COLLECTIONS];

/** The layers of the validation engine (contract §3). */
export const VALIDATION_DEPTHS = [
  'eligibility',
  'dns',
  'transport',
  'manifest',
  'playlist',
  'segments',
  'browser',
] as const;

export type ValidationDepth = (typeof VALIDATION_DEPTHS)[number];

/** Terminal outcomes a check may produce. `null` while it is still running. */
export const CHECK_OUTCOMES = [
  'healthy',
  'degraded',
  'failing',
  'unknown',
  'unverifiable',
  'ineligible',
  'paused',
] as const;

export type CheckOutcomeCode = (typeof CHECK_OUTCOMES)[number];

export const FAILURE_CAUSES = ['authorization', 'network', 'protocol', 'content', 'browser', 'policy'] as const;

export type FailureCause = (typeof FAILURE_CAUSES)[number];

export const CHECK_STATES = ['pending', 'running', 'done', 'failed', 'skipped'] as const;

export type CheckState = (typeof CHECK_STATES)[number];

/** Aggregate health status (contract §1.2). */
export const HEALTH_STATUSES = ['healthy', 'degraded', 'failing', 'unknown', 'paused', 'unverifiable'] as const;

export type HealthStatus = (typeof HEALTH_STATUSES)[number];

/** A terminal check state: only these may move aggregate health. */
export function isTerminalCheckState(state: CheckState): boolean {
  return state === 'done' || state === 'failed' || state === 'skipped';
}

/**
 * What the 02C eligibility gate said *at the moment of the check*. Persisted as
 * audit, never re-read as a permission: a right recorded later does not
 * retroactively bless an old probe, and a right revoked later does not erase the
 * fact that the probe was authorised when it ran.
 */
export interface EligibilitySnapshot {
  readonly playable: boolean;
  /** The five-way class the gate resolved, or `null` when nothing was recorded. */
  readonly verdict: string | null;
  /** Machine-readable denial/materialisation reason (`authorization-unresolved`, …). */
  readonly reason: string | null;
  readonly publicationReason: string | null;
  readonly authorizationReason: string | null;
  /** When this snapshot was taken. */
  readonly at: Date;
}

/** Where the probe was launched from and under which policy. */
export interface CheckOrigin {
  /** Egress host the request left from (label, never an IP of a person). */
  readonly egressHost: string;
  readonly region: string | null;
  readonly userAgent: string;
  /** Policy snapshot applied (`policyId` version), for audit. */
  readonly policy: string;
}

export interface CheckTimings {
  readonly queuedAt: Date;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  readonly latencyMs: number | null;
}

export interface CheckAttempt {
  readonly number: number;
  readonly maxAttempts: number;
  readonly backoffMs: number;
}

export interface CheckLease {
  readonly owner: string;
  readonly expiresAt: Date;
}

/**
 * Bounded evidence: status codes, sizes, digests of a *sample*. Never the
 * manifest text, never a tokenized URL (D-015), never a response body.
 */
export interface BoundedEvidence {
  readonly httpStatus: number | null;
  readonly contentType: string | null;
  readonly bytes: number | null;
  /** SHA-256 of the bounded sample (first 4 KiB for manifests). */
  readonly sampleSha256: string | null;
  /** Redacted, credential-free URLs actually probed, in order. */
  readonly urls: readonly string[];
  readonly segmentStatuses: readonly number[];
  readonly manifest: ManifestFactsSummary | null;
  readonly latencyMs: number | null;
  /** Sample markers too long to be a sampling bug when recounted. */
  readonly samplesRequested: number;
  readonly samplesAttempted: number;
}

/** Structured facts only — the parser never returns playlist text. */
export interface ManifestFactsSummary {
  readonly format: 'hls-master' | 'hls-media' | 'dash';
  readonly mimeType: string;
  readonly startsWithExtM3u: boolean;
  readonly mediaSequence: number | null;
  readonly segmentCount: number;
  readonly variantCount: number;
  readonly targetDuration: number | null;
  readonly endsWithEndList: boolean;
  readonly first4KiBSha256: string;
  readonly parsedBytes: number;
}

/** What could NOT be observed, and why. Never inferred into a health claim. */
export interface Uncertainty {
  readonly browserNotProbed: boolean;
  readonly segmentsNotSampled: boolean;
  readonly leaseExpired: boolean;
  readonly manifestTruncated: boolean;
  /** Free-form, machine-readable reasons; never prose from a third party. */
  readonly notes: readonly string[];
}

export const EMPTY_UNCERTAINTY: Uncertainty = Object.freeze({
  browserNotProbed: false,
  segmentsNotSampled: false,
  leaseExpired: false,
  manifestTruncated: false,
  notes: [],
});

export interface FailureDetail {
  /** Exactly one of the contract vocabulary. */
  readonly category: FailureCategory;
  readonly cause: FailureCause;
  /** Human-readable, our own words; never a body excerpt from the origin. */
  readonly message: string;
  readonly depth: ValidationDepth;
}

/** `source_health_checks_02d` (§1.1). */
export interface CheckRunDoc {
  /** Idempotency key: `${sourceId}:${scheduledForISO}`. */
  _id: string;
  sourceId: string;
  kind: 'scheduled' | 'manual' | 'retry';
  trigger: { actor: string; reason: string | null };
  state: CheckState;
  /** Terminal only; `null` while pending/running. */
  outcome: CheckOutcomeCode | null;
  depth: ValidationDepth;
  eligibilityAt: EligibilitySnapshot;
  origin: CheckOrigin;
  timings: CheckTimings;
  attempt: CheckAttempt;
  failure: FailureDetail | null;
  uncertainty: Uncertainty;
  evidence: BoundedEvidence;
  lease: CheckLease | null;
  createdAt: Date;
}

/** One ring-buffer sample of `source_health_02d`. */
export interface HealthSample {
  readonly at: Date;
  readonly outcome: CheckOutcomeCode;
  readonly cause: FailureCause | null;
  readonly depth: ValidationDepth;
  readonly latencyMs: number | null;
  readonly checkId: string;
}

/** `source_health_02d` (§1.2). */
export interface HealthAggregateDoc {
  /** sourceId */
  _id: string;
  status: HealthStatus;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  lastOutcome: CheckOutcomeCode | null;
  lastCheckedAt: Date | null;
  nextCheckAt: Date;
  circuit: { state: 'closed' | 'open' | 'half-open'; openedAt: Date | null; reopenCount: number };
  history: HealthSample[];
  /** CAS token. */
  revision: number;
  updatedAt: Date;
}

/** `verification_policies_02d`: kill-switch and operator controls. */
export interface VerificationPolicyDoc {
  /** `global`, `provider:<id>`, `host:<host>` or `source:<sourceId>`. */
  _id: string;
  scope: 'global' | 'provider' | 'host' | 'source';
  /** When false, no automated check is scheduled or started in this scope. */
  enabled: boolean;
  /** Operator-triggered pause; never erases history. */
  paused: boolean;
  browserChecks: 'manual-only' | 'disabled' | 'enabled';
  /** Requests allowed per host per round. */
  maxConcurrentPerHost: number;
  /** Requests allowed per scheduler tick. */
  maxPerTick: number;
  leaseTtlMs: number;
  maxAttempts: number;
  historySize: number;
  actor: string;
  reason: string | null;
  updatedAt: Date;
  revision: number;
}
