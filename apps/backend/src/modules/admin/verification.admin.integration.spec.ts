/**
 * Operator verification endpoints, end to end through the real Express app.
 *
 * The router is deliberately **not** mounted by `createRouter`, so each test
 * mounts it exactly the way the documented wiring does — under `/api/v1/admin`,
 * behind the real `requireRole('admin')` guard — onto the harness application.
 * That makes the test prove the contract the captain has to wire, not a private
 * shortcut:
 *
 * - an anonymous caller gets 401 and an editor gets 403 (these endpoints change
 *   what the platform asks third parties for);
 * - a pause is audited and keeps history;
 * - a manual retry without a reason is refused, with one is audited;
 * - the metrics endpoint is Prometheus text and never contains a URL.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import express from 'express';
import { MongoClient, type Collection } from 'mongodb';
import type { DatabaseHandle } from '../../infrastructure/mongo.js';
import { COLLECTIONS } from '../../infrastructure/mongo.js';
import type { AdminUserDoc, AuditDoc } from '../../infrastructure/schema.js';
import { TEST_MONGO_URI, createHarness, mongoAvailable } from '../../test/harness.js';
import type { TestHarness } from '../../test/harness.js';
import type { HealthAggregateDoc } from '../../verification/health.schema.js';
import { createVerificationAdminRouter } from './verification.admin.js';
import { hashPassword } from './admin.auth.js';
import { VerificationControls } from '../../verification/controls.js';
import { VerificationMetrics } from '../../verification/metrics.js';
import { MongoQueue } from '../../verification/queue.js';
import type { ValidationRequest, ValidationResult } from '../../verification/scheduler.js';
import { VerificationScheduler } from '../../verification/scheduler.js';

const CHECKS = 'source_health_checks_02d';
const HEALTH = 'source_health_02d';
const POLICIES = 'verification_policies_02d';

const BOOTSTRAP_TOKEN = 'test-bootstrap-token-0123456789abcdef';
const PASSWORD = 'Correct-Horse-Battery-9';
const EDITOR_EMAIL = 'editor-verify@tdt.invalid';

let harness: TestHarness;
let database: DatabaseHandle;
let adminToken: string;
let editorToken: string;
/** The real app with the operator router mounted at the documented path. */
let operatorApp: ReturnType<typeof express>;
let mounted: Awaited<ReturnType<typeof mountVerificationRoutes>>;

/** Mounts the router the documented way and returns the app + its collaborators. */
async function mountVerificationRoutes(h: TestHarness) {
  const metrics = new VerificationMetrics();
  const queue = new MongoQueue({ database: h.context.database });
  const validator = {
    async validate(_request: ValidationRequest): Promise<ValidationResult> {
      return {
        outcome: 'http-404',
        depth: 'transport',
        egressRequests: 1,
        failure: { code: 'http-404', httpStatus: 404, detail: 'gone' },
      };
    },
  };
  const scheduler = new VerificationScheduler({
    database: h.context.database,
    queue,
    validator,
    metrics,
    concurrency: 1,
    perHostConcurrency: 1,
    maxAttempts: 1,
    backoff: () => 0,
  });
  const controls = new VerificationControls({ database: h.context.database, queue });
  await scheduler.ensureIndexes();

  /*
   * The documented wiring, applied to a focused app instead of `routes.ts`.
   *
   * Why a focused app: `createApp` installs its 404 catch-all while it is being
   * built, so anything mounted afterwards lands behind it. This app mounts only
   * the operator router at exactly the path and behind exactly the guard the
   * wiring uses — and the sibling test proves the *real* app 404s that path
   * until the captain wires it, so it cannot leak onto the public surface.
   */
  const app = express();
  app.use(express.json());
  app.use(
    '/api/v1/admin',
    h.context.adminAuth.requireRole('admin'),
    createVerificationAdminRouter({
      database: h.context.database,
      queue,
      scheduler,
      controls,
      metrics,
      requireAdmin: h.context.adminAuth.requireRole('admin'),
    }),
  );
  return { app, scheduler, queue, controls, metrics };
}

/**
 * Typed handles on the string-keyed collections. The 02D collections and the
 * audit log are keyed by a string `_id`; `DatabaseHandle.collection` is typed
 * for `{ _id: string }` documents already, so only the two raw 02D names need
 * this widening — stated once, here, instead of at every call site.
 */
function healthCollection(): Collection<HealthAggregateDoc> {
  return database.db.collection(HEALTH) as unknown as Collection<HealthAggregateDoc>;
}

function audits(): Collection<AuditDoc> {
  return database.collection<AuditDoc>(COLLECTIONS.audits);
}

/** Plants one published source with a due aggregate row. */
async function plantSource(host: string): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  await database.collection<{ _id: string } & Record<string, unknown>>(COLLECTIONS.sources).insertOne({
    _id: id,
    channelId: randomUUID(),
    provider: 'official-web',
    type: 'hls',
    url: `https://${host}/live/index.m3u8`,
    officialPageUrl: null,
    permission: 'official',
    authorisationEvidence: null,
    conditions: {},
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
  await healthCollection().insertOne({
    _id: id,
    status: 'unknown',
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastOutcome: null,
    lastCheckedAt: null,
    nextCheckAt: new Date(now.getTime() - 60_000),
    circuit: { state: 'closed', openedAt: null, reopenCount: 0 },
    history: [
      // A pre-existing sample: a pause must not erase it.
      { at: now, outcome: 'healthy', cause: null, depth: 'segments', latencyMs: 12, checkId: `${id}:seed` },
    ],
    revision: 0,
    updatedAt: now,
  });
  return id;
}

const skip = !(await mongoAvailable());

beforeAll(async () => {
  if (skip) return;
  harness = await createHarness({ ADMIN_BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN });
  database = harness.context.database;

  // Bootstrap first: it is refused once any administrator exists.
  await request(harness.app)
    .post('/api/v1/auth/bootstrap')
    .send({ email: 'admin-verify@tdt.invalid', password: PASSWORD, bootstrapToken: BOOTSTRAP_TOKEN, roles: ['admin'] })
    .expect(201);

  // Then the editor, whose 403 proves these endpoints are administrator-only.
  const adminClient = new MongoClient(TEST_MONGO_URI);
  try {
    await adminClient.connect();
    await adminClient
      .db(harness.databaseName)
      .collection<AdminUserDoc>(COLLECTIONS.admins)
      .insertOne({
        _id: randomUUID(),
        email: EDITOR_EMAIL,
        passwordHash: await hashPassword(PASSWORD),
        roles: ['editor'],
        disabled: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        lastLoginAt: null,
      });
  } finally {
    await adminClient.close();
  }

  const adminLogin = await request(harness.app)
    .post('/api/v1/auth/login')
    .send({ email: 'admin-verify@tdt.invalid', password: PASSWORD })
    .expect(200);
  adminToken = adminLogin.body.data.token as string;

  const editorLogin = await request(harness.app)
    .post('/api/v1/auth/login')
    .send({ email: EDITOR_EMAIL, password: PASSWORD })
    .expect(200);
  editorToken = editorLogin.body.data.token as string;

  await mountVerificationRoutes(harness).then((mountedRoutes) => {
    mounted = mountedRoutes;
    operatorApp = mountedRoutes.app;
  });
}, 120_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  if (skip) return;
  for (const name of [CHECKS, HEALTH, POLICIES, COLLECTIONS.audits, COLLECTIONS.sources]) {
    await database.db.collection(name).deleteMany({});
  }
});

const admin = () => ({ Authorization: `Bearer ${adminToken}` });
const editor = () => ({ Authorization: `Bearer ${editorToken}` });

describe.skipIf(skip)('verification operator endpoints', () => {
  it('is not reachable from the real application until the captain wires it', async () => {
    // Proof the router is not mounted publicly: the real app 404s the path.
    const unwired = await request(harness.app).get('/api/v1/admin/verification/status').set(admin());
    expect(unwired.status).toBe(404);
  });

  it('refuses an anonymous caller with 401 on every route', async () => {
    for (const path of [
      '/api/v1/admin/verification/status',
      '/api/v1/admin/verification/metrics',
    ]) {
      const response = await request(operatorApp).get(path);
      expect(response.status).toBe(401);
    }
    for (const path of [
      '/api/v1/admin/verification/pause-all',
      '/api/v1/admin/verification/resume-all',
    ]) {
      const response = await request(operatorApp).post(path).send({});
      expect(response.status).toBe(401);
    }
  });

  it('refuses an editor with 403: operator controls are administrator-only', async () => {
    const sourceId = await plantSource('forbidden.test.invalid');
    const status = await request(operatorApp).get('/api/v1/admin/verification/status').set(editor());
    expect(status.status).toBe(403);
    const pause = await request(operatorApp)
      .post(`/api/v1/admin/verification/sources/${sourceId}/pause`)
      .set(editor())
      .send({ reason: 'nope' });
    expect(pause.status).toBe(403);
  });

  it('GET /verification/status aggregates counts by status and failure category', async () => {
    await plantSource('status.test.invalid');
    const response = await request(operatorApp).get('/api/v1/admin/verification/status').set(admin()).expect(200);
    const data = response.body.data as {
      checks: Record<string, number>;
      sources: Record<string, number>;
      failures: Array<{ category: string; count: number }>;
      circuitOpen: number;
      queue: { backend: string; depth: number };
      paused: { all: boolean; providers: string[] };
    };
    expect(data.sources.unknown).toBe(1);
    expect(data.checks).toHaveProperty('pending');
    expect(Array.isArray(data.failures)).toBe(true);
    expect(data.queue.backend).toBe('mongo');
    expect(data.paused.all).toBe(false);
  });

  it('POST pause and resume are audited and keep the history', async () => {
    const sourceId = await plantSource('pausable.test.invalid');

    const pause = await request(operatorApp)
      .post(`/api/v1/admin/verification/sources/${sourceId}/pause`)
      .set(admin())
      .send({ reason: 'provider maintenance' })
      .expect(200);
    expect((pause.body.data as { paused: boolean }).paused).toBe(true);

    const row = await healthCollection().findOne({ _id: sourceId });
    expect(row?.status).toBe('paused');
    // History survives the pause: this is the "pause is not data loss" rule.
    expect(row?.history).toHaveLength(1);

    const audit = await audits().findOne({ action: 'verification.source.pause' });
    expect(audit?.actor.id).toBe('admin-verify@tdt.invalid');
    expect(audit?.reason).toBe('provider maintenance');

    const resume = await request(operatorApp)
      .post(`/api/v1/admin/verification/sources/${sourceId}/resume`)
      .set(admin())
      .send({ reason: 'back to normal' })
      .expect(200);
    expect((resume.body.data as { paused: boolean }).paused).toBe(false);

    const resumed = await healthCollection().findOne({ _id: sourceId });
    expect(resumed?.status).not.toBe('paused');
    expect(resumed?.history).toHaveLength(1);

    const auditRows = await audits()
      .find({ entityType: 'source', entityId: sourceId })
      .toArray();
    expect(auditRows.map((entry) => entry.action).sort()).toEqual([
      'verification.source.pause',
      'verification.source.resume',
    ]);
  });

  it('POST retry requires a reason and writes it to the audit log', async () => {
    const sourceId = await plantSource('retry.test.invalid');

    // Without a reason: refused, and nothing is queued.
    const refused = await request(operatorApp)
      .post(`/api/v1/admin/verification/sources/${sourceId}/retry`)
      .set(admin())
      .send({});
    expect(refused.status).toBe(400);

    const accepted = await request(operatorApp)
      .post(`/api/v1/admin/verification/sources/${sourceId}/retry`)
      .set(admin())
      .send({ reason: 'viewer reported a black screen' })
      .expect(202);
    const data = accepted.body.data as { checkId: string; scheduledFor: string; auditId: string };
    expect(data.checkId.startsWith(`${sourceId}:`)).toBe(true);

    const audit = await audits().findOne({ action: 'verification.source.retry' });
    expect(audit?.reason).toBe('viewer reported a black screen');
  });

  it('POST pause-all and resume-all flip the global switch', async () => {
    await request(operatorApp)
      .post('/api/v1/admin/verification/pause-all')
      .set(admin())
      .send({ reason: 'incident' })
      .expect(200);

    let status = await request(operatorApp).get('/api/v1/admin/verification/status').set(admin()).expect(200);
    expect((status.body.data as { paused: { all: boolean } }).paused.all).toBe(true);

    await request(operatorApp)
      .post('/api/v1/admin/verification/resume-all')
      .set(admin())
      .send({ reason: 'resolved' })
      .expect(200);

    status = await request(operatorApp).get('/api/v1/admin/verification/status').set(admin()).expect(200);
    expect((status.body.data as { paused: { all: boolean } }).paused.all).toBe(false);

    const globalAudits = await audits()
      .find({ entityType: 'global' })
      .toArray();
    expect(globalAudits.map((entry) => entry.action).sort()).toEqual(['verification.pause', 'verification.resume']);
  });

  it('GET /verification/metrics is Prometheus text and never leaks a URL', async () => {
    await plantSource('secret-host.test.invalid');
    // Produce a real observation through the same scheduler the router exposes.
    await mounted.scheduler.runRound(new Date());

    const response = await request(operatorApp)
      .get('/api/v1/admin/verification/metrics')
      .set(admin())
      .expect(200);
    expect(response.headers['content-type']).toContain('text/plain');
    const text = response.text;
    expect(text).toContain('tdt_verification_checks_total');
    expect(text).toContain('tdt_verification_egress_requests_total');
    // The three things that must never appear.
    expect(text).not.toContain('secret-host');
    expect(text).not.toContain('https://');
    expect(text).not.toContain('.m3u8');
  });
});
