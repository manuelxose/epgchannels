import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminCatalogueComponent } from './admin-catalogue.component';
import { AdminChannelDrawerComponent } from './admin-channel-drawer.component';
import { AdminCatalogueStore } from '../../../core/admin/admin-catalogue.store';
import { AdminSessionStore } from '../../../core/admin/admin-session.store';
import { provideRebuildConfig } from '../../../core/config/rebuild-config.token';

/** Catalogue workbench: rows come from the API, errors are the API's own. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const page = {
  data: [
    {
      id: 'id-la1',
      slug: 'la-1',
      name: 'La 1',
      country: 'ES',
      regionCode: null,
      language: 'es',
      category: 'generalista',
      editorialStatus: 'published',
      playbackStatus: 'available',
      sourceCandidates: 3,
      eligibleSources: 2,
      duplicateOf: null,
      updatedAt: '2026-11-17T10:00:00.000Z',
    },
  ],
  pagination: { page: 1, pageSize: 25, total: 1, pageCount: 1, hasNext: false, hasPrevious: false },
};

const detail = {
  data: {
    id: 'id-la1',
    slug: 'la-1',
    name: 'La 1',
    shortName: 'La 1',
    country: 'ES',
    regionCode: null,
    language: 'es',
    category: 'generalista',
    editorialStatus: 'published',
    playbackStatus: 'available',
    alias: [],
    sources: [
      {
        id: 'id-src1',
        provider: 'emitimos',
        type: 'hls',
        permission: 'emitter-public-stream',
        technicalStatus: 'ok',
        editorialStatus: 'published',
        priority: 10,
        eligible: true,
        eligibilityReason: null,
        lastVerifiedAt: '2026-11-17T09:00:00.000Z',
      },
    ],
    duplicates: [],
    updatedAt: '2026-11-17T10:00:00.000Z',
  },
};

/** One fetch double for every admin path these components touch. */
function routeFetch(input: string): Promise<Response> {
  const url = new URL(input, 'http://localhost');
  const path = url.pathname.replace('/api/v1', '');
  if (path === '/admin/catalogue') return Promise.resolve(json(page));
  if (path === '/admin/catalogue/id-la1') return Promise.resolve(json(detail));
  if (path.endsWith('/identity')) return Promise.resolve(json(detail));
  return Promise.resolve(json({ error: { code: 'not_found', message: `Ruta no encontrada: ${path}` } }, 404));
}

function signIn(): void {
  TestBed.inject(AdminSessionStore).signIn({
    token: 'tok',
    email: 'op@test',
    expiresAt: '2999-01-01T00:00:00.000Z',
  });
}

describe('AdminCatalogueComponent', () => {
  let fixture: ComponentFixture<AdminCatalogueComponent>;

  beforeEach(async () => {
    sessionStorage.clear();
    vi.stubGlobal('fetch', vi.fn(routeFetch));
    await TestBed.configureTestingModule({
      imports: [AdminCatalogueComponent],
      providers: [provideZonelessChangeDetection(), provideRebuildConfig({ apiBaseUrl: 'http://api.test/api/v1' })],
    }).compileComponents();
    signIn();
    fixture = TestBed.createComponent(AdminCatalogueComponent);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it('renders the channels the API returned with their editorial state', async () => {
    await TestBed.inject(AdminCatalogueStore).load();
    fixture.detectChanges();

    const rows = fixture.nativeElement.querySelectorAll('tbody tr');
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toContain('La 1');
    expect(rows[0].textContent).toContain('Publicado');
    expect(rows[0].textContent).toContain('2/3');
  });

  it('shows the API error with its status and a retry, never fabricated rows', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ error: { code: 'not_found', message: 'Ruta no encontrada' } }, 404)),
    );
    await TestBed.inject(AdminCatalogueStore).load();
    fixture.detectChanges();

    const alert = fixture.nativeElement.querySelector('[role="alert"]');
    expect(alert.textContent).toContain('404');
    expect(fixture.nativeElement.querySelector('tbody')).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Reintentar');
  });

  it('offers labelled filters', async () => {
    await TestBed.inject(AdminCatalogueStore).load();
    fixture.detectChanges();
    const labels = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLElement>('label.field'),
    ).map((label) => label.querySelector('.field__label')?.textContent?.trim());
    expect(labels).toEqual(['Buscar', 'Estado editorial', 'País', 'Categoría']);
  });

  it('opens the detail drawer for the chosen channel', async () => {
    await TestBed.inject(AdminCatalogueStore).load();
    fixture.detectChanges();

    (fixture.nativeElement.querySelector('tbody button') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(TestBed.inject(AdminCatalogueStore).detailStatus()).toBe('ready'));
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[role="dialog"]')).not.toBeNull();
  });
});

describe('AdminChannelDrawerComponent', () => {
  let fixture: ComponentFixture<AdminChannelDrawerComponent>;

  beforeEach(async () => {
    sessionStorage.clear();
    vi.stubGlobal('fetch', vi.fn(routeFetch));
    await TestBed.configureTestingModule({
      imports: [AdminChannelDrawerComponent],
      providers: [provideZonelessChangeDetection(), provideRebuildConfig({ apiBaseUrl: 'http://api.test/api/v1' })],
    }).compileComponents();
    signIn();
    fixture = TestBed.createComponent(AdminChannelDrawerComponent);
    fixture.componentRef.setInput('channelId', 'id-la1');
    await TestBed.inject(AdminCatalogueStore).open('id-la1');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it('is a labelled modal dialog with the channel detail', () => {
    fixture.detectChanges();

    const dialog = fixture.nativeElement.querySelector('[role="dialog"]');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBe('drawer-title');
    expect(dialog.textContent).toContain('La 1');
    expect(dialog.textContent).toContain('emitimos');
  });

  it('keeps the technical controls behind a disclosure', () => {
    fixture.detectChanges();

    const details = fixture.nativeElement.querySelector('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.querySelector('summary')?.textContent).toContain('Configuración técnica avanzada');
  });

  it('closes on Escape', () => {
    fixture.detectChanges();
    let closed = false;
    fixture.componentInstance.closed.subscribe(() => (closed = true));
    fixture.nativeElement
      .querySelector('[role="dialog"]')
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(closed).toBe(true);
  });

  it('requires a reason before saving the identity', () => {
    fixture.detectChanges();

    const reason = fixture.nativeElement.querySelector('input[name="reason"]') as HTMLInputElement;
    expect(reason.getAttribute('minlength')).toBe('3');
    expect(reason.required).toBe(true);
    const save = fixture.nativeElement.querySelector('button[type="submit"]') as HTMLButtonElement;
    // Nothing typed yet: there is no change to send.
    expect(save.disabled).toBe(true);
  });
});
