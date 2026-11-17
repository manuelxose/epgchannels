/**
 * Channel detail drawer (right panel).
 *
 * Order follows the operator's job: identity first (basic operation), then the
 * sources with their real eligibility, and only behind a disclosure the technical
 * controls (priority, withdraw), each of which calls its real route.
 */
import { ChangeDetectionStrategy, Component, ElementRef, effect, inject, input, output, signal, viewChild } from '@angular/core';
import type { AdminChannelDetail, ChannelCategory, EditorialStatus } from '@tdt/contracts';
import { AdminCatalogueStore } from '../../../core/admin/admin-catalogue.store';
import { IconComponent } from '../../../shared/ui/icon.component';

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

const EDITORIAL_LABEL: Readonly<Record<EditorialStatus, string>> = {
  draft: 'Borrador',
  review: 'En revisión',
  published: 'Publicado',
  withdrawn: 'Retirado',
};

@Component({
  selector: 'app-admin-channel-drawer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  template: `
    <div class="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title" (keydown)="onKeydown($event)">
      <button type="button" class="drawer__scrim" tabindex="-1" aria-label="Cerrar el detalle" (click)="closed.emit()"></button>

      <div class="drawer__panel" #panel>
        @if (store.detailStatus() === 'loading') {
          <p class="admin-note" role="status">Cargando el canal…</p>
        } @else if (store.detailStatus() === 'error') {
          <p class="admin-alert" role="alert">
            <app-icon name="alert" [size]="18" />
            {{ store.detailError() }}
          </p>
          <div class="drawer__actions">
            <button type="button" class="btn btn--ghost" (click)="store.open(channelId())">Reintentar</button>
            <button type="button" class="btn btn--ghost" (click)="closed.emit()">Cerrar</button>
          </div>
        } @else if (store.detail(); as channel) {
          <header class="drawer__head">
            <div>
              <h2 class="drawer__title" id="drawer-title" tabindex="-1">{{ channel.name }}</h2>
              <p class="drawer__sub">{{ channel.slug }} · {{ editorialLabel(channel.editorialStatus) }}</p>
            </div>
            <button type="button" class="btn btn--ghost btn--icon" aria-label="Cerrar el detalle" (click)="closed.emit()">
              <app-icon name="close" [size]="18" />
            </button>
          </header>

          @if (store.lastActionError(); as message) {
            <p class="admin-alert" role="alert">
              <app-icon name="alert" [size]="18" />
              {{ message }}
            </p>
          }
          @if (store.lastAction(); as message) {
            <p class="admin-ok" role="status">
              <app-icon name="info" [size]="18" />
              {{ message }}
            </p>
          }

          <section class="drawer__section" aria-labelledby="identity-title">
            <h3 id="identity-title">Identidad editorial</h3>
            <form class="drawer__grid" (submit)="save($event)">
              <label class="field">
                <span class="field__label">Nombre</span>
                <input name="name" required maxlength="160" [value]="name()" (input)="name.set(value($event))" />
              </label>
              <label class="field">
                <span class="field__label">Nombre corto</span>
                <input name="shortName" required maxlength="40" [value]="shortName()" (input)="shortName.set(value($event))" />
              </label>
              <label class="field">
                <span class="field__label">País</span>
                <input name="country" required minlength="2" maxlength="3" [value]="country()" (input)="country.set(value($event).toUpperCase())" />
              </label>
              <label class="field">
                <span class="field__label">Idioma</span>
                <input name="language" required maxlength="20" [value]="language()" (input)="language.set(value($event))" />
              </label>
              <label class="field">
                <span class="field__label">Categoría</span>
                <select name="category" (change)="setCategory(value($event))">
                  @for (option of categories; track option) {
                    <option [value]="option" [selected]="option === category()">{{ option }}</option>
                  }
                </select>
              </label>
              <label class="field">
                <span class="field__label">Región</span>
                <input name="regionCode" maxlength="16" placeholder="Sin región" [value]="regionCode() ?? ''" (input)="regionCode.set(value($event) || null)" />
              </label>
              <label class="field" style="grid-column: 1 / -1">
                <span class="field__label">Motivo del cambio (queda en la auditoría)</span>
                <input name="reason" required minlength="3" maxlength="400" [value]="reason()" (input)="reason.set(value($event))" />
              </label>
              <div class="drawer__actions" style="grid-column: 1 / -1">
                <button type="submit" class="btn btn--primary" [disabled]="!dirty()">Guardar identidad</button>
                <button type="button" class="btn btn--ghost" [disabled]="!dirty()" (click)="reset(channel)">Descartar</button>
              </div>
            </form>
          </section>

          <section class="drawer__section" aria-labelledby="sources-title">
            <h3 id="sources-title">Fuentes ({{ channel.sources.length }})</h3>
            @if (channel.sources.length === 0) {
              <p class="admin-note">Este canal no tiene fuentes registradas.</p>
            } @else {
              <div class="table-wrap">
                <table class="admin-table">
                  <caption class="visually-hidden">Fuentes del canal con su elegibilidad</caption>
                  <thead>
                    <tr>
                      <th scope="col">Proveedor</th>
                      <th scope="col">Permiso</th>
                      <th scope="col">Técnica</th>
                      <th scope="col">Elegible</th>
                      <th scope="col"><span class="visually-hidden">Acciones</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (source of channel.sources; track source.id) {
                      <tr>
                        <th scope="row">
                          <span class="cell-strong">{{ source.provider }}</span>
                          <span class="cell-sub">{{ source.type }} · prio {{ source.priority }}</span>
                        </th>
                        <td>{{ source.permission }}</td>
                        <td>
                          <span class="status-pill" [attr.data-status]="pill(source.technicalStatus)">
                            {{ source.technicalStatus }}
                          </span>
                        </td>
                        <td>
                          {{ source.eligible ? 'Sí' : 'No' }}
                          @if (source.eligibilityReason) {
                            <span class="cell-sub">{{ source.eligibilityReason }}</span>
                          }
                        </td>
                        <td class="cell-actions">
                          <button
                            type="button"
                            class="btn btn--ghost"
                            [attr.aria-label]="'Verificar ' + source.provider"
                            (click)="store.verifySource(source.id)"
                          >
                            Verificar
                          </button>
                          <button
                            type="button"
                            class="btn btn--ghost"
                            [attr.aria-label]="'Historial de ' + source.provider"
                            (click)="store.loadHistory(source.id)"
                          >
                            Historial
                          </button>
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>

              @if (store.historyError(); as message) {
                <p class="admin-alert" role="alert">
                  <app-icon name="alert" [size]="18" />
                  {{ message }}
                </p>
              }
              @if (store.sourceHistory(); as history) {
                <pre class="admin-note history">{{ history }}</pre>
              }
            }

            @if (channel.duplicates.length > 0) {
              <p class="admin-note">
                Duplicados propuestos:
                {{ channel.duplicates.length }} canales ({{ channel.duplicates[0].name }}, …).
              </p>
            }

            <details>
              <summary>
                <app-icon name="settings" [size]="16" />
                Configuración técnica avanzada
              </summary>

              <form class="drawer__grid" (submit)="changePriority($event)">
                <label class="field">
                  <span class="field__label">Fuente</span>
                  <select name="sourceId" (change)="sourceId.set(value($event))">
                    @for (source of channel.sources; track source.id) {
                      <option [value]="source.id" [selected]="source.id === sourceId()">
                        {{ source.provider }} · {{ source.type }}
                      </option>
                    }
                  </select>
                </label>
                <label class="field">
                  <span class="field__label">Prioridad (0–1000, menor primero)</span>
                  <input name="priority" type="number" min="0" max="1000" [value]="priority()" (input)="priority.set(+value($event))" />
                </label>
                <label class="field">
                  <span class="field__label">Motivo</span>
                  <input name="priorityReason" minlength="3" maxlength="400" [value]="priorityReason()" (input)="priorityReason.set(value($event))" />
                </label>
                <div class="drawer__actions" style="grid-column: 1 / -1">
                  <button type="submit" class="btn btn--ghost" [disabled]="!sourceId()">Guardar prioridad</button>
                </div>
              </form>

              <form class="drawer__grid" (submit)="withdraw($event)">
                <label class="field">
                  <span class="field__label">Fuente</span>
                  <select name="withdrawId" (change)="withdrawId.set(value($event))">
                    @for (source of channel.sources; track source.id) {
                      <option [value]="source.id" [selected]="source.id === withdrawId()">
                        {{ source.provider }} · {{ source.type }}
                      </option>
                    }
                  </select>
                </label>
                <label class="field">
                  <span class="field__label">Motivo de la retirada</span>
                  <input name="withdrawReason" minlength="3" maxlength="400" [value]="withdrawReason()" (input)="withdrawReason.set(value($event))" />
                </label>
                <div class="drawer__actions" style="grid-column: 1 / -1">
                  <button type="submit" class="btn btn--ghost" [disabled]="!withdrawId()">Retirar fuente</button>
                </div>
              </form>
            </details>
          </section>
        }
      </div>
    </div>
  `,
  styleUrl: '../admin-shared.css',
})
export class AdminChannelDrawerComponent {
  protected readonly store = inject(AdminCatalogueStore);
  private readonly panel = viewChild<ElementRef<HTMLElement>>('panel');

  readonly channelId = input.required<string>();
  readonly closed = output<void>();

  protected readonly categories = CATEGORIES;
  protected readonly name = signal('');
  protected readonly shortName = signal('');
  protected readonly country = signal('');
  protected readonly language = signal('');
  protected readonly category = signal<ChannelCategory>('generalista');
  protected readonly regionCode = signal<string | null>(null);
  protected readonly reason = signal('');
  protected readonly sourceId = signal('');
  protected readonly priority = signal(0);
  protected readonly priorityReason = signal('Cambio de prioridad editorial');
  protected readonly withdrawId = signal('');
  protected readonly withdrawReason = signal('');

  constructor() {
    // Refill the form from each fresh detail (open, or after a successful save).
    effect(() => {
      const channel = this.store.detail();
      if (!channel) return;
      this.reset(channel);
      const first = channel.sources[0];
      this.sourceId.update((current) => current || (first?.id ?? ''));
      this.withdrawId.update((current) => current || (first?.id ?? ''));
    });
    // Move focus into the dialog so Escape and Tab behave for keyboard users.
    effect(() => {
      if (this.store.detailStatus() !== 'ready') return;
      queueMicrotask(() => this.panel()?.nativeElement.querySelector<HTMLElement>('#drawer-title')?.focus());
    });
  }

  protected value(event: Event): string {
    return (event.target as HTMLInputElement | HTMLSelectElement).value;
  }

  protected setCategory(value: string): void {
    this.category.set(value as ChannelCategory);
  }

  protected editorialLabel(status: EditorialStatus): string {
    return EDITORIAL_LABEL[status] ?? status;
  }

  protected pill(status: string): string {
    if (status === 'ok') return 'ok';
    if (status === 'unknown') return 'unknown';
    return 'error';
  }

  protected dirty(): boolean {
    const channel = this.store.detail();
    if (!channel) return false;
    return (
      this.name() !== channel.name ||
      this.shortName() !== channel.shortName ||
      this.country() !== channel.country ||
      this.language() !== channel.language ||
      this.category() !== channel.category ||
      this.regionCode() !== channel.regionCode
    );
  }

  protected reset(channel: AdminChannelDetail): void {
    this.name.set(channel.name);
    this.shortName.set(channel.shortName);
    this.country.set(channel.country);
    this.language.set(channel.language);
    this.category.set(channel.category);
    this.regionCode.set(channel.regionCode);
  }

  protected async save(event: Event): Promise<void> {
    event.preventDefault();
    const channel = this.store.detail();
    if (!channel) return;
    const saved = await this.store.saveIdentity(channel.id, {
      name: this.name(),
      shortName: this.shortName(),
      country: this.country(),
      language: this.language(),
      category: this.category(),
      regionCode: this.regionCode(),
      reason: this.reason(),
    });
    if (saved) this.reason.set('');
  }

  protected async changePriority(event: Event): Promise<void> {
    event.preventDefault();
    await this.store.setPriority(this.sourceId(), this.priority(), this.priorityReason());
  }

  protected async withdraw(event: Event): Promise<void> {
    event.preventDefault();
    if (await this.store.withdrawSource(this.withdrawId(), this.withdrawReason())) {
      this.withdrawReason.set('');
    }
  }

  /** Escape closes the dialog; Tab stays inside the panel. */
  protected onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.closed.emit();
      return;
    }
    if (event.key !== 'Tab') return;
    const panel = this.panel()?.nativeElement;
    if (!panel) return;
    const focusable = Array.from(
      panel.querySelectorAll<HTMLElement>('button, input, select, textarea, summary, a[href], [tabindex="0"]'),
    ).filter((element) => !element.hasAttribute('disabled') && element.tabIndex !== -1);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
}
