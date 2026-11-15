import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { IconComponent } from '../../shared/ui/icon.component';
import { CatalogueQuery } from '../../core/state/catalogue-query';
import { CatalogStore } from '../../core/state/catalog.store';
import { decodeSessionPayload } from '../../core/integrations/remote-playback';

/** Shown in the stage area when no channel is selected. */
@Component({
  selector: 'app-catalogue-home',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent],
  template: `
    <section class="home" aria-labelledby="home-title">
      <p class="home__eyebrow">
        <span class="live-dot" aria-hidden="true"></span>
        En directo
      </p>
      <h1 id="home-title" class="home__title">Televisión en directo, sin ruido</h1>
      <p class="home__text">
        Explora {{ catalog.channels().length || 'los' }} canales, consulta qué se está emitiendo ahora y abre la ficha
        oficial de cada medio. Selecciona un canal del catálogo para empezar a verlo.
      </p>

      <div class="home__actions">
        <a class="btn btn--primary" routerLink="/schedule">
          <app-icon name="clock" [size]="16" />
          Ver qué hay ahora
        </a>
      </div>

      @if (incoming(); as sent) {
        <!--
          Someone sent this device a channel ("Enviar a otra pantalla"). The link
          carries only which channel; the receiver decides what to do with it, so
          nothing leaves this device and no session is created anywhere.
        -->
        <div class="home__incoming" data-testid="incoming-cast" role="status">
          <h2 class="home__section-title">Te han enviado un canal</h2>
          <p class="home__text">{{ sent.name }}. Puedes verlo aquí, en este dispositivo.</p>
          <div class="home__actions">
            <a class="btn btn--primary" [routerLink]="['/television', sent.id]">
              <app-icon name="play" [size]="16" />
              Ver {{ sent.name }}
            </a>
            <button type="button" class="btn" (click)="dismissIncoming()">Ahora no</button>
          </div>
        </div>
      }

      @if (query.recentChannels().length > 0) {
        <div class="home__section">
          <h2 class="home__section-title">Recientes</h2>
          <ul class="home__chips">
            @for (channel of query.recentChannels(); track channel.id) {
              <li>
                <a class="chip" [routerLink]="['/television', channel.id]">{{ channel.name }}</a>
              </li>
            }
          </ul>
        </div>
      }

      @if (query.favoriteChannels().length > 0) {
        <div class="home__section">
          <h2 class="home__section-title">Favoritos</h2>
          <ul class="home__chips">
            @for (channel of query.favoriteChannels(); track channel.id) {
              <li>
                <a class="chip" [routerLink]="['/television', channel.id]">{{ channel.name }}</a>
              </li>
            }
          </ul>
        </div>
      }
    </section>
  `,
  styles: `
    .home {
      display: flex;
      flex-direction: column;
      gap: var(--s-3);
      padding: clamp(var(--s-5), 3vw, var(--s-8));
      border-radius: var(--r-xl);
      border: 1px solid var(--border);
      background:
        radial-gradient(90% 120% at 100% 0%, rgba(124, 92, 255, 0.16), transparent 60%),
        var(--surface-1);
    }

    .home__eyebrow {
      display: inline-flex;
      align-items: center;
      gap: var(--s-2);
      color: var(--text-muted);
      font-size: var(--fs-xs);
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }

    .home__title {
      font-size: clamp(1.6rem, 3.4vw, 2.6rem);
      letter-spacing: -0.03em;
      max-width: 20ch;
    }

    .home__text {
      max-width: 62ch;
      color: var(--text-muted);
    }

    .home__actions {
      display: flex;
      gap: var(--s-2);
      flex-wrap: wrap;
      margin-top: var(--s-2);
    }

    .home__section-title {
      font-size: var(--fs-xs);
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--text-subtle);
      margin-bottom: var(--s-2);
    }

    .home__section {
      margin-top: var(--s-3);
    }

    .home__chips {
      display: flex;
      flex-wrap: wrap;
      gap: var(--s-2);
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .chip {
      display: inline-flex;
      align-items: center;
      min-height: 36px;
      padding: 0 var(--s-3);
      border-radius: var(--r-pill);
      border: 1px solid var(--border);
      background: var(--surface-2);
      font-size: var(--fs-sm);
      font-weight: 600;
    }

    .chip:hover {
      border-color: var(--signal);
      background: var(--signal-soft);
    }
  `,
})
export class CatalogueHomeComponent implements OnInit {
  protected readonly catalog = inject(CatalogStore);
  protected readonly query = inject(CatalogueQuery);

  /** A channel another device sent to this one, once read. */
  private readonly incomingState = signal<{ id: string; name: string; appUrl: string } | undefined>(undefined);
  protected readonly incoming = this.incomingState.asReadonly();

  /**
   * The hand-over lives in the URL fragment (`#/cast/<token>`), which the router
   * ignores. It is read when this view initialises — not at construction, because
   * the fragment may still be settling then — and it is accepted only while the
   * payload is valid.
   */
  ngOnInit(): void {
    if (typeof window !== 'undefined') {
      this.incomingState.set(this.readHandover(window.location.hash));
    }
  }

  protected dismissIncoming(): void {
    this.incomingState.set(undefined);
    if (typeof window !== 'undefined' && window.location.hash.startsWith('#/cast/')) {
      window.history.replaceState({}, '', window.location.pathname + window.location.search);
    }
  }

  private readHandover(hash: string): { id: string; name: string; appUrl: string } | undefined {
    const token = /^#\/cast\/(.+)$/.exec(hash)?.[1];
    const payload = token ? decodeSessionPayload(token) : undefined;
    return payload ? { id: payload.channel.id, name: payload.channel.name, appUrl: payload.appUrl } : undefined;
  }
}
