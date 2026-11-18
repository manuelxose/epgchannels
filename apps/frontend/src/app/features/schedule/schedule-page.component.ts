import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { EmptyStateComponent } from '../../shared/ui/empty-state.component';
import { IconComponent } from '../../shared/ui/icon.component';
import { EpgApiService } from '../../core/api/epg-api.service';

interface FeedChannel {
  id: string;
  slug: string;
  name: string;
  country?: string | null;
}

interface FeedProgramme {
  title: string;
  genre: string | null;
  start: string;
  end: string;
}

interface FeedEntry {
  channel: FeedChannel;
  programme: FeedProgramme | null;
}

interface ScheduleRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly country: string;
  readonly nowTitle: string;
  readonly nextTitle: string;
  readonly genre: string | null;
  readonly timeLabel: string;
  readonly progress: number;
}

interface CountryGroup {
  readonly code: string;
  readonly label: string;
  readonly rows: ScheduleRow[];
}

const COUNTRY_LABELS = new Intl.DisplayNames(['es'], { type: 'region' });

function countryLabel(code: string | null | undefined): string {
  if (!code) return 'Sin país';
  if (code === 'INT') return 'Internacional';
  try {
    return COUNTRY_LABELS.of(code) ?? code;
  } catch {
    return code;
  }
}

/** España primero, luego internacional, luego por volumen de canales. */
const PRIORITY: Record<string, number> = { ES: 0, INT: 1 };

const PAGE_SIZE = 100;
/** Páginas que se cargan sin intervención del usuario al abrir la vista. */
const AUTO_PAGES = 5;

/**
 * Cross-channel guide, grouped by country — the same shape the guide sources
 * publish (one XMLTV file per country).
 *
 * Reads the paged `/epg/now` + `/epg/next` feeds instead of one schedule request
 * per channel: the catalogue snapshot only carries the first page of channels,
 * which is why the previous grid could never show more than a handful of rows.
 */
@Component({
  selector: 'app-schedule-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, EmptyStateComponent, IconComponent],
  template: `
    <section class="schedule">
      <header class="schedule__head">
        <h1>Parrilla de programación</h1>
        <p class="schedule__sub">
          Qué se está emitiendo ahora mismo, agrupado por país.
          <span class="tabular">{{ nowLabel() }}</span>
        </p>

        <div class="schedule__controls">
          <label class="schedule__filter">
            <app-icon name="search" [size]="16" />
            <span class="visually-hidden">Buscar canal en la parrilla</span>
            <input
              type="search"
              aria-label="Buscar canal en la parrilla"
              placeholder="Buscar canal…"
              [value]="filter()"
              (input)="onFilter($event)"
            />
          </label>

          <label class="schedule__country">
            <span class="visually-hidden">Filtrar por país</span>
            <select [value]="countryFilter()" (change)="onCountry($event)">
              <option value="">Todos los países</option>
              @for (entry of countryOptions(); track entry.code) {
                <option [value]="entry.code">{{ entry.label }} ({{ entry.count }})</option>
              }
            </select>
          </label>
        </div>
      </header>

      @if (groups().length > 0) {
        @for (group of groups(); track group.code) {
          <section class="group">
            <h2 class="group__title">
              {{ group.label }}
              <span class="group__count">{{ group.rows.length }}</span>
            </h2>
            <ul class="schedule__list">
              @for (row of group.rows; track row.id) {
                <li>
                  <a class="row" [routerLink]="['/television', row.slug]">
                    <span class="row__channel">{{ row.name }}</span>
                    <span class="row__now">
                      {{ row.nowTitle }}
                      <span class="row__time tabular">{{ row.timeLabel }}</span>
                    </span>
                    <span class="row__next">
                      <span class="row__next-label">Siguiente</span>
                      {{ row.nextTitle }}
                    </span>
                    @if (row.genre) {
                      <span class="row__genre">{{ row.genre }}</span>
                    }
                    <span class="row__bar" aria-hidden="true"><span [style.width.%]="row.progress * 100"></span></span>
                  </a>
                </li>
              }
            </ul>
          </section>
        }

        @if (hasMore()) {
          <button class="schedule__more" type="button" (click)="loadMore()" [disabled]="loading()">
            {{ loading() ? 'Cargando…' : 'Cargar más canales' }}
          </button>
        }
      } @else if (loading()) {
        <p class="schedule__loading" role="status">Cargando guía de programación…</p>
      } @else {
        <app-empty-state
          icon="clock"
          title="Todavía no hay programación que mostrar"
          message="Ningún canal tiene emisiones en este momento."
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

    .schedule__controls {
      display: flex;
      flex-wrap: wrap;
      gap: var(--s-3);
    }

    .schedule__filter,
    .schedule__country select {
      display: flex;
      align-items: center;
      gap: var(--s-2);
      height: 44px;
      padding: 0 var(--s-3);
      border-radius: var(--r-md);
      border: 1px solid var(--border);
      background: var(--surface-2);
      color: var(--text);
      font-size: var(--fs-base);
    }

    .schedule__filter {
      flex: 1;
      min-width: 220px;
      max-width: 340px;
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

    .schedule__country select {
      min-width: 220px;
      cursor: pointer;
    }

    .group {
      display: flex;
      flex-direction: column;
      gap: var(--s-2);
    }

    .group__title {
      display: flex;
      align-items: baseline;
      gap: var(--s-2);
      margin: var(--s-3) 0 0;
      font-size: var(--fs-lg);
    }

    .group__count {
      padding: 2px 8px;
      border-radius: var(--r-sm);
      background: var(--surface-3);
      color: var(--text-muted);
      font-size: var(--fs-xs);
      font-weight: 600;
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
      grid-template-columns: minmax(120px, 200px) minmax(0, 1.2fr) minmax(0, 1fr) auto;
      grid-template-areas:
        'channel now next genre'
        'bar bar bar bar';
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

    .row__genre {
      grid-area: genre;
      padding: 2px 8px;
      border-radius: var(--r-sm);
      background: var(--surface-3);
      color: var(--text-muted);
      font-size: var(--fs-xs);
      white-space: nowrap;
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

    .schedule__more {
      align-self: center;
      padding: var(--s-2) var(--s-4);
      border-radius: var(--r-md);
      border: 1px solid var(--border-strong);
      background: var(--surface-2);
      color: var(--text);
      cursor: pointer;
    }

    .schedule__more:disabled {
      opacity: 0.6;
      cursor: default;
    }

    .schedule__loading {
      color: var(--text-muted);
    }

    @media (width <= 720px) {
      .row {
        grid-template-columns: minmax(0, 1fr) auto;
        grid-template-areas:
          'channel genre'
          'now now'
          'next next'
          'bar bar';
      }
    }
  `,
})
export class SchedulePageComponent {
  private readonly epgApi = inject(EpgApiService);

  protected readonly now = signal(new Date());
  protected readonly filter = signal('');
  protected readonly countryFilter = signal('');
  protected readonly loading = signal(false);
  protected readonly hasMore = signal(true);

  /** One row per channel, already joined with its following programme. */
  private readonly rows = signal<ScheduleRow[]>([]);
  private page = 0;
  private readonly format = new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit' });

  protected readonly nowLabel = computed(() =>
    new Intl.DateTimeFormat('es-ES', { dateStyle: 'full', timeStyle: 'short' }).format(this.now()),
  );

  protected readonly groups = computed<CountryGroup[]>(() => {
    const query = this.filter().trim().toLowerCase();
    const onlyCountry = this.countryFilter();
    const byCountry = new Map<string, ScheduleRow[]>();

    for (const row of this.rows()) {
      if (onlyCountry && row.country !== onlyCountry) continue;
      if (query && !row.name.toLowerCase().includes(query)) continue;
      const list = byCountry.get(row.country) ?? [];
      list.push(row);
      byCountry.set(row.country, list);
    }

    return [...byCountry.entries()]
      .map(([code, rows]) => ({
        code,
        label: countryLabel(code),
        rows: [...rows].sort((a, b) => a.name.localeCompare(b.name, 'es')),
      }))
      .sort((a, b) => {
        const priorityA = PRIORITY[a.code] ?? 2;
        const priorityB = PRIORITY[b.code] ?? 2;
        if (priorityA !== priorityB) return priorityA - priorityB;
        if (a.rows.length !== b.rows.length) return b.rows.length - a.rows.length;
        return a.label.localeCompare(b.label, 'es');
      });
  });

  /** Country picker entries: always computed from every loaded row. */
  protected readonly countryOptions = computed(() =>
    [...this.rows().reduce((acc, row) => {
      acc.set(row.country, (acc.get(row.country) ?? 0) + 1);
      return acc;
    }, new Map<string, number>())]
      .sort((a, b) => {
        const priorityA = PRIORITY[a[0]] ?? 2;
        const priorityB = PRIORITY[b[0]] ?? 2;
        if (priorityA !== priorityB) return priorityA - priorityB;
        return b[1] - a[1];
      })
      .map(([code, count]) => ({ code, label: countryLabel(code), count })),
  );

  constructor() {
    // First paint shows several countries at once; the rest is on demand.
    void this.loadMore(AUTO_PAGES);
    setInterval(() => this.now.set(new Date()), 30_000);
  }

  /** Appends the next page(s) of the "on air" feed. */
  protected async loadMore(pages = 1): Promise<void> {
    if (this.loading()) return;
    if (this.page > 0 && !this.hasMore()) return;
    this.loading.set(true);
    try {
      for (let index = 0; index < pages; index += 1) {
        const page = this.page + 1;
        const [nowPage, nextPage] = await Promise.all([
          this.fetchPage('/epg/now', page),
          this.fetchPage('/epg/next', page),
        ]);
        if (nowPage.length === 0) {
          this.hasMore.set(false);
          break;
        }
        const nextBySlug = new Map(nextPage.map((entry) => [entry.channel.slug, entry.programme]));
        const at = this.now();
        // Channels without a programme in the window carry `programme: null`;
        // they are dropped instead of breaking the whole page.
        const rows = nowPage
          .filter((entry) => entry.programme !== null)
          .map((entry) => this.toRow(entry, nextBySlug.get(entry.channel.slug), at));
        this.rows.update((current) => [...current, ...rows]);
        this.page = page;
        if (nowPage.length < PAGE_SIZE) {
          this.hasMore.set(false);
          break;
        }
      }
    } catch {
      this.hasMore.set(false);
    } finally {
      this.loading.set(false);
    }
  }

  private async fetchPage(path: string, page: number): Promise<FeedEntry[]> {
    const response = await fetch(`/api/v1${path}?limit=${PAGE_SIZE}&page=${page}`, {
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return [];
    const payload = (await response.json()) as { data?: FeedEntry[] };
    return payload.data ?? [];
  }

  private toRow(entry: FeedEntry, next: FeedProgramme | null | undefined, at: Date): ScheduleRow {
    const programme = entry.programme as FeedProgramme;
    const start = new Date(programme.start);
    const end = new Date(programme.end);
    const total = end.getTime() - start.getTime();
    const progress = total > 0 ? Math.min(1, Math.max(0, (at.getTime() - start.getTime()) / total)) : 0;
    return {
      id: entry.channel.id,
      slug: entry.channel.slug,
      name: entry.channel.name,
      country: entry.channel.country ?? '',
      nowTitle: programme.title,
      nextTitle: next?.title ?? '—',
      genre: programme.genre,
      timeLabel: `${this.format.format(start)} – ${this.format.format(end)}`,
      progress,
    };
  }

  protected onFilter(event: Event): void {
    this.filter.set((event.target as HTMLInputElement).value);
  }

  protected onCountry(event: Event): void {
    this.countryFilter.set((event.target as HTMLSelectElement).value);
  }
}
