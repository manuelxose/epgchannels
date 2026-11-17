/**
 * SDK coverage for the TDT-API-02FG public surface.
 *
 * Tested against a scripted fetch (no network): these tests protect the URL each
 * method builds and the shape it hands back, which is what a consumer codes
 * against.
 */
import { describe, expect, it, vi } from 'vitest';
import { createTdtClient } from '../src/client.js';
import { OPENAPI_OPERATIONS } from '../src/generated/openapi-types.js';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function clientWith(body: unknown) {
  const fetchMock = vi.fn(async () => jsonResponse(body));
  const client = createTdtClient({
    baseUrl: 'https://api.example.org/api/v1',
    fetch: fetchMock as unknown as typeof fetch,
  });
  const urlOf = (index = 0): string => String((fetchMock.mock.calls[index] as unknown[])[0]);
  return { client, fetchMock, urlOf };
}

describe('discovery endpoints', () => {
  it('lists countries', async () => {
    const payload = { data: [{ code: 'INT', name: 'Internacionales', international: true }], attribution: {} };
    const { client, urlOf } = clientWith(payload);
    const response = await client.catalogue.countries();
    expect(urlOf()).toBe('https://api.example.org/api/v1/countries');
    expect(response).toEqual(payload);
  });

  it('lists languages', async () => {
    const payload = { data: [{ code: 'multi', name: 'Varios idiomas' }], attribution: {} };
    const { client, urlOf } = clientWith(payload);
    await client.catalogue.languages();
    expect(urlOf()).toBe('https://api.example.org/api/v1/languages');
  });

  it('lists the regions of a country, encoding the code', async () => {
    const payload = { country: { code: 'ES' }, data: [], attribution: {} };
    const { client, urlOf } = clientWith(payload);
    await client.catalogue.countryRegions('ES');
    expect(urlOf()).toBe('https://api.example.org/api/v1/countries/ES/regions');
  });

  it('encodes the international aggregate without escaping it into nonsense', async () => {
    const { client, urlOf } = clientWith({ country: {}, data: [], attribution: {} });
    await client.catalogue.countryRegions('INT');
    expect(urlOf()).toBe('https://api.example.org/api/v1/countries/INT/regions');
  });

  it('forwards the widened catalogue filters the API now accepts', async () => {
    const { client, urlOf } = clientWith({ data: [], pagination: {}, attribution: {} });
    await client.channels.list({ country: 'INT', language: 'multi', playable: true });
    expect(urlOf()).toBe(
      'https://api.example.org/api/v1/channels?country=INT&language=multi&playable=true',
    );
  });
});

describe('channel availability and guide day', () => {
  it('fetches the public availability aggregate', async () => {
    const payload = {
      data: {
        slug: 'la-1',
        playable: true,
        playbackStatus: 'available',
        geoRestricted: false,
        authorisedSources: 1,
        lastVerifiedAt: null,
        epg: { availability: 'not-mapped', updatedAt: null },
      },
      attribution: {},
    };
    const { client, urlOf } = clientWith(payload);
    const response = await client.channels.availability('la 1');
    expect(urlOf()).toBe('https://api.example.org/api/v1/channels/la%201/availability');
    expect(response.data.playable).toBe(true);
  });

  it('requests a guide day by local date', async () => {
    const { client, urlOf } = clientWith({ data: { programmes: [] }, attribution: {} });
    await client.channels.epg('la-1', { date: '2026-11-16' });
    expect(urlOf()).toBe('https://api.example.org/api/v1/channels/la-1/epg?date=2026-11-16');
  });

  it('requests a guide day by explicit window, including the zone', async () => {
    const { client, urlOf } = clientWith({ data: { programmes: [] }, attribution: {} });
    await client.channels.epg('la-1', { from: '2026-11-16T00:00:00Z', hours: 12, timezone: 'Europe/Madrid' });
    expect(urlOf()).toBe(
      'https://api.example.org/api/v1/channels/la-1/epg?timezone=Europe%2FMadrid&from=2026-11-16T00%3A00%3A00Z&hours=12',
    );
  });
});

describe('generated contract', () => {
  it('exposes the new operations with their documented paths', () => {
    expect(OPENAPI_OPERATIONS['listCountries']).toEqual({ method: 'GET', path: '/countries' });
    expect(OPENAPI_OPERATIONS['listCountryRegions']).toEqual({ method: 'GET', path: '/countries/{code}/regions' });
    expect(OPENAPI_OPERATIONS['listLanguages']).toEqual({ method: 'GET', path: '/languages' });
    expect(OPENAPI_OPERATIONS['getChannelEpgDay']).toEqual({ method: 'GET', path: '/channels/{slug}/epg' });
    expect(OPENAPI_OPERATIONS['getChannelAvailability']).toEqual({
      method: 'GET',
      path: '/channels/{slug}/availability',
    });
    expect(OPENAPI_OPERATIONS['listEpgCoverage']).toEqual({ method: 'GET', path: '/epg/channels' });
  });

  it('keeps every operation that existed before', () => {
    for (const operationId of ['listChannels', 'getChannel', 'getPlayback', 'getSchedule', 'getEpgNow', 'getEpgNext', 'listCategories', 'listRegions', 'getHealth']) {
      expect(OPENAPI_OPERATIONS).toHaveProperty(operationId);
    }
  });
});
