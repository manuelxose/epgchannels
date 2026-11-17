import { Injectable, computed, signal, type WritableSignal } from '@angular/core';
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
  categories: readonly string[],
  favoritesOnly: boolean,
  availability: AvailabilityFilter,
  countries: readonly string[],
  languages: readonly string[],
): boolean {
  return (
    normalizeForSearch(query).length > 0 ||
    categories.length > 0 ||
    favoritesOnly ||
    availability !== 'all' ||
    countries.length > 0 ||
    languages.length > 0
  );
}

/**
 * Catalogue view-model: search, category, country, language, favourites and
 * availability filters plus paging.
 *
 * Filters are **multi-valued** since TDT-API-02FG: `?category=a&category=b` is
 * "any of these categories", and different filters combine with AND — which is
 * what a person means when they pick two categories and then a country. An empty
 * selection is "all", never "none". The old single-value setters are kept as
 * one-element selections so existing callers and tests keep working.
 *
 * Kept separate from the components so the rules are unit-testable.
 */
@Injectable({ providedIn: 'root' })
export class CatalogueQuery {
  private readonly catalog = inject(CatalogStore);
  private readonly preferences = inject(PreferencesStore);

  readonly query = signal('');
  /** Selected categories; empty means every category. */
  readonly categories = signal<readonly string[]>([]);
  /** Selected ISO-3166 codes as published by the catalogue; empty means all. */
  readonly countries = signal<readonly string[]>([]);
  /** Selected language codes; empty means all. */
  readonly languages = signal<readonly string[]>([]);
  readonly favoritesOnly = signal(false);
  readonly availability = signal<AvailabilityFilter>('all');
  readonly page = signal(1);

  /** The first selected category, or `'all'`; kept for existing callers. */
  readonly categoryId = computed(() => this.categories()[0] ?? 'all');
  /** The first selected country, or `'all'`; kept for existing callers. */
  readonly country = computed(() => this.countries()[0] ?? 'all');
  /** The first selected language, or `'all'`; kept for existing callers. */
  readonly language = computed(() => this.languages()[0] ?? 'all');

  private readonly searchIndex = computed(() => {
    const index = new Map<string, string>();
    for (const channel of this.catalog.channels()) {
      index.set(channel.id, searchForms(normalizeForSearch(`${channel.name} ${channel.categoryName}`)).join(' '));
    }
    return index;
  });

  private readonly filtered = computed<readonly Channel[]>(() => {
    const query = normalizeForSearch(this.query());
    const categories = new Set(this.categories());
    const countries = new Set(this.countries());
    const languages = new Set(this.languages());
    const favoritesOnly = this.favoritesOnly();
    const favorites = this.preferences.favorites();
    const availability = this.availability();
    const index = this.searchIndex();

    return this.catalog.channels().filter((channel) => {
      /* Within a filter: any of the values. Between filters: all of them. */
      if (categories.size > 0 && !categories.has(channel.categoryId)) {
        return false;
      }
      if (countries.size > 0 && !countries.has(channel.country)) {
        return false;
      }
      // A channel with no published language is not claimed to be in any
      // language: it only appears when no language filter is applied.
      if (languages.size > 0) {
        const language = channelLanguage(channel);
        if (language === undefined || !languages.has(language)) {
          return false;
        }
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
        this.categories(),
        this.favoritesOnly(),
        this.availability(),
        this.countries(),
        this.languages(),
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
   *
   * countryOptions is the same list under a name that does not collide with
   * the countries FILTER signal above.
   */
  readonly countryOptions = computed(() => {
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
  readonly languageOptions = computed(() => {
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

  /**
   * Replaces the category selection. `'all'` (or an empty list) clears it.
   * Kept as the single-value entry point for existing callers and tests.
   */
  setCategory(categoryId: string): void {
    this.setCategories(categoryId === 'all' ? [] : [categoryId]);
  }

  /** Replaces the whole category selection; several values mean "any of these". */
  setCategories(values: readonly string[]): void {
    this.categories.set([...new Set(values.filter((value) => value !== '' && value !== 'all'))]);
    this.page.set(1);
  }

  /** Adds or removes one value from the current selection. */
  toggleCategory(categoryId: string): void {
    this.toggleIn(this.categories, categoryId);
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
    this.setCountries(code === 'all' ? [] : [code]);
  }

  setCountries(values: readonly string[]): void {
    this.countries.set([...new Set(values.filter((value) => value !== '' && value !== 'all'))]);
    this.page.set(1);
  }

  toggleCountry(code: string): void {
    this.toggleIn(this.countries, code);
  }

  setLanguage(code: string): void {
    this.setLanguages(code === 'all' ? [] : [code]);
  }

  setLanguages(values: readonly string[]): void {
    this.languages.set([...new Set(values.filter((value) => value !== '' && value !== 'all'))]);
    this.page.set(1);
  }

  toggleLanguage(code: string): void {
    this.toggleIn(this.languages, code);
  }

  /** Shared toggle for the multi-valued filters: selects, or deselects if present. */
  private toggleIn(target: WritableSignal<readonly string[]>, value: string): void {
    if (value === '' || value === 'all') return;
    target.update((current) =>
      current.includes(value) ? current.filter((entry) => entry !== value) : [...current, value],
    );
    this.page.set(1);
  }

  clearFilters(): void {
    this.query.set('');
    this.categories.set([]);
    this.countries.set([]);
    this.languages.set([]);
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
