import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { IconComponent } from '../../shared/ui/icon.component';
import { PreferencesStore } from '../../core/state/preferences.store';
import { verifiedStateLabel, type VerifiedStateKind } from '../../core/integrations/verified-state';
import type { Channel, MediaSource } from '../../core/models/catalog.model';

/** Channel identity block: logo, name, category, official links, favourite and source picker. */
@Component({
  selector: 'app-channel-header',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  template: `
    <header class="head">
      <span class="head__logo">
        @if (channel().logoSrc) {
          <img [src]="channel().logoSrc" alt="" width="56" height="56" referrerpolicy="no-referrer" />
        } @else {
          <app-icon name="tv" [size]="26" />
        }
      </span>

      <div class="head__id">
        <p class="head__category">{{ channel().categoryName }} · {{ channel().country }}</p>
        <h1 class="head__name">{{ channel().name }}</h1>
        <span class="info-badge" [class.info-badge--warn]="warn()" data-testid="channel-state-badge">
          {{ availabilityLabel() }}
        </span>
      </div>

      <div class="head__actions">
        @if (channel().webUrl; as web) {
          <a class="btn btn--ghost" [href]="web" target="_blank" rel="noopener noreferrer">
            <app-icon name="external" [size]="15" />
            Sitio oficial
          </a>
        }
        <button
          type="button"
          class="btn btn--ghost btn--icon"
          [attr.aria-pressed]="favorite()"
          [attr.aria-label]="(favorite() ? 'Quitar ' : 'Añadir ') + channel().name + ' de favoritos'"
          (click)="favoriteToggle.emit(channel().id)"
        >
          <app-icon [name]="favorite() ? 'heart-filled' : 'heart'" [size]="18" />
        </button>

        @if (sources().length > 1) {
          <label class="head__source">
            <span class="visually-hidden">Emisión</span>
            <select aria-label="Emisión" [value]="selectedSourceIndex()" (change)="onSourceChange($event)">
              @for (source of sources(); track source.id; let index = $index) {
                <option [value]="index">{{ source.label }}</option>
              }
            </select>
            <app-icon name="chevron-down" [size]="15" />
          </label>
        }
      </div>
    </header>
  `,
  styles: `
    .head {
      display: flex;
      align-items: center;
      gap: var(--s-4);
      padding: var(--s-4);
      border-radius: var(--r-lg);
      border: 1px solid var(--border);
      background: var(--surface-1);
    }

    .head__logo {
      display: grid;
      place-items: center;
      width: 56px;
      height: 56px;
      flex-shrink: 0;
      border-radius: var(--r-md);
      overflow: hidden;
      background: var(--surface-3);
      color: var(--text-muted);
    }

    .head__logo img {
      width: 100%;
      height: 100%;
      object-fit: contain;
      background: #fff;
      padding: 4px;
    }

    .head__id {
      min-width: 0;
      flex: 1;
    }

    .head__category {
      color: var(--text-muted);
      font-size: var(--fs-xs);
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }

    .head__name {
      font-size: clamp(var(--fs-lg), 1.6vw, var(--fs-2xl));
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .head__actions {
      display: flex;
      align-items: center;
      gap: var(--s-2);
      flex-wrap: wrap;
      justify-content: flex-end;
    }

    .info-badge--warn {
      background: rgba(251, 191, 36, 0.16);
      color: var(--accent);
    }

    .head__source {
      position: relative;
      display: flex;
      align-items: center;
    }

    .head__source select {
      height: 40px;
      padding: 0 var(--s-7) 0 var(--s-3);
      border-radius: var(--r-pill);
      border: 1px solid var(--border);
      background: var(--surface-2);
      color: var(--text);
      font-size: var(--fs-sm);
      font-weight: 600;
      appearance: none;
      cursor: pointer;
    }

    .head__source app-icon {
      position: absolute;
      right: var(--s-3);
      pointer-events: none;
      color: var(--text-subtle);
    }

    @media (width <= 720px) {
      .head {
        flex-wrap: wrap;
        gap: var(--s-3);
      }

      .head__actions {
        width: 100%;
        justify-content: flex-start;
      }
    }
  `,
})
export class ChannelHeaderComponent {
  readonly channel = input.required<Channel>();
  readonly sources = input<readonly MediaSource[]>([]);
  readonly selectedSourceIndex = input(0);
  /** Verified state of the channel (spec §9); the badge must not invent one. */
  readonly stateKind = input<VerifiedStateKind>('unavailable');
  readonly favoriteToggle = output<string>();
  readonly sourceChange = output<number>();

  private readonly preferences = inject(PreferencesStore);

  protected readonly favorite = computed(() => this.preferences.favorites().has(this.channel().id));
  protected readonly availabilityLabel = computed(() => verifiedStateLabel(this.stateKind()));
  protected readonly warn = computed(() => this.stateKind() !== 'live');

  protected onSourceChange(event: Event): void {
    this.sourceChange.emit(Number((event.target as HTMLSelectElement).value));
  }
}
