/**
 * Classification of what a validator call throws.
 *
 * The validator performs network I/O through the 02D safe-egress layer, which
 * throws `EgressFailure` carrying one of a closed set of codes. The scheduler
 * must never guess from the message text, and it must never treat a refusal as
 * a transient fault:
 *
 * | class       | codes                                                              | scheduler effect |
 * | ----------- | ------------------------------------------------------------------ | ---------------- |
 * | retryable   | `timeout`, `dns-failure`, `connection-failed`, `tls-failure`        | retried inside the check, up to the cap |
 * | permanent   | `private-address`, `dns-rebind`, `host-blocked`, `credential-in-url`, `redirect-unsafe`, `too-many-redirects`, `response-too-large`, `content-type-not-allowed`, `invalid-url`, `scheme-not-allowed` | never retried |
 *
 * Retrying a permanent refusal is a security bug, not an inefficiency: one SSRF
 * probe would become three requests, and a `credential-in-url` refusal would be
 * repeated against a host we already declined to contact.
 *
 * The mapping from an egress code to the contract's failure vocabulary lives
 * here too, so there is exactly one place where the two vocabularies meet.
 */
import type { FailureCode } from './types.js';

/** Egress codes that may succeed on a later attempt. */
export const RETRYABLE_EGRESS_CODES: ReadonlySet<string> = new Set([
  'timeout',
  'dns-failure',
  'connection-failed',
  'tls-failure',
]);

/**
 * Egress codes that can only be fixed by changing the source, not by trying
 * again. Listed explicitly, so a new code added upstream defaults to *permanent*
 * (fail closed) rather than being silently retried.
 */
export const PERMANENT_EGRESS_CODES: ReadonlySet<string> = new Set([
  'invalid-url',
  'scheme-not-allowed',
  'host-blocked',
  'private-address',
  'dns-rebind',
  'redirect-unsafe',
  'too-many-redirects',
  'response-too-large',
  'credential-in-url',
  'content-type-not-allowed',
]);

/** The contract failure code an egress refusal maps to. */
const FAILURE_OF_EGRESS: Record<string, FailureCode> = {
  'invalid-url': 'ineligible',
  'scheme-not-allowed': 'unsupported-format',
  'host-blocked': 'ssrf-blocked',
  'private-address': 'ssrf-blocked',
  'dns-rebind': 'ssrf-blocked',
  'redirect-unsafe': 'redirect-unsafe',
  'too-many-redirects': 'redirect-unsafe',
  timeout: 'timeout',
  'response-too-large': 'response-too-large',
  'credential-in-url': 'ineligible',
  'tls-failure': 'tls-failure',
  'dns-failure': 'dns-failure',
  'connection-failed': 'connection-refused',
  'content-type-not-allowed': 'unsupported-format',
};

/**
 * The egress code carried by a thrown value, read defensively: this must work
 * for an `EgressFailure` from another module instance, for a structurally
 * similar error, and for anything else (which yields `null`).
 */
export function egressCodeOf(error: unknown): string | null {
  if (error === null || typeof error !== 'object') return null;
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && code.length > 0) return code;
  return null;
}

/** True only for a thrown failure that deserves another attempt. */
export function isRetryableThrown(error: unknown): boolean {
  const code = egressCodeOf(error);
  if (code === null) return false;
  return RETRYABLE_EGRESS_CODES.has(code);
}

/** True when the error is a refusal we must not repeat. */
export function isPermanentThrown(error: unknown): boolean {
  const code = egressCodeOf(error);
  if (code === null) return false;
  return PERMANENT_EGRESS_CODES.has(code);
}

/** Contract failure code for a thrown error (used for the outage/refusal path). */
export function failureCodeOfThrown(error: unknown): FailureCode {
  const code = egressCodeOf(error);
  if (code === null) return 'unknown-error';
  return FAILURE_OF_EGRESS[code] ?? 'unknown-error';
}

/**
 * The breaker only counts faults that describe the *destination*. A policy
 * refusal (SSRF block, ineligible source) is a statement about our rules, and a
 * host we refuse to contact had zero requests sent to it — it must not be blamed
 * for the failure, or a single bad row could open the circuit for a whole CDN.
 */
export function countsTowardBreakerOnThrow(error: unknown): boolean {
  const code = egressCodeOf(error);
  if (code === null) return false;
  return code !== 'host-blocked' && code !== 'private-address' && code !== 'dns-rebind' && code !== 'credential-in-url';
}
