/**
 * Operaciones — real jobs, aggregated errors and metrics.
 *
 * The overview tiles are the API's counts; each tile states where it comes from so
 * nobody reads a number as something it is not. Pause/resume call the real routes:
 * a base that does not serve them answers 404 and the operator sees that message.
 */
import { ChangeDetectionStrategy, Component, effect, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import type { AdminJobRow } from '@tdt/contracts';
import { AdminOperationsStore } from '../../../core/admin/admin-operations.store';
import { EmptyStateComponent } from '../../../shared/ui/empty-state.component';
import { IconComponent } from '../../../shared/ui/icon.component';

@Component({
  selector: 'app-admin-operations',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, EmptyStateComponent, IconComponent],
  template: `
    <section class="operations" aria-labelledby="ops-title">
      <div class="operations__head">
        <h2 id="ops-title">Operaciones</h2>
        <span class="admin-count">
          @if (store.overview(); as overview) {
            Medido a las {{ overview.asOf | date: 'dd/MM HH:mm:ss' }}
          }
        </span>
      </div>

      @if (store.actionError(); as message) {
        <p class="admin-alert" role="alert">
          <app-icon name="alert" [size]="18" />
          {{ message }}
        </p>
      }
      @if (store.actionMessage(); as message) {
        <p class="admin-ok" role="status">
          <app-icon name="info" [size]="18" />
          {{ message }}
        </p>
      }

      @if (store.overviewError(); as message) {
        <p class="admin-alert" role="alert">
          <app-icon name="alert" [size]="18" />
          Resumen no disponible: {{ message }}
        </p>
      } @else if (store.overview(); as overview) {
        <dl class="metrics" aria-label="Resumen operativo">
          <div><dt>Canales</dt><dd class="tabular">{{ overview.catalogue.total }}</dd><small>{{ overview.catalogue.published }} publicados · {{ overview.catalogue.review }} en revisión</small></div>
          <div><dt>Fuentes</dt><dd class="tabular">{{ overview.sources.total }}</dd><small>{{ overview.sources.failing }} con fallos · {{ overview.sources.unverified }} sin verificar</small></div>
          <div><dt>EPG mapeados</dt><dd class="tabular">{{ overview.epg.mappedChannels }}</dd><small>{{ overview.epg.staleChannels }} caducados · {{ overview.epg.failedRuns24h }} fallos 24 h</small></div>
          <div><dt>Trabajos</dt><dd class="tabular">{{ overview.operations.jobs }}</dd><small>{{ overview.operations.failed }} fallidos · {{ overview.operations.paused }} pausados</small></div>
          <div><dt>Países</dt><dd class="tabular">{{ overview.countries.length }}</dd><small>con canales publicados</small></div>
          <div><dt>Idiomas</dt><dd class="tabular">{{ overview.languages.length }}</dd><small>etiquetas canónicas</small></div>
        </dl>
      }

      <section aria-labelledby="jobs-title">
        <h3 id="jobs-title">Trabajos</h3>
        @if (store.jobsStatus() === 'loading') {
          <p class="admin-note" role="status">Cargando trabajos…</p>
        } @else if (store.jobsError(); as message) {
          <p class="admin-alert" role="alert">
            <app-icon name="alert" [size]="18" />
            {{ message }}
          </p>
        } @else if (store.jobs().length === 0) {
          <app-empty-state icon="clock" title="Sin trabajos" message="El backend no devolvió ningún trabajo programado." />
        } @else {
          <div class="table-wrap" tabindex="0" role="region" aria-label="Trabajos programados">
            <table class="admin-table">
              <caption class="visually-hidden">Trabajos con su último estado y fallos seguidos</caption>
              <thead>
                <tr>
                  <th scope="col">Trabajo</th>
                  <th scope="col">Estado</th>
                  <th scope="col">Última ejecución</th>
                  <th scope="col">Fallos seguidos</th>
                  <th scope="col">Último error</th>
                  <th scope="col"><span class="visually-hidden">Control</span></th>
                </tr>
              </thead>
              <tbody>
                @for (job of store.jobs(); track job.name) {
                  <tr>
                    <th scope="row"><span class="cell-strong">{{ job.name }}</span></th>
                    <td>
                      <span class="status-pill" [attr.data-status]="jobPill(job)">
                        {{ job.paused ? 'pausado' : job.lastStatus }}
                      </span>
                    </td>
                    <td class="tabular">
                      {{ job.lastFinishedAt ? (job.lastFinishedAt | date: 'dd/MM HH:mm:ss') : 'nunca' }}
                      @if (job.lastDurationMs !== null) {
                        <span class="cell-sub">{{ job.lastDurationMs }} ms</span>
                      }
                    </td>
                    <td class="tabular">{{ job.consecutiveFailures }}</td>
                    <td>{{ job.lastError ?? '—' }}</td>
                    <td class="cell-actions">
                      <label class="field">
                        <span class="visually-hidden">Motivo para {{ job.name }}</span>
                        <input
                          [value]="reasonFor(job.name)"
                          maxlength="400"
                          placeholder="Motivo (auditoría)"
                          (input)="setReason(job.name, value($event))"
                        />
                      </label>
                      <button
                        type="button"
                        class="btn btn--ghost"
                        [attr.aria-label]="(job.paused ? 'Reanudar ' : 'Pausar ') + job.name"
                        [disabled]="store.busy()"
                        (click)="store.setPaused(job, !job.paused, reasonFor(job.name))"
                      >
                        {{ job.paused ? 'Reanudar' : 'Pausar' }}
                      </button>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      </section>

      <section aria-labelledby="errors-title">
        <h3 id="errors-title">Errores operativos</h3>
        @if (store.errorsError(); as message) {
          <p class="admin-alert" role="alert">
            <app-icon name="alert" [size]="18" />
            {{ message }}
          </p>
        } @else if (store.errors().length === 0) {
          <p class="admin-note">Sin errores agregados en la ventana.</p>
        } @else {
          <ul class="runs">
            @for (error of store.errors(); track error.component + error.code + error.at) {
              <li>
                <span class="cell-strong">{{ error.component }}</span>
                <span class="cell-sub">{{ error.code }} · {{ error.count }}×</span>
                <span class="cell-sub">{{ error.at | date: 'dd/MM HH:mm' }}</span>
              </li>
            }
          </ul>
        }
      </section>

      <section aria-labelledby="metrics-title">
        <h3 id="metrics-title">Métricas</h3>
        @if (store.metricsError(); as message) {
          <p class="admin-alert" role="alert">
            <app-icon name="alert" [size]="18" />
            {{ message }}
          </p>
        } @else if (store.metrics(); as metrics) {
          <dl class="metrics" aria-label="Métricas de peticiones y reproducción">
            <div><dt>Peticiones</dt><dd class="tabular">{{ metrics.http.totalRequests }}</dd><small>{{ metrics.http.errorRequests }} con error</small></div>
            <div><dt>p50</dt><dd class="tabular">{{ metrics.http.p50Ms }} ms</dd></div>
            <div><dt>p95</dt><dd class="tabular">{{ metrics.http.p95Ms }} ms</dd></div>
            <div><dt>Descriptores</dt><dd class="tabular">{{ metrics.playback.descriptorsServed }}</dd><small>servidos</small></div>
            <div><dt>Rechazos</dt><dd class="tabular">{{ metrics.playback.refusedUnauthorised }}</dd><small>sin autorización</small></div>
            <div><dt>Ventana</dt><dd class="tabular">{{ metrics.windowSeconds }} s</dd></div>
          </dl>
        }
      </section>

      <button type="button" class="btn btn--ghost" (click)="store.load()">Actualizar</button>
    </section>
  `,
  styleUrl: '../admin-shared.css',
})
export class AdminOperationsComponent {
  protected readonly store = inject(AdminOperationsStore);
  private readonly reasons = signal<Readonly<Record<string, string>>>({});

  constructor() {
    effect(() => {
      if (this.store.jobsStatus() === 'idle') void this.store.load();
    });
  }

  protected value(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected reasonFor(name: string): string {
    return this.reasons()[name] ?? '';
  }

  protected setReason(name: string, value: string): void {
    this.reasons.update((current) => ({ ...current, [name]: value }));
  }

  protected jobPill(job: AdminJobRow): string {
    if (job.paused) return 'unknown';
    if (job.lastStatus === 'ok') return 'ok';
    if (job.lastStatus === 'failed') return 'error';
    return 'unknown';
  }
}
