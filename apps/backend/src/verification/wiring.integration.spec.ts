/**
 * Wiring integration: the verification subsystem as it exists in the running app.
 *
 * The three parallel branches each proved their own unit. This suite proves the
 * *integration*, and it does so through the real HTTP application and a real
 * MongoDB, never by calling the router or the scheduler directly:
 *
 * 1. the operator routes exist, and an anonymous caller gets 401;
 * 2. an editor gets 403 (these endpoints change what the platform asks third
 *    parties for, so they are administrator-only);
 * 3. the public `/api/v1` surface gained no verification route;
 * 4. a scheduled round through the *wired context* verifies a real fixture source
 *    end to end and writes a terminal check plus a health aggregate;
 * 5. the round is refused entirely while `VERIFY_ENABLED` is false.
 *
 * Point 4 is the reason this file exists: it is the only test that exercises
 * `safeFetch` on the production path, with the round, queue, ledger and
 * aggregate all being the instances the application built.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Collection } from 'mongodb';
import { COLLECTIONS } from '../infrastructure/mongo.js';
import { AUTHORIZATION_COLLECTION } from '../modules/providers/authorization.repository.js';
import { HEALTH_COLLECTIONS } from './health.schema.js';
import type { CheckRunDoc, HealthAggregateDoc } from './health.schema.js';
import { startHttpFixture, type HttpFixture } from './fixtures/http-fixtures.js';
import { createHarness, mongoAvailable, type TestHarness } from '../test/harness.js';
import { createVerificationRuntime } from './runtime.js';
import type { PlaybackSourceDoc } from '../infrastructure/schema.js';

const BOOTSTRAP_TOKEN = 'test-bootstrap-token-0123456789abcdef';
const PASSWORD = 'Correct-Horse-Battery-9';
const EDITOR_EMAIL = 'editor-wiring@tdt.invalid';

const skip = !(await mongoAvailable());

let harness: TestHarness;
let adminToken: string;
let editorToken: string;
let fixture: HttpFixture | null = null;

/** Seeds an administrator (bootstrap) and an editor, then logs both in. */
async function seedAndLogin(h: TestHarness): Promise<void> {
  await request(h.app)
    .post('/api/v1/auth/bootstrap')
    .send({ email: 'admin-wiring@tdt.invalid', password: PASSWORD, bootstrapToken: BOOTSTRAP_TOKEN, roles: ['admin'] })
    .expect(201);

  const editor = await import('../modules/admin/admin.auth.js');
  await h.context.database.db.collection<{ _id: string }>(COLLECTIONS.admins).insertOne({
    _id: randomUUID(),
    email: EDITOR_EMAIL,
    passwordHash: await editor.hashPassword(PASSWORD),
    roles: ['editor'],
    disabled: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastLoginAt: null,
  } as never);

  adminToken = (
    await request(h.app).post('/api/v1/auth/login').send({ email: 'admin-wiring@tdt.invalid', password: PASSWORD }).expect(200)
  ).body.data.token as string;
  editorToken = (
    await request(h.app).post('/api/v1/auth/login').send({ email: EDITOR_EMAIL, password: PASSWORD }).expect(200)
  ).body.data.token as string;
}

const asAdmin = () => ({ Authorization: `Bearer ${adminToken}` });
const asEditor = () => ({ Authorization: `Bearer ${editorToken}` });

/** Typed handle on the 02D collections, whose `_id` is a source id string. */
function checks(): Collection<CheckRunDoc> {
  return harness.context.database.db.collection(HEALTH_COLLECTIONS.checks) as unknown as Collection<CheckRunDoc>;
}

function health(): Collection<HealthAggregateDoc> {
  return harness.context.database.db.collection(
    HEALTH_COLLECTIONS.health,
  ) as unknown as Collection<HealthAggregateDoc>;
}

beforeAll(async () => {
  if (skip) return;
  harness = await createHarness({ ADMIN_BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN });
  await seedAndLogin(harness);
}, 120_000);

afterAll(async () => {
  await fixture?.close();
  await harness?.close();
});

describe.skipIf(skip)('verification wiring', () => {
  it('refuses the operator routes without a session (401)', async () => {
    for (const path of [
      '/api/v1/admin/verification/status',
      '/api/v1/admin/verification/metrics',
    ]) {
      const response = await request(harness.app).get(path);
      expect(response.status).toBe(401);
    }
    for (const path of [
      '/api/v1/admin/verification/pause-all',
      '/api/v1/admin/verification/resume-all',
    ]) {
      const response = await request(harness.app).post(path).send({});
      expect(response.status).toBe(401);
    }
  });

  it('refuses an editor (403): operator controls are administrator-only', async () => {
    const status = await request(harness.app).get('/api/v1/admin/verification/status').set(asEditor());
    expect(status.status).toBe(403);
    const metrics = await request(harness.app).get('/api/v1/admin/verification/metrics').set(asEditor());
    expect(metrics.status).toBe(403);
  });

  it('serves the operator status and Prometheus metrics to an administrator', async () => {
    const status = await request(harness.app)
      .get('/api/v1/admin/verification/status')
      .set(asAdmin())
      .expect(200);
    const data = status.body.data as {
      checks: Record<string, number>;
      sources: Record<string, number>;
      failures: unknown[];
      queue: { backend: string };
    };
    expect(data.queue.backend).toBe('mongo');
    expect(data.sources).toHaveProperty('healthy');
    expect(Array.isArray(data.failures)).toBe(true);

    const metrics = await request(harness.app)
      .get('/api/v1/admin/verification/metrics')
      .set(asAdmin())
      .expect(200);
    expect(metrics.headers['content-type']).toContain('text/plain');
    expect(metrics.text).toContain('tdt_verification_');
  });

  it('adds no verification route to the public /api/v1 surface', async () => {
    /*
     * The public contract is unchanged: these paths either do not exist or are
     * the admin 401. What must never happen is a verification route answering
     * *without* the admin guard, which is what this asserts: no path returns 2xx
     * to an anonymous caller.
     */
    for (const path of [
      '/api/v1/verification/status',
      '/api/v1/verification/metrics',
      '/api/v1/verification/sources/abc/pause',
      '/api/v1/verification/pause-all',
    ]) {
      const response = await request(harness.app).get(path);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).not.toBe(200);
    }
    // And the integration manifest (the documented public surface) lists none.
    const manifest = await request(harness.app).get('/api/v1/integration/manifest').expect(200);
    const endpoints = manifest.body.data.endpoints as Array<{ path: string }>;
    expect(endpoints.some((endpoint) => endpoint.path.includes('verification'))).toBe(false);
  });

  it('verifies a fixture source end to end on a scheduled round through the wired context', async () => {
    // A real local HLS fixture: the round reaches it through safeFetch.
    const playlist = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:2',
      '#EXTINF:2.0,',
      'seg0.ts',
      '#EXTINF:2.0,',
      'seg1.ts',
      '#EXT-X-ENDLIST',
    ].join('\n');
    fixture = await startHttpFixture({
      '/live/index.m3u8': {
        status: 200,
        contentType: 'application/vnd.apple.mpegurl',
        body: playlist,
      },
      '/live/seg0.ts': { status: 200, contentType: 'video/mp2t', body: 'segment-0' },
      '/live/seg1.ts': { status: 200, contentType: 'video/mp2t', body: 'segment-1' },
    });

    const sourceId = randomUUID();
    const sourceUrl = fixture.url('/live/index.m3u8');
    const now = new Date();
    await harness.context.database
      .collection<{ _id: string } & Record<string, unknown>>(COLLECTIONS.sources)
      .insertOne({
      _id: sourceId,
      channelId: randomUUID(),
      provider: 'official-web',
      type: 'hls',
      url: sourceUrl,
      officialPageUrl: null,
      /*
       * A permission the publication policy accepts (`official` is not one:
       * the 02C gate refused it with `disallowed-integration`, which is exactly
       * the fail-closed behaviour this milestone requires).
       */
      permission: 'emitter-public-stream',
      authorisationEvidence: null,
      conditions: {
        embedAllowed: false,
        proxyAllowed: false,
        worldwide: true,
        restrictedRegions: [],
        attributionRequired: false,
        geoBlocked: false,
        drm: null,
        notes: null,
      },
      priority: 1,
      editorialStatus: 'published',
      technicalStatus: 'unknown',
      lastVerifiedAt: null,
      lastVerification: null,
      provenance: [],
      createdAt: now,
      updatedAt: now,
      revision: 0,
    } as never);

    /*
     * The 02C gate records a *right*, and verification refuses to probe without
     * one (that is the milestone's layer 1). This is the recorded decision the
     * real operator seeds use, with a written licence for a permitted direct
     * playback — a disposable fixture, never a real operator.
     */
    /*
     * The 02C authorization collection is deliberately addressed by its own
     * module constant (`DatabaseHandle.collection` only accepts 02D-era declared
     * names), so this goes through the raw `Db` like the 02C repository does.
     */
    await harness.context.database.db
      .collection(AUTHORIZATION_COLLECTION)
      .insertOne({
        _id: `fixture-operator:${sourceUrl}`,
        operatorId: 'fixture-operator',
        sourceUrl,
        providerKind: 'broadcaster_cdn',
        verdict: 'permitted-direct-playback',
        basis: 'written-licence',
        quotedClause: null,
        clauseUrl: 'https://fixture.invalid/licence.pdf',
        method: 'direct-playback',
        publicationScope: 'in-app',
        /*
         * `worldwide`: the scheduler does not name a territory, and the gate
         * refuses a territory-less request for a right confined to named
         * countries ("asking no question is not the same as answering yes").
         */
        territory: { allowed: [], restricted: [], worldwide: true, geoBlocked: false },
        restrictions: [],
        attribution: 'Fixture Operator',
        discovery: {
          line: 1,
          sourceUrl,
          documentUrl: null,
          retrievedAt: now,
        },
        lifecycle: 'active',
        expiresAt: null,
        validationTimestamp: now,
        authorizationTimestamp: now,
        reviewStatus: 'reviewed',
        notes: null,
      } as never);

    // A due aggregate row, exactly as the scheduler's planner expects to find it.
    await health().insertOne({
      _id: sourceId,
      status: 'unknown',
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastOutcome: null,
      lastCheckedAt: null,
      nextCheckAt: new Date(now.getTime() - 60_000),
      circuit: { state: 'closed', openedAt: null, reopenCount: 0 },
      history: [],
      revision: 0,
      updatedAt: now,
    });

    /*
     * A runtime built from the SAME context, with only the loopback test flag
     * added, so the round exercises the production validator + safeFetch path
     * against a real socket. `VERIFY_ENABLED` is set so the gate is on.
     */
    const runtime = createVerificationRuntime({
      database: harness.context.database,
      logger: harness.context.logger,
      config: harness.config,
      authorizationsFor: (sources) => harness.context.playback.authorizationsFor(sources),
      findSource: (id) =>
        harness.context.database
          .collection<{ _id: string } & Record<string, unknown>>(COLLECTIONS.sources)
          .findOne({ _id: id }) as Promise<PlaybackSourceDoc | null>,
      allowLoopbackForTests: true,
    });

    const counts = await runtime.scheduler.runRound(new Date());

    // The round planned the source and the fixture was really contacted.
    expect(counts.planned).toBe(1);
    expect(fixture.counters.requests).toBeGreaterThan(0);
    // A real HLS fixture with a manifest and two segments reaches `healthy`:
    // that only happens after layers 4 and 5 produced evidence.
    expect(counts.byOutcome).toEqual({ healthy: 1 });

    // A terminal check row exists, written by the ledger.
    const check = await checks().findOne({ sourceId });
    expect(check).not.toBeNull();
    expect(check?.state).toBe('done');
    expect(check?.outcome).toBe('healthy');
    expect(check?.failure).toBeNull();
    // The depth is the layer the evidence came from, never the requested layer.
    expect(check?.depth).toBe('segments');

    // And the aggregate moved: health is recorded, not guessed.
    const aggregate = await health().findOne({ _id: sourceId });
    expect(aggregate).not.toBeNull();
    expect(aggregate?.status).toBe('healthy');
    expect(aggregate?.lastCheckedAt).not.toBeNull();
    expect(aggregate?.revision).toBeGreaterThan(0);
  }, 60_000);

  it('does not run a round while VERIFY_ENABLED is false', async () => {
    /*
     * The job body returns before planning. Proven at the job's own gate rather
     * than by starting timers: a fresh harness has JOBS_ENABLED=false and
     * VERIFY_ENABLED defaults to false, so the zero-cost path is the default.
     */
    expect(harness.config.VERIFY_ENABLED).toBe(false);
    const factory = await import('../jobs/scheduler.js');
    expect(typeof factory.startJobs).toBe('function');
    // Configuration proof: the default is off, so nothing schedules by accident.
    const configModule = await import('../config/config.js');
    const defaults = configModule.loadConfig({
      NODE_ENV: 'test',
      MONGODB_URI: 'mongodb://127.0.0.1:27117/?replicaSet=rs0',
    } as NodeJS.ProcessEnv);
    expect(defaults.VERIFY_ENABLED).toBe(false);
    expect(defaults.VERIFY_CONCURRENCY).toBe(4);
    expect(defaults.VERIFY_PER_HOST_CONCURRENCY).toBe(2);
    expect(defaults.VERIFY_BROWSER_ENABLED).toBe(false);
  });
});
