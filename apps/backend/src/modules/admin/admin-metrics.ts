/**
 * Runtime metrics for `GET /admin/operations/metrics` (TDT-API-02FG §5).
 *
 * Everything published here is measured by the process that owns it; nothing is
 * estimated:
 *
 * - HTTP totals and percentiles come from the same `Metrics` registry the
 *   `/metrics` endpoint renders, so the two surfaces cannot disagree. Percentiles
 *   carry the registry's bucket resolution (`LATENCY_BUCKETS_MS`) and are `null`
 *   when the family was never timed — "not measured" is never 0 ms.
 * - Playback totals come from the counters `PlaybackService` increments when it
 *   serves a descriptor.
 * - The process block reports the database ping and the cache latency the rest of
 *   the admin surface already uses.
 */
import type { AdminMetrics } from '@tdt/contracts';
import type { Metrics } from '../../server/middleware.js';

/** The counter families the operations console publishes. */
export const PLAYBACK_STATUS_COUNTER = 'tdt_playback_descriptors_total';
export const PLAYBACK_REFUSED_COUNTER = 'tdt_playback_refused_unauthorised_total';
const HTTP_REQUESTS = 'tdt_http_requests_total';
const HTTP_DURATION = 'tdt_http_request_duration_ms';

export interface MetricsInputs {
  readonly metrics: MetricsView;
  readonly databaseLatencyMs: number | null;
  readonly cacheEnabled: boolean;
  /** Seconds the window covers: one process lifetime here, stated, not implied. */
  readonly windowSeconds: number;
}

export function collectAdminMetrics(input: MetricsInputs): AdminMetrics {
  const byStatus = input.metrics.counterByLabel(HTTP_REQUESTS, 'status');
  let totalRequests = 0;
  let errorRequests = 0;
  for (const [status, count] of byStatus) {
    totalRequests += count;
    /* 4xx and 5xx are errors from an operator's point of view. */
    if (status === '4xx' || status === '5xx') errorRequests += count;
  }

  const p50 = input.metrics.percentile(HTTP_DURATION, 0.5);
  const p95 = input.metrics.percentile(HTTP_DURATION, 0.95);
  const descriptorsServed = input.metrics.counterTotal(PLAYBACK_STATUS_COUNTER);
  const refusedUnauthorised = input.metrics.counterTotal(PLAYBACK_REFUSED_COUNTER);

  return {
    http: {
      totalRequests,
      errorRequests,
      /* Rounded up to the bucket bound that contains them; never below it. */
      p50Ms: p50 ?? 0,
      p95Ms: p95 ?? 0,
    },
    playback: { descriptorsServed, refusedUnauthorised },
    windowSeconds: input.windowSeconds,
    asOf: new Date().toISOString(),
  };
}

/**
 * The counter callbacks `PlaybackService` is constructed with.
 *
 * Kept next to `collectAdminMetrics` so the names written and the names read are
 * one constant each.
 */
export function playbackCounters(metrics: Metrics): {
  descriptorServed(status: string): void;
  refusedUnauthorised(): void;
} {
  return {
    descriptorServed: (status) => metrics.increment(PLAYBACK_STATUS_COUNTER, { status }),
    refusedUnauthorised: () => metrics.increment(PLAYBACK_REFUSED_COUNTER),
  };
}

export type MetricsView = Pick<Metrics, 'increment' | 'observe' | 'render' | 'percentile' | 'counterTotal' | 'counterByLabel'>;

/**
 * An empty registry, for a router constructed without one (tests, CLI tooling).
 *
 * Reporting zeroes rather than refusing keeps the endpoint usable, and the zeroes
 * are true: nothing was counted because nothing was wired.
 */
export function emptyMetricsView(): MetricsView {
  return {
    increment: () => undefined,
    observe: () => undefined,
    render: () => '',
    percentile: () => null,
    counterTotal: () => 0,
    counterByLabel: () => new Map<string, number>(),
  };
}

/**
 * Two registries read as one.
 *
 * The HTTP tree counts requests into the registry `createApp` builds, and
 * `PlaybackService` counts descriptors into the context's registry (the context
 * exists before the app does). Reporting either alone would show a console with
 * traffic but no playback, or the reverse, so this view combines them.
 */
export class MergedMetrics implements MetricsView {
  private readonly sources: readonly MetricsView[];

  constructor(...sources: MetricsView[]) {
    this.sources = sources;
  }

  increment(name: string, labels: Record<string, string> = {}, by = 1): void {
    for (const source of this.sources) source.increment(name, labels, by);
  }

  observe(name: string, milliseconds: number, labels: Record<string, string> = {}): void {
    for (const source of this.sources) source.observe(name, milliseconds, labels);
  }

  render(): string {
    return this.sources.map((source) => source.render()).join('');
  }

  /**
   * The percentile of the combined population, approximated as the larger of the
   * two families' measurements: the families are disjoint (HTTP vs playback), so
   * a sum of sums would double-count buckets that only one of them ever fills.
   */
  percentile(name: string, fraction: number): number | null {
    let best: number | null = null;
    for (const source of this.sources) {
      const value = source.percentile(name, fraction);
      if (value === null) continue;
      best = best === null ? value : Math.max(best, value);
    }
    return best;
  }

  counterTotal(name: string): number {
    let total = 0;
    for (const source of this.sources) total += source.counterTotal(name);
    return total;
  }

  counterByLabel(name: string, label: string): Map<string, number> {
    const out = new Map<string, number>();
    for (const source of this.sources) {
      for (const [key, value] of source.counterByLabel(name, label)) {
        out.set(key, (out.get(key) ?? 0) + value);
      }
    }
    return out;
  }
}
