import {
  ChangeDetectionStrategy,
  Component,
  effect,
  ElementRef,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { IconComponent } from '../../shared/ui/icon.component';
import { EmptyStateComponent } from '../../shared/ui/empty-state.component';
import { ChannelTileComponent } from './channel-tile.component';
import { CatalogueQuery } from '../../core/state/catalogue-query';
import { CatalogStore } from '../../core/state/catalog.store';
import { PreferencesStore } from '../../core/state/preferences.store';

/**
 * Catalogue rail: search, category filter, favourites filter and paged grid.
 * Owns the accessible result counter so screen readers announce every change.
 */
@Component({
  selector: 'app-catalogue-rail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, ChannelTileComponent, EmptyStateComponent],
  templateUrl: './catalogue-rail.component.html',
  styleUrl: './catalogue-rail.component.css',
})
export class CatalogueRailComponent {
  readonly activeChannelId = input<string | null>(null);
  readonly focusRequest = input(0);

  protected readonly query = inject(CatalogueQuery);
  protected readonly catalog = inject(CatalogStore);
  protected readonly preferences = inject(PreferencesStore);

  protected readonly searchRef = viewChild<ElementRef<HTMLInputElement>>('searchInput');
  protected readonly gridRef = viewChild<ElementRef<HTMLElement>>('grid');
  protected readonly favoriteSelectionAnnouncement = signal('');

  protected readonly loading = this.catalog.status;
  protected readonly skeletons = Array.from({ length: 12 }, (_, index) => index);

  constructor() {
    effect(() => {
      const request = this.focusRequest();
      if (request > 0) {
        this.searchRef()?.nativeElement.focus();
      }
    });
  }

  protected resultSummary(): string {
    const view = this.query.view();
    const noun = view.filteredCount === 1 ? 'canal' : 'canales';
    if (view.isFiltered) {
      if (view.filteredCount === 0) {
        return '0 resultados';
      }
      return view.filteredCount === 1 ? '1 resultado' : `${view.filteredCount} resultados`;
    }
    if (view.filteredCount === 0) {
      return '0 canales';
    }
    return `Mostrando ${view.firstVisible}–${view.lastVisible} de ${view.filteredCount} ${noun}`;
  }

  protected onSearch(event: Event): void {
    this.query.setQuery((event.target as HTMLInputElement).value);
  }

  /** Every value currently selected in a multi-select, in DOM order. */
  private selectedValues(event: Event): string[] {
    const select = event.target as HTMLSelectElement;
    return [...select.selectedOptions].map((option) => option.value).filter((value) => value !== '');
  }

  protected onCategories(event: Event): void {
    this.query.setCategories(this.selectedValues(event));
  }

  protected isCategorySelected(id: string): boolean {
    return this.query.categories().includes(id);
  }

  protected onAvailability(event: Event): void {
    this.query.setAvailability((event.target as HTMLSelectElement).value as never);
  }

  protected onCountries(event: Event): void {
    this.query.setCountries(this.selectedValues(event));
  }

  protected isCountrySelected(code: string): boolean {
    return this.query.countries().includes(code);
  }

  protected onLanguages(event: Event): void {
    this.query.setLanguages(this.selectedValues(event));
  }

  protected isLanguageSelected(code: string): boolean {
    return this.query.languages().includes(code);
  }

  /**
   * Visible summary of a multi-select. "Filtro ninguno" means no filter (every
   * value shows), never "nothing matches".
   *
   * Wording avoids gender agreement on purpose: "Todos"/"Todas" and
   * "seleccionado"/"seleccionada" cannot both be right for "país" and "categoría",
   * and a label that reads wrong makes the filter look broken.
   */
  protected selectionHint(values: readonly string[], noun: string): string {
    if (values.length === 0) return `Sin filtro de ${noun}`;
    return `${values.length} ${noun} en el filtro`;
  }

  protected onFavorite(channelId: string): void {
    const nowFavorite = this.preferences.toggleFavorite(channelId);
    this.favoriteSelectionAnnouncement.set(nowFavorite ? 'Añadido a favoritos' : 'Quitado de favoritos');
  }

  protected focusSearch(): void {
    this.searchRef()?.nativeElement.focus();
  }

  protected clearSearch(): void {
    this.query.setQuery('');
    this.focusSearch();
  }

  protected isFavorite(channelId: string): boolean {
    return this.preferences.favorites().has(channelId);
  }
}
