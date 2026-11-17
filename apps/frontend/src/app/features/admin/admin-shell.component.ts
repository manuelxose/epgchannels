/**
 * Administration shell: session gate, area tabs and the router outlet.
 *
 * Tabs are real routes (`admin/…`) so an operator can bookmark an area, and each
 * area loads only its own data — no monolith screen that loads half a platform to
 * show a title.
 */
import { ChangeDetectionStrategy, Component, ElementRef, effect, inject, signal, viewChild } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { describeAdminError, AdminApiService } from '../../core/admin/admin-api.service';
import { AdminSessionStore } from '../../core/admin/admin-session.store';
import { AdminSignInComponent } from './admin-sign-in.component';
import { IconComponent } from '../../shared/ui/icon.component';

interface Area {
  readonly path: string;
  readonly label: string;
  readonly hint: string;
}

const AREAS: readonly Area[] = [
  { path: 'catalogo', label: 'Catálogo', hint: 'Identidad, estado editorial y duplicados' },
  { path: 'fuentes', label: 'Fuentes', hint: 'Salud técnica y autorización de reproducción' },
  { path: 'epg', label: 'EPG', hint: 'Cobertura, mapeos e ingestas' },
  { path: 'operaciones', label: 'Operaciones', hint: 'Trabajos, errores y métricas' },
];

@Component({
  selector: 'app-admin-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, RouterLinkActive, RouterOutlet, AdminSignInComponent, IconComponent],
  template: `
    <section class="admin" aria-labelledby="admin-title">
      <header class="admin__head">
        <div>
          <p class="admin__eyebrow">
            <app-icon name="settings" [size]="14" />
            Administración
          </p>
          <h1 id="admin-title">Consola operativa</h1>
        </div>

        @if (session.signedIn()) {
          <div class="admin__session">
            <span class="admin-count">{{ session.email() }}</span>
            <button type="button" class="btn btn--ghost" (click)="signOut()">Cerrar sesión</button>
          </div>
        }
      </header>

      @if (signOutError(); as message) {
        <p class="admin-alert" role="alert">
          <app-icon name="alert" [size]="18" />
          {{ message }}
        </p>
      }

      @if (!session.signedIn()) {
        <app-admin-sign-in />
      } @else {
        <nav class="admin__tabs" aria-label="Áreas de administración">
          @for (area of areas; track area.path) {
            <a
              [routerLink]="area.path"
              routerLinkActive="is-active"
              ariaCurrentWhenActive="page"
              [attr.title]="area.hint"
            >
              {{ area.label }}
            </a>
          }
        </nav>

        <!-- Area content replaces focus target after a tab change. -->
        <div class="admin__area" tabindex="-1" #areaHost>
          <router-outlet />
        </div>
      }
    </section>
  `,
  styles: `
    .admin {
      display: flex;
      flex-direction: column;
      gap: var(--s-4);
      max-width: 1600px;
      margin: 0 auto;
    }

    .admin__head {
      display: flex;
      flex-wrap: wrap;
      align-items: flex-end;
      justify-content: space-between;
      gap: var(--s-3);
    }

    .admin__head h1 {
      font-size: var(--fs-2xl);
    }

    .admin__eyebrow {
      display: inline-flex;
      align-items: center;
      gap: var(--s-1);
      color: var(--text-subtle);
      font-size: var(--fs-xs);
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .admin__session {
      display: flex;
      align-items: center;
      gap: var(--s-3);
    }

    .admin__tabs {
      display: flex;
      flex-wrap: wrap;
      gap: var(--s-1);
      padding: var(--s-1);
      border: 1px solid var(--border);
      border-radius: var(--r-pill);
      background: var(--surface-1);
      align-self: flex-start;
    }

    .admin__tabs a {
      padding: var(--s-2) var(--s-4);
      border-radius: var(--r-pill);
      color: var(--text-muted);
      font-size: var(--fs-sm);
      font-weight: 600;
      min-height: 36px;
      display: inline-flex;
      align-items: center;
    }

    .admin__tabs a:hover {
      background: var(--surface-2);
      color: var(--text);
    }

    .admin__tabs a.is-active {
      background: var(--accent);
      color: var(--on-accent);
    }

    .admin__area:focus-visible {
      outline: none;
    }
  `,
})
export class AdminShellComponent {
  protected readonly session = inject(AdminSessionStore);
  private readonly api = inject(AdminApiService);
  private readonly areaHost = viewChild<ElementRef<HTMLElement>>('areaHost');

  protected readonly areas = AREAS;
  protected readonly signOutError = signal<string | null>(null);

  constructor() {
    // Focus lands on the area when the session opens, not on the removed form.
    effect(() => {
      if (!this.session.signedIn()) return;
      queueMicrotask(() => this.areaHost()?.nativeElement.focus());
    });
  }

  protected async signOut(): Promise<void> {
    const token = this.session.token();
    this.signOutError.set(null);
    try {
      if (token) await this.api.logout(token);
    } catch (error) {
      // The local session is dropped either way, but the API's answer is shown.
      this.signOutError.set(describeAdminError(error));
    } finally {
      this.session.signOut();
    }
  }
}
