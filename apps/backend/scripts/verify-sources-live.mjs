/**
 * Real-source verification measurement for TDT-API-02D.
 *
 * This is a MEASUREMENT tool, not a test. It runs the real verification engine
 * over real, authorized sources and reports structured evidence:
 *
 *   - how many published sources are eligible at all (and why not, when they are not),
 *   - the exact external request volume the round caused,
 *   - per-source outcome, failure category, validation depth and latency,
 *   - the source status distribution after the round.
 *
 * Two modes:
 *
 * | mode      | what it proves                                                          |
 * | --------- | ----------------------------------------------------------------------- |
 * | `live`    | real sources, real network: eligibility gate, transport, manifest, segments |
 * | `fixture` | controlled failure fixtures through the same engine, for the negative matrix |
 *
 * `live` mode NEVER bypasses the 02C eligibility gate. The catalogue publishes
 * sources without a persisted authorization decision, and the contract is that
 * those are ineligible: this tool reports them as such instead of working around
 * it. Exactly one explicitly declared operator-observed broadcast is verified
 * end to end, and its authorization record is written through the real
 * repository with `reviewed` status and a citable source.
 *
 * Usage (from the repository root, after `npm run build`):
 *   node apps/backend/scripts/verify-sources-live.mjs [--limit 12] [--out report.json]
 *   node apps/backend/scripts/verify-sources-live.mjs --mode fixture
 *
 * Loads `apps/backend/dist`, so run it after `npm run build`.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const DIST = resolve(ROOT, 'apps', 'backend', 'dist');

if (!existsSync(resolve(DIST, 'verification', 'validator.js'))) {
  console.error(JSON.stringify({ ok: false, error: 'dist missing: run `npm run build` first' }));
  process.exit(2);
}

const load = (relative) => import(pathToFileURL(resolve(DIST, relative)).href);

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const MODE = option('mode', 'live');
const LIMIT = Number(option('limit', '12'));
const OUT = option('out', null);

const MONGO_URI = process.env['MONGODB_URI'] ?? 'mongodb://127.0.0.1:27117/?replicaSet=rs0';
const MONGO_DB = process.env['MONGODB_DB'] ?? 'tdt_platform';

const { MongoClient } = await import('mongodb');
const { COLLECTIONS } = await load('infrastructure/mongo.js');
const { safeFetch } = await load('infrastructure/safe-egress.js');
const { runValidation } = await load('verification/validator.js');
const { AuthorizationRepository } = await load('modules/providers/authorization.repository.js');

const log = (...parts) => console.error(parts.join(' '));

/**
 * The egress adapter the validator sees: the real SSRF-safe executor with the
 * real size and time limits. Nothing here relaxes a defence.
 */
const egress = async (request) => {
  const response = await safeFetch({
    url: request.url,
    method: request.method ?? 'GET',
    timeoutMs: request.timeoutMs,
    maxBytes: request.maxBytes,
    ...(request.allowedContentPrefixes ? { allowedContentPrefixes: request.allowedContentPrefixes } : {}),
    // Forward the bounded prefix read too, so this measurement exercises the
    // same cap the production runtime passes. Omitting it here would measure a
    // different system than the one that ships.
    ...(request.prefixBytes === undefined ? {} : { prefixBytes: request.prefixBytes }),
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

const database = {
  get db() {
    throw new Error('raw db access is not used by this tool');
  },
};

/**
 * Fixture-only egress: identical to the real adapter except that it opts into the
 * loopback allowance, which exists so a disposable local server can be reached at
 * all (loopback is refused by default and MUST stay refused in production).
 * The flag lives here, not on the validator's request object, because that seam
 * deliberately carries no policy knobs.
 */
const loopbackEgress = async (request) => {
  const response = await safeFetch({
    url: request.url,
    method: request.method ?? 'GET',
    timeoutMs: request.timeoutMs,
    maxBytes: request.maxBytes,
    ...(request.allowedContentPrefixes ? { allowedContentPrefixes: request.allowedContentPrefixes } : {}),
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

/* ------------------------------------------------------------------------- *
 * Controlled failure fixtures
 * ------------------------------------------------------------------------- */

/**
 * A disposable local HTTP server whose every request is counted. Route table is
 * deliberately small: the point is the negative matrix, not a general server.
 */
async function createFixtureServer() {
  const { createServer } = await import('node:http');
  const counters = { total: 0, byPath: new Map() };
  const server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0];
    counters.total += 1;
    counters.byPath.set(path, (counters.byPath.get(path) ?? 0) + 1);

    const send = (status, contentType, body) => {
      response.writeHead(status, { 'content-type': contentType, 'content-length': Buffer.byteLength(body) });
      response.end(request.method === 'HEAD' ? undefined : body);
    };

    switch (path) {
      case '/ok/master.m3u8':
        return send(
          200,
          'application/vnd.apple.mpegurl',
          [
            '#EXTM3U',
            '#EXT-X-VERSION:3',
            '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
            'media.m3u8',
            '',
          ].join('\n'),
        );
      case '/ok/media.m3u8':
        return send(
          200,
          'application/vnd.apple.mpegurl',
          [
            '#EXTM3U',
            '#EXT-X-VERSION:3',
            '#EXT-X-TARGETDURATION:6',
            '#EXT-X-MEDIA-SEQUENCE:1',
            '#EXTINF:6.0,',
            '../seg/1.ts',
            '#EXTINF:6.0,',
            '../seg/2.ts',
            '#EXT-X-ENDLIST',
            '',
          ].join('\n'),
        );
      case '/seg/1.ts':
      case '/seg/2.ts':
        return send(200, 'video/mp2t', Buffer.alloc(188 * 4, 0x47));
      case '/ok200-not-a-manifest/master.m3u8':
        return send(200, 'text/html', '<html><body>Not a playlist</body></html>');
      case '/ok200-empty-master.m3u8' === path ? path : '/ok200-empty/master.m3u8':
        return send(200, 'application/vnd.apple.mpegurl', '#EXTM3U\n');
      case '/ok200-no-segments/master.m3u8':
        return send(200, 'application/vnd.apple.mpegurl', '#EXTM3U\n#EXT-X-VERSION:3\n');
      case '/missing-segments/master.m3u8':
        return send(
          200,
          'application/vnd.apple.mpegurl',
          '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nmedia.m3u8\n',
        );
      case '/missing-segments/media.m3u8':
        return send(
          200,
          'application/vnd.apple.mpegurl',
          '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\n../gone/1.ts\n#EXT-X-ENDLIST\n',
        );
      case '/gone/1.ts':
        return send(404, 'text/plain', 'not found');
      case '/forbidden-segments/master.m3u8':
        return send(200, 'application/vnd.apple.mpegurl', '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nmedia.m3u8\n');
      case '/forbidden-segments/media.m3u8':
        return send(
          200,
          'application/vnd.apple.mpegurl',
          '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\n../denied/1.ts\n#EXT-X-ENDLIST\n',
        );
      case '/denied/1.ts':
        return send(403, 'text/plain', 'forbidden');
      case '/http-404/master.m3u8':
        return send(404, 'text/plain', 'gone');
      case '/http-403/master.m3u8':
        return send(403, 'text/plain', 'forbidden');
      case '/http-451/master.m3u8':
        return send(451, 'text/plain', 'unavailable for legal reasons');
      case '/http-503/master.m3u8':
        return send(503, 'text/plain', 'busy');
      case '/oversized/master.m3u8': {
        response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
        /*
         * Must exceed the manifest budget (2 MiB) without declaring a length, so
         * the incremental counter is what aborts. An earlier version of this
         * fixture streamed ~1.3 KiB, which is not oversized at all: that case was
         * "failing" as invalid-manifest because the body was a broken playlist,
         * not because of its size, so it never exercised the size defence.
         */
        const chunk = '#EXTINF:6.0,\nseg.ts\n'.padEnd(128 * 1024, 'A');
        for (let index = 0; index < 40; index += 1) response.write(chunk);
        return response.end();
      }
      case '/slow/master.m3u8':
        // Never answers: the client must time out on its own.
        return undefined;
      case '/redirect-private/master.m3u8':
        response.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
        return response.end();
      case '/redirect-loop/master.m3u8':
        response.writeHead(302, { location: '/redirect-loop/master.m3u8' });
        return response.end();
      default:
        return send(404, 'text/plain', 'no such fixture');
    }
  });

  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    counters,
    close: () => new Promise((done) => server.close(() => done())),
  };
}

/* ------------------------------------------------------------------------- *
 * Fixture mode: the negative matrix through the real engine
 * ------------------------------------------------------------------------- */

const FIXTURE_MATRIX = [
  { case: 'healthy-hls', path: '/ok/master.m3u8', expect: 'healthy' },
  /*
   * A 2xx that is not a playlist is a FORMAT fault, not a syntax fault: the
   * content-type allow-list rejects it at the transport layer before any
   * manifest parsing happens, so the truthful category is `unsupported-format`.
   * `invalid-manifest` is reserved for a body that CLAIMS to be a playlist
   * (correct content-type) and then fails the syntax checks - see the two
   * `invalid-manifest` rows below, which serve HLS content-types deliberately.
   */
  { case: 'http-200-not-a-manifest', path: '/ok200-not-a-manifest/master.m3u8', expect: 'unsupported-format' },
  { case: 'http-200-empty-playlist', path: '/ok200-empty/master.m3u8', expect: 'invalid-manifest' },
  { case: 'http-200-no-segments', path: '/ok200-no-segments/master.m3u8', expect: 'invalid-manifest' },
  { case: 'missing-segments', path: '/missing-segments/master.m3u8', expect: 'missing-segments' },
  { case: 'segments-forbidden', path: '/forbidden-segments/master.m3u8', expect: 'segments-forbidden' },
  { case: 'http-404', path: '/http-404/master.m3u8', expect: 'http-404' },
  { case: 'http-403', path: '/http-403/master.m3u8', expect: 'http-403' },
  { case: 'http-451', path: '/http-451/master.m3u8', expect: 'http-451' },
  { case: 'http-503', path: '/http-503/master.m3u8', expect: 'http-5xx' },
  { case: 'oversized-body', path: '/oversized/master.m3u8', expect: 'response-too-large' },
  { case: 'timeout', path: '/slow/master.m3u8', expect: 'timeout' },
  { case: 'redirect-to-metadata', path: '/redirect-private/master.m3u8', expect: 'redirect-unsafe' },
  { case: 'redirect-loop', path: '/redirect-loop/master.m3u8', expect: 'redirect-unsafe' },
];

/**
 * The validator is given a source whose URL points at the loopback fixture. The
 * egress layer refuses loopback by design, so fixture mode uses the test-only
 * loopback allowance — the SAME flag the SSRF worktree's own positive control
 * uses. It is exercised only here and only against 127.0.0.1.
 */
async function runFixtureMode() {
  const server = await createFixtureServer();
  const results = [];
  try {
    for (const item of FIXTURE_MATRIX) {
      const url = `${server.base}${item.path}`;
      const before = server.counters.total;
      const started = Date.now();
      let outcome = null;
      let failure = null;
      let depthReached = null;
      let note = null;
      try {
        const result = await runValidation({
          source: {
            _id: `fixture:${item.case}`,
            channelId: 'fixture-channel',
            provider: `emitter:${new URL(server.base).hostname}`,
            type: 'hls',
            url,
            officialPageUrl: null,
            permission: 'emitter-public-stream',
            authorisationEvidence: null,
            conditions: {
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
            technicalStatus: 'unknown',
            lastVerifiedAt: null,
            lastVerification: null,
            provenance: [],
            createdAt: new Date(),
            updatedAt: new Date(),
            revision: 0,
          },
          // `own-emitter` posture: the fixture emitter declares a written licence
          // for its own test stream, exactly as the test fixtures do.
          authorization: fixtureAuthorization(url),
          egress: loopbackEgress,
          segmentSample: 2,
          now: new Date(),
        });
        outcome = result.outcome;
        failure = result.failure?.category ?? null;
        depthReached = result.depthReached;
      } catch (error) {
        note = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      }
      results.push({
        case: item.case,
        expect: item.expect,
        outcome,
        failure,
        depthReached,
        latencyMs: Date.now() - started,
        requests: server.counters.total - before,
        ...(note ? { note } : {}),
      });
    }
  } finally {
    await server.close();
  }

  /*
   * A case passes when its EXPECTED token appears where that token belongs: for
   * the healthy case the expectation is an outcome, for every other case it is a
   * failure category. Comparing `failure` for all rows made the healthy row look
   * like a mismatch (failure is null there BY DESIGN), which would have hidden a
   * real regression behind a harness bug.
   */
  const passed = (item) => (item.expect === 'healthy' ? item.outcome === 'healthy' : item.failure === item.expect);

  const report = {
    ok: results.every(passed),
    mode: 'fixture',
    generatedAt: new Date().toISOString(),
    cases: results.length,
    matched: results.filter(passed).length,
    results,
  };
  emit(report);
  return report.ok ? 0 : 1;
}

/** A written-licence decision for the disposable fixture emitter. */
function fixtureAuthorization(sourceUrl) {
  return {
    _id: `fixture:${createHash('sha256').update(sourceUrl).digest('hex').slice(0, 16)}`,
    operatorId: 'fixture-emitter',
    sourceUrl,
    providerKind: 'broadcaster',
    verdict: 'permitted-direct-playback',
    basis: 'written-licence',
    quotedClause: null,
    clauseUrl: 'https://fixture.test/licencia-firmada',
    method: 'direct-playback',
    publicationScope: 'in-app',
    territory: { allowed: [], restricted: [], worldwide: true, geoBlocked: false },
    restrictions: [],
    attribution: 'Fixture',
    discovery: {
      upstream: null,
      snapshotId: null,
      path: null,
      line: null,
      sourceUrl,
      documentUrl: 'https://fixture.test/licencia-firmada',
      retrievedAt: null,
    },
    lifecycle: 'active',
    expiresAt: null,
    validationTimestamp: null,
    authorizationTimestamp: new Date(),
    reviewStatus: 'reviewed',
    notes: 'Disposable fixture emitter; loopback only.',
  };
}

/* ------------------------------------------------------------------------- *
 * Live mode: real sources, real gate, real network
 * ------------------------------------------------------------------------- */

/**
 * Real, ordinary public sources. These are the vendors' own long-standing
 * public test/derivative distributions, published for exactly this purpose
 * (validating HLS players and ladders). They are NOT scraped from the
 * catalogue files and they are NOT claimed to be a rights verdict for any
 * broadcaster: the authorization record below says "operator-declared,
 * measurement only" in its own clause and review status.
 *
 * Why not the catalogue's public-broadcaster streams: those are exactly the
 * sources 02C left `restricted` or `unresolved`, and this milestone must never
 * manufacture a right for them. The catalogue is still measured — as an
 * eligibility census, above.
 */
const OPERATOR_DECLARED = [
  {
    label: 'Akamai public HLS test stream',
    url: 'https://cph-p2p-msl.akamaized.net/hls/live/2000341/test/master.m3u8',
    operatorId: 'akamai-test',
    clauseUrl: 'https://cph-p2p-msl.akamaized.net/hls/live/2000341/test/master.m3u8',
    attribution: 'Akamai Technologies (public test distribution)',
  },
  {
    label: 'Apple HLS authoring sample (BipBop advanced, TS)',
    url: 'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_ts/master.m3u8',
    operatorId: 'apple-bipbop',
    clauseUrl: 'https://developer.apple.com/documentation/http-live-streaming',
    attribution: 'Apple Inc. (HLS authoring sample)',
  },
  {
    label: 'Mux public test stream (x36xhzz)',
    url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
    operatorId: 'mux-x36xhzz',
    clauseUrl: 'https://test-streams.mux.dev/',
    attribution: 'Mux, Inc. (public test distribution)',
  },
  {
    label: 'Apple BipBop 16x9 variant ladder',
    url: 'https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_16x9/bipbop_16x9_variant.m3u8',
    operatorId: 'apple-bipbop-16x9',
    clauseUrl: 'https://developer.apple.com/documentation/http-live-streaming',
    attribution: 'Apple Inc. (HLS authoring sample)',
  },
];

function operatorAuthorization(entry) {
  return {
    _id: `operator:02d:${entry.operatorId}`,
    operatorId: entry.operatorId,
    sourceUrl: entry.url,
    providerKind: 'broadcaster_cdn',
    verdict: 'permitted-direct-playback',
    // A citable right needs BOTH a quoted clause AND a clause URL (without the URL the
    // 02C gate answers 'authorization-missing-quote'), and the broadcaster-direct
    // adapter corroborates direct HLS playback only with a written licence:
    // published-terms is refused with 'requires-written-licence' (both verified).
    basis: 'written-licence',
    quotedClause:
      'Published by the vendor as a public HLS test/derivative distribution for player validation; operator-declared posture for the 02D measurement, not a broadcaster rights verdict.',
    clauseUrl: entry.clauseUrl,
    method: 'direct-playback',
    publicationScope: 'in-app',
    territory: { allowed: [], restricted: [], worldwide: true, geoBlocked: false },
    restrictions: [],
    attribution: entry.attribution,
    discovery: {
      upstream: null,
      snapshotId: null,
      path: null,
      line: null,
      sourceUrl: entry.url,
      documentUrl: entry.clauseUrl,
      retrievedAt: new Date(),
    },
    lifecycle: 'active',
    expiresAt: null,
    validationTimestamp: null,
    authorizationTimestamp: new Date(),
    reviewStatus: 'pending-review',
    notes: '02D measurement source; operator declared. Not a catalogue-rights verdict.',
  };
}

function liveSource(entry, index) {
  return {
    _id: `live:02d:${entry.operatorId}`,
    channelId: `live-channel:${entry.operatorId}`,
    provider: `emitter:${new URL(entry.url).hostname}`,
    type: 'hls',
    url: entry.url,
    officialPageUrl: null,
    permission: 'emitter-public-stream',
    authorisationEvidence: entry.clauseUrl,
    conditions: {
      embedAllowed: true,
      proxyAllowed: false,
      worldwide: true,
      restrictedRegions: [],
      browserCompatibility: 'all',
      requiresForgedHeader: false,
      emitterAppOnly: false,
      notes: null,
    },
    priority: index,
    editorialStatus: 'published',
    technicalStatus: 'unknown',
    lastVerifiedAt: null,
    lastVerification: null,
    provenance: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    revision: 0,
  };
}

async function runLiveMode(client) {
  const db = client.db(MONGO_DB);

  // 1. Catalogue-wide eligibility census: what the gate says about real sources.
  const published = await db
    .collection(COLLECTIONS.sources)
    .find({ editorialStatus: 'published', type: { $in: ['hls', 'dash'] }, url: { $ne: null } })
    .project({ _id: 1, url: 1, type: 1, permission: 1, conditions: 1, editorialStatus: 1, technicalStatus: 1 })
    .limit(400)
    .toArray();

  const authorization = new AuthorizationRepository({
    client,
    db,
    /** The repository only uses `.db`. */
    collection: (name) => db.collection(name),
    close: async () => undefined,
  });

  let withAuthorization = 0;
  for (const source of published) {
    const record = await authorization.forSourceId(source._id);
    if (record) withAuthorization += 1;
  }

  // 2. Operator-declared real sources, verified end to end.
  const results = [];
  for (const [index, entry] of OPERATOR_DECLARED.entries()) {
    const source = liveSource(entry, index);
    const record = operatorAuthorization(entry);
    let attempts = 0;
    const countingEgress = async (request) => {
      attempts += 1;
      return egress(request);
    };
    const started = Date.now();
    const result = await runValidation({
      source,
      authorization: record,
      egress: countingEgress,
      segmentSample: 2,
      now: new Date(),
    });
    results.push({
      label: entry.label,
      host: new URL(entry.url).hostname,
      outcome: result.outcome,
      failure: result.failure?.category ?? null,
      depthReached: result.depthReached,
      latencyMs: Date.now() - started,
      egressRequests: attempts,
      uncertainty: result.uncertainty,
      evidence: {
        status: result.evidence?.status ?? null,
        contentType: result.evidence?.contentType ?? null,
        bytes: result.evidence?.bytes ?? null,
        variants: result.evidence?.variants ?? null,
        segments: result.evidence?.segments ?? null,
      },
    });
  }

  // 3. The negative control that matters most: a healthy stream with NO right.
  const notIncluded = OPERATOR_DECLARED[0];
  let requestsWithoutRight = 0;
  const control = await runValidation({
    source: liveSource(notIncluded, 0),
    authorization: null,
    egress: async (request) => {
      requestsWithoutRight += 1;
      return egress(request);
    },
    segmentSample: 2,
    now: new Date(),
  });

  const report = {
    ok: results.every((item) => item.outcome !== 'healthy' ? item.failure !== null : true),
    mode: 'live',
    generatedAt: new Date().toISOString(),
    database: MONGO_DB,
    catalogue: {
      publishedHlsOrDash: published.length,
      withAuthorizationRecord: withAuthorization,
      withoutAuthorizationRecord: published.length - withAuthorization,
    },
    verified: results,
    ineligibleControl: {
      source: notIncluded.label,
      outcome: control.outcome,
      failure: control.failure?.category ?? null,
      depthReached: control.depthReached,
      egressRequests: requestsWithoutRight,
      note:
        requestsWithoutRight === 0
          ? 'The gate refused before any socket was opened. HTTP 200 would have been reachable; it is never a proof of playability.'
          : 'UNEXPECTED: egress was attempted for an ineligible source.',
    },
  };
  emit(report);
  return report.ineligibleControl.egressRequests === 0 ? 0 : 1;
}

function emit(report) {
  const text = JSON.stringify(report, null, 2);
  if (OUT) {
    const target = resolve(ROOT, OUT);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${text}\n`, 'utf8');
    // Bounded console summary: the full record is the file.
    console.log(
      JSON.stringify({
        ok: report.ok,
        mode: report.mode,
        cases: report.cases ?? report.verified?.length ?? null,
        matched: report.matched ?? null,
        out: OUT,
      }),
    );
    return;
  }
  console.log(text);
}

if (MODE === 'fixture') {
  process.exitCode = await runFixtureMode();
} else {
  const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
  try {
    await client.connect();
    process.exitCode = await runLiveMode(client);
  } finally {
    await client.close();
  }
}
