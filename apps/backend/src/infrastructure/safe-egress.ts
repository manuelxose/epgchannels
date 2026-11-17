/**
 * SSRF-safe egress executor (TDT-API-02D, SEC-01).
 *
 * A single outbound request, with every SSRF-relevant decision made *before* a
 * socket exists and enforced *at* the socket:
 *
 * 1. **URL**      — `http(s)` only, no `userinfo` (a credential in a URL is never
 *                   replayed: `credential-in-url`), host must not be a reserved
 *                   name (`host-blocked`), nor on the caller's block list.
 * 2. **DNS**      — resolved explicitly (`dns.promises.lookup({all:true})`);
 *                   *every* answer is classified and any non-public address
 *                   fails the request (`private-address`). A set that mixes
 *                   public and private addresses is refused too.
 * 3. **Pinning**  — the connection is made by `node:http(s)` with a custom
 *                   `lookup` that *only* returns the address we validated, so a
 *                   second resolution cannot move the target (`dns-rebind` if the
 *                   socket is somehow given a different address). TLS SNI/`Host`
 *                   still carry the hostname, so virtual hosting keeps working.
 * 4. **Redirects** — handled manually; every hop is re-validated with the same
 *                   policy (`redirect-unsafe` for private/other-scheme, and
 *                   `redirect-unsafe` twice+ means `too-many-redirects` after
 *                   `maxRedirects`).
 * 5. **Headers**  — nothing but `accept` and `user-agent` is ever sent. There is
 *                   deliberately no option to add headers, so `Authorization`,
 *                   `Cookie` and operator headers cannot be replayed.
 * 6. **Size**     — `content-length` is checked up front *and* an incremental
 *                   counter aborts a chunked/lying body (`response-too-large`).
 * 7. **Time**     — one deadline covers connect, redirects and the full body read
 *                   (`timeout`).
 * 8. **Content**  — optional content-type allow-list (`content-type-not-allowed`).
 *
 * `node:http`/`node:https` rather than global `fetch` is a requirement, not a
 * preference: `fetch` offers no hook to force the socket onto a validated IP.
 * No third-party dependencies.
 */
import { promises as dns } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { isPublicAddress, classifyIp, isReservedHostname } from './ip-classification.js';

export type EgressFailureCode =
  | 'invalid-url'
  | 'scheme-not-allowed'
  | 'host-blocked'
  | 'private-address'
  | 'dns-failure'
  | 'dns-rebind'
  | 'redirect-unsafe'
  | 'too-many-redirects'
  | 'timeout'
  | 'response-too-large'
  | 'credential-in-url'
  | 'tls-failure'
  | 'connection-failed'
  /** Content-type allow-list (`allowedContentPrefixes`) rejected the response. */
  | 'content-type-not-allowed';

/** Every failure is one of these codes; `detail` is bounded, redacted evidence. */
export class EgressFailure extends Error {
  constructor(
    readonly code: EgressFailureCode,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'EgressFailure';
  }
}

export interface SafeEgressRequest {
  readonly url: string;
  readonly method?: 'GET' | 'HEAD';
  readonly timeoutMs: number;
  readonly maxBytes: number;
  /** Redirect hops allowed; default 5. */
  readonly maxRedirects?: number;
  /** Extra host block list, same semantics as `egress.ts#isHostBlocked`. */
  readonly blockedHosts?: readonly string[];
  readonly userAgent?: string;
  readonly signal?: AbortSignal;
  /** Content-type prefixes accepted, e.g. `['application/vnd.apple.mpegurl']`. */
  readonly allowedContentPrefixes?: readonly string[];
  /**
   * TEST-ONLY: permit loopback/private destinations so a local fixture can be
   * exercised. Never set this from production code; the default is `false`.
   */
  readonly allowLoopbackForTests?: boolean;
  /**
   * TEST-ONLY companion to `allowLoopbackForTests`: redirect hops may change to
   * these ports (a fixture on an ephemeral port). Ignored unless the loopback
   * test flag is set. Production redirects stay on standard port pairs.
   */
  readonly allowedRedirectPorts?: readonly number[];
  /**
   * Opt-in bounded prefix read: "I only need this many bytes of the body".
   *
   * When set (1 … 1 MiB):
   *  - the declared `content-length` pre-check is skipped for this request, so a
   *    large media segment is no longer refused just for being large;
   *  - the read stops once `prefixBytes` have arrived and the socket is DESTROYED
   *    (not drained), so the origin cannot push the rest of the segment;
   *  - the call resolves normally with `ok`, `status`, `contentType` and `bytes`
   *    equal to the prefix actually received (never more than `prefixBytes`).
   *
   * The incremental counter still applies on top: a body that exceeds `maxBytes`
   * before reaching the cap is still `response-too-large`. Every SSRF defence
   * (scheme/userinfo, reserved names, block list, DNS, private-address, pinning,
   * peer re-check, per-hop redirect validation) runs first and still refuses.
   * Out-of-range values are refused with `invalid-url`, never clamped.
   */
  readonly prefixBytes?: number;
}

/** Bounds for `SafeEgressRequest.prefixBytes`. */
export const MIN_PREFIX_BYTES = 1;
export const MAX_PREFIX_BYTES = 1024 * 1024;

export interface SafeEgressResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly contentType: string | null;
  readonly bytes: number;
  /** Body text for GET (always `null` for HEAD); bounded by `maxBytes`. */
  readonly body: string | null;
  readonly finalUrl: string;
  readonly finalHost: string;
  readonly redirects: number;
  /** Addresses that were validated and pinned for the final hop. */
  readonly resolvedAddresses: readonly string[];
  readonly latencyMs: number;
  /**
   * True when `prefixBytes` was requested and the body was cut at the cap (the
   * origin had more to send). Absent/undefined means the body ended on its own.
   */
  readonly prefixTruncated?: boolean;
}

export type EgressLookup = (host: string) => Promise<readonly string[]>;

export interface SafeEgressDeps {
  /** Injectable resolver; tests replace DNS entirely so no real name is queried. */
  readonly lookup?: EgressLookup;
}

const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_USER_AGENT = 'TDTPlatform/1.0 (+https://example.invalid/tdt-platform)';
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Ports a redirect may move to without an explicit allowance. */
const STANDARD_PORT_ALTERNATIVE: Readonly<Record<number, number>> = { 80: 443, 443: 80 };

/** Same rule as `egress.ts#isHostBlocked`: an entry blocks itself and its subtree. */
function hostMatchesBlockList(host: string, blockedHosts: readonly string[]): boolean {
  const normalized = host.toLowerCase().replace(/\.$/, '');
  return blockedHosts.some((blocked) => {
    const entry = blocked.toLowerCase().trim().replace(/\.$/, '');
    if (entry.length === 0) return false;
    const domain = entry.startsWith('*.') ? entry.slice(2) : entry;
    return normalized === domain || normalized.endsWith(`.${domain}`);
  });
}

/** Hostname without IPv6 brackets, for classification and pinning. */
function bareHost(url: URL): string {
  const host = url.hostname.toLowerCase();
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

interface ValidatedHop {
  readonly url: URL;
  readonly host: string;
  readonly port: number;
  readonly addresses: readonly string[];
}

interface RawResult {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly bytes: number;
  readonly body: string | null;
  /** True when a bounded prefix read stopped the body at `prefixBytes`. */
  readonly prefixTruncated?: boolean;
}

export async function safeFetch(
  request: SafeEgressRequest,
  deps: SafeEgressDeps = {},
): Promise<SafeEgressResponse> {
  const startedAt = Date.now();
  const lookup: EgressLookup =
    deps.lookup ??
    (async (host) => {
      const answers = await dns.lookup(host, { all: true, verbatim: true });
      return answers.map((answer) => answer.address);
    });

  const totalMs = request.timeoutMs;
  if (!Number.isFinite(totalMs) || totalMs <= 0) {
    throw new EgressFailure('invalid-url', 'timeoutMs must be a positive number', { timeoutMs: totalMs });
  }
  if (!Number.isFinite(request.maxBytes) || request.maxBytes <= 0) {
    throw new EgressFailure('response-too-large', 'maxBytes must be a positive number', {
      maxBytes: request.maxBytes,
    });
  }
  // `prefixBytes` is validated, never clamped: a caller that asks for nonsense
  // must hear about it rather than silently getting a different budget.
  if (request.prefixBytes !== undefined) {
    const prefix = request.prefixBytes;
    if (
      typeof prefix !== 'number' ||
      !Number.isInteger(prefix) ||
      prefix < MIN_PREFIX_BYTES ||
      prefix > MAX_PREFIX_BYTES
    ) {
      throw new EgressFailure(
        'invalid-url',
        `prefixBytes must be an integer in [${MIN_PREFIX_BYTES}, ${MAX_PREFIX_BYTES}]; got ${String(prefix)}`,
        { prefixBytes: prefix, min: MIN_PREFIX_BYTES, max: MAX_PREFIX_BYTES },
      );
    }
  }
  const maxRedirects = request.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const method = request.method ?? 'GET';
  const blockedHosts = request.blockedHosts ?? [];
  const deadline = startedAt + totalMs;

  // One abort source for the whole chain: our deadline, plus the caller's signal.
  // Both are tracked separately because they end differently: a deadline is
  // `timeout`, a caller abort is `connection-failed` (the contract has no abort code).
  const controller = new AbortController();
  let timedOut = false;
  let abortedByCaller = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new EgressFailure('timeout', `Egress exceeded ${totalMs} ms`));
  }, totalMs);
  const onOuterAbort = (): void => {
    abortedByCaller = true;
    controller.abort(request.signal?.reason);
  };
  if (request.signal?.aborted === true) {
    // Already aborted before we start: no request may be issued at all.
    abortedByCaller = true;
    controller.abort(request.signal.reason);
  } else {
    request.signal?.addEventListener('abort', onOuterAbort, { once: true });
  }

  const validateHop = async (raw: string, hop: number): Promise<ValidatedHop> => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new EgressFailure('invalid-url', `Invalid URL: ${redact(raw)}`, { hop });
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new EgressFailure('scheme-not-allowed', `Refusing to fetch a non-http(s) URL: ${url.protocol}`, {
        scheme: url.protocol,
        hop,
      });
    }
    if (url.username.length > 0 || url.password.length > 0) {
      // Never echo the credential itself, only the fact that there was one.
      throw new EgressFailure('credential-in-url', 'URL carries userinfo credentials; refusing to replay them', {
        host: url.hostname,
        hop,
      });
    }
    const host = bareHost(url);
    // TEST-ONLY: the flag relaxes *loopback* destinations (a local fixture), never
    // any other reserved or private destination.
    const testMode = request.allowLoopbackForTests === true;
    if (isReservedHostname(host) && !(testMode && isLoopbackLiteral(host))) {
      throw new EgressFailure('host-blocked', `Host "${host}" is a reserved/internal name`, { host, hop });
    }
    if (hostMatchesBlockList(host, blockedHosts)) {
      throw new EgressFailure('host-blocked', `Egress to "${host}" is blocked by policy.`, { host, hop });
    }

    const port = url.port.length > 0 ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new EgressFailure('invalid-url', `Invalid port: ${url.port}`, { hop });
    }

    const isLiteral = host.includes(':') || /^[0-9.]+$/.test(host);
    let answers: readonly string[];
    if (isLiteral) {
      // `new URL` already normalised numeric spellings (`0x7f.1`, `2130706433`),
      // so the literal is classified as written — never re-resolved.
      answers = [host];
    } else {
      try {
        answers = await lookup(host);
      } catch (error) {
        throw new EgressFailure('dns-failure', `DNS lookup failed for "${host}"`, {
          host,
          hop,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      if (answers.length === 0) {
        throw new EgressFailure('dns-failure', `DNS returned no addresses for "${host}"`, { host, hop });
      }
    }

    const privates = answers.filter(
      (address) => !isPublicAddress(address) && !(testMode && isLoopbackLiteral(address)),
    );
    if (privates.length > 0) {
      throw new EgressFailure('private-address', `"${host}" resolves to a non-public address`, {
        host,
        hop,
        addresses: answers.slice(0, 8),
        refused: privates.slice(0, 8),
      });
    }
    return { url, host, port, addresses: answers.map(normalizeAddress) };
  };

  try {
    let current: ValidatedHop = await validateHop(request.url, 0);
    let redirects = 0;
    for (;;) {
        if (controller.signal.aborted) throw abortError(timedOut, totalMs, abortedByCaller);
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        timedOut = true;
        throw new EgressFailure('timeout', `Egress exceeded ${totalMs} ms`, { timeoutMs: totalMs });
      }
      const raw = await performHop(current, {
        method,
        deadline,
        timeoutMs: totalMs,
        maxBytes: request.maxBytes,
        // A HEAD never has a body: a prefix limit is meaningless there, and passing
        // it would only skip the (harmless, empty) declared-length check.
        ...(method === 'GET' && request.prefixBytes !== undefined ? { prefixBytes: request.prefixBytes } : {}),
        userAgent: request.userAgent ?? DEFAULT_USER_AGENT,
        allowedContentPrefixes: request.allowedContentPrefixes ?? [],
        signal: controller.signal,
        wasTimedOut: () => timedOut,
        wasAbortedByCaller: () => abortedByCaller,
      });
      const location = headerValue(raw.headers, 'location');
      if (REDIRECT_STATUSES.has(raw.status) && location !== null) {
        redirects += 1;
        if (redirects > maxRedirects) {
          throw new EgressFailure('too-many-redirects', `Redirect limit ${maxRedirects} exceeded`, {
            maxRedirects,
            redirects,
          });
        }
        let nextUrl: URL;
        try {
          nextUrl = new URL(location, current.url);
        } catch {
          throw new EgressFailure('redirect-unsafe', 'Redirect target is not a valid URL', {
            redirects,
            location: redact(location),
          });
        }
        if (nextUrl.protocol !== 'http:' && nextUrl.protocol !== 'https:') {
          throw new EgressFailure('redirect-unsafe', 'Redirect left http(s)', {
            redirects,
            scheme: nextUrl.protocol,
          });
        }
        let next: ValidatedHop;
        try {
          next = await validateHop(nextUrl.toString(), redirects);
        } catch (error) {
          if (error instanceof EgressFailure) {
            throw new EgressFailure(
              'redirect-unsafe',
              `Redirect #${redirects} rejected: ${error.message}`,
              { redirects, reason: error.code, ...(error.detail ?? {}) },
            );
          }
          throw error;
        }
        // Contract §2 ("cualquier salto … a otro puerto no estándar de egreso"):
        // a hop to a different port must be explicitly permitted, never inferred.
        if (next.port !== current.port) {
          const permitted =
            request.allowLoopbackForTests === true
              ? (request.allowedRedirectPorts ?? []).includes(next.port)
              : STANDARD_PORT_ALTERNATIVE[current.port] === next.port;
          if (!permitted) {
            throw new EgressFailure('redirect-unsafe', `Redirect #${redirects} changes port to ${next.port}`, {
              redirects,
              port: next.port,
              fromPort: current.port,
            });
          }
        }
        current = next;
        continue;
      }
      return {
        status: raw.status,
        ok: raw.status >= 200 && raw.status < 300,
        contentType: headerValue(raw.headers, 'content-type'),
        bytes: raw.bytes,
        body: method === 'HEAD' ? null : raw.body,
        finalUrl: current.url.toString(),
        finalHost: current.host,
        redirects,
        resolvedAddresses: current.addresses,
        latencyMs: Date.now() - startedAt,
        ...(raw.prefixTruncated === true ? { prefixTruncated: true } : {}),
      };
    }
  } catch (error) {
    if (error instanceof EgressFailure) throw error;
    if (timedOut || controller.signal.aborted) throw abortError(timedOut, totalMs, abortedByCaller);
    throw new EgressFailure('connection-failed', error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener('abort', onOuterAbort);
  }
}

/**
 * Which failure closes an aborted chain. A deadline is `timeout`; a caller abort
 * has no code of its own in the contract, so it is reported as
 * `connection-failed` with `reason: 'aborted'`.
 */
function abortError(timedOut: boolean, timeoutMs: number, abortedByCaller = true): EgressFailure {
  if (timedOut) return new EgressFailure('timeout', `Egress exceeded ${timeoutMs} ms`, { timeoutMs });
  return abortedByCaller
    ? new EgressFailure('connection-failed', 'Egress aborted by caller', { reason: 'aborted' })
    : new EgressFailure('connection-failed', 'Egress aborted');
}

function isLoopbackLiteral(address: string): boolean {
  const bare = address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
  const normalized = bare.toLowerCase();
  return normalized === '::1' || normalized === 'localhost' || normalized.startsWith('127.');
}

function normalizeAddress(address: string): string {
  return address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | null {
  const value = headers[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length > 0) return value[0] ?? null;
  return null;
}

/** Redacts userinfo and query values: failures can be logged. */
function redact(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.username.length > 0 || url.password.length > 0) {
      url.username = url.username.length > 0 ? 'redacted' : '';
      url.password = '';
    }
    if (url.search.length > 0) url.search = '?redacted';
    return url.toString();
  } catch {
    return '<unparseable-url>';
  }
}

interface HopOptions {
  readonly method: 'GET' | 'HEAD';
  readonly deadline: number;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly userAgent: string;
  readonly allowedContentPrefixes: readonly string[];
  /** Bounded prefix read: stop after this many body bytes (validated upstream). */
  readonly prefixBytes?: number;
  readonly signal: AbortSignal;
  readonly wasTimedOut: () => boolean;
  readonly wasAbortedByCaller: () => boolean;
}

/**
 * Failure for a stream that closed before its body completed.
 *
 * Most often that close is ours: the size counter called `destroy()` on the
 * response, so the socket errors before any `end` event. In that case the
 * decision we already made is the true verdict — a synchronously-resolved
 * `response-too-large` — never a generic "stream closed" that a caller could
 * re-label as a truncated/invalid body.
 */
function closeError(
  options: HopOptions,
  code: EgressFailureCode,
  message: string,
  decided: EgressFailure | null,
): EgressFailure {
  if (decided !== null) return decided;
  if (options.wasTimedOut()) {
    return new EgressFailure('timeout', `Egress exceeded ${options.timeoutMs} ms`, { timeoutMs: options.timeoutMs });
  }
  if (options.wasAbortedByCaller()) return abortError(false, options.timeoutMs);
  return new EgressFailure(code, message, { reason: 'stream-closed' });
}

/** `lookup` as `node:http`/`node:tls` invoke it (the callback overloads we must answer). */
export type NodeLookupOptions = { readonly all?: boolean | undefined };
type NodeLookupCallback = (
  error: Error | null,
  address: string | readonly { address: string; family: number }[] | null,
  family?: number,
) => void;

/**
 * The pin: a `lookup` for `node:http(s)` that answers ONLY the validated address.
 *
 * Node calls a custom `lookup` in **two** conventions and the callback shape
 * differs between them:
 *
 *  - `options.all !== true` → `callback(err, addressString, family)`
 *  - `options.all === true` → `callback(err, [{ address, family }, …])`
 *
 * Node 20+ enables `autoSelectFamily`, so the http(s) agent normally asks in the
 * `all: true` form. Answering the string form to an `all: true` request makes
 * Node read `.address` of a string and fail every connection with
 * `ERR_INVALID_INVALID_IP_ADDRESS` — for *every* real HTTPS host. Both forms are
 * therefore answered explicitly, and both are asserted by the unit suite —
 * including over the real `net`/`tls` stack rather than only through `deps.lookup`.
 */
export function pinnedLookup(pinned: string | null): (hostname: string, options: NodeLookupOptions, callback: NodeLookupCallback) => void {
  return (_hostname, options, callback) => {
    if (pinned === null) {
      callback(new EgressFailure('dns-rebind', 'No validated address to pin'), null);
      return;
    }
    const family = pinned.includes(':') ? 6 : 4;
    if (options?.all === true) {
      callback(null, [{ address: pinned, family }], family);
      return;
    }
    callback(null, pinned, family);
  };
}

function performHop(hop: ValidatedHop, options: HopOptions): Promise<RawResult> {
  const pinned = pickPinnedAddress(hop.addresses);
  return new Promise<RawResult>((resolve, reject) => {
    let settled = false;
    /** A failure verdict decided before a deliberate teardown; wins over teardown errors. */
    let pendingError: EgressFailure | null = null;
    /**
     * A SUCCESS verdict decided before a deliberate teardown — the bounded prefix
     * read closing the socket after `prefixBytes`. Pinned for the same reason as
     * `pendingError`: the `aborted`/`error` events a destroy() produces would
     * otherwise replace a complete, correct prefix with a transport failure.
     */
    let decision: RawResult | null = null;
    const finish = (error: EgressFailure | null, value?: RawResult): void => {
      if (settled) return;
      settled = true;
      // A deliberate teardown (size cap, refused type, peer mismatch, prefix read
      // complete) is followed by `aborted`/`close` errors from the destroyed
      // socket, in no fixed order. The decided verdict is the truth, so it is
      // queued and only resolved on the next tick, after those errors are ignored.
      if (decision !== null) {
        const decidedResult = decision;
        queueMicrotask(() => resolve(decidedResult));
        return;
      }
      if (pendingError !== null) {
        queueMicrotask(() => reject(pendingError as EgressFailure));
        return;
      }
      options.signal.removeEventListener('abort', onAbort);
      if (error !== null) reject(error);
      else resolve(value as RawResult);
    };
    const onAbort = (): void => {
      finish(abortError(options.wasTimedOut(), options.timeoutMs));
      request.destroy();
    };

    const transport = hop.url.protocol === 'https:' ? https : http;
    const request = transport.request(
      {
        protocol: hop.url.protocol,
        host: hop.host,
        hostname: hop.host,
        port: hop.port,
        path: `${hop.url.pathname}${hop.url.search}`,
        method: options.method,
        // Bound the handshake/headers separately; the body read is bounded below
        // by the same overall deadline.
        timeout: Math.max(1, options.deadline - Date.now()),
        // Exactly two headers, ever. No header map from the caller exists.
        headers: {
          accept: '*/*',
          'user-agent': options.userAgent,
        },
        agent: false,
        // The pin: the only address this socket may connect to. Answers both of
        // Node's lookup callback conventions (see `pinnedLookup`).
        lookup: pinnedLookup(pinned) as never,
        ...(hop.url.protocol === 'https:' ? { servername: hop.host } : {}),
      },
      (response: IncomingMessage) => {
        /** Records the verdict we are about to deliver (see `closeError`). */
        let decided: EgressFailure | null = null;
        /**
         * Decides the failure first, then tears the socket down, and resolves the
         * promise SYNCHRONOUSLY with that verdict. `abortWith` is always called
         * from a socket/stream callback, so `finish` runs synchronously: the
         * deliberate-destroy errors that follow can never replace the verdict
         * with a generic one (or let a truncated body reach the caller).
         */
        const abortWith = (error: EgressFailure): void => {
          decided = error;
          pendingError = error;
          response.destroy();
          request.destroy();
          finish(error);
        };

        // Anti-rebinding check at the socket: the peer must be a validated answer.
        const peer = peerAddress(response.socket as Socket | null);
        if (peer !== null) {
          const normalizedPeer = normalizeAddress(peer).toLowerCase();
          const allowed = hop.addresses.some((address) => address.toLowerCase() === normalizedPeer);
          if (!allowed) {
            abortWith(
              new EgressFailure('dns-rebind', 'Connection peer is not a validated address', {
                host: hop.host,
                peer: normalizedPeer,
                validated: hop.addresses.slice(0, 8),
              }),
            );
            return;
          }
        }

        const headers = response.headers;
        const declaredLength = Number(headerValue(headers, 'content-length') ?? '');
        // With a prefix read the declared size is irrelevant to what we will hold:
        // we are sampling a segment we already vetted at the HEAD layer, and the
        // whole point is to refuse it *before* transferring it. So this one check
        // is skipped — and only this one. Everything above it (SSRF checks, the
        // pin, the peer check) and everything below it (content-type, the
        // incremental counter, the deadline) still applies.
        if (options.prefixBytes === undefined && Number.isFinite(declaredLength) && declaredLength > options.maxBytes) {
          abortWith(
            new EgressFailure('response-too-large', `Declared content-length exceeds ${options.maxBytes} bytes`, {
              host: hop.host,
              contentLength: declaredLength,
              maxBytes: options.maxBytes,
            }),
          );
          return;
        }
        const contentType = headerValue(headers, 'content-type');
        const responseStatus = response.statusCode ?? 0;
        const is2xx = responseStatus >= 200 && responseStatus < 300;
        // The content-type allow-list is a *body trust* rule for the payload the
        // caller asked for. An error status (404/403/451/503) usually carries
        // text/html, and its meaning is the status, not the body: refusing it
        // here would erase the only signal a caller can classify by. Only 2xx
        // payloads are filtered.
        if (is2xx && !contentTypeAllowed(contentType, options.allowedContentPrefixes)) {
          abortWith(
            new EgressFailure('content-type-not-allowed', `Content-Type "${contentType ?? ''}" is not allowed`, {
              host: hop.host,
              contentType,
              allowed: options.allowedContentPrefixes,
            }),
          );
          return;
        }

        // Buffer is bounded by the smaller of `maxBytes` and `prefixBytes`: the read
        // is cut off the moment either limit is reached, so a hostile stream cannot
        // grow memory and cannot push the rest of a large body at us.
        const chunks: Buffer[] = [];
        let bytes = 0;
        const prefixBytes = options.prefixBytes;
        const tooLarge = (): void =>
          abortWith(
            new EgressFailure('response-too-large', `Response body exceeds ${options.maxBytes} bytes`, {
              host: hop.host,
              maxBytes: options.maxBytes,
              bytes,
            }),
          );
        const prefixReached = (received: number): void => {
          // The verdict is a SUCCESS, resolved synchronously before the teardown,
          // exactly like a decided failure: `decision` pins it so the destroy
          // errors that follow cannot replace it. `request.destroy()` closes the
          // socket; the body is never drained.
          decision = {
            status: response.statusCode ?? 0,
            headers,
            bytes: received,
            body: options.method === 'GET' ? Buffer.concat(chunks).toString('utf8') : null,
            prefixTruncated: true,
          };
          response.destroy();
          request.destroy();
        };
        response.on('data', (chunk: Buffer) => {
          if (settled) return;
          if (prefixBytes !== undefined) {
            // Prefix mode: ONE cumulative counter for every byte this response
            // delivers, checked BEFORE the cap. A prefix read may skip the
            // declared-length pre-check, but it must never lift the `maxBytes`
            // ceiling: reaching the cap first is the normal, successful end; a
            // body that runs past `maxBytes` first is `response-too-large`.
            bytes += chunk.byteLength;
            const kept = Math.min(prefixBytes, chunk.byteLength, Math.max(0, prefixBytes - (bytes - chunk.byteLength)));
            if (kept > 0) chunks.push(chunk.subarray(0, kept));
            if (bytes >= prefixBytes) {
              prefixReached(prefixBytes);
              return;
            }
            if (bytes > options.maxBytes) {
              tooLarge();
              return;
            }
            return;
          }
          bytes += chunk.byteLength;
          if (bytes > options.maxBytes) {
            tooLarge();
            return;
          }
          if (options.method === 'GET') chunks.push(chunk);
        });
        response.on('end', () => {
          if (settled) return;
          // NOTE: when a prefix/destroy verdict is pinned, `finish` resolves with
          // that pinned value itself, so no separate branch is needed here.
          finish(null, {
            status: response.statusCode ?? 0,
            headers,
            bytes,
            body: options.method === 'GET' ? Buffer.concat(chunks).toString('utf8') : null,
          });
        });
        response.on('error', (error) => {
          if (settled) return;
          if (decision !== null) {
            finish(null, decision);
            return;
          }
          finish(closeError(options, 'connection-failed', error.message, decided));
        });
        response.on('aborted', () => {
          if (settled) return;
          if (decision !== null) {
            finish(null, decision);
            return;
          }
          finish(closeError(options, 'connection-failed', 'Response aborted before completion', decided));
        });
      },
    );

    request.on('timeout', () => {
      // Covers the handshake and the header phase; the body phase shares the
      // same overall deadline through the abort signal above.
      request.destroy();
      finish(new EgressFailure('timeout', `Egress exceeded ${options.timeoutMs} ms`, { timeoutMs: options.timeoutMs }));
    });
    request.on('error', (error: NodeJS.ErrnoException) => {
      if (settled) return;
      // A deliberate teardown after a verdict (`response-too-large`, refused
      // content-type, peer mismatch, prefix complete) surfaces here as
      // ECONNRESET/aborted, in no fixed order relative to the response events.
      // The verdict we decided is the truth, so it wins over any generic close.
      if (decision !== null) {
        finish(null, decision);
        return;
      }
      if (pendingError !== null) {
        finish(pendingError);
        return;
      }
      if (options.wasTimedOut() || options.wasAbortedByCaller()) {
        finish(abortError(options.wasTimedOut(), options.timeoutMs));
        return;
      }
      if (error instanceof EgressFailure) {
        finish(error);
        return;
      }
      const code = error.code ?? '';
      if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(code) || /certificate|tls|ssl/i.test(error.message)) {
        finish(new EgressFailure('tls-failure', error.message, { host: hop.host, code }));
        return;
      }
      finish(new EgressFailure('connection-failed', error.message, { host: hop.host, code }));
    });
    options.signal.addEventListener('abort', onAbort, { once: true });
    request.end();
  });
}

/** Deterministic pin: first validated address, IPv4 preferred for stability. */
function pickPinnedAddress(addresses: readonly string[]): string | null {
  const v4 = addresses.find((address) => !address.includes(':'));
  return v4 ?? addresses[0] ?? null;
}

function peerAddress(socket: Socket | null): string | null {
  if (socket === null) return null;
  const remote = socket.remoteAddress;
  if (typeof remote !== 'string' || remote.length === 0) return null;
  // Node reports IPv4-over-IPv6 as `::ffff:127.0.0.1`.
  return remote.startsWith('::ffff:') && remote.includes('.') ? remote.slice(7) : remote;
}

function contentTypeAllowed(contentType: string | null, prefixes: readonly string[]): boolean {
  if (prefixes.length === 0) return true;
  if (contentType === null) return false;
  const normalized = contentType.toLowerCase();
  return prefixes.some((prefix) => normalized.startsWith(prefix.toLowerCase()));
}
