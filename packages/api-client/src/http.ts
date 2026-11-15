/**
 * HTTP core of the SDK.
 *
 * One request path for every call, so behaviour is uniform:
 * - absolute or relative base URL (works in a browser, in Node and under SSR);
 * - bounded timeout with `AbortSignal`;
 * - structured `ApiError` for any non-2xx, parsed from the documented envelope;
 * - ETag support: a cached validator is sent as `If-None-Match` and a 304 reuses
 *   the last body, so SSR renders and client navigation do not refetch;
 * - no credentials are ever read from, or written to, the network by default.
 */
import type { ApiError as ApiErrorBody } from '@tdt/contracts';

export interface ClientOptions {
  /** API root, e.g. `https://api.example.org/api/v1`. */
  readonly baseUrl: string;
  /** Per-request timeout in milliseconds (default 15000). */
  readonly timeoutMs?: number;
  /** Extra headers (a server-to-server key, an application name). */
  readonly headers?: Readonly<Record<string, string>>;
  /** Custom fetch (e.g. Angular's `fetch`, a polyfill, or a test double). */
  readonly fetch?: typeof fetch;
  /** Reuses conditional requests when a response carried an ETag (default true). */
  readonly cacheValidators?: boolean;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: ReadonlyArray<{ path: string; message: string }>,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }
  get isRateLimited(): boolean {
    return this.status === 429;
  }
  get isValidation(): boolean {
    return this.status === 400;
  }
}

export interface RequestOptions {
  readonly query?: Readonly<Record<string, string | number | boolean | readonly string[] | undefined | null>>;
  readonly signal?: AbortSignal;
  /** Forces a fresh request even if a validator is cached. */
  readonly noCache?: boolean;
}

interface CacheEntry {
  readonly etag: string;
  readonly body: unknown;
}

function buildQuery(query: RequestOptions['query']): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, item);
    } else {
      params.append(key, String(value));
    }
  }
  const serialised = params.toString();
  return serialised ? `?${serialised}` : '';
}

export class HttpCore {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly options: ClientOptions) {}

  /** Normalised base URL without a trailing slash. */
  get baseUrl(): string {
    return this.options.baseUrl.replace(/\/+$/, '');
  }

  async request<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, requestOptions: RequestOptions = {}): Promise<T> {
    const url = `${this.baseUrl}${path}${buildQuery(requestOptions.query)}`;
    const fetchImpl = this.options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      throw new ApiError(0, 'no_fetch', 'No hay implementación de fetch disponible en este entorno.');
    }
    const useCache = method === 'GET' && (this.options.cacheValidators ?? true);
    const cached = useCache && !requestOptions.noCache ? this.cache.get(url) : undefined;

    const controller = new AbortController();
    const timeoutMs = this.options.timeoutMs ?? 15_000;
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
    const onAbort = (): void => controller.abort(requestOptions.signal?.reason);
    requestOptions.signal?.addEventListener('abort', onAbort, { once: true });

    const headers: Record<string, string> = {
      accept: 'application/json',
      ...this.options.headers,
    };
    if (cached) headers['if-none-match'] = cached.etag;

    try {
      const response = await fetchImpl(url, {
        method,
        headers,
        signal: controller.signal,
      });

      if (response.status === 304 && cached) {
        return cached.body as T;
      }

      const text = await response.text();
      const body: unknown = text.length > 0 ? (JSON.parse(text) as unknown) : undefined;

      if (!response.ok) {
        const envelope = body as Partial<ApiErrorBody> | undefined;
        throw new ApiError(
          response.status,
          envelope?.error?.code ?? 'http_error',
          envelope?.error?.message ?? `HTTP ${response.status}`,
          envelope?.error?.details,
          envelope?.requestId ?? response.headers.get('x-request-id') ?? undefined,
        );
      }

      if (useCache) {
        const etag = response.headers.get('etag');
        if (etag) this.cache.set(url, { etag, body });
      }
      return body as T;
    } finally {
      clearTimeout(timer);
      requestOptions.signal?.removeEventListener('abort', onAbort);
    }
  }

  /** Drops every cached validator (e.g. after an editorial change). */
  clearCache(): void {
    this.cache.clear();
  }
}
