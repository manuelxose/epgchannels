import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { EmptyStateComponent } from '../../shared/ui/empty-state.component';
import { IconComponent } from '../../shared/ui/icon.component';
import { CatalogStore } from '../../core/state/catalog.store';
import { resolveNowNext } from '../../core/epg/now-next';
import type { Channel } from '../../core/models/catalog.model';

interface ScheduleRow {
  readonly channel: Channel;
  readonly nowTitle: string;
  readonly nextTitle: string;
  readonly timeLabel: string;
  readonly progress: number;
}

/** Cross-channel guide: what is on now for every channel that publishes an EPG. */
@Component({
  selector: 'app-schedule-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, EmptyStateComponent, IconComponent],
  template: `
    <section class="schedule">
      <header class="schedule__head">
        <h1>Parrilla de programación</h1>
        <p class="schedule__sub">
          Qué se está emitiendo ahora mismo en los canales que publican guía.
          <span class="tabular">{{ nowLabel() }}</span>
        </p>
        <label class="schedule__filter">
          <app-icon name="search" [size]="16" />
          <span class="visually-hidden">Buscar canal en la parrilla</span>
          <input type="search" aria-label="Buscar canal en la parrilla" placeholder="Buscar canal…" [value]="filter()" (input)="onFilter($event)" />
        </label>
      </header>

      @if (rows().length > 0) {
        <ul class="schedule__list">
          @for (row of rows(); track row.channel.id) {
            <li>
              <a class="row" [routerLink]="['/television', row.channel.id]">
                <span class="row__channel">{{ row.channel.name }}</span>
                <span class="row__category">{{ row.channel.categoryName }}</span>
                <span class="row__now">
                  {{ row.nowTitle }}
                  <span class="row__time tabular">{{ row.timeLabel }}</span>
                </span>
                <span class="row__next">
                  <span class="row__next-label">Siguiente</span>
                  {{ row.nextTitle }}
                </span>
                <span class="row__bar" aria-hidden="true"><span [style.width.%]="row.progress * 100"></span></span>
              </a>
            </li>
          }
        </ul>
      } @else if (catalog.epgStatus() === 'loading' || catalog.status() === 'loading') {
        <p class="schedule__loading" role="status">Cargando guía de programación…</p>
      } @else {
        <app-empty-state
          icon="clock"
          title="Todavía no hay programación que mostrar"
          message="La guía se rellena en cuanto se cargan los datos del catálogo y del EPG."
        />
      }
    </section>
  `,
  styles: `
    .schedule {
      display: flex;
      flex-direction: column;
      gap: var(--s-4);
      max-width: 1100px;
      margin: 0 auto;
    }

    .schedule__head {
      display: flex;
      flex-direction: column;
      gap: var(--s-2);
    }

    .schedule__sub {
      color: var(--text-muted);
      font-size: var(--fs-sm);
    }

    .schedule__filter {
      display: flex;
      align-items: center;
      gap: var(--s-2);
      max-width: 340px;
      height: 44px;
      padding: 0 var(--s-3);
      border-radius: var(--r-md);
      border: 1px solid var(--border);
      background: var(--surface-2);
      color: var(--text-subtle);
    }

    .schedule__filter input {
      flex: 1;
      min-width: 0;
      border: 0;
      background: transparent;
      color: var(--text);
      font-size: var(--fs-base);
      outline: none;
    }

    .schedule__list {
      margin: 0;
      padding: 0;
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: var(--s-2);
    }

    .row {
      display: grid;
      grid-template-columns: minmax(120px, 200px) minmax(0, 1.2fr) minmax(0, 1fr);
      grid-template-areas:
        'channel now next'
        'bar bar bar';
      align-items: center;
      gap: var(--s-1) var(--s-3);
      padding: var(--s-3) var(--s-4);
      border-radius: var(--r-md);
      border: 1px solid var(--border);
      background: var(--surface-1);
      transition:
        border-color var(--dur-fast) var(--ease-out),
        background var(--dur-fast) var(--ease-out);
    }

    .row:hover {
      background: var(--surface-2);
      border-color: var(--border-strong);
    }

    .row__channel {
      grid-area: channel;
      font-weight: 650;
    }

    .row__category {
      display: none;
    }

    .row__now {
      grid-area: now;
      display: flex;
      flex-direction: column;
      font-size: var(--fs-sm);
    }

    .row__time {
      color: var(--text-muted);
      font-size: var(--fs-xs);
    }

    .row__next {
      grid-area: next;
      font-size: var(--fs-sm);
      color: var(--text-muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .row__next-label {
      display: block;
      font-size: var(--fs-xs);
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--text-subtle);
    }

    .row__bar {
      grid-area: bar;
      height: 3px;
      border-radius: 2px;
      background: var(--surface-3);
      overflow: hidden;
    }

    .row__bar span {
      display: block;
      height: 100%;
      background: var(--accent);
    }

    .schedule__loading {
      color: var(--text-muted);
    }

    @media (width <= 720px) {
      .row {
        grid-template-columns: minmax(0, 1fr);
        grid-template-areas:
          'channel'
          'now'
          'next'
          'bar';
      }
    }
  `,
})
export class SchedulePageComponent {
  protected readonly catalog = inject(CatalogStore);
  protected readonly now = signal(new Date());
  protected readonly filter = signal('');
  protected readonly nowLabel = computed(() =>
    new Intl.DateTimeFormat('es-ES', { dateStyle: 'full', timeStyle: 'short' }).format(this.now()),
  );

  protected readonly rows = computed<ScheduleRow[]>(() => {
    // Read the reactive inputs explicitly: the clock tick, the guide snapshot and
    // the filter. Depending only on this.now() left the list stale when the EPG
    // arrived after the first render.
    const at = this.now();
    const epg = this.catalog.epg();
    const query = this.filter().trim().toLowerCase();
    if (!epg) {
      return [];
    }
    const rows: ScheduleRow[] = [];
    for (const channel of this.catalog.channels()) {
      const schedule = this.catalog.scheduleFor(channel);
      const { now, next, progress } = resolveNowNext(schedule, at);
      if (!now && !next) {
        continue;
      }
      if (query && !channel.name.toLowerCase().includes(query)) {
        continue;
      }
      const format = new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit' });
      if (now) {
        rows.push({
          channel,
          nowTitle: now.title,
          nextTitle: next?.title ?? '—',
          timeLabel: `${format.format(now.start)} – ${format.format(now.end)}`,
          progress,
        });
      } else if (next) {
        rows.push({
          channel,
          nowTitle: `Sin emisión programada · próximo: ${next.title}`,
          nextTitle: next.title,
          timeLabel: `${format.format(next.start)} – ${format.format(next.end)}`,
          progress: 0,
        });
      }
    }
    return rows;
  });

  constructor() {
    // This page is the one that shows the guide grid, so it is the one that loads
    // it: the catalogue no longer pays 21 per-channel requests for a snapshot only
    // this view renders.
    void this.catalog.ensureCatalog().then(() => this.catalog.ensureEpg());
    setInterval(() => this.now.set(new Date()), 30_000);
  }

  protected onFilter(event: Event): void {
    this.filter.set((event.target as HTMLInputElement).value);
  }
}
