/**
 * Where a source's health is *actually recorded*, and how to read it.
 *
 * The measured state of the platform is the reason this module exists: no row in
 * `playback_sources` carries a health verdict. `technicalStatus` is `unknown` for
 * every one of the 1364 rows, while the real 02D measurement (63 healthy of 81
 * authorized `hls` sources) was produced by `runValidation` and persisted to the
 * health ledger — one row per check in `source_health_checks_02d` — not to the
 * source document. Reading `technicalStatus` alone therefore answers "not
 * verified" for every source on the platform, and an axis that trusted it would be
 * decorative.
 *
 * Two rules, and neither is negotiable:
 *
 * 1. **`not-verified` is its own answer.** It is never collapsed into `healthy`
 *    (that was the earlier defect: `isSourceHealthy` returned true for `unknown`)
 *    and never into `failing` (that would disable a source for a check that never
 *    ran).
 * 2. **Only a verdict about the stream counts.** A run refused at the eligibility
 *    layer reached no network at all, so it is not evidence about the stream even
 *    though the engine records it as `ineligible`.
 *
 * ## The one canonical mapping
 *
 * The ledger's persisted row (`CheckRunDoc`) calls the depth `depth` and stamps the
 * observation time in `timings.finishedAt`; the validation result calls it
 * `depthReached` and carries no timestamp of its own. Rather than let callers cast
 * between them (which silently yields `undefined`), `recordedCheckOf` is the ONLY
 * place the two are mapped, and it is exported so the wiring and the tests use the
 * same function.
 */
import type { PlaybackHealth } from '@tdt/contracts';

/** The shape the health axis reads, in one vocabulary this module owns. */
export interface RecordedCheck {
  readonly outcome: string;
  readonly depth: string;
  readonly failure: { readonly category: string } | null;
  /** When the observation was made. */
  readonly observedAt: Date;
}

/**
 * The ledger row, structurally. Declared here (not imported) so this module adds
 * no dependency on the repository, and typed loosely enough that a row read back
 * from MongoDB is assignable without a cast.
 */
export interface LedgerCheckRow {
  readonly state?: unknown;
  readonly outcome?: unknown;
  readonly depth?: unknown;
  readonly failure?: { readonly category?: unknown } | null;
  readonly timings?: { readonly finishedAt?: unknown; readonly startedAt?: unknown } | null;
  readonly createdAt?: unknown;
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Maps one persisted ledger row to the health axis, or `null` when the row is not
 * a completed check (a pending/running row is not evidence, and neither is a row
 * with no terminal outcome).
 *
 * Timestamp: `timings.finishedAt` (what `completeCheck` stamps), then
 * `timings.startedAt`, then `createdAt`. A row with none of them is refused rather
 * than given an invented instant — the axis reports what it can observe.
 */
export function recordedCheckOf(row: LedgerCheckRow | null | undefined): RecordedCheck | null {
  if (row === null || row === undefined) return null;
  if (row.state !== undefined && row.state !== 'done' && row.state !== 'failed' && row.state !== 'skipped') {
    return null;
  }
  const outcome = asString(row.outcome);
  const depth = asString(row.depth);
  if (outcome === null || depth === null) return null;
  const observedAt = asDate(row.timings?.finishedAt) ?? asDate(row.timings?.startedAt) ?? asDate(row.createdAt);
  if (observedAt === null) return null;
  const category = asString(row.failure?.category ?? null);
  return { outcome, depth, failure: category === null ? null : { category }, observedAt };
}

/** The legacy per-source columns the selector may fall back to. */
export interface StoredTechnicalStatus {
  readonly technicalStatus: string;
  readonly lastVerifiedAt: Date | null;
  readonly lastVerification: { readonly status: string; readonly message: string | null } | null;
}

export type HealthOrigin = 'health-ledger' | 'source-record' | 'none';

export interface SourceHealthVerdict {
  readonly state: PlaybackHealth;
  readonly origin: HealthOrigin;
  readonly depth: string | null;
  readonly failure: string | null;
  readonly observedAt: Date | null;
}

export const NOT_VERIFIED: SourceHealthVerdict = Object.freeze({
  state: 'not-verified',
  origin: 'none',
  depth: null,
  failure: null,
  observedAt: null,
});

/**
 * Outcomes that are verdicts about the stream. `ineligible` is deliberately
 * absent: a refusal to connect is a fact about rights, recorded on the
 * authorization axis, not about the stream.
 */
function verdictOf(check: RecordedCheck): PlaybackHealth {
  if (check.outcome === 'healthy' || check.outcome === 'degraded') return 'healthy';
  if (check.outcome === 'failing') return 'failing';
  return 'not-verified';
}

/**
 * Resolves health from, in order, the recorded ledger check and then the source
 * row.
 *
 * The ledger wins because it is the measurement the engine actually made and it
 * keeps the depth and failure category. The row is a fallback for an operator who
 * verified a source by hand (`POST /admin/sources/:id/verify`), which writes
 * `technicalStatus` directly. With neither present the answer is `not-verified`.
 */
export function resolveSourceHealth(
  check: RecordedCheck | null,
  record: StoredTechnicalStatus | null,
): SourceHealthVerdict {
  if (check !== null) {
    const state = verdictOf(check);
    if (state !== 'not-verified') {
      return {
        state,
        origin: 'health-ledger',
        depth: check.depth,
        failure: check.failure?.category ?? null,
        observedAt: check.observedAt,
      };
    }
  }
  if (record !== null) {
    const status = record.lastVerification?.status ?? record.technicalStatus;
    if (status === 'ok') {
      return { state: 'healthy', origin: 'source-record', depth: null, failure: null, observedAt: record.lastVerifiedAt };
    }
    if (status === 'http-error' || status === 'unreachable' || status === 'invalid-manifest') {
      return {
        state: 'failing',
        origin: 'source-record',
        depth: null,
        failure: status,
        observedAt: record.lastVerifiedAt,
      };
    }
  }
  return NOT_VERIFIED;
}

/**
 * Whether health decides attemptability for this source type — the ONE definition
 * of that closed set.
 *
 * Only `hls` and `dash` are probed by the health engine. For the other types the
 * axis stays `not-verified` and, because it never observed them, it does not
 * disable them; their attemptability comes from their authorization and their own
 * adapter.
 */
export function healthGovernsType(type: string): boolean {
  return type === 'hls' || type === 'dash';
}
