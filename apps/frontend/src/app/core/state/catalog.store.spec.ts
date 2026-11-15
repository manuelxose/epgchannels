import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CatalogStore } from './catalog.store';
import { CatalogueQuery, PAGE_SIZE } from './catalogue-query';
import { PreferencesStore } from './preferences.store';
import { provideRebuildConfig } from '../config/rebuild-config.token';
import { DemoStorage } from './test-support';

const catalog = {
  epg: { json: 'https://example.org/epg.json' },
  countries: [
    {
      name: 'España',
      ambits: [
        {
          name: 'Generalistas',
          channels: [
            { name: 'La 1', options: [{ format: 'm3u8', url: 'https://cdn.example.org/la1.m3u8' }], epg_id: 'La1.TV' },
            { name: 'La 2', options: [{ format: 'm3u8', url: 'https://cdn.example.org/la2.m3u8' }] },
            { name: 'Cuatro', options: [], extra_info: ['EXTA'] },
          ],
        },
        {
          name: 'Andalucía',
          channels: [{ name: 'Canal Sur', options: [], extra_info: ['NOEM'] }],
        },
      ],
    },
  ],
};

const now = Math.floor(Date.now() / 1000);
const epg = {
  0: { name: 'La1.TV', events: [{ hi: now - 600, hf: now + 600, t: 'Ahora en La 1', d: 'x' }] },
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('CatalogStore + CatalogueQuery integration', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    // jsdom exposes localStorage as a read-only accessor, so it is replaced
    // through a property definition rather than assignment.
    Object.defineProperty(globalThis, 'localStorage', {
      value: new DemoStorage(),
      configurable: true,
      writable: true,
    });

    TestBed.configureTestingModule({
      providers: [
        provideRebuildConfig({
          catalogUrl: 'https://upstream.example.org/tv.json',
          epgUrl: 'https://upstream.example.org/TV.epg.json',
          demoCatalogUrl: 'demo/catalog.demo.json',
          demoEpgUrl: 'demo/epg.demo.json',
        }),
      ],
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('loads the remote catalogue and the guide', async () => {
    fetchMock.mockImplementation((input: string) => {
      if (input.includes('tv.json')) return Promise.resolve(jsonResponse(catalog));
      if (input.includes('TV.epg.json')) return Promise.resolve(jsonResponse(epg));
      return Promise.reject(new Error(`unexpected fetch ${input}`));
    });

    const store = TestBed.inject(CatalogStore);
    await store.ensureCatalog();

    expect(store.status()).toBe('ready');
    expect(store.usingDemoCatalog()).toBe(false);
    expect(store.channels()).toHaveLength(4);
    expect(store.categories().map((category) => category.name)).toEqual(['Generalistas', 'Andalucía']);
    expect(store.channels()[0].availability).toBe('playable');
    expect(store.channels()[2].availability).toBe('external');
    expect(store.channels()[3].availability).toBe('no-emission');

    await vi.waitFor(() => expect(store.epgStatus()).toBe('ready'));
    expect(store.scheduleFor(store.channelById('la-1'))?.programs).toHaveLength(1);
    expect(store.scheduleFor(store.channelById('la-2'))).toBeUndefined();
  });

  it('falls back to the bundled demo catalogue when upstream fails', async () => {
    fetchMock.mockImplementation((input: string) => {
      if (input.includes('upstream.example.org/tv.json')) return Promise.reject(new Error('network down'));
      if (input.includes('demo/catalog.demo.json')) return Promise.resolve(jsonResponse(catalog));
      if (input.includes('demo/epg.demo.json')) return Promise.resolve(jsonResponse(epg));
      return Promise.reject(new Error(`unexpected fetch ${input}`));
    });

    const store = TestBed.inject(CatalogStore);
    await store.ensureCatalog();

    expect(store.status()).toBe('ready');
    expect(store.usingDemoCatalog()).toBe(true);
    expect(store.channels()).toHaveLength(4);
  });

  it('keeps the catalogue usable when the guide fails', async () => {
    fetchMock.mockImplementation((input: string) => {
      if (input.includes('tv.json')) return Promise.resolve(jsonResponse(catalog));
      return Promise.reject(new Error('guide down'));
    });

    const store = TestBed.inject(CatalogStore);
    await store.ensureCatalog();
    await vi.waitFor(() => expect(store.epgStatus()).toBe('error'));
    expect(store.status()).toBe('ready');
    expect(store.channels()).toHaveLength(4);
  });

  it('surfaces an error when neither source is reachable', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    const store = TestBed.inject(CatalogStore);
    await store.ensureCatalog();
    expect(store.status()).toBe('error');
    expect(store.error()).toContain('offline');
  });

  describe('filters and paging', () => {
    beforeEach(async () => {
      fetchMock.mockImplementation((input: string) => {
        if (input.includes('tv.json')) return Promise.resolve(jsonResponse(catalog));
        return Promise.resolve(jsonResponse(epg));
      });
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
      query.setCategory('españa:generalistas');
      query.setAvailability('playable');
      query.clearFilters();
      expect(query.view().isFiltered).toBe(false);
      expect(query.view().filteredCount).toBe(4);
    });

    it(`pages by ${PAGE_SIZE} and clamps requests`, async () => {
      const many = {
        countries: [
          {
            name: 'España',
            ambits: [
              {
                name: 'Generalistas',
                channels: Array.from({ length: 25 }, (_, index) => ({
                  name: `Canal ${index + 1}`,
                  options: [{ format: 'm3u8', url: `https://cdn.example.org/${index}.m3u8` }],
                })),
              },
            ],
          },
        ],
      };
      fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(many)));
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
