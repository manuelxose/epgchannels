/**
 * The layered validation engine (MODULE-CONTRACT-02D §3).
 *
 * Six layers, and the reported depth is the layer the evidence came from — never
 * the layer that was requested. The ordering is not cosmetic, it is the security
 * property: eligibility is decided *before* any socket could be opened, so an
 * unauthorised source is refused without an egress call at all.
 *
 * | # | layer      | what it proves                                         |
 * |---|------------|--------------------------------------------------------|
 * | 1 | eligibility| the 02C gate says `playable`                           |
 * | 2 | dns        | bounded DNS answers, no private/reserved destination     |
 * | 3 | transport  | 2xx + an HLS/DASH content type                          |
 * | 4 | manifest   | a coherent manifest of the declared format              |
 * | 5 | playlist   | variant/segment sample answers (bounded, N=2)           |
 * | 6 | browser    | an INJECTED reproduction verdict, never opened here     |
 *
 * Two invariants this file exists to keep:
 *
 * - **`HTTP 200` is not health.** For `hls`/`dash`, `healthy` is reachable only
 *   after layers 4 and 5 produced evidence; layer 3 alone stops at `manifest`.
 * - **No browser is ever opened.** Layer 6 consumes a `BrowserProbeResult` the
 *   caller obtained elsewhere. With no probe available the outcome stays at
 *   pre-browser health and `uncertainty.browserNotProbed` records that the
 *   reproduction axis was *not observed* — never that it failed.
 */
import { hostname as osHostname } from 'node:os';
import type { PlaybackSourceDoc } from '../infrastructure/schema.js';
import type { PlaybackType } from '@tdt/contracts';
import { decideSourceEligibility } from '../modules/providers/source-eligibility.js';
import { providerAdapterRegistry, type ProviderAdapterRegistry } from '../modules/providers/adapter.registry.js';
import type { AuthorizationRecord, EligibilityDecision } from '../modules/providers/authorization.js';
import { redactCredentials } from '../ingestion/provenance.js';
import { FAILURE_CAUSE, type FailureCategory } from './failures.js';
import {
  EMPTY_UNCERTAINTY,
  type BoundedEvidence,
  type CheckOutcomeCode,
  type EligibilitySnapshot,
  type FailureCause,
  type FailureDetail,
  type ManifestFactsSummary,
  type Uncertainty,
  type ValidationDepth,
} from './health.schema.js';
import { isDashMime, isHlsMime, parseManifest, samplePlaylistUris } from './manifest.js';

export type { ValidationDepth } from './health.schema.js';

/**
 * What a single bounded egress call returns. Deliberately smaller than
 * `EgressResult`: the verification engine needs a body and a status, and the
 * SSRF owner (`ssrf-engineer`) implements the real one.
 */
export interface EgressResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly contentType: string | null;
  readonly bytes: number;
  readonly body: string | null;
  readonly finalUrl: string;
  readonly latencyMs: number;
  /** Present only when the transport failed before a status existed. */
  readonly transportError?: string;
}

export interface EgressRequest {
  readonly url: string;
  readonly method?: 'GET' | 'HEAD';
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly allowedContentPrefixes?: readonly string[];
}

/** The injected egress seam: one bounded request, one bounded answer. */
export type EgressFn = (req: EgressRequest) => Promise<EgressResponse>;

export interface DnsAnswer {
  readonly address: string;
  readonly family: 4 | 6;
}

export interface DnsResolution {
  readonly host: string;
  readonly addresses: readonly DnsAnswer[];
}

/** The injected DNS seam: a resolution, bounded and observable. */
export type DnsResolverFn = (host: string) => Promise<DnsResolution>;

/**
 * The injected browser verdict. This engine consumes it and never produces it.
 * A browser probe is produced by the captain's deterministic script
 * (`apps/backend/scripts/browser-playback-check.mjs`), never by this module.
 */
export interface BrowserProbeResult {
  /** `null` when the probe could not be run at all. */
  readonly reproduced: boolean;
  readonly failure: 'browser-incompatible' | 'codec-failure' | 'cors-limitation' | null;
  /** Our own words. Never a page excerpt. */
  readonly note: string | null;
  readonly evidence: {
    readonly mediaErrorCode: number | null;
    readonly manifestRequests: number;
    readonly segmentRequests: number;
    readonly blockedByCors: boolean;
  };
  readonly probedAt: Date;
}

export interface ValidationRequest {
  readonly source: PlaybackSourceDoc;
  readonly authorization: AuthorizationRecord | null;
  readonly registry?: ProviderAdapterRegistry;
  /** Layer 1 → everything else. Called only after eligibility passed. */
  readonly egress: EgressFn;
  /** Optional DNS seam (layer 2). Absent ⇒ layer 2 is *not observed*, which is not a pass. */
  readonly dns?: DnsResolverFn;
  /** Segments sampled in layer 5. Default 2 (§4). */
  readonly segmentSample?: number;
  /** Injected reproduction verdict, or `null` when it was not probed. */
  readonly browser?: BrowserProbeResult | null;
  readonly now?: Date;
  /** Label of the egress origin, for the check row (`origin.egressHost`). */
  readonly egressHost?: string;
}

export interface ValidationResult {
  readonly outcome: CheckOutcomeCode;
  readonly cause: FailureCause | null;
  readonly depthReached: ValidationDepth;
  readonly evidence: BoundedEvidence;
  readonly failure: FailureDetail | null;
  readonly uncertainty: Uncertainty;
  readonly eligibilityAt: EligibilitySnapshot;
}

export const DEFAULT_SEGMENT_SAMPLE = 2;
export const SEGMENT_TIMEOUT_MS = 8_000;
export const MANIFEST_TIMEOUT_MS = 15_000;
export const MANIFEST_MAX_BYTES = 2 * 1024 * 1024;
export const SEGMENT_MAX_BYTES = 64 * 1024;
export const DEFAULT_USER_AGENT = 'TDTPlatform/1.0 (+https://example.invalid/tdt-platform)';

/** Where a depth sits in the order; used to keep "reached" monotonic. */
const DEPTH_ORDER: Readonly<Record<ValidationDepth, number>> = {
  eligibility: 1,
  dns: 2,
  transport: 3,
  manifest: 4,
  playlist: 5,
  segments: 6,
  browser: 7,
};

/** Types whose availability this platform can observe over HTTP at all. */
const NETWORK_PROBED_TYPES: ReadonlySet<string> = new Set(['hls', 'dash']);

/**
 * Runs the layers in order and returns the first evidence-backed verdict.
 *
 * Pure with respect to its injections: the only I/O is through `egress` and
 * `dns`, and neither is called before eligibility has passed.
 */
export async function runValidation(request: ValidationRequest): Promise<ValidationResult> {
  const now = request.now ?? new Date();
  const source = request.source;
  const type = source.type as PlaybackType;
  const segmentSample = Math.max(0, Math.trunc(request.segmentSample ?? DEFAULT_SEGMENT_SAMPLE));

  // ── Layer 1: eligibility, before anything touches the network ─────────────
  const decision = decideSourceEligibility({
    publication: {
      channelStatus: source.editorialStatus,
      sourceStatus: source.editorialStatus,
      permission: source.permission as never,
      technicalStatus: source.technicalStatus,
      conditions: source.conditions,
    },
    authorization: request.authorization,
    type,
    now,
    ...(request.registry === undefined ? {} : { registry: request.registry }),
  });

  const eligibilityAt = snapshotOf(decision, now);
  const probe = {
    httpStatus: null as number | null,
    contentType: null as string | null,
    bytes: null as number | null,
    sampleSha256: null as string | null,
    urls: [] as string[],
    segmentStatuses: [] as number[],
    manifest: null as ManifestFactsSummary | null,
    latencyMs: null as number | null,
    samplesRequested: segmentSample,
    samplesAttempted: 0,
  };
  const uncertainty = { ...EMPTY_UNCERTAINTY, notes: [] as string[] };

  if (!decision.playable) {
    // Contract §3 layer 1: no socket is opened. The egress function is not called.
    const reason = decision.publicationReason ?? decision.authorizationReason ?? 'ineligible';
    return finish({
      outcome: 'ineligible',
      depth: 'eligibility',
      evidence: evidenceOf(probe),
      failure: failure('ineligible', 'eligibility', `Not playable: ${reason}`),
      uncertainty,
      eligibilityAt,
    });
  }

  const url = source.url;
  if (url === null || url.trim() === '') {
    // Contract hard rule 3: a source with no URL fails closed.
    return finish({
      outcome: 'unverifiable',
      depth: 'eligibility',
      evidence: evidenceOf(probe),
      failure: failure('unsupported-format', 'eligibility', 'Eligible source has no URL to probe.'),
      uncertainty,
      eligibilityAt,
    });
  }

  /*
   * Credentials in the URL are never used, never sent and never stored: the
   * verifier has no operator credentials to replay, and a userinfo URL is a
   * source we do not hold the right to probe (contract §2, `ineligible`).
   */
  if (hasUserInfo(url)) {
    return finish({
      outcome: 'ineligible',
      depth: 'eligibility',
      evidence: evidenceOf(probe),
      failure: failure('ineligible', 'eligibility', 'URL carries userinfo credentials; not used.'),
      uncertainty,
      eligibilityAt,
    });
  }

  if (!NETWORK_PROBED_TYPES.has(source.type)) {
    // Embed/link integrations are not fetched by this platform (no generic proxy).
    // Availability is not observable here, so it is declared, not guessed.
    uncertainty.browserNotProbed = true;
    uncertainty.notes.push('type-not-probed-over-http');
    return finish({
      outcome: 'unverifiable',
      depth: 'eligibility',
      evidence: evidenceOf(probe),
      failure: null,
      uncertainty,
      eligibilityAt,
    });
  }

  const initial = new URL(url);
  probe.urls.push(redactCredentials(initial.toString(), true));

  // ── Layer 2: DNS, when a resolver is injected ────────────────────────────
  if (request.dns !== undefined) {
    try {
      const resolution = await request.dns(initial.hostname);
      if (resolution.addresses.length === 0) {
        return finish({
          outcome: 'failing',
          depth: 'dns',
          evidence: evidenceOf(probe),
          failure: failure('dns-failure', 'dns', 'Resolution returned no address.'),
          uncertainty,
          eligibilityAt,
        });
      }
    } catch (error) {
      const category: FailureCategory =
        error instanceof Error && /tls|certificate/i.test(error.message) ? 'tls-failure' : 'dns-failure';
      return finish({
        outcome: 'failing',
        depth: 'dns',
        evidence: evidenceOf(probe),
        failure: failure(category, 'dns', messageOf(error)),
        uncertainty,
        eligibilityAt,
      });
    }
  } else {
    uncertainty.notes.push('dns-not-observed');
  }

  // ── Layer 3: bounded transport + content type ────────────────────────────
  let response: EgressResponse;
  try {
    response = await request.egress({
      url: initial.toString(),
      method: 'GET',
      timeoutMs: MANIFEST_TIMEOUT_MS,
      maxBytes: MANIFEST_MAX_BYTES,
      allowedContentPrefixes: ['application/vnd.apple.mpegurl', 'application/x-mpegurl', 'application/dash+xml'],
    });
  } catch (error) {
    const category = transportCategory(error);
    return finish({
      outcome: 'failing',
      depth: 'transport',
      evidence: evidenceOf(probe),
      failure: failure(category, 'transport', messageOf(error)),
      uncertainty,
      eligibilityAt,
    });
  }

  probe.httpStatus = response.status;
  probe.contentType = response.contentType;
  probe.bytes = response.bytes;
  probe.latencyMs = response.latencyMs;
  if (response.finalUrl !== initial.toString()) {
    probe.urls.push(redactCredentials(response.finalUrl, true));
  }

  if (!response.ok) {
    const category = statusCategory(response.status);
    return finish({
      outcome: 'failing',
      depth: 'transport',
      evidence: evidenceOf(probe),
      failure: failure(category, 'transport', `HTTP ${response.status}`),
      uncertainty,
      eligibilityAt,
    });
  }

  const declared: 'hls' | 'dash' = source.type === 'dash' ? 'dash' : 'hls';
  const mimeMatches = declared === 'hls' ? isHlsMime(response.contentType) : isDashMime(response.contentType);
  if (!mimeMatches) {
    // A 200 with the wrong type is not a manifest: nothing downstream can be
    // trusted, so this stops at the transport layer.
    return finish({
      outcome: 'failing',
      depth: 'transport',
      evidence: evidenceOf(probe),
      failure: failure(
        'unsupported-format',
        'transport',
        `Content-Type ${response.contentType ?? '(none)'} is not a ${declared} manifest type.`,
      ),
      uncertainty,
      eligibilityAt,
    });
  }

  // ── Layer 4: manifest ────────────────────────────────────────────────────
  const parsed = parseManifest(response.body ?? '', response.contentType, { expected: declared });
  if (!parsed.ok) {
    return finish({
      outcome: 'failing',
      depth: 'manifest',
      evidence: evidenceOf(probe),
      failure: failure(parsed.reason, 'manifest', parsed.detail),
      uncertainty,
      eligibilityAt,
    });
  }
  probe.manifest = parsed.facts;
  probe.sampleSha256 = parsed.facts.first4KiBSha256;
  if (parsed.truncated) uncertainty.manifestTruncated = true;

  // ── Layer 5: playlist and segment sampling ───────────────────────────────
  const baseUrl = response.finalUrl;
  const sampled = samplePlaylistUris(response.body ?? '', baseUrl, segmentSample);
  if (parsed.facts.format === 'hls-master') {
    if (sampled.variants.length === 0) {
      return finish({
        outcome: 'failing',
        depth: 'playlist',
        evidence: evidenceOf(probe),
        failure: failure('invalid-manifest', 'playlist', 'Master playlist declares variants but none resolved.'),
        uncertainty,
        eligibilityAt,
      });
    }
    return finish({
      outcome: 'degraded',
      depth: 'playlist',
      evidence: evidenceOf(probe),
      failure: null,
      uncertainty: markSegmentsNotSampled(uncertainty, 'master-playlist-segments-not-sampled'),
      eligibilityAt,
    });
  }

  if (segmentSample === 0) {
    // Nothing was sampled, so segment health is **not observed**. It cannot be
    // claimed healthy from a manifest alone.
    return finish({
      outcome: 'degraded',
      depth: 'manifest',
      evidence: evidenceOf(probe),
      failure: null,
      uncertainty: markSegmentsNotSampled(uncertainty, 'segment-sample-size-zero'),
      eligibilityAt,
    });
  }

  if (parsed.facts.format === 'dash') {
    /*
     * The MPD parser reports structure, not media entries, so nothing was
     * sampled. Segments are *not observed* here — which is recorded, never
     * promoted to `healthy`.
     */
    return finish({
      outcome: 'degraded',
      depth: 'manifest',
      evidence: evidenceOf(probe),
      failure: null,
      uncertainty: markSegmentsNotSampled(uncertainty, 'dash-segments-not-sampled'),
      eligibilityAt,
    });
  }

  if (sampled.segments.length === 0) {
    return finish({
      outcome: 'failing',
      depth: 'playlist',
      evidence: evidenceOf(probe),
      failure: failure('invalid-manifest', 'playlist', 'Media playlist declares segments but none resolved.'),
      uncertainty,
      eligibilityAt,
    });
  }

  let segmentsOk = 0;
  let firstCategory: FailureCategory | null = null;
  for (const segmentUrl of sampled.segments) {
    probe.urls.push(redactCredentials(segmentUrl, true));
    probe.samplesAttempted += 1;
    try {
      const segment = await request.egress({
        url: segmentUrl,
        method: 'GET',
        timeoutMs: SEGMENT_TIMEOUT_MS,
        maxBytes: SEGMENT_MAX_BYTES,
      });
      probe.segmentStatuses.push(segment.status);
      if (segment.ok) segmentsOk += 1;
      else if (firstCategory === null) firstCategory = statusCategory(segment.status);
    } catch (error) {
      probe.segmentStatuses.push(0);
      if (firstCategory === null) firstCategory = transportCategory(error);
    }
  }

  if (firstCategory !== null) {
    const category: FailureCategory =
      firstCategory === 'http-401' || firstCategory === 'http-403' ? 'segments-forbidden' : 'missing-segments';
    return finish({
      outcome: 'failing',
      depth: 'playlist',
      evidence: evidenceOf(probe),
      failure: failure(category, 'playlist', `Sampled segments: ${segmentsOk}/${probe.samplesAttempted} answered 2xx.`),
      uncertainty,
      eligibilityAt,
    });
  }

  // ── Layer 6: injected browser reproduction ──────────────────────────────
  const browser = request.browser ?? null;
  if (browser === null) {
    const marked = { ...uncertainty, notes: [...uncertainty.notes] };
    marked.browserNotProbed = true;
    return finish({
      outcome: 'healthy',
      depth: 'segments',
      evidence: evidenceOf(probe),
      failure: null,
      uncertainty: marked,
      eligibilityAt,
    });
  }

  if (!browser.reproduced) {
    const category: FailureCategory = browser.failure ?? 'browser-incompatible';
    return finish({
      outcome: 'degraded',
      depth: 'browser',
      evidence: evidenceOf(probe),
      failure: failure(category, 'browser', browser.note ?? 'Browser did not reproduce the stream.'),
      uncertainty,
      eligibilityAt,
    });
  }

  return finish({
    outcome: 'healthy',
    depth: 'browser',
    evidence: evidenceOf(probe),
    failure: null,
    uncertainty,
    eligibilityAt,
  });
}

function markSegmentsNotSampled(uncertainty: Uncertainty, note: string): Uncertainty {
  return { ...uncertainty, segmentsNotSampled: true, notes: [...uncertainty.notes, note] };
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 300);
  return String(error).slice(0, 300);
}

function hasUserInfo(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.username !== '' || parsed.password !== '';
  } catch {
    return false;
  }
}

/**
 * Status → contract category. Only `http-5xx` (and 429, which is the origin
 * asking us to slow down) may retry; 401/403/404/410/451 are permanent records.
 *
 * The vocabulary has no generic `http-4xx` member, so an unlisted 4xx is
 * recorded as `http-404`: the resource we requested is not available to us. It
 * is deliberately *not* mapped to a retryable category.
 */
export function statusCategory(status: number): FailureCategory {
  if (status === 401) return 'http-401';
  if (status === 403) return 'http-403';
  if (status === 451) return 'http-451';
  if (status >= 500 || status === 429) return 'http-5xx';
  return 'http-404';
}

/**
 * `EgressFailure.code` → contract category. This is the authoritative mapping:
 * the code is a structured contract from the egress layer, while a message is
 * prose that changes whenever someone rewords a log line.
 *
 * The failure this replaces is instructive. The old classifier matched
 * `/too large|maxbytes|exceed/` on the message text, and the redirect error reads
 * "Redirect limit 5 exceeded" — so a redirect loop was reported as
 * `response-too-large`, a timeout as the same, and a 2xx whose content-type was
 * rejected as `unknown-error`. Every one of those was a category for a cause we
 * had actually identified.
 *
 * `content-type-not-allowed` deserves its own note: the egress layer applies the
 * allow-list to **2xx only**, so a `200 text/html` (the classic "not a manifest"
 * case) arrives here as this code and must become `unsupported-format` — not a
 * generic error, and never `healthy`.
 */
const EGRESS_CODE_CATEGORY: Readonly<Record<string, FailureCategory>> = {
  timeout: 'timeout',
  'dns-failure': 'dns-failure',
  'tls-failure': 'tls-failure',
  'connection-failed': 'connection-refused',
  // Every refusal to reach a destination is one SSRF/policy outcome to the
  // health ledger: the operator needs "we did not connect", not the sub-reason.
  'private-address': 'ssrf-blocked',
  'dns-rebind': 'ssrf-blocked',
  'host-blocked': 'ssrf-blocked',
  'scheme-not-allowed': 'ssrf-blocked',
  'invalid-url': 'ssrf-blocked',
  'credential-in-url': 'ssrf-blocked',
  'redirect-unsafe': 'redirect-unsafe',
  'too-many-redirects': 'redirect-unsafe',
  'response-too-large': 'response-too-large',
  'content-type-not-allowed': 'unsupported-format',
};

/** A string `code` on the thrown value, when it carries one. */
function egressCodeOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.length > 0 ? code : null;
}

/**
 * Classifies a transport-layer throw.
 *
 * **Structured code first.** When the error carries a string `code` (an
 * `EgressFailure`, or anything shaped like one) that code decides. An unknown
 * code is `unknown-error` and is deliberately *not* passed to the message
 * fallback: a code we do not recognise means the contract moved, and guessing
 * from prose on top of that would hide it.
 *
 * **Message matching is a best-effort fallback** for errors that carry no code at
 * all — a plain `Error` from a custom `egress` implementation, a Node system
 * error wrapping something else. It is documented as best-effort precisely
 * because it is not a contract; no finding here should ever be read as stronger
 * than the code path.
 */
export function transportCategory(error: unknown): FailureCategory {
  const code = egressCodeOf(error);
  if (code !== null) return EGRESS_CODE_CATEGORY[code] ?? 'unknown-error';
  return transportCategoryFromMessage(messageOf(error).toLowerCase());
}

/** Best-effort classification for errors with no structured code. */
function transportCategoryFromMessage(message: string): FailureCategory {
  if (/timeout|timed out|abort/.test(message)) return 'timeout';
  if (/too large|maxbytes|exceed/.test(message)) return 'response-too-large';
  if (/tls|certificate|ssl/.test(message)) return 'tls-failure';
  if (/econnrefused|connection refused/.test(message)) return 'connection-refused';
  if (/enotfound|getaddrinfo|dns/.test(message)) return 'dns-failure';
  if (/redirect/.test(message)) return 'redirect-unsafe';
  if (/blocked|private|loopback|reserved/.test(message)) return 'ssrf-blocked';
  return 'unknown-error';
}

function failure(category: FailureCategory, depth: ValidationDepth, message: string): FailureDetail {
  return { category, cause: FAILURE_CAUSE[category], message, depth };
}

function evidenceOf(probe: {
  httpStatus: number | null;
  contentType: string | null;
  bytes: number | null;
  sampleSha256: string | null;
  urls: string[];
  segmentStatuses: number[];
  manifest: ManifestFactsSummary | null;
  latencyMs: number | null;
  samplesRequested: number;
  samplesAttempted: number;
}): BoundedEvidence {
  return {
    httpStatus: probe.httpStatus,
    contentType: probe.contentType,
    bytes: probe.bytes,
    sampleSha256: probe.sampleSha256,
    urls: [...probe.urls],
    segmentStatuses: [...probe.segmentStatuses],
    manifest: probe.manifest,
    latencyMs: probe.latencyMs,
    samplesRequested: probe.samplesRequested,
    samplesAttempted: probe.samplesAttempted,
  };
}

interface FinishInput {
  readonly outcome: CheckOutcomeCode;
  readonly depth: ValidationDepth;
  readonly evidence: BoundedEvidence;
  readonly failure: FailureDetail | null;
  readonly uncertainty: Uncertainty;
  readonly eligibilityAt: EligibilitySnapshot;
}

function finish(input: FinishInput): ValidationResult {
  return {
    outcome: input.outcome,
    cause: input.failure === null ? null : input.failure.cause,
    depthReached: input.depth,
    evidence: input.evidence,
    failure: input.failure,
    uncertainty: input.uncertainty,
    eligibilityAt: input.eligibilityAt,
  };
}

function snapshotOf(decision: ReturnType<typeof decideSourceEligibility>, at: Date): EligibilitySnapshot {
  const inner: EligibilityDecision = decision.eligibility;
  return {
    playable: decision.playable,
    verdict: inner.verdict,
    reason: inner.eligible ? null : inner.reason,
    publicationReason: decision.playable ? null : decision.publicationReason,
    authorizationReason: decision.playable ? null : decision.authorizationReason,
    at,
  };
}

/** Export shape used by the scheduler when building the check row's `origin`. */
export function defaultOrigin(policy: string, region: string | null = null): {
  egressHost: string;
  region: string | null;
  userAgent: string;
  policy: string;
} {
  return {
    egressHost: safeHostname(),
    region,
    userAgent: DEFAULT_USER_AGENT,
    policy,
  };
}

function safeHostname(): string {
  try {
    return osHostname();
  } catch {
    return 'unknown';
  }
}

/** Kept for callers that need to know whether a type is network-probed at all. */
export function isNetworkProbedType(type: string): boolean {
  return NETWORK_PROBED_TYPES.has(type);
}

/** Bound on how many URLs a row may record, so evidence stays bounded. */
export const MAX_EVIDENCE_URLS = 8;
