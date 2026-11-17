/**
 * The layered validation engine: two-sided, and adversarial about the one thing
 * that matters most in this milestone.
 *
 * The central negative test is the one a naive implementation fails:
 * `HTTP 200 is not health`. A stream can answer 200 with a valid HLS
 * content-type and still be unusable (HTML body, empty playlist, forbidden
 * segments). Each of those must stop at the layer that found the problem, and
 * none of them may ever be reported `healthy`.
 *
 * The other central test is the ordering one: eligibility runs **before** egress,
 * proven with a spy, because a socket opened for an unauthorised source would be
 * a rights violation and not a bug.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { PlaybackSourceDoc } from '../infrastructure/schema.js';
import type { AuthorizationRecord } from '../modules/providers/authorization.js';
import { createDefaultAdapterRegistry } from '../modules/providers/adapter.registry.js';
import {
  FAILURE_CATEGORIES,
  FAILURE_CAUSE,
  isFailureCategory,
  isRetryable,
  type FailureCategory,
} from './failures.js';
import { HEALTH_COLLECTIONS, isTerminalCheckState, type FailureCause } from './health.schema.js';
import {
  DASH_MIME_TYPES,
  HLS_MIME_TYPES,
  MAX_MANIFEST_PARSE_BYTES,
  manifestContentTypeAllowList,
  parseManifest,
  samplePlaylistUris,
} from './manifest.js';
import {
  runValidation,
  SEGMENT_MAX_BYTES,
  SEGMENT_PROBE_BYTES,
  statusCategory,
  transportCategory,
  type BrowserProbeResult,
  type EgressFn,
  type EgressRequest,
  type EgressResponse,
  type ValidationResult,
} from './validator.js';
import { EgressFailure, safeFetch } from '../infrastructure/safe-egress.js';
import { startHttpFixture, type HttpFixture } from './fixtures/http-fixtures.js';
import { BACKOFF_MAX_MS, computeBackoff, deterministicJitterUnit, statusForOutcome } from './backoff.js';

const NOW = new Date('2026-11-17T10:00:00.000Z');
const SOURCE_URL = 'https://example.test/live/master.m3u8';

const DISCOVERY = {
  upstream: 'fixture',
  snapshotId: 'fixture-1',
  path: 'es.m3u',
  line: 1,
  sourceUrl: SOURCE_URL,
  documentUrl: null,
  retrievedAt: NOW,
};

/** A written licence we could plausibly hold: the positive side of the gate. */
function authorization(overrides: Partial<AuthorizationRecord> = {}): AuthorizationRecord {
  return {
    _id: `fixture:${SOURCE_URL}`,
    operatorId: 'fixture-operator',
    sourceUrl: SOURCE_URL,
    providerKind: 'broadcaster_cdn',
    verdict: 'permitted-direct-playback',
    basis: 'written-licence',
    quotedClause: null,
    clauseUrl: 'https://example.test/licence-agreement.pdf',
    method: 'direct-playback',
    publicationScope: 'in-app',
    territory: { allowed: [], restricted: [], worldwide: true, geoBlocked: false },
    restrictions: [],
    attribution: 'Fixture Operator',
    discovery: DISCOVERY,
    lifecycle: 'active',
    expiresAt: null,
    validationTimestamp: NOW,
    authorizationTimestamp: NOW,
    reviewStatus: 'reviewed',
    notes: null,
    ...overrides,
  };
}

function source(overrides: Partial<PlaybackSourceDoc> = {}): PlaybackSourceDoc {
  return {
    _id: 'src-1',
    channelId: 'chan-1',
    provider: 'fixture',
    type: 'hls',
    url: SOURCE_URL,
    officialPageUrl: null,
    permission: 'emitter-public-stream',
    authorisationEvidence: null,
    conditions: {
      // `technicalStatus` is deliberately `ok`: availability must never rescue a
      // missing right, and the eligibility layer must not read it as a permission.
      embedAllowed: true,
      proxyAllowed: false,
      worldwide: true,
      restrictedRegions: [],
      browserCompatibility: 'all',
      requiresForgedHeader: false,
      emitterAppOnly: false,
      notes: null,
    },
    priority: 1,
    editorialStatus: 'published',
    technicalStatus: 'ok',
    lastVerifiedAt: null,
    lastVerification: null,
    provenance: [],
    createdAt: NOW,
    updatedAt: NOW,
    revision: 1,
    ...overrides,
  };
}

const HLS_MIME = 'application/vnd.apple.mpegurl';

const MEDIA_PLAYLIST = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-TARGETDURATION:6',
  '#EXT-X-MEDIA-SEQUENCE:42',
  '#EXTINF:6.0,',
  'segment-1.ts?token=SECRET-TOKEN-1',
  '#EXTINF:6.0,',
  'segment-2.ts?token=SECRET-TOKEN-2',
  '#EXTINF:6.0,',
  'segment-3.ts?token=SECRET-TOKEN-3',
  '#EXT-X-ENDLIST',
  '',
].join('\n');

const MASTER_PLAYLIST = [
  '#EXTM3U',
  '#EXT-X-VERSION:4',
  '#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720',
  '720p/index.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360',
  '360p/index.m3u8',
  '',
].join('\n');

function response(overrides: Partial<EgressResponse> = {}): EgressResponse {
  return {
    status: 200,
    ok: true,
    contentType: HLS_MIME,
    bytes: 1024,
    body: MEDIA_PLAYLIST,
    finalUrl: SOURCE_URL,
    latencyMs: 42,
    ...overrides,
  };
}

interface EgressSpy {
  readonly fn: EgressFn;
  readonly calls: EgressRequest[];
}

/** A scripted egress: the callback decides per request, and every call is recorded. */
function scriptedEgress(handler: (req: EgressRequest) => EgressResponse) {
  const calls: EgressRequest[] = [];
  const fn = vi.fn(async (req: EgressRequest): Promise<EgressResponse> => {
    calls.push(req);
    return handler(req);
  });
  const spy: EgressSpy = { fn, calls };
  return spy;
}

/** Default: manifest as given, every segment 2xx. */
function healthyEgress(body = MEDIA_PLAYLIST, contentType = HLS_MIME) {
  return scriptedEgress((req) =>
    req.url.includes('segment-')
      ? response({ contentType: 'video/mp2t', body: null, bytes: 4096, finalUrl: req.url })
      : response({ body, contentType, finalUrl: SOURCE_URL }),
  );
}

async function validate(
  overrides: Partial<Parameters<typeof runValidation>[0]> = {},
): Promise<ValidationResult> {
  const egress = healthyEgress();
  return runValidation({
    source: source(),
    authorization: authorization(),
    registry: createDefaultAdapterRegistry(),
    egress: egress.fn,
    now: NOW,
    ...overrides,
  });
}

function codeOf(result: ValidationResult): string {
  return result.failure?.category ?? `none:${result.outcome}`;
}

describe('failure vocabulary — exactly the contract, two-sided', () => {
  const CONTRACT: readonly FailureCategory[] = [
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
  ];

  it('is exactly the 23 contract categories: no more, no fewer, no renames', () => {
    expect([...FAILURE_CATEGORIES].sort()).toEqual([...CONTRACT].sort());
    for (const category of CONTRACT) expect(isFailureCategory(category)).toBe(true);
    expect(isFailureCategory('http-418')).toBe(false);
    expect(isFailureCategory('')).toBe(false);
  });

  it('every category maps to exactly one of the six causes, and only `ineligible` is authorization', () => {
    const causes: readonly FailureCause[] = ['authorization', 'network', 'protocol', 'content', 'browser', 'policy'];
    for (const category of FAILURE_CATEGORIES) {
      const cause = FAILURE_CAUSE[category];
      expect(causes).toContain(cause);
    }
    const authorizationCategories = FAILURE_CATEGORIES.filter((c) => FAILURE_CAUSE[c] === 'authorization');
    expect(authorizationCategories).toEqual(['ineligible']);
  });

  it('retries only transient transport faults; permanents are never retried', () => {
    const retryable = FAILURE_CATEGORIES.filter(isRetryable);
    expect([...retryable].sort()).toEqual(['connection-refused', 'dns-failure', 'http-5xx', 'timeout', 'tls-failure']);

    for (const never of [
      'http-404',
      'http-403',
      'http-401',
      'http-451',
      'georestriction',
      'ineligible',
      'invalid-manifest',
      'unsupported-format',
      'missing-segments',
      'segments-forbidden',
      'browser-incompatible',
      'codec-failure',
      'cors-limitation',
      'ssrf-blocked',
      'redirect-unsafe',
      'response-too-large',
      'expired-source',
      'unknown-error',
    ] as const) {
      expect(isRetryable(never)).toBe(false);
    }
  });

  it('names collections per contract §1 and never reuses the legacy source_health', () => {
    expect(HEALTH_COLLECTIONS).toEqual({
      checks: 'source_health_checks_02d',
      health: 'source_health_02d',
      policies: 'verification_policies_02d',
    });
    expect(Object.values(HEALTH_COLLECTIONS)).not.toContain('source_health');
  });

  it('terminal states are done/failed/skipped only', () => {
    expect(isTerminalCheckState('done')).toBe(true);
    expect(isTerminalCheckState('failed')).toBe(true);
    expect(isTerminalCheckState('skipped')).toBe(true);
    expect(isTerminalCheckState('running')).toBe(false);
    expect(isTerminalCheckState('pending')).toBe(false);
  });
});

describe('manifest parser — structured facts only', () => {
  it('POSITIVE: a media playlist becomes counts and a 4 KiB digest, never text', () => {
    const parsed = parseManifest(MEDIA_PLAYLIST, HLS_MIME, { expected: 'hls' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.facts.format).toBe('hls-media');
    expect(parsed.facts.startsWithExtM3u).toBe(true);
    expect(parsed.facts.segmentCount).toBe(3);
    expect(parsed.facts.variantCount).toBe(0);
    expect(parsed.facts.mediaSequence).toBe(42);
    expect(parsed.facts.targetDuration).toBe(6);
    expect(parsed.facts.endsWithEndList).toBe(true);
    expect(parsed.facts.first4KiBSha256).toMatch(/^[0-9a-f]{64}$/);
    // Nothing in the returned facts can carry playlist text or a token.
    expect(JSON.stringify(parsed.facts)).not.toMatch(/SECRET-TOKEN|segment-1|EXTINF/);
  });

  it('POSITIVE: a master playlist is recognised as master with its variant count', () => {
    const parsed = parseManifest(MASTER_PLAYLIST, HLS_MIME, { expected: 'hls' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.facts.format).toBe('hls-master');
    expect(parsed.facts.variantCount).toBe(2);
    expect(parsed.facts.segmentCount).toBe(0);
  });

  it('NEGATIVE: an HTML body with an HLS MIME is `invalid-manifest`, not a manifest', () => {
    const parsed = parseManifest('<!doctype html><html><body>Access denied</body></html>', HLS_MIME, { expected: 'hls' });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toBe('invalid-manifest');
  });

  it('NEGATIVE: a body with no HLS MIME and no header is `unsupported-format`', () => {
    const parsed = parseManifest('{"stream":"x"}', 'application/json', { expected: 'hls' });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toBe('unsupported-format');
  });

  it('NEGATIVE: header only (empty playlist) is `invalid-manifest`', () => {
    const parsed = parseManifest('#EXTM3U\n#EXT-X-VERSION:3\n', HLS_MIME, { expected: 'hls' });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toBe('invalid-manifest');
    expect(parsed.detail).toMatch(/no #EXT-X-STREAM-INF/);
  });

  it('BOUND: never parses more than 200 KiB and says it truncated', () => {
    const huge = `#EXTM3U\n#EXT-X-TARGETDURATION:6\n${'#EXTINF:6.0,\nseg.ts\n'.repeat(40_000)}`;
    expect(Buffer.byteLength(huge)).toBeGreaterThan(MAX_MANIFEST_PARSE_BYTES);
    const parsed = parseManifest(huge, HLS_MIME, { expected: 'hls' });
    expect(parsed.truncated).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.facts.parsedBytes).toBe(MAX_MANIFEST_PARSE_BYTES);
  });

  it('DASH: a real MPD passes, an MPD without a Period does not', () => {
    const ok = parseManifest(
      '<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011"><Period id="p0"/></MPD>',
      'application/dash+xml',
      { expected: 'dash' },
    );
    expect(ok.ok).toBe(true);
    const bad = parseManifest('<?xml version="1.0"?><MPD></MPD>', 'application/dash+xml', { expected: 'dash' });
    expect(bad.ok).toBe(false);
  });

  it('sampling resolves relative URIs and never follows a non-http scheme', () => {
    const sampled = samplePlaylistUris(
      '#EXTM3U\n#EXTINF:6,\nseg-1.ts\n#EXTINF:6,\ndata:text/plain,evil\n#EXTINF:6,\nseg-3.ts\n',
      'https://example.test/live/index.m3u8',
      5,
    );
    expect(sampled.segments).toEqual([
      'https://example.test/live/seg-1.ts',
      'https://example.test/live/seg-3.ts',
    ]);
  });
});

describe('validator — layer 1 runs before any network call (spy)', () => {
  it('CENTRAL: an ineligible source never calls egress, not once', async () => {
    const spy = healthyEgress();
    const result = await validate({
      source: source({ permission: 'unlicensed' as PlaybackSourceDoc['permission'] }),
      authorization: authorization(),
      egress: spy.fn,
    });
    expect(spy.fn).not.toHaveBeenCalled();
    expect(spy.calls).toHaveLength(0);
    expect(result.outcome).toBe('ineligible');
    expect(result.cause).toBe('authorization');
    expect(result.depthReached).toBe('eligibility');
    expect(result.failure?.category).toBe('ineligible');
  });

  it('a source with no authorisation record is refused before egress (and 200 cannot rescue it)', async () => {
    const spy = healthyEgress();
    const result = await validate({ authorization: null, egress: spy.fn, source: source({ technicalStatus: 'ok' }) });
    expect(spy.fn).not.toHaveBeenCalled();
    expect(result.outcome).toBe('ineligible');
    expect(result.eligibilityAt.playable).toBe(false);
    expect(result.eligibilityAt.reason).toBe('no-authorization-record');
  });

  it('an expired right is refused before egress', async () => {
    const spy = healthyEgress();
    const result = await validate({
      authorization: authorization({ expiresAt: new Date('2026-11-01T00:00:00.000Z') }),
      egress: spy.fn,
    });
    expect(spy.fn).not.toHaveBeenCalled();
    expect(result.failure?.category).toBe('ineligible');
  });

  it('a URL carrying userinfo is refused without being used or stored', async () => {
    const spy = healthyEgress();
    const withCreds = 'https://user:pass@example.test/live/master.m3u8';
    const result = await validate({ source: source({ url: withCreds }), egress: spy.fn });
    expect(spy.fn).not.toHaveBeenCalled();
    expect(result.failure?.category).toBe('ineligible');
    expect(JSON.stringify(result.evidence)).not.toMatch(/pass@|user:/);
  });
});

describe('validator — the positive path', () => {
  it('POSITIVE: a valid live HLS media playlist with 2xx segments is healthy at depth `segments`', async () => {
    const spy = healthyEgress();
    const result = await validate({ egress: spy.fn });
    expect(result.outcome).toBe('healthy');
    expect(result.cause).toBeNull();
    expect(result.failure).toBeNull();
    expect(result.depthReached).toBe('segments');
    expect(result.uncertainty.browserNotProbed).toBe(true);
    expect(result.evidence.httpStatus).toBe(200);
    expect(result.evidence.sampleSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.evidence.manifest?.segmentCount).toBe(3);
    // Default sample size is 2 (§4), and the manifest itself is the first call.
    expect(result.evidence.samplesAttempted).toBe(2);
    expect(result.evidence.segmentStatuses).toEqual([200, 200]);
    // Manifest + (HEAD, prefix GET) per sampled segment: 1 + 2×2.
    expect(spy.calls).toHaveLength(5);
    expect(result.eligibilityAt.playable).toBe(true);
  });

  it('POSITIVE: tokenized segment URLs are redacted in the evidence', async () => {
    const result = await validate();
    const urls = result.evidence.urls.join(' ');
    expect(urls).not.toMatch(/SECRET-TOKEN/);
    expect(urls).toMatch(/segment-1\.ts/);
  });

  it('POSITIVE: a DASH MPD is recognised', async () => {
    const spy = scriptedEgress(() =>
      response({
        contentType: 'application/dash+xml',
        body: '<?xml version="1.0"?><MPD><Period id="p0"/></MPD>',
      }),
    );
    const result = await validate({ source: source({ type: 'dash' }), egress: spy.fn });
    expect(result.evidence.manifest?.format).toBe('dash');
    // An MPD resolves no segment URIs here, so segments are declared unobserved
    // rather than sampled: a 200 with a valid MPD is never `healthy` on its own.
    expect(result.depthReached).toBe('manifest');
    expect(result.outcome).toBe('degraded');
    expect(result.uncertainty.segmentsNotSampled).toBe(true);
  });
});

describe('validator — HTTP 200 is NOT health (central negatives)', () => {
  it('CENTRAL: 200 + valid HLS content-type + HTML body is `invalid-manifest`, never healthy', async () => {
    const spy = scriptedEgress(() => response({ body: '<!doctype html><html>geo blocked</html>' }));
    const result = await validate({ egress: spy.fn });
    expect(result.outcome).toBe('failing');
    expect(result.depthReached).toBe('manifest');
    expect(result.failure?.category).toBe('invalid-manifest');
    expect(result.cause).toBe('content');
  });

  it('CENTRAL: 200 + `#EXTM3U` header and no segments is `invalid-manifest`, never healthy', async () => {
    const spy = scriptedEgress(() => response({ body: '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n' }));
    const result = await validate({ egress: spy.fn });
    expect(result.outcome).toBe('failing');
    expect(result.depthReached).toBe('manifest');
    expect(result.failure?.category).toBe('invalid-manifest');
  });

  it('CENTRAL: 200 with the wrong content-type stops at `transport` as `unsupported-format`', async () => {
    const spy = scriptedEgress(() => response({ contentType: 'text/html; charset=utf-8' }));
    const result = await validate({ egress: spy.fn });
    expect(result.outcome).toBe('failing');
    expect(result.depthReached).toBe('transport');
    expect(result.failure?.category).toBe('unsupported-format');
    // A 200 whose type is wrong must not even read the body as a manifest.
    expect(spy.calls).toHaveLength(1);
  });

  it('CENTRAL: segmentSample=0 cannot produce healthy — segments are not observed', async () => {
    const result = await validate({ segmentSample: 0 });
    expect(result.outcome).toBe('degraded');
    expect(result.depthReached).toBe('manifest');
    expect(result.uncertainty.segmentsNotSampled).toBe(true);
  });

  it('HONEST UNKNOWN: a master whose followed variant is itself a master is degraded, not healthy', async () => {
    /*
     * Formerly this fixture answered the master body for *every* URL, so the
     * descent landed on another master. That is exactly the nested case: the
     * engine must stop after one level, say so, and never recurse.
     */
    const spy = scriptedEgress(() => response({ body: MASTER_PLAYLIST }));
    const result = await validate({ egress: spy.fn });
    expect(result.outcome).toBe('degraded');
    expect(result.depthReached).toBe('playlist');
    expect(result.uncertainty.segmentsNotSampled).toBe(true);
    expect(result.uncertainty.notes).toContain('nested-master-not-followed');
    expect(result.evidence.manifest?.variantCount).toBe(2);
    // Exactly two requests: the master, then one variant. Never a third.
    expect(spy.calls).toHaveLength(2);
    expect(result.evidence.variantStatus).toBe(200);
  });
});

describe('validator — every failure category is reachable from real evidence', () => {
  const cases: readonly { name: string; run: () => Promise<ValidationResult>; category: FailureCategory; depth: string }[] = [
    {
      name: 'http-404',
      category: 'http-404',
      depth: 'transport',
      run: () => {
        const spy = scriptedEgress(() => response({ status: 404, ok: false, body: null }));
        return validate({ egress: spy.fn });
      },
    },
    {
      name: 'http-403',
      category: 'http-403',
      depth: 'transport',
      run: () => {
        const spy = scriptedEgress(() => response({ status: 403, ok: false, body: null }));
        return validate({ egress: spy.fn });
      },
    },
    {
      name: 'http-401',
      category: 'http-401',
      depth: 'transport',
      run: () => {
        const spy = scriptedEgress(() => response({ status: 401, ok: false, body: null }));
        return validate({ egress: spy.fn });
      },
    },
    {
      name: 'http-451',
      category: 'http-451',
      depth: 'transport',
      run: () => {
        const spy = scriptedEgress(() => response({ status: 451, ok: false, body: null }));
        return validate({ egress: spy.fn });
      },
    },
    {
      name: 'http-5xx',
      category: 'http-5xx',
      depth: 'transport',
      run: () => {
        const spy = scriptedEgress(() => response({ status: 503, ok: false, body: null }));
        return validate({ egress: spy.fn });
      },
    },
    {
      name: 'timeout',
      category: 'timeout',
      depth: 'transport',
      run: () => {
        const spy = scriptedEgress(() => {
          throw new Error('egress timeout after 15000ms');
        });
        return validate({ egress: spy.fn });
      },
    },
    {
      name: 'tls-failure',
      category: 'tls-failure',
      depth: 'transport',
      run: () => {
        const spy = scriptedEgress(() => {
          throw new Error('TLS handshake failed: certificate expired');
        });
        return validate({ egress: spy.fn });
      },
    },
    {
      name: 'connection-refused',
      category: 'connection-refused',
      depth: 'transport',
      run: () => {
        const spy = scriptedEgress(() => {
          throw new Error('connect ECONNREFUSED 203.0.113.10:443');
        });
        return validate({ egress: spy.fn });
      },
    },
    {
      name: 'dns-failure',
      category: 'dns-failure',
      depth: 'dns',
      run: async () => {
        const spy = healthyEgress();
        return validate({
          egress: spy.fn,
          dns: async () => {
            throw new Error('getaddrinfo ENOTFOUND example.test');
          },
        });
      },
    },
    {
      name: 'ssrf-blocked',
      category: 'ssrf-blocked',
      depth: 'transport',
      run: () => {
        const spy = scriptedEgress(() => {
          throw new Error('destination is private/loopback');
        });
        return validate({ egress: spy.fn });
      },
    },
    {
      name: 'redirect-unsafe',
      category: 'redirect-unsafe',
      depth: 'transport',
      run: () => {
        const spy = scriptedEgress(() => {
          throw new Error('unsafe redirect to file:///etc/passwd');
        });
        return validate({ egress: spy.fn });
      },
    },
    {
      name: 'response-too-large',
      category: 'response-too-large',
      depth: 'transport',
      run: () => {
        const spy = scriptedEgress(() => {
          throw new Error('response exceeds 2097152 byte limit');
        });
        return validate({ egress: spy.fn });
      },
    },
    {
      name: 'invalid-manifest',
      category: 'invalid-manifest',
      depth: 'manifest',
      run: () => {
        const spy = scriptedEgress(() => response({ body: '#EXTM3U\n#EXT-X-ENDLIST\n' }));
        return validate({ egress: spy.fn });
      },
    },
    {
      name: 'unsupported-format',
      category: 'unsupported-format',
      depth: 'transport',
      run: () => {
        const spy = scriptedEgress(() => response({ contentType: 'video/mp4' }));
        return validate({ egress: spy.fn });
      },
    },
    {
      name: 'missing-segments',
      category: 'missing-segments',
      depth: 'playlist',
      run: () => {
        const spy = scriptedEgress((req) =>
          req.url.includes('segment-')
            ? response({ status: 404, ok: false, contentType: 'text/plain', body: null, finalUrl: req.url })
            : response(),
        );
        return validate({ egress: spy.fn });
      },
    },
    {
      name: 'segments-forbidden',
      category: 'segments-forbidden',
      depth: 'playlist',
      run: () => {
        const spy = scriptedEgress((req) =>
          req.url.includes('segment-')
            ? response({ status: 403, ok: false, contentType: 'text/plain', body: null, finalUrl: req.url })
            : response(),
        );
        return validate({ egress: spy.fn });
      },
    },
    {
      /*
       * `georestriction` is NOT producible by this engine at all: the validator
       * never bypasses a geo block, and an operator-recorded geo restriction
       * makes the source ineligible at layer 1 (`authorization`), which is a
       * different axis. Encoded here as the negative side of the same property:
       * a geo-restricted right is refused before any request is made.
       */
      name: 'georestriction (recorded as a right restriction, refused at layer 1)',
      category: 'ineligible',
      depth: 'eligibility',
      run: () => {
        const spy = healthyEgress();
        return validate({
          authorization: authorization({
            territory: { allowed: [], restricted: ['ES'], worldwide: false, geoBlocked: true },
            restrictions: ['Geo-blocked'],
          }),
          egress: spy.fn,
        });
      },
    },
    {
      name: 'unsupported-format (no URL)',
      category: 'unsupported-format',
      depth: 'eligibility',
      run: () => {
        const spy = healthyEgress();
        return validate({ source: source({ url: null }), egress: spy.fn });
      },
    },
    {
      name: 'unknown-error',
      category: 'unknown-error',
      depth: 'transport',
      run: () => {
        const spy = scriptedEgress(() => {
          throw new Error('something entirely unexpected');
        });
        return validate({ egress: spy.fn });
      },
    },
    {
      name: 'ineligible',
      category: 'ineligible',
      depth: 'eligibility',
      run: () => {
        const spy = healthyEgress();
        return validate({
          authorization: authorization({ verdict: 'restricted', method: 'none', publicationScope: 'none', basis: 'published-terms' }),
          egress: spy.fn,
        });
      },
    },
  ];

  for (const testCase of cases) {
    it(`${testCase.name} is reachable and reports depth ${testCase.depth}`, async () => {
      const result = await testCase.run();
      expect(codeOf(result)).toBe(testCase.category);
      expect(result.depthReached).toBe(testCase.depth);
      expect(result.cause).toBe(FAILURE_CAUSE[testCase.category]);
      expect(result.outcome).not.toBe('healthy');
    });
  }

  it('the vocabulary entries not produced by a network probe are still mapped, not guessed', () => {
    // `cors-limitation`, `browser-incompatible`, `codec-failure`, `expired-source`
    // and `georestriction` come from the browser axis / operator decisions. They
    // must still be categorised; a missing mapping is a silent fallback.
    for (const browserCategory of ['cors-limitation', 'browser-incompatible', 'codec-failure'] as const) {
      expect(FAILURE_CAUSE[browserCategory]).toBe('browser');
    }
    expect(FAILURE_CAUSE['expired-source']).toBe('content');
    expect(FAILURE_CAUSE['georestriction']).toBe('policy');
  });
});

describe('validator — layer 6 consumes an injected browser result and never opens one', () => {
  const failures = ['browser-incompatible', 'codec-failure', 'cors-limitation'] as const;

  for (const failure of failures) {
    it(`${failure} from the injected probe is degraded at depth browser`, async () => {
      const spy = healthyEgress();
      const result = await validate({
        egress: spy.fn,
        browser: {
          reproduced: false,
          failure,
          note: 'fixture probe',
          evidence: { mediaErrorCode: 4, manifestRequests: 1, segmentRequests: 2, blockedByCors: failure === 'cors-limitation' },
          probedAt: NOW,
        },
      });
      expect(result.outcome).toBe('degraded');
      expect(result.depthReached).toBe('browser');
      expect(result.failure?.category).toBe(failure);
      expect(result.cause).toBe('browser');
    });
  }

  it('a reproduced stream reaches `healthy` at depth `browser` with browserNotProbed=false', async () => {
    const spy = healthyEgress();
    const result = await validate({
      egress: spy.fn,
      browser: {
        reproduced: true,
        failure: null,
        note: null,
        evidence: { mediaErrorCode: null, manifestRequests: 1, segmentRequests: 3, blockedByCors: false },
        probedAt: NOW,
      },
    });
    expect(result.outcome).toBe('healthy');
    expect(result.depthReached).toBe('browser');
    expect(result.uncertainty.browserNotProbed).toBe(false);
  });

  it('no browser available ⇒ pre-browser health stands and browserNotProbed says so', async () => {
    const spy = healthyEgress();
    const result = await validate({ egress: spy.fn, browser: null });
    expect(result.outcome).toBe('healthy');
    expect(result.depthReached).toBe('segments');
    expect(result.uncertainty.browserNotProbed).toBe(true);
    // Not inferred as a reproduction failure: no failure detail at all.
    expect(result.failure).toBeNull();
  });

  it('a non-HTTP type is `unverifiable`, not `failing`: availability is not observable here', async () => {
    const spy = healthyEgress();
    const youtubeUrl = 'https://www.youtube.com/watch?v=fixture';
    const result = await validate({
      source: source({ type: 'youtube', url: youtubeUrl }),
      authorization: authorization({
        _id: `fixture:${youtubeUrl}`,
        sourceUrl: youtubeUrl,
        providerKind: 'platform',
        operatorId: 'youtube',
        verdict: 'permitted-official-embed',
        method: 'official-embed',
        basis: 'published-terms',
        quotedClause: 'Embedded playback is permitted through the official player.',
        clauseUrl: 'https://www.youtube.com/t/terms',
      }),
      egress: spy.fn,
    });
    expect(spy.fn).not.toHaveBeenCalled();
    expect(result.outcome).toBe('unverifiable');
    expect(result.failure).toBeNull();
    expect(result.uncertainty.notes).toContain('type-not-probed-over-http');
  });
});

describe('validator — layer 2 (DNS) is observed when injected and declared when not', () => {
  it('an empty DNS answer is `dns-failure` at depth `dns` before egress', async () => {
    const spy = healthyEgress();
    const result = await validate({ egress: spy.fn, dns: async () => ({ host: 'example.test', addresses: [] }) });
    expect(spy.fn).not.toHaveBeenCalled();
    expect(result.failure?.category).toBe('dns-failure');
    expect(result.depthReached).toBe('dns');
  });

  it('a TLS error from the resolver is `tls-failure`, not a generic DNS failure', async () => {
    const spy = healthyEgress();
    const result = await validate({
      egress: spy.fn,
      dns: async () => {
        throw new Error('TLS certificate verify failed');
      },
    });
    expect(result.failure?.category).toBe('tls-failure');
  });

  it('without a resolver, the row says DNS was not observed instead of claiming it passed', async () => {
    const result = await validate();
    expect(result.uncertainty.notes).toContain('dns-not-observed');
  });
});

describe('status mapping', () => {
  it('maps statuses onto contract categories without inventing a retryable 4xx', () => {
    expect(statusCategory(401)).toBe('http-401');
    expect(statusCategory(403)).toBe('http-403');
    expect(statusCategory(404)).toBe('http-404');
    expect(statusCategory(410)).toBe('http-404');
    expect(statusCategory(451)).toBe('http-451');
    expect(statusCategory(418)).toBe('http-404');
    expect(statusCategory(500)).toBe('http-5xx');
    expect(statusCategory(503)).toBe('http-5xx');
    expect(statusCategory(429)).toBe('http-5xx');
    expect(isRetryable(statusCategory(418))).toBe(false);
    expect(isRetryable(statusCategory(503))).toBe(true);
  });
});

/**
 * Transport classification: the structured `EgressFailure.code` decides, message
 * text is only a fallback. Every case below was a real misclassification found
 * by running the engine against live fixtures, not a hypothetical.
 */
describe('transport classification - the code is the contract, not the message', () => {
  const coded = (code: string, message: string): Error => new EgressFailure(code as never, message);

  it('REGRESSION: a redirect loop is redirect-unsafe, never response-too-large', () => {
    // The message contains "exceeded", which the old message regex matched as a
    // size failure. This single case is why the repair exists.
    const error = coded('too-many-redirects', 'Redirect limit 5 exceeded');
    expect(transportCategory(error)).toBe('redirect-unsafe');
    expect(transportCategory(error)).not.toBe('response-too-large');
  });

  it('a redirect-unsafe code is redirect-unsafe', () => {
    expect(transportCategory(coded('redirect-unsafe', 'Redirect left http(s)'))).toBe('redirect-unsafe');
  });

  it('TIMEOUT: a timeout code wins over a message that also says "exceeded"', () => {
    // Upstream messages a timeout as "Egress exceeded 2000 ms" — the same word
    // that made a timeout look like a size failure.
    const error = coded('timeout', 'Egress exceeded 2000 ms');
    expect(transportCategory(error)).toBe('timeout');
    expect(transportCategory(error)).not.toBe('response-too-large');
  });

  it('a 2xx whose content-type is not allowed is unsupported-format', () => {
    const error = coded('content-type-not-allowed', 'Content-Type "text/html" is not allowed');
    expect(transportCategory(error)).toBe('unsupported-format');
  });

  it('FALLBACK: a plain Error with no code is still classified from its message', () => {
    expect(transportCategory(new Error('connection refused'))).toBe('connection-refused');
    expect(transportCategory(new Error('getaddrinfo ENOTFOUND example.test'))).toBe('dns-failure');
    expect(transportCategory(new Error('something entirely unexpected'))).toBe('unknown-error');
  });

  it('the full code table maps exactly as contracted', () => {
    const table: ReadonlyArray<readonly [string, string]> = [
      ['timeout', 'timeout'],
      ['dns-failure', 'dns-failure'],
      ['tls-failure', 'tls-failure'],
      ['connection-failed', 'connection-refused'],
      ['private-address', 'ssrf-blocked'],
      ['dns-rebind', 'ssrf-blocked'],
      ['host-blocked', 'ssrf-blocked'],
      ['scheme-not-allowed', 'ssrf-blocked'],
      ['invalid-url', 'ssrf-blocked'],
      ['credential-in-url', 'ssrf-blocked'],
      ['redirect-unsafe', 'redirect-unsafe'],
      ['too-many-redirects', 'redirect-unsafe'],
      ['response-too-large', 'response-too-large'],
      ['content-type-not-allowed', 'unsupported-format'],
    ];
    for (const [code, expected] of table) {
      // A misleading message on purpose: the code must decide regardless.
      expect(`${code} -> ${transportCategory(coded(code, 'exceeded timeout redirect'))}`).toBe(`${code} -> ${expected}`);
    }
  });

  it('an unrecognised code is unknown-error and is NOT guessed from the message', () => {
    // A message that the fallback would happily call `timeout`: the code path must
    // win and say "we do not know this cause", so a moving contract surfaces.
    expect(transportCategory(coded('brand-new-code', 'timed out'))).toBe('unknown-error');
  });
});

/**
 * TWO-SIDED through the real path: a real socket, the real `safeFetch`, the real
 * `runValidation`. Hand-made error objects prove the mapping table; only this
 * proves the classifier agrees with what the egress layer actually throws.
 */
describe('transport classification - proven through the real safeFetch path', () => {
  /** Adapts the real egress executor to the validator's injected seam. */
  const realEgress: EgressFn = async (request) => {
    const response = await safeFetch({
      url: request.url,
      ...(request.method === undefined ? {} : { method: request.method }),
      timeoutMs: request.timeoutMs,
      maxBytes: request.maxBytes,
      ...(request.allowedContentPrefixes === undefined
        ? {}
        : { allowedContentPrefixes: request.allowedContentPrefixes }),
      // A local fixture is a loopback destination: the only reason this flag
      // exists. Production never sets it.
      allowLoopbackForTests: true,
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
  };

  let fixture: HttpFixture | null = null;

  async function withFixture<T>(routes: Parameters<typeof startHttpFixture>[0], body: (f: HttpFixture) => Promise<T>): Promise<T> {
    fixture = await startHttpFixture(routes);
    try {
      return await body(fixture);
    } finally {
      await fixture.close();
      fixture = null;
    }
  }

  /** Runs one manifest probe against the fixture through the real engine. */
  function probeFixture(url: string, segmentSample = 0) {
    return runValidation({
      source: source({ url }),
      authorization: authorization({ sourceUrl: url }),
      registry: createDefaultAdapterRegistry(),
      egress: realEgress,
      segmentSample,
      now: NOW,
      // The fixture is loopback; DNS is not what is under test here.
      dns: async () => ({ host: '127.0.0.1', addresses: [{ address: '127.0.0.1', family: 4 }] }),
    });
  }

  it('a 4 MiB undeclared (chunked) body is response-too-large', async () => {
    await withFixture(
      { '/big.m3u8': { streamBytes: 4 * 1024 * 1024, contentType: HLS_MIME, chunkSize: 64 * 1024 } },
      async (f) => {
        const result = await probeFixture(f.url('/big.m3u8'));
        expect(result.failure?.category).toBe('response-too-large');
        expect(result.depthReached).toBe('transport');
        expect(result.outcome).toBe('failing');
      },
    );
  }, 30_000);

  it('a server that never answers is timeout', async () => {
    await withFixture({ '/hang.m3u8': { hang: true } }, async (f) => {
      const result = await probeFixture(f.url('/hang.m3u8'));
      expect(result.failure?.category).toBe('timeout');
      expect(result.depthReached).toBe('transport');
    });
  }, 30_000);

  it('a 302 loop is redirect-unsafe, not response-too-large', async () => {
    await withFixture({ '/loop.m3u8': { location: '/loop.m3u8', status: 302 } }, async (f) => {
      const result = await probeFixture(f.url('/loop.m3u8'));
      expect(result.failure?.category).toBe('redirect-unsafe');
      expect(result.failure?.category).not.toBe('response-too-large');
      expect(result.depthReached).toBe('transport');
    });
  }, 30_000);

  it('REGRESSION GUARD: a 2xx with a non-manifest content-type is unsupported-format at transport', async () => {
    await withFixture(
      // Exactly the "HTTP 200 is not a manifest" case: 2xx, HTML, no redirect.
      { '/page.m3u8': { status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><html></html>' } },
      async (f) => {
        const result = await probeFixture(f.url('/page.m3u8'));
        expect(result.failure?.category).toBe('unsupported-format');
        expect(result.depthReached).toBe('transport');
        expect(result.outcome).toBe('failing');
        // And it is never healthy, which is the whole point of the axis split.
        expect(result.outcome).not.toBe('healthy');
      },
    );
  }, 30_000);

  it('POSITIVE CONTROL: a real manifest from the same fixture is manifest-accepted at depth manifest', async () => {
    await withFixture(
      { '/ok.m3u8': { status: 200, contentType: HLS_MIME, body: MEDIA_PLAYLIST } },
      async (f) => {
        const result = await probeFixture(f.url('/ok.m3u8'));
        expect(result.failure).toBeNull();
        expect(result.depthReached).toBe('manifest');
      },
    );
  }, 30_000);
});

describe('back-off — deterministic, capped, bounded', () => {
  const from = NOW;

  it('uses the contract bases per status', () => {
    const healthy = computeBackoff({ status: 'healthy', attempt: 1, sourceId: 's1' }, from);
    const degraded = computeBackoff({ status: 'degraded', attempt: 1, sourceId: 's1' }, from);
    const failing = computeBackoff({ status: 'failing', attempt: 1, sourceId: 's1' }, from);
    const unknown = computeBackoff({ status: 'unknown', attempt: 1, sourceId: 's1' }, from);
    expect(healthy.baseDelayMs).toBe(6 * 60 * 60 * 1000);
    expect(degraded.baseDelayMs).toBe(2 * 60 * 60 * 1000);
    expect(failing.baseDelayMs).toBe(30 * 60 * 1000);
    expect(unknown.baseDelayMs).toBe(15 * 60 * 1000);
  });

  it('doubles per attempt and caps at 24 h', () => {
    const a1 = computeBackoff({ status: 'failing', attempt: 1, sourceId: 's1' }, from);
    const a2 = computeBackoff({ status: 'failing', attempt: 2, sourceId: 's1' }, from);
    expect(a2.baseDelayMs).toBe(a1.baseDelayMs * 2);
    const capped = computeBackoff({ status: 'healthy', attempt: 12, sourceId: 's1' }, from);
    expect(capped.baseDelayMs).toBe(BACKOFF_MAX_MS);
    expect(capped.delayMs).toBeLessThanOrEqual(BACKOFF_MAX_MS);
  });

  it('jitter is deterministic per (sourceId, attempt), bounded by ±20 %, and differs across sources', () => {
    const one = computeBackoff({ status: 'healthy', attempt: 1, sourceId: 'source-a' }, from);
    const repeat = computeBackoff({ status: 'healthy', attempt: 1, sourceId: 'source-a' }, from);
    expect(one).toEqual(repeat);

    for (const sourceId of ['source-a', 'source-b', 'source-c']) {
      for (const attempt of [1, 2, 3]) {
        const plan = computeBackoff({ status: 'degraded', attempt, sourceId }, from);
        expect(Math.abs(plan.jitterMs)).toBeLessThanOrEqual(Math.round(plan.baseDelayMs * 0.2) + 1);
        expect(deterministicJitterUnit(sourceId, attempt)).toBeGreaterThanOrEqual(-1);
        expect(deterministicJitterUnit(sourceId, attempt)).toBeLessThan(1);
      }
    }
    const others = new Set(
      ['source-a', 'source-b', 'source-c'].map((s) => computeBackoff({ status: 'healthy', attempt: 1, sourceId: s }, from).jitterMs),
    );
    expect(others.size).toBeGreaterThan(1);
  });

  it('retry is bounded by the attempt cap and never happens for paused/unverifiable', () => {
    expect(computeBackoff({ status: 'failing', attempt: 1, sourceId: 's', maxAttempts: 3 }, from).retryable).toBe(true);
    expect(computeBackoff({ status: 'failing', attempt: 3, sourceId: 's', maxAttempts: 3 }, from).retryable).toBe(false);
    const paused = computeBackoff({ status: 'paused', attempt: 1, sourceId: 's' }, from);
    expect(paused.retryable).toBe(false);
    expect(paused.delayMs).toBe(0);
    expect(statusForOutcome('healthy')).toBe('healthy');
    expect(statusForOutcome('ineligible')).toBe('unknown');
    expect(statusForOutcome('paused')).toBe('paused');
  });

  it('nextCheckAt is exactly from + delay', () => {
    const plan = computeBackoff({ status: 'unknown', attempt: 2, sourceId: 's' }, from);
    expect(plan.nextCheckAt.getTime()).toBe(from.getTime() + plan.delayMs);
  });
});

describe('validator — source hygiene', () => {
  it('the validator module never opens a browser or a socket itself', () => {
    const path = fileURLToPath(new URL('./validator.ts', import.meta.url));
    const text = readFileSync(path, 'utf8');
    // No imports of a browser driver, a scheduler, or raw network primitives:
    // the only I/O is the injected `egress`/`dns` seam.
    for (const forbidden of ['playwright', 'puppeteer', 'child_process', 'node:net', 'node:http', 'node:https', 'undici']) {
      expect(text).not.toMatch(new RegExp(`from '${forbidden.replace(/[/\\]/g, '\\$&')}'`));
    }
  });
});

/**
 * Master → one variant → segments, through a REAL socket and the REAL safeFetch.
 *
 * Before this repair the master branch returned `degraded`/`failure: null`
 * without ever fetching a variant, so layer 5 was unreachable for the shape most
 * emitters publish. These tests drive the actual engine over an actual HTTP
 * server: no injected fake, no hand-made response.
 */
describe('master playlist descent — layer 5 actually runs (real fixtures)', () => {
  const MASTER_VARIANTS = [
    '#EXTM3U',
    '#EXT-X-VERSION:4',
    '#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720',
    'v0/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360',
    'v1/index.m3u8',
    '',
  ].join('\n');

  const media = (segments: readonly string[]): string =>
    ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:6', ...segments.flatMap((s) => ['#EXTINF:6.0,', s]), ''].join(
      '\n',
    );

  /** The real egress executor behind the validator's injected seam. */
  const realEgress: EgressFn = async (request) => {
    const response = await safeFetch({
      url: request.url,
      ...(request.method === undefined ? {} : { method: request.method }),
      timeoutMs: request.timeoutMs,
      maxBytes: request.maxBytes,
      ...(request.allowedContentPrefixes === undefined
        ? {}
        : { allowedContentPrefixes: request.allowedContentPrefixes }),
      allowLoopbackForTests: true,
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
  };

  /** Counts every egress call the engine makes, so "bounded" is measured. */
  function countingEgress(calls: string[]): EgressFn {
    return async (request) => {
      calls.push(request.url);
      return realEgress(request);
    };
  }

  function probe(url: string, egress: EgressFn, segmentSample?: number) {
    return runValidation({
      source: source({ url }),
      authorization: authorization({ sourceUrl: url }),
      registry: createDefaultAdapterRegistry(),
      egress,
      ...(segmentSample === undefined ? {} : { segmentSample }),
      now: NOW,
      dns: async () => ({ host: '127.0.0.1', addresses: [{ address: '127.0.0.1', family: 4 }] }),
    });
  }

  async function withFixture<T>(
    routes: Parameters<typeof startHttpFixture>[0],
    body: (f: HttpFixture) => Promise<T>,
  ): Promise<T> {
    const fixture = await startHttpFixture(routes);
    try {
      return await body(fixture);
    } finally {
      await fixture.close();
    }
  }

  it('CENTRAL: master → media → 2 valid segments is healthy at depth segments', async () => {
    await withFixture(
      {
        '/master.m3u8': { contentType: HLS_MIME, body: MASTER_VARIANTS },
        '/v0/index.m3u8': { contentType: HLS_MIME, body: media(['seg-1.ts', 'seg-2.ts']) },
        '/v0/seg-1.ts': { contentType: 'video/mp2t', body: 'AAAA' },
        '/v0/seg-2.ts': { contentType: 'video/mp2t', body: 'BBBB' },
      },
      async (f) => {
        const calls: string[] = [];
        const result = await probe(f.url('/master.m3u8'), countingEgress(calls));
        expect(result.failure).toBeNull();
        expect(result.outcome).toBe('healthy');
        expect(result.depthReached).toBe('segments');
        // The operator can see the path taken.
        expect(result.evidence.followedVariant).toContain('/v0/index.m3u8');
        expect(result.evidence.variantStatus).toBe(200);
        expect(result.evidence.segmentStatuses).toEqual([200, 200]);
        expect(result.evidence.samplesAttempted).toBe(2);
        // Bounded: master + 1 variant + (HEAD, prefix GET) × 2 segments.
        expect(calls).toHaveLength(6);
      },
    );
  }, 30_000);

  it('master → media whose segment is 404 is missing-segments, not degraded', async () => {
    await withFixture(
      {
        '/master.m3u8': { contentType: HLS_MIME, body: MASTER_VARIANTS },
        '/v0/index.m3u8': { contentType: HLS_MIME, body: media(['gone.ts']) },
        // '/v0/gone.ts' deliberately absent → the fixture answers 404.
      },
      async (f) => {
        const result = await probe(f.url('/master.m3u8'), realEgress);
        expect(result.failure?.category).toBe('missing-segments');
        expect(result.outcome).toBe('failing');
        expect(result.depthReached).toBe('playlist');
        expect(result.evidence.segmentStatuses).toContain(404);
      },
    );
  }, 30_000);

  it('master → media whose segment is 403 is segments-forbidden, not degraded', async () => {
    await withFixture(
      {
        '/master.m3u8': { contentType: HLS_MIME, body: MASTER_VARIANTS },
        '/v0/index.m3u8': { contentType: HLS_MIME, body: media(['locked.ts']) },
        '/v0/locked.ts': { status: 403, contentType: 'text/plain', body: 'forbidden' },
      },
      async (f) => {
        const result = await probe(f.url('/master.m3u8'), realEgress);
        expect(result.failure?.category).toBe('segments-forbidden');
        expect(result.outcome).toBe('failing');
        expect(result.depthReached).toBe('playlist');
      },
    );
  }, 30_000);

  it('AKAMAI SHAPE: master 200 whose variant is 404 is a named failure, never degraded/null', async () => {
    await withFixture(
      {
        // The real case: the master serves, the playlist it names does not.
        '/master.m3u8': { contentType: HLS_MIME, body: MASTER_VARIANTS },
      },
      async (f) => {
        const result = await probe(f.url('/master.m3u8'), realEgress);
        expect(result.outcome).toBe('failing');
        expect(result.failure).not.toBeNull();
        expect(result.failure?.category).toBe('missing-segments');
        expect(result.depthReached).toBe('playlist');
        expect(result.evidence.variantStatus).toBe(404);
        expect(result.failure?.message).toMatch(/variant answered HTTP 404/);
      },
    );
  }, 30_000);

  it('NESTED MASTERS: never recurses and the request count stays bounded', async () => {
    await withFixture(
      {
        '/master.m3u8': { contentType: HLS_MIME, body: MASTER_VARIANTS },
        // Every variant is itself a master, each naming more masters.
        '/v0/index.m3u8': { contentType: HLS_MIME, body: MASTER_VARIANTS },
        '/v1/index.m3u8': { contentType: HLS_MIME, body: MASTER_VARIANTS },
      },
      async (f) => {
        const calls: string[] = [];
        const result = await probe(f.url('/master.m3u8'), countingEgress(calls));
        expect(result.outcome).toBe('degraded');
        expect(result.failure).toBeNull();
        expect(result.uncertainty.notes).toContain('nested-master-not-followed');
        expect(result.uncertainty.segmentsNotSampled).toBe(true);
        // Master + exactly one variant. A chain cannot multiply requests.
        expect(calls).toHaveLength(2);
      },
    );
  }, 30_000);

  it('TWO-SIDED: segmentSample=0 keeps the honest degraded/null-failure', async () => {
    await withFixture(
      { '/master.m3u8': { contentType: HLS_MIME, body: MASTER_VARIANTS } },
      async (f) => {
        const calls: string[] = [];
        const result = await probe(f.url('/master.m3u8'), countingEgress(calls), 0);
        expect(result.outcome).toBe('degraded');
        expect(result.failure).toBeNull();
        expect(result.uncertainty.segmentsNotSampled).toBe(true);
        expect(result.uncertainty.notes).toContain('segment-sample-size-zero');
        // Nothing was sampled, so no variant was even fetched.
        expect(calls).toHaveLength(1);
      },
    );
  }, 30_000);

  it('a media playlist still works unchanged (no variant descent for non-masters)', async () => {
    await withFixture(
      {
        '/media.m3u8': { contentType: HLS_MIME, body: media(['s1.ts', 's2.ts']) },
        '/s1.ts': { contentType: 'video/mp2t', body: 'A' },
        '/s2.ts': { contentType: 'video/mp2t', body: 'B' },
      },
      async (f) => {
        const calls: string[] = [];
        const result = await probe(f.url('/media.m3u8'), countingEgress(calls));
        expect(result.outcome).toBe('healthy');
        expect(result.depthReached).toBe('segments');
        expect(result.evidence.followedVariant).toBeNull();
        // Media playlist + (HEAD, prefix GET) × 2 sampled segments.
        expect(calls).toHaveLength(5);
      },
    );
  }, 30_000);
});

/**
 * The egress content-type allow-list and the parser must agree.
 *
 * The measured defect: the mux test stream serves `audio/mpegurl`, which
 * `manifest.ts` accepts but the hardcoded egress allow-list did not — so a good
 * public stream was reported `unsupported-format` before it was ever parsed.
 * Both now derive from the same exported arrays, and these tests enumerate them
 * so a future addition to one place cannot silently miss the other.
 */
describe('egress content-type allow-list derives from the manifest MIME sets', () => {
  /** Adapts the real egress executor to the validator's injected seam. */
  const realEgress: EgressFn = async (request) => {
    const response = await safeFetch({
      url: request.url,
      ...(request.method === undefined ? {} : { method: request.method }),
      timeoutMs: request.timeoutMs,
      maxBytes: request.maxBytes,
      ...(request.allowedContentPrefixes === undefined
        ? {}
        : { allowedContentPrefixes: request.allowedContentPrefixes }),
      allowLoopbackForTests: true,
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
  };

  function probe(url: string, egress: EgressFn) {
    return runValidation({
      source: source({ url }),
      authorization: authorization({ sourceUrl: url }),
      registry: createDefaultAdapterRegistry(),
      egress,
      now: NOW,
      dns: async () => ({ host: '127.0.0.1', addresses: [{ address: '127.0.0.1', family: 4 }] }),
    });
  }

  async function withFixture<T>(
    routes: Parameters<typeof startHttpFixture>[0],
    body: (f: HttpFixture) => Promise<T>,
  ): Promise<T> {
    const fixture = await startHttpFixture(routes);
    try {
      return await body(fixture);
    } finally {
      await fixture.close();
    }
  }

  it('the allow-list is built from the exported sets, not a third hand-copied list', () => {
    const hls = manifestContentTypeAllowList('hls');
    for (const type of HLS_MIME_TYPES) expect(hls).toContain(type);
    for (const type of DASH_MIME_TYPES) expect(hls).toContain(type);
    const dash = manifestContentTypeAllowList('dash');
    for (const type of DASH_MIME_TYPES) expect(dash).toContain(type);
    // No silent widening: every entry traces back to a manifest set.
    for (const type of hls) expect([...HLS_MIME_TYPES, ...DASH_MIME_TYPES]).toContain(type);
  });

  /** Segment routes that complete `MEDIA_PLAYLIST`, so MIME acceptance is what is tested. */
  const MEDIA_SEGMENT_ROUTES = {
    '/m3u8/segment-1.ts': { contentType: 'video/mp2t', body: 'A' },
    '/segment-1.ts': { contentType: 'video/mp2t', body: 'A' },
    '/segment-2.ts': { contentType: 'video/mp2t', body: 'B' },
    '/segment-3.ts': { contentType: 'video/mp2t', body: 'C' },
    '/v0/segment-1.ts': { contentType: 'video/mp2t', body: 'A' },
    '/v0/segment-2.ts': { contentType: 'video/mp2t', body: 'B' },
    '/v0/segment-3.ts': { contentType: 'video/mp2t', body: 'C' },
  } as const;

  it('ENUMERATES every HLS MIME type: each is accepted on the manifest path', async () => {
    for (const mimeType of HLS_MIME_TYPES) {
      await withFixture(
        { '/m.m3u8': { contentType: mimeType, body: MEDIA_PLAYLIST }, ...MEDIA_SEGMENT_ROUTES },
        async (f) => {
          const result = await probe(f.url('/m.m3u8'), realEgress);
          // Reaching the manifest layer means the egress allow-list let it through.
          expect(`${mimeType} -> ${result.failure?.category ?? 'accepted'}`).toBe(`${mimeType} -> accepted`);
          expect(result.evidence.manifest).not.toBeNull();
        },
      );
    }
  }, 60_000);

  it('ENUMERATES every HLS MIME type: each is accepted on the followed-variant path', async () => {
    const master = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=800000',
      'v0/index.m3u8',
      '',
    ].join('\n');
    for (const mimeType of HLS_MIME_TYPES) {
      await withFixture(
        {
          '/master.m3u8': { contentType: HLS_MIME, body: master },
          '/v0/index.m3u8': { contentType: mimeType, body: MEDIA_PLAYLIST },
          ...MEDIA_SEGMENT_ROUTES,
        },
        async (f) => {
          const result = await probe(f.url('/master.m3u8'), realEgress);
          // The variant was fetched and its segments sampled, so the variant
          // fetch's allow-list accepted this type.
          expect(`${mimeType} -> ${result.evidence.variantStatus}`).toBe(`${mimeType} -> 200`);
          expect(result.evidence.samplesAttempted).toBeGreaterThan(0);
        },
      );
    }
  }, 60_000);

  it('REGRESSION: a manifest served as audio/mpegurl reaches the manifest layer', async () => {
    await withFixture(
      { '/mux.m3u8': { status: 200, contentType: 'audio/mpegurl', body: MEDIA_PLAYLIST }, ...MEDIA_SEGMENT_ROUTES },
      async (f) => {
        const result = await probe(f.url('/mux.m3u8'), realEgress);
        expect(result.failure).toBeNull();
        expect(result.evidence.manifest?.format).toBe('hls-media');
        expect(result.depthReached).not.toBe('transport');
      },
    );
  }, 30_000);

  it('TWO-SIDED: a 200 text/html is still refused as unsupported-format at transport', async () => {
    await withFixture(
      { '/page.m3u8': { status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><html></html>' } },
      async (f) => {
        const result = await probe(f.url('/page.m3u8'), realEgress);
        expect(result.failure?.category).toBe('unsupported-format');
        expect(result.depthReached).toBe('transport');
        expect(result.outcome).toBe('failing');
      },
    );
  }, 30_000);

  it('TWO-SIDED: an unrelated binary type is still refused at transport', async () => {
    await withFixture(
      { '/x.m3u8': { status: 200, contentType: 'video/mp4', body: 'not a playlist' } },
      async (f) => {
        const result = await probe(f.url('/x.m3u8'), realEgress);
        expect(result.failure?.category).toBe('unsupported-format');
        expect(result.depthReached).toBe('transport');
      },
    );
  }, 30_000);
});

/**
 * The sampled-probe budget versus the whole-segment ceiling.
 *
 * The measured defect: one constant (64 KiB) was both the per-sample probe budget
 * and the whole-GET budget, so any real HD segment was refused as
 * `response-too-large` … and then reported as `missing-segments`, blaming the
 * content for a policy decision. A healthy live chain could never reach healthy.
 *
 * The probe now HEADs first (existence + declared size), then reads a bounded
 * prefix, so a multi-megabyte segment is sampled rather than downloaded.
 */
describe('segment probe budgets — HEAD + bounded prefix (real fixtures)', () => {
  const realEgress: EgressFn = async (request) => {
    const response = await safeFetch({
      url: request.url,
      ...(request.method === undefined ? {} : { method: request.method }),
      timeoutMs: request.timeoutMs,
      maxBytes: request.maxBytes,
      ...(request.allowedContentPrefixes === undefined
        ? {}
        : { allowedContentPrefixes: request.allowedContentPrefixes }),
      allowLoopbackForTests: true,
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
  };

  function probe(url: string, egress: EgressFn) {
    return runValidation({
      source: source({ url }),
      authorization: authorization({ sourceUrl: url }),
      registry: createDefaultAdapterRegistry(),
      egress,
      segmentSample: 2,
      now: NOW,
      dns: async () => ({ host: '127.0.0.1', addresses: [{ address: '127.0.0.1', family: 4 }] }),
    });
  }

  async function withFixture<T>(
    routes: Parameters<typeof startHttpFixture>[0],
    body: (f: HttpFixture) => Promise<T>,
  ): Promise<T> {
    const fixture = await startHttpFixture(routes);
    try {
      return await body(fixture);
    } finally {
      await fixture.close();
    }
  }

  const master = ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=2500000', 'v0/index.m3u8', ''].join('\n');
  const media = (segments: readonly string[]): string =>
    ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:6', ...segments.flatMap((s) => ['#EXTINF:6.0,', s]), ''].join(
      '\n',
    );

  it('LIVE SHAPE: master → media → two ≥200 KiB segments is healthy at depth segments', async () => {
    /*
     * A real HD segment is far above the old 64 KiB whole-GET budget. The body is
     * a plain declared-length body on purpose: `streamBytes` writes chunks after
     * declaring a content-length, which makes the fixture's own response
     * malformed ("Data after Connection: close"). A plain body is what a real
     * origin serves and what the probe must accept.
     */
    const segmentBody = 'a'.repeat(220 * 1024);
    await withFixture(
      {
        '/master.m3u8': { contentType: HLS_MIME, body: master },
        '/v0/index.m3u8': { contentType: HLS_MIME, body: media(['s1.ts', 's2.ts']) },
        '/v0/s1.ts': { contentType: 'video/mp2t', body: segmentBody },
        '/v0/s2.ts': { contentType: 'video/mp2t', body: segmentBody },
      },
      async (f) => {
        const result = await probe(f.url('/master.m3u8'), realEgress);
        expect(result.failure).toBeNull();
        expect(result.outcome).toBe('healthy');
        expect(result.depthReached).toBe('segments');
        expect(result.evidence.segmentStatuses).toEqual([200, 200]);
        // The sampling budget held even though each segment is 220 KiB.
        expect(result.evidence.segmentBytesRead).toBeLessThanOrEqual(2 * SEGMENT_PROBE_BYTES);
      },
    );
  }, 40_000);

  it('PREFIX BOUND: a huge undeclared body is stopped by the ceiling, reading far less than it', async () => {
    /*
     * 8 MiB with no content-length, above the 4 MiB ceiling. The egress layer
     * counts bytes as they arrive and aborts, so the probe never accumulates the
     * whole body — the size defence fires and the row is not healthy.
     */
    const huge = 8 * 1024 * 1024;
    await withFixture(
      {
        '/master.m3u8': { contentType: HLS_MIME, body: master },
        '/v0/index.m3u8': { contentType: HLS_MIME, body: media(['big.ts', 'big2.ts']) },
        '/v0/big.ts': { contentType: 'video/mp2t', streamBytes: huge },
        '/v0/big2.ts': { contentType: 'video/mp2t', streamBytes: huge },
      },
      async (f) => {
        const result = await probe(f.url('/master.m3u8'), realEgress);
        expect(result.outcome).not.toBe('healthy');
        expect(result.failure?.category).toBe('response-too-large');
        // Whatever it read, it read far less than the whole 8 MiB.
        expect(result.evidence.segmentBytesRead).toBeLessThan(huge / 4);
      },
    );
  }, 40_000);

  it('an UNDECLARED size (the real CDN shape) is UNKNOWN, never assumed to fit', async () => {
    /*
     * Measured on the live CDNs: HEAD answers 200 `application/octet-stream`
     * with no content-length, while the GET of the same segment declares ~1.8 MiB.
     * A probe that read HEAD's zero as "it fits" would be asserting something it
     * never observed. The segment here is above the OLD 512 KiB ceiling and
     * within the new 4 MiB one, with no declared length on HEAD.
     */
    const body = 'a'.repeat(1_800_000);
    await withFixture(
      {
        '/master.m3u8': { contentType: HLS_MIME, body: master },
        '/v0/index.m3u8': { contentType: HLS_MIME, body: media(['a.ts', 'b.ts']) },
        '/v0/a.ts': { contentType: 'video/mp2t', body },
        '/v0/b.ts': { contentType: 'video/mp2t', body },
      },
      async (f) => {
        const result = await probe(f.url('/master.m3u8'), realEgress);
        expect(result.failure).toBeNull();
        expect(result.outcome).toBe('healthy');
        expect(result.evidence.segmentStatuses).toEqual([200, 200]);
      },
    );
  }, 40_000);

  it('TWO-SIDED: a hostile 10 MiB body is still refused as response-too-large', async () => {
    const hostile = 10 * 1024 * 1024;
    await withFixture(
      {
        '/master.m3u8': { contentType: HLS_MIME, body: master },
        '/v0/index.m3u8': { contentType: HLS_MIME, body: media(['evil.ts']) },
        '/v0/evil.ts': { contentType: 'video/mp2t', declaredContentLength: hostile, body: 'x' },
      },
      async (f) => {
        const result = await probe(f.url('/master.m3u8'), realEgress);
        expect(result.failure?.category).toBe('response-too-large');
        expect(result.outcome).not.toBe('healthy');
      },
    );
  }, 30_000);

  it('TWO-SIDED: a genuine 404 stays missing-segments', async () => {
    await withFixture(
      {
        '/master.m3u8': { contentType: HLS_MIME, body: master },
        '/v0/index.m3u8': { contentType: HLS_MIME, body: media(['gone.ts']) },
      },
      async (f) => {
        const result = await probe(f.url('/master.m3u8'), realEgress);
        expect(result.failure?.category).toBe('missing-segments');
        expect(result.failure?.message).toMatch(/404/);
      },
    );
  }, 30_000);

  it('TWO-SIDED: a genuine 403 stays segments-forbidden', async () => {
    await withFixture(
      {
        '/master.m3u8': { contentType: HLS_MIME, body: master },
        '/v0/index.m3u8': { contentType: HLS_MIME, body: media(['locked.ts']) },
        '/v0/locked.ts': { status: 403, contentType: 'text/plain', body: 'forbidden' },
      },
      async (f) => {
        const result = await probe(f.url('/master.m3u8'), realEgress);
        expect(result.failure?.category).toBe('segments-forbidden');
      },
    );
  }, 30_000);

  it('TWO-SIDED: a segment above the ceiling is still response-too-large, never healthy', async () => {
    const aboveCeiling = SEGMENT_MAX_BYTES + 64 * 1024;
    await withFixture(
      {
        '/master.m3u8': { contentType: HLS_MIME, body: master },
        '/v0/index.m3u8': { contentType: HLS_MIME, body: media(['huge.ts']) },
        '/v0/huge.ts': { contentType: 'video/mp2t', declaredContentLength: aboveCeiling, body: 'x' },
      },
      async (f) => {
        const result = await probe(f.url('/master.m3u8'), realEgress);
        // The size defence is not disabled by the fix.
        expect(result.failure?.category).toBe('response-too-large');
        expect(result.outcome).not.toBe('healthy');
        // The operator can tell a size refusal from an absent segment.
        expect(result.failure?.message).toMatch(/ceiling|response-too-large|exceeds/i);
      },
    );
  }, 30_000);
});
