import { ChangeDetectionStrategy, Component, effect, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterOutlet } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { map, of } from 'rxjs';
import { CatalogueRailComponent } from '../catalogue/catalogue-rail.component';
import { CatalogStore } from '../../core/state/catalog.store';
import { IconComponent } from '../../shared/ui/icon.component';

/**
 * Layout shell for `/television`: catalogue rail plus the routed watch stage.
 * Loading is initiated here so a deep link straight to a channel also works.
 */
@Component({
  selector: 'app-catalogue-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, CatalogueRailComponent, IconComponent],
  template: `
    <div class="layout">
      <aside class="layout__rail">
        <app-catalogue-rail [activeChannelId]="activeChannelId()" [focusRequest]="focusRequest()" />
      </aside>

      <div class="layout__stage">
        @if (catalog.status() === 'error') {
          <div class="load-error" role="alert">
            <app-icon name="alert" [size]="22" />
            <div>
              <p class="load-error__title">No se ha podido cargar el catálogo.</p>
              <p class="load-error__message">{{ catalog.error() }}</p>
            </div>
            <button type="button" class="btn" (click)="retry()">Reintentar</button>
          </div>
        }

        <router-outlet (activate)="focusRequest.set(focusRequest() + 1)" />

        @if (catalog.usingDemoCatalog()) {
          <p class="demo" role="status">
            <app-icon name="info" [size]="16" />
            Catálogo de demostración: no se ha podido contactar con la fuente pública.
          </p>
        }
      </div>
    </div>
  `,
  styles: `
    :host {
      display: block;
    }

    .layout {
      display: grid;
      grid-template-columns: var(--rail-w) minmax(0, 1fr);
      gap: clamp(var(--s-3), 1.6vw, var(--s-5));
      align-items: start;
    }

    .layout__rail {
      position: sticky;
      top: calc(var(--header-h) + var(--s-3));
      /*
       * max-height alone does not bound the child: as a grid item with
       * align-items:start the aside still sized to its content, the inner rail
       * grew to 2 816px and the pager ended up 2 869px below the fold (the
       * catalogue looked unpaginated). A flex column plus an explicit height
       * gives the scroll area a real ceiling and keeps the pager pinned.
       */
      height: calc(100dvh - var(--header-h) - var(--s-6));
      display: flex;
      flex-direction: column;
      min-height: 0;
      overflow: hidden;
      padding: var(--s-3);
      border-radius: var(--r-lg);
      border: 1px solid var(--border);
      background: var(--surface-1);
      box-shadow: 0 20px 40px -32px rgba(0, 0, 0, 0.8);
    }

    .layout__stage {
      display: flex;
      flex-direction: column;
      gap: var(--s-4);
      min-width: 0;
    }

    .load-error {
      display: flex;
      align-items: center;
      gap: var(--s-3);
      padding: var(--s-4);
      border-radius: var(--r-md);
      border: 1px solid var(--danger);
      background: var(--danger-soft);
      color: var(--text);
    }

    .load-error__title {
      font-weight: 650;
    }

    .load-error__message {
      color: var(--text-muted);
      font-size: var(--fs-sm);
    }

    .load-error .btn {
      margin-left: auto;
    }

    .demo {
      display: inline-flex;
      align-items: center;
      gap: var(--s-2);
      align-self: flex-start;
      padding: var(--s-2) var(--s-3);
      border-radius: var(--r-pill);
      background: var(--surface-2);
      border: 1px solid var(--border);
      color: var(--text-muted);
      font-size: var(--fs-sm);
    }

    @media (max-width: 1023px) {
      .layout {
        grid-template-columns: minmax(0, 1fr);
      }

      /*
       * Keep the rail bounded: with no max-height it grew to the full page of
       * tiles, so the pager sat thousands of pixels below the viewport on a
       * phone — the catalogue looked like it had no pagination at all.
       *
       * On narrow screens the stage (video) sits above the rail, so the rail
       * only has the space the viewport leaves under it. Any taller and the
       * pager lands off-screen again.
       */
      .layout__rail {
        position: static;
        max-height: 54dvh;
        display: flex;
        flex-direction: column;
        min-height: 0;
      }
    }

    /*
     * Mobile: the video is the product, so it comes first. The catalogue rail
     * follows the stage instead of preceding it (source order is unchanged for
     * assistive technology via the layout order below).
     */
    @media (max-width: 720px) {
      .layout {
        display: flex;
        flex-direction: column-reverse;
        gap: var(--s-3);
      }
    }
  `,
})
export class CataloguePageComponent {
  protected readonly catalog = inject(CatalogStore);
  private readonly route = inject(ActivatedRoute);

  protected readonly focusRequest = signal(0);

  protected readonly activeChannelId = toSignal<string | null>(
    this.route.firstChild
      ? this.route.firstChild.paramMap.pipe(map((params) => params.get('channelId') ?? null))
      : of(null),
    { initialValue: null },
  );

  constructor() {
    void this.catalog.ensureCatalog();

    /*
     * No guide is loaded here on purpose. The catalogue view never renders EPG
     * data (it shows tiles, and the schedule page owns the guide), while asking
     * for it cost 21 per-channel `/schedule` requests on every home visit for a
     * snapshot nothing displayed. The guide is fetched where it is shown: the
     * watch page for one channel, the schedule page for the grid.
     */
  }

  protected retry(): void {
    void this.catalog.reloadCatalog();
  }
}
