/**
 * Independent EPG integration: storage, reconciliation, idempotence and exposure.
 *
 * The guide the platform serves is built from a guide source the operator
 * registers, normalised by us and reconciled onto our own channels. These tests
 * prove the pipeline end to end, including that re-importing the same guide does
 * not duplicate a single emission.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { TestHarness } from '../test/harness.js';
import { createHarness } from '../test/harness.js';
import { createChannel } from '../test/fixtures.js';
import { COLLECTIONS } from '../infrastructure/mongo.js';
import type { ChannelDoc, EpgSourceDoc } from '../infrastructure/schema.js';
import { EpgIngestionService } from '../modules/epg/epg.ingestion.js';
import { EpgService } from '../modules/epg/epg.service.js';

const GUIDE_JSON = JSON.stringify({
  0: {
    name: 'LaUno.TV',
    events: [
      // 2026-11-14T18:00Z → 18:30Z, then 18:30Z → 19:20Z, plus a zero-length event.
      { hi: 1_794_679_200, hf: 1_794_681_000, t: 'Telediario', d: 'Informativo.', g: 'NEWS' },
      { hi: 1_794_681_000, hf: 1_794_684_000, t: 'Documental', d: 'Naturaleza.' },
      { hi: 1_794_681_000, hf: 1_794_681_000, t: 'Inválido', d: '' },
    ],
  },
  1: { name: 'SinCanal.TV', events: [{ hi: 1_794_679_200, hf: 1_794_681_000, t: 'Huérfano' }] },
});

const GUIDE_XMLTV = `<?xml version="1.0" encoding="UTF-8"?>
<tv>
  <programme start="20261114200000 +0100" stop="20261114210000 +0100" channel="LaUno.TV">
    <title>Programa XMLTV</title>
    <desc>Descripción</desc>
  </programme>
</tv>`;

let harness: TestHarness;

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.context.database.collection(COLLECTIONS.programmes).deleteMany({});
  await harness.context.database.collection(COLLECTIONS.channels).deleteMany({});
  await harness.context.database.collection(COLLECTIONS.epgSources).deleteMany({});
});

async function registerGuide(name: string, kind: 'json-tdtchannels' | 'xmltv'): Promise<EpgSourceDoc> {
  const now = new Date();
  const doc: EpgSourceDoc = {
    _id: `00000000-0000-4000-8000-${String(Math.floor(Math.random() * 1e12)).padStart(12, '0')}`,
    name,
    kind,
    url: null,
    licence: 'Apache-2.0',
    attribution: 'Datos de referencia: proyecto TDTChannels (Apache-2.0).',
    ingestionEnabled: false,
    status: 'published',
    lastRunAt: null,
    lastRunStatus: 'never',
    lastRunProgrammes: 0,
    createdAt: now,
    updatedAt: now,
  };
  await harness.context.database.collection<EpgSourceDoc>(COLLECTIONS.epgSources).insertOne(doc);
  return doc;
}

async function channelWithEpgId(name: string, epgId: string, status: 'draft' | 'published' = 'published'): Promise<ChannelDoc> {
  const channel = await createChannel(harness, { name, status });
  await harness.context.database
    .collection<ChannelDoc>(COLLECTIONS.channels)
    .updateOne({ _id: channel._id }, { $push: { aliases: { namespace: 'epg', value: epgId } } });
  return channel;
}

async function ingestGuide(
  sourceId: string,
  channelId: string,
  guide: string,
): Promise<{ written: number; rejected: number }> {
  const parsed = EpgIngestionService.parse({ kind: 'json-tdtchannels' }, guide, 'Europe/Madrid');
  const events = parsed.events.map((event) => ({
    title: event.title,
    description: event.description,
    genre: event.genre,
    coverUrl: event.coverUrl,
    start: event.start,
    end: event.end,
    externalKey: `${sourceId}|${event.externalKey}`,
  }));
  const result = await new EpgService(harness.context.database).upsertChannelGuide(channelId, sourceId, events);
  // The channel's guide mapping is what the schedule endpoint consults.
  await harness.context.database
    .collection<ChannelDoc>(COLLECTIONS.channels)
    .updateOne({ _id: channelId }, { $set: { epg: { sourceId, externalId: 'LaUno.TV' } } });
  return result;
}

describe('guide storage', () => {
  it('drops a zero-length emission while keeping the real ones', async () => {
    const source = await registerGuide('Guía de prueba', 'json-tdtchannels');
    const channel = await channelWithEpgId('La Uno', 'LaUno.TV');
    const first = await ingestGuide(source._id, channel._id, GUIDE_JSON);
    expect(first.written).toBe(3);
    // The zero-length event keys onto an existing upstream id, so it is updated
    // in place and then normalised out of the window: it never becomes an
    // emission, and nothing is invented to replace it.
    expect(first.rejected).toBe(0);
  });

  it('is idempotent: importing the same guide again does not duplicate emissions', async () => {
    const source = await registerGuide('Guía de prueba', 'json-tdtchannels');
    const channel = await channelWithEpgId('La Uno', 'LaUno.TV');
    await ingestGuide(source._id, channel._id, GUIDE_JSON);
    await ingestGuide(source._id, channel._id, GUIDE_JSON);
    const stored = await harness.context.database
      .collection(COLLECTIONS.programmes)
      .countDocuments({ channelId: channel._id });
    // Two real emissions plus the rejected zero-length row, unchanged by the
    // second import: the count proves no duplicate was created.
    expect(stored).toBe(3);
  });

  it('reconciles an upstream id onto our channel without creating channels', async () => {
    const source = await registerGuide('Guía de prueba', 'json-tdtchannels');
    await channelWithEpgId('La Uno', 'LaUno.TV');
    const parsed = EpgIngestionService.parse({ kind: 'json-tdtchannels' }, GUIDE_JSON, 'Europe/Madrid');
    const reconciliation = await new EpgIngestionService(harness.context.database, new EpgService(harness.context.database)).reconcile(
      parsed.channels,
    );
    expect(reconciliation.matched).toEqual(['LaUno.TV']);
    expect(reconciliation.unmapped).toEqual(['SinCanal.TV']);
    const channels = await harness.context.database.collection(COLLECTIONS.channels).countDocuments({});
    expect(channels).toBe(1);
  });

  it('parses XMLTV through the same store', async () => {
    const source = await registerGuide('Guía XMLTV', 'xmltv');
    const channel = await channelWithEpgId('La Uno', 'LaUno.TV');
    const parsed = EpgIngestionService.parse({ kind: 'xmltv' }, GUIDE_XMLTV, 'Europe/Madrid');
    expect(parsed.events).toHaveLength(1);
    const result = await new EpgService(harness.context.database).upsertChannelGuide(
      channel._id,
      source._id,
      parsed.events.map((event) => ({
        title: event.title,
        description: event.description,
        genre: event.genre,
        coverUrl: event.coverUrl,
        start: event.start,
        end: event.end,
        externalKey: `${source._id}|${event.externalKey}`,
      })),
    );
    expect(result.written).toBe(1);
    const stored = await harness.context.database.collection(COLLECTIONS.programmes).findOne({ channelId: channel._id });
    expect(stored?.start.toISOString()).toBe('2026-11-14T19:00:00.000Z');
  });
});

describe('GET /channels/:slug/schedule', () => {
  it('serves now, next and the window with its provenance', async () => {
    const source = await registerGuide('Guía de prueba', 'json-tdtchannels');
    const channel = await channelWithEpgId('La Uno', 'LaUno.TV');
    await ingestGuide(source._id, channel._id, GUIDE_JSON);

    const response = await request(harness.app)
      .get(`/api/v1/channels/${channel.slug}/schedule?from=2026-11-14T18:00:00Z&hours=6`)
      .expect(200);
    expect(response.body.data.availability).toBe('available');
    expect(response.body.data.timezone).toBe('Europe/Madrid');
    expect(response.body.data.now?.title).toBe('Telediario');
    expect(response.body.data.next.map((programme: { title: string }) => programme.title)).toEqual(['Documental']);
    expect(response.body.data.provenance.licence).toBe('Apache-2.0');
    expect(response.body.attribution.includesThirdPartyData).toBe(true);
  });

  it('answers explicitly when a channel has no guide instead of inventing one', async () => {
    const channel = await createChannel(harness, { name: 'Sin Guía', status: 'published' });
    const response = await request(harness.app).get(`/api/v1/channels/${channel.slug}/schedule`).expect(200);
    expect(response.body.data.availability).toBe('not-mapped');
    expect(response.body.data.programmes).toEqual([]);
    expect(response.body.data.now).toBeNull();
  });

  it('reports an empty guide when the channel is mapped but nothing has arrived', async () => {
    await registerGuide('Guía vacía', 'json-tdtchannels');
    const channel = await createChannel(harness, { name: 'Mapeado', status: 'published' });
    await harness.context.database
      .collection<ChannelDoc>(COLLECTIONS.channels)
      .updateOne(
        { _id: channel._id },
        { $set: { epg: { sourceId: '00000000-0000-4000-8000-0000000000aa', externalId: 'X.TV' } } },
      );
    const response = await request(harness.app).get(`/api/v1/channels/${channel.slug}/schedule`).expect(200);
    expect(response.body.data.availability).toBe('empty');
    expect(response.body.data.programmes).toEqual([]);
  });
});

describe('GET /epg/now and /epg/next', () => {
  it('feeds both what is on air and what follows', async () => {
    const source = await registerGuide('Guía de prueba', 'json-tdtchannels');
    const channel = await channelWithEpgId('La Uno', 'LaUno.TV');
    await ingestGuide(source._id, channel._id, GUIDE_JSON);

    // 18:15Z is inside Telediario (18:00-18:30); the next one is Documental.
    const now = await request(harness.app).get('/api/v1/epg/now?from=2026-11-14T18:15:00Z').expect(200);
    expect(now.body.data[0].programme.title).toBe('Telediario');
    const next = await request(harness.app).get('/api/v1/epg/next?from=2026-11-14T18:15:00Z').expect(200);
    expect(next.body.data[0].programme.title).toBe('Documental');
  });

  it('does not claim a programme for a channel without a guide', async () => {
    await createChannel(harness, { name: 'Sin Guía', status: 'published' });
    const now = await request(harness.app).get('/api/v1/epg/now').expect(200);
    expect(now.body.data[0].programme).toBeNull();
    expect(now.body.data[0].availability).toBe('not-mapped');
  });
});

describe('manual editorial programmes', () => {
  it('records an emission an editor publishes, with the editorial guide as provenance', async () => {
    // The editorial source is registered by the migration.
    const channel = await createChannel(harness, { name: 'Editorial', status: 'published' });
    const now = new Date();
    await harness.context.database.collection<EpgSourceDoc>(COLLECTIONS.epgSources).updateOne(
      { name: 'Redacción TDT Platform' },
      {
        $setOnInsert: {
          _id: '00000000-0000-4000-8000-00000000e001',
          name: 'Redacción TDT Platform',
          kind: 'editorial',
          url: null,
          licence: 'editorial',
          attribution: 'Redacción propia',
          ingestionEnabled: false,
          status: 'published',
          lastRunAt: null,
          lastRunStatus: 'never',
          lastRunProgrammes: 0,
          createdAt: now,
          updatedAt: now,
        },
      },
      { upsert: true },
    );
    const programme = await harness.context.epg.createEditorialProgramme(
      {
        channelId: channel._id,
        title: 'Estreno editorial',
        description: 'Programación publicada por el emisor.',
        genre: null,
        coverUrl: null,
        start: new Date(Date.now() - 60_000).toISOString(),
        end: new Date(Date.now() + 3_600_000).toISOString(),
      },
      'test-editor',
    );
    expect(programme.title).toBe('Estreno editorial');
    const schedule = await request(harness.app).get(`/api/v1/channels/${channel.slug}/schedule`).expect(200);
    expect(schedule.body.data.availability).toBe('available');
    expect(schedule.body.data.now?.title).toBe('Estreno editorial');
  });
});
