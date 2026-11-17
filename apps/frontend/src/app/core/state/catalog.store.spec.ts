import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CatalogStore } from './catalog.store';
import { CatalogueQuery, PAGE_SIZE } from './catalogue-query';
import { PreferencesStore } from './preferences.store';
import { provideRebuildConfig } from '../config/rebuild-config.token';
import { DemoStorage } from './test-support';

/**
 * These tests exercise the store against **our own API's** contract.
 *
 * The fixtures below are API payloads (`/channels`, `/categories`,
 * `/channels/:slug/schedule`), not a third-party catalogue: after TDT-API-01 the
 * client has no other source, so a fixture that does not look like our API would
 * not be testing anything real.
 */

const API = 'http://api.test/api/v1';

interface ApiChannelFixture {
  slug: string;
  name: string;
  category: string;
  playbackStatus: string;
  country?: string;
  language?: string;
  kind?: string;
  region?: { code: string; name: string } | null;
  /** Human category name used by the client-side search index. */
  categoryName?: string;
}

const apiChannels: ApiChannelFixture[] = [
  { slug: 'la-1', name: 'La 1', category: 'generalista', playbackStatus: 'available' },
  { slug: 'la-2', name: 'La 2', category: 'generalista', playbackStatus: 'available' },
  { slug: 'cuatro', name: 'Cuatro', category: 'generalista', playbackStatus: 'external' },
  { slug: 'canal-sur', name: 'Canal Sur', category: 'autonomica', categoryName: 'Andalucía', playbackStatus: 'eventual', region: { code: 'AN', name: 'Andalucía' } },
];

function channelListBody(channels: ApiChannelFixture[] = apiChannels, page = 1, pageSize = 100) {
  const start = (page - 1) * pageSize;
  const window = channels.slice(start, start + pageSize);
  const pageCount = Math.ceil(channels.length / pageSize);
  return {
    data: window.map((channel) => ({
      id: `id-${channel.slug}`,
      slug: channel.slug,
      name: channel.name,
      shortName: channel.name,
      country: 'ES',
      region: channel.region ?? null,
      language: 'es',
      category: channel.category,
      categoryName: channel.categoryName ?? channel.category,
      kind: 'linear',
      playbackStatus: channel.playbackStatus,
      logoSrc: null,
      hasSchedule: true,
    })),
    pagination: {
      page,
      pageSize,
      total: channels.length,
      pageCount,
      hasNext: page < pageCount,
      hasPrevious: page > 1,
    },
    attribution: {
      notices: ['Datos de referencia: proyecto TDTChannels, Apache-2.0.'],
      includesThirdPartyData: channels.length > 0,
    },
  };
}

const categoriesBody = {
  data: [
    { id: 'generalista', name: 'Generalistas', channelCount: 3, playableCount: 2 },
    { id: 'autonomica', name: 'Andalucía', channelCount: 1, playableCount: 0 },
  ],
  attribution: { notices: [], includesThirdPartyData: false },
};

function scheduleBody(slug: string) {
  const now = Date.now();
  const programmes =
    slug === 'la-1'
      ? [
          {
            id: 'p1',
            title: 'Ahora en La 1',
            description: 'x',
            genre: null,
            coverUrl: null,
            start: new Date(now - 600_000).toISOString(),
            end: new Date(now + 600_000).toISOString(),
          },
        ]
      : [];
  return {
    data: {
      channel: { id: `id-${slug}`, slug, name: slug },
      timezone: 'Europe/Madrid',
      availability: programmes.length > 0 ? 'available' : 'not-mapped',
      now: programmes[0] ?? null,
      next: [],
      programmes,
      asOf: new Date(now).toISOString(),
      provenance: { sourceId: null, sourceName: null, licence: null, attribution: null, editedAt: null },
      updatedAt: null,
    },
    attribution: { notices: [], includesThirdPartyData: false },
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function routeFetch(input: string, init?: RequestInit): Promise<Response> {
  const url = new URL(input, 'http://localhost');
  void init;
  if (url.pathname === '/api/v1/channels') {
    const page = Number(url.searchParams.get('page') ?? '1');
    const pageSize = Number(url.searchParams.get('pageSize') ?? '100');
    return Promise.resolve(jsonResponse(channelListBody(apiChannels, page, pageSize)));
  }
  if (url.pathname === '/api/v1/categories') return Promise.resolve(jsonResponse(categoriesBody));
  if (url.pathname.startsWith('/api/v1/channels/') && url.pathname.endsWith('/schedule')) {
    const slug = url.pathname.split('/')[4] ?? '';
    return Promise.resolve(jsonResponse(scheduleBody(decodeURIComponent(slug))));
  }
  return Promise.reject(new Error(`unexpected fetch ${input}`));
}

describe('CatalogStore + CatalogueQuery integration (our API)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(routeFetch);
    vi.stubGlobal('fetch', fetchMock);
    // jsdom exposes localStorage as a read-only accessor, so it is replaced
    // through a property definition rather than assignment.
    Object.defineProperty(globalThis, 'localStorage', {
      value: new DemoStorage(),
      configurable: true,
      writable: true,
    });

    TestBed.configureTestingModule({
      providers: [provideRebuildConfig({ apiBaseUrl: API })],
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('loads the catalogue and the guide from our API', async () => {
    const store = TestBed.inject(CatalogStore);
    await store.ensureCatalog();

    expect(store.status()).toBe('ready');
    expect(store.channels()).toHaveLength(4);
    expect(store.categories().map((category) => category.name)).toEqual(['Generalistas', 'Andalucía']);
    expect(store.channels()[0].availability).toBe('playable');
    expect(store.channels()[2].availability).toBe('external');
    expect(store.channels()[3].availability).toBe('no-emission');
    // The catalogue alone issues no guide request: 21 per-channel `/schedule`
    // calls used to fire on every home visit for a snapshot the home never shows.
    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/schedule'))).toHaveLength(0);

    await store.ensureEpg();
    expect(store.epgStatus()).toBe('ready');
    expect(store.scheduleFor(store.channelById('la-1'))?.programs).toHaveLength(1);
    expect(store.scheduleFor(store.channelById('la-2'))?.programs).toHaveLength(0);
  });

  it('joins a guide request already in flight instead of fetching it twice', async () => {
    const store = TestBed.inject(CatalogStore);
    await store.ensureCatalog();
    const scheduleCalls = () =>
      fetchMock.mock.calls.filter(([input]) => String(input).includes('/schedule')).length;
    expect(scheduleCalls()).toBe(0);

    // Three callers race on opening a channel (detail effect, loader, clock).
    // Nothing is cached yet, so only the in-flight guard keeps this at one request.
    const racers = [store.ensureEpg(['la-1']), store.ensureEpg(['la-1']), store.ensureEpg(['la-1'])];
    await Promise.all(racers);

    expect(scheduleCalls()).toBe(1);
    expect(store.epgStatus()).toBe('ready');
  });

  it('never falls back to a third-party catalogue: an unreachable API is an error', async () => {
    fetchMock.mockRejectedValue(new Error('api down'));
    const store = TestBed.inject(CatalogStore);
    await store.ensureCatalog();

    expect(store.status()).toBe('error');
    expect(store.error()).toContain('api down');
    expect(store.channels()).toHaveLength(0);
    // Only our API was contacted; no other host appears in any request.
    for (const [input] of fetchMock.mock.calls) {
      expect(String(input)).toContain('/api/v1/');
    }
  });

  it('keeps the catalogue usable when the guide fails', async () => {
    // Guard every schedule answer, whatever query string the SDK appends.
    fetchMock.mockImplementation((input: string, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname.endsWith('/schedule')) return Promise.reject(new Error('guide down'));
      return routeFetch(input as string, init);
    });

    const store = TestBed.inject(CatalogStore);
    await store.ensureCatalog();
    // `ensureCatalog` starts the guide load without awaiting it, so drive it
    // explicitly instead of racing the store's internal fire-and-forget call.
    await store.ensureEpg([], true);
    expect(store.epgStatus()).toBe('error');
    expect(store.status()).toBe('ready');
    expect(store.channels()).toHaveLength(4);
  });

  describe('filters and paging', () => {
    beforeEach(async () => {
      fetchMock.mockImplementation(routeFetch);
      const store = TestBed.inject(CatalogStore);
      await store.ensureCatalog();
    });

    it('starts unfiltered with a counter', () => {
      const query = TestBed.inject(CatalogueQuery);
      expect(query.view().filteredCount).toBe(4);
      expect(query.view().isFiltered).toBe(false);
      expect(query.view().pageChannels).toHaveLength(4);
    });

    it('filters by search without accents and resets the page', () => {
      const query = TestBed.inject(CatalogueQuery);
      query.goToPage(2);
      query.setQuery('andalu');
      expect(query.view().filteredCount).toBe(1);
      expect(query.view().pageChannels[0].name).toBe('Canal Sur');
      expect(query.view().page).toBe(1);
      expect(query.view().isFiltered).toBe(true);
    });

    it('filters by category and availability', () => {
      const query = TestBed.inject(CatalogueQuery);
      const generalistasId = TestBed.inject(CatalogStore).categories().find((c) => c.name === 'Generalistas')!.id;
      query.setCategory(generalistasId);
      expect(query.view().filteredCount).toBe(3);
      query.setAvailability('external');
      expect(query.view().pageChannels.map((channel) => channel.name)).toEqual(['Cuatro']);
    });

    /*
     * TDT-API-02FG: the previous filter was a single `<select>` whose handler
     * REPLACED the value, so "two categories at once" was impossible by
     * construction. These tests pin the multi-value contract that replaced it.
     */
    it('combines several categories in one selection (any of them)', () => {
      const query = TestBed.inject(CatalogueQuery);
      const store = TestBed.inject(CatalogStore);
      const generalistas = store.categories().find((c) => c.name === 'Generalistas')!.id;
      const other = store.categories().map((category) => category.id).find((id) => id !== generalistas)!;

      query.setCategories([generalistas, other]);
      expect(query.categories()).toEqual([generalistas, other]);
      expect(query.view().filteredCount).toBeGreaterThanOrEqual(3);
      expect(query.view().isFiltered).toBe(true);
    });

    it('toggles a value on and off instead of replacing the selection', () => {
      const query = TestBed.inject(CatalogueQuery);
      query.toggleCountry('ES');
      expect(query.countries()).toEqual(['ES']);
      query.toggleCountry('FR');
      expect(query.countries()).toEqual(['ES', 'FR']);
      query.toggleCountry('ES');
      expect(query.countries()).toEqual(['FR']);
    });

    it('combines different filters with AND', () => {
      const query = TestBed.inject(CatalogueQuery);
      const store = TestBed.inject(CatalogStore);
      const generalistas = store.categories().find((c) => c.name === 'Generalistas')!.id;
      query.setCategories([generalistas]);
      query.setCountries(['ES']);
      const both = query.view().filteredCount;

      query.setCountries(['ES', 'FR']);
      expect(query.view().filteredCount).toBe(both);
    });

    it('an empty selection means "every value", never "nothing matches"', () => {
      const query = TestBed.inject(CatalogueQuery);
      query.setCountries([]);
      query.setCategories([]);
      expect(query.view().isFiltered).toBe(false);
      expect(query.view().filteredCount).toBe(4);
    });

    it('filters by favourites and reports an empty favourites state', () => {
      const query = TestBed.inject(CatalogueQuery);
      const preferences = TestBed.inject(PreferencesStore);

      query.toggleFavoritesOnly();
      expect(query.view().filteredCount).toBe(0);
      expect(query.view().hasFavorites).toBe(false);

      preferences.toggleFavorite('la-2');
      expect(query.view().filteredCount).toBe(1);
      expect(query.view().hasFavorites).toBe(true);
    });

    it('clears every filter at once', () => {
      const query = TestBed.inject(CatalogueQuery);
      query.setQuery('la');
      query.setCategory('generalista');
      query.setAvailability('playable');
      query.setCountry('ES');
      query.setLanguage('ca');
      query.clearFilters();
      expect(query.view().isFiltered).toBe(false);
      expect(query.view().filteredCount).toBe(4);
    });

    it('filters by country, built from the countries the catalogue actually has', () => {
      const query = TestBed.inject(CatalogueQuery);
      // Every fixture is published from ES, so the option list holds exactly one
      // entry and never offers a filter that cannot match anything.
      expect(query.countryOptions().map((country) => country.code)).toEqual(['ES']);
      expect(query.countryOptions()[0]?.channelCount).toBe(4);

      query.setCountry('ES');
      expect(query.view().filteredCount).toBe(4);
      expect(query.view().isFiltered).toBe(true);

      query.setCountry('FR');
      expect(query.view().filteredCount).toBe(0);
      expect(query.view().pageChannels).toEqual([]);
    });

    it('filters by language, and does not claim a language for unlabelled channels', () => {
      const query = TestBed.inject(CatalogueQuery);
      // The API labels every fixture `es`.
      expect(query.languageOptions().map((language) => language.code)).toEqual(['es']);
      expect(query.channelsWithoutLanguage()).toBe(0);

      query.setLanguage('es');
      expect(query.view().filteredCount).toBe(4);

      query.setLanguage('ca');
      expect(query.view().filteredCount).toBe(0);
    });

    it('excludes an unlabelled channel from every language filter', async () => {
      // `Canal Sur` alone publishes no language.
      const mixed: ApiChannelFixture[] = [
        { slug: 'con-idioma', name: 'Con Idioma', category: 'generalista', playbackStatus: 'available' },
        { slug: 'sin-idioma', name: 'Sin Idioma', category: 'generalista', playbackStatus: 'available' },
      ];
      fetchMock.mockImplementation((input: string, init?: RequestInit) => {
        const url = new URL(String(input), 'http://localhost');
        if (url.pathname === '/api/v1/channels') {
          const body = channelListBody(mixed, 1, 100);
          body.data[1].language = null as unknown as string;
          return Promise.resolve(jsonResponse(body));
        }
        return routeFetch(input as string, init);
      });

      const store = TestBed.inject(CatalogStore);
      await store.reloadCatalog();

      const query = TestBed.inject(CatalogueQuery);
      query.clearFilters();
      expect(query.view().filteredCount).toBe(2);
      expect(query.channelsWithoutLanguage()).toBe(1);

      query.setLanguage('es');
      expect(query.view().pageChannels.map((channel) => channel.name)).toEqual(['Con Idioma']);
    });

    it(`pages by ${PAGE_SIZE} and clamps requests`, async () => {
      const manyChannels: ApiChannelFixture[] = Array.from({ length: 25 }, (_, index) => ({
        slug: `canal-${index + 1}`,
        name: `Canal ${index + 1}`,
        category: 'generalista',
        playbackStatus: 'available',
      }));
      fetchMock.mockImplementation((input: string, init?: RequestInit) => {
        const url = new URL(String(input), 'http://localhost');
        if (url.pathname === '/api/v1/channels') {
          const page = Number(url.searchParams.get('page') ?? '1');
          const pageSize = Number(url.searchParams.get('pageSize') ?? '100');
          return Promise.resolve(jsonResponse(channelListBody(manyChannels, page, pageSize)));
        }
        return routeFetch(input as string, init);
      });
      const store = TestBed.inject(CatalogStore);
      await store.reloadCatalog();

      const query = TestBed.inject(CatalogueQuery);
      expect(query.view().pageCount).toBe(2);
      expect(query.view().pageChannels).toHaveLength(PAGE_SIZE);
      expect(query.view().firstVisible).toBe(1);
      expect(query.view().lastVisible).toBe(PAGE_SIZE);

      query.nextPage();
      expect(query.view().page).toBe(2);
      expect(query.view().pageChannels).toHaveLength(4);
      query.nextPage();
      expect(query.view().page).toBe(2);
      query.goToPage(0);
      expect(query.view().page).toBe(1);
    });
  });
});
