/**
 * Outbound network policy.
 *
 * Every server-side fetch of third-party data goes through this module, which
 * owns three rules:
 *
 * 1. Only `http(s)` is ever fetched, never a redirect chain into another scheme.
 * 2. A host block list (used by the independence test, and usable in staging)
 *    fails before a socket is opened.
 * 3. Timeouts and response size are always bounded, and nothing is downloaded
 *    that was not asked for.
 *
 * The platform's *normal operation* never consults a third-party catalogue: this
 * module is used only by verification jobs and by guide ingestion from sources
 * an operator explicitly enabled.
 */
import { EgressFailure, safeFetch } from './safe-egress.js';

export class EgressBlockedError extends Error {
  constructor(public readonly host: string) {
    super(`Egress to "${host}" is blocked by policy.`);
    this.name = 'EgressBlockedError';
  }
}

export class EgressResponseTooLargeError extends Error {
  constructor(host: string, limit: number) {
    super(`Response from "${host}" exceeds the ${limit} byte limit.`);
    this.name = 'EgressResponseTooLargeError';
  }
}

export interface EgressOptions {
  readonly blockedHosts: readonly string[];
  readonly timeoutMs: number;
  readonly maxBytes?: number;
  readonly userAgent?: string;
  /** Probe only: `HEAD` avoids downloading a media manifest body. */
  readonly method?: 'GET' | 'HEAD';
  readonly signal?: AbortSignal;
  /**
   * Run the request through the SSRF guard (`safe-egress.ts`) instead of plain
   * `fetch`: explicit DNS resolution, private/reserved destination refusal, a
   * pinned connection, re-validated redirects and a body-size counter.
   *
   * **Off by default** so that `fetchWithPolicy` keeps its historical behaviour
   * exactly; TDT-API-02D's verification engine sets it. Callers that opt in get
   * `EgressFailure` (from `safe-egress.ts`) for guard refusals and the existing
   * error types for the pre-existing checks.
   */
  readonly ssrfGuard?: boolean;
}

export interface EgressResult {
  readonly status: number;
  readonly ok: boolean;
  readonly contentType: string | null;
  readonly bytes: number;
  /** Body text, only for GET requests that passed the size limit. */
  readonly body: string | null;
  readonly finalHost: string;
}

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_USER_AGENT = 'TDTPlatform/1.0 (+https://example.invalid/tdt-platform)';

/**
 * True when `host` equals, or is a subdomain of, any blocked entry.
 *
 * An entry blocks the domain it names *and everything below it*
 * (`tdtchannels.com` also blocks `www.tdtchannels.com`); an entry written as
 * `*.example.com` expresses the same rule.
 */
export function isHostBlocked(host: string, blockedHosts: readonly string[]): boolean {
  const normalized = host.toLowerCase().replace(/\.$/, '');
  return blockedHosts.some((blocked) => {
    const entry = blocked.toLowerCase().trim().replace(/\.$/, '');
    if (entry.length === 0) return false;
    const domain = entry.startsWith('*.') ? entry.slice(2) : entry;
    return normalized === domain || normalized.endsWith(`.${domain}`);
  });
}

export async function fetchWithPolicy(url: string, options: EgressOptions): Promise<EgressResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Refusing to fetch a non-http(s) URL: ${parsed.protocol}`);
  }
  if (isHostBlocked(parsed.hostname, options.blockedHosts)) {
    throw new EgressBlockedError(parsed.hostname);
  }

  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  // SSRF guard delegation (TDT-API-02D, SEC-01). Opt-in only: the historical
  // path below is untouched so guide ingestion and the youtube probe behave
  // exactly as before. When enabled, `safe-egress.ts` owns DNS resolution,
  // private-address refusal, connection pinning, redirect validation and the
  // body-size counter; refusals surface as `EgressFailure` and the two
  // pre-existing error types are preserved for the two pre-existing conditions
  // (blocked host, oversized body).
  if (options.ssrfGuard === true) {
    let guarded;
    try {
      guarded = await safeFetch({
        url: parsed.toString(),
        method: options.method ?? 'GET',
        timeoutMs: options.timeoutMs,
        maxBytes,
        blockedHosts: options.blockedHosts,
        ...(options.userAgent !== undefined ? { userAgent: options.userAgent } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
    } catch (error) {
      if (error instanceof EgressFailure) {
        // Preserve the historical error types for the two conditions this module
        // has always reported; every other refusal is the guard's own code.
        if (error.code === 'response-too-large') {
          const host = typeof error.detail?.['host'] === 'string' ? error.detail['host'] : parsed.hostname;
          throw new EgressResponseTooLargeError(host, maxBytes);
        }
        if (error.code === 'host-blocked') {
          throw new EgressBlockedError(parsed.hostname);
        }
      }
      throw error;
    }
    return {
      status: guarded.status,
      ok: guarded.ok,
      contentType: guarded.contentType,
      bytes: guarded.bytes,
      body: guarded.body,
      finalHost: guarded.finalHost,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('egress timeout')), options.timeoutMs);
  const onOuterAbort = (): void => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', onOuterAbort, { once: true });

  try {
    const response = await fetch(parsed, {
      method: options.method ?? 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        accept: '*/*',
        'user-agent': options.userAgent ?? DEFAULT_USER_AGENT,
      },
    });
    // A redirect may land on a blocked host: re-check the final origin.
    const finalHost = new URL(response.url).hostname;
    if (isHostBlocked(finalHost, options.blockedHosts)) {
      await response.body?.cancel();
      throw new EgressBlockedError(finalHost);
    }
    const contentLength = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      await response.body?.cancel();
      throw new EgressResponseTooLargeError(finalHost, maxBytes);
    }
    let body: string | null = null;
    let bytes = 0;
    if ((options.method ?? 'GET') === 'GET' && response.body) {
      const chunks: Uint8Array[] = [];
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBytes) {
          await reader.cancel();
          throw new EgressResponseTooLargeError(finalHost, maxBytes);
        }
        chunks.push(value);
      }
      body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
    }
    return {
      status: response.status,
      ok: response.ok,
      contentType: response.headers.get('content-type'),
      bytes,
      body,
      finalHost,
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onOuterAbort);
  }
}
