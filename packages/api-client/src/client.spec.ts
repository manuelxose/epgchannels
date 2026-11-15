/**
 * SDK behaviour, tested against a scripted fetch (no network).
 *
 * These tests protect the properties a consumer depends on: structured errors,
 * deterministic URLs, ETag revalidation, cancellation and engine selection.
 */
import { describe, expect, it, vi } from 'vitest';
import type { PlaybackDescriptor } from '@tdt/contracts';
import { createTdtClient } from '../src/client.js';
import { ApiError } from '../src/http.js';
import { createGuiaTvPlaybackAdapter, selectEngine } from '../src/guiatv.js';
import { describePlayback } from '../src/wire.js';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...(init.headers as Record<string, string> | undefined) },
    ...init,
  });
}

function descriptor(overrides: Partial<PlaybackDescriptor['playback']> = {}): PlaybackDescriptor {
  return {
    channel: { id: '00000000-0000-4000-8000-000000000001', slug: 'la-1', name: 'La 1' },
    playback: {
      status: 'available',
      engine: 'hls',
      type: 'hls',
      sourceId: '00000000-0000-4000-8000-0000000000aa',
      url: 'https://example.org/live/master.m3u8',
      externalUrl: null,
      options: [
        {
          sourceId: '00000000-0000-4000-8000-0000000000aa',
          label: 'Señal del emisor',
          type: 'hls',
          engine: 'hls',
          url: 'https://example.org/live/master.m3u8',
          externalUrl: null,
          geoRestricted: false,
          preferred: true,
        },
      ],
      reason: null,
      ...overrides,
    },
    checkedAt: new Date().toISOString(),
    issues: [],
  };
}

describe('client', () => {
  it('builds deterministic URLs, encoding the slug and dropping empty filters', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: [], pagination: {}, attribution: {} }));
    const client = createTdtClient({ baseUrl: 'https://api.example.org/api/v1/', fetch: fetchMock as unknown as typeof fetch });
    await client.channels.list({ q: 'la 1', page: 2, category: undefined });
    const url = String((fetchMock.mock.calls[0] as unknown[])[0]);
    // Parameters follow the client's declaration order and empty filters are
    // omitted instead of being sent as the string 'undefined'.
    expect(url).toBe('https://api.example.org/api/v1/channels?page=2&q=la+1');
    await client.channels.get('sal y pimienta');
    expect(String((fetchMock.mock.calls[1] as unknown[])[0])).toBe(
      'https://api.example.org/api/v1/channels/sal%20y%20pimienta',
    );
  });

  it('maps the documented error envelope onto a typed error', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: { code: 'not_found', message: 'Canal no encontrado.' },
          requestId: 'req-1',
        }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      ),
    );
    const client = createTdtClient({ baseUrl: 'https://api.example.org/api/v1', fetch: fetchMock as unknown as typeof fetch });
    const error = await client.channels.get('nope').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect((error as ApiError).code).toBe('not_found');
    expect((error as ApiError).isNotFound).toBe(true);
    expect((error as ApiError).requestId).toBe('req-1');
  });

  it('revalidates with If-None-Match and reuses the body on 304', async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return jsonResponse(
          { data: { id: '00000000-0000-4000-8000-000000000001', slug: 'la-1', name: 'La 1' }, attribution: {} },
          { headers: { etag: 'W/"abc"' } },
        );
      }
      return new Response(null, { status: 304 });
    });
    const client = createTdtClient({ baseUrl: 'https://api.example.org/api/v1', fetch: fetchMock as unknown as typeof fetch });
    const first = await client.channels.get('la-1');
    const second = await client.channels.get('la-1');
    expect(second).toEqual(first);
    const init = (fetchMock.mock.calls[1] as unknown[])[1] as RequestInit;
    expect((init.headers as Record<string, string>)['if-none-match']).toBe('W/"abc"');
  });

  it('aborts a request that exceeds its timeout', async () => {
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const client = createTdtClient({
      baseUrl: 'https://api.example.org/api/v1',
      timeoutMs: 10,
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(client.channels.get('la-1')).rejects.toThrow(/aborted/);
  });

  it('pages through the whole catalogue and stops at the last page', async () => {
    let page = 0;
    const fetchMock = vi.fn(async () => {
      page += 1;
      return jsonResponse({
        data: [{ id: `id-${page}`, slug: `c-${page}` }],
        pagination: { page, pageSize: 1, total: 3, pageCount: 3, hasNext: page < 3, hasPrevious: page > 1 },
        attribution: {},
      });
    });
    const client = createTdtClient({ baseUrl: 'https://api.example.org/api/v1', fetch: fetchMock as unknown as typeof fetch });
    const all = await client.channels.all({ pageSize: 1 });
    expect(all).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('wire narrowing', () => {
  it('keeps a null container when nothing is selectable', () => {
    const wire = { ...descriptor(), playback: { ...descriptor().playback, type: null, options: [], status: 'unavailable' as const } };
    expect(describePlayback(wire).playback.type).toBeNull();
  });

  it('keeps a concrete container when a source is selectable', () => {
    expect(describePlayback(descriptor()).playback.type).toBe('hls');
  });
});

describe('engine selection', () => {
  it('selects the first option and keeps the alternatives', () => {
    const selection = selectEngine(descriptor());
    expect(selection.primary).toEqual({
      kind: 'hls',
      url: 'https://example.org/live/master.m3u8',
      sourceId: '00000000-0000-4000-8000-0000000000aa',
    });
    expect(selection.all).toHaveLength(1);
  });

  it('maps a YouTube option to the YouTube engine', () => {
    const selection = selectEngine(
      descriptor({
        engine: 'youtube-iframe',
        type: 'youtube',
        url: 'https://www.youtube.com/watch?v=abcdefghijk',
        options: [
          {
            sourceId: '00000000-0000-4000-8000-0000000000bb',
            label: 'Emisión en YouTube',
            type: 'youtube',
            engine: 'youtube-iframe',
            url: 'https://www.youtube.com/watch?v=abcdefghijk',
            externalUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
            geoRestricted: false,
            preferred: true,
          },
        ],
      }),
    );
    expect(selection.primary.kind).toBe('youtube');
  });

  it('falls back to the external page, never pretending in-app playback', () => {
    const selection = selectEngine(
      descriptor({ status: 'external', engine: 'external', type: 'external', url: null, options: [], externalUrl: 'https://example.org/directo' }),
    );
    expect(selection.primary).toEqual({ kind: 'external', url: 'https://example.org/directo' });
  });

  it('reports none with the API reason when there is nothing to play', () => {
    const selection = selectEngine(
      descriptor({ status: 'unavailable', engine: 'none', type: null, url: null, options: [], externalUrl: null, reason: 'Sin señal.' }),
    );
    expect(selection.primary).toEqual({ kind: 'none', reason: 'Sin señal.' });
  });
});

describe('GuíaTV adapter', () => {
  it('prefers the consumer slug when mapping an identity', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/integration/guiatv/identity-map')) {
        return jsonResponse({
          data: [{ tdtId: '00000000-0000-4000-8000-000000000001', slug: 'la-1', guiatvSlug: 'la-uno' }],
          pagination: { page: 1, pageSize: 500, total: 1 },
        });
      }
      return new Response(JSON.stringify({ error: { code: 'not_found', message: 'x' }, requestId: 'r' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    });
    const adapter = createGuiaTvPlaybackAdapter({
      baseUrl: 'https://api.example.org/api/v1',
      fetch: fetchMock as unknown as typeof fetch,
    });
    const link = await adapter.link('la-uno');
    expect(link).toMatchObject({ slug: 'la-1', guiatvSlug: 'la-uno', publicSlug: 'la-uno' });
  });

  it('reports the platform as unreachable without throwing', async () => {
    const adapter = createGuiaTvPlaybackAdapter({
      baseUrl: 'https://api.example.org/api/v1',
      fetch: vi.fn(async () => {
        throw new Error('offline');
      }) as unknown as typeof fetch,
    });
    const health = await adapter.health();
    expect(health.ok).toBe(false);
    expect(health.status).toBe('unreachable');
  });

  it('never calls the platform unless a consumer asks it to', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ status: 'ok', data: {} }));
    createGuiaTvPlaybackAdapter({ baseUrl: 'https://api.example.org/api/v1', fetch: fetchMock as unknown as typeof fetch });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
