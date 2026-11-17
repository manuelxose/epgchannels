/**
 * Operations state: the real overview, job rows, aggregated errors and metrics of
 * `/admin/operations/*`. Pause/resume call the real routes; a base that does not
 * serve them answers 404 and the operator sees that.
 */
import { Injectable, computed, inject, signal } from '@angular/core';
import type { AdminJobRow, AdminMetrics, AdminOperationError, AdminOverview } from '@tdt/contracts';
import { AdminApiError, AdminApiService, describeAdminError } from './admin-api.service';
import { AdminSessionStore } from './admin-session.store';
import { errorState, idle, loading, ready, type AsyncState } from './async-state';
import { readArray } from './json-shape';

@Injectable({ providedIn: 'root' })
export class AdminOperationsStore {
  private readonly api = inject(AdminApiService);
  private readonly session = inject(AdminSessionStore);

  private readonly overviewState = signal<AsyncState<AdminOverview>>(idle());
  private readonly jobsState = signal<AsyncState<readonly AdminJobRow[]>>(idle());
  private readonly errorsState = signal<AsyncState<readonly AdminOperationError[]>>(idle());
  private readonly metricsState = signal<AsyncState<AdminMetrics>>(idle());
  private readonly actionState = signal<AsyncState<string>>(idle());

  readonly overview = computed(() => {
    const state = this.overviewState();
    return state.kind === 'ready' ? state.value : null;
  });
  readonly overviewError = computed(() => {
    const state = this.overviewState();
    return state.kind === 'error' ? state.message : null;
  });

  readonly jobs = computed(() => {
    const state = this.jobsState();
    return state.kind === 'ready' ? state.value : [];
  });
  readonly jobsStatus = computed(() => this.jobsState().kind);
  readonly jobsError = computed(() => {
    const state = this.jobsState();
    return state.kind === 'error' ? state.message : null;
  });

  readonly errors = computed(() => {
    const state = this.errorsState();
    return state.kind === 'ready' ? state.value : [];
  });
  readonly errorsError = computed(() => {
    const state = this.errorsState();
    return state.kind === 'error' ? state.message : null;
  });

  readonly metrics = computed(() => {
    const state = this.metricsState();
    return state.kind === 'ready' ? state.value : null;
  });
  readonly metricsError = computed(() => {
    const state = this.metricsState();
    return state.kind === 'error' ? state.message : null;
  });

  readonly actionMessage = computed(() => {
    const state = this.actionState();
    return state.kind === 'ready' ? state.value : null;
  });
  readonly actionError = computed(() => {
    const state = this.actionState();
    return state.kind === 'error' ? state.message : null;
  });
  readonly busy = computed(() => this.actionState().kind === 'loading');

  async load(): Promise<void> {
    const token = this.session.token();
    if (!token) {
      const message = 'Inicia sesión para consultar las operaciones.';
      this.overviewState.set(errorState(message, 401));
      this.jobsState.set(errorState(message, 401));
      this.errorsState.set(errorState(message, 401));
      this.metricsState.set(errorState(message, 401));
      return;
    }
    this.overviewState.set(loading());
    this.jobsState.set(loading());
    this.errorsState.set(loading());
    this.metricsState.set(loading());

    const [overview, jobs, errors, metrics] = await Promise.allSettled([
      this.api.overview(token),
      this.api.jobs(token),
      this.api.operationErrors(token),
      this.api.metrics(token),
    ]);
    this.overviewState.set(settle(overview));
    this.jobsState.set(
      jobs.status === 'fulfilled' ? ready(readArray<AdminJobRow>(jobs.value) ?? []) : errorState(describeAdminError(jobs.reason), statusOf(jobs.reason)),
    );
    this.errorsState.set(
      errors.status === 'fulfilled'
        ? ready(readArray<AdminOperationError>(errors.value) ?? [])
        : errorState(describeAdminError(errors.reason), statusOf(errors.reason)),
    );
    this.metricsState.set(settle(metrics));
  }

  async setPaused(job: AdminJobRow, paused: boolean, reason: string): Promise<void> {
    const token = this.session.token();
    if (!token) return;
    if (reason.trim().length < 3) {
      this.actionState.set(errorState('Indica un motivo de al menos 3 caracteres: queda en la auditoría.', null));
      return;
    }
    this.actionState.set(loading());
    try {
      if (paused) await this.api.pauseJob(job.name, reason.trim(), token);
      else await this.api.resumeJob(job.name, reason.trim(), token);
      this.actionState.set(ready(`${job.name}: ${paused ? 'pausado' : 'reanudado'}.`));
      await this.load();
    } catch (error) {
      this.actionState.set(errorState(describeAdminError(error), statusOf(error)));
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
