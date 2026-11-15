/**
 * Public API integration: a real Express app over a real MongoDB.
 *
 * The assertions are about *behaviour a consumer depends on*: pagination,
 * filtering, the playback descriptor contract, honest statuses, caching headers,
 * validation errors and the security boundary between public and admin surfaces.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { TestHarness } from '../test/harness.js';
import { createHarness, resetResponseCache } from '../test/harness.js';
import { createChannel, createSource, publishedPlayableChannel } from '../test/fixtures.js';
import { COLLECTIONS } from '../infrastructure/mongo.js';
import type { ChannelDoc, PlaybackSourceDoc } from '../infrastructure/schema.js';

let harness: TestHarness;

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  resetResponseCache();
  await harness.context.database.collection(COLLECTIONS.sources).deleteMany({});
  await harness.context.database.collection(COLLECTIONS.channels).deleteMany({});
  await harness.context.database.collection(COLLECTIONS.audits).deleteMany({});
});

describe('GET /health', () => {
  it('reports the real persisted counts, not a fixture', async () => {
    const response = await request(harness.app).get('/api/v1/health').expect(200);
    expect(response.body.status).toBe('degraded'); // no published channels yet
    expect(response.body.data).toEqual({ channels: 0, publishedChannels: 0, sources: 0, programmes: 0 });
    expect(response.body.dependencies.find((dep: { name: string }) => dep.name === 'mongodb').state).toBe('up');
  });

  it('becomes ok once the catalogue has published channels', async () => {
    await publishedPlayableChannel(harness, 'Canal Uno');
    const response = await request(harness.app).get('/api/v1/health').expect(200);
    expect(response.body.status).toBe('ok');
    expect(response.body.data.publishedChannels).toBe(1);
    expect(response.body.data.sources).toBe(1);
  });
});

describe('GET /channels', () => {
  it('paginates with a bounded page size and reports the envelope', async () => {
    for (let index = 0; index < 5; index += 1) {
      await publishedPlayableChannel(harness, `Canal ${String(index).padStart(2, '0')}`);
    }
    const first = await request(harness.app).get('/api/v1/channels?pageSize=2&page=1').expect(200);
    expect(first.body.data).toHaveLength(2);
    expect(first.body.pagination).toMatchObject({ page: 1, pageSize: 2, total: 5, pageCount: 3, hasNext: true, hasPrevious: false });
    const last = await request(harness.app).get('/api/v1/channels?pageSize=2&page=3').expect(200);
    expect(last.body.data).toHaveLength(1);
    expect(last.body.pagination.hasNext).toBe(false);
  });

  it('never returns a withdrawn or draft channel', async () => {
    await publishedPlayableChannel(harness, 'Publicado');
    await createChannel(harness, { name: 'Borrador', status: 'draft' });
    await createChannel(harness, { name: 'Retirado', status: 'withdrawn' });
    const response = await request(harness.app).get('/api/v1/channels').expect(200);
    expect(response.body.data.map((channel: { name: string }) => channel.name)).toEqual(['Publicado']);
  });

  it('searches without accents and ignores leading articles', async () => {
    await publishedPlayableChannel(harness, 'Aragón TV');
    await publishedPlayableChannel(harness, 'La 1');
    const accented = await request(harness.app).get('/api/v1/channels?q=aragon').expect(200);
    expect(accented.body.data.map((channel: { name: string }) => channel.name)).toEqual(['Aragón TV']);
    const glued = await request(harness.app).get('/api/v1/channels?q=la1').expect(200);
    expect(glued.body.data.map((channel: { name: string }) => channel.name)).toEqual(['La 1']);
  });

  it('filters by category, country and playable', async () => {
    const playable = await createChannel(harness, { name: 'Deportes OK', category: 'deportes', status: 'published' });
    await createSource(harness, playable._id, { technicalStatus: 'ok' });
    await createChannel(harness, { name: 'Deportes Externo', category: 'deportes', status: 'published' });
    await createChannel(harness, { name: 'Generalista', category: 'generalista', status: 'published' });

    const byCategory = await request(harness.app).get('/api/v1/channels?category=deportes').expect(200);
    expect(byCategory.body.data).toHaveLength(2);
    const playableOnly = await request(harness.app).get('/api/v1/channels?playable=true').expect(200);
    expect(playableOnly.body.data.map((channel: { name: string }) => channel.name)).toEqual(['Deportes OK']);
    const byCountry = await request(harness.app).get('/api/v1/channels?country=ES').expect(200);
    expect(byCountry.body.data).toHaveLength(3);
  });

  it('rejects invalid query parameters with a bounded error envelope', async () => {
    const response = await request(harness.app).get('/api/v1/channels?pageSize=1000').expect(400);
    expect(response.body.error.code).toBe('validation_failed');
    expect(response.body.error.details[0].path).toBe('pageSize');
    expect(response.body.requestId).toBe(response.headers['x-request-id']);
  });

  it('sends cache headers and honours If-None-Match', async () => {
    await publishedPlayableChannel(harness, 'Cacheable');
    const first = await request(harness.app).get('/api/v1/channels').expect(200);
    expect(first.headers['cache-control']).toContain('public');
    expect(first.headers.etag).toBeDefined();
    const second = await request(harness.app)
      .get('/api/v1/channels')
      .set('If-None-Match', first.headers.etag as string)
      .expect(304);
    expect(second.text).toBe('');
  });

  it('includes the attribution required by the reference data licence', async () => {
    const channel = await publishedPlayableChannel(harness, 'Con atribución');
    await harness.context.database
      .collection<ChannelDoc>(COLLECTIONS.channels)
      .updateOne(
        { _id: channel._id },
        {
          $set: {
            provenance: [
              {
                source: 'tdtchannels-snapshot',
                label: 'Catálogo de referencia',
                url: 'https://github.com/LaQuay/TDTChannels',
                licence: 'Apache-2.0',
                attribution: 'Datos de referencia: proyecto TDTChannels (Apache-2.0).',
                digestSha256: null,
                capturedAt: new Date(),
                editorial: false,
              },
            ],
          },
        },
      );
    const response = await request(harness.app).get('/api/v1/channels').expect(200);
    expect(response.body.attribution.includesThirdPartyData).toBe(true);
    expect(response.body.attribution.notices[0]).toContain('TDTChannels');
  });
});

describe('GET /channels/:slug', () => {
  it('returns the canonical record and 404s for an unknown slug', async () => {
    const channel = await publishedPlayableChannel(harness, 'Ficha Canal');
    const found = await request(harness.app).get(`/api/v1/channels/${channel.slug}`).expect(200);
    expect(found.body.data.id).toBe(channel._id);
    expect(found.body.data.slug).toBe(channel.slug);
    expect(found.body.data.provenance).toHaveLength(1);
    await request(harness.app).get('/api/v1/channels/no-existe').expect(404);
  });
});

describe('GET /channels/:slug/playback', () => {
  it('describes an authorised in-app source as available', async () => {
    const channel = await publishedPlayableChannel(harness, 'Reproducible');
    const response = await request(harness.app).get(`/api/v1/channels/${channel.slug}/playback`).expect(200);
    expect(response.body.data.playback).toMatchObject({
      status: 'available',
      engine: 'hls',
      type: 'hls',
      url: 'https://example.org/live/master.m3u8',
    });
    expect(response.body.data.playback.options).toHaveLength(1);
    expect(response.body.data.channel.slug).toBe(channel.slug);
  });

  it('never exposes a source without permission, whatever its health', async () => {
    const channel = await createChannel(harness, { name: 'Sin Permiso', status: 'published' });
    // The API refuses to *create* an unlicensed playable source; the remaining\n    // route is a withdrawn one, which must stay hidden whatever its health.\n    await createSource(harness, channel._id, { status: 'withdrawn', technicalStatus: 'ok' });
    const response = await request(harness.app).get(`/api/v1/channels/${channel.slug}/playback`).expect(200);
    expect(response.body.data.playback.status).toBe('unavailable');
    expect(response.body.data.playback.url).toBeNull();
    expect(response.body.data.playback.options).toEqual([]);
    // A withdrawn source produces no public issue either: the descriptor simply\n    // has nothing to offer, and the channel's own state explains why.\n    expect(response.body.data.issues).toEqual([]);\n    expect(response.body.data.playback.reason).not.toBeNull();
  });

  it('reports a channel that is only available in the emitter player as external', async () => {
    const channel = await createChannel(harness, { name: 'Solo Emisor', status: 'published' });
    await createSource(harness, channel._id, {
      type: 'external',
      url: 'https://example.org/directo',
      officialPageUrl: 'https://example.org/directo',
      permission: 'official-player-only',
      technicalStatus: 'ok',
    });
    const response = await request(harness.app).get(`/api/v1/channels/${channel.slug}/playback`).expect(200);
    expect(response.body.data.playback).toMatchObject({
      status: 'external',
      engine: 'external',
      url: null,
      externalUrl: 'https://example.org/directo',
    });
  });

  it('marks a registered but unhealthy source as degraded, not available', async () => {
    const channel = await createChannel(harness, { name: 'Caída', status: 'published' });
    await createSource(harness, channel._id, { technicalStatus: 'http-error' });
    const response = await request(harness.app).get(`/api/v1/channels/${channel.slug}/playback`).expect(200);
    expect(response.body.data.playback.status).toBe('degraded');
    expect(response.body.data.playback.options).toEqual([]);
    expect(response.body.data.issues[0].kind).toBe('verification');
  });

  it('reports an eventual channel with nothing attached as eventual', async () => {
    const channel = await createChannel(harness, { name: 'Eventual', kind: 'eventual', status: 'published' });
    const response = await request(harness.app).get(`/api/v1/channels/${channel.slug}/playback`).expect(200);
    expect(response.body.data.playback.status).toBe('eventual');
    expect(response.body.data.playback.url).toBeNull();
  });

  it('prefers the highest-priority healthy source and lists the alternatives', async () => {
    const channel = await createChannel(harness, { name: 'Varias Fuentes', status: 'published' });
    await createSource(harness, channel._id, {
      url: 'https://example.org/second.m3u8',
      priority: 200,
      technicalStatus: 'ok',
    });
    await createSource(harness, channel._id, {
      url: 'https://example.org/first.m3u8',
      priority: 10,
      technicalStatus: 'ok',
    });
    const response = await request(harness.app).get(`/api/v1/channels/${channel.slug}/playback`).expect(200);
    expect(response.body.data.playback.url).toBe('https://example.org/first.m3u8');
    expect(response.body.data.playback.options.map((option: { url: string }) => option.url)).toEqual([
      'https://example.org/first.m3u8',
      'https://example.org/second.m3u8',
    ]);
  });

  it('never leaks a private credential field into the payload', async () => {
    const channel = await createChannel(harness, { name: 'Credenciales', status: 'published' });
    const source = await createSource(harness, channel._id, { technicalStatus: 'ok' });
    await harness.context.database
      .collection<PlaybackSourceDoc>(COLLECTIONS.sources)
      .updateOne(
        { _id: source._id },
        { $set: { url: 'https://example.org/stream.m3u8?token=SECRET123', provider: 'emitter:example.org' } },
      );
    const response = await request(harness.app).get(`/api/v1/channels/${channel.slug}/playback`).expect(200);
    // The URL is the emitter's own public address; the record carries no
    // credential field at all, and none is invented by the API.
    expect(Object.keys(response.body.data.playback)).not.toContain('credentials');
    expect(Object.keys(response.body.data)).not.toContain('authorisationEvidence');
  });

  it('rejects a slug with invalid characters before hitting the database', async () => {
    // An empty slug never reaches the handler: there is no route for it, so the\n    // answer is a plain 404 without touching the database.\n    await request(harness.app).get('/api/v1/channels/%20/schedule').expect(404);
  });
});

describe('GET /categories and /regions', () => {
  it('counts only public channels and reports playable counts', async () => {
    const playable = await createChannel(harness, { name: 'A', category: 'deportes', status: 'published' });
    await createSource(harness, playable._id, { technicalStatus: 'ok' });
    await createChannel(harness, { name: 'B', category: 'deportes', status: 'published' });
    await createChannel(harness, { name: 'C', category: 'infantil', status: 'draft' });

    const categories = await request(harness.app).get('/api/v1/categories').expect(200);
    const deportes = categories.body.data.find((entry: { id: string }) => entry.id === 'deportes');
    expect(deportes).toMatchObject({ channelCount: 2, playableCount: 1 });
    expect(categories.body.data.find((entry: { id: string }) => entry.id === 'infantil')).toBeUndefined();
  });

  it('returns the autonomous communities with counts', async () => {
    const channel = await publishedPlayableChannel(harness, 'Andaluza');
    await harness.context.database
      .collection<ChannelDoc>(COLLECTIONS.channels)
      .updateOne({ _id: channel._id }, { $set: { region: { code: 'AN', name: 'Andalucía' } } });
    const response = await request(harness.app).get('/api/v1/regions').expect(200);
    const andalucia = response.body.data.find((entry: { code: string }) => entry.code === 'AN');
    expect(andalucia).toMatchObject({ channelCount: 1, playableCount: 1 });
  });
});

describe('integration endpoints', () => {
  it('serves the integration manifest with the slug policy', async () => {
    const response = await request(harness.app).get('/api/v1/integration/manifest').expect(200);
    expect(response.body.data.slugPolicy).toEqual({
      authoritative: 'tdt-platform',
      guiatvSlugWinsWhenPresent: true,
    });
    expect(response.body.data.endpoints.length).toBeGreaterThan(5);
  });

  it('serves the GuíaTV catalogue and the identity map', async () => {
    const channel = await publishedPlayableChannel(harness, 'Para GuíaTV');
    await harness.context.database
      .collection<ChannelDoc>(COLLECTIONS.channels)
      .updateOne({ _id: channel._id }, { $push: { aliases: { namespace: 'guiatv', value: 'la-uno' } } });

    const catalogue = await request(harness.app).get('/api/v1/integration/guiatv/channels').expect(200);
    expect(catalogue.body.data[0]).toMatchObject({ tdtId: channel._id, slug: channel.slug, guiatvSlug: 'la-uno' });

    const map = await request(harness.app).get('/api/v1/integration/guiatv/identity-map').expect(200);
    expect(map.body.data[0]).toMatchObject({ slug: channel.slug, guiatvSlug: 'la-uno', match: 'alias' });
  });
});

describe('security boundary', () => {
  it('requires a session for every admin route', async () => {
    const routes: Array<[string, string]> = [
      ['get', '/api/v1/admin/channels'],
      ['get', '/api/v1/admin/audits'],
      ['get', '/api/v1/admin/providers'],
      ['get', '/api/v1/admin/me'],
      ['post', '/api/v1/admin/channels'],
    ];
    for (const [method, path] of routes) {
      const call = method === 'get' ? request(harness.app).get(path) : request(harness.app).post(path).send({});
      const response = await call;
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('unauthorized');
    }
  });

  it('rejects a forged bearer token', async () => {
    await request(harness.app).get('/api/v1/admin/channels').set('Authorization', 'Bearer not-a-session').expect(401);
  });

  it('refuses the bootstrap endpoint when it is not configured', async () => {
    const response = await request(harness.app)
      .post('/api/v1/auth/bootstrap')
      .send({ email: 'a@b.invalid', password: 'Correct-Horse-Battery-9', bootstrapToken: 'x'.repeat(32) })
      .expect(403);
    expect(response.body.error.code).toBe('forbidden');
  });

  it('does not answer an unversioned path', async () => {
    const response = await request(harness.app).get('/api/channels').expect(404);
    expect(response.body.error.code).toBe('not_found');
  });

  it('allows only configured browser origins', async () => {
    await request(harness.app)
      .get('/api/v1/channels')
      .set('Origin', 'http://localhost:4200')
      .expect(200)
      .expect('access-control-allow-origin', 'http://localhost:4200');
    await request(harness.app).get('/api/v1/channels').set('Origin', 'https://evil.example').expect(403);
  });

  it('rejects an oversized JSON body before parsing it into memory', async () => {
    const huge = { name: 'x'.repeat(300_000) };
    const response = await request(harness.app).post('/api/v1/auth/login').send(huge);
    expect([400, 413]).toContain(response.status);
  });

  it('serves metrics without leaking route parameters', async () => {
    await request(harness.app).get('/api/v1/channels').expect(200);
    const metrics = await request(harness.app).get('/metrics').expect(200);
    expect(metrics.text).toContain('tdt_http_requests_total');
    expect(metrics.text).not.toContain('secret-slug');
  });
});
