/**
 * Middleware stack. Order matters and is documented in `app.ts`.
 */
import type { RequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import type { CacheStore } from '../infrastructure/cache.js';
import type { Logger } from '../infrastructure/logging.js';
import { AppError } from './errors.js';

export const REQUEST_ID_HEADER = 'x-request-id';

/** Correlates a request through every log line and error body. */
export const requestId: RequestHandler = (request, response, next) => {
  const incoming = request.header(REQUEST_ID_HEADER);
  const id = incoming && /^[A-Za-z0-9_-]{8,80}$/.test(incoming) ? incoming : randomUUID();
  response.locals['requestId'] = id;
  response.setHeader(REQUEST_ID_HEADER, id);
  next();
};

export interface RateLimitOptions {
  readonly windowSeconds: number;
  readonly maxRequests: number;
  readonly cache: CacheStore;
  readonly logger: Logger;
}

/**
 * Fixed-window limiter. With Redis it is shared across instances; without Redis
 * it is in-process and says so in the response headers (`ratelimit-mode`), so an
 * operator is never told a limit is distributed when it is not.
 */
export function createRateLimit(options: RateLimitOptions): RequestHandler {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  let lastSweep = 0;

  return async (request, response, next) => {
    const now = Date.now();
    const windowMs = options.windowSeconds * 1000;
    const identity = request.ip ?? 'unknown';
    const key = `ratelimit:${identity}:${Math.floor(now / windowMs)}`;

    let count: number;
    let resetAt: number;
    if (options.cache.enabled) {
      response.setHeader('ratelimit-mode', 'shared');
      const current = Number((await options.cache.get(key)) ?? '0');
      count = Number.isFinite(current) ? current + 1 : 1;
      await options.cache.set(key, String(count), options.windowSeconds);
      resetAt = (Math.floor(now / windowMs) + 1) * windowMs;
    } else {
      response.setHeader('ratelimit-mode', 'process');
      if (now - lastSweep > windowMs) {
        for (const [bucketKey, bucket] of buckets) {
          if (bucket.resetAt <= now) buckets.delete(bucketKey);
        }
        lastSweep = now;
      }
      const bucket = buckets.get(key) ?? { count: 0, resetAt: (Math.floor(now / windowMs) + 1) * windowMs };
      bucket.count += 1;
      buckets.set(key, bucket);
      count = bucket.count;
      resetAt = bucket.resetAt;
    }

    const remaining = Math.max(0, options.maxRequests - count);
    response.setHeader('ratelimit-limit', String(options.maxRequests));
    response.setHeader('ratelimit-remaining', String(remaining));
    response.setHeader('ratelimit-reset', String(Math.ceil(resetAt / 1000)));
    if (count > options.maxRequests) {
      response.setHeader('retry-after', String(Math.ceil((resetAt - now) / 1000)));
      next(AppError.rateLimited());
      return;
    }
    next();
  };
}

/** In-memory metrics suitable for a single instance; exported as Prometheus text. */
export class Metrics {
  private readonly counters = new Map<string, number>();
  private readonly histograms = new Map<string, { count: number; sum: number }>();
  private readonly startedAt = Date.now();

  increment(name: string, labels: Record<string, string> = {}, by = 1): void {
    const key = `${name}|${labelKey(labels)}`;
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  observe(name: string, milliseconds: number, labels: Record<string, string> = {}): void {
    const key = `${name}|${labelKey(labels)}`;
    const entry = this.histograms.get(key) ?? { count: 0, sum: 0 };
    entry.count += 1;
    entry.sum += milliseconds;
    this.histograms.set(key, entry);
  }

  render(): string {
    const lines: string[] = [];
    lines.push('# HELP tdt_uptime_seconds Process uptime.');
    lines.push('# TYPE tdt_uptime_seconds gauge');
    lines.push(`tdt_uptime_seconds ${Math.round((Date.now() - this.startedAt) / 1000)}`);
    let index = 0;
    for (const [key, value] of this.counters) {
      const [name, labels] = splitKey(key);
      lines.push(`# TYPE ${name} counter`);
      lines.push(`${name}${labels} ${value} ${index++}`);
    }
    for (const [key, value] of this.histograms) {
      const [name, labels] = splitKey(key);
      lines.push(`# TYPE ${name} summary`);
      lines.push(`${name}_count${labels} ${value.count} ${index++}`);
      lines.push(`${name}_sum${labels} ${value.sum.toFixed(3)} ${index++}`);
    }
    return `${lines.join('\n')}\n`;
  }
}

function labelKey(labels: Record<string, string>): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  return entries.map(([key, value]) => `${key}="${value.replace(/"/g, '')}"`).join(',');
}

function splitKey(key: string): [string, string] {
  const separator = key.indexOf('|');
  const name = key.slice(0, separator);
  const labels = key.slice(separator + 1);
  return [name, labels ? `{${labels}}` : ''];
}

/** Times every request and records counters for the metrics endpoint. */
export function createMetricsMiddleware(metrics: Metrics): RequestHandler {
  return (request, response, next) => {
    const started = performance.now();
    response.on('finish', () => {
      const duration = performance.now() - started;
      // Route patterns, not raw paths: no unbounded label cardinality.
      const route = (request.route?.path as string | undefined) ?? 'unmatched';
      const base = request.baseUrl ?? '';
      metrics.increment('tdt_http_requests_total', {
        method: request.method,
        route: `${base}${route === '/' ? '' : route}`,
        status: `${Math.floor(response.statusCode / 100)}xx`,
      });
      metrics.observe('tdt_http_request_duration_ms', duration, {
        method: request.method,
        route: `${base}${route === '/' ? '' : route}`,
      });
    });
    next();
  };
}

/**
 * `Cache-Control` + `ETag` for GET responses. The ETag is derived from the
 * serialised body so a second request with the same representation gets a 304
 * without re-serialising, and clients cache honestly.
 */
export function createCacheHeaders(options: { maxAgeSeconds: number; publicResponses: boolean }): RequestHandler {
  return (request, response, next) => {
    if (request.method !== 'GET') {
      response.setHeader('cache-control', 'no-store');
      next();
      return;
    }
    if (!options.publicResponses) {
      response.setHeader('cache-control', 'no-store');
      next();
      return;
    }
    const stale = Math.max(30, options.maxAgeSeconds * 4);
    response.setHeader(
      'cache-control',
      `public, max-age=${options.maxAgeSeconds}, stale-while-revalidate=${stale}`,
    );
    next();
  };
}

/** Body-size guard: JSON bodies are bounded before parsing. */
export const MAX_JSON_BODY_BYTES = '256kb';
