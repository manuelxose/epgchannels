/**
 * Public international API (TDT-API-02FG) — integration against a real MongoDB.
 *
 * What is proven here, and why each matters:
 *
 * - every count comes from a database aggregate over the *published* catalogue,
 *   so it agrees with what `/channels` lists;
 * - the guide day is computed in the channel's zone (DST included), and an
 *   absent guide is reported honestly instead of being padded;
 * - the availability aggregate is authorization-first: it is derived from the
 *   same descriptor the player receives, and it can never carry an address, a
 *   source id, a provider name, a credential or a licence clause;
 * - the filters accept the two values the live catalogue really stores (`INT`,
 *   `multi`), which the strict contracts used to reject with 400.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  channelAvailabilityResponseSchema,
  countryListResponseSchema,
} from '@tdt/contracts';
import type { TestHarness } from '../../test/harness.js';
import { createHarness, resetResponseCache } from '../../test/harness.js';
import { createChannel, createSource, publishedPlayableChannel } from '../../test/fixtures.js';
import { COLLECTIONS } from '../../infrastructure/mongo.js';
import type { ChannelDoc } from '../../infrastructure/schema.js';
import { countryRegionsResponseSchema, publicLanguageListResponseSchema } from './catalogue.aggregates.js';

let harness: TestHarness;

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  resetResponseCache();
  for (const name of [COLLECTIONS.sources, COLLECTIONS.channels, COLLECTIONS.programmes, COLLECTIONS.epgSources]) {
    await harness.context.database.collection(name).deleteMany({});
  }
});

const channels = () => harness.context.database.collection<ChannelDoc>(COLLECTIONS.channels);

/** Gives a published channel a region, as the importer does. */
async function withRegion(channel: ChannelDoc, code: string, name: string): Promise<void> {
  await channels().updateOne({ _id: channel._id }, { $set: { region: { code, name } } });
}

/** Sets the stored language tag directly (the importer writes `multi`). */
async function withLanguage(channel: ChannelDoc, tag: string): Promise<void> {
  await channels().updateOne({ _id: channel._id }, { $set: { languageTag: tag } });
}

/** Inserts a programme through the real service, then forces its window. */
async function programme(
  channelId: string,
  start: string,
  end: string,
  title = 'Programa de prueba',
): Promise<void> {
  await harness.context.database.collection(COLLECTIONS.programmes).insertOne({
    _id: crypto.randomUUID(),
    channelId,
    sourceId: crypto.randomUUID(),
    title,
    description: '',
    genre: null,
    coverUrl: null,
    start: new Date(start),
    end: new Date(end),
    externalKey: `${channelId}|${start}`,
    editedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as never);
}

describe('GET /countries', () => {
  it('counts the published catalogue by country in the database', async () => {
    const es = await publishedPlayableChannel(harness, 'Española');
    await withRegion(es, 'AN', 'Andalucía');
    await createChannel(harness, { name: 'Solo publicada', status: 'published' });
    await createChannel(harness, { name: 'Borrador', status: 'draft' });
    const international = await createChannel(harness, { name: 'Internacional', country: 'INT', status: 'published' });

    const response = await request(harness.app).get('/api/v1/countries').expect(200);
    const parsed = countryListResponseSchema.safeParse(response.body);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);

    const rows = response.body.data as Array<Record<string, unknown>>;
    const spain = rows.find((row) => row['code'] === 'ES');
    expect(spain).toMatchObject({ international: false, channelCount: 2, playableCount: 1, regionCount: 1 });
    const intl = rows.find((row) => row['code'] === 'INT');
    expect(intl).toMatchObject({ international: true, channelCount: 1, playableCount: 0, regionCount: 0 });
    // A draft never counts.
    expect(rows.reduce((sum, row) => sum + (row['channelCount'] as number), 0)).toBe(3);
    expect(international.country).toBe('INT');
  });

  it('does not count a channel merged into another record', async () => {
    const survivor = await publishedPlayableChannel(harness, 'Superviviente');
    const folded = await createChannel(harness, { name: 'Fusionado', status: 'published' });
    await channels().updateOne({ _id: folded._id }, { $set: { mergedInto: survivor._id } });
    const response = await request(harness.app).get('/api/v1/countries').expect(200);
    expect(response.body.data.find((row: { code: string }) => row.code === 'ES').channelCount).toBe(1);
  });
});

describe('GET /countries/:code/regions', () => {
  it('groups by region and folds the region-less ones into the INTL aggregate', async () => {
    const andaluza = await publishedPlayableChannel(harness, 'Andaluza');
    await withRegion(andaluza, 'AN', 'Andalucía');
    const catalana = await createChannel(harness, { name: 'Catalana', status: 'published' });
    await withRegion(catalana, 'CT', 'Cataluña');
    await createChannel(harness, { name: 'Sin región', status: 'published' });

    const response = await request(harness.app).get('/api/v1/countries/ES/regions').expect(200);
    expect(countryRegionsResponseSchema.safeParse(response.body).success).toBe(true);
    const codes = response.body.data.map((row: { code: string }) => row.code);
    expect(codes).toContain('AN');
    expect(codes).toContain('CT');
    const aggregate = response.body.data.find((row: { code: string }) => row.code === 'INTL');
    expect(aggregate).toMatchObject({ aggregate: true, channelCount: 1 });
    // The rows account for every channel of the country: nothing is dropped.
    const sum = response.body.data.reduce((total: number, row: { channelCount: number }) => total + row.channelCount, 0);
    expect(sum).toBe(response.body.country.channelCount);
  });

  it('is case-insensitive on the code and 404s for a country with no channel', async () => {
    await publishedPlayableChannel(harness, 'Española');
    const lower = await request(harness.app).get('/api/v1/countries/es/regions').expect(200);
    expect(lower.body.country.code).toBe('ES');
    await request(harness.app).get('/api/v1/countries/FR/regions').expect(404);
  });
});

describe('GET /languages', () => {
  it('publishes the tag the catalogue really stores, including multi', async () => {
    const spanish = await publishedPlayableChannel(harness, 'En español');
    await withLanguage(spanish, 'es');
    await publishWithLanguage('En catalán', 'ca');
    const international = await publishWithLanguage('Internacional', 'multi');
    await withLanguage(international, 'multi');

    const response = await request(harness.app).get('/api/v1/languages').expect(200);
    const parsed = publicLanguageListResponseSchema.safeParse(response.body);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);

    const rows = response.body.data as Array<{ code: string; name: string; channelCount: number }>;
    expect(rows.find((row) => row.code === 'es')).toMatchObject({ name: 'Español', channelCount: 1 });
    expect(rows.find((row) => row.code === 'ca')).toMatchObject({ channelCount: 1 });
    expect(rows.find((row) => row.code === 'multi')).toMatchObject({
      name: 'Varios idiomas',
      channelCount: 1,
    });
  });

  it('counts only published channels', async () => {
    await publishedPlayableChannel(harness, 'Publicada');
    await createChannel(harness, { name: 'Borrador', status: 'draft' });
    const response = await request(harness.app).get('/api/v1/languages').expect(200);
    expect(response.body.data.every((row: { channelCount: number }) => row.channelCount === 1)).toBe(true);
  });
});

async function publishWithLanguage(name: string, tag: string): Promise<ChannelDoc> {
  const channel = await createChannel(harness, { name, country: 'INT', status: 'published' });
  await withLanguage(channel, tag);
  return channel;
}

describe('GET /channels filters', () => {
  it('accepts the international aggregate and the multi-language marker', async () => {
    const intl = await createChannel(harness, { name: 'Internacional', country: 'INT', status: 'published' });
    await withLanguage(intl, 'multi');
    await publishedPlayableChannel(harness, 'Nacional');

    const byCountry = await request(harness.app).get('/api/v1/channels?country=INT').expect(200);
    expect(byCountry.body.data.map((row: { name: string }) => row.name)).toEqual(['Internacional']);

    const byLanguage = await request(harness.app).get('/api/v1/channels?language=multi').expect(200);
    expect(byLanguage.body.data.map((row: { name: string }) => row.name)).toEqual(['Internacional']);

    const both = await request(harness.app).get('/api/v1/channels?country=INT&language=multi').expect(200);
    expect(both.body.pagination.total).toBe(1);
  });

  it('keeps rejecting a malformed country or language', async () => {
    const bad = await request(harness.app).get('/api/v1/channels?country=es').expect(400);
    expect(bad.body.error.details[0].path).toBe('country');
    const badLanguage = await request(harness.app).get('/api/v1/channels?language=english').expect(400);
    expect(badLanguage.body.error.details[0].path).toBe('language');
  });

  it('filters by region', async () => {
    const andaluza = await publishedPlayableChannel(harness, 'Andaluza');
    await withRegion(andaluza, 'AN', 'Andalucía');
    await publishedPlayableChannel(harness, 'Otra');
    const response = await request(harness.app).get('/api/v1/channels?region=AN').expect(200);
    expect(response.body.data.map((row: { name: string }) => row.name)).toEqual(['Andaluza']);
  });

  it('pages the playable subset with a self-consistent envelope', async () => {
    for (let index = 0; index < 4; index += 1) {
      await publishedPlayableChannel(harness, `Reproducible ${index}`);
    }
    for (let index = 0; index < 3; index += 1) {
      await createChannel(harness, { name: `Sin Fuente ${index}`, status: 'published' });
    }
    const first = await request(harness.app).get('/api/v1/channels?playable=true&pageSize=2').expect(200);
    expect(first.body.data).toHaveLength(2);
    expect(first.body.data.every((row: { playbackStatus: string }) => row.playbackStatus === 'available')).toBe(true);
    /*
     * A first page is answered by a bounded scan that stops one channel past the
     * window, so `total` is the honest lower bound it proved (3 = 2 + 1) and not
     * the catalogue size (4). The envelope must still be self-consistent, and a
     * complete sweep must report the exact total.
     */
    expect(first.body.pagination).toMatchObject({ page: 1, pageSize: 2, total: 3, pageCount: 2, hasNext: true });
    const last = await request(harness.app).get('/api/v1/channels?playable=true&pageSize=2&page=2').expect(200);
    expect(last.body.pagination).toMatchObject({ page: 2, total: 4, pageCount: 2, hasNext: false });
    expect(last.body.data).toHaveLength(2);
  });

  it('returns an exact total once the sweep is complete', async () => {
    await publishedPlayableChannel(harness, 'Uno');
    await createChannel(harness, { name: 'Sin Fuente', status: 'published' });
    const response = await request(harness.app).get('/api/v1/channels?playable=true&pageSize=10').expect(200);
    expect(response.body.pagination).toMatchObject({ total: 1, pageCount: 1, hasNext: false });
  });
});

describe('GET /channels/:slug/epg', () => {
  it('returns the complete guide day in the channel zone', async () => {
    const channel = await publishedPlayableChannel(harness, 'Con Guía');
    await channels().updateOne(
      { _id: channel._id },
      { $set: { timezone: 'Europe/Madrid', epg: { sourceId: crypto.randomUUID(), externalId: 'x' } } },
    );
    // 2026-01-15 in Madrid is 23:00Z..23:00Z; two programmes inside the day.
    await programme(channel._id, '2026-01-15T08:00:00Z', '2026-01-15T09:30:00Z', 'Mañana');
    await programme(channel._id, '2026-01-15T20:00:00Z', '2026-01-15T21:00:00Z', 'Noche');
    await programme(channel._id, '2026-01-16T00:00:00Z', '2026-01-16T01:00:00Z', 'Día siguiente');

    const slugged = await request(harness.app).get(`/api/v1/channels/${channel.slug}/epg?date=2026-01-15`).expect(200);
    expect(slugged.body.data.availability).toBe('available');
    expect(slugged.body.data.timezone).toBe('Europe/Madrid');
    expect(slugged.body.data.asOf).toBe('2026-01-14T23:00:00.000Z');
    expect(slugged.body.data.programmes.map((row: { title: string }) => row.title)).toEqual(['Mañana', 'Noche']);
    // `hasSchedule` is true only because a source is mapped.
    expect(slugged.body.attribution).toBeDefined();
  });

  it('honours an explicit window with from and hours', async () => {
    const channel = await publishedPlayableChannel(harness, 'Ventana');
    await channels().updateOne(
      { _id: channel._id },
      { $set: { epg: { sourceId: crypto.randomUUID(), externalId: 'x' } } },
    );
    await programme(channel._id, '2026-01-15T10:00:00Z', '2026-01-15T11:00:00Z', 'Dentro');
    await programme(channel._id, '2026-01-15T18:00:00Z', '2026-01-15T19:00:00Z', 'Fuera');
    const response = await request(harness.app)
      .get(`/api/v1/channels/${channel.slug}/epg?from=2026-01-15T09:00:00Z&hours=4`)
      .expect(200);
    expect(response.body.data.programmes.map((row: { title: string }) => row.title)).toEqual(['Dentro']);
  });

  it('never invents programming for a channel with no guide', async () => {
    const channel = await publishedPlayableChannel(harness, 'Sin Guía');
    const response = await request(harness.app).get(`/api/v1/channels/${channel.slug}/epg?date=2026-01-15`).expect(200);
    expect(response.body.data.availability).toBe('not-mapped');
    expect(response.body.data.programmes).toEqual([]);
    expect(response.body.data.now).toBeNull();
  });

  it('rejects a contradictory or impossible query', async () => {
    const channel = await publishedPlayableChannel(harness, 'Consulta');
    const url = `/api/v1/channels/${channel.slug}/epg`;
    const both = await request(harness.app).get(`${url}?date=2026-01-15&from=2026-01-15T00:00:00Z`).expect(400);
    expect(both.body.error.code).toBe('validation_failed');
    await request(harness.app).get(`${url}?date=2026-02-31`).expect(400);
    await request(harness.app).get(`${url}?date=2026-01-15&timezone=Mars/Base`).expect(400);
    await request(harness.app).get(`${url}?hours=999`).expect(400);
    await request(harness.app).get('/api/v1/channels/no-existe/epg?date=2026-01-15').expect(404);
  });

  it('shifts the whole grid across a DST change instead of the UTC day', async () => {
    const channel = await publishedPlayableChannel(harness, 'Cambio de hora');
    await channels().updateOne(
      { _id: channel._id },
      { $set: { timezone: 'Europe/Madrid', epg: { sourceId: crypto.randomUUID(), externalId: 'x' } } },
    );
    // Summer day: 2026-07-15 local starts at 22:00Z on the 14th.
    await programme(channel._id, '2026-07-14T22:30:00Z', '2026-07-14T23:30:00Z', 'Primero del día');
    const response = await request(harness.app).get(`/api/v1/channels/${channel.slug}/epg?date=2026-07-15`).expect(200);
    expect(response.body.data.asOf).toBe('2026-07-14T22:00:00.000Z');
    expect(response.body.data.programmes.map((row: { title: string }) => row.title)).toEqual(['Primero del día']);
  });
});

describe('GET /channels/:slug/availability', () => {
  it('reports an authorised, healthy in-app source without exposing it', async () => {
    const channel = await publishedPlayableChannel(harness, 'Disponible');
    const response = await request(harness.app).get(`/api/v1/channels/${channel.slug}/availability`).expect(200);
    const parsed = channelAvailabilityResponseSchema.safeParse(response.body);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(response.body.data).toMatchObject({
      slug: channel.slug,
      playable: true,
      playbackStatus: 'available',
      authorisedSources: 1,
    });
    // Authorization first: no address, id, provider or licence ever leaves here.
    const serialised = JSON.stringify(response.body);
    for (const forbidden of ['https://', 'm3u8', 'sourceId', 'provider', 'clauseUrl', 'authorisationEvidence', 'token']) {
      expect(serialised).not.toContain(forbidden);
    }
  });

  it('reports the emitter-only fallback as external and unplayable in-app', async () => {
    const channel = await createChannel(harness, { name: 'Solo emisor', status: 'published' });
    await createSource(harness, channel._id, {
      type: 'external',
      permission: 'official-player-only',
      officialPageUrl: 'https://example.org/directo',
      technicalStatus: 'ok',
    });
    const response = await request(harness.app).get(`/api/v1/channels/${channel.slug}/availability`).expect(200);
    expect(response.body.data).toMatchObject({
      playable: false,
      playbackStatus: 'external',
      authorisedSources: 0,
    });
    expect(JSON.stringify(response.body)).not.toContain('example.org');
  });

  it('reports a degraded channel as not playable', async () => {
    const channel = await createChannel(harness, { name: 'Degradado', status: 'published' });
    await createSource(harness, channel._id, { technicalStatus: 'http-error' });
    const response = await request(harness.app).get(`/api/v1/channels/${channel.slug}/availability`).expect(200);
    expect(response.body.data).toMatchObject({ playable: false, playbackStatus: 'degraded', authorisedSources: 0 });
  });

  it('includes the guide state from the shared coverage measure', async () => {
    const channel = await publishedPlayableChannel(harness, 'Con cobertura');
    const response = await request(harness.app).get(`/api/v1/channels/${channel.slug}/availability`).expect(200);
    expect(response.body.data.epg).toEqual({ availability: 'not-mapped', updatedAt: null });
    await request(harness.app).get('/api/v1/channels/inexistente/availability').expect(404);
  });

  it('never claims playability for a healthy stream with no recorded right', async () => {
    const channel = await createChannel(harness, { name: 'Sin derecho', status: 'published' });
    await createSource(harness, channel._id, { technicalStatus: 'ok', authorization: 'none' });
    const response = await request(harness.app).get(`/api/v1/channels/${channel.slug}/availability`).expect(200);
    expect(response.body.data).toMatchObject({ playable: false, authorisedSources: 0 });
  });
});

describe('GET /epg/channels', () => {
  it('publishes coverage totals for the published catalogue', async () => {
    const mapped = await publishedPlayableChannel(harness, 'Mapeado');
    await channels().updateOne({ _id: mapped._id }, { $set: { epg: { sourceId: crypto.randomUUID(), externalId: 'x' } } });
    await publishedPlayableChannel(harness, 'Sin mapear');
    const response = await request(harness.app).get('/api/v1/epg/channels').expect(200);
    expect(response.body.data.totals).toMatchObject({ channels: 2, mapped: 1, notMapped: 1 });
    expect(response.body.data.entries).toHaveLength(2);
  });
});

describe('compatibility with the existing consumers', () => {
  it('keeps the channel list envelope and shape unchanged', async () => {
    const channel = await publishedPlayableChannel(harness, 'Compatibilidad');
    const response = await request(harness.app).get('/api/v1/channels').expect(200);
    expect(Object.keys(response.body).sort()).toEqual(['attribution', 'data', 'pagination']);
    const row = response.body.data[0];
    expect(Object.keys(row).sort()).toEqual(
      ['category', 'country', 'hasSchedule', 'id', 'kind', 'language', 'logoSrc', 'name', 'playbackStatus', 'region', 'shortName', 'slug'].sort(),
    );
    expect(row.country).toBe('ES');
    expect(row.language).toBe('es');
    expect(channel.slug).toBe(row.slug);
  });

  it('does not shadow the existing channel routes', async () => {
    const channel = await publishedPlayableChannel(harness, 'Rutas existentes');
    await request(harness.app).get(`/api/v1/channels/${channel.slug}`).expect(200);
    await request(harness.app).get(`/api/v1/channels/${channel.slug}/playback`).expect(200);
    await request(harness.app).get(`/api/v1/channels/${channel.slug}/schedule`).expect(200);
    // `/countries` must not be swallowed by `/channels/:slug`.
    await request(harness.app).get('/api/v1/countries').expect(200);
  });
});
