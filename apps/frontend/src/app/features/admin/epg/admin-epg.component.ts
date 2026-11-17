/**
 * EPG — coverage, mappings and real ingestion.
 *
 * The coverage numbers are the API's single shared measure (`EpgService.coverage()`
 * through `/admin/epg/coverage`). The screen filters what the API returned; it never
 * derives a second coverage and never invents a programme.
 */
import { ChangeDetectionStrategy, Component, effect, inject } from '@angular/core';
import { DatePipe } from '@angular/common';
import { AdminEpgStore, type CoverageFilter } from '../../../core/admin/admin-epg.store';
import { EmptyStateComponent } from '../../../shared/ui/empty-state.component';
import { IconComponent } from '../../../shared/ui/icon.component';

const FILTERS: readonly { readonly id: CoverageFilter; readonly label: string }[] = [
  { id: 'all', label: 'Todos' },
  { id: 'fresh', label: 'Al día' },
  { id: 'stale', label: 'Caducados' },
  { id: 'empty', label: 'Vacíos' },
  { id: 'not-mapped', label: 'Sin mapear' },
];

@Component({
  selector: 'app-admin-epg',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, EmptyStateComponent, IconComponent],
  template: `
    <section class="epg" aria-labelledby="epg-title">
      <div class="epg__head">
        <h2 id="epg-title">Guía de programación (EPG)</h2>
        <span class="admin-count">Cobertura por canal, mapeos y fuentes XMLTV</span>
      </div>

      @if (store.ingestionError(); as message) {
        <p class="admin-alert" role="alert">
          <app-icon name="alert" [size]="18" />
          {{ message }}
        </p>
      }
      @if (store.lastIngestion(); as message) {
        <p class="admin-ok" role="status">
          <app-icon name="info" [size]="18" />
          {{ message }}
        </p>
      }

      <section aria-labelledby="coverage-title">
        <h3 id="coverage-title">Cobertura</h3>
        @if (store.coverageStatus() === 'loading') {
          <p class="admin-note" role="status">Cargando cobertura…</p>
        } @else if (store.coverageError(); as message) {
          <p class="admin-alert" role="alert">
            <app-icon name="alert" [size]="18" />
            {{ message }}
          </p>
        } @else if (store.coverage(); as coverage) {
          <dl class="metrics">
            <div><dt>Canales</dt><dd class="tabular">{{ coverage.totals.channels }}</dd></div>
            <div><dt>Mapeados</dt><dd class="tabular">{{ coverage.totals.mapped }}</dd></div>
            <div><dt>Al día</dt><dd class="tabular">{{ coverage.totals.fresh }}</dd></div>
            <div><dt>Caducados</dt><dd class="tabular">{{ coverage.totals.stale }}</dd></div>
            <div><dt>Vacíos</dt><dd class="tabular">{{ coverage.totals.empty }}</dd></div>
            <div><dt>Sin mapear</dt><dd class="tabular">{{ coverage.totals.notMapped }}</dd></div>
            <div><dt>Conflictos</dt><dd class="tabular">{{ coverage.conflicts }}</dd></div>
          </dl>
          <p class="admin-note">Medido a las {{ coverage.asOf | date: 'dd/MM HH:mm' }}.</p>

          <div class="filters" role="group" aria-label="Filtrar por estado de cobertura">
            @for (option of filters; track option.id) {
              <button
                type="button"
                class="btn btn--ghost"
                [attr.aria-pressed]="store.filter() === option.id"
                (click)="store.setFilter(option.id)"
              >
                {{ option.label }}
              </button>
            }
          </div>

          @if (store.entries().length === 0) {
            <app-empty-state icon="clock" title="Ningún canal en este estado" message="Cambia el filtro de cobertura." />
          } @else {
            <div class="table-wrap" tabindex="0" role="region" aria-label="Cobertura por canal">
              <table class="admin-table">
                <caption class="visually-hidden">Canales con su estado de cobertura EPG</caption>
                <thead>
                  <tr>
                    <th scope="col">Canal</th>
                    <th scope="col">País</th>
                    <th scope="col">Fuente</th>
                    <th scope="col">Estado</th>
                    <th scope="col">Programas</th>
                  </tr>
                </thead>
                <tbody>
                  @for (entry of store.entries(); track entry.channelId) {
                    <tr>
                      <th scope="row">
                        <span class="cell-strong">{{ entry.name }}</span>
                        <span class="cell-sub">{{ entry.slug }}</span>
                      </th>
                      <td>{{ entry.country }}</td>
                      <td>{{ entry.sourceName ?? '—' }}</td>
                      <td>
                        <span class="status-pill" [attr.data-status]="statusPill(entry.status)">
                          {{ entry.status }}
                        </span>
                      </td>
                      <td class="tabular">{{ entry.programmes }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        }
      </section>

      <section aria-labelledby="sources-title">
        <h3 id="sources-title">Fuentes XMLTV e ingestas</h3>
        @if (store.sourcesError(); as message) {
          <p class="admin-alert" role="alert">
            <app-icon name="alert" [size]="18" />
            {{ message }}
          </p>
        } @else if (store.sources().length === 0) {
          <app-empty-state icon="clock" title="Sin fuentes EPG" message="El backend no tiene fuentes XMLTV registradas." />
        } @else {
          <div class="table-wrap" tabindex="0" role="region" aria-label="Fuentes XMLTV">
            <table class="admin-table">
              <thead>
                <tr>
                  <th scope="col">Fuente</th>
                  <th scope="col">Licencia</th>
                  <th scope="col">Ingesta</th>
                  <th scope="col">Última ejecución</th>
                  <th scope="col"><span class="visually-hidden">Acciones</span></th>
                </tr>
              </thead>
              <tbody>
                @for (source of store.sources(); track source.id) {
                  <tr>
                    <th scope="row">
                      <span class="cell-strong">{{ source.name }}</span>
                      <span class="cell-sub">{{ source.kind }}</span>
                    </th>
                    <td>{{ source.licence }}</td>
                    <td>
                      <span class="status-pill" [attr.data-status]="source.ingestionEnabled ? 'ok' : 'unknown'">
                        {{ source.ingestionEnabled ? 'Activada' : 'Desactivada' }}
                      </span>
                    </td>
                    <td>
                      <span class="cell-sub">{{ source.lastRunAt ? (source.lastRunAt | date: 'dd/MM HH:mm') : 'nunca' }}</span>
                      @if (source.lastRunStatus) {
                        <span class="cell-sub">{{ source.lastRunStatus }}</span>
                      }
                    </td>
                    <td class="cell-actions">
                      <button
                        type="button"
                        class="btn btn--ghost"
                        [attr.aria-label]="'Ingerir ahora ' + source.name"
                        [disabled]="!source.ingestionEnabled || store.ingesting()"
                        (click)="store.ingest(source.id)"
                      >
                        {{ store.ingesting() ? 'Ingiriendo…' : 'Ingerir ahora' }}
                      </button>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }

        @if (store.runsError(); as message) {
          <p class="admin-alert" role="alert">
            <app-icon name="alert" [size]="18" />
            {{ message }}
          </p>
        } @else if (store.runs().length > 0) {
          <h4>Últimas ingestas</h4>
          <ul class="runs">
            @for (run of store.runs(); track run.id) {
              <li>
                <span class="cell-strong">{{ run.sourceName ?? run.sourceId }}</span>
                <span class="status-pill" [attr.data-status]="run.status === 'ok' ? 'ok' : 'error'">{{ run.status }}</span>
                <span class="cell-sub">
                  {{ run.startedAt | date: 'dd/MM HH:mm' }} · {{ run.trigger }} · {{ run.programmes }} programas ·
                  {{ run.channelsMatched }} canales
                  @if (run.error) {
                    · {{ run.error }}
                  }
                </span>
              </li>
            }
          </ul>
        }
      </section>

      <section aria-labelledby="mappings-title">
        <h3 id="mappings-title">Mapeos ({{ store.conflicts().length }} en conflicto)</h3>
        @if (store.mappingsError(); as message) {
          <p class="admin-alert" role="alert">
            <app-icon name="alert" [size]="18" />
            {{ message }}
          </p>
        } @else if (store.mappings().length === 0) {
          <p class="admin-note">El backend no devolvió mapeos.</p>
        } @else {
          <div class="table-wrap" tabindex="0" role="region" aria-label="Mapeos de EPG">
            <table class="admin-table">
              <thead>
                <tr>
                  <th scope="col">Canal</th>
                  <th scope="col">Externo</th>
                  <th scope="col">Estado</th>
                  <th scope="col">Confianza</th>
                  <th scope="col"><span class="visually-hidden">Acciones</span></th>
                </tr>
              </thead>
              <tbody>
                @for (mapping of store.mappings(); track mapping.id) {
                  <tr>
                    <th scope="row">
                      <span class="cell-strong">{{ mapping.channelName }}</span>
                      <span class="cell-sub">{{ mapping.channelSlug }}</span>
                    </th>
                    <td>
                      <span class="cell-sub">{{ mapping.namespace }}:{{ mapping.externalId }}</span>
                      @if (mapping.conflict) {
                        <span class="cell-sub">conflicto</span>
                      }
                    </td>
                    <td>
                      <span class="status-pill" [attr.data-status]="mapping.status === 'confirmed' ? 'ok' : 'unknown'">
                        {{ mapping.status }}
                      </span>
                    </td>
                    <td class="tabular">{{ mapping.confidence }}</td>
                    <td class="cell-actions">
                      <button
                        type="button"
                        class="btn btn--ghost"
                        [attr.aria-label]="'Confirmar el mapeo de ' + mapping.channelName"
                        [disabled]="store.ingesting()"
                        (click)="store.decideMapping(mapping.id, 'confirm', 'Corrección manual de mapeo EPG')"
                      >
                        Confirmar
                      </button>
                      <button
                        type="button"
                        class="btn btn--ghost"
                        [attr.aria-label]="'Rechazar el mapeo de ' + mapping.channelName"
                        [disabled]="store.ingesting()"
                        (click)="store.decideMapping(mapping.id, 'reject', 'Corrección manual de mapeo EPG')"
                      >
                        Rechazar
                      </button>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      </section>

      <p class="admin-note">
        Nunca se inventa programación: si una fuente no trae datos, el canal aparece vacío o caducado y se dice.
      </p>
    </section>
  `,
  styleUrl: '../admin-shared.css',
})
export class AdminEpgComponent {
  protected readonly store = inject(AdminEpgStore);
  protected readonly filters = FILTERS;

  constructor() {
    effect(() => {
      if (this.store.coverageStatus() === 'idle') void this.store.load();
    });
  }

  protected statusPill(status: string): string {
    if (status === 'fresh') return 'ok';
    if (status === 'stale') return 'warn';
    if (status === 'not-mapped') return 'unknown';
    return 'warn';
  }
}
