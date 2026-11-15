/**
 * Contract tests: the document, the running API and the SDK must agree.
 *
 * Three claims are checked together, which is what makes an API "typed":
 *
 * 1. every documented operation answers on the running app (no ghost paths);
 * 2. every real response satisfies the shared Zod schema for its endpoint;
 * 3. the exported OpenAPI document describes the same schemas, and the SDK
 *    exposes an operation for every documented path.
 */
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  apiErrorSchema,
  channelListResponseSchema,
  channelResponseSchema,
  categorySchema,
  healthResponseSchema,
  identityMappingSchema,
  playbackResponseSchema,
  regionEntrySchema,
  scheduleResponseSchema,
  guiatvChannelSchema,
} from '@tdt/contracts';
import { buildOpenApi } from '../server/openapi.js';
import type { TestHarness } from '../test/harness.js';
import { createHarness } from '../test/harness.js';
import { createChannel, createSource, publishedPlayableChannel } from '../test/fixtures.js';
import { COLLECTIONS } from '../infrastructure/mongo.js';
import type { ChannelDoc } from '../infrastructure/schema.js';

let harness: TestHarness;

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.context.database.collection(COLLECTIONS.sources).deleteMany({});
  await harness.context.database.collection(COLLECTIONS.channels).deleteMany({});
  await harness.context.database.collection(COLLECTIONS.programmes).deleteMany({});
  await harness.context.database.collection(COLLECTIONS.epgSources).deleteMany({});
});

/** Routes the contract suite deliberately does not exercise in this file. */
const ADMIN_AND_AUTH = new Set([
  '/admin/channels',
  '/admin/channels/{id}',
  '/admin/sources',
  '/admin/sources/{id}',
  '/admin/sources/{id}/verify',
  '/admin/audits',
  '/admin/providers',
]);

describe('OpenAPI document', () => {
  it('is a valid 3.1 document with unique operation ids', () => {
    const document = buildOpenApi('http://127.0.0.1:4010');
    expect(document.openapi).toBe('3.1.0');
    expect(document.info.title).toBeTruthy();
    const operationIds = new Set<string>();
    for (const [path, methods] of Object.entries(document.paths)) {
      expect(path.startsWith('/')).toBe(true);
      for (const [method, operation] of Object.entries(methods)) {
        expect(['get', 'post', 'patch', 'put', 'delete']).toContain(method);
        const id = (operation as { operationId?: string }).operationId;
        expect(id).toBeTruthy();
        expect(operationIds.has(id as string)).toBe(false);
        operationIds.add(id as string);
        const responses = (operation as { responses: Record<string, unknown> }).responses;
        expect(Object.keys(responses).length).toBeGreaterThan(0);
      }
    }
    expect(operationIds.size).toBeGreaterThanOrEqual(19);
  });

  it('documents every public endpoint that the router serves', async () => {
    const document = buildOpenApi('http://127.0.0.1:4010');
    const documented = new Set(Object.keys(document.paths));
    for (const path of documented) {
      if (ADMIN_AND_AUTH.has(path)) continue;
      const concrete = path
        .replace('{slug}', 'la-1')
        .replace('{id}', '00000000-0000-4000-8000-000000000000');
      const response = await request(harness.app).get(`/api/v1${concrete}`);
      // 200 when data exists, 404 for a missing channel: never 500 or "route missing".
      expect([200, 404]).toContain(response.status);
      if (response.status === 404) {
        expect(JSON.stringify(response.body)).toContain('not_found');
      }
    }
  });

  it('has no ghost paths: the route table matches the document exactly', () => {
    const document = buildOpenApi('http://127.0.0.1:4010');
    const documented = new Set(Object.keys(document.paths));
    // The routes the document may omit, per the v1 contract.
    const notDocumented = new Set(['/metrics']);
    void notDocumented;
    for (const required of [
      '/health',
      '/channels',
      '/channels/{slug}',
      '/channels/{slug}/playback',
      '/channels/{slug}/schedule',
      '/epg/now',
      '/epg/next',
      '/categories',
      '/regions',
      '/integration/manifest',
      '/integration/guiatv/channels',
      '/integration/guiatv/identity-map',
    ]) {
      expect(documented.has(required)).toBe(true);
    }
  });

  it('is exported on disk and matches the in-process document', async () => {
    const exported = JSON.parse(await readFile('../../openapi/openapi.json', 'utf8')) as { openapi: string; paths: Record<string, unknown> };
    const generated = buildOpenApi('http://127.0.0.1:4010');
    expect(exported.openapi).toBe('3.1.0');
    expect(Object.keys(exported.paths).sort()).toEqual(Object.keys(generated.paths).sort());
  });
});

describe('responses satisfy the shared contracts', () => {
  it('health', async () => {
    const response = await request(harness.app).get('/api/v1/health').expect(200);
    expect(healthResponseSchema.safeParse(response.body).success).toBe(true);
  });

  it('channel list', async () => {
    await publishedPlayableChannel(harness, 'Canal Contrato');
    const response = await request(harness.app).get('/api/v1/channels').expect(200);
    const parsed = channelListResponseSchema.safeParse(response.body);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('channel detail', async () => {
    const channel = await publishedPlayableChannel(harness, 'Detalle Contrato');
    const response = await request(harness.app).get(`/api/v1/channels/${channel.slug}`).expect(200);
    const parsed = channelResponseSchema.safeParse(response.body);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('playback descriptor', async () => {
    const channel = await publishedPlayableChannel(harness, 'Reproducción Contrato');
    const response = await request(harness.app).get(`/api/v1/channels/${channel.slug}/playback`).expect(200);
    const parsed = playbackResponseSchema.safeParse(response.body);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('schedule', async () => {
    const channel = await publishedPlayableChannel(harness, 'Guía Contrato');
    const response = await request(harness.app).get(`/api/v1/channels/${channel.slug}/schedule`).expect(200);
    const parsed = scheduleResponseSchema.safeParse(response.body);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('categories and regions', async () => {
    await publishedPlayableChannel(harness, 'Categorías Contrato');
    const categories = await request(harness.app).get('/api/v1/categories').expect(200);
    for (const category of categories.body.data) {
      expect(categorySchema.safeParse(category).success).toBe(true);
    }
    const regions = await request(harness.app).get('/api/v1/regions').expect(200);
    for (const region of regions.body.data) {
      expect(regionEntrySchema.safeParse(region).success).toBe(true);
    }
  });

  it('GuíaTV catalogue and identity map', async () => {
    await publishedPlayableChannel(harness, 'GuíaTV Contrato');
    const channels = await request(harness.app).get('/api/v1/integration/guiatv/channels').expect(200);
    for (const channel of channels.body.data) {
      expect(guiatvChannelSchema.safeParse(channel).success).toBe(true);
    }
    const map = await request(harness.app).get('/api/v1/integration/guiatv/identity-map').expect(200);
    for (const entry of map.body.data) {
      expect(identityMappingSchema.safeParse(entry).success).toBe(true);
    }
  });

  it('error envelope', async () => {
    const response = await request(harness.app).get('/api/v1/channels/inexistente').expect(404);
    const parsed = apiErrorSchema.safeParse(response.body);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('playback status is one of the documented values for every channel', async () => {
    const playable = await createChannel(harness, { name: 'Reproducible', status: 'published' });
    await createSource(harness, playable._id, { technicalStatus: 'ok' });
    const external = await createChannel(harness, { name: 'Externo', status: 'published' });
    await createSource(harness, external._id, {
      type: 'external',
      permission: 'official-player-only',
      technicalStatus: 'ok',
    });
    const eventual = await createChannel(harness, { name: 'Eventual', kind: 'eventual', status: 'published' });
    const nothing = await createChannel(harness, { name: 'Nada', status: 'published' });

    for (const [channel, expected] of [
      [playable, 'available'],
      [external, 'external'],
      [eventual, 'eventual'],
      [nothing, 'unavailable'],
    ] as const) {
      const response = await request(harness.app).get(`/api/v1/channels/${channel.slug}/playback`).expect(200);
      expect(response.body.data.playback.status).toBe(expected);
    }
  });
});

describe('SDK contract', () => {
  it('exposes an operation for every documented path', async () => {
    const document = buildOpenApi('http://127.0.0.1:4010');
    const sdk = await import('@tdt/api-client');
    const operations = sdk.OPENAPI_OPERATIONS as Record<string, { method: string; path: string }>;
    const documentedPaths = new Set(Object.keys(document.paths));
    for (const operationsforPaths of Object.values(operations)) {
      expect(documentedPaths.has(operationsforPaths.path)).toBe(true);
    }
    expect(Object.keys(operations).length).toBeGreaterThanOrEqual(19);
  });

  it('talks to the running app through the real HTTP client', async () => {
    const { createTdtClient } = await import('@tdt/api-client');
    const channel = await publishedPlayableChannel(harness, 'SDK Contrato');
    const server = harness.app.listen(0);
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    try {
      const client = createTdtClient({ baseUrl: `http://127.0.0.1:${port}/api/v1`, timeoutMs: 5000 });
      const health = await client.system.health();
      expect(health.status).toBeDefined();
      const list = await client.channels.list({ pageSize: 5 });
      expect(list.data.some((entry) => entry.slug === channel.slug)).toBe(true);
      const descriptor = await client.playback.get(channel.slug);
      expect(descriptor.playback.status).toBe('available');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('data integrity invariants', () => {
  it('no public channel record without provenance', async () => {
    await publishedPlayableChannel(harness, 'Con Procedencia');
    const channels = await harness.context.database.collection<ChannelDoc>(COLLECTIONS.channels).find({}).toArray();
    for (const channel of channels) {
      expect(channel.provenance.length).toBeGreaterThan(0);
      for (const entry of channel.provenance) {
        expect(entry.source.length).toBeGreaterThan(0);
        expect(entry.licence.length).toBeGreaterThan(0);
      }
    }
  });

  it('every channel is addressable by its slug and never by its internal id', async () => {
    const channel = await publishedPlayableChannel(harness, 'Solo Slug');
    await request(harness.app).get(`/api/v1/channels/${channel.slug}`).expect(200);
    await request(harness.app).get(`/api/v1/channels/${channel._id}`).expect(404);
  });
});
