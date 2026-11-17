import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminApiError, AdminApiService, describeAdminError } from './admin-api.service';
import { AdminSessionStore } from './admin-session.store';
import { AdminCatalogueStore } from './admin-catalogue.store';
import { AdminEpgStore } from './admin-epg.store';
import { AdminOperationsStore } from './admin-operations.store';
import { provideRebuildConfig } from '../config/rebuild-config.token';

/**
 * These tests drive the admin stores against the **real** API contract: the
 * fixtures below are payloads of `/api/v1/admin/*` (shapes of
 * `packages/contracts/src/admin-operations.ts`). The point of each test is that
 * the UI shows what the API answered and nothing else.
 */

const API = 'http://api.test/api/v1';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const catalogueBody = {
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

const detailBody = {
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

const overviewBody = {
  data: {
    catalogue: { total: 768, published: 412, review: 356, draft: 0, withdrawn: 0 },
    countries: [{ code: 'ES', name: 'España', channelCount: 294, playableCount: 100 }],
    languages: [{ code: 'es', channelCount: 294 }],
    sources: { total: 1364, healthy: 1000, failing: 200, unverified: 164, ineligible: 0 },
    epg: { sources: 2, mappedChannels: 117, missingChannels: 651, staleChannels: 117, failedRuns24h: 1 },
    operations: { jobs: 3, paused: 1, failed: 2 },
    asOf: '2026-11-17T10:00:00.000Z',
  },
};

const jobsBody = {
  data: [
    {
      name: 'epg-sync',
      paused: false,
      lastStatus: 'failed',
      lastStartedAt: '2026-11-17T09:00:00.000Z',
      lastFinishedAt: '2026-11-17T09:01:00.000Z',
      lastDurationMs: 60_000,
      consecutiveFailures: 2,
      lastError: 'timeout',
    },
  ],
};

const coverageBody = {
  data: {
    entries: [
      {
        channelId: 'id-la1',
        slug: 'la-1',
        name: 'La 1',
        country: 'ES',
        language: 'es',
        timezone: 'Europe/Madrid',
        mapped: true,
        sourceId: 'fsrc1',
        sourceName: 'XMLTV',
        status: 'stale',
        availability: 'available',
        programmes: 12,
      },
    ],
    totals: { channels: 768, mapped: 117, fresh: 0, stale: 117, empty: 0, notMapped: 651 },
    conflicts: 0,
    asOf: '2026-11-17T10:00:00.000Z',
  },
  attribution: { notices: [], includesThirdPartyData: false },
};

function routeFetch(input: string, init?: RequestInit): Promise<Response> {
  const url = new URL(input, 'http://localhost');
  const method = init?.method ?? 'GET';
  const path = url.pathname.replace('/api/v1', '');
  if (path === '/auth/login') return Promise.resolve(json({ data: { token: 'tok', email: 'op@test', expiresAt: '2999-01-01T00:00:00.000Z' } }));
  if (path === '/admin/catalogue') return Promise.resolve(json(catalogueBody));
  if (path === '/admin/catalogue/id-la1') return Promise.resolve(json(detailBody));
  if (path === '/admin/catalogue/id-la1/identity' && method === 'POST') {
    const body = JSON.parse(String(init?.body ?? '{}')) as { name?: string };
    return Promise.resolve(
      json({ data: { ...detailBody.data, name: body.name ?? detailBody.data.name, updatedAt: '2026-11-17T11:00:00.000Z' } }),
    );
  }
  if (path === '/admin/overview') return Promise.resolve(json(overviewBody));
  if (path === '/admin/operations/jobs') return Promise.resolve(json(jobsBody));
  if (path === '/admin/operations/errors') return Promise.resolve(json({ data: [] }));
  if (path === '/admin/operations/metrics') {
    return Promise.resolve(
      json({
        data: {
          http: { totalRequests: 10, errorRequests: 1, p50Ms: 12, p95Ms: 40 },
          playback: { descriptorsServed: 5, refusedUnauthorised: 0 },
          windowSeconds: 300,
          asOf: '2026-11-17T10:00:00.000Z',
        },
      }),
    );
  }
  if (path === '/admin/epg/coverage') return Promise.resolve(json(coverageBody));
  if (path === '/admin/epg/mappings') {
    return Promise.resolve(json({ data: [], pagination: { page: 1, pageSize: 100, total: 0 } }));
  }
  if (path === '/admin/epg-sources') {
    return Promise.resolve(
      json({ data: [{ id: 'fsrc1', name: 'XMLTV', kind: 'xmltv', url: 'x', licence: 'CC0', ingestionEnabled: true, status: 'ok', lastRunAt: null, lastRunStatus: 'ok', lastRunProgrammes: 12 }] }),
    );
  }
  if (path === '/admin/epg/ingestion-runs') return Promise.resolve(json({ data: [] }));
  if (path === '/admin/sources/health') {
    return Promise.resolve(
      json({ data: [], pagination: { page: 1, pageSize: 100, total: 0 } }),
    );
  }
  return Promise.resolve(json({ error: { code: 'not_found', message: `Ruta no encontrada: ${method} ${path}` } }, 404));
}

describe('Admin stores against the real API contract', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(routeFetch);
    vi.stubGlobal('fetch', fetchMock);
    sessionStorage.clear();
    TestBed.configureTestingModule({ providers: [provideRebuildConfig({ apiBaseUrl: API })] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  function signedIn(): void {
    TestBed.inject(AdminSessionStore).signIn({
      token: 'tok',
      email: 'op@test',
      expiresAt: '2999-01-01T00:00:00.000Z',
    });
  }

  it('without a session the catalogue reports it and never calls the API', async () => {
    const store = TestBed.inject(AdminCatalogueStore);
    await store.load();
    expect(store.status()).toBe('error');
    expect(store.error()).toContain('Inicia sesión');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('loads the catalogue page through /admin/catalogue and keeps the API pagination', async () => {
    signedIn();
    const store = TestBed.inject(AdminCatalogueStore);
    await store.load();
    expect(store.status()).toBe('ready');
    expect(store.rows().length).toBe(1);
    expect(store.rows()[0].eligibleSources).toBe(2);
    expect(store.pagination()?.total).toBe(1);
    const called = new URL(String(fetchMock.mock.calls[0][0]));
    expect(called.pathname).toBe('/api/v1/admin/catalogue');
    expect(called.searchParams.get('pageSize')).toBe('25');
  });

  it('a 404 on the catalogue surfaces the API message, not invented rows', async () => {
    signedIn();
    const store = TestBed.inject(AdminCatalogueStore);
    fetchMock.mockResolvedValueOnce(
      json({ error: { code: 'not_found', message: 'Ruta no encontrada: GET /admin/catalogue' } }, 404),
    );
    await store.load();
    expect(store.status()).toBe('error');
    expect(store.rows()).toEqual([]);
    expect(store.error()).toContain('404');
    expect(store.error()).toContain('Ruta no encontrada');
  });

  it('an unreachable API is reported as such', async () => {
    signedIn();
    const store = TestBed.inject(AdminCatalogueStore);
    fetchMock.mockRejectedValueOnce(new Error('fetch failed'));
    await store.load();
    expect(store.status()).toBe('error');
    expect(store.error()).toContain('No se pudo contactar con la API');
  });

  it('changing a filter other than the page resets to page 1', async () => {
    signedIn();
    const store = TestBed.inject(AdminCatalogueStore);
    await store.setFilters({ page: 3 });
    await store.setFilters({ q: 'la 1' });
    expect(store.filters().page).toBe(1);
    expect(store.filters().q).toBe('la 1');
  });

  it('saves identity with its reason and adopts the API’s updated detail', async () => {
    signedIn();
    const store = TestBed.inject(AdminCatalogueStore);
    await store.open('id-la1');
    expect(store.detail()?.name).toBe('La 1');

    const saved = await store.saveIdentity('id-la1', {
      name: 'La Primera',
      shortName: 'La 1',
      country: 'ES',
      language: 'es',
      category: 'generalista',
      regionCode: null,
      reason: 'Nombre comercial actualizado',
    });
    expect(saved).toBe(true);
    expect(store.detail()?.name).toBe('La Primera');
    const post = fetchMock.mock.calls.find((call) => String(call[1]?.method) === 'POST');
    const body = JSON.parse(String(post?.[1]?.body));
    expect(body.reason).toBe('Nombre comercial actualizado');
    expect(body).not.toHaveProperty('region');
  });

  it('refuses to save an identity change without a reason (audit requires it)', async () => {
    signedIn();
    const store = TestBed.inject(AdminCatalogueStore);
    await store.open('id-la1');
    fetchMock.mockClear();
    const saved = await store.saveIdentity('id-la1', {
      name: 'X',
      shortName: 'X',
      country: 'ES',
      language: 'es',
      category: 'generalista',
      regionCode: null,
      reason: '  ',
    });
    expect(saved).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.lastActionError()).toContain('motivo');
  });

  it('operations reads the overview, jobs, errors and metrics independently', async () => {
    signedIn();
    const store = TestBed.inject(AdminOperationsStore);
    await store.load();
    expect(store.overview()?.catalogue.published).toBe(412);
    expect(store.jobs().length).toBe(1);
    expect(store.jobs()[0].lastStatus).toBe('failed');
    expect(store.errors()).toEqual([]);
    expect(store.metrics()?.http.p95Ms).toBe(40);
  });

  it('operations shows the real 404 when a route is not served', async () => {
    signedIn();
    const store = TestBed.inject(AdminOperationsStore);
    fetchMock.mockImplementation((input: string) => {
      const url = new URL(input, 'http://localhost');
      return Promise.resolve(json({ error: { message: `Ruta no encontrada: ${url.pathname}` } }, 404));
    });
    await store.load();
    expect(store.overview()).toBeNull();
    expect(store.overviewError()).toContain('404');
    expect(store.jobsError()).toContain('Ruta no encontrada');
  });

  it('EPG keeps coverage from the shared measure and filters it locally', async () => {
    signedIn();
    const store = TestBed.inject(AdminEpgStore);
    await store.load();
    expect(store.coverage()?.totals.mapped).toBe(117);
    expect(store.entries().length).toBe(1);
    store.setFilter('fresh');
    expect(store.entries().length).toBe(0);
    store.setFilter('stale');
    expect(store.entries().length).toBe(1);
  });

  it('the admin error taxonomy tells missing, forbidden and offline apart', () => {
    expect(describeAdminError(new AdminApiError(404, 'x'))).toContain('404');
    expect(describeAdminError(new AdminApiError(403, 'x'))).toContain('rol');
    expect(describeAdminError(new AdminApiError(401, 'Credenciales no validas.'))).toBe(
      'No se pudo autenticar (401): Credenciales no validas.',
    );
    expect(describeAdminError(new AdminApiError(0, 'x'))).toContain('No se pudo contactar');
    expect(new AdminApiError(401, 'x').isUnauthorized).toBe(true);
  });

  it('the session survives a reload only while it has not expired', () => {
    const first = TestBed.inject(AdminSessionStore);
    first.signIn({ token: 'tok', email: 'op@test', expiresAt: '2999-01-01T00:00:00.000Z' });
    expect(sessionStorage.getItem('tdt.admin.session')).toContain('tok');
    expect(first.signedIn()).toBe(true);

    sessionStorage.setItem(
      'tdt.admin.session',
      JSON.stringify({ token: 'old', email: 'op@test', expiresAt: '2000-01-01T00:00:00.000Z' }),
    );
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [provideRebuildConfig({ apiBaseUrl: API })] });
    const reloaded = TestBed.inject(AdminSessionStore);
    expect(reloaded.current()).toBeNull();
    expect(reloaded.signedIn()).toBe(false);
  });

  it('logout is sent to the real endpoint and clears the local session', async () => {
    signedIn();
    const session = TestBed.inject(AdminSessionStore);
    const api = TestBed.inject(AdminApiService);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await api.logout(session.token() ?? '');
    session.signOut();
    expect(session.current()).toBeNull();
    expect(String(fetchMock.mock.calls[0][0])).toContain('/auth/logout');
  });
});
