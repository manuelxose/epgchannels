/**
 * Reading an egress code out of a value that was THROWN rather than returned.
 *
 * ## Status: an adapter into the policy, NOT the policy itself
 *
 * On the production path the scheduler decides retryability and circuit-breaker
 * accounting from the **validator result**, not from thrown errors:
 *
 * ```
 * scheduler.runOne -> decisionFailureCode(result) -> types.isPermanentFailure / types.countsTowardBreaker
 * ```
 *
 * with egress codes entering through `types.failureCodeOfEgressCode(...)`. That
 * is deliberate: t2's `EgressFn` seam is `Promise<EgressResponse>`, so the
 * production adapter in `runtime.ts` **catches** `EgressFailure` and returns
 * `EgressResponse.transportError`. `ValidationResult.thrown` is therefore never
 * true in production.
 *
 * An earlier revision exported `isRetryableThrown` / `isPermanentThrown` /
 * `countsTowardBreakerOnThrow` here, which made that dead channel look like the
 * retry policy and let one egress code be classified two different ways
 * depending on whether it arrived by throw or by return. Those three functions
 * are **removed**; the vocabulary lives once, in `types.ts`.
 *
 * ## What remains, and why
 *
 * A validator implementation may still throw instead of returning (a custom
 * executor, or a future seam change). When that happens the scheduler converts
 * the thrown value into a failure *category* here and then feeds it into exactly
 * the same decision functions as a returned code — one policy, two adapters.
 */
import type { FailureCode } from './types.js';
import { failureCodeOfEgressCode } from './types.js';

/**
 * The egress code carried by a thrown value, read defensively: this works for an
 * `EgressFailure` from another module instance, for a structurally similar
 * error, and for anything else (which yields `null`).
 */
export function egressCodeOf(error: unknown): string | null {
  if (error === null || typeof error !== 'object') return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.length > 0 ? code : null;
}

/**
 * The failure category of a thrown error, via the same egress-code door the
 * returned-value path uses. An unrecognised thrown value is `unknown-error`,
 * which the policy treats as permanent — fail closed.
 */
export function failureCodeOfThrownError(error: unknown): FailureCode {
  return failureCodeOfEgressCode(egressCodeOf(error));
}
