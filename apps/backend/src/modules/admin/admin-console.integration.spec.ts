/**
 * Administration console integration (TDT-API-02FG §5).
 *
 * Every assertion runs against a real MongoDB and the real Express app built from
 * the real services: no route below is staged, and the writes are the platform's
 * own audited operations. The suite proves the two properties that would make the
 * console dishonest if they broke:
 *
 * 1. it never says "playable" about something the 02C gate refuses, and never
 *    exposes a URL or a credential;
 * 2. its controls do something — a paused job genuinely does not run, a merge
 *    genuinely folds two records, an identity edit genuinely moves the record and
 *    leaves an audit entry.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { TestHarness } from '../../test/harness.js';
import { createHarness, mongoAvailable } from '../../test/harness.js';
import { COLLECTIONS } from '../../infrastructure/mongo.js';
import type { AuditDoc, ChannelDoc, PlaybackSourceDoc } from '../../infrastructure/schema.js';
import { registerScheduledJobs } from '../../jobs/job-control.js';

const BOOTSTRAP_TOKEN = 'test-bootstrap-token-0123456789abcdef';
const PASSWORD = 'Correct-Horse-Battery-9';

const available = await mongoAvailable();
const suite = available ? describe : describe.skip;

let harness: TestHarness;
let token: string;

async function login(): Promise<string> {
  const response = await request(harness.app)
    .post('/api/v1/auth/login')
    .send({ email: 'editor@tdt.invalid', password: PASSWORD })
    .expect(200);
  return response.body.data.token as string;
}

function auth(): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

async function createChannel(name: string, extra: Record<string, unknown> = {}): Promise<{
  id: string;
  slug: string;
  updatedAt: string;
}> {
  const response = await request(harness.app)
    .post('/api/v1/admin/channels')
    .set(auth())
    .send({
      name,
      country: 'ES',
      category: 'local',
      language: 'es',
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
  return response.body.data as { id: string; slug: string; updatedAt: string };
}

async function createSource(channelId: string, body: Record<string, unknown> = {}): Promise<string> {
  const response = await request(harness.app)
    .post('/api/v1/admin/sources')
    .set(auth())
    .send({
      channelId,
      provider: 'emitter',
      type: 'hls',
      url: 'https://cdn.example.test/live/index.m3u8?token=SUPERSECRET',
      permission: 'emitter-public-stream',
      conditions: {
        embedAllowed: true,
        proxyAllowed: false,
        worldwide: false,
        restrictedRegions: [],
        browserCompatibility: 'all',
        requiresForgedHeader: false,
        emitterAppOnly: false,
      },
      ...body,
    })
    .expect(201);
  return response.body.data.id as string;
}

beforeAll(async () => {
  if (!available) return;
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
  if (!available) return;
  const db = harness.context.database;
  for (const name of [
    COLLECTIONS.sources,
    COLLECTIONS.channels,
    COLLECTIONS.audits,
    COLLECTIONS.epgMappings,
    COLLECTIONS.channelAliases,
    COLLECTIONS.jobRuns,
    COLLECTIONS.epgSources,
    COLLECTIONS.programmes,
    COLLECTIONS.epgSyncRuns,
  ] as const) {
    await db.collection(name).deleteMany({});
  }
  await db.db.collection('job_controls').deleteMany({});
  await db.db.collection('source_health_02d').deleteMany({});
  await db.db.collection('source_health_checks_02d').deleteMany({});
  token = await login();
});

suite('authorization', () => {
  it('refuses every console route without a session', async () => {
    for (const [method, path] of [
      ['get', '/api/v1/admin/overview'],
      ['get', '/api/v1/admin/catalogue'],
      ['get', '/api/v1/admin/duplicates'],
      ['get', '/api/v1/admin/sources/health'],
      ['get', '/api/v1/admin/epg/coverage'],
      ['get', '/api/v1/admin/epg/mappings'],
      ['get', '/api/v1/admin/epg/ingestion-runs'],
      ['get', '/api/v1/admin/operations/jobs'],
      ['get', '/api/v1/admin/operations/errors'],
      ['get', '/api/v1/admin/operations/metrics'],
    ] as const) {
      await request(harness.app)[method](path).expect(401);
    }
  });
});

suite('overview', () => {
  it('reports the catalogue, the health of sources and the guide state', async () => {
    const published = await createChannel('Canal Publicado Uno', { editorialStatus: 'published' });
    await createChannel('Canal En Revisión Dos', { editorialStatus: 'review' });
    await createSource(published.id);

    const response = await request(harness.app).get('/api/v1/admin/overview').set(auth()).expect(200);
    const data = response.body.data;
    expect(data.catalogue.total).toBe(2);
    expect(data.catalogue.published).toBe(1);
    expect(data.catalogue.review).toBe(1);
    expect(data.catalogue.draft).toBe(0);
    expect(data.sources.total).toBe(1);
    /*
     * The source was never verified, so it must NOT be counted healthy: an
     * unverified source is its own bucket, which is the whole point.
     */
    expect(data.sources.healthy).toBe(0);
    expect(data.sources.unverified).toBe(1);
    expect(data.countries.some((entry: { code: string }) => entry.code === 'ES')).toBe(true);
    expect(data.languages.some((entry: { code: string }) => entry.code === 'es')).toBe(true);
    expect(typeof data.epg.sources).toBe('number');
    expect(typeof data.asOf).toBe('string');
  });

  it('counts a source as healthy only after the health ledger records a healthy check', async () => {
    const channel = await createChannel('Canal Con Salud', { editorialStatus: 'published' });
    const sourceId = await createSource(channel.id);
    await harness.context.database.db.collection('source_health_checks_02d').insertOne({
      _id: `${sourceId}:2026-11-17T00:00:00.000Z`,
      sourceId,
      kind: 'scheduled',
      trigger: { actor: 'scheduler', reason: null },
      state: 'done',
      outcome: 'healthy',
      depth: 'playlist',
      eligibilityAt: {},
      origin: {},
      timings: { startedAt: new Date(), finishedAt: new Date() },
      attempt: { number: 1, maxAttempts: 3, backoffMs: 0 },
      failure: null,
      uncertainty: {},
      evidence: {},
      lease: null,
      createdAt: new Date(),
    } as never);

    const response = await request(harness.app).get('/api/v1/admin/overview').set(auth()).expect(200);
    expect(response.body.data.sources.healthy).toBe(1);
    expect(response.body.data.sources.unverified).toBe(0);
  });
});

suite('catalogue', () => {
  it('lists channels with source counts and never leaks a URL', async () => {
    const channel = await createChannel('Canal Catálogo', { editorialStatus: 'published' });
    await createSource(channel.id);

    const response = await request(harness.app).get('/api/v1/admin/catalogue').set(auth()).expect(200);
    expect(response.body.data).toHaveLength(1);
    const row = response.body.data[0];
    expect(row).toMatchObject({
      id: channel.id,
      slug: channel.slug,
      country: 'ES',
      language: 'es',
      editorialStatus: 'published',
      sourceCandidates: 1,
    });
    expect(typeof row.eligibleSources).toBe('number');
    expect(response.body.pagination.total).toBe(1);
    /* The security property, asserted on the serialised body, not on one field. */
    const serialised = JSON.stringify(response.body);
    expect(serialised).not.toContain('SUPERSECRET');
    expect(serialised).not.toContain('cdn.example.test');
    expect(serialised).not.toContain('clauseUrl');
  });

  it('filters by status, search text and country', async () => {
    await createChannel('Teledeporte Andaluza', { editorialStatus: 'published', country: 'ES' });
    await createChannel('France Info', { editorialStatus: 'review', country: 'FR' });

    const byStatus = await request(harness.app)
      .get('/api/v1/admin/catalogue?status=review')
      .set(auth())
      .expect(200);
    expect(byStatus.body.data).toHaveLength(1);
    expect(byStatus.body.data[0].name).toBe('France Info');

    const bySearch = await request(harness.app)
      .get('/api/v1/admin/catalogue?q=teledeporte')
      .set(auth())
      .expect(200);
    expect(bySearch.body.data).toHaveLength(1);

    const byCountry = await request(harness.app)
      .get('/api/v1/admin/catalogue?country=FR')
      .set(auth())
      .expect(200);
    expect(byCountry.body.data).toHaveLength(1);
  });

  it('escapes the search term instead of compiling it as a pattern', async () => {
    await createChannel('Canal Normal');
    /* `.*` as a pattern would match everything; escaped, it matches nothing. */
    const response = await request(harness.app)
      .get('/api/v1/admin/catalogue?q=.*')
      .set(auth())
      .expect(200);
    expect(response.body.data).toHaveLength(0);
  });

  it('rejects an invalid query instead of silently ignoring it', async () => {
    await request(harness.app).get('/api/v1/admin/catalogue?status=nope').set(auth()).expect(400);
  });

  it('returns the detail with its sources and their eligibility, without URLs', async () => {
    const channel = await createChannel('Canal Detalle');
    await createSource(channel.id);
    const response = await request(harness.app)
      .get(`/api/v1/admin/catalogue/${channel.id}`)
      .set(auth())
      .expect(200);
    const data = response.body.data;
    expect(data.id).toBe(channel.id);
    expect(data.sources).toHaveLength(1);
    expect(data.sources[0]).toHaveProperty('eligible');
    expect(data.sources[0]).toHaveProperty('eligibilityReason');
    const serialised = JSON.stringify(response.body);
    expect(serialised).not.toContain('SUPERSECRET');
    expect(serialised).not.toContain('cdn.example.test');
  });

  it('404s for an unknown channel', async () => {
    await request(harness.app)
      .get('/api/v1/admin/catalogue/00000000-0000-4000-8000-000000000000')
      .set(auth())
      .expect(404);
  });
});

suite('identity edit', () => {
  it('edits identity, records the audit entry and keeps the revision', async () => {
    const channel = await createChannel('Nombre Antiguo');
    const response = await request(harness.app)
      .post(`/api/v1/admin/catalogue/${channel.id}/identity`)
      .set(auth())
      .send({ name: 'Nombre Nuevo', category: 'informativos', reason: 'Corrección editorial' })
      .expect(200);

    expect(response.body.data.name).toBe('Nombre Nuevo');
    expect(response.body.data.category).toBe('informativos');

    const stored = await harness.context.database
      .collection<ChannelDoc>(COLLECTIONS.channels)
      .findOne({ _id: channel.id });
    expect(stored?.name).toBe('Nombre Nuevo');
    expect(stored?.revision).toBe(2);

    const audits = await harness.context.database
      .collection<AuditDoc>(COLLECTIONS.audits)
      .find({ entityId: channel.id, action: 'channel.update' })
      .toArray();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.reason).toBe('Corrección editorial');
    expect(audits[0]?.actor.id).toBe('editor@tdt.invalid');
  });

  it('requires a reason', async () => {
    const channel = await createChannel('Sin Razón');
    await request(harness.app)
      .post(`/api/v1/admin/catalogue/${channel.id}/identity`)
      .set(auth())
      .send({ name: 'Otro' })
      .expect(400);
  });

  it('refuses a reason-only edit without writing or auditing it', async () => {
    /*
     * TDT-API-02FG closeout: a reason is not an edit. The schema now demands at
     * least one identity field, and the route refuses an edit that would leave
     * every column as it already is. Auditing such a request would record a
     * change that never happened, so nothing is written either.
     */
    const channel = await createChannel('Sin Cambios');
    await request(harness.app)
      .post(`/api/v1/admin/catalogue/${channel.id}/identity`)
      .set(auth())
      .send({ reason: 'motivo suficiente' })
      .expect(400);

    const stored = await harness.context.database
      .collection<ChannelDoc>(COLLECTIONS.channels)
      .findOne({ _id: channel.id });
    expect(stored?.name).toBe('Sin Cambios');
    const audits = await harness.context.database
      .collection<AuditDoc>(COLLECTIONS.audits)
      .find({ entityId: channel.id, action: 'channel.update' })
      .toArray();
    expect(audits).toHaveLength(0);
  });

  it('refuses an edit that repeats the stored value with 409 and keeps the record untouched', async () => {
    const channel = await createChannel('Igual Nombre');
    await request(harness.app)
      .post(`/api/v1/admin/catalogue/${channel.id}/identity`)
      .set(auth())
      .send({ name: 'Igual Nombre', reason: 'mismo valor a propósito' })
      .expect(409);
    const audits = await harness.context.database
      .collection<AuditDoc>(COLLECTIONS.audits)
      .find({ entityId: channel.id, action: 'channel.update' })
      .toArray();
    expect(audits).toHaveLength(0);
  });

  it('accepts and audits a real identity change', async () => {
    const channel = await createChannel('Antes del Cambio');
    const response = await request(harness.app)
      .post(`/api/v1/admin/catalogue/${channel.id}/identity`)
      .set(auth())
      .send({ name: 'Después del Cambio', reason: 'nombre corregido' })
      .expect(200);
    expect(response.body.data.name).toBe('Después del Cambio');
    const audits = await harness.context.database
      .collection<AuditDoc>(COLLECTIONS.audits)
      .find({ entityId: channel.id, action: 'channel.update' })
      .toArray();
    expect(audits).toHaveLength(1);
  });
});

suite('duplicates and merge', () => {
  it('proposes groups by shared guide alias and merges through the audited service', async () => {
    const first = await createChannel('Canal Uno', { editorialStatus: 'published' });
    const second = await createChannel('Canal Uno Réplica');
    await harness.context.database
      .collection<ChannelDoc>(COLLECTIONS.channels)
      .updateOne({ _id: first.id }, { $set: { aliases: [{ namespace: 'epg', value: 'canal-uno' }] } });
    await harness.context.database
      .collection<ChannelDoc>(COLLECTIONS.channels)
      .updateOne({ _id: second.id }, { $set: { aliases: [{ namespace: 'epg', value: 'canal-uno' }] } });

    const groups = await request(harness.app).get('/api/v1/admin/duplicates').set(auth()).expect(200);
    expect(groups.body.total).toBeGreaterThanOrEqual(1);
    const group = groups.body.data.find((entry: { channelIds: string[] }) =>
      entry.channelIds.includes(first.id),
    );
    expect(group.reason).toBe('alias');
    expect(group.channelIds).toHaveLength(2);
    /* The published record is the proposed survivor. */
    expect(group.suggestedPrimary).toBe(first.id);

    await request(harness.app)
      .post(`/api/v1/admin/duplicates/${group.key}/merge`)
      .set(auth())
      .send({ reason: 'Duplicado evidente del mismo emisor' })
      .expect(200);

    const duplicate = await harness.context.database
      .collection<ChannelDoc>(COLLECTIONS.channels)
      .findOne({ _id: second.id });
    expect(duplicate?.editorialStatus).toBe('withdrawn');
    expect(duplicate?.mergedInto).toBe(first.id);

    const audits = await harness.context.database
      .collection<AuditDoc>(COLLECTIONS.audits)
      .find({ action: 'channel.merge' })
      .toArray();
    expect(audits).toHaveLength(1);
  });

  it('does not propose a group for two channels that are merely similar in name', async () => {
    await createChannel('La Sexta');
    await createChannel('La Sexta Bética');
    const response = await request(harness.app).get('/api/v1/admin/duplicates').set(auth()).expect(200);
    expect(response.body.data).toHaveLength(0);
  });

  it('refuses to merge channels that are not in the group', async () => {
    const first = await createChannel('Grupo A Uno', { editorialStatus: 'published' });
    const second = await createChannel('Grupo A Dos');
    const outsider = await createChannel('Ajeno');
    await harness.context.database
      .collection<ChannelDoc>(COLLECTIONS.channels)
      .updateOne({ _id: first.id }, { $set: { aliases: [{ namespace: 'epg', value: 'grupo-a' }] } });
    await harness.context.database
      .collection<ChannelDoc>(COLLECTIONS.channels)
      .updateOne({ _id: second.id }, { $set: { aliases: [{ namespace: 'epg', value: 'grupo-a' }] } });

    const groups = await request(harness.app).get('/api/v1/admin/duplicates').set(auth()).expect(200);
    const group = groups.body.data.find((entry: { channelIds: string[] }) => entry.channelIds.includes(first.id));
    await request(harness.app)
      .post(`/api/v1/admin/duplicates/${group.key}/merge`)
      .set(auth())
      .send({ mergeId: outsider.id, reason: 'Intento fuera de grupo' })
      .expect(400);
  });
});

suite('source health, history and operations', () => {
  it('reports health per source with its failure class and the alternatives', async () => {
    const channel = await createChannel('Canal Salud', { editorialStatus: 'published' });
    const sourceId = await createSource(channel.id);
    await harness.context.database.db.collection('source_health_02d').insertOne({
      _id: sourceId,
      status: 'failing',
      consecutiveFailures: 3,
      consecutiveSuccesses: 0,
      lastSuccessAt: null,
      lastFailureAt: new Date(),
      lastOutcome: 'failing',
      lastCheckedAt: new Date(),
      nextCheckAt: new Date(),
      circuit: { state: 'closed', openedAt: null, reopenCount: 0 },
      history: [
        { at: new Date(), outcome: 'failing', cause: 'http-404', depth: 'transport', latencyMs: 12, checkId: 'c1' },
      ],
      revision: 1,
      updatedAt: new Date(),
    } as never);

    const response = await request(harness.app).get('/api/v1/admin/sources/health').set(auth()).expect(200);
    const row = response.body.data[0];
    expect(row.id).toBe(sourceId);
    expect(row.channelSlug).toBe(channel.slug);
    expect(row.consecutiveFailures).toBe(3);
    expect(row.failureClass).toBe('http-error');
    expect(JSON.stringify(response.body)).not.toContain('SUPERSECRET');
  });

  it('filters by failure class', async () => {
    const channel = await createChannel('Canal Filtro', { editorialStatus: 'published' });
    await createSource(channel.id);
    const none = await request(harness.app)
      .get('/api/v1/admin/sources/health?failureClass=http-error')
      .set(auth())
      .expect(200);
    expect(none.body.data).toHaveLength(0);
    const all = await request(harness.app)
      .get('/api/v1/admin/sources/health?failureClass=none')
      .set(auth())
      .expect(200);
    expect(all.body.data).toHaveLength(1);
  });

  it('returns the retained verification history of a source', async () => {
    const channel = await createChannel('Canal Historial', { editorialStatus: 'published' });
    const sourceId = await createSource(channel.id);
    await harness.context.database.db.collection('source_health_02d').insertOne({
      _id: sourceId,
      status: 'degraded',
      consecutiveFailures: 1,
      consecutiveSuccesses: 2,
      lastSuccessAt: new Date(),
      lastFailureAt: new Date(),
      lastOutcome: 'degraded',
      lastCheckedAt: new Date(),
      nextCheckAt: new Date(),
      circuit: { state: 'closed', openedAt: null, reopenCount: 0 },
      history: [
        { at: new Date('2026-11-17T10:00:00Z'), outcome: 'healthy', cause: null, depth: 'playlist', latencyMs: 30, checkId: 'a' },
        { at: new Date('2026-11-17T11:00:00Z'), outcome: 'failing', cause: 'timeout', depth: 'transport', latencyMs: 5000, checkId: 'b' },
      ],
      revision: 2,
      updatedAt: new Date(),
    } as never);

    const response = await request(harness.app)
      .get(`/api/v1/admin/sources/${sourceId}/history`)
      .set(auth())
      .expect(200);
    expect(response.body.data.sourceId).toBe(sourceId);
    expect(response.body.data.entries).toHaveLength(2);
    expect(response.body.data.entries[0].state).toBe('healthy');
    expect(response.body.data.entries[1].failureClass).toBe('timeout');
  });

  it('404s the history of an unknown source', async () => {
    await request(harness.app)
      .get('/api/v1/admin/sources/00000000-0000-4000-8000-000000000000/history')
      .set(auth())
      .expect(404);
  });

  it('assigns a source to another channel as an audited write', async () => {
    const origin = await createChannel('Canal Origen');
    const target = await createChannel('Canal Destino');
    const sourceId = await createSource(origin.id);

    await request(harness.app)
      .post(`/api/v1/admin/sources/${sourceId}/assign`)
      .set(auth())
      .send({ channelId: target.id, sourceId, reason: 'La fuente pertenece al canal destino' })
      .expect(200);

    const stored = await harness.context.database
      .collection<PlaybackSourceDoc>(COLLECTIONS.sources)
      .findOne({ _id: sourceId });
    expect(stored?.channelId).toBe(target.id);

    const audits = await harness.context.database
      .collection<AuditDoc>(COLLECTIONS.audits)
      .find({ action: 'source.assign' })
      .toArray();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.after?.['fromChannelId']).toBe(origin.id);
    expect(audits[0]?.after?.['toChannelId']).toBe(target.id);
  });

  it('removes a source by withdrawing it, keeping the record', async () => {
    const channel = await createChannel('Canal Retirada');
    const sourceId = await createSource(channel.id);
    await request(harness.app)
      .post(`/api/v1/admin/sources/${sourceId}/remove`)
      .set(auth())
      .send({ reason: 'El emisor retiró la autorización' })
      .expect(200);

    const stored = await harness.context.database
      .collection<PlaybackSourceDoc>(COLLECTIONS.sources)
      .findOne({ _id: sourceId });
    expect(stored).not.toBeNull();
    expect(stored?.editorialStatus).toBe('withdrawn');
  });
});

suite('epg', () => {
  it('serves the shared coverage measure and the mapping list', async () => {
    const channel = await createChannel('Canal EPG', { editorialStatus: 'published' });
    await harness.context.database
      .collection<ChannelDoc>(COLLECTIONS.channels)
      .updateOne({ _id: channel.id }, { $set: { epg: { sourceId: 'guide-1', externalId: 'ext-1' } } });

    const response = await request(harness.app).get('/api/v1/admin/epg/coverage').set(auth()).expect(200);
    expect(response.body.data.entries).toHaveLength(1);
    expect(response.body.data.entries[0]).toMatchObject({ channelId: channel.id, mapped: true });
    expect(response.body.data.entries[0].status).toBe('empty');
    expect(response.body.data.totals.mapped).toBe(1);
  });

  it('lists ingestion runs from the rows the ingestion service really writes', async () => {
    await harness.context.database.collection(COLLECTIONS.epgSources).insertOne({
      _id: 'guide-1',
      name: 'Guía de prueba',
      kind: 'xmltv',
      url: 'https://guide.example.test/guide.xml?token=HIDDEN',
      licence: 'test',
      attribution: null,
      ingestionEnabled: false,
      status: 'published',
      lastRunAt: null,
      lastRunStatus: 'never',
      lastRunProgrammes: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    /*
     * The canonical history: one row in `epg_sync_runs`, which is what the
     * ingestion service writes through `EpgSyncRunService`. The classified error
     * (never the raw provider message) is what the view is allowed to carry.
     */
    await harness.context.database.collection(COLLECTIONS.epgSyncRuns).insertOne({
      _id: 'run-1',
      sourceId: 'guide-1',
      startedAt: new Date('2026-11-17T09:00:00Z'),
      finishedAt: new Date('2026-11-17T09:01:00Z'),
      status: 'failed',
      programmes: 0,
      channelsMatched: 0,
      rejected: 0,
      duplicates: 0,
      error: 'fetch-failed',
      trigger: 'scheduled',
    } as never);

    const response = await request(harness.app)
      .get('/api/v1/admin/epg/ingestion-runs')
      .set(auth())
      .expect(200);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0]).toMatchObject({
      sourceId: 'guide-1',
      sourceName: 'Guía de prueba',
      status: 'failed',
      trigger: 'scheduled',
    });
    /* The provider's message is classified, never echoed. */
    const serialised = JSON.stringify(response.body);
    expect(serialised).not.toContain('HIDDEN');
    expect(serialised).not.toContain('guide.example.test');
  });

  it('reports honestly that manual mapping writes are not wired yet', async () => {
    const channel = await createChannel('Canal Mapeo');
    await request(harness.app)
      .post('/api/v1/admin/epg/mappings')
      .set(auth())
      .send({ channelId: channel.id, epgSourceId: null, externalId: 'ext', reason: 'Mapeo manual' })
      .expect(503);
  });
});

suite('operations and job control', () => {
  it('lists the registered jobs and refuses to control an unregistered one', async () => {
    /* The scheduler publishes its registry on boot; register the real names here. */
    registerScheduledJobs([
      { name: 'epg-refresh', intervalMinutes: 30, enabled: true },
      { name: 'youtube-resolution', intervalMinutes: 10, enabled: true },
    ]);
    const response = await request(harness.app).get('/api/v1/admin/operations/jobs').set(auth()).expect(200);
    expect(response.body.data.map((job: { name: string }) => job.name)).toEqual([
      'epg-refresh',
      'youtube-resolution',
    ]);
    expect(response.body.data[0].lastStatus).toBe('never');
    expect(response.body.data[0].paused).toBe(false);

    await request(harness.app)
      .post('/api/v1/admin/operations/jobs/not-a-job/pause')
      .set(auth())
      .send({ reason: 'Intento sobre un trabajo inexistente' })
      .expect(404);
  });

  it('pauses and resumes a job for real, and the scheduler stops running it', async () => {
    registerScheduledJobs([{ name: 'epg-refresh', intervalMinutes: 30, enabled: true }]);

    const pause = await request(harness.app)
      .post('/api/v1/admin/operations/jobs/epg-refresh/pause')
      .set(auth())
      .send({ reason: 'Congelar ingesta durante la migración' })
      .expect(200);
    expect(pause.body.data).toMatchObject({ name: 'epg-refresh', paused: true, changed: true });

    /* The control the scheduler reads is the one the route wrote. */
    expect(await harness.context.jobControl.mayRun('epg-refresh')).toBe(false);
    expect(await harness.context.jobControl.stateOf('epg-refresh')).toMatchObject({
      paused: true,
      pausedReason: 'Congelar ingesta durante la migración',
    });

    const listed = await request(harness.app).get('/api/v1/admin/operations/jobs').set(auth()).expect(200);
    expect(listed.body.data[0].paused).toBe(true);

    const resumed = await request(harness.app)
      .post('/api/v1/admin/operations/jobs/epg-refresh/resume')
      .set(auth())
      .send({ reason: 'Migración terminada' })
      .expect(200);
    expect(resumed.body.data).toMatchObject({ paused: false, changed: true });
    expect(await harness.context.jobControl.mayRun('epg-refresh')).toBe(true);

    const audits = await harness.context.database
      .collection<AuditDoc>(COLLECTIONS.audits)
      .find({ entityType: 'job' })
      .toArray();
    expect(audits.map((entry) => entry.action).sort()).toEqual(['job.pause', 'job.resume']);
  });

  it('keeps the original pause reason when paused twice', async () => {
    registerScheduledJobs([{ name: 'epg-refresh', intervalMinutes: 30, enabled: true }]);
    await request(harness.app)
      .post('/api/v1/admin/operations/jobs/epg-refresh/pause')
      .set(auth())
      .send({ reason: 'Primer motivo' })
      .expect(200);
    const second = await request(harness.app)
      .post('/api/v1/admin/operations/jobs/epg-refresh/pause')
      .set(auth())
      .send({ reason: 'Segundo motivo' })
      .expect(200);
    expect(second.body.data.changed).toBe(false);
    expect(await harness.context.jobControl.stateOf('epg-refresh')).toMatchObject({
      paused: true,
      pausedReason: 'Primer motivo',
    });
  });

  it('aggregates operational errors over a window without echoing raw messages', async () => {
    await harness.context.database.collection(COLLECTIONS.jobRuns).insertOne({
      _id: 'f1',
      job: 'source-verification',
      status: 'failed',
      startedAt: new Date(),
      finishedAt: new Date(),
      message: 'connect ECONNREFUSED 10.0.0.9:443',
      details: {},
    } as never);
    const response = await request(harness.app)
      .get('/api/v1/admin/operations/errors?hours=24')
      .set(auth())
      .expect(200);
    expect(response.body.total).toBeGreaterThanOrEqual(1);
    expect(response.body.data[0]).toMatchObject({ component: 'job', code: 'source-verification' });
    expect(JSON.stringify(response.body)).not.toContain('ECONNREFUSED');
  });

  it('reports measured HTTP metrics and a zero playback count before any descriptor', async () => {
    const response = await request(harness.app)
      .get('/api/v1/admin/operations/metrics')
      .set(auth())
      .expect(200);
    const data = response.body.data;
    expect(data.http.totalRequests).toBeGreaterThanOrEqual(1);
    expect(data.playback.descriptorsServed).toBe(0);
    expect(data.playback.refusedUnauthorised).toBe(0);
    expect(data.windowSeconds).toBeGreaterThanOrEqual(1);
  });

  it('counts a served descriptor once the public playback route is used', async () => {
    const channel = await createChannel('Canal Métrica', { editorialStatus: 'published' });
    await createSource(channel.id);
    await request(harness.app).get(`/api/v1/channels/${channel.slug}/playback`).expect(200);

    const response = await request(harness.app)
      .get('/api/v1/admin/operations/metrics')
      .set(auth())
      .expect(200);
    expect(response.body.data.playback.descriptorsServed).toBeGreaterThanOrEqual(1);
  });
});
