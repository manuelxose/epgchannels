/**
 * EPG administration state: the real coverage measure of `EpgService.coverage()`
 * through `/admin/epg/coverage`, the mappings, the XMLTV sources and their runs.
 *
 * Coverage is the single shared measure: the UI reads it and never derives a
 * second one, and it never fills a missing programme to make a channel look OK.
 */
import { Injectable, computed, inject, signal } from '@angular/core';
import type { AdminMappingRow, EpgSyncRun } from '@tdt/contracts';
import {
  AdminApiError,
  AdminApiService,
  describeAdminError,
  type EpgCoveragePayload,
  type EpgSource,
} from './admin-api.service';
import { AdminSessionStore } from './admin-session.store';
import { errorState, idle, loading, ready, type AsyncState } from './async-state';
import { readArray } from './json-shape';

export type CoverageFilter = 'all' | 'fresh' | 'stale' | 'empty' | 'not-mapped';

@Injectable({ providedIn: 'root' })
export class AdminEpgStore {
  private readonly api = inject(AdminApiService);
  private readonly session = inject(AdminSessionStore);

  private readonly coverageState = signal<AsyncState<EpgCoveragePayload>>(idle());
  private readonly mappingsState = signal<AsyncState<readonly AdminMappingRow[]>>(idle());
  private readonly sourcesState = signal<AsyncState<readonly EpgSource[]>>(idle());
  private readonly runsState = signal<AsyncState<readonly EpgSyncRun[]>>(idle());
  private readonly ingestionState = signal<AsyncState<string>>(idle());
  private readonly coverageFilter = signal<CoverageFilter>('all');

  readonly coverage = computed(() => {
    const state = this.coverageState();
    return state.kind === 'ready' ? state.value : null;
  });
  readonly coverageStatus = computed(() => this.coverageState().kind);
  readonly coverageError = computed(() => {
    const state = this.coverageState();
    return state.kind === 'error' ? state.message : null;
  });

  readonly filter = this.coverageFilter;
  readonly entries = computed(() => {
    const coverage = this.coverage();
    const filter = this.coverageFilter();
    if (!coverage) return [];
    return filter === 'all' ? coverage.entries : coverage.entries.filter((entry) => entry.status === filter);
  });

  readonly mappings = computed(() => {
    const state = this.mappingsState();
    return state.kind === 'ready' ? state.value : [];
  });
  readonly mappingsError = computed(() => {
    const state = this.mappingsState();
    return state.kind === 'error' ? state.message : null;
  });
  readonly conflicts = computed(() => this.mappings().filter((mapping) => mapping.conflict));

  readonly sources = computed(() => {
    const state = this.sourcesState();
    return state.kind === 'ready' ? state.value : [];
  });
  readonly sourcesError = computed(() => {
    const state = this.sourcesState();
    return state.kind === 'error' ? state.message : null;
  });

  readonly runs = computed(() => {
    const state = this.runsState();
    return state.kind === 'ready' ? state.value : [];
  });
  readonly runsError = computed(() => {
    const state = this.runsState();
    return state.kind === 'error' ? state.message : null;
  });

  readonly ingesting = computed(() => this.ingestionState().kind === 'loading');
  readonly lastIngestion = computed(() => {
    const state = this.ingestionState();
    return state.kind === 'ready' ? state.value : null;
  });
  readonly ingestionError = computed(() => {
    const state = this.ingestionState();
    return state.kind === 'error' ? state.message : null;
  });

  /** Loads every EPG panel in parallel; each one fails independently. */
  async load(): Promise<void> {
    const token = this.session.token();
    if (!token) {
      const message = 'Inicia sesión para consultar la EPG.';
      this.coverageState.set(errorState(message, 401));
      this.mappingsState.set(errorState(message, 401));
      this.sourcesState.set(errorState(message, 401));
      this.runsState.set(errorState(message, 401));
      return;
    }
    this.coverageState.set(loading());
    this.mappingsState.set(loading());
    this.sourcesState.set(loading());
    this.runsState.set(loading());

    const [coverage, mappings, sources, runs] = await Promise.allSettled([
      this.api.epgCoverage(token),
      this.api.epgMappings({ page: 1, pageSize: 100 }, token),
      this.api.epgSources(token),
      this.api.ingestionRuns(token),
    ]);
    this.coverageState.set(settle(coverage));
    this.mappingsState.set(
      mappings.status === 'fulfilled' ? ready(readArray<AdminMappingRow>(mappings.value) ?? []) : errorState(describeAdminError(mappings.reason), statusOf(mappings.reason)),
    );
    this.sourcesState.set(settle(sources));
    this.runsState.set(settle(runs));
  }

  setFilter(filter: CoverageFilter): void {
    this.coverageFilter.set(filter);
  }

  /** Asks the backend to run the ingestion now; the message is what it answered. */
  async ingest(sourceId: string): Promise<void> {
    const token = this.session.token();
    if (!token) return;
    this.ingestionState.set(loading());
    try {
      const result = await this.api.ingest(sourceId, token);
      this.ingestionState.set(ready(describeIngestion(result)));
      await this.load();
    } catch (error) {
      this.ingestionState.set(errorState(describeAdminError(error), statusOf(error)));
    }
  }

  async decideMapping(mappingId: string, decision: 'confirm' | 'reject', reason: string): Promise<void> {
    const token = this.session.token();
    if (!token) return;
    this.ingestionState.set(loading());
    try {
      if (decision === 'confirm') await this.api.confirmMapping(mappingId, reason, token);
      else await this.api.rejectMapping(mappingId, reason, token);
      this.ingestionState.set(ready(decision === 'confirm' ? 'Mapeo confirmado.' : 'Mapeo rechazado.'));
      await this.load();
    } catch (error) {
      this.ingestionState.set(errorState(describeAdminError(error), statusOf(error)));
    }
  }
}

function settle<T>(result: PromiseSettledResult<T>): AsyncState<T> {
  return result.status === 'fulfilled'
    ? ready(result.value)
    : errorState(describeAdminError(result.reason), statusOf(result.reason));
}

function statusOf(error: unknown): number | null {
  return error instanceof AdminApiError ? error.status : null;
}

/** One-line summary of the ingestion result, only from scalar fields. */
function describeIngestion(result: Record<string, unknown>): string {
  const parts = Object.entries(result)
    .filter(([, value]) => value === null || ['string', 'number', 'boolean'].includes(typeof value))
    .slice(0, 8)
    .map(([key, value]) => `${key}=${String(value)}`);
  return parts.length > 0 ? parts.join(' · ') : 'Ingesta completada; la respuesta no trae campos simples.';
}
