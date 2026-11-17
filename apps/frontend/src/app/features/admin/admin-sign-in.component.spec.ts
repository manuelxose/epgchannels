import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminSignInComponent } from './admin-sign-in.component';
import { AdminSessionStore } from '../../core/admin/admin-session.store';
import { provideRebuildConfig } from '../../core/config/rebuild-config.token';

/**
 * The sign-in form talks to the real `/auth/login`. These tests prove it renders
 * the API's answer (success or failure) and keeps the password out of view.
 */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('AdminSignInComponent', () => {
  let fixture: ComponentFixture<AdminSignInComponent>;

  beforeEach(async () => {
    sessionStorage.clear();
    await TestBed.configureTestingModule({
      imports: [AdminSignInComponent],
      providers: [provideZonelessChangeDetection(), provideRebuildConfig({ apiBaseUrl: 'http://api.test/api/v1' })],
    }).compileComponents();
    fixture = TestBed.createComponent(AdminSignInComponent);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  function type(selector: string, value: string): void {
    const input = fixture.nativeElement.querySelector(selector) as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event('input'));
  }

  it('labels both fields and never pre-fills a password', () => {
    fixture.detectChanges();
    const password = fixture.nativeElement.querySelector('input[name="password"]') as HTMLInputElement;
    expect(password.type).toBe('password');
    expect(password.value).toBe('');
    expect(password.getAttribute('autocomplete')).toBe('current-password');
    expect(fixture.nativeElement.querySelectorAll('label .field__label')).toHaveLength(2);
  });

  it('shows the real authentication failure inside an alert', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json({ error: { code: 'unauthorized', message: 'Credenciales no válidas.' } }, 401),
      ),
    );
    fixture.detectChanges();
    type('input[name="email"]', 'op@test');
    type('input[name="password"]', 'nope');
    fixture.nativeElement.querySelector('form').dispatchEvent(new Event('submit'));
    await fixture.whenStable();
    fixture.detectChanges();

    const alert = fixture.nativeElement.querySelector('[role="alert"]');
    expect(alert.textContent).toContain('Credenciales no válidas.');
    expect(TestBed.inject(AdminSessionStore).signedIn()).toBe(false);
  });

  it('stores the session the API issued and clears the password field', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json({ data: { token: 'tok-1', email: 'op@test', expiresAt: '2999-01-01T00:00:00.000Z' } }),
      ),
    );
    fixture.detectChanges();
    type('input[name="email"]', 'op@test');
    type('input[name="password"]', 'right');
    fixture.nativeElement.querySelector('form').dispatchEvent(new Event('submit'));
    await fixture.whenStable();
    fixture.detectChanges();

    const session = TestBed.inject(AdminSessionStore);
    expect(session.signedIn()).toBe(true);
    expect(session.token()).toBe('tok-1');
    const password = fixture.nativeElement.querySelector('input[name="password"]') as HTMLInputElement;
    expect(password.value).toBe('');
  });

  it('validates locally before calling the API', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    fixture.detectChanges();
    fixture.nativeElement.querySelector('form').dispatchEvent(new Event('submit'));
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(fixture.nativeElement.querySelector('[role="alert"]').textContent).toContain('Completa correo');
  });
});
