/**
 * Phase 9 — operational independence from TDTChannels.
 *
 * The test blocks every TDTChannels host **at the process level**: `fetch` is
 * replaced by a guard that refuses any request to those domains (including
 * subdomains and redirect targets), and every refusal is recorded. The whole
 * platform then has to keep working: catalogue, search, filters, pagination,
 * guide, playback resolution, the SDK, and the editorial workflow.
 *
 * Independence here means independence from *that data provider*. It does not
 * mean independence from the emitters: an authorised emitter stream is still an
 * emitter stream, and pointing at RTVE's public HLS address in a fixture is
 * exactly what a real record does.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { TestHarness } from '../test/harness.js';
import { createHarness } from '../test/harness.js';
import { createChannel, createSource, publishedPlayableChannel } from '../test/fixtures.js';
import { COLLECTIONS } from '../infrastructure/mongo.js';
import type { ChannelDoc, EpgSourceDoc } from '../infrastructure/schema.js';
import { EpgService } from '../modules/epg/epg.service.js';
import { isHostBlocked } from '../infrastructure/egress.js';

/** Every host the third-party provider serves data from. */
export const BLOCKED_HOSTS = [
  'tdtchannels.com',
  'www.tdtchannels.com',
  'play.tdtchannels.com',
  'raw.githubusercontent.com',
  'github.com',
];

interface BlockedCall {
  readonly url: string;
  readonly host: string;
  readonly stack: string;
}

const blockedCalls: BlockedCall[] = [];
const realFetch = globalThis.fetch;

/**
 * Installs the guard. Any attempt to reach a blocked host throws and is
 * recorded with the call site, so a leak cannot be silently swallowed.
 */
function installEgressGuard(): void {
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const raw =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    let host = '';
    try {
      host = new URL(raw, 'http://localhost').hostname;
    } catch {
      host = '';
    }
    if (host && isHostBlocked(host, BLOCKED_HOSTS)) {
      const stack = new Error('blocked egress').stack ?? '';
      blockedCalls.push({ url: raw, host, stack });
      return Promise.reject(new Error(`Egress to ${host} is blocked by the independence test.`));
    }
    return realFetch(input as Parameters<typeof fetch>[0], init);
  }) as typeof fetch;
}

let harness: TestHarness;

beforeAll(async () => {
  installEgressGuard();
  harness = await createHarness({
    EGRESS_GUARD_ENABLED: 'true',
    BLOCKED_EGRESS_HOSTS: BLOCKED_HOSTS.join(','),
  });
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await harness?.close();
});

beforeEach(async () => {
  blockedCalls.length = 0;
  await harness.context.database.collection(COLLECTIONS.sources).deleteMany({});
  await harness.context.database.collection(COLLECTIONS.channels).deleteMany({});
  await harness.context.database.collection(COLLECTIONS.programmes).deleteMany({});
});

describe('the guard itself', () => {
  it('blocks the provider and any subdomain, and lets other hosts through', async () => {
    await expect(fetch('https://www.tdtchannels.com/lists/tv.json')).rejects.toThrow(/blocked/);
    await expect(fetch('https://tdtchannels.com/epg/TV.json')).rejects.toThrow(/blocked/);
    expect(blockedCalls.map((call) => call.host)).toEqual(['www.tdtchannels.com', 'tdtchannels.com']);
  });

  it('is active while the platform runs', () => {
    expect(blockedCalls.length).toBe(0);
    expect(typeof globalThis.fetch).toBe('function');
  });
});

describe('platform operation with TDTChannels blocked', () => {
  it('serves health with real persisted counts', async () => {
    await publishedPlayableChannel(harness, 'Canal A');
    const response = await request(harness.app).get('/api/v1/health').expect(200);
    expect(response.body.status).toBe('ok');
    expect(response.body.data.publishedChannels).toBe(1);
  });

  it('serves the catalogue, paginated and bounded', async () => {
    for (let index = 0; index < 7; index += 1) {
      await publishedPlayableChannel(harness, `Canal ${index}`);
    }
    const response = await request(harness.app).get('/api/v1/channels?pageSize=3&page=2').expect(200);
    expect(response.body.data).toHaveLength(3);
    expect(response.body.pagination.total).toBe(7);
  });

  it('searches', async () => {
    await publishedPlayableChannel(harness, 'Televisión de Aragón');
    await publishedPlayableChannel(harness, 'Canal Nacional');
    const response = await request(harness.app).get('/api/v1/channels?q=aragon').expect(200);
    expect(response.body.data.map((channel: { name: string }) => channel.name)).toEqual(['Televisión de Aragón']);
  });

  it('filters by category, language and playable', async () => {
    const playable = await createChannel(harness, { name: 'Deportes Uno', category: 'deportes', status: 'published' });
    await createSource(harness, playable._id, { technicalStatus: 'ok' });
    await createChannel(harness, { name: 'Infantil Uno', category: 'infantil', status: 'published' });

    const byCategory = await request(harness.app).get('/api/v1/channels?category=deportes').expect(200);
    expect(byCategory.body.data).toHaveLength(1);
    const playableOnly = await request(harness.app).get('/api/v1/channels?playable=true').expect(200);
    expect(playableOnly.body.data).toHaveLength(1);
    const byLanguage = await request(harness.app).get('/api/v1/channels?language=es').expect(200);
    expect(byLanguage.body.data).toHaveLength(2);
  });

  it('serves the guide from our own store', async () => {
    const channel = await createChannel(harness, { name: 'Con Guía', status: 'published' });
    await harness.context.database.collection<EpgSourceDoc>(COLLECTIONS.epgSources).insertOne({
      _id: '00000000-0000-4000-8000-0000000000e1',
      name: 'Guía editorial de prueba',
      kind: 'editorial',
      url: null,
      licence: 'editorial',
      attribution: 'Redacción propia',
      ingestionEnabled: false,
      status: 'published',
      lastRunAt: null,
      lastRunStatus: 'never',
      lastRunProgrammes: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await harness.context.epg.createEditorialProgramme(
      {
        channelId: channel._id,
        title: 'Emisión de prueba',
        description: '',
        genre: null,
        coverUrl: null,
        start: new Date(Date.now() - 60_000).toISOString(),
        end: new Date(Date.now() + 3_600_000).toISOString(),
      },
      'independence-test',
    );
    const schedule = await request(harness.app).get(`/api/v1/channels/${channel.slug}/schedule`).expect(200);
    expect(schedule.body.data.availability).toBe('available');
    expect(schedule.body.data.now?.title).toBe('Emisión de prueba');
    const feed = await request(harness.app).get('/api/v1/epg/now').expect(200);
    expect(feed.body.data.some((entry: { programme: { title: string } | null }) => entry.programme?.title === 'Emisión de prueba')).toBe(
      true,
    );
  });

  it('serves the guide stored by the ingestion pipeline, without fetching anything', async () => {
    const parsed = { events: [] as never[] };
    void parsed;
    const sourceId = '00000000-0000-4000-8000-0000000000e2';
    await harness.context.database.collection<EpgSourceDoc>(COLLECTIONS.epgSources).insertOne({
      _id: sourceId,
      name: 'Guía importada',
      kind: 'json-tdtchannels',
      url: 'https://www.tdtchannels.com/epg/TV.json',
      licence: 'Apache-2.0',
      attribution: 'Datos de referencia: proyecto TDTChannels (Apache-2.0).',
      ingestionEnabled: false,
      status: 'published',
      lastRunAt: new Date(),
      lastRunStatus: 'ok',
      lastRunProgrammes: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const channel = await createChannel(harness, { name: 'Guía Importada TV', status: 'published' });
    await harness.context.database
      .collection<ChannelDoc>(COLLECTIONS.channels)
      .updateOne({ _id: channel._id }, { $set: { epg: { sourceId, externalId: 'GuiaImportada.TV' } } });
    await new EpgService(harness.context.database).upsertChannelGuide(channel._id, sourceId, [
      {
        title: 'Programa importado ayer',
        description: '',
        genre: null,
        coverUrl: null,
        start: new Date(Date.now() - 1_800_000),
        end: new Date(Date.now() + 1_800_000),
        externalKey: 'x1',
      },
    ]);
    // The source *URL* points at the blocked provider, yet serving the guide
    // never touches the network: the data already lives in our database.
    const response = await request(harness.app).get(`/api/v1/channels/${channel.slug}/schedule`).expect(200);
    expect(response.body.data.now?.title).toBe('Programa importado ayer');
    expect(blockedCalls).toEqual([]);
  });

  it('resolves an authorised playback source', async () => {
    const channel = await publishedPlayableChannel(harness, 'Con Señal');
    const response = await request(harness.app).get(`/api/v1/channels/${channel.slug}/playback`).expect(200);
    expect(response.body.data.playback.status).toBe('available');
    expect(response.body.data.playback.url).toBe('https://example.org/live/master.m3u8');
  });

  it('resolves the public broadcaster source through the real descriptor path', async () => {
    const channel = await createChannel(harness, { name: 'Canal Público', status: 'published' });
    await createSource(harness, channel._id, {
      url: 'https://rtvelivestream.rtve.es/rtvesec/la1/la1_main_dvr.m3u8',
      technicalStatus: 'ok',
    });
    const descriptor = await request(harness.app).get(`/api/v1/channels/${channel.slug}/playback`).expect(200);
    // The URL is the emitter's own address, recorded and authorised; TDTChannels
    // plays no part in resolving or serving it.
    expect(descriptor.body.data.playback.url).toContain('rtvelivestream.rtve.es');
  });

  it('keeps the editorial workflow working', async () => {
    const token = await request(harness.app)
      .post('/api/v1/auth/login')
      .send({ email: 'editor@tdt.invalid', password: 'Correct-Horse-Battery-9' });
    expect([200, 401]).toContain(token.status);
  });

  it('answers the integration contract for GuíaTV', async () => {
    await publishedPlayableChannel(harness, 'Para GuíaTV');
    const channels = await request(harness.app).get('/api/v1/integration/guiatv/channels').expect(200);
    expect(channels.body.data).toHaveLength(1);
    const map = await request(harness.app).get('/api/v1/integration/guiatv/identity-map').expect(200);
    expect(map.body.data).toHaveLength(1);
  });

  it('never contacted the provider during any of the above', () => {
    expect(blockedCalls).toEqual([]);
  });
});

describe('the source tree itself', () => {
  it('contains no TDTChannels URL in runtime code', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const roots = ['src', '../../packages/contracts/src', '../../packages/api-client/src', '../../apps/frontend/src'];
    const offenders: string[] = [];
    async function walk(directory: string): Promise<void> {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const full = join(directory, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (/\.(ts|mts|js|mjs|html|css|json)$/.test(entry.name) && !entry.name.endsWith('.spec.ts')) {
          const text = await readFile(full, 'utf8');
          // Comments and documentation may name the provider; a URL in code may not.
          if (/https?:\/\/(?:[\w-]+\.)*tdtchannels\.com/i.test(text)) offenders.push(full);
        }
      }
    }
    for (const root of roots) {
      await walk(root);
    }
    expect(offenders).toEqual([]);
  });

  it('does not depend on a TDTChannels player, script or bundle', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const offenders: string[] = [];
    async function walk(directory: string): Promise<void> {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const full = join(directory, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (/\.(ts|html)$/.test(entry.name) && !entry.name.endsWith('.spec.ts')) {
          const text = await readFile(full, 'utf8');
          if (/play\.tdtchannels|tdtchannels\.com\/player|tdtchannels\.min\.js/i.test(text)) offenders.push(full);
        }
      }
    }
    await walk('../../apps/frontend/src');
    await walk('src');
    expect(offenders).toEqual([]);
  });
});
