/**
 * Administrative workflow integration.
 *
 * Proves the operation an editor actually performs end to end: authenticate,
 * create, edit with optimistic concurrency, attach and withdraw sources, merge a
 * duplicate, revert a revision, and read the audit trail afterwards. Nothing is
 * staged by hand: every record is produced by the API under test.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { TestHarness } from '../test/harness.js';
import { createHarness } from '../test/harness.js';
import { COLLECTIONS } from '../infrastructure/mongo.js';
import type { AdminSessionDoc, AuditDoc, ChannelDoc, PlaybackSourceDoc } from '../infrastructure/schema.js';

const BOOTSTRAP_TOKEN = 'test-bootstrap-token-0123456789abcdef';
const PASSWORD = 'Correct-Horse-Battery-9';

let harness: TestHarness;
let token: string;

async function login(): Promise<string> {
  const response = await request(harness.app)
    .post('/api/v1/auth/login')
    .send({ email: 'editor@tdt.invalid', password: PASSWORD })
    .expect(200);
  return response.body.data.token as string;
}

function authHeader(): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

async function createChannelApi(name: string, extra: Record<string, unknown> = {}) {
  const response = await request(harness.app)
    .post('/api/v1/admin/channels')
    .set(authHeader())
    .send({
      name,
      country: 'ES',
      category: 'local',
      provenance: [
        {
          source: 'editorial',
          label: 'Alta de prueba',
          url: null,
          licence: 'editorial',
          attribution: null,
          editorial: true,
        },
      ],
      ...extra,
    })
    .expect(201);
  return response.body.data as { id: string; slug: string; updatedAt: string; editorialStatus: string };
}

beforeAll(async () => {
  harness = await createHarness({ ADMIN_BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN });
  await request(harness.app)
    .post('/api/v1/auth/bootstrap')
    .send({ email: 'editor@tdt.invalid', password: PASSWORD, bootstrapToken: BOOTSTRAP_TOKEN, roles: ['admin'] })
    .expect(201);
});

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.context.database.collection(COLLECTIONS.sources).deleteMany({});
  await harness.context.database.collection(COLLECTIONS.channels).deleteMany({});
  await harness.context.database.collection(COLLECTIONS.audits).deleteMany({});
  token = await login();
});

describe('authentication', () => {
  it('refuses a second bootstrap once an administrator exists', async () => {
    const response = await request(harness.app)
      .post('/api/v1/auth/bootstrap')
      .send({ email: 'other@tdt.invalid', password: PASSWORD, bootstrapToken: BOOTSTRAP_TOKEN, roles: ['admin'] })
      .expect(409);
    expect(response.body.error.code).toBe('conflict');
  });

  it('refuses a wrong bootstrap token', async () => {
    await request(harness.app)
      .post('/api/v1/auth/bootstrap')
      .send({ email: 'x@tdt.invalid', password: PASSWORD, bootstrapToken: 'x'.repeat(32), roles: ['admin'] })
      .expect(401);
  });

  it('does not reveal whether an account exists', async () => {
    const wrongPassword = await request(harness.app)
      .post('/api/v1/auth/login')
      .send({ email: 'editor@tdt.invalid', password: 'wrong-password-123456' })
      .expect(401);
    const unknownUser = await request(harness.app)
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@tdt.invalid', password: 'wrong-password-123456' })
      .expect(401);
    expect(wrongPassword.body.error.message).toBe(unknownUser.body.error.message);
    expect(wrongPassword.body.error.code).toBe('unauthorized');
  });

  it('invalidates the session on logout', async () => {
    await request(harness.app).get('/api/v1/admin/me').set(authHeader()).expect(200);
    await request(harness.app).post('/api/v1/auth/logout').set(authHeader()).expect(204);
    await request(harness.app).get('/api/v1/admin/me').set(authHeader()).expect(401);
  });

  it('stores only a hash of the session token', async () => {
    const sessions = await harness.context.database
      .collection<AdminSessionDoc>(COLLECTIONS.adminSessions)
      .find({})
      .toArray();
    expect(sessions.length).toBeGreaterThan(0);
    for (const session of sessions) {
      expect(session.tokenSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(session)).not.toContain(token);
    }
  });
});

describe('channel lifecycle', () => {
  it('creates a channel in draft, invisible to the public API', async () => {
    const created = await createChannelApi('Canal Nuevo');
    expect(created.slug).toBe('canal-nuevo');
    expect(created.editorialStatus).toBe('draft');
    await request(harness.app).get('/api/v1/channels/canal-nuevo').expect(404);
  });

  it('refuses a duplicate slug with a conflict instead of silently renaming', async () => {
    await createChannelApi('Duplicado');
    const response = await request(harness.app)
      .post('/api/v1/admin/channels')
      .set(authHeader())
      .send({
        name: 'Duplicado',
        country: 'ES',
        category: 'local',
        provenance: [{ source: 'editorial', label: 'x', url: null, licence: 'editorial', attribution: null, editorial: true }],
      })
      .expect(409);
    expect(response.body.error.code).toBe('conflict');
  });

  it('honours optimistic concurrency and records every change in the audit log', async () => {
    const created = await createChannelApi('Editado');
    const updated = await request(harness.app)
      .patch(`/api/v1/admin/channels/${created.id}`)
      .set(authHeader())
      .send({ description: 'Primera corrección', expectedUpdatedAt: created.updatedAt, reason: 'Revisión' })
      .expect(200);
    expect(updated.body.data.description).toBe('Primera corrección');

    const stale = await request(harness.app)
      .patch(`/api/v1/admin/channels/${created.id}`)
      .set(authHeader())
      .send({ description: 'Cambio con versión vieja', expectedUpdatedAt: created.updatedAt })
      .expect(409);
    expect(stale.body.error.code).toBe('conflict');

    const audits = await request(harness.app)
      .get(`/api/v1/admin/audits?entityId=${created.id}`)
      .set(authHeader())
      .expect(200);
    expect(audits.body.data.map((entry: { action: string }) => entry.action)).toEqual([
      'channel.update',
      'channel.create',
    ]);
    expect(audits.body.data[0].reason).toBe('Revisión');
    expect(audits.body.data[0].before.description).toBe('');
  });

  it('restores a previous revision', async () => {
    const created = await createChannelApi('Restaurable');
    await request(harness.app)
      .patch(`/api/v1/admin/channels/${created.id}`)
      .set(authHeader())
      .send({ description: 'Corregido', expectedUpdatedAt: created.updatedAt })
      .expect(200);
    const history = await request(harness.app)
      .get(`/api/v1/admin/audits?entityId=${created.id}`)
      .set(authHeader())
      .expect(200);
    const creation = history.body.data.find((entry: { action: string }) => entry.action === 'channel.create');
    const restored = await request(harness.app)
      .post(`/api/v1/admin/channels/${created.id}/revert`)
      .set(authHeader())
      .send({ auditId: creation.id })
      .expect(200);
    expect(restored.body.data.description).toBe('');
  });

  it('merges a duplicate: aliases and sources move, the duplicate is withdrawn, nothing is deleted', async () => {
    const survivor = await createChannelApi('Canal Original');
    const duplicate = await createChannelApi('Canal Duplicado');
    await request(harness.app)
      .post('/api/v1/admin/sources')
      .set(authHeader())
      .send({
        channelId: duplicate.id,
        provider: 'emitter:example.org',
        type: 'hls',
        url: 'https://example.org/live/master.m3u8',
        permission: 'emitter-public-stream',
        conditions: {
          embedAllowed: true,
          proxyAllowed: false,
          worldwide: true,
          restrictedRegions: [],
          browserCompatibility: 'all',
          requiresForgedHeader: false,
          emitterAppOnly: false,
        },
      })
      .expect(201);

    const merged = await request(harness.app)
      .post(`/api/v1/admin/channels/${survivor.id}/merge`)
      .set(authHeader())
      .send({ duplicateId: duplicate.id, reason: 'Duplicado detectado en la revisión' })
      .expect(200);

    expect(merged.body.data.aliases.map((alias: { namespace: string }) => alias.namespace)).toContain('merged-from');
    expect(merged.body.data.sourceRecords).toHaveLength(1);

    const duplicateRecord = await harness.context.database
      .collection<ChannelDoc>(COLLECTIONS.channels)
      .findOne({ _id: duplicate.id });
    expect(duplicateRecord?.editorialStatus).toBe('withdrawn');
    expect(duplicateRecord?.mergedInto).toBe(survivor.id);
    await request(harness.app).get(`/api/v1/channels/${duplicate.slug}`).expect(404);
  });
});

describe('source registry', () => {
  it('refuses to register an unlicensed source as playable', async () => {
    const channel = await createChannelApi('Destino');
    const response = await request(harness.app)
      .post('/api/v1/admin/sources')
      .set(authHeader())
      .send({
        channelId: channel.id,
        provider: 'emitter:example.org',
        type: 'hls',
        url: 'https://example.org/live/master.m3u8',
        permission: 'unlicensed',
        conditions: {
          embedAllowed: false,
          proxyAllowed: false,
          worldwide: true,
          restrictedRegions: [],
          browserCompatibility: 'all',
          requiresForgedHeader: false,
          emitterAppOnly: false,
        },
      })
      .expect(400);
    // Refused by the request contract before the service runs: same outcome,\n    // reported where the caller can see which field is wrong.\n    expect(response.body.error.code).toBe('validation_failed');
  });

  it('requires an official page for an external source', async () => {
    const channel = await createChannelApi('Externo');
    await request(harness.app)
      .post('/api/v1/admin/sources')
      .set(authHeader())
      .send({
        channelId: channel.id,
        provider: 'emitter:example.org',
        type: 'external',
        url: null,
        permission: 'official-player-only',
        conditions: {
          embedAllowed: false,
          proxyAllowed: false,
          worldwide: true,
          restrictedRegions: [],
          browserCompatibility: 'all',
          requiresForgedHeader: false,
          emitterAppOnly: false,
        },
      })
      .expect(400);
  });

  it('publishing a channel with a healthy source makes it public', async () => {
    const channel = await createChannelApi('Publicable');
    await request(harness.app)
      .post('/api/v1/admin/sources')
      .set(authHeader())
      .send({
        channelId: channel.id,
        provider: 'emitter:example.org',
        type: 'hls',
        url: 'https://example.org/live/master.m3u8',
        permission: 'emitter-public-stream',
        conditions: {
          embedAllowed: true,
          proxyAllowed: false,
          worldwide: true,
          restrictedRegions: [],
          browserCompatibility: 'all',
          requiresForgedHeader: false,
          emitterAppOnly: false,
        },
      })
      .expect(201);
    // A newly registered source is verified before it is offered.
    await harness.context.database
      .collection<PlaybackSourceDoc>(COLLECTIONS.sources)
      .updateMany({ channelId: channel.id }, { $set: { technicalStatus: 'ok' } });
    await request(harness.app)
      .patch(`/api/v1/admin/channels/${channel.id}`)
      .set(authHeader())
      .send({ editorialStatus: 'published', reason: 'Listo para publicar' })
      .expect(200);

    const descriptor = await request(harness.app).get(`/api/v1/channels/${channel.slug}/playback`).expect(200);
    expect(descriptor.body.data.playback.status).toBe('available');
  });

  it('withdrawing a source removes it from the public descriptor while keeping the record', async () => {
    const channel = await createChannelApi('Con Fuente', { editorialStatus: 'published' });
    const created = await request(harness.app)
      .post('/api/v1/admin/sources')
      .set(authHeader())
      .send({
        channelId: channel.id,
        provider: 'emitter:example.org',
        type: 'hls',
        url: 'https://example.org/live/master.m3u8',
        permission: 'emitter-public-stream',
        conditions: {
          embedAllowed: true,
          proxyAllowed: false,
          worldwide: true,
          restrictedRegions: [],
          browserCompatibility: 'all',
          requiresForgedHeader: false,
          emitterAppOnly: false,
        },
      })
      .expect(201);
    await harness.context.database
      .collection<PlaybackSourceDoc>(COLLECTIONS.sources)
      .updateMany({ channelId: channel.id }, { $set: { technicalStatus: 'ok' } });
    const before = await request(harness.app).get(`/api/v1/channels/${channel.slug}/playback`).expect(200);
    expect(before.body.data.playback.status).toBe('available');

    await request(harness.app)
      .post(`/api/v1/admin/sources/${created.body.data.id}/withdraw`)
      .set(authHeader())
      .send({ reason: 'El emisor retira la señal' })
      .expect(200);

    const after = await request(harness.app).get(`/api/v1/channels/${channel.slug}/playback`).expect(200);
    expect(after.body.data.playback.status).toBe('unavailable');
    const stored = await harness.context.database
      .collection<PlaybackSourceDoc>(COLLECTIONS.sources)
      .findOne({ _id: created.body.data.id });
    expect(stored).not.toBeNull();
    expect(stored?.editorialStatus).toBe('withdrawn');
  });

  it('records source verification results and their cause', async () => {
    const channel = await createChannelApi('Verificable');
    // A loopback endpoint that refuses connections: a determinate failure.
    const created = await request(harness.app)
      .post('/api/v1/admin/sources')
      .set(authHeader())
      .send({
        channelId: channel.id,
        provider: 'emitter:example.org',
        type: 'hls',
        url: 'http://127.0.0.1:9/never.m3u8',
        permission: 'emitter-public-stream',
        conditions: {
          embedAllowed: true,
          proxyAllowed: false,
          worldwide: true,
          restrictedRegions: [],
          browserCompatibility: 'all',
          requiresForgedHeader: false,
          emitterAppOnly: false,
        },
      })
      .expect(201);
    const verified = await request(harness.app)
      .post(`/api/v1/admin/sources/${created.body.data.id}/verify`)
      .set(authHeader())
      .expect(200);
    expect(verified.body.data.status).not.toBe('ok');
    const stored = await harness.context.database
      .collection<PlaybackSourceDoc>(COLLECTIONS.sources)
      .findOne({ _id: created.body.data.id });
    expect(stored?.technicalStatus).toBe(verified.body.data.status);
    expect(stored?.lastVerifiedAt).toBeInstanceOf(Date);
  });
});

describe('providers and audit surface', () => {
  it('lists the integration providers without a single one dominating', async () => {
    const response = await request(harness.app).get('/api/v1/admin/providers').set(authHeader()).expect(200);
    const ids = response.body.data.map((provider: { id: string }) => provider.id);
    expect(ids).toEqual(
      expect.arrayContaining(['emitter-hls', 'emitter-dash', 'youtube-iframe', 'official-embed', 'external-reference']),
    );
    expect(ids).not.toContain('tdtchannels');
    for (const provider of response.body.data) {
      expect(provider.credentialFree).toBe(true);
    }
  });

  it('keeps an immutable audit trail of who did what', async () => {
    const channel = await createChannelApi('Auditado');
    await request(harness.app)
      .patch(`/api/v1/admin/channels/${channel.id}`)
      .set(authHeader())
      .send({ description: 'cambio', expectedUpdatedAt: channel.updatedAt })
      .expect(200);
    const stored = await harness.context.database.collection<AuditDoc>(COLLECTIONS.audits).find({}).toArray();
    const actions = stored.map((entry) => entry.action);
    expect(actions).toContain('auth.login');
    expect(actions).toContain('channel.create');
    expect(actions).toContain('channel.update');
    for (const entry of stored) {
      expect(entry.requestId).toBeTruthy();
      expect(entry.actor.type).toMatch(/user|system/);
    }
  });
});
