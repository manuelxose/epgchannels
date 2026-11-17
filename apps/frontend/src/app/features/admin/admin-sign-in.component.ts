/**
 * Admin sign-in: a real `POST /auth/login` against our API.
 *
 * Nothing is simulated: a wrong password or an unreachable API is shown verbatim,
 * errors are announced, and focus moves to the alert so a keyboard user lands where
 * the problem is.
 */
import { ChangeDetectionStrategy, Component, ElementRef, inject, signal, viewChild } from '@angular/core';
import { AdminApiService, describeAdminError } from '../../core/admin/admin-api.service';
import { AdminSessionStore } from '../../core/admin/admin-session.store';
import { IconComponent } from '../../shared/ui/icon.component';

@Component({
  selector: 'app-admin-sign-in',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  template: `
    <form class="sign-in" (submit)="submit($event)" novalidate>
      <h2 class="sign-in__title">Acceso de administración</h2>
      <p class="admin-note">
        Usa las credenciales de un usuario editorial de esta API. El token se guarda solo en esta pestaña.
      </p>

      @if (error()) {
        <div class="admin-alert" role="alert" tabindex="-1" #alert>
          <app-icon name="alert" [size]="18" />
          <span>{{ error() }}</span>
        </div>
      }

      <label class="field">
        <span class="field__label">Correo</span>
        <input
          #emailInput
          type="email"
          name="email"
          autocomplete="username"
          required
          [attr.aria-invalid]="invalidEmail()"
          (input)="email.set(emailInput.value)"
        />
      </label>

      <label class="field">
        <span class="field__label">Contraseña</span>
        <input
          #passwordInput
          type="password"
          name="password"
          autocomplete="current-password"
          required
          [attr.aria-invalid]="invalidPassword()"
          (input)="password.set(passwordInput.value)"
        />
      </label>

      <button type="submit" class="btn btn--primary" [disabled]="busy()">
        {{ busy() ? 'Entrando…' : 'Entrar' }}
      </button>
    </form>
  `,
  styleUrl: './admin-shared.css',
})
export class AdminSignInComponent {
  private readonly api = inject(AdminApiService);
  private readonly session = inject(AdminSessionStore);
  private readonly alert = viewChild<ElementRef<HTMLElement>>('alert');
  private readonly passwordInput = viewChild<ElementRef<HTMLInputElement>>('passwordInput');

  protected readonly email = signal('');
  protected readonly password = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly invalidEmail = signal(false);
  protected readonly invalidPassword = signal(false);

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    this.error.set(null);
    this.invalidEmail.set(!this.email().trim());
    this.invalidPassword.set(!this.password());
    if (this.invalidEmail() || this.invalidPassword()) {
      this.error.set('Completa correo y contraseña.');
      queueMicrotask(() => this.alert()?.nativeElement.focus());
      return;
    }
    this.busy.set(true);
    try {
      const result = await this.api.login(this.email().trim(), this.password());
      this.session.signIn(result);
      // The password never stays in memory or in the field after a successful login.
      this.password.set('');
      if (this.passwordInput()) this.passwordInput()!.nativeElement.value = '';
    } catch (failure) {
      this.error.set(describeAdminError(failure));
      this.invalidPassword.set(true);
      queueMicrotask(() => this.alert()?.nativeElement.focus());
    } finally {
      this.busy.set(false);
    }
  }
}
