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
import {
  isDashMime,
  isHlsMime,
  manifestContentTypeAllowList,
  parseManifest,
  samplePlaylistUris,
} from './manifest.js';

export type { ValidationDepth } from './health.schema.js';

/**
 * Evidence plus the master-descent trail.
 *
 * The trail lives here, in the module that produces it, rather than widening
 * `BoundedEvidence` in `health.schema.ts`: it is additive and optional, so any
 * consumer typed against `BoundedEvidence` still accepts it, and the shape the
 * ledger persists is untouched.
 */
export interface BoundedEvidenceWithPath extends BoundedEvidence {
  /** The variant actually followed from a master (redacted); null for media playlists. */
  readonly followedVariant?: string | null;
  /** HTTP status of that variant fetch; 0 when it threw before a status existed. */
  readonly variantStatus?: number | null;
  /**
   * Total bytes the segment probes actually transferred. Bounded by
   * `SEGMENT_PROBE_BYTES` per sampled segment, never the whole segment — this is
   * the number that proves the bandwidth discipline held.
   */
  readonly segmentBytesRead?: number;
}

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
  /**
   * Read at most this many bytes and stop, regardless of how large the resource
   * declares itself to be. This is what turns the sampling budget into a real
   * *transfer* bound: `maxBytes` still decides `response-too-large` for a
   * genuinely oversized resource, while `prefixBytes` caps what we are willing to
   * read and keep. Must be ≤ `maxBytes`.
   */
  readonly prefixBytes?: number;
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
  readonly evidence: BoundedEvidenceWithPath;
  readonly failure: FailureDetail | null;
  readonly uncertainty: Uncertainty;
  readonly eligibilityAt: EligibilitySnapshot;
}

export const DEFAULT_SEGMENT_SAMPLE = 2;
/**
 * How many variants of a master playlist are followed. One is the default and
 * one level is the *only* depth: a variant that is itself a master is recorded
 * as `nested-master-not-followed` and never fetched again. This is the ceiling
 * that stops a hostile nested-master chain from multiplying requests.
 */
export const MAX_VARIANT_FOLLOW = 1;
export const SEGMENT_TIMEOUT_MS = 8_000;
export const MANIFEST_TIMEOUT_MS = 15_000;
export const MANIFEST_MAX_BYTES = 2 * 1024 * 1024;
/**
 * The three budgets of contract §2 are three different numbers, and conflating
 * any two of them produced a policy-induced wrong answer — twice:
 *
 * 1. First, the 64 KiB *sampled-probe* budget was used as the whole-GET budget, so
 *    every real HD segment looked oversized and a healthy stream was reported as
 *    `missing-segments`.
 * 2. Then 512 KiB was still used as the whole-GET budget, and a *measured* real
 *    HLS segment is ~1.8 MiB (1 915 156 bytes), so live sources reported
 *    `response-too-large` instead.
 *
 * The numbers, each doing exactly one job:
 *
 * - `MANIFEST_MAX_BYTES` (2 MiB): the whole manifest. Fetched in full.
 * - `SEGMENT_MAX_BYTES` (4 MiB): a **declared-length sanity tolerance only** — the
 *   value the egress layer compares against a segment's declared `content-length`
 *   when one is visible. It is NOT a bandwidth budget and, since the prefix read
 *   landed, it is NOT a guarantee that an oversized segment is refused: prefix
 *   mode deliberately skips the declared-length pre-check (that skip is what lets
 *   a 1.8 MiB segment be sampled at all), and the 64 KiB cap is checked first, so
 *   a very large segment that streams successfully is reported healthy *because
 *   we only sample it*. This is the captain's ruling (option a), recorded in
 *   `DOCUMENTED CONSEQUENCE` in the unit spec: the health verdict means the
 *   manifest, the variant and sampled segments are retrievable and of the right
 *   kind — it does not mean "any size is acceptable". Total transfer stays
 *   bounded by `SEGMENT_PROBE_BYTES`. 4 MiB is chosen because real HD HLS
 *   segments measure ~1.8 MiB. Changing this is a contract-bound change and was
 *   authorised by the captain.
 * - `SEGMENT_PROBE_BYTES` (64 KiB): the **sampling** budget — how much we are
 *   willing to read and keep per sampled segment, regardless of its size.
 */
export const SEGMENT_MAX_BYTES = 4 * 1024 * 1024;
export const SEGMENT_PROBE_BYTES = 64 * 1024;
/** A HEAD that does not answer in this long is not worth a GET. */
export const SEGMENT_HEAD_TIMEOUT_MS = 5_000;
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
    /** Bytes actually transferred by segment probes; each is bounded by SEGMENT_PROBE_BYTES. */
    segmentBytesRead: 0,
    /** The variant actually followed from a master, redacted. Null for media playlists. */
    followedVariant: null as string | null,
    /** HTTP status of that variant fetch; 0 when it threw before a status existed. */
    variantStatus: null as number | null,
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
  /** The format the source declares; the allow-list and the check both use it. */
  const declared: 'hls' | 'dash' = source.type === 'dash' ? 'dash' : 'hls';
  let response: EgressResponse;
  try {
    response = await request.egress({
      url: initial.toString(),
      method: 'GET',
      timeoutMs: MANIFEST_TIMEOUT_MS,
      maxBytes: MANIFEST_MAX_BYTES,
      // Derived from the manifest MIME sets: the request must accept exactly what
      // the parser will accept, or a good stream dies before it is parsed.
      allowedContentPrefixes: manifestContentTypeAllowList(declared),
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
  /*
   * Variant resolution is NOT limited by the segment sample size: a master that
   * resolves no variant is a broken manifest, while `segmentSample: 0` only means
   * "do not fetch segments". Tying the two together would report a valid master
   * as `invalid-manifest` whenever segment sampling was disabled.
   */
  const variants = samplePlaylistUris(response.body ?? '', baseUrl, MAX_VARIANT_FOLLOW).variants;

  if (parsed.facts.format === 'hls-master') {
    if (variants.length === 0) {
      return finish({
        outcome: 'failing',
        depth: 'playlist',
        evidence: evidenceOf(probe),
        failure: failure('invalid-manifest', 'playlist', 'Master playlist declares variants but none resolved.'),
        uncertainty,
        eligibilityAt,
      });
    }

    /*
     * A master playlist carries no segments of its own: it names other playlists.
     * Without following one, layer 5 is unreachable for the shape nearly every
     * emitter publishes, and a master whose variant is 404 would be reported as a
     * bare `degraded` — the very hole this descent closes.
     */
    if (segmentSample === 0) {
      // Nothing may be sampled at all, so the variant fetch would prove nothing.
      return finish({
        outcome: 'degraded',
        depth: 'playlist',
        evidence: evidenceOf(probe),
        failure: null,
        uncertainty: markSegmentsNotSampled(uncertainty, 'segment-sample-size-zero'),
        eligibilityAt,
      });
    }

    // Bounded descent: at most MAX_VARIANT_FOLLOW variants, never recursive.
    const variantUrl = variants[0];
    if (variantUrl === undefined) {
      return finish({
        outcome: 'failing',
        depth: 'playlist',
        evidence: evidenceOf(probe),
        failure: failure('invalid-manifest', 'playlist', 'Master playlist variant did not resolve to a URL.'),
        uncertainty,
        eligibilityAt,
      });
    }
    probe.followedVariant = redactCredentials(variantUrl, true);
    probe.urls.push(probe.followedVariant);

    let variantResponse: EgressResponse;
    try {
      variantResponse = await request.egress({
        url: variantUrl,
        method: 'GET',
        timeoutMs: MANIFEST_TIMEOUT_MS,
        maxBytes: MANIFEST_MAX_BYTES,
        // Same derivation as the master fetch: a variant is parsed as HLS, so it
        // must be accepted with exactly the types the HLS parser accepts.
        allowedContentPrefixes: manifestContentTypeAllowList('hls'),
      });
    } catch (error) {
      const category = transportCategory(error);
      probe.variantStatus = 0;
      return finish({
        outcome: 'failing',
        depth: 'playlist',
        evidence: evidenceOf(probe),
        failure: failure(category, 'playlist', `Variant fetch failed: ${messageOf(error)}`),
        uncertainty,
        eligibilityAt,
      });
    }
    probe.variantStatus = variantResponse.status;

    if (!variantResponse.ok) {
      // The Akamai shape: master 200, variant 404. Name the variant failure.
      const category = statusCategory(variantResponse.status);
      return finish({
        outcome: 'failing',
        depth: 'playlist',
        evidence: evidenceOf(probe),
        failure: failure(
          category === 'http-401' || category === 'http-403' ? 'segments-forbidden' : 'missing-segments',
          'playlist',
          `Master variant answered HTTP ${variantResponse.status}: the manifest names a playlist that does not serve.`,
        ),
        uncertainty,
        eligibilityAt,
      });
    }

    const variantParsed = parseManifest(variantResponse.body ?? '', variantResponse.contentType, { expected: 'hls' });
    if (!variantParsed.ok) {
      return finish({
        outcome: 'failing',
        depth: 'manifest',
        evidence: evidenceOf(probe),
        failure: failure(variantParsed.reason, 'manifest', `Followed variant: ${variantParsed.detail}`),
        uncertainty,
        eligibilityAt,
      });
    }
    if (variantParsed.facts.format === 'hls-master') {
      // One level only. Recorded, never followed: recursion is the attack.
      return finish({
        outcome: 'degraded',
        depth: 'playlist',
        evidence: evidenceOf(probe),
        failure: null,
        uncertainty: markSegmentsNotSampled(uncertainty, 'nested-master-not-followed'),
        eligibilityAt,
      });
    }
    if (variantParsed.truncated) uncertainty.manifestTruncated = true;

    const variantSegments = samplePlaylistUris(variantResponse.body ?? '', variantResponse.finalUrl, segmentSample)
      .segments;
    if (variantSegments.length === 0) {
      return finish({
        outcome: 'failing',
        depth: 'playlist',
        evidence: evidenceOf(probe),
        failure: failure('invalid-manifest', 'playlist', 'Followed variant declares segments but none resolved.'),
        uncertainty,
        eligibilityAt,
      });
    }
    return finish(await sampleSegments(variantSegments));
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

  return finish(await sampleSegments(sampled.segments));

  /**
   * Layer 5 sampling, shared by the media-playlist path and the followed variant
   * so both produce identical evidence and categories.
   */
  async function sampleSegments(segmentUrls: readonly string[]): Promise<FinishInput> {
    let segmentsOk = 0;
    /**
     * The first *classified* probe failure, kept with its own truth value so a
     * refusal keeps its real category instead of being flattened.
     */
    let firstFailure: Extract<SegmentProbeResult, { ok: false }> | null = null;
    for (const segmentUrl of segmentUrls) {
      probe.urls.push(redactCredentials(segmentUrl, true));
      probe.samplesAttempted += 1;
      const outcome = await probeSegment(request.egress, segmentUrl);
      probe.segmentStatuses.push(outcome.status);
      probe.segmentBytesRead += outcome.bytesRead;
      if (outcome.ok) segmentsOk += 1;
      else if (firstFailure === null) firstFailure = outcome;
    }

    if (firstFailure !== null) {
      const category = segmentFailureCategory(firstFailure);
      return {
        outcome: 'failing',
        depth: 'playlist',
        evidence: evidenceOf(probe),
        failure: failure(
          category,
          'playlist',
          `${firstFailure.detail} Sampled segments: ${segmentsOk}/${probe.samplesAttempted} answered 2xx.`,
        ),
        uncertainty,
        eligibilityAt,
      };
    }

    // ── Layer 6: injected browser reproduction ────────────────────────────
    const browser = request.browser ?? null;
    if (browser === null) {
      const marked = { ...uncertainty, notes: [...uncertainty.notes] };
      marked.browserNotProbed = true;
      return {
        outcome: 'healthy',
        depth: 'segments',
        evidence: evidenceOf(probe),
        failure: null,
        uncertainty: marked,
        eligibilityAt,
      };
    }

    if (!browser.reproduced) {
      const category: FailureCategory = browser.failure ?? 'browser-incompatible';
      return {
        outcome: 'degraded',
        depth: 'browser',
        evidence: evidenceOf(probe),
        failure: failure(category, 'browser', browser.note ?? 'Browser did not reproduce the stream.'),
        uncertainty,
        eligibilityAt,
      };
    }

    return {
      outcome: 'healthy',
      depth: 'browser',
      evidence: evidenceOf(probe),
      failure: null,
      uncertainty,
      eligibilityAt,
    };
  }
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

/** What one sampled segment proved, and why it did not when it did not. */
type SegmentProbeResult =
  | {
      readonly ok: true;
      /** HTTP status observed. */
      readonly status: number;
      /** Bytes actually transferred by this probe — never a whole multi-MB segment. */
      readonly bytesRead: number;
      readonly detail: string;
    }
  | {
      readonly ok: false;
      readonly status: number;
      readonly bytesRead: number;
      /** Truthful category: size, absent and forbidden stay distinct. */
      readonly category: FailureCategory;
      readonly detail: string;
    };

/**
 * The category for a failed segment probe.
 *
 * Truthfulness rule: a *size* refusal keeps `response-too-large`, an absent
 * segment is `missing-segments`, a forbidden one is `segments-forbidden`. The
 * old code collapsed everything that was not 401/403 into `missing-segments`,
 * which is how a size-budget defect got reported as "the segment is missing" —
 * blaming the content for a policy decision.
 */
function segmentFailureCategory(failureResult: Extract<SegmentProbeResult, { ok: false }>): FailureCategory {
  if (failureResult.category === 'response-too-large') return 'response-too-large';
  if (failureResult.category === 'http-401' || failureResult.category === 'http-403') return 'segments-forbidden';
  return 'missing-segments';
}

/**
 * Probes one segment without ever holding a whole one.
 *
 * The shape, and why each step is there:
 *
 * 1. **HEAD first.** The cheapest question — does this exist? A 404 costs no body
 *    at all. On these CDNs a HEAD reports no `content-length`, so it can only
 *    answer existence; the declared length stays UNKNOWN here rather than being
 *    read as "0 bytes, it fits".
 * 2. **Bounded prefix GET.** The probe then reads at most
 *    `SEGMENT_PROBE_BYTES` (the contract's per-sampled-segment budget) and
 *    releases the socket. `maxBytes` carries `SEGMENT_MAX_BYTES` as a
 *    declared-length tolerance; the prefix cap, not the tolerance, is what bounds
 *    the transfer.
 * 3. **Reaching the cap is success, not a failure.** A segment longer than our
 *    sample is the normal case; it was proved retrievable, which is all sampling
 *    asserts. Only a *declared* length above the tolerance, or a non-2xx answer,
 *    produces a failure.
 */
async function probeSegment(
  egress: EgressFn,
  segmentUrl: string,
): Promise<SegmentProbeResult> {
  /*
   * 1. HEAD: does it exist, and did it declare a size?
   *
   * `declaredBytes` stays `null` when the origin declares nothing (or reports 0),
   * and **null means UNKNOWN — never "it fits"**. This is a measured real-world
   * case: the Akamai/Apple CDNs answer HEAD with `200`, `application/octet-stream`
   * and NO `content-length`, while the GET of the same segment declares ~1.8 MiB.
   * Treating "0" as authoritative would either short-circuit the size decision
   * (a lie in the unsafe direction) or make the probe declare success it never
   * checked. So an unknown size simply defers the ceiling to the GET, where the
   * declared length IS visible to the egress layer.
   */
  let declaredBytes: number | null = null;
  try {
    const head = await egress({
      url: segmentUrl,
      method: 'HEAD',
      timeoutMs: SEGMENT_HEAD_TIMEOUT_MS,
      maxBytes: Number.MAX_SAFE_INTEGER,
    });
    if (!head.ok) {
      const category = statusCategory(head.status);
      return {
        ok: false,
        status: head.status,
        bytesRead: 0,
        category,
        detail: `Segment HEAD answered HTTP ${head.status}.`,
      };
    }
    /*
     * The seam reports `bytes` as the *body* received, which is 0 for any HEAD,
     * and exposes no header map — so a HEAD can only ever tell us "it exists".
     * `head.bytes` is therefore not a size signal here; it is left as UNKNOWN on
     * purpose rather than being read as "0 bytes, fits".
     */
    declaredBytes = null;
  } catch (error) {
    // A server may refuse HEAD (405) while serving GET fine. That is not a
    // segment failure: fall through to the prefix read, which is the real test.
    if (!isHeadUnsupported(error)) {
      const category = transportCategory(error);
      return {
        ok: false,
        status: 0,
        bytesRead: 0,
        category,
        detail: `Segment HEAD failed: ${messageOf(error)}`,
      };
    }
  }

  // The whole-segment ceiling, applied to the size the origin declared.
  if (declaredBytes !== null && declaredBytes > SEGMENT_MAX_BYTES) {
    return {
      ok: false,
      status: 200,
      bytesRead: 0,
      category: 'response-too-large',
      detail: `Segment declares ${declaredBytes} bytes, above the ${SEGMENT_MAX_BYTES}-byte segment ceiling.`,
    };
  }

  /*
   * 2. The GET carries BOTH budgets, each doing its own job.
   *
   * - `maxBytes = SEGMENT_MAX_BYTES` is the *vetting* limit: the egress layer
   *   refuses a resource whose declared `content-length` exceeds it, which is the
   *   truthful `response-too-large` verdict about the origin's segment.
   * - `prefixBytes = SEGMENT_PROBE_BYTES` is the *transfer* limit: the read stops
   *   at 64 KiB and the socket is released. Without it, `maxBytes` alone would let
   *   a sampled 1.8 MiB segment transfer 1.8 MiB — bandwidth the contract §4 says
   *   we must not spend. Using the probe budget as `maxBytes` instead would make
   *   every real segment look oversized, which was the earlier defect.
   *
   * So the ceiling decides *whether* a segment is acceptable and the prefix
   * decides *how much of it we actually pay for*.
   */
  try {
    const got = await egress({
      url: segmentUrl,
      method: 'GET',
      timeoutMs: SEGMENT_TIMEOUT_MS,
      maxBytes: SEGMENT_MAX_BYTES,
      prefixBytes: SEGMENT_PROBE_BYTES,
    });
    const bytesRead = Math.min(got.bytes, SEGMENT_PROBE_BYTES);
    if (!got.ok) {
      const category = statusCategory(got.status);
      return {
        ok: false,
        status: got.status,
        bytesRead,
        category,
        detail: `Segment answered HTTP ${got.status}.`,
      };
    }
    return { ok: true, status: got.status, bytesRead, detail: 'prefix read 2xx' };
  } catch (error) {
    const category = transportCategory(error);
    if (category === 'response-too-large') {
      /*
       * A declared length above `SEGMENT_MAX_BYTES` — but only on a path where the
       * egress layer still applies that pre-check. In prefix mode the declared
       * pre-check is skipped by design and the 64 KiB cap ends the read first, so
       * the common outcome for a large-but-real segment is success, not this
       * branch. Kept so a caller without a prefix cap (or with one above the
       * declared length) still gets the truthful `response-too-large`.
       */
      return {
        ok: false,
        status: 200,
        bytesRead: 0,
        category: 'response-too-large',
        detail: `Segment exceeds the ${SEGMENT_MAX_BYTES}-byte segment ceiling (declare or stream).`,
      };
    }
    return {
      ok: false,
      status: 0,
      bytesRead: 0,
      category,
      detail: `Segment prefix read failed: ${messageOf(error)}`,
    };
  }
}

/** A HEAD the origin does not implement must not fail the segment. */
function isHeadUnsupported(error: unknown): boolean {
  const code = egressCodeOf(error);
  if (code !== null) {
    // The egress layer reports a non-2xx HEAD as a response, not a throw; a
    // thrown code here is a transport problem, except for method refusals.
    return false;
  }
  return /method not allowed|not implemented|501|405/i.test(messageOf(error));
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
  followedVariant: string | null;
  variantStatus: number | null;
  segmentBytesRead: number;
}): BoundedEvidenceWithPath {
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
    followedVariant: probe.followedVariant,
    variantStatus: probe.variantStatus,
    segmentBytesRead: probe.segmentBytesRead,
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
