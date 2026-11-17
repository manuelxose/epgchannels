/**
 * Operator session: the bearer token `/auth/login` issues.
 *
 * Kept in `sessionStorage` on purpose — closing the tab drops the credential.
 * Nothing outside `AdminApiService` ever attaches it to a request.
 */
import { Injectable, computed, signal } from '@angular/core';
import { SafeStorage } from '../state/safe-storage';

const KEY = 'tdt.admin.session';

export interface AdminSession {
  readonly token: string;
  readonly email: string;
  readonly expiresAt: string;
}

function storage(): SafeStorage {
  try {
    return new SafeStorage(typeof sessionStorage === 'undefined' ? undefined : sessionStorage);
  } catch {
    return new SafeStorage(undefined);
  }
}

@Injectable({ providedIn: 'root' })
export class AdminSessionStore {
  private readonly store = storage();
  private readonly session = signal<AdminSession | null>(readStored(this.store));

  readonly current = this.session;
  readonly token = computed(() => this.session()?.token ?? null);
  readonly email = computed(() => this.session()?.email ?? '');
  readonly signedIn = computed(() => !isExpired(this.session()));

  signIn(session: AdminSession): void {
    this.session.set(session);
    this.store.write(KEY, JSON.stringify(session));
  }

  signOut(): void {
    this.session.set(null);
    this.store.remove(KEY);
  }
}

function isExpired(session: AdminSession | null): boolean {
  if (!session) return true;
  const expires = Date.parse(session.expiresAt);
  // An unparsable expiry is treated as still valid: the API is the authority.
  return Number.isFinite(expires) && expires <= Date.now();
}

function readStored(store: SafeStorage): AdminSession | null {
  const raw = store.read(KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<AdminSession>;
    if (typeof parsed.token !== 'string' || typeof parsed.email !== 'string') return null;
    const session = { token: parsed.token, email: parsed.email, expiresAt: parsed.expiresAt ?? '' };
    return isExpired(session) ? null : session;
  } catch {
    return null;
  }
}
