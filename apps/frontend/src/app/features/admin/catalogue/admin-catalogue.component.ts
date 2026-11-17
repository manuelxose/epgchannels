/**
 * Catálogo — the editorial workbench.
 *
 * The list is the basic operation: find a channel, see its editorial state, open
 * it. Technical detail (source health, eligibility, priorities) lives in the
 * drawer, behind a disclosure, so neither screen becomes monolithic.
 */
import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import type { AdminCatalogueRow, ChannelCategory, EditorialStatus } from '@tdt/contracts';
import { AdminCatalogueStore } from '../../../core/admin/admin-catalogue.store';
import { EmptyStateComponent } from '../../../shared/ui/empty-state.component';
import { IconComponent } from '../../../shared/ui/icon.component';
import { AdminChannelDrawerComponent } from './admin-channel-drawer.component';

const STATUS_LABEL: Readonly<Record<EditorialStatus, string>> = {
  draft: 'Borrador',
  review: 'En revisión',
  published: 'Publicado',
  withdrawn: 'Retirado',
};

const CATEGORIES: readonly ChannelCategory[] = [
  'generalista',
  'informativos',
  'deportes',
  'infantil',
  'musica',
  'cultura',
  'cine-series',
  'documentales',
  'entretenimiento',
  'religion',
  'local',
  'autonomica',
  'internacional',
  'otros',
];

@Component({
  selector: 'app-admin-catalogue',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [EmptyStateComponent, IconComponent, AdminChannelDrawerComponent],
  template: `
    <section aria-labelledby="catalogue-title" class="catalogue">
      <div class="catalogue__head">
        <h2 id="catalogue-title">Catálogo</h2>
        <span class="admin-count" aria-live="polite">
          @if (store.pagination(); as page) {
            {{ page.total }} canales · página {{ page.page }} de {{ page.pageCount || 1 }}
          }
        </span>
      </div>

      <form class="filters" role="search" (submit)="apply($event)">
        <label class="field">
          <span class="field__label">Buscar</span>
          <input
            type="search"
            name="q"
            placeholder="Nombre del canal…"
            [value]="store.filters().q"
            (input)="store.setFilters({ q: value($event) })"
          />
        </label>

        <label class="field">
          <span class="field__label">Estado editorial</span>
          <select name="status" (change)="setStatus(value($event))">
            <option value="">Todos</option>
            @for (option of statuses; track option) {
              <option [value]="option" [selected]="option === store.filters().status">{{ statusLabel(option) }}</option>
            }
          </select>
        </label>

        <label class="field">
          <span class="field__label">País</span>
          <input
            name="country"
            maxlength="3"
            placeholder="ES"
            [value]="store.filters().country"
            (input)="store.setFilters({ country: value($event).toUpperCase() })"
          />
        </label>

        <label class="field">
          <span class="field__label">Categoría</span>
          <select name="category" (change)="setCategory(value($event))">
            <option value="">Todas</option>
            @for (option of categories; track option) {
              <option [value]="option" [selected]="option === store.filters().category">{{ option }}</option>
            }
          </select>
        </label>
      </form>

      @if (store.status() === 'loading') {
        <p class="admin-note" role="status">Cargando catálogo…</p>
      } @else if (store.status() === 'error') {
        <p class="admin-alert" role="alert">
          <app-icon name="alert" [size]="18" />
          {{ store.error() }}
        </p>
        <button type="button" class="btn btn--ghost" (click)="store.load()">Reintentar</button>
      } @else if (store.rows().length === 0) {
        <app-empty-state
          icon="search"
          title="Ningún canal coincide"
          message="Prueba con otro texto o quita algún filtro."
        />
      } @else {
        <div class="table-wrap" tabindex="0" role="region" aria-label="Canales del catálogo">
          <table class="admin-table">
            <caption class="visually-hidden">
              Canales con estado editorial, fuentes y avisos de duplicado
            </caption>
            <thead>
              <tr>
                <th scope="col">Canal</th>
                <th scope="col">País</th>
                <th scope="col">Categoría</th>
                <th scope="col">Estado</th>
                <th scope="col">Fuentes</th>
                <th scope="col"><span class="visually-hidden">Acciones</span></th>
              </tr>
            </thead>
            <tbody>
              @for (row of store.rows(); track row.id) {
                <tr [class.is-selected]="row.id === selectedId()">
                  <th scope="row">
                    <span class="cell-strong">{{ row.name }}</span>
                    <span class="cell-sub">{{ row.slug }}</span>
                  </th>
                  <td>{{ row.country }}</td>
                  <td>{{ row.category }}</td>
                  <td>
                    <span class="status-pill" [attr.data-status]="row.editorialStatus">
                      {{ statusLabel(row.editorialStatus) }}
                    </span>
                  </td>
                  <td>
                    <span class="tabular">{{ row.eligibleSources }}/{{ row.sourceCandidates }}</span>
                    @if (row.duplicateOf) {
                      <span class="cell-sub">duplicado propuesto</span>
                    }
                  </td>
                  <td class="cell-actions">
                    <button
                      type="button"
                      class="btn btn--ghost"
                      [attr.aria-label]="'Abrir ' + row.name"
                      (click)="open(row)"
                    >
                      Abrir
                    </button>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>

        @if (store.pagination(); as page) {
          @if (page.pageCount > 1) {
            <nav class="pager" aria-label="Paginación del catálogo">
              <button
                type="button"
                class="btn btn--ghost"
                [disabled]="!page.hasPrevious || store.status() === 'loading'"
                (click)="store.setFilters({ page: page.page - 1 })"
              >
                Anterior
              </button>
              <span class="pager__label tabular">{{ page.page }} / {{ page.pageCount }}</span>
              <button
                type="button"
                class="btn btn--ghost"
                [disabled]="!page.hasNext || store.status() === 'loading'"
                (click)="store.setFilters({ page: page.page + 1 })"
              >
                Siguiente
              </button>
            </nav>
          }
        }
      }
    </section>

    @if (selectedId(); as id) {
      <app-admin-channel-drawer [channelId]="id" (closed)="close()" />
    }
  `,
  styleUrl: '../admin-shared.css',
})
export class AdminCatalogueComponent {
  protected readonly store = inject(AdminCatalogueStore);
  protected readonly statuses: readonly EditorialStatus[] = ['draft', 'review', 'published', 'withdrawn'];
  protected readonly categories = CATEGORIES;
  protected readonly selectedId = signal<string | null>(null);
  private lastOpened = computed(() => this.store.detail()?.id ?? null);

  constructor() {
    // Load once the area is mounted and the session exists.
    effect(() => {
      if (this.store.status() === 'idle') void this.store.load();
    });
    // Escape closes the drawer from anywhere when it is not handled inside.
    effect(() => {
      if (this.lastOpened() === null) this.selectedId.set(null);
    });
  }

  protected value(event: Event): string {
    return (event.target as HTMLInputElement | HTMLSelectElement).value;
  }

  protected statusLabel(status: EditorialStatus): string {
    return STATUS_LABEL[status] ?? status;
  }

  protected setStatus(value: string): void {
    void this.store.setFilters({ status: value as EditorialStatus | '' });
  }

  protected setCategory(value: string): void {
    void this.store.setFilters({ category: value as ChannelCategory | '' });
  }

  protected open(row: AdminCatalogueRow): void {
    this.selectedId.set(row.id);
    void this.store.open(row.id);
  }

  protected close(): void {
    this.selectedId.set(null);
    this.store.close();
  }

  /** Enter in any filter applies it immediately instead of waiting for blur. */
  protected apply(event: Event): void {
    event.preventDefault();
    void this.store.load();
  }
}
