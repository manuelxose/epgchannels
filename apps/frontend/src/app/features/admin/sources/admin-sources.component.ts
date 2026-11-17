/**
 * Fuentes y reproducción — real source health across the catalogue.
 *
 * Every row is an API row from `/admin/sources/health`; the filters are the API's
 * own query parameters, so what the operator filters is what the backend filters.
 * Failure classes are shown as labels, never as a raw upstream message.
 */
import { ChangeDetectionStrategy, Component, effect, inject, signal } from '@angular/core';
import type { AdminSourceFailureClass, AdminSourceHealthRow } from '@tdt/contracts';
import { AdminApiService, describeAdminError, type SourceHealthPage } from '../../../core/admin/admin-api.service';
import { AdminSessionStore } from '../../../core/admin/admin-session.store';
import { EmptyStateComponent } from '../../../shared/ui/empty-state.component';
import { IconComponent } from '../../../shared/ui/icon.component';

const FAILURE_CLASSES: readonly AdminSourceFailureClass[] = [
  'none',
  'http-error',
  'unreachable',
  'invalid-manifest',
  'missing-segments',
  'unsupported-format',
  'timeout',
  'unknown',
];

@Component({
  selector: 'app-admin-sources',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [EmptyStateComponent, IconComponent],
  template: `
    <section class="sources" aria-labelledby="sources-title">
      <div class="sources__head">
        <h2 id="sources-title">Fuentes y reproducción</h2>
        <span class="admin-count" aria-live="polite">
          @if (pagination(); as page) {
            {{ page.total }} fuentes · página {{ page.page }}
          }
        </span>
      </div>

      <form class="filters" role="search" (submit)="$event.preventDefault()">
        <label class="field">
          <span class="field__label">Clase de fallo</span>
          <select name="failureClass" (change)="setFailureClass(value($event))">
            <option value="">Todas</option>
            @for (option of failureClasses; track option) {
              <option [value]="option" [selected]="option === failureClass()">{{ option }}</option>
            }
          </select>
        </label>
        <label class="field">
          <span class="field__label">Elegibles</span>
          <select name="eligible" (change)="setEligible(value($event))">
            <option value="">Todas</option>
            <option value="true" [selected]="eligible() === true">Sí</option>
            <option value="false" [selected]="eligible() === false">No</option>
          </select>
        </label>
        <button type="button" class="btn btn--ghost" (click)="load()">Actualizar</button>
      </form>

      @if (status() === 'loading') {
        <p class="admin-note" role="status">Cargando salud de fuentes…</p>
      } @else if (status() === 'error') {
        <p class="admin-alert" role="alert">
          <app-icon name="alert" [size]="18" />
          {{ error() }}
        </p>
      } @else if (rows().length === 0) {
        <app-empty-state
          icon="signal-off"
          title="Ninguna fuente coincide"
          message="Prueba a quitar los filtros de clase de fallo o de elegibilidad."
        />
      } @else {
        <div class="table-wrap" tabindex="0" role="region" aria-label="Salud de las fuentes">
          <table class="admin-table">
            <caption class="visually-hidden">
              Fuentes con su estado técnico, clase de fallo y elegibilidad
            </caption>
            <thead>
              <tr>
                <th scope="col">Canal</th>
                <th scope="col">Proveedor</th>
                <th scope="col">Permiso</th>
                <th scope="col">Técnica</th>
                <th scope="col">Fallo</th>
                <th scope="col">Fallos seguidos</th>
                <th scope="col">Elegible</th>
              </tr>
            </thead>
            <tbody>
              @for (row of rows(); track row.id) {
                <tr>
                  <th scope="row">
                    <span class="cell-strong">{{ row.channelName ?? row.channelId }}</span>
                    <span class="cell-sub">{{ row.channelSlug ?? '—' }}</span>
                  </th>
                  <td>{{ row.provider }}</td>
                  <td>{{ row.permission }}</td>
                  <td>
                    <span class="status-pill" [attr.data-status]="pill(row.technicalStatus)">
                      {{ row.technicalStatus }}
                    </span>
                  </td>
                  <td>{{ row.failureClass }}</td>
                  <td class="tabular">{{ row.consecutiveFailures }}</td>
                  <td>
                    {{ row.eligible ? 'Sí' : 'No' }}
                    @if (row.eligibilityReason) {
                      <span class="cell-sub">{{ row.eligibilityReason }}</span>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }

      @if (actionMessage()) {
        <p class="admin-ok" role="status">
          <app-icon name="info" [size]="18" />
          {{ actionMessage() }}
        </p>
      }
    </section>
  `,
  styleUrl: '../admin-shared.css',
})
export class AdminSourcesComponent {
  private readonly api = inject(AdminApiService);
  private readonly session = inject(AdminSessionStore);

  protected readonly failureClasses = FAILURE_CLASSES;
  protected readonly failureClass = signal<AdminSourceFailureClass | ''>('');
  protected readonly eligible = signal<boolean | null>(null);
  protected readonly rows = signal<readonly AdminSourceHealthRow[]>([]);
  protected readonly pagination = signal<SourceHealthPage['pagination'] | null>(null);
  protected readonly status = signal<'idle' | 'loading' | 'ready' | 'error'>('idle');
  protected readonly error = signal<string | null>(null);
  protected readonly actionMessage = signal<string | null>(null);

  constructor() {
    effect(() => {
      if (this.status() === 'idle') void this.load();
    });
  }

  protected value(event: Event): string {
    return (event.target as HTMLSelectElement).value;
  }

  protected setFailureClass(value: string): void {
    this.failureClass.set(value as AdminSourceFailureClass | '');
    void this.load();
  }

  protected setEligible(value: string): void {
    this.eligible.set(value === '' ? null : value === 'true');
    void this.load();
  }

  protected pill(status: string): string {
    if (status === 'ok') return 'ok';
    if (status === 'unknown') return 'unknown';
    return 'error';
  }

  async load(): Promise<void> {
    const token = this.session.token();
    if (!token) {
      this.status.set('error');
      this.error.set('Inicia sesión para consultar las fuentes.');
      return;
    }
    this.status.set('loading');
    this.error.set(null);
    try {
      const eligible = this.eligible();
      const page = await this.api.sourceHealth(
        {
          page: 1,
          pageSize: 100,
          ...(this.failureClass() ? { failureClass: this.failureClass() as AdminSourceFailureClass } : {}),
          ...(eligible === null ? {} : { eligible }),
        },
        token,
      );
      this.rows.set(page.data);
      this.pagination.set(page.pagination);
      this.status.set('ready');
    } catch (failure) {
      this.status.set('error');
      this.error.set(describeAdminError(failure));
      this.rows.set([]);
      this.pagination.set(null);
    }
  }
}
