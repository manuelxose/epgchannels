/**
 * Verification metrics: zero-dependency counters, gauges and histograms with a
 * Prometheus text exposition.
 *
 * The rule that shapes this module: **a metric never carries a URL, a query
 * string or a credential**. Hosts are mapped to one of a fixed set of buckets
 * (the same host always lands in the same bucket, so a broken CDN is still
 * recognisable), and every other label is a closed vocabulary defined here — an
 * unknown value is folded into `other`, never emitted raw. That is what keeps
 * the label cardinality bounded: a deployment with ten thousand sources emits
 * the same number of series as one with ten.
 *
 * It is in-process by design. Counters reset when the process restarts; the
 * exposed `build_info` series carries a boot timestamp so a scraper can tell a
 * reset from a drop. A multi-instance deployment scrapes (or sums) each instance.
 */

/** Outcome codes a check can end with, plus the two scheduler-side outcomes. */
export const CHECK_OUTCOMES = [
  'healthy',
  'degraded',
  'skipped',
  'aborted',
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

export type CheckOutcome = (typeof CHECK_OUTCOMES)[number];

const OUTCOME_SET: ReadonlySet<string> = new Set(CHECK_OUTCOMES);

/** Cause of a failure, the axis the contract's failure vocabulary maps to. */
export const FAILURE_CATEGORIES = [
  'authorization',
  'network',
  'protocol',
  'content',
  'browser',
  'policy',
  'unknown',
] as const;

export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

const CATEGORY_SET: ReadonlySet<string> = new Set(FAILURE_CATEGORIES);

/** Aggregated source health, the same six values `source_health_02d.status` uses. */
export const SOURCE_STATUSES = ['healthy', 'degraded', 'failing', 'unknown', 'paused', 'unverifiable'] as const;

export type SourceStatus = (typeof SOURCE_STATUSES)[number];

const STATUS_SET: ReadonlySet<string> = new Set(SOURCE_STATUSES);

/** Number of host buckets. Fixed so the series count never depends on the data. */
export const HOST_BUCKET_COUNT = 16;

/** Histogram upper bounds in milliseconds (Prometheus convention: cumulative). */
export const LATENCY_BUCKETS_MS = [50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000] as const;

/**
 * Deterministic bucket for a host: FNV-1a over the lowercased host, modulo the
 * bucket count. It never leaves the process and yields a fixed label such as
 * `h03`, so equal hosts always agree and a URL can never be recovered from it.
 */
export function hostBucket(host: string): string {
  let hash = 0x811c9dc5;
  const normalized = host.toLowerCase();
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `h${String(hash % HOST_BUCKET_COUNT).padStart(2, '0')}`;
}

/** Host of a URL, or `unknown` when the string is not an http(s) URL. */
export function hostOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname === '' ? 'unknown' : parsed.hostname;
  } catch {
    return 'unknown';
  }
}

/** Registry key: one sorted label set, so lookups are exact and stable. */
function keyOf(labels: Record<string, string>): string {
  const entries = Object.entries(labels).filter(([, value]) => value !== '');
  entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return entries.map(([name, value]) => `${name}=${value}`).join('\u0000');
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function renderLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels).filter(([, value]) => value !== '');
  if (entries.length === 0) return '';
  entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([name, value]) => `${name}="${escapeLabel(value)}"`).join(',')}}`;
}

interface HistogramState {
  readonly labels: Record<string, string>;
  count: number;
  sum: number;
  /** One slot per upper bound, plus the implicit `+Inf` that is always `count`. */
  readonly buckets: number[];
}

export interface ChecksOptions {
  /** True when the check was a manual operator retry rather than a scheduled tick. */
  readonly manual?: boolean;
}

export class VerificationMetrics {
  private readonly checks = new Map<string, { labels: Record<string, string>; value: number }>();
  private readonly failures = new Map<string, { labels: Record<string, string>; value: number }>();
  private readonly egress = new Map<string, { labels: Record<string, string>; value: number }>();
  private readonly retries = new Map<string, { labels: Record<string, string>; value: number }>();
  private readonly circuitOpens = new Map<string, { labels: Record<string, string>; value: number }>();
  private readonly rounds = new Map<string, { labels: Record<string, string>; value: number }>();
  private readonly gauges = new Map<string, { labels: Record<string, string>; value: number }>();
  private readonly latencies = new Map<string, HistogramState>();
  private readonly startedAtSeconds = Math.floor(Date.now() / 1000);

  /* ------------------------------------------------------------- counters */

  /** One check finished. Only the closed outcome vocabulary and `manual` are labels. */
  checksTotal(outcome: string, options: ChecksOptions = {}): void {
    const label = OUTCOME_SET.has(outcome) ? outcome : 'unknown-error';
    this.bump(this.checks, { outcome: label, mode: options.manual === true ? 'manual' : 'scheduled' });
  }

  failureTotal(category: string): void {
    this.bump(this.failures, { category: CATEGORY_SET.has(category) ? category : 'unknown' });
  }

  /** One outbound request was issued. The host is reduced to its bucket. */
  egressRequestTotal(urlOrHost: string): void {
    const host = urlOrHost.includes('://') ? hostOf(urlOrHost) : urlOrHost;
    this.bump(this.egress, { host_bucket: hostBucket(host) });
  }

  retryTotal(reason: string): void {
    this.bump(this.retries, { reason: this.reasonLabel(reason) });
  }

  /** A circuit breaker moved to `open`. `scope` is `source` or `host`. */
  circuitOpenTotal(scope: 'source' | 'host'): void {
    this.bump(this.circuitOpens, { scope });
  }

  /** One scheduler round finished. */
  roundTotal(status: 'ok' | 'degraded'): void {
    this.bump(this.rounds, { status });
  }

  /* --------------------------------------------------------------- gauges */

  setInFlight(value: number): void {
    this.gauge('verification_in_flight', {}, value);
  }

  setQueueDepth(backend: string, value: number): void {
    this.gauge('verification_queue_depth', { backend }, value);
  }

  setSourcesByStatus(status: string, value: number): void {
    this.gauge('verification_sources', { status: STATUS_SET.has(status) ? status : 'unknown' }, value);
  }

  setHostInFlight(host: string, value: number): void {
    this.gauge('verification_host_in_flight', { host_bucket: hostBucket(host) }, value);
  }

  setCircuitOpen(scope: 'source' | 'host', value: number): void {
    this.gauge('verification_circuits_open', { scope }, value);
  }

  /* ------------------------------------------------------------ histogram */

  /** Records one check latency. `labels` may only carry closed-vocabulary values. */
  observeLatency(milliseconds: number, options: { kind?: string; outcome?: string } = {}): void {
    const labels: Record<string, string> = {
      kind: options.kind === undefined ? '' : safeKind(options.kind),
      outcome: options.outcome === undefined ? '' : OUTCOME_SET.has(options.outcome) ? options.outcome : 'unknown-error',
    };
    const key = keyOf({ metric: 'verification_check_latency_ms', ...labels });
    const state = this.latencies.get(key) ?? {
      labels,
      count: 0,
      sum: 0,
      buckets: LATENCY_BUCKETS_MS.map(() => 0),
    };
    state.count += 1;
    state.sum += Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : 0;
    LATENCY_BUCKETS_MS.forEach((bound, index) => {
      if (milliseconds <= bound) state.buckets[index] = (state.buckets[index] ?? 0) + 1;
    });
    this.latencies.set(key, state);
  }

  /* ------------------------------------------------------------- snapshot */

  /** Current values, for the JSON operator view and for the load script. */
  snapshot(): {
    counters: Record<string, Record<string, Record<string, number>>>;
    gauges: Record<string, Record<string, Record<string, number>>>;
  } {
    const flatten = (source: Map<string, { labels: Record<string, string>; value: number }>) => {
      const out: Record<string, Record<string, Record<string, number>>> = {};
      for (const entry of source.values()) {
        const { metric, ...labels } = entry.labels as Record<string, string>;
        const metricName = metric ?? 'unlabelled';
        const bucket = (out[metricName] ??= {});
        bucket[JSON.stringify(labels)] = { value: entry.value };
      }
      return out;
    };
    return { counters: flatten(this.countersWithMetric()), gauges: flatten(this.gauges) };
  }

  /**
   * Prometheus text exposition (version 0.0.4). Deterministic order, so two
   * renders of an unchanged registry are byte-identical.
   */
  render(): string {
    const lines: string[] = [];
    lines.push('# HELP tdt_verification_build_info Verification metrics registry identity.');
    lines.push('# TYPE tdt_verification_build_info gauge');
    lines.push(`tdt_verification_build_info{started_seconds="${this.startedAtSeconds}"} 1`);

    this.renderCounter(lines, 'tdt_verification_checks_total', 'Checks that reached a terminal state.', 'checks');
    this.renderCounter(lines, 'tdt_verification_failure_total', 'Checks that failed, by failure category.', 'failures');
    this.renderCounter(lines, 'tdt_verification_egress_requests_total', 'Outbound egress requests by host bucket.', 'egress');
    this.renderCounter(lines, 'tdt_verification_retries_total', 'Retries by reason.', 'retries');
    this.renderCounter(lines, 'tdt_verification_circuit_open_total', 'Circuit breaker openings.', 'circuitOpens');
    this.renderCounter(lines, 'tdt_verification_round_total', 'Scheduler rounds that finished.', 'rounds');

    for (const [name, help] of [
      ['verification_in_flight', 'Checks currently running.'],
      ['verification_queue_depth', 'Check queue depth by backend.'],
      ['verification_sources', 'Aggregated sources by health status.'],
      ['verification_host_in_flight', 'Checks in flight per host bucket.'],
      ['verification_circuits_open', 'Circuit breakers currently open.'],
    ] as const) {
      lines.push(`# HELP tdt_${name} ${help}`);
      lines.push(`# TYPE tdt_${name} gauge`);
    }
    const sortedGauges = [...this.gauges.values()].sort((left, right) =>
      keyOf(left.labels) < keyOf(right.labels) ? -1 : keyOf(left.labels) > keyOf(right.labels) ? 1 : 0,
    );
    for (const entry of sortedGauges) {
      const { metric, ...labels } = entry.labels as Record<string, string>;
      lines.push(`${metric ?? 'tdt_unlabelled'}${renderLabels(labels)} ${entry.value}`);
    }

    lines.push('# HELP tdt_verification_check_latency_ms Check latency in milliseconds.');
    lines.push('# TYPE tdt_verification_check_latency_ms histogram');
    const histogramMetric = 'tdt_verification_check_latency_ms';
    const sortedHistograms = [...this.latencies.values()].sort((left, right) =>
      keyOf(left.labels) < keyOf(right.labels) ? -1 : keyOf(left.labels) > keyOf(right.labels) ? 1 : 0,
    );
    for (const state of sortedHistograms) {
      LATENCY_BUCKETS_MS.forEach((bound, index) => {
        lines.push(`${histogramMetric}_bucket${renderLabels({ ...state.labels, le: String(bound) })} ${state.buckets[index] ?? 0}`);
      });
      lines.push(`${histogramMetric}_bucket${renderLabels({ ...state.labels, le: '+Inf' })} ${state.count}`);
      lines.push(`${histogramMetric}_sum${renderLabels(state.labels)} ${state.sum.toFixed(3)}`);
      lines.push(`${histogramMetric}_count${renderLabels(state.labels)} ${state.count}`);
    }
    return `${lines.join('\n')}\n`;
  }

  /** Resets every series (tests and the load script reuse one process). */
  reset(): void {
    for (const map of [this.checks, this.failures, this.egress, this.retries, this.circuitOpens, this.rounds, this.gauges]) {
      map.clear();
    }
    this.latencies.clear();
  }

  /* -------------------------------------------------------------- private */

  private countersWithMetric(): Map<string, { labels: Record<string, string>; value: number }> {
    const out = new Map<string, { labels: Record<string, string>; value: number }>();
    const groups: Array<[string, Map<string, { labels: Record<string, string>; value: number }>]> = [
      ['tdt_verification_checks_total', this.checks],
      ['tdt_verification_failure_total', this.failures],
      ['tdt_verification_egress_requests_total', this.egress],
      ['tdt_verification_retries_total', this.retries],
      ['tdt_verification_circuit_open_total', this.circuitOpens],
      ['tdt_verification_round_total', this.rounds],
    ];
    for (const [metric, source] of groups) {
      for (const [key, entry] of source) {
        out.set(key, { labels: { ...entry.labels, metric: entry.labels['metric'] ?? metric }, value: entry.value });
      }
    }
    return out;
  }

  private renderCounter(
    lines: string[],
    name: string,
    help: string,
    map: 'checks' | 'failures' | 'egress' | 'retries' | 'circuitOpens' | 'rounds',
  ): void {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} counter`);
    const entries = [...this[map].values()].sort((left, right) =>
      keyOf(left.labels) < keyOf(right.labels) ? -1 : keyOf(left.labels) > keyOf(right.labels) ? 1 : 0,
    );
    for (const entry of entries) {
      lines.push(`${name}${renderLabels(entry.labels)} ${entry.value}`);
    }
  }

  private bump(
    map: Map<string, { labels: Record<string, string>; value: number }>,
    labels: Record<string, string>,
  ): void {
    const key = keyOf(labels);
    const entry = map.get(key) ?? { labels, value: 0 };
    entry.value += 1;
    map.set(key, entry);
  }

  private gauge(metric: string, labels: Record<string, string>, value: number): void {
    const full = { metric, ...labels };
    this.gauges.set(keyOf(full), { labels: full, value: Number.isFinite(value) ? value : 0 });
  }

  private reasonLabel(reason: string): string {
    const known = ['timeout', 'transient', 'lease-expired', 'scheduled'];
    return known.includes(reason) ? reason : 'other';
  }
}

/** Retry reason vocabulary for the `reason` label; anything else is `other`. */
function safeKind(kind: string): string {
  const known = ['scheduled', 'manual', 'retry'];
  return known.includes(kind) ? kind : 'other';
}
