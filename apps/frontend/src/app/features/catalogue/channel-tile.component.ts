import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { IconComponent } from '../../shared/ui/icon.component';
import { canEmbed } from '../../core/models/catalog.model';
import type { Channel, MediaSource } from '../../core/models/catalog.model';

/**
 * One catalogue entry: logo well, name, availability hint and favourite toggle.
 * The whole tile is a real link so it supports open-in-new-tab and history.
 */
@Component({
  selector: 'app-channel-tile',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent],
  template: `
    <div class="tile" [class.tile--active]="active()">
      <a
        class="tile__link"
        [routerLink]="['/television', channel().id]"
        [attr.aria-current]="active() ? 'page' : null"
        [attr.aria-label]="channel().name + availabilitySuffix()"
      >
        <span class="tile__logo" [style.--logo-hue]="logoHue()">
          @if (channel().logoSrc && !logoFailed()) {
            <img
              [src]="channel().logoSrc"
              [alt]="''"
              loading="lazy"
              decoding="async"
              referrerpolicy="no-referrer"
              width="48"
              height="48"
              (error)="logoFailed.set(true)"
            />
          } @else {
            <span class="tile__initials" aria-hidden="true">{{ initials() }}</span>
          }
        </span>
        <span class="tile__name" [attr.title]="channel().name">{{ channel().name }}</span>
      </a>
      <button
        type="button"
        class="tile__fav"
        [class.is-on]="favorite()"
        [attr.aria-pressed]="favorite()"
        [attr.aria-label]="(favorite() ? 'Quitar ' : 'Añadir ') + channel().name + ' de favoritos'"
        (click)="favoriteToggle.emit(channel().id)"
      >
        <app-icon [name]="favorite() ? 'heart-filled' : 'heart'" [size]="15" />
      </button>
      @if (channel().availability === 'no-emission') {
        <span class="tile__flag" title="Sin emisión continua por internet">off</span>
      } @else if (hasYoutubePage()) {
        <span class="tile__flag tile__flag--embed" title="Se ve en el reproductor oficial de YouTube">yt</span>
      } @else if (channel().availability === 'external') {
        <span class="tile__flag" title="Se ve en la web del emisor">web</span>
      }
    </div>
  `,
  styles: `
    :host {
      display: block;
      min-width: 0;
    }

    .tile {
      position: relative;
      border-radius: var(--r-md);
      border: 1px solid var(--border);
      background: var(--surface-1);
      transition:
        border-color var(--dur-fast) var(--ease-out),
        background var(--dur-fast) var(--ease-out),
        transform var(--dur-fast) var(--ease-out);
    }

    .tile:hover {
      background: var(--surface-2);
      border-color: var(--border-strong);
      transform: translateY(-1px);
    }

    .tile--active {
      border-color: var(--signal);
      background: var(--signal-soft);
      box-shadow: inset 0 0 0 1px var(--signal);
    }

    .tile__link {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: var(--s-2);
      padding: var(--s-3) var(--s-2) var(--s-2);
      border-radius: var(--r-md);
      min-height: 92px;
    }

    .tile__link:focus-visible {
      box-shadow: var(--focus-ring);
    }

    .tile__logo {
      display: grid;
      place-items: center;
      width: 48px;
      height: 48px;
      border-radius: 12px;
      overflow: hidden;
      background: hsl(var(--logo-hue, 230) 24% 22%);
      color: #f8fafc;
      font-size: var(--fs-sm);
      font-weight: 700;
      letter-spacing: 0.02em;
    }

    .tile__logo img {
      width: 100%;
      height: 100%;
      object-fit: contain;
      background: #fff;
      padding: 4px;
    }

    .tile__name {
      width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      text-align: center;
      font-size: var(--fs-xs);
      font-weight: 600;
      color: var(--text);
    }

    .tile__fav {
      position: absolute;
      top: 2px;
      right: 2px;
      display: grid;
      place-items: center;
      width: 26px;
      height: 26px;
      padding: 0;
      border: 0;
      border-radius: 50%;
      background: transparent;
      color: var(--text-subtle);
      opacity: 0;
      cursor: pointer;
      transition:
        opacity var(--dur-fast) var(--ease-out),
        color var(--dur-fast) var(--ease-out);
    }

    .tile:hover .tile__fav,
    .tile__fav:focus-visible,
    .tile__fav.is-on {
      opacity: 1;
    }

    .tile__fav.is-on {
      color: var(--live);
    }

    .tile__flag {
      position: absolute;
      top: 4px;
      left: 4px;
      padding: 1px 5px;
      border-radius: var(--r-sm);
      background: var(--surface-3);
      color: var(--text-subtle);
      font-size: 0.625rem;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }

    @media (hover: none) {
      .tile__fav {
        opacity: 1;
      }
    }
  `,
})
export class ChannelTileComponent {
  readonly channel = input.required<Channel>();
  readonly active = input(false);
  readonly favorite = input(false);
  readonly favoriteToggle = output<string>();

  protected readonly logoFailed = signal(false);

  /** The published YouTube page can be embedded, so the tile may say so. */
  protected readonly hasYoutubePage = computed(() => this.channel().sources.some((source: MediaSource) => canEmbed(source)));

  protected readonly initials = computed(() => {
    const name = this.channel().name.trim();
    const words = name.split(/\s+/).filter(Boolean);
    if (words.length >= 2) {
      return (words[0][0] + words[1][0]).toUpperCase();
    }
    return name.slice(0, 3).toUpperCase();
  });

  /** Deterministic hue so logos-without-image tiles stay recognisable. */
  protected readonly logoHue = computed(() => {
    let hash = 0;
    for (const char of this.channel().id) {
      hash = (hash * 31 + char.charCodeAt(0)) % 360;
    }
    return hash;
  });

  protected readonly availabilitySuffix = computed(() => {
    const channel = this.channel();
    switch (channel.availability) {
      case 'external':
        return this.hasYoutubePage() ? ' (se ve en el reproductor oficial de YouTube)' : ' (se ve en la web del emisor)';
      case 'no-emission':
        return ' (sin emisión continua por internet)';
      case 'unavailable':
        return ' (no disponible actualmente)';
      default:
        return '';
    }
  });
}
