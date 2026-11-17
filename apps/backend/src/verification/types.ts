/**
 * Scheduler-side vocabulary, aligned with the t2 validation engine.
 *
 * The row shapes and the failure vocabulary are **owned by t2** and live in
 * `health.schema.ts` and `failures.ts`. This module does not restate them: it
 * re-exports them under the names the scheduler uses and adds only what the
 * scheduler itself decides about them (which failures are permanent, which feed
 * a circuit breaker, how layers order).
 *
 * That separation is deliberate. Two copies of the failure list is how a
 * taxonomy silently forks; there is exactly one list, and this file points at it.
 */
import { FAILURE_CATEGORIES, FAILURE_CAUSE, isRetryable } from './failures.js';
import type { FailureCategory } from './failures.js';
import { HEALTH_COLLECTIONS, isTerminalCheckState } from './health.schema.js';
import type {
  CheckOutcomeCode as SchemaOutcome,
  CheckRunDoc,
  CheckState,
  FailureCause,
  HealthAggregateDoc,
  HealthStatus,
  ValidationDepth,
} from './health.schema.js';

export type { FailureCategory };
export type { CheckRunDoc, CheckState, FailureCause, HealthStatus, ValidationDepth };
export type { HealthAggregateDoc, HealthSample, VerificationPolicyDoc } from './health.schema.js';

/** The 02D collection names, as t2 declared them. */
export const VERIFICATION_COLLECTIONS = HEALTH_COLLECTIONS;

/** Contract §1.3, from the one place that defines it. */
export const FAILURE_CODES = FAILURE_CATEGORIES;

export type FailureCode = FailureCategory;

const FAILURE_SET: ReadonlySet<string> = new Set(FAILURE_CATEGORIES);

export function isFailureCode(value: string): value is FailureCode {
  return FAILURE_SET.has(value);
}

/**
 * What a validator reports for one attempt: a failure category or one of the
 * non-failure ends. `aborted` is ours, not the validator's: it means the check
 * never ran (deferred or cancelled) and must not be recorded as a source verdict.
 */
export type CheckOutcomeCode = SchemaOutcome | 'aborted';

export function isCheckOutcomeCode(value: string): value is SchemaOutcome {
  return FAILURE_SET.has(value) || value === 'healthy' || value === 'degraded';
}

/** Which axis a failure belongs to, from t2's single mapping. */
export function failureCause(code: FailureCode): FailureCause {
  return FAILURE_CAUSE[code];
}

/**
 * Failures that retrying cannot fix inside a check.
 *
 * t2's `isRetryable` is the authority for the retryable set; everything else is
 * permanent here, plus `ineligible` and `ssrf-blocked`, which are policy
 * refusals that must never be repeated (a retried refusal is one request too
 * many against a host we already declined).
 */
const POLICY_REFUSALS: ReadonlySet<FailureCode> = new Set<FailureCode>(['ineligible', 'ssrf-blocked']);

export function isPermanentFailure(code: FailureCode): boolean {
  if (POLICY_REFUSALS.has(code)) return true;
  return !isRetryable(code);
}

/**
 * Whether a failure counts towards a circuit breaker.
 *
 * A policy refusal sent no request to the destination, so it must not be blamed
 * on the host — otherwise one bad source record could open the circuit for a
 * whole CDN. Everything the destination itself did counts.
 */
export function countsTowardBreaker(code: FailureCode): boolean {
  return !POLICY_REFUSALS.has(code);
}

/**
 * The egress codes `safeFetch` refuses with, mapped onto the contract vocabulary.
 *
 * `safeFetch` (t1) is the real egress on the production path. It reports a
 * refusal either as a thrown `EgressFailure` or, through t2's `EgressFn` seam,
 * as `EgressResponse.transportError`; both are the same closed code set, so both
 * must land in the same failure category before any retry decision is taken.
 * A code not listed here is mapped to `unknown-error`, which is permanent.
 */
const FAILURE_OF_EGRESS_CODE: Readonly<Record<string, FailureCode>> = {
  // Retryable: the transient side may be ours or the network's.
  timeout: 'timeout',
  'dns-failure': 'dns-failure',
  'connection-failed': 'connection-refused',
  'tls-failure': 'tls-failure',
  // Permanent refusals: waiting cannot change the answer.
  'host-blocked': 'ssrf-blocked',
  'private-address': 'ssrf-blocked',
  'dns-rebind': 'ssrf-blocked',
  'redirect-unsafe': 'redirect-unsafe',
  'too-many-redirects': 'redirect-unsafe',
  'response-too-large': 'response-too-large',
  'credential-in-url': 'ineligible',
  'invalid-url': 'ineligible',
  'scheme-not-allowed': 'unsupported-format',
  'content-type-not-allowed': 'unsupported-format',
};

/**
 * The failure category of an egress code such as `EgressResponse.transportError`.
 *
 * This is the single door from t1's egress vocabulary into the contract's, used
 * by the scheduler for *both* a thrown `EgressFailure` and a returned
 * `transportError`, so one egress code can never be classified two ways
 * depending on whether it arrived by throw or by return.
 */
export function failureCodeOfEgressCode(code: string | null | undefined): FailureCode {
  if (code === null || code === undefined) return 'unknown-error';
  return FAILURE_OF_EGRESS_CODE[code] ?? 'unknown-error';
}

const DEPTH_ORDER: readonly ValidationDepth[] = [
  'eligibility',
  'dns',
  'transport',
  'manifest',
  'playlist',
  'segments',
  'browser',
];

export function depthRank(depth: ValidationDepth): number {
  const index = DEPTH_ORDER.indexOf(depth);
  return index < 0 ? 0 : index;
}

/** A source document trimmed to what the planner reads. */
export interface TrimmedSource {
  readonly _id: string;
  readonly url: string | null;
  readonly type: string;
  readonly provider: string;
  readonly editorialStatus: string;
  readonly priority: number;
}

/** The scheduler reads the same rows t2 writes; these aliases keep call sites readable. */
export type SourceHealthCheckDoc = CheckRunDoc;
export type SourceHealthDoc = HealthAggregateDoc;

export const DEFAULT_MAX_ATTEMPTS = 3;
export const CIRCUIT_FAILURE_THRESHOLD = 5;
export const CIRCUIT_MAX_WINDOW_MS = 60 * 60 * 1000;
export const CIRCUIT_BASE_WINDOW_MS = 5 * 60 * 1000;
export const HISTORY_LIMIT = 30;

/** Re-exported so a caller decides terminality exactly as the ledger does. */
export { isTerminalCheckState };
