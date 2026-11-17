/**
 * The failure vocabulary of MODULE-CONTRACT-02D §1.3 — exactly these categories,
 * no more, no fewer.
 *
 * Two things this file refuses to do:
 *
 * 1. It never invents a category. A layer that cannot name one of these says
 *    `unknown-error`, which is how an unobserved cause is reported instead of a
 *    guessed one.
 * 2. It never lets an authorization failure be dressed as an availability one.
 *    `ineligible` is the only category whose cause is `authorization`, and every
 *    cause here answers "which axis failed", never "did the stream work".
 */
import type { FailureCause } from './health.schema.js';

/** The exact vocabulary of contract §1.3, in contract order. */
export const FAILURE_CATEGORIES = [
  'timeout',
  'dns-failure',
  'tls-failure',
  'connection-refused',
  'http-404',
  'http-403',
  'http-401',
  'http-451',
  'http-5xx',
  'invalid-manifest',
  'unsupported-format',
  'missing-segments',
  'segments-forbidden',
  'cors-limitation',
  'browser-incompatible',
  'codec-failure',
  'georestriction',
  'expired-source',
  'ssrf-blocked',
  'ineligible',
  'response-too-large',
  'redirect-unsafe',
  'unknown-error',
] as const;

export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

/**
 * Category → the axis it belongs to. `authorization` has exactly one member
 * (`ineligible`): a right we do not hold is never a network problem.
 */
export const FAILURE_CAUSE: Readonly<Record<FailureCategory, FailureCause>> = {
  timeout: 'network',
  'dns-failure': 'network',
  'tls-failure': 'network',
  'connection-refused': 'network',

  // The origin answered and answered "no". Permanent until policy changes.
  'http-404': 'protocol',
  'http-403': 'protocol',
  'http-401': 'protocol',
  'http-451': 'protocol',

  'http-5xx': 'protocol',
  'redirect-unsafe': 'protocol',

  'invalid-manifest': 'content',
  'unsupported-format': 'content',
  'missing-segments': 'content',
  'segments-forbidden': 'content',
  'expired-source': 'content',
  'response-too-large': 'content',

  'cors-limitation': 'browser',
  'browser-incompatible': 'browser',
  'codec-failure': 'browser',

  'georestriction': 'policy',
  'ssrf-blocked': 'policy',
  ineligible: 'authorization',
  'unknown-error': 'policy',
};

export function isFailureCategory(value: unknown): value is FailureCategory {
  return typeof value === 'string' && (FAILURE_CATEGORIES as readonly string[]).includes(value);
}

/**
 * Categories that may be retried by the same check (contract §4: at most three
 * attempts, then the next cycle decides).
 *
 * Retryable means "the transient side may be ours or the network's": transport
 * errors, a 5xx, a timeout, a temporary DNS failure. Everything else is permanent
 * until an operator changes something — a 404 is not going to become a 200 by
 * asking again, a 403/451 is a refusal we must record rather than dodge, and a
 * malformed manifest is the origin's content, not a flake.
 */
const RETRYABLE: ReadonlySet<FailureCategory> = new Set<FailureCategory>([
  'timeout',
  'dns-failure',
  'tls-failure',
  'connection-refused',
  'http-5xx',
]);

export function isRetryable(category: FailureCategory): boolean {
  return RETRYABLE.has(category);
}

/** Every category reachable, with its cause and retry policy. Used by tests and operator views. */
export function describeFailure(category: FailureCategory): {
  readonly category: FailureCategory;
  readonly cause: FailureCause;
  readonly retryable: boolean;
} {
  return { category, cause: FAILURE_CAUSE[category], retryable: isRetryable(category) };
}
