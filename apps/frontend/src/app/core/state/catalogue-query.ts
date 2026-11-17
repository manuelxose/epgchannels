import { Injectable, computed, signal } from '@angular/core';
import { inject } from '@angular/core';
import { CatalogStore } from './catalog.store';
import { PreferencesStore } from './preferences.store';
import type { Channel } from '../models/catalog.model';
import { matchesQuery, normalizeForSearch, searchForms, SPANISH_COLLATOR } from '../text/normalize';

export const PAGE_SIZE = 21;

export type AvailabilityFilter = 'all' | 'playable' | 'external' | 'no-emission';

/**
 * The language a channel is filtered by.
 *
 * A BCP-47 tag may carry a region (`es-ES`); the catalogue filter is by
 * language, so only the primary subtag is compared. A channel the API did not
 * label has no language and is never counted under one.
 */
export function channelLanguage(channel: Channel): string | undefined {
  const tag = channel.language;
  if (!tag) {
    return undefined;
  }
  return tag.toLowerCase().split('-')[0];
}

/** Human names for the language codes the catalogue publishes. */
const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  es: 'Español',
  ca: 'Català',
  gl: 'Galego',
  eu: 'Euskara',
  en: 'English',
  fr: 'Français',
  de: 'Deutsch',
  it: 'Italiano',
  pt: 'Português',
  ar: 'العربية',
  ro: 'Română',
  zh: '中文',
  ja: '日本語',
};

/** Display name for a language code, falling back to the code itself. */
export function languageLabel(code: string): string {
  return LANGUAGE_NAMES[code] ?? code.toUpperCase();
}

/**
 * Name for a country code, using the user's locale.
 *
 * `Intl.DisplayNames.of` throws a RangeError for a language code it does not
 * recognise as a region, so any failure falls back to the raw code.
 */
export function countryLabel(code: string): string {
  try {
    const names = new Intl.DisplayNames(['es'], { type: 'region' });
    return names.of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * Name for a language code, using the user's locale.
 *
 * Deliberately does NOT call `of(code)` unconditionally: for a language code
 * `Intl.DisplayNames` with `type: 'region'` mis-steps (an earlier version of
 * this function threw a RangeError here and removed the whole language filter
 * from the page). The curated table covers every language the catalogue
 * publishes; anything else is shown as its own code.
 */
export function languageDisplayName(code: string): string {
  const known = LANGUAGE_NAMES[code];
  if (known) {
    return known;
  }
  try {
    const names = new Intl.DisplayNames(['es'], { type: 'language' });
    return names.of(code) ?? code.toUpperCase();
  } catch {
    return code.toUpperCase();
  }
}

export interface CatalogueView {
  readonly pageChannels: readonly Channel[];
  readonly filteredCount: number;
  readonly totalCount: number;
  readonly page: number;
  readonly pageCount: number;
  readonly firstVisible: number;
  readonly lastVisible: number;
  readonly isFiltered: boolean;
  readonly hasFavorites: boolean;
}

function isFiltered(
  query: string,
  categoryId: string,
  favoritesOnly: boolean,
  availability: AvailabilityFilter,
  country: string,
  language: string,
): boolean {
  return (
    normalizeForSearch(query).length > 0 ||
    categoryId !== 'all' ||
    favoritesOnly ||
    availability !== 'all' ||
    country !== 'all' ||
    language !== 'all'
  );
}

/**
 * Catalogue view-model: search, category, country, language, favourites and
 * availability filters plus paging. Kept separate from the components so the
 * rules are unit-testable.
 */
@Injectable({ providedIn: 'root' })
export class CatalogueQuery {
  private readonly catalog = inject(CatalogStore);
  private readonly preferences = inject(PreferencesStore);

  readonly query = signal('');
  readonly categoryId = signal('all');
  /** `'all'` or an ISO-3166 alpha-2 country code as published by the catalogue. */
  readonly country = signal('all');
  /** `'all'` or a language code (`es`, `ca`, `en`…) as published per channel. */
  readonly language = signal('all');
  readonly favoritesOnly = signal(false);
  readonly availability = signal<AvailabilityFilter>('all');
  readonly page = signal(1);

  private readonly searchIndex = computed(() => {
    const index = new Map<string, string>();
    for (const channel of this.catalog.channels()) {
      index.set(channel.id, searchForms(normalizeForSearch(`${channel.name} ${channel.categoryName}`)).join(' '));
    }
    return index;
  });

  private readonly filtered = computed<readonly Channel[]>(() => {
    const query = normalizeForSearch(this.query());
    const category = this.categoryId();
    const country = this.country();
    const language = this.language();
    const favoritesOnly = this.favoritesOnly();
    const favorites = this.preferences.favorites();
    const availability = this.availability();
    const index = this.searchIndex();

    return this.catalog.channels().filter((channel) => {
      if (category !== 'all' && channel.categoryId !== category) {
        return false;
      }
      if (country !== 'all' && channel.country !== country) {
        return false;
      }
      // A channel with no published language is not claimed to be in any
      // language: it only appears when no language filter is applied.
      if (language !== 'all' && channelLanguage(channel) !== language) {
        return false;
      }
      if (favoritesOnly && !favorites.has(channel.id)) {
        return false;
      }
      if (availability !== 'all' && channel.availability !== availability) {
        return false;
      }
      return matchesQuery(index.get(channel.id) ?? '', query);
    });
  });

  readonly view = computed<CatalogueView>(() => {
    const filtered = this.filtered();
    const total = filtered.length;
    const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const page = Math.min(Math.max(1, this.page()), pageCount);
    const start = (page - 1) * PAGE_SIZE;
    const pageChannels = filtered.slice(start, start + PAGE_SIZE);
    return {
      pageChannels,
      filteredCount: total,
      totalCount: this.catalog.channels().length,
      page,
      pageCount,
      firstVisible: total === 0 ? 0 : start + 1,
      lastVisible: start + pageChannels.length,
      isFiltered: isFiltered(
        this.query(),
        this.categoryId(),
        this.favoritesOnly(),
        this.availability(),
        this.country(),
        this.language(),
      ),
      hasFavorites: this.preferences.hasFavorites(),
    };
  });

  readonly groupedCategories = computed(() => {
    const groups = new Map<string, { id: string; name: string; channelCount: number }[]>();
    for (const category of this.catalog.categories()) {
      const list = groups.get(category.country) ?? [];
      list.push({ id: category.id, name: category.name, channelCount: category.channelCount });
      groups.set(category.country, list);
    }
    return [...groups.entries()].map(([country, categories]) => ({ country, categories }));
  });

  /**
   * Countries actually present in the catalogue, with their channel counts.
   * Built from the data so the rail never offers an empty filter.
   */
  readonly countries = computed(() => {
    const counts = new Map<string, number>();
    for (const channel of this.catalog.channels()) {
      counts.set(channel.country, (counts.get(channel.country) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([code, channelCount]) => ({ code, label: countryLabel(code), channelCount }))
      .sort((a, b) => a.label.localeCompare(b.label, 'es'));
  });

  /**
   * Languages actually present in the catalogue, with their channel counts.
   * A channel with no published language contributes to no language.
   */
  readonly languages = computed(() => {
    const counts = new Map<string, number>();
    for (const channel of this.catalog.channels()) {
      const code = channelLanguage(channel);
      if (code) {
        counts.set(code, (counts.get(code) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .map(([code, channelCount]) => ({ code, label: languageDisplayName(code), channelCount }))
      .sort((a, b) => a.label.localeCompare(b.label, 'es'));
  });

  /** Number of channels published without a language, for an honest summary. */
  readonly channelsWithoutLanguage = computed(
    () => this.catalog.channels().filter((channel) => channelLanguage(channel) === undefined).length,
  );

  /** Channels marked as favourites, ordered by name, for the "recientes/favoritos" rail. */
  readonly favoriteChannels = computed<readonly Channel[]>(() => {
    const favorites = this.preferences.favorites();
    return this.catalog
      .channels()
      .filter((channel) => favorites.has(channel.id))
      .sort((a, b) => SPANISH_COLLATOR.compare(a.name, b.name));
  });

  readonly recentChannels = computed<readonly Channel[]>(() => {
    const channels = this.catalog.channels();
    const byId = new Map(channels.map((channel) => [channel.id, channel]));
    return this.preferences
      .recent()
      .map((id) => byId.get(id))
      .filter((channel): channel is Channel => channel !== undefined);
  });

  setQuery(value: string): void {
    this.query.set(value);
    this.page.set(1);
  }

  setCategory(categoryId: string): void {
    this.categoryId.set(categoryId);
    this.page.set(1);
  }

  toggleFavoritesOnly(): void {
    this.favoritesOnly.update((value) => !value);
    this.page.set(1);
  }

  setAvailability(value: AvailabilityFilter): void {
    this.availability.set(value);
    this.page.set(1);
  }

  setCountry(code: string): void {
    this.country.set(code);
    this.page.set(1);
  }

  setLanguage(code: string): void {
    this.language.set(code);
    this.page.set(1);
  }

  clearFilters(): void {
    this.query.set('');
    this.categoryId.set('all');
    this.country.set('all');
    this.language.set('all');
    this.favoritesOnly.set(false);
    this.availability.set('all');
    this.page.set(1);
  }

  goToPage(page: number): void {
    const { pageCount } = this.view();
    this.page.set(Math.min(Math.max(1, page), pageCount));
  }

  nextPage(): void {
    this.goToPage(this.view().page + 1);
  }

  previousPage(): void {
    this.goToPage(this.view().page - 1);
  }
}
