/**
 * HTTP response cache.
 *
 * A cache here has to earn its place, so it does exactly three things:
 *
 * 1. caches only the **expensive catalogue reads** (categories, regions and the
 *    `playable` channel listing, which need the whole published catalogue to
 *    derive a status per channel) — never a channel lookup, never a descriptor;
 * 2. keys on the exact effective URL, so two different queries cannot collide;
 * 3. is bounded in both size and age, and is cleared by an editorial mutation.
 *
 * It is process-local on purpose. The database remains the source of truth and a
 * restart cannot serve stale content; a multi-instance deployment clears through
 * the editorial endpoints, which are the only writers.
 */
import type { NextFunction, RequestHandler, Response } from 'express';

export interface ResponseCacheOptions {
  /** Maximum number of cached responses. */
  readonly maxEntries: number;
  /** Maximum age of an entry in milliseconds. */
  readonly maxAgeMs: number;
  /** Returns true when this request should be cached. */
  readonly shouldCache: (method: string, path: string) => boolean;
}

interface Entry {
  readonly body: string;
  readonly contentType: string;
  readonly etag: string | null;
  readonly storedAt: number;
}

/** Paths whose payload is derived from the whole catalogue and is worth caching. */
export function isCacheableCatalogueRead(method: string, path: string): boolean {
  if (method !== 'GET') return false;
  if (path === '/categories' || path === '/regions') return true;
  if (path === '/channels') return true;
  return false;
}

export class ResponseCache {
  private readonly entries = new Map<string, Entry>();
  private hits = 0;
  private misses = 0;

  constructor(private readonly options: ResponseCacheOptions) {}

  stats(): { entries: number; hits: number; misses: number } {
    return { entries: this.entries.size, hits: this.hits, misses: this.misses };
  }

  clear(): void {
    this.entries.clear();
  }

  middleware(): RequestHandler {
    return (request, response, next: NextFunction) => {
      const path = request.path;
      const method = request.method;
      if (!this.options.shouldCache(method, path)) {
        next();
        return;
      }
      const key = `${method} ${request.originalUrl}`;
      const cached = this.entries.get(key);
      if (cached) {
        const age = Date.now() - cached.storedAt;
        const valid = age < this.options.maxAgeMs;
        const ifNoneMatch = request.headers['if-none-match'];
        if (valid && ifNoneMatch && ifNoneMatch === cached.etag) {
          this.hits += 1;
          response.setHeader('x-cache', 'HIT');
          response.status(304).end();
          return;
        }
        if (valid) {
          this.hits += 1;
          response.setHeader('x-cache', 'HIT');
          response.setHeader('content-type', cached.contentType);
          if (cached.etag) response.setHeader('etag', cached.etag);
          response.setHeader('content-length', Buffer.byteLength(cached.body).toString());
          response.status(200).end(cached.body);
          return;
        }
        this.entries.delete(key);
      }
      this.misses += 1;
      response.setHeader('x-cache', 'MISS');
      this.capture(request, response, key);
      next();
    };
  }

  /**
   * Records a successful JSON response produced downstream, by wrapping `end`.
   *
   * `json` cannot be used here: the ETag middleware is mounted *inside* the
   * cache and replaces `res.json` itself, so a `json` hook would never see the
   * body. `end` is the one method every response reaches, and the ETag has been
   * set by then.
   */
  private capture(request: { method: string }, response: Response, key: string): void {
    const originalEnd = response.end.bind(response) as (...args: unknown[]) => Response;
    response.end = ((chunk?: unknown, encoding?: unknown, callback?: unknown) => {
      const isBodyChunk = chunk !== undefined && chunk !== null && typeof chunk !== 'function';
      if (response.statusCode === 200 && request.method === 'GET' && isBodyChunk) {
        try {
          const body = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
          if (this.entries.size >= this.options.maxEntries) {
            // Bounded eviction: drop the oldest entry.
            const oldest = [...this.entries.entries()].sort((a, b) => a[1].storedAt - b[1].storedAt)[0];
            if (oldest) this.entries.delete(oldest[0]);
          }
          this.entries.set(key, {
            body,
            contentType: String(response.getHeader('content-type') ?? 'application/json; charset=utf-8'),
            etag: (response.getHeader('etag') as string | undefined) ?? null,
            storedAt: Date.now(),
          });
        } catch {
          /* an uncacheable body is simply not cached */
        }
      }
      return originalEnd(chunk, encoding, callback) as Response;
    }) as Response['end'];
  }
}

/**
 * Clears the cache whenever an editorial mutation succeeds. Writers are the only
 * actors that can change a public payload, so this is the complete invalidation
 * rule for a single instance.
 */
export function invalidateOnWrite(cache: ResponseCache): RequestHandler {
  return (request, response, next) => {
    if (request.method !== 'GET') {
      response.on('finish', () => {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          cache.clear();
        }
      });
    }
    next();
  };
}
