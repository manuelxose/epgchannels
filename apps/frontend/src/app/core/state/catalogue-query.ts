import { Injectable, computed, signal } from '@angular/core';
import { inject } from '@angular/core';
import { CatalogStore } from './catalog.store';
import { PreferencesStore } from './preferences.store';
import type { Channel } from '../models/catalog.model';
import { matchesQuery, normalizeForSearch, searchForms, SPANISH_COLLATOR } from '../text/normalize';

export const PAGE_SIZE = 21;

export type AvailabilityFilter = 'all' | 'playable' | 'external' | 'no-emission';

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

function isFiltered(query: string, categoryId: string, favoritesOnly: boolean, availability: AvailabilityFilter): boolean {
  return normalizeForSearch(query).length > 0 || categoryId !== 'all' || favoritesOnly || availability !== 'all';
}

/**
 * Catalogue view-model: search, category, favourites and availability filters
 * plus paging. Kept separate from the components so the rules are unit-testable.
 */
@Injectable({ providedIn: 'root' })
export class CatalogueQuery {
  private readonly catalog = inject(CatalogStore);
  private readonly preferences = inject(PreferencesStore);

  readonly query = signal('');
  readonly categoryId = signal('all');
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
    const favoritesOnly = this.favoritesOnly();
    const favorites = this.preferences.favorites();
    const availability = this.availability();
    const index = this.searchIndex();

    return this.catalog.channels().filter((channel) => {
      if (category !== 'all' && channel.categoryId !== category) {
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
      isFiltered: isFiltered(this.query(), this.categoryId(), this.favoritesOnly(), this.availability()),
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

  clearFilters(): void {
    this.query.set('');
    this.categoryId.set('all');
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
