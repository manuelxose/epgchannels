/**
 * Deterministic back-off (MODULE-CONTRACT-02D §4).
 *
 * Two properties matter and both are testable:
 *
 * - **Deterministic jitter.** The jitter is derived from `(sourceId, attempt)`,
 *   so a replayed check computes the same delay. A random jitter cannot be
 *   asserted; this one can, and it still spreads a fleet of sources.
 * - **Bounded growth.** Doubling per attempt, capped at 24 h, so a dead provider
 *   is probed once a day at most, never faster than the base interval.
 *
 * Status bases are the contract's: `healthy` 6 h, `degraded` 2 h, `failing`
 * 30 min, `unknown` 15 min. `paused` and `unverifiable` have no automatic
 * cadence: `paused` means an operator stopped it and `unverifiable` means the
 * source cannot be observed by this platform at all, so neither is retried on
 * its own (they return `null` instead of inventing an interval).
 */
import { createHash } from 'node:crypto';
import type { CheckOutcomeCode, HealthStatus } from './health.schema.js';

export const BACKOFF_MAX_MS = 24 * 60 * 60 * 1000;
/** Fraction of the delay the jitter may move it by, either way. */
export const JITTER_RATIO = 0.2;

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** Base interval per aggregate status (contract §4). */
export const BASE_INTERVAL_MS: Readonly<Record<HealthStatus, number | null>> = {
  healthy: 6 * HOUR,
  degraded: 2 * HOUR,
  failing: 30 * MINUTE,
  unknown: 15 * MINUTE,
  paused: null,
  unverifiable: null,
};

export interface BackoffInput {
  /** Aggregate status the source is in *now*. */
  readonly status: HealthStatus;
  /** 1-based attempt number inside the current check cycle. */
  readonly attempt: number;
  readonly sourceId: string;
  /** Per-check attempt cap; above it no retry is due (contract §4: 3). */
  readonly maxAttempts?: number;
}

export interface BackoffPlan {
  /** Delay before the next attempt, after cap and jitter. */
  readonly delayMs: number;
  /** Delay before jitter (base * 2^(attempt-1), capped). */
  readonly baseDelayMs: number;
  /** The jitter actually applied, in milliseconds (signed). */
  readonly jitterMs: number;
  /** False when the attempt cap is exhausted: wait for the next cycle. */
  readonly retryable: boolean;
  /** When the next check is due, from `from`. */
  readonly nextCheckAt: Date;
}

/** Deterministic unit value in [-1, 1) for `(sourceId, attempt)`. */
export function deterministicJitterUnit(sourceId: string, attempt: number): number {
  const digest = createHash('sha256').update(`${sourceId}:${attempt}`).digest();
  // 32 bits is plenty: the ratio is applied to at most 24 h (±12 ms resolution).
  const value = digest.readUInt32BE(0) / 0x1_0000_0000;
  return value * 2 - 1;
}

/**
 * Pure back-off for one `(status, attempt)` pair.
 *
 * Never throws and never reads the clock: the caller passes `from`, so tests and
 * replays produce the same instant.
 */
export function computeBackoff(input: BackoffInput, from: Date): BackoffPlan {
  const maxAttempts = input.maxAttempts ?? 3;
  const attempt = Math.max(1, Math.trunc(input.attempt));
  const base = BASE_INTERVAL_MS[input.status];
  if (base === null) {
    // Operator-driven or structurally unobservable: no automatic retry exists.
    return { delayMs: 0, baseDelayMs: 0, jitterMs: 0, retryable: false, nextCheckAt: from };
  }
  const uncapped = base * 2 ** (attempt - 1);
  const baseDelayMs = Math.min(BACKOFF_MAX_MS, uncapped);
  const jitterMs = Math.round(baseDelayMs * JITTER_RATIO * deterministicJitterUnit(input.sourceId, attempt));
  // The cap applies to the jittered value too: `base * 2^n` with `n` large must
  // never exceed a day even by the 20 % it is allowed to grow.
  const delayMs = Math.max(0, Math.min(BACKOFF_MAX_MS, baseDelayMs + jitterMs));
  return {
    delayMs,
    baseDelayMs,
    jitterMs,
    retryable: attempt < maxAttempts,
    nextCheckAt: new Date(from.getTime() + delayMs),
  };
}

/**
 * True when a *failed* check outcome may extend the cycle: only failures whose
 * category is retryable (see `failures.ts`) and only below the attempt cap.
 * Kept here so the scheduler has one call and no second opinion.
 */
export function shouldRetry(input: { readonly status: HealthStatus; readonly attempt: number; readonly categoryRetryable: boolean; readonly maxAttempts?: number }): boolean {
  if (!input.categoryRetryable) return false;
  return input.attempt < (input.maxAttempts ?? 3);
}

/** Maps a terminal outcome to the aggregate status it implies. */
export function statusForOutcome(outcome: CheckOutcomeCode): HealthStatus {
  switch (outcome) {
    case 'healthy':
      return 'healthy';
    case 'degraded':
      return 'degraded';
    case 'failing':
      return 'failing';
    case 'ineligible':
      return 'unknown';
    case 'paused':
      return 'paused';
    case 'unverifiable':
      return 'unverifiable';
    case 'unknown':
    default:
      return 'unknown';
  }
}
