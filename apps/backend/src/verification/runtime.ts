/**
 * Verification runtime: the one place the subsystem is constructed.
 *
 * Everything in `apps/backend/src/verification/` is a set of pure pieces with
 * injected seams. This module is the *only* place in the application that binds
 * those seams to real I/O, so a reviewer has exactly one file to read when
 * asking "what does the verification subsystem actually do on the network?".
 *
 * The answer, and the security property of the milestone, is one line:
 *
 *     const egress = safeFetchEgress(...)   // apps/backend/src/infrastructure/safe-egress.ts
 *
 * The scheduler never opens a socket itself; it calls a `ValidationExecutor`,
 * which here adapts t3's scheduler request onto t2's `runValidation` with an
 * egress function backed by `safeFetch` (DNS pinning, private-address refusal,
 * redirect policy, byte bound). Wiring it anywhere else — or only in tests —
 * would put the SSRF guard off the production path.
 */
import type { Config } from '../config/config.js';
import type { Logger } from '../infrastructure/logging.js';
import type { DatabaseHandle } from '../infrastructure/mongo.js';
import type { PlaybackSourceDoc } from '../infrastructure/schema.js';
import type { AuthorizationRecord } from '../modules/providers/authorization.js';
import { safeFetch, EgressFailure } from '../infrastructure/safe-egress.js';
import { COLLECTIONS } from '../infrastructure/mongo.js';
import { VerificationControls } from './controls.js';
import { VerificationMetrics } from './metrics.js';
import { createQueue, type QueueBackend } from './queue.js';
import { VerificationScheduler } from './scheduler.js';
import type { ValidationExecutor, ValidationRequest, ValidationResult } from './scheduler.js';
import { runValidation, DEFAULT_SEGMENT_SAMPLE } from './validator.js';
import type { EgressFn, EgressRequest, EgressResponse } from './validator.js';

export interface VerificationRuntime {
  readonly metrics: VerificationMetrics;
  readonly queue: QueueBackend;
  readonly scheduler: VerificationScheduler;
  readonly controls: VerificationControls;
  /** The executor the scheduler runs. Exposed so a test can assert the seam. */
  readonly validator: ValidationExecutor;
}

export interface VerificationRuntimeOptions {
  readonly database: DatabaseHandle;
  readonly logger: Logger;
  readonly config: Config;
  /**
   * Resolves what the 02C gate recorded for a source. Injected so this module
   * needs no PlaybackService (which would be a circular import through context).
   */
  readonly authorizationsFor: (
    sources: readonly PlaybackSourceDoc[],
  ) => Promise<ReadonlyMap<string, AuthorizationRecord>>;
  /** Lookup of a source document by id; the scheduler plans from aggregates. */
  readonly findSource: (sourceId: string) => Promise<PlaybackSourceDoc | null>;
  /** TEST-ONLY: let `safeFetch` reach a loopback fixture. Production omits it. */
  readonly allowLoopbackForTests?: boolean;
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

/**
 * The egress function handed to t2's validator: `safeFetch`, and nothing else.
 *
 * A transport refusal (`EgressFailure`) is re-thrown unchanged so t3's
 * `egress-classification.ts` can classify it: retryable codes retry, permanent
 * refusals (SSRF, credential-in-url, redirect-unsafe) are never repeated.
 */
export function safeFetchEgress(limits: {
  readonly timeoutMs: number;
  readonly maxBytes: number;
  /**
   * TEST-ONLY: pass through `allowLoopbackForTests` so an integration test can
   * point the round at a loopback fixture. Production never sets it; the
   * SSRF guard is otherwise unchanged, which is the point of routing through
   * `safeFetch` rather than a test double.
   */
  readonly allowLoopbackForTests?: boolean;
}): EgressFn {
  return async (request: EgressRequest): Promise<EgressResponse> => {
    try {
      const response = await safeFetch({
        url: request.url,
        ...(request.method === undefined ? {} : { method: request.method }),
        timeoutMs: limits.timeoutMs,
        maxBytes: Math.min(request.maxBytes || limits.maxBytes, limits.maxBytes),
        ...(request.allowedContentPrefixes === undefined
          ? {}
          : { allowedContentPrefixes: request.allowedContentPrefixes }),
        /*
         * Forward the bounded prefix read. Without this line the segment probe's
         * `prefixBytes` is silently dropped here and the cap never reaches
         * `safeFetch`, so a sampled segment would cost up to the whole-segment
         * ceiling instead of SEGMENT_PROBE_BYTES. A capability that is only
         * exercised through an injected test seam is exactly the defect class
         * this milestone exists to stop repeating.
         */
        ...(request.prefixBytes === undefined ? {} : { prefixBytes: request.prefixBytes }),
        ...(limits.allowLoopbackForTests === true ? { allowLoopbackForTests: true } : {}),
      });
      return {
        status: response.status,
        ok: response.ok,
        contentType: response.contentType,
        bytes: response.bytes,
        body: response.body,
        finalUrl: response.finalUrl,
        latencyMs: response.latencyMs,
      };
    } catch (error) {
      // A refusal before any status existed: surface it as a transport failure so
      // the validator records a category instead of crashing the round, and keep
      // the code readable by the scheduler's retry classifier.
      if (error instanceof EgressFailure || (error as { name?: string })?.name === 'EgressFailure') {
        const failure = error as EgressFailure;
        return {
          status: 0,
          ok: false,
          contentType: null,
          bytes: 0,
          body: null,
          finalUrl: request.url,
          latencyMs: 0,
          transportError: failure.code,
        };
      }
      throw error;
    }
  };
}

/**
 * Adapts t3's scheduler request onto t2's `runValidation`.
 *
 * The scheduler plans from health aggregates and therefore knows a source's
 * `id`, `url` and `type`, not its full document; this loads the document (which
 * the validator needs for layer 1) and the recorded authorization decision.
 */
export function createValidationExecutor(options: VerificationRuntimeOptions): ValidationExecutor {
  const egress = safeFetchEgress({
    timeoutMs: options.config.VERIFY_TIMEOUT_MS,
    maxBytes: options.config.VERIFY_MAX_BYTES || DEFAULT_MAX_BYTES,
    ...(options.allowLoopbackForTests === true ? { allowLoopbackForTests: true } : {}),
  });
  const segmentSample =
    options.config.VERIFY_SEGMENT_SAMPLE === undefined
      ? DEFAULT_SEGMENT_SAMPLE
      : options.config.VERIFY_SEGMENT_SAMPLE;

  return {
    async validate(request: ValidationRequest): Promise<ValidationResult> {
      const source = await options.findSource(request.sourceId);
      if (source === null) {
        /*
         * The aggregate row outlived its source document: nothing to probe, and
         * inventing a verdict would be worse than saying so.
         */
        return {
          outcome: 'ineligible',
          started: false,
          depth: 'eligibility',
          failure: { code: 'ineligible', httpStatus: null, detail: 'source document not found' },
        };
      }
      const authorizations = await options.authorizationsFor([source]);
      const result = await runValidation({
        source,
        authorization: authorizations.get(source._id) ?? null,
        egress,
        segmentSample,
        // Layer 6 is manual-only: a scheduled round never injects a browser probe.
        browser: null,
        egressHost: 'scheduler',
        now: new Date(),
      });
      return {
        outcome: result.outcome,
        started: true,
        depth: result.depthReached,
        // `exactOptionalPropertyTypes`: omit the key instead of passing `undefined`.
        ...(result.failure === null
          ? {}
          : {
              failure: {
                code: result.failure.category,
                httpStatus: result.evidence.httpStatus,
                detail: result.failure.message,
              },
            }),
        uncertainty: {
          notes: result.uncertainty.notes,
        },
        // Layer 5 evidence is what lets the scheduler distinguish "manifest
        // passed, segments sampled" from "stopped at transport".
        segmentsSampled: result.depthReached === 'segments',
        evidence: {
          httpStatus: result.evidence.httpStatus,
          contentType: result.evidence.contentType,
          // t3 models an unobserved size as absent; t2 models it as `null`.
          ...(result.evidence.bytes === null ? {} : { bytes: result.evidence.bytes }),
        },
      };
    },
  };
}

export function createVerificationRuntime(options: VerificationRuntimeOptions): VerificationRuntime {
  const { database, logger, config } = options;
  const metrics = new VerificationMetrics();
  const queue = createQueue({ database, logger });
  const controls = new VerificationControls({ database, queue, logger });
  const validator = createValidationExecutor(options);

  const scheduler = new VerificationScheduler({
    database,
    queue,
    validator,
    metrics,
    logger,
    concurrency: config.VERIFY_CONCURRENCY,
    perHostConcurrency: config.VERIFY_PER_HOST_CONCURRENCY,
    /*
     * The plan-side per-host cap equals the execution-side one: a round never
     * promises more work to a host than the executor will run at once.
     */
    perHostPlanLimit: config.VERIFY_PER_HOST_CONCURRENCY,
    maxAttempts: 3,
    leaseTtlMs: Math.max(30_000, config.VERIFY_TIMEOUT_MS * 3),
    breakers: {
      threshold: config.VERIFY_CIRCUIT_THRESHOLD,
      maxWindowMs: config.VERIFY_CIRCUIT_MAX_MINUTES * 60_000,
    },
    collections: {
      checks: COLLECTIONS.sourceHealthChecks,
      health: COLLECTIONS.sourceHealthAggregate,
      policies: COLLECTIONS.verificationPolicies,
    },
  });

  return { metrics, queue, scheduler, controls, validator };
}
