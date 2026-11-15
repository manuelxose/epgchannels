import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { IconComponent } from '../../shared/ui/icon.component';
import { formatTimeRange } from '../../core/epg/now-next';
import type { EpgProgram } from '../../core/models/catalog.model';

/** Current / next / after programme panel with a progress bar for the live show. */
@Component({
  selector: 'app-programme-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  template: `
    <section class="panel" aria-labelledby="programme-heading">
      <div class="panel__head">
        <h2 id="programme-heading" class="panel__title">
          <span class="live-dot" aria-hidden="true"></span>
          Ahora
        </h2>
        <button type="button" class="btn btn--primary" (click)="openSchedule.emit()">
          <app-icon name="clock" [size]="16" />
          Toda la programación
        </button>
      </div>

      @if (now(); as current) {
        <article class="current">
          @if (current.coverUrl) {
            <img class="current__cover" [src]="current.coverUrl" alt="" width="96" height="96" loading="lazy" />
          }
          <div class="current__body">
            <p class="current__meta">
              @if (current.genre) {
                <span class="genre">{{ current.genre }}</span>
              }
              <span class="tabular">{{ range(current) }}</span>
            </p>
            <h3 class="current__title">{{ current.title }}</h3>
            <div
              class="progress"
              role="progressbar"
              aria-valuemin="0"
              aria-valuemax="100"
              [attr.aria-valuenow]="progressPercent()"
              aria-label="Progreso del programa actual"
            >
              <span [style.width.%]="progressPercent()"></span>
            </div>
            @if (current.description) {
              <p class="current__desc">{{ current.description }}</p>
            }
          </div>
        </article>

        <div class="upcoming">
          @if (next(); as upcoming) {
            <article class="upnext">
              <p class="upnext__label">Siguiente</p>
              <h4 class="upnext__title">{{ upcoming.title }}</h4>
              <p class="upnext__time tabular">{{ range(upcoming) }}</p>
            </article>
          }
          @if (after(); as later) {
            <article class="upnext">
              <p class="upnext__label">Después</p>
              <h4 class="upnext__title">{{ later.title }}</h4>
              <p class="upnext__time tabular">{{ range(later) }}</p>
            </article>
          }
        </div>
      } @else {
        <p class="panel__empty">
          Programación no disponible para este canal.
          @if (loading()) {
            <span class="panel__loading">Cargando guía…</span>
          }
        </p>
      }
    </section>
  `,
  styles: `
    .panel {
      display: flex;
      flex-direction: column;
      gap: var(--s-3);
      padding: var(--s-4);
      border-radius: var(--r-lg);
      border: 1px solid var(--border);
      background: var(--surface-1);
    }

    .panel__head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--s-3);
      flex-wrap: wrap;
    }

    .panel__title {
      display: inline-flex;
      align-items: center;
      gap: var(--s-2);
      font-size: var(--fs-sm);
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--text-muted);
    }

    .current {
      display: flex;
      gap: var(--s-4);
      align-items: flex-start;
    }

    .current__cover {
      width: 96px;
      height: 96px;
      flex-shrink: 0;
      border-radius: var(--r-md);
      object-fit: cover;
      background: var(--surface-3);
    }

    .current__meta {
      display: flex;
      align-items: center;
      gap: var(--s-2);
      color: var(--text-muted);
      font-size: var(--fs-sm);
    }

    .genre {
      padding: 1px 8px;
      border-radius: var(--r-pill);
      background: var(--surface-3);
      font-size: var(--fs-xs);
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }

    .current__title {
      margin-top: var(--s-1);
      font-size: var(--fs-lg);
    }

    .current__desc {
      margin-top: var(--s-2);
      max-width: 72ch;
      color: var(--text-muted);
      font-size: var(--fs-sm);
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    .progress {
      margin-top: var(--s-2);
      height: 4px;
      border-radius: 2px;
      background: var(--surface-3);
      overflow: hidden;
    }

    .progress span {
      display: block;
      height: 100%;
      background: var(--accent);
    }

    .upcoming {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: var(--s-3);
      border-top: 1px solid var(--border);
      padding-top: var(--s-3);
    }

    .upnext__label {
      font-size: var(--fs-xs);
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--text-subtle);
    }

    .upnext__title {
      font-size: var(--fs-base);
      font-weight: 600;
    }

    .upnext__time {
      color: var(--text-muted);
      font-size: var(--fs-sm);
    }

    .panel__empty {
      color: var(--text-muted);
      font-size: var(--fs-sm);
      padding: var(--s-4) 0;
    }

    .panel__loading {
      display: block;
      color: var(--text-subtle);
      font-size: var(--fs-xs);
      margin-top: var(--s-1);
    }

    @media (width <= 720px) {
      .current {
        gap: var(--s-3);
      }

      .current__cover {
        width: 72px;
        height: 72px;
      }
    }
  `,
})
export class ProgrammePanelComponent {
  readonly now = input<EpgProgram | undefined>(undefined);
  readonly next = input<EpgProgram | undefined>(undefined);
  readonly after = input<EpgProgram | undefined>(undefined);
  readonly progress = input(0);
  readonly loading = input(false);
  readonly locale = input('es-ES');
  readonly openSchedule = output<void>();

  protected readonly progressPercent = computed(() => Math.round(Math.min(1, Math.max(0, this.progress())) * 100));

  protected range(program: EpgProgram): string {
    return formatTimeRange(program.start, program.end, this.locale());
  }
}
